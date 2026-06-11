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

export interface AdmissionCardInput {
  issueIdentifier: string;
  stageName: string | null;
  decision: RightSizingDecision;
  budgetMultiplier: number;
  /** A gate-passed frozen AC snapshot already exists for this issue. */
  hasFrozenAcceptanceCriteria: boolean;
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
    : "acceptance criteria not yet frozen — the investigate exit gate authors and freezes them before implement";
  const modelRoutingLine =
    decision.modelRouting.reason === "not_needed"
      ? "deterministic route sufficed (no model consult)"
      : decision.modelRouting.reason === "ambiguous_routing"
        ? "model consult allowed: deterministic signals were ambiguous"
        : "model consult allowed: risk trigger";
  const riskLines =
    decision.signals.highRiskFiles.length === 0
      ? []
      : [
          `**Risk surface:** touches high-risk files — ${decision.signals.highRiskFiles
            .slice(0, MAX_SCOPE_FILES)
            .join(", ")}`,
        ];

  return [
    "## Admission Card",
    "",
    `**Issue:** ${input.issueIdentifier}`,
    `**Decision:** admit → ${input.stageName ?? "initial stage"}`,
    `**Eligibility:** passed deterministic eligibility and disjointness checks`,
    `**Right-sizing:** \`${decision.mode}\` via \`${decision.classifier}\` — ${decision.reason}`,
    `**Model routing:** ${modelRoutingLine}`,
    `**Budget:** ${budgetLine}`,
    `**Declared scope:** ${scopeLine}`,
    ...riskLines,
    `**Verification path:** ${verificationLine}`,
    "",
    "_Derived from journaled dispatcher decisions (admission + right_sizing); no model calls. Contest by commenting or adjusting labels before the next dispatch._",
  ].join("\n");
}
