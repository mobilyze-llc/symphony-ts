import {
  classifyPortfolioIssue,
  upsertPortfolioClassificationBlock,
} from "../portfolio/classifier.js";
import type { SupervisionFinding } from "./supervision.js";

export interface TrackerIssueWriteRequest {
  boundary:
    | {
        type: "explicit_finding";
        phase: "dispatch" | "running";
        finding: SupervisionFinding;
      }
    | {
        type: "promotion_boundary";
        label: string;
        summary: string;
        sourceIssueIds: string[];
      };
}

export interface TrackerIssueReference {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string | null;
  teamId: string | null;
  teamKey: string | null;
  projectId: string | null;
  projectSlug: string | null;
  projectName?: string | null;
  labels: string[];
  parent: {
    id: string;
    identifier: string;
    title: string;
    url: string | null;
  } | null;
}

export interface TrackerIssueWriterClient {
  fetchIssueReferencesByIds(
    issueIds: string[],
  ): Promise<TrackerIssueReference[]>;
  findOpenIssuesByTitle(input: {
    projectId: string;
    title: string;
    excludeStateNames: string[];
  }): Promise<TrackerIssueReference[]>;
  resolveLabelIdsByNames(
    labelNames: string[],
    teamKey: string,
  ): Promise<Array<{ id: string; name: string }>>;
  createIssue(input: {
    teamId: string;
    title: string;
    projectId: string;
    labelIds: string[];
    description: string;
    parentId?: string;
  }): Promise<{ id: string; identifier: string; title: string }>;
  updateIssue(input: {
    issueId: string;
    description: string;
    labelIds: string[];
    projectId?: string;
    parentId?: string;
  }): Promise<{ id: string; identifier: string; title: string }>;
}

export interface TrackerIssueWriteResult {
  operation: "created" | "updated";
  issueTitle: string;
  issueIdentifier: string;
  parentIdentifier: string | null;
}

export async function writeTrackerIssueFromBoundary(input: {
  client: TrackerIssueWriterClient;
  request: TrackerIssueWriteRequest;
  terminalStates: string[];
  now?: () => Date;
  onFailure?: (context: {
    title: string;
    request: TrackerIssueWriteRequest;
    sourceIssueIds: string[];
    error: unknown;
  }) => void;
}): Promise<TrackerIssueWriteResult> {
  const now = input.now ?? (() => new Date());
  try {
    return await upsertTrackerIssueFromBoundary({
      client: input.client,
      request: input.request,
      terminalStates: input.terminalStates,
      now,
    });
  } catch (error) {
    const summary = summarizeTrackerWriteRequest(input.request);
    input.onFailure?.({
      title: summary.title,
      request: input.request,
      sourceIssueIds: summary.sourceIssueIds,
      error,
    });
    throw error;
  }
}

