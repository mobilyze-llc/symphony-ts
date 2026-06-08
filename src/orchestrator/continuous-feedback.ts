import type {
  ContinuousFeedbackEvent,
  ContinuousFeedbackFinding,
  ContinuousFeedbackIssueState,
  ContinuousFeedbackLane,
} from "../domain/model.js";

export interface ContinuousFeedbackFindingInput {
  signature?: string | null;
  title: string;
  detail?: string | null;
  severity?: "info" | "warning" | "blocking" | null;
  file?: string | null;
  line?: number | null;
}

export interface ContinuousFeedbackReviewResult {
  summary?: string | null;
  findings: ContinuousFeedbackFindingInput[];
}

export interface ContinuousFeedbackCheckpointInput {
  issueId: string;
  issueIdentifier: string;
  event: ContinuousFeedbackEvent;
  checkedAt: string;
  workerLane: ContinuousFeedbackLane;
  reviewerLane: ContinuousFeedbackLane;
  findings: ContinuousFeedbackFindingInput[];
}

export function ensureDecorrelatedFeedbackLane(
  preferredLane: ContinuousFeedbackLane,
  workerLane: ContinuousFeedbackLane,
): ContinuousFeedbackLane {
  if (!isSameLane(preferredLane, workerLane)) {
    return preferredLane;
  }
  return {
    ...preferredLane,
    role: `${preferredLane.role}-decorrelated`,
    model:
      preferredLane.model === null
        ? "local-flash-reviewer"
        : `${preferredLane.model}-reviewer`,
  };
}

export function mergeContinuousFeedbackCheckpoint(
  previous: ContinuousFeedbackIssueState | undefined,
  input: ContinuousFeedbackCheckpointInput,
): ContinuousFeedbackIssueState {
  const existing = new Map(
    (previous?.findings ?? []).map((finding) => [finding.signature, finding]),
  );
  const nextFindings = [...(previous?.findings ?? [])];

  for (const rawFinding of input.findings) {
    const signature = normalizeFeedbackSignature(rawFinding);
    const current = existing.get(signature);
    if (current !== undefined) {
      const updated: ContinuousFeedbackFinding = {
        ...current,
        title: normalizeText(rawFinding.title, current.title),
        detail: normalizeText(rawFinding.detail, current.detail),
        severity: rawFinding.severity ?? current.severity,
        file: rawFinding.file ?? current.file,
        line: rawFinding.line ?? current.line,
        lastSeenAt: input.checkedAt,
        occurrences: current.occurrences + 1,
        status: "open",
        reviewerLane: input.reviewerLane,
      };
      existing.set(signature, updated);
      const index = nextFindings.findIndex(
        (finding) => finding.signature === signature,
      );
      if (index >= 0) {
        nextFindings[index] = updated;
      }
      continue;
    }

    const finding: ContinuousFeedbackFinding = {
      signature,
      title: normalizeText(rawFinding.title, "Continuous feedback finding"),
      detail: normalizeText(rawFinding.detail, ""),
      severity: rawFinding.severity ?? "warning",
      file: rawFinding.file ?? null,
      line: rawFinding.line ?? null,
      firstSeenAt: input.checkedAt,
      lastSeenAt: input.checkedAt,
      occurrences: 1,
      status: "open",
      reviewerLane: input.reviewerLane,
    };
    existing.set(signature, finding);
    nextFindings.push(finding);
  }

  return {
    status: input.findings.length === 0 ? "pass" : "finding",
    lastEvent: input.event,
    lastCheckedAt: input.checkedAt,
    reviewerLane: input.reviewerLane,
    workerLane: input.workerLane,
    findings: nextFindings,
  };
}

export function getOpenContinuousFeedbackFindings(
  feedback: ContinuousFeedbackIssueState | undefined,
): ContinuousFeedbackFinding[] {
  return (feedback?.findings ?? []).filter(
    (finding) => finding.status === "open",
  );
}

export function markContinuousFeedbackFindingsBounced(
  feedback: ContinuousFeedbackIssueState,
  signatures: readonly string[],
): ContinuousFeedbackIssueState {
  const bounced = new Set(signatures);
  return {
    ...feedback,
    findings: feedback.findings.map((finding) =>
      bounced.has(finding.signature)
        ? { ...finding, status: "bounced" }
        : finding,
    ),
  };
}

export function formatContinuousFeedbackComment(input: {
  issueIdentifier: string;
  stageName: string | null;
  findings: readonly ContinuousFeedbackFinding[];
}): string {
  const lines = [
    "## Continuous Feedback Findings",
    "",
    `**Issue:** ${input.issueIdentifier}`,
    `**Stage:** ${input.stageName ?? "unscoped"}`,
    "",
    "This cheap feedback lane is non-authoritative. It redirects inner-loop work while the terminal gate remains the merge decision.",
    "",
  ];
  for (const finding of input.findings) {
    const location =
      finding.file === null
        ? ""
        : ` (${finding.file}${finding.line === null ? "" : `:${finding.line}`})`;
    lines.push(
      `- **${finding.severity.toUpperCase()}** ${finding.title}${location}`,
    );
    if (finding.detail.trim() !== "") {
      lines.push(`  ${finding.detail}`);
    }
  }
  return lines.join("\n");
}

function isSameLane(
  left: ContinuousFeedbackLane,
  right: ContinuousFeedbackLane,
): boolean {
  return left.runner === right.runner && left.model === right.model;
}

function normalizeFeedbackSignature(
  finding: ContinuousFeedbackFindingInput,
): string {
  const explicit = finding.signature?.trim();
  if (explicit !== undefined && explicit !== "") {
    return explicit;
  }
  return [
    finding.severity ?? "warning",
    finding.file ?? "nofile",
    finding.line?.toString() ?? "noline",
    normalizeText(finding.title, "finding").toLowerCase(),
  ].join(":");
}

function normalizeText(
  value: string | null | undefined,
  fallback: string,
): string {
  const normalized = value?.trim();
  return normalized === undefined || normalized === "" ? fallback : normalized;
}
