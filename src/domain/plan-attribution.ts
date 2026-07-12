export interface PlanAttribution {
  plannerModel?: string;
  plannerEffort?: string;
}

export type PlanRevisionSource = "planner" | "supersession" | "manual";

const PLAN_PREMISE_KINDS = ["verifiable", "judgment"] as const;

type PlanPremiseKind = (typeof PLAN_PREMISE_KINDS)[number];

export interface PlanPremiseRecord {
  decisionAnchor: string;
  kind: PlanPremiseKind;
  statement: string;
}

export function planAttribution(input: PlanAttribution): PlanAttribution {
  return {
    ...(input.plannerModel === undefined
      ? {}
      : { plannerModel: input.plannerModel }),
    ...(input.plannerEffort === undefined
      ? {}
      : { plannerEffort: input.plannerEffort }),
  };
}

export function resolvePlanAttribution(
  preferred: PlanAttribution,
  fallback: PlanAttribution,
): PlanAttribution {
  const plannerModel = preferred.plannerModel ?? fallback.plannerModel;
  const plannerEffort = preferred.plannerEffort ?? fallback.plannerEffort;

  return planAttribution({
    ...(plannerModel === undefined ? {} : { plannerModel }),
    ...(plannerEffort === undefined ? {} : { plannerEffort }),
  });
}

export function validPlanAttribution(input: Record<string, unknown>): boolean {
  return (
    (input.plannerModel === undefined ||
      typeof input.plannerModel === "string") &&
    (input.plannerEffort === undefined ||
      typeof input.plannerEffort === "string")
  );
}