async function upsertTrackerIssueFromBoundary(input: {
  client: TrackerIssueWriterClient;
  request: TrackerIssueWriteRequest;
  terminalStates: string[];
  now: () => Date;
}): Promise<TrackerIssueWriteResult> {
  const summary = summarizeTrackerWriteRequest(input.request);
  if (summary.sourceIssueIds.length === 0) {
    throw new Error(
      "Tracker write request did not include any source issue IDs.",
    );
  }

  const sourceIssues = await input.client.fetchIssueReferencesByIds(
    summary.sourceIssueIds,
  );
  if (sourceIssues.length === 0) {
    throw new Error("Tracker write source issues could not be resolved.");
  }

  const primaryIssue = sourceIssues[0];
  if (primaryIssue === undefined) {
    throw new Error("Tracker write source issues were empty after resolution.");
  }
  if (
    primaryIssue.teamId === null ||
    primaryIssue.teamId.trim() === "" ||
    primaryIssue.teamKey === null ||
    primaryIssue.teamKey.trim() === ""
  ) {
    throw new Error(
      `Tracker write source issue ${primaryIssue.identifier} is missing team/project context.`,
    );
  }

  const parent = resolveCommonParent(sourceIssues);
  const labelNames = resolveRelevantLabels(input.request, sourceIssues);
  const resolvedLabelIds = (
    await input.client.resolveLabelIdsByNames(labelNames, primaryIssue.teamKey)
  ).map((label) => label.id);
  const description = formatTrackerIssueDescription({
    request: input.request,
    sourceIssues,
    labelNames,
    parent,
    now: input.now(),
  });
  const classification = classifyPortfolioIssue({
    identifier: primaryIssue.identifier,
    title: summary.title,
    description,
    teamKey: primaryIssue.teamKey,
    projectId: primaryIssue.projectId,
    projectSlug: primaryIssue.projectSlug,
    projectName: primaryIssue.projectName ?? null,
  });
  const targetProject =
    classification.targetProject ?? classification.intakeProject;
  const targetProjectId = targetProject?.id ?? primaryIssue.projectId;
  if (targetProjectId === null) {
    throw new Error(
      `Tracker write source issue ${primaryIssue.identifier} is missing project context.`,
    );
  }
  const descriptionWithPortfolio =
    classification.status === "not_applicable"
      ? description
      : upsertPortfolioClassificationBlock(description, classification);
  const existing = await findMatchingOpenIssue({
    client: input.client,
    title: summary.title,
    projectId: targetProjectId,
    terminalStates: input.terminalStates,
    marker: buildSourceMarker(input.request),
  });

  if (existing !== null) {
    const updated = await input.client.updateIssue({
      issueId: existing.id,
      description: descriptionWithPortfolio,
      labelIds: resolvedLabelIds,
      projectId: targetProjectId,
      ...(parent !== null ? { parentId: parent.id } : {}),
    });
    return {
      operation: "updated",
      issueTitle: updated.title,
      issueIdentifier: updated.identifier,
      parentIdentifier: parent?.identifier ?? null,
    };
  }

  const created = await input.client.createIssue({
    teamId: primaryIssue.teamId,
    title: summary.title,
    projectId: targetProjectId,
    labelIds: resolvedLabelIds,
    description: descriptionWithPortfolio,
    ...(parent !== null ? { parentId: parent.id } : {}),
  });
  return {
    operation: "created",
    issueTitle: created.title,
    issueIdentifier: created.identifier,
    parentIdentifier: parent?.identifier ?? null,
  };
}

async function findMatchingOpenIssue(input: {
  client: TrackerIssueWriterClient;
  title: string;
  projectId: string;
  terminalStates: string[];
  marker: string;
}): Promise<TrackerIssueReference | null> {
  const candidates = await input.client.findOpenIssuesByTitle({
    projectId: input.projectId,
    title: input.title,
    excludeStateNames: input.terminalStates,
  });

  return (
    candidates.find((candidate) =>
      candidate.description?.includes(input.marker),
    ) ?? null
  );
}

function summarizeTrackerWriteRequest(request: TrackerIssueWriteRequest): {
  title: string;
  sourceIssueIds: string[];
} {
  if (request.boundary.type === "explicit_finding") {
    const identifiers = [...request.boundary.finding.issueIdentifiers].sort();
    return {
      title: `Dispatcher follow-up: ${request.boundary.finding.kind} for ${identifiers.join(" + ")}`,
      sourceIssueIds: [...request.boundary.finding.workerIds],
    };
  }

  return {
    title: `Dispatcher follow-up: ${request.boundary.label}`,
    sourceIssueIds: [...request.boundary.sourceIssueIds],
  };
}

function resolveRelevantLabels(
  request: TrackerIssueWriteRequest,
  sourceIssues: readonly TrackerIssueReference[],
): string[] {
  const sourceRiskLabels = sourceIssues.flatMap((issue) =>
    issue.labels.filter((label) => label.startsWith("risk:")),
  );
  if (request.boundary.type === "explicit_finding") {
    return [...new Set(["supervision", ...sourceRiskLabels])].sort();
  }

  const sourceModeLabels = sourceIssues.flatMap((issue) =>
    issue.labels.filter((label) => label.startsWith("mode:")),
  );
  return [...new Set([...sourceModeLabels, ...sourceRiskLabels])].sort();
}

