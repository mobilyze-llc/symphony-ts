/**
 * SYMPH-810 — structured, inspectable browser-QA evidence for the crabrunner
 * review/QA job group.
 *
 * The QA lane is substrate-neutral like the reviewer lanes: it produces a
 * STRUCTURED artifact (not unstructured prose) that records exactly what was
 * exercised — target URL, the reviewed head SHA, the scenario, the assertions
 * that were checked, media references, console/network findings, and the
 * failure rule that decides pass/fail. The assessor is fail-closed: a missing,
 * malformed, or degraded artifact, a failed assertion, or a violated failure
 * rule blocks (or degrades, per policy) the stage. It never silently passes.
 *
 * This module owns only the QA evidence shape + its assessment. It does not
 * touch merge-readiness, the review-result validator, or the reviewer-lane
 * verdict aggregation (those live in review-verdict / the orchestrator).
 */

export type BrowserQaConsoleLevel = "log" | "info" | "warn" | "error";

export interface BrowserQaAssertion {
  description: string;
  passed: boolean;
}

export interface BrowserQaMediaRef {
  kind: "screenshot" | "video" | "trace" | "har";
  path: string;
  sha256: string | null;
}

export interface BrowserQaConsoleFinding {
  level: BrowserQaConsoleLevel;
  message: string;
}

export interface BrowserQaNetworkFinding {
  url: string;
  status: number | null;
  method: string | null;
  failure: string | null;
}

/**
 * The rule that decides whether the QA run is a pass. `violated` is the
 * authoritative producer-side signal; the assessor independently re-checks
 * assertions so a producer that forgets to set `violated` still fails closed.
 */
export interface BrowserQaFailureRule {
  id: string;
  description: string;
  violated: boolean;
}

export interface BrowserQaEvidence {
  schemaVersion: 1;
  kind: "symphony-browser-qa-evidence";
  /** The exact URL the scenario exercised — load-bearing for traceability. */
  targetUrl: string;
  /** The PR head SHA the QA run targeted (freshness/provenance binding). */
  headSha: string;
  scenario: string;
  assertions: BrowserQaAssertion[];
  mediaRefs: BrowserQaMediaRef[];
  consoleFindings: BrowserQaConsoleFinding[];
  networkFindings: BrowserQaNetworkFinding[];
  failureRule: BrowserQaFailureRule;
}

export type BrowserQaDisposition = "pass" | "block" | "degrade";

export interface BrowserQaAssessment {
  disposition: BrowserQaDisposition;
  /** True for any non-pass disposition (block OR degrade both gate the stage). */
  blocking: boolean;
  /** Machine-readable reasons (never just prose) for the disposition. */
  reasons: string[];
}

export interface AssessBrowserQaEvidenceOptions {
  /**
   * Policy for a missing/null QA artifact. `"block"` (default) fails closed;
   * `"degrade"` records an explicit degraded disposition (still gating).
   */
  policy?: "block" | "degrade";
  /**
   * The current PR head SHA the QA run must have targeted (freshness). When
   * provided, a QA artifact bound to any other head SHA is stale and fails
   * closed — the same head-assertion the reviewer lanes enforce. When omitted,
   * only the presence of `headSha` is checked (back-compat).
   */
  currentHeadSha?: string;
}

const CONSOLE_LEVELS: ReadonlySet<string> = new Set([
  "log",
  "info",
  "warn",
  "error",
]);
const MEDIA_KINDS: ReadonlySet<string> = new Set([
  "screenshot",
  "video",
  "trace",
  "har",
]);

/**
 * Fail-closed assessment of a browser-QA artifact. A `null` artifact (missing
 * QA evidence) blocks or degrades per policy. A present artifact blocks when any
 * required field is missing, when there are no assertions, when any assertion
 * failed, or when the failure rule is violated.
 */
