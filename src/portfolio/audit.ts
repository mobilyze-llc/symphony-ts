import type { Issue } from "../domain/model.js";
import {
  type PortfolioEligibilityResult,
  evaluatePortfolioEligibility,
} from "./eligibility.js";
import {
  type LivePortfolioProject,
  PORTFOLIO_INTAKE_PROJECT,
  validatePortfolioTaxonomyRegistry,
} from "./taxonomy.js";

export interface PortfolioAuditFinding {
  issueIdentifier: string;
  observedProject: string | null;
  reasonCode: PortfolioEligibilityResult["reasonCode"];
  reason: string;
  targetProject: string | null;
  whyUncertain: string | null;
  candidates: string[];
}

export interface PortfolioIntakeSummary {
  count: number;
  staleCount: number;
  oldestAgeDays: number | null;
  withWhyUncertain: number;
  withCandidateProjects: number;
}

export interface PortfolioAuditReport {
  generatedAt: string;
  ok: boolean;
  issueCount: number;
  registryFindings: ReturnType<typeof validatePortfolioTaxonomyRegistry>;
  findings: PortfolioAuditFinding[];
  intake: PortfolioIntakeSummary;
}

export function runPortfolioTaxonomyAudit(input: {
  issues: readonly Issue[];
  liveProjects?: readonly LivePortfolioProject[];
  generatedAt?: string;
  intakeStaleDays?: number;
}): PortfolioAuditReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const findings: PortfolioAuditFinding[] = [];
  for (const issue of input.issues) {
    const result = evaluatePortfolioEligibility(issue);
    if (!result.eligible && result.reasonCode !== "not_portfolio_scoped") {
      findings.push({
        issueIdentifier: issue.identifier,
        observedProject:
          issue.projectName ?? issue.projectId ?? issue.projectSlug ?? null,
        reasonCode: result.reasonCode,
        reason: result.classification.reason,
        targetProject:
          result.classification.targetProject?.name ??
          result.classification.intakeProject?.name ??
          null,
        whyUncertain: result.classification.whyUncertain,
        candidates: result.classification.candidates.map(
          (candidate) => candidate.name,
        ),
      });
    }
  }

  const registryFindings =
    input.liveProjects === undefined
      ? []
      : validatePortfolioTaxonomyRegistry(input.liveProjects);

  return {
    generatedAt,
    ok: findings.length === 0 && registryFindings.length === 0,
    issueCount: input.issues.length,
    registryFindings,
    findings,
    intake: summarizeIntake({
      issues: input.issues,
      generatedAt,
      staleDays: input.intakeStaleDays ?? 7,
    }),
  };
}

export function renderPortfolioAuditReport(
  report: PortfolioAuditReport,
): string {
  const lines = [
    "# Portfolio Taxonomy Audit",
    "",
    `Generated: ${report.generatedAt}`,
    `Status: ${report.ok ? "pass" : "fail"}`,
    `Issues checked: ${report.issueCount}`,
    "",
    "## Registry Drift",
    "",
  ];
  if (report.registryFindings.length === 0) {
    lines.push("No registry drift detected.");
  } else {
    for (const finding of report.registryFindings) {
      lines.push(
        `- ${finding.code}: ${finding.projectName} (${finding.projectId ?? "no-id"})`,
      );
    }
  }
  lines.push("", "## Issue Findings", "");
  if (report.findings.length === 0) {
    lines.push("No invalid portfolio classifications detected.");
  } else {
    for (const finding of report.findings) {
      lines.push(
        `- ${finding.issueIdentifier}: ${finding.reasonCode}; observed=${finding.observedProject ?? "(none)"}; target=${finding.targetProject ?? "(none)"}`,
      );
      if (finding.whyUncertain !== null) {
        lines.push(`  why_uncertain: ${finding.whyUncertain}`);
      }
      if (finding.candidates.length > 0) {
        lines.push(`  candidates: ${finding.candidates.join("; ")}`);
      }
    }
  }
  lines.push(
    "",
    "## Intake",
    "",
    `Count: ${report.intake.count}`,
    `Stale: ${report.intake.staleCount}`,
    `Oldest age days: ${report.intake.oldestAgeDays ?? "(none)"}`,
    `With why_uncertain: ${report.intake.withWhyUncertain}`,
    `With candidate projects: ${report.intake.withCandidateProjects}`,
    "",
  );
  return lines.join("\n");
}

function summarizeIntake(input: {
  issues: readonly Issue[];
  generatedAt: string;
  staleDays: number;
}): PortfolioIntakeSummary {
  const now = Date.parse(input.generatedAt);
  const intakeIssues = input.issues.filter(
    (issue) => issue.projectId === PORTFOLIO_INTAKE_PROJECT.id,
  );
  const ages = intakeIssues
    .map((issue) =>
      issue.createdAt === null
        ? null
        : Math.floor((now - Date.parse(issue.createdAt)) / 86_400_000),
    )
    .filter((age): age is number => age !== null && Number.isFinite(age));
  return {
    count: intakeIssues.length,
    staleCount: ages.filter((age) => age >= input.staleDays).length,
    oldestAgeDays: ages.length === 0 ? null : Math.max(...ages),
    withWhyUncertain: intakeIssues.filter((issue) =>
      /why_uncertain\s*:/i.test(issue.description ?? ""),
    ).length,
    withCandidateProjects: intakeIssues.filter((issue) =>
      /candidate projects\s*:/i.test(issue.description ?? ""),
    ).length,
  };
}