function resolveCommonParent(
  sourceIssues: readonly TrackerIssueReference[],
): TrackerIssueReference["parent"] {
  const firstParent = sourceIssues[0]?.parent ?? null;
  if (firstParent === null) {
    return null;
  }

  return sourceIssues.every((issue) => issue.parent?.id === firstParent.id)
    ? firstParent
    : null;
}

function formatTrackerIssueDescription(input: {
  request: TrackerIssueWriteRequest;
  sourceIssues: readonly TrackerIssueReference[];
  labelNames: readonly string[];
  parent: TrackerIssueReference["parent"];
  now: Date;
}): string {
  const marker = buildSourceMarker(input.request);
  const lines = [marker, "", "## Scope", ""];

  if (input.request.boundary.type === "explicit_finding") {
    lines.push(
      `Dispatcher deterministic supervision surfaced a \`${input.request.boundary.finding.kind}\` finding during the \`${input.request.boundary.phase}\` phase and promoted it into bounded tracker work.`,
    );
  } else {
    lines.push(
      `Dispatcher promoted a workflow boundary event into bounded tracker work: ${input.request.boundary.summary}`,
    );
  }

  lines.push("", "## Source Refs", "");
  if (input.request.boundary.type === "explicit_finding") {
    lines.push(
      `- Boundary: explicit finding / ${input.request.boundary.phase}`,
      `- Finding: \`${input.request.boundary.finding.kind}\` -> \`${input.request.boundary.finding.action}\``,
      `- Dispatcher note: ${input.request.boundary.finding.message}`,
    );
    if (input.request.boundary.finding.files.length > 0) {
      lines.push(
        `- Files: ${input.request.boundary.finding.files
          .map((file) => `\`${file}\``)
          .join(", ")}`,
      );
    }
  } else {
    lines.push(
      `- Boundary: promotion / ${input.request.boundary.label}`,
      `- Dispatcher note: ${input.request.boundary.summary}`,
    );
  }
  lines.push(`- Observed at: ${input.now.toISOString()}`);

  lines.push("", "## Acceptance Criteria", "");
  lines.push(
    "- Confirm the cited deterministic finding or promotion boundary from the linked source issues.",
    "- Land a bounded fix, reroute, or policy change that removes the dispatcher follow-up condition.",
    "- Record verification that the dispatcher can resume without repeating the same bounded trigger.",
  );

  if (input.parent !== null) {
    lines.push("", "## Parent Issue", "");
    lines.push(formatLinkedIssue(input.parent));
  }

  lines.push("", "## Related Issues", "");
  for (const issue of [...input.sourceIssues].sort((left, right) =>
    left.identifier.localeCompare(right.identifier),
  )) {
    lines.push(formatLinkedIssue(issue));
  }

  lines.push("", "## Relevant Labels", "");
  for (const label of input.labelNames) {
    lines.push(`- ${label}`);
  }

  lines.push("", "## Notes", "");
  lines.push(
    "- Keep this work bounded to the cited finding or boundary; do not broaden scope without filing a separate follow-up.",
    "- Source authority: `SPEC.mobilyze.md` reviewable increment 3 and the linked source issues above.",
  );

  return lines.join("\n");
}

function formatLinkedIssue(issue: {
  identifier: string;
  title: string;
  url: string | null;
}): string {
  return issue.url === null
    ? `- ${issue.identifier}: ${issue.title}`
    : `- [${issue.identifier}](${issue.url}): ${issue.title}`;
}

function buildSourceMarker(request: TrackerIssueWriteRequest): string {
  if (request.boundary.type === "explicit_finding") {
    return [
      "<!-- symphony-tracker-write -->",
      `<!-- boundary:explicit_finding:${request.boundary.phase}:${request.boundary.finding.kind} -->`,
      `<!-- source-issue-ids:${[...request.boundary.finding.workerIds].sort().join(",")} -->`,
    ].join("\n");
  }

  return [
    "<!-- symphony-tracker-write -->",
    `<!-- boundary:promotion_boundary:${request.boundary.label} -->`,
    `<!-- source-issue-ids:${[...request.boundary.sourceIssueIds].sort().join(",")} -->`,
  ].join("\n");
}