export function assessBrowserQaEvidence(
  evidence: BrowserQaEvidence | null,
  options: AssessBrowserQaEvidenceOptions = {},
): BrowserQaAssessment {
  if (evidence === null) {
    const disposition = options.policy === "degrade" ? "degrade" : "block";
    return {
      disposition,
      blocking: true,
      reasons: ["qa_evidence_missing"],
    };
  }

  const reasons: string[] = [];

  // Structural completeness: the load-bearing identity fields must be present,
  // otherwise the evidence cannot be tied to what was exercised.
  if (evidence.targetUrl.trim() === "") {
    reasons.push("qa_evidence_malformed:targetUrl");
  }
  if (evidence.headSha.trim() === "") {
    reasons.push("qa_evidence_malformed:headSha");
  } else if (
    options.currentHeadSha !== undefined &&
    evidence.headSha !== options.currentHeadSha
  ) {
    // Freshness: a QA run captured against an older commit must not count
    // toward a PASS, mirroring the reviewer-lane current-head assertion.
    reasons.push("qa_stale_review");
  }
  if (evidence.scenario.trim() === "") {
    reasons.push("qa_evidence_malformed:scenario");
  }
  if (evidence.failureRule.id.trim() === "") {
    reasons.push("qa_evidence_malformed:failureRule");
  }

  if (evidence.assertions.length === 0) {
    reasons.push("qa_no_assertions");
  } else if (evidence.assertions.some((assertion) => !assertion.passed)) {
    // Independent re-check: a failed assertion blocks even if the producer
    // forgot to flip the failure rule.
    reasons.push("qa_assertion_failed");
  }

  if (evidence.failureRule.violated) {
    reasons.push(
      `qa_failure_rule_violated:${evidence.failureRule.id || "unknown"}`,
    );
  }

  if (reasons.length === 0) {
    return { disposition: "pass", blocking: false, reasons: [] };
  }

  return { disposition: "block", blocking: true, reasons };
}

/**
 * Parse an unknown record (e.g. a collected crabrunner artifact) into typed
 * browser-QA evidence. Returns `null` for any non-object, wrong-kind, or
 * wrong-schema input so the assessor fails closed rather than throwing.
 * Malformed nested entries are dropped, not fatal — the assessor then sees an
 * incomplete (and therefore blocking) artifact.
 */
export function parseBrowserQaEvidence(
  value: unknown,
): BrowserQaEvidence | null {
  const record = recordOrNull(value);
  if (record === null) {
    return null;
  }
  if (
    record.kind !== "symphony-browser-qa-evidence" ||
    record.schemaVersion !== 1
  ) {
    return null;
  }

  const failureRule = parseFailureRule(record.failureRule);
  if (failureRule === null) {
    return null;
  }

  return {
    schemaVersion: 1,
    kind: "symphony-browser-qa-evidence",
    targetUrl: readString(record.targetUrl),
    headSha: readString(record.headSha),
    scenario: readString(record.scenario),
    assertions: readArray(record.assertions, parseAssertion),
    mediaRefs: readArray(record.mediaRefs, parseMediaRef),
    consoleFindings: readArray(record.consoleFindings, parseConsoleFinding),
    networkFindings: readArray(record.networkFindings, parseNetworkFinding),
    failureRule,
  };
}

function parseFailureRule(value: unknown): BrowserQaFailureRule | null {
  const record = recordOrNull(value);
  if (record === null) {
    return null;
  }
  // `violated` is the pass/fail decision: it MUST be an explicit boolean. An
  // omitted or wrong-typed value is malformed and fails closed (null) rather
  // than silently coercing to false, which would let a malformed artifact pass.
  if (typeof record.violated !== "boolean") {
    return null;
  }
  return {
    id: readString(record.id),
    description: readString(record.description),
    violated: record.violated,
  };
}

function parseAssertion(value: unknown): BrowserQaAssertion | null {
  const record = recordOrNull(value);
  if (record === null || typeof record.description !== "string") {
    return null;
  }
  return {
    description: record.description,
    passed: record.passed === true,
  };
}

function parseMediaRef(value: unknown): BrowserQaMediaRef | null {
  const record = recordOrNull(value);
  if (
    record === null ||
    typeof record.kind !== "string" ||
    !MEDIA_KINDS.has(record.kind) ||
    typeof record.path !== "string"
  ) {
    return null;
  }
  return {
    kind: record.kind as BrowserQaMediaRef["kind"],
    path: record.path,
    sha256: typeof record.sha256 === "string" ? record.sha256 : null,
  };
}

function parseConsoleFinding(value: unknown): BrowserQaConsoleFinding | null {
  const record = recordOrNull(value);
  if (
    record === null ||
    typeof record.level !== "string" ||
    !CONSOLE_LEVELS.has(record.level) ||
    typeof record.message !== "string"
  ) {
    return null;
  }
  return {
    level: record.level as BrowserQaConsoleLevel,
    message: record.message,
  };
}

function parseNetworkFinding(value: unknown): BrowserQaNetworkFinding | null {
  const record = recordOrNull(value);
  if (record === null || typeof record.url !== "string") {
    return null;
  }
  return {
    url: record.url,
    status: typeof record.status === "number" ? record.status : null,
    method: typeof record.method === "string" ? record.method : null,
    failure: typeof record.failure === "string" ? record.failure : null,
  };
}

function readArray<T>(
  value: unknown,
  parse: (entry: unknown) => T | null,
): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const parsed: T[] = [];
  for (const entry of value) {
    const result = parse(entry);
    if (result !== null) {
      parsed.push(result);
    }
  }
  return parsed;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
