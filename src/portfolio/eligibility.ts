import type { Issue } from "../domain/model.js";
import {
  type PortfolioClassificationResult,
  classifyPortfolioIssue,
} from "./classifier.js";
import {
  PORTFOLIO_INTAKE_PROJECT,
  findForbiddenPortfolioProject,
  isPortfolioTeamKey,
} from "./taxonomy.js";

export type PortfolioEligibilityReason =
  | "not_portfolio_scoped"
  | "portfolio_classification_valid"
  | "portfolio_project_missing"
  | "portfolio_project_forbidden"
  | "portfolio_project_unregistered"
  | "portfolio_intake_not_selectable";

export interface PortfolioEligibilityResult {
  eligible: boolean;
  reasonCode: PortfolioEligibilityReason;
  remedy: string | null;
  classification: PortfolioClassificationResult;
}

export interface PortfolioPartition {
  eligible: Issue[];
  held: Array<{
    issue: Issue;
    result: PortfolioEligibilityResult;
  }>;
}

export function evaluatePortfolioEligibility(
  issue: Issue,
): PortfolioEligibilityResult {
  if (!hasPortfolioMetadata(issue)) {
    return {
      eligible: true,
      reasonCode: "not_portfolio_scoped",
      remedy: null,
      classification: classifyPortfolioIssue({
        ...issue,
        identifier: null,
        teamKey: null,
      }),
    };
  }

  const classification = classifyPortfolioIssue(issue);
  if (
    classification.status === "not_applicable" &&
    !isPortfolioIdentifier(issue.identifier)
  ) {
    return {
      eligible: true,
      reasonCode: "not_portfolio_scoped",
      remedy: null,
      classification,
    };
  }
  if (classification.status === "valid") {
    return {
      eligible: true,
      reasonCode: "portfolio_classification_valid",
      remedy: null,
      classification,
    };
  }

  return {
    eligible: false,
    reasonCode: reasonForClassification(issue, classification),
    remedy:
      "Classify the issue into a registered portfolio project, or route it to Portfolio Intake / Needs Classification with why_uncertain and candidate projects.",
    classification,
  };
}

export function partitionPortfolioEligibleIssues(
  issues: readonly Issue[],
): PortfolioPartition {
  const eligible: Issue[] = [];
  const held: PortfolioPartition["held"] = [];
  for (const issue of issues) {
    const result = evaluatePortfolioEligibility(issue);
    if (result.eligible) {
      eligible.push(issue);
    } else {
      held.push({ issue, result });
    }
  }
  return { eligible, held };
}

function hasPortfolioMetadata(issue: Issue): boolean {
  return (
    issue.teamKey !== undefined ||
    issue.projectId !== undefined ||
    issue.projectSlug !== undefined ||
    issue.projectName !== undefined
  );
}

function reasonForClassification(
  issue: Issue,
  classification: PortfolioClassificationResult,
): PortfolioEligibilityReason {
  if (
    findForbiddenPortfolioProject({
      id: issue.projectId ?? null,
      slugId: issue.projectSlug ?? null,
      name: issue.projectName ?? null,
    }) !== null
  ) {
    return "portfolio_project_forbidden";
  }
  if (
    (issue.projectId ?? null) === null &&
    (issue.projectSlug ?? null) === null &&
    (issue.projectName ?? null) === null
  ) {
    return "portfolio_project_missing";
  }
  if (
    issue.projectId === PORTFOLIO_INTAKE_PROJECT.id ||
    issue.projectSlug === PORTFOLIO_INTAKE_PROJECT.slugId ||
    issue.projectName === PORTFOLIO_INTAKE_PROJECT.name
  ) {
    return "portfolio_intake_not_selectable";
  }
  if (classification.intakeProject !== null) {
    return "portfolio_project_unregistered";
  }
  return "portfolio_project_unregistered";
}

function isPortfolioIdentifier(identifier: string): boolean {
  const prefix = identifier.split("-")[0];
  return isPortfolioTeamKey(prefix);
}
