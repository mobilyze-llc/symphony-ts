import {
  PORTFOLIO_CLASSIFIER_VERSION,
  PORTFOLIO_INTAKE_PROJECT,
  PORTFOLIO_TAXONOMY_PROJECTS,
  type PortfolioProject,
  findForbiddenPortfolioProject,
  findPortfolioProject,
  isPortfolioTeamKey,
  normalizePortfolioName,
} from "./taxonomy.js";

export type PortfolioClassificationStatus =
  | "not_applicable"
  | "valid"
  | "repair"
  | "intake";

export interface PortfolioIssueParentHint {
  identifier?: string | null;
  projectId?: string | null;
  projectSlug?: string | null;
  projectName?: string | null;
}

export interface PortfolioClassificationInput {
  identifier?: string | null;
  title?: string | null;
  description?: string | null;
  teamKey?: string | null;
  projectId?: string | null;
  projectSlug?: string | null;
  projectName?: string | null;
  parent?: PortfolioIssueParentHint | null;
}

export interface PortfolioClassificationResult {
  classifierVersion: string;
  status: PortfolioClassificationStatus;
  confidence: "none" | "low" | "medium" | "high";
  reason: string;
  teamKey: string | null;
  observedProject: {
    id: string | null;
    slugId: string | null;
    name: string | null;
  };
  targetProject: PortfolioProject | null;
  intakeProject: PortfolioProject | null;
  candidates: PortfolioProject[];
  whyUncertain: string | null;
}

interface CandidateScore {
  project: PortfolioProject;
  score: number;
}

export function classifyPortfolioIssue(
  input: PortfolioClassificationInput,
): PortfolioClassificationResult {
  const teamKey = input.teamKey ?? inferTeamKey(input.identifier ?? null);
  const observedProject = {
    id: input.projectId ?? null,
    slugId: input.projectSlug ?? null,
    name: input.projectName ?? null,
  };

  if (!isPortfolioTeamKey(teamKey)) {
    return result({
      status: "not_applicable",
      confidence: "none",
      reason: "Issue is outside the SYMPH/MOB portfolio enforcement teams.",
      teamKey,
      observedProject,
    });
  }

  const forbidden = findForbiddenPortfolioProject(observedProject);
  if (forbidden !== null) {
    return result({
      status: "intake",
      confidence: "low",
      reason:
        "`Pipeline` is reserved for Symphony automation and is not a portfolio taxonomy target.",
      teamKey,
      observedProject,
      candidates: inferCandidateProjects(input).map(
        (candidate) => candidate.project,
      ),
      whyUncertain:
        "Observed project is forbidden for portfolio classification; a human or classifier must choose a taxonomy project.",
    });
  }

  const currentProject = findPortfolioProject(observedProject);
  if (currentProject !== null) {
    if (currentProject.kind === "intake") {
      return result({
        status: "intake",
        confidence: "low",
        reason:
          "Issue is already in the portfolio intake project and is not selectable for execution.",
        teamKey,
        observedProject,
        candidates: inferCandidateProjects(input).map(
          (candidate) => candidate.project,
        ),
        whyUncertain:
          "Intake membership is a dead-letter state until why_uncertain and candidate projects are resolved.",
      });
    }
    return result({
      status: "valid",
      confidence: "high",
      reason:
        "Observed Linear project is a registered portfolio taxonomy target.",
      teamKey,
      observedProject,
      targetProject: currentProject,
    });
  }

  const explicitHint = parsePortfolioProjectHint(input.description ?? null);
  const explicitProject =
    explicitHint === null ? null : findPortfolioProject({ name: explicitHint });
  if (explicitProject !== null && explicitProject.kind !== "intake") {
    return result({
      status: "repair",
      confidence: "high",
      reason:
        "Issue body carries an explicit Portfolio Classification project hint.",
      teamKey,
      observedProject,
      targetProject: explicitProject,
    });
  }

  const parentProject =
    input.parent === null || input.parent === undefined
      ? null
      : findPortfolioProject({
          id: input.parent.projectId ?? null,
          slugId: input.parent.projectSlug ?? null,
          name: input.parent.projectName ?? null,
        });
  if (
    parentProject !== null &&
    parentProject.kind !== "intake" &&
    observedProject.id === null &&
    observedProject.slugId === null &&
    observedProject.name === null
  ) {
    return result({
      status: "repair",
      confidence: "medium",
      reason: `Issue inherits portfolio project from parent ${input.parent?.identifier ?? "(unknown)"}.`,
      teamKey,
      observedProject,
      targetProject: parentProject,
    });
  }

  const candidates = inferCandidateProjects(input);
  if (candidates.length === 1 && candidates[0]?.score !== undefined) {
    return result({
      status: "repair",
      confidence: candidates[0].score >= 2 ? "medium" : "low",
      reason:
        "Deterministic title/body keywords identify one registered portfolio target.",
      teamKey,
      observedProject,
      targetProject: candidates[0].project,
      candidates: [candidates[0].project],
    });
  }

  return result({
    status: "intake",
    confidence: "low",
    reason:
      observedProject.id === null &&
      observedProject.slugId === null &&
      observedProject.name === null
        ? "No Linear project metadata is present."
        : "Observed Linear project is not in the portfolio taxonomy registry.",
    teamKey,
    observedProject,
    candidates: candidates.slice(0, 3).map((candidate) => candidate.project),
    whyUncertain:
      candidates.length === 0
        ? "No deterministic project hint matched the title, description, parent, or current project metadata."
        : "Multiple deterministic project hints matched; refusing to invent product intent.",
  });
}

