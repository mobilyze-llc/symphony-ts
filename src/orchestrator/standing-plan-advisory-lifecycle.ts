import {
  type AdvisoryLifecycleConfig,
  applyAdvisoryLifecycle,
} from "../agent/advisory-lifecycle.js";
import type { PlannerContext } from "../agent/triage-planner.js";
import type { Issue } from "../domain/model.js";
import type { StructuralAdvisory } from "../domain/structural-advisory.js";
import { partitionPortfolioEligibleIssues } from "../portfolio/eligibility.js";
import type { PlanBody } from "./standing-plan-supersession.js";

export function prepareBacklogAdvisoryInput(issues: readonly Issue[]): {
  eligible: Issue[];
  heldCount: number;
} {
  const partition = partitionPortfolioEligibleIssues(issues);
  return { eligible: partition.eligible, heldCount: partition.held.length };
}

export async function applyStandingPlanAdvisoryLifecycle(input: {
  body: PlanBody;
  previous: readonly StructuralAdvisory[];
  context: PlannerContext;
  config: AdvisoryLifecycleConfig;
  resolveRootIssueIdentifier?: (identifier: string) => Promise<boolean>;
  terminalIssueIdentifiers?: ReadonlySet<string>;
  scanComplete: boolean;
  log: (
    event: string,
    message: string,
    fields: Record<string, unknown>,
  ) => void | Promise<void>;
}): Promise<PlanBody> {
  const presented = [
    ...input.context.backlog,
    ...(input.context.advisoryInput ?? []),
  ];
  const presentedIssueIdentifiers = new Set(
    presented.map((candidate) => candidate.issueIdentifier),
  );
  const conflictIssueIdentifiers = new Set(
    presented
      .filter((candidate) =>
        candidate.auditAnnotations?.some(
          (annotation) => annotation.classification === "kill",
        ),
      )
      .map((candidate) => candidate.issueIdentifier),
  );
  const result = await applyAdvisoryLifecycle({
    emitted: input.body.structuralAdvisories ?? [],
    previous: input.previous,
    presentedIssueIdentifiers,
    conflictIssueIdentifiers,
    config: input.config,
    scanComplete: input.scanComplete,
    ...(input.resolveRootIssueIdentifier === undefined
      ? {}
      : { resolveRootIssueIdentifier: input.resolveRootIssueIdentifier }),
    ...(input.terminalIssueIdentifiers === undefined
      ? {}
      : { terminalIssueIdentifiers: input.terminalIssueIdentifiers }),
  });
  for (const event of result.events) {
    await input.log(
      `queue_triage_structural_advisory_${event.kind}`,
      "Structural advisory lifecycle evidence (report-only).",
      { outcome: "report_only", ...event },
    );
  }
  return { ...input.body, structuralAdvisories: result.advisories };
}
