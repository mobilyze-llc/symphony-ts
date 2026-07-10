import type { BacklogAuditReport } from "./backlog-audit.js";

/**
 * Keep hygiene classifications available to the planner while removing every
 * field that could authorize tracker mutation. Cull authority remains exclusive
 * to the off-pressure lane.
 */
export function stripBacklogAuditCullAuthority(
  report: BacklogAuditReport,
): BacklogAuditReport {
  if (report.verdict.findings.every((finding) => finding.cull == null)) {
    return report;
  }
  return {
    ...report,
    verdict: {
      ...report.verdict,
      findings: report.verdict.findings.map((finding) =>
        finding.cull == null
          ? finding
          : {
              ...finding,
              cull: {
                classification: finding.cull.classification,
                killReason: null,
                marker: null,
                rootIssueIdentifier: finding.cull.rootIssueIdentifier,
                advisoryOnly: true,
              },
            },
      ),
    },
  };
}