export function renderPortfolioClassificationBlock(
  classification: PortfolioClassificationResult,
): string {
  const project =
    classification.targetProject ?? classification.intakeProject ?? null;
  const lines = [
    "## Portfolio Classification",
    "",
    `Project: ${project === null ? "(none)" : `\`${project.name}\``}`,
    `Project ID: ${project?.id ?? "(none)"}`,
    `Classifier: ${classification.classifierVersion}`,
    `Status: ${classification.status}`,
    `Confidence: ${classification.confidence}`,
    `Reason: ${classification.reason}`,
  ];
  if (classification.whyUncertain !== null) {
    lines.push(`why_uncertain: ${classification.whyUncertain}`);
  }
  if (classification.candidates.length > 0) {
    lines.push(
      `Candidate projects: ${classification.candidates
        .map((candidate) => candidate.name)
        .join("; ")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function upsertPortfolioClassificationBlock(
  description: string,
  classification: PortfolioClassificationResult,
): string {
  const block = renderPortfolioClassificationBlock(classification).trimEnd();
  const source = description.trimEnd();
  const marker = /^## Portfolio Classification\s*$/m.exec(source);
  if (marker === null) {
    return source === "" ? `${block}\n` : `${source}\n\n${block}\n`;
  }

  const afterMarkerStart = marker.index + marker[0].length;
  const nextHeading = /\n## (?!Portfolio Classification\s*$)/m.exec(
    source.slice(afterMarkerStart),
  );
  const before = source.slice(0, marker.index).trimEnd();
  const after =
    nextHeading === null
      ? ""
      : source.slice(afterMarkerStart + nextHeading.index).trimStart();
  return `${[before, block, after].filter((part) => part !== "").join("\n\n")}\n`;
}

function result(
  input: Omit<
    PortfolioClassificationResult,
    | "classifierVersion"
    | "intakeProject"
    | "candidates"
    | "targetProject"
    | "whyUncertain"
  > & {
    targetProject?: PortfolioProject | null;
    candidates?: PortfolioProject[];
    whyUncertain?: string | null;
  },
): PortfolioClassificationResult {
  const { candidates, targetProject, whyUncertain, ...rest } = input;
  return {
    classifierVersion: PORTFOLIO_CLASSIFIER_VERSION,
    ...rest,
    targetProject: targetProject ?? null,
    intakeProject: rest.status === "intake" ? PORTFOLIO_INTAKE_PROJECT : null,
    candidates: candidates ?? [],
    whyUncertain: whyUncertain ?? null,
  };
}

function inferTeamKey(identifier: string | null): string | null {
  if (identifier === null) {
    return null;
  }
  const prefix = identifier.split("-")[0];
  return prefix === "SYMPH" || prefix === "MOB" ? prefix : null;
}

function parsePortfolioProjectHint(description: string | null): string | null {
  if (description === null) {
    return null;
  }
  const lines = description.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    /^##+\s+Portfolio Classification\s*$/i.test(line.trim()),
  );
  if (start === -1) {
    return null;
  }
  for (const line of lines.slice(start + 1)) {
    if (/^##+\s+/.test(line.trim())) {
      return null;
    }
    const match = /^Project:\s*`?([^`]+?)`?\s*$/i.exec(line.trim());
    if (match?.[1] !== undefined) {
      const project = match[1].trim();
      return project === "" || project === "(none)" ? null : project;
    }
  }
  return null;
}

function inferCandidateProjects(
  input: PortfolioClassificationInput,
): CandidateScore[] {
  const haystack = normalizePortfolioName(
    [
      input.identifier ?? "",
      input.title ?? "",
      input.description ?? "",
      input.projectName ?? "",
      input.parent?.projectName ?? "",
    ].join(" "),
  );
  const scores = PORTFOLIO_TAXONOMY_PROJECTS.filter(
    (project) => project.kind === "taxonomy",
  )
    .map((project) => ({
      project,
      score: project.keywords.reduce((count, keyword) => {
        const normalized = normalizePortfolioName(keyword);
        return haystack.includes(normalized) ? count + 1 : count;
      }, 0),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);
  if (scores.length <= 1) {
    return scores;
  }
  const topScore = scores[0]?.score ?? 0;
  return scores.filter((candidate) => candidate.score === topScore);
}
