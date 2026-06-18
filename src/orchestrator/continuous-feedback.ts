import type {
  ContinuousFeedbackEvent,
  ContinuousFeedbackFinding,
  ContinuousFeedbackIssueState,
  ContinuousFeedbackLane,
  ContinuousFeedbackStatus,
} from "../domain/model.js";

export const CONTINUOUS_FEEDBACK_PROVIDER_FAILURE_SUMMARY_PREFIX =
  "Continuous feedback provider exited";

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
  status?: ContinuousFeedbackStatus;
}

export interface ContinuousFeedbackCheckpointInput {
  issueId: string;
  issueIdentifier: string;
  event: ContinuousFeedbackEvent;
  checkedAt: string;
  workerLane: ContinuousFeedbackLane;
  reviewerLane: ContinuousFeedbackLane;
  findings: ContinuousFeedbackFindingInput[];
  status?: ContinuousFeedbackStatus;
  summary?: string | null;
}

export function ensureDecorrelatedFeedbackLane(
  preferredLane: ContinuousFeedbackLane,
  workerLane: ContinuousFeedbackLane,
): ContinuousFeedbackLane {
  if (!isSameLane(preferredLane, workerLane)) {
    return preferredLane;
  }
  // Decorrelate by ROLE only (SYMPH-762). The prior `${model}-reviewer` mutation
  // produced a model id no runner can resolve, so a same-lane worker/reviewer
  // pair always failed with "model not found" and the lane silently degraded to
  // unavailable. The model must stay a real, resolvable id; the `-decorrelated`
  // role suffix carries the decorrelation (the reviewer prompt differs by role).
  return {
    ...preferredLane,
    role: `${preferredLane.role}-decorrelated`,
  };
}

/**
 * Injection-hygiene policy (SYMPH-378): mid-flight feedback must carry NEW
 * signal — a confirmed blocker, a concrete correction, or a scope stop —
 * never restatement of the task or a raised proof bar. The mechanical
 * proxy: a finding must either be `blocking` (blockers and scope stops) or
 * cite a concrete location (`file`). Ungrounded advisory findings are the
 * restatement shape; they get status `suppressed` — journaled for
 * measurement, never bounced, never commented. The semantic half of the
 * policy lives in the reviewer-lane prompt (continuous-feedback-provider).
 */
export function feedbackFindingCarriesNewSignal(
  finding: ContinuousFeedbackFindingInput,
): boolean {
  // Trim-aware: an empty or whitespace `file` must not defeat the
  // grounding proxy (council R1 — `"" != null` is true).
  return (
    finding.severity === "blocking" ||
    (finding.file != null && finding.file.trim() !== "")
  );
}

export function mergeContinuousFeedbackCheckpoint(
  previous: ContinuousFeedbackIssueState | undefined,
  input: ContinuousFeedbackCheckpointInput,
): ContinuousFeedbackIssueState {
  const checkpointStatus = input.status ?? "pass";
  const unavailable = checkpointStatus === "unavailable";
  const existing = new Map(
    (previous?.findings ?? []).map((finding) => [finding.signature, finding]),
  );
  // Resolution requires a genuinely clean checkpoint (no raw findings at
  // all — the prompt defines empty as "clean", with still-unaddressed
  // findings re-reported). A checkpoint whose findings were all
  // suppressed carries NO signal about prior opens: it must not resolve
  // them (council R1 — the only-new-signal prompt changed what an empty
  // array means, so emptiness and suppressed-only must diverge).
  const nextFindings =
    input.findings.length === 0 && !unavailable
      ? (previous?.findings ?? []).map((finding) =>
          finding.status === "open"
            ? {
                ...finding,
                status: "resolved" as const,
                lastSeenAt: input.checkedAt,
              }
            : finding,
        )
      : [...(previous?.findings ?? [])];

  for (const rawFinding of input.findings) {
    const signature = normalizeFeedbackSignature(rawFinding);
    // Classified on every arrival, but grounding once established carries
    // forward: an already-open finding is never demoted to suppressed by a
    // re-sighting that merely drops its file (council R1 — reviewer
    // non-determinism must not silently downgrade a confirmed finding). A
    // previously suppressed finding that returns WITH evidence is admitted.
    const admitted = feedbackFindingCarriesNewSignal(rawFinding);
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
        status: admitted || current.status === "open" ? "open" : "suppressed",
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
      status: admitted ? "open" : "suppressed",
      reviewerLane: input.reviewerLane,
    };
    existing.set(signature, finding);
    nextFindings.push(finding);
  }

  return {
    // Post-merge truth: a checkpoint passes only when nothing is open —
    // residual opens from prior checkpoints keep the state at "finding"
    // even when the current arrivals were all suppressed (council R1:
    // the journal must never say pass while a bounce can still fire).
    status: unavailable
      ? "unavailable"
      : nextFindings.some((finding) => finding.status === "open")
        ? "finding"
        : "pass",
    summary: input.summary ?? null,
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
