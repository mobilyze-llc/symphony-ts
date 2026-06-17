import type { RightSizingDecision } from "../domain/model.js";

/**
 * Admission card (SYMPH-379): when the dispatcher admits an issue, the
 * decision it already computed is published to the issue as one compact,
 * bounded comment — eligibility basis, right-sizing route, risk surface,
 * and the expected verification path. Derived entirely from journaled
 * decision data; no model calls. Makes admission auditable by the
 * operator and contestable by later agents without reading the journal.
 */

const MAX_SCOPE_FILES = 8;

function describeModelRouting(
  reason: RightSizingDecision["modelRouting"]["reason"],
): string {
  switch (reason) {
    case "not_needed":
      return "advisory: deterministic route sufficed (no model consult)";
    case "ambiguous_routing":
      return "advisory: model consult recommended because deterministic signals were ambiguous";
    case "risk_trigger":
      return "advisory: model consult recommended because a risk trigger matched";
    default: {
      // Exhaustiveness guard: a new routing reason must be described here
      // rather than silently rendering as some other reason's label.
      const unhandled: never = reason;
      return `model consult: ${String(unhandled)}`;
    }
  }
}

export interface AdmissionCardInput {
  issueIdentifier: string;
  stageName: string | null;
  decision: RightSizingDecision;
  budgetMultiplier: number;
  /** A gate-passed frozen AC snapshot already exists for this issue. */
  hasFrozenAcceptanceCriteria: boolean;
  /**
   * The dispatched route skips the investigate AC gate (SYMPH-765) — e.g. a
   * fast-track / direct-to-implement issue. Defaults to false. When true and no
   * AC is frozen, the verification line must NOT claim an investigate exit gate
   * will author and freeze criteria, because that stage never runs.
   */
  skipsAcGate?: boolean;
}

export function formatAdmissionCard(input: AdmissionCardInput): string {
  const { decision } = input;
  const scopeFiles = decision.signals.declaredScopeFiles;
  const scopeLine =
    scopeFiles.length === 0
      ? "none declared"
      : scopeFiles.slice(0, MAX_SCOPE_FILES).join(", ") +
        (scopeFiles.length > MAX_SCOPE_FILES
          ? ` (+${scopeFiles.length - MAX_SCOPE_FILES} more)`
          : "");
  const budgetLine =
    input.budgetMultiplier > 1
      ? `${decision.mode} ceilings × ${input.budgetMultiplier} (escalated)`
      : `${decision.mode} ceilings`;
  const verificationLine = input.hasFrozenAcceptanceCriteria
    ? "frozen acceptance criteria on record — implement satisfies them in-session; spec-fidelity judges the diff at review exit"
    : input.skipsAcGate === true
      ? "no frozen acceptance criteria and this route skips the investigate AC gate — the ticket has no `## Acceptance Criteria` section to freeze, so spec-fidelity is non-gating (no canonical rubric) and merge gating rests on the council review result"
      : "acceptance criteria not yet frozen — the investigate exit gate authors and freezes them before implement";
  const modelRoutingLine = describeModelRouting(decision.modelRouting.reason);
  const riskFiles = decision.signals.highRiskFiles;
  const riskLines =
    riskFiles.length === 0
      ? []
      : [
          `**Risk surface:** touches high-risk files — ${riskFiles
            .slice(0, MAX_SCOPE_FILES)
            .join(", ")}${
            riskFiles.length > MAX_SCOPE_FILES
              ? ` (+${riskFiles.length - MAX_SCOPE_FILES} more)`
              : ""
          }`,
        ];

  return [
    "## Admission Card",
    "",
    `**Issue:** ${input.issueIdentifier}`,
    `**Decision:** admit → ${input.stageName ?? "initial stage"}`,
    "**Eligibility:** passed deterministic eligibility and disjointness checks",
    `**Right-sizing:** \`${decision.mode}\` via \`${decision.classifier}\` — ${decision.reason}`,
    `**Model routing (advisory):** ${modelRoutingLine}`,
    `**Budget:** ${budgetLine}`,
    `**Declared scope:** ${scopeLine}`,
    ...riskLines,
    `**Verification path:** ${verificationLine}`,
    "",
    "_Derived from journaled dispatcher decisions (admission + right_sizing); no model calls. Contest by commenting or adjusting labels before the next dispatch._",
  ].join("\n");
}
