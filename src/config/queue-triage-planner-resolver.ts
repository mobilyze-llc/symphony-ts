import {
  DEFAULT_QUEUE_TRIAGE_PLANNER_EFFORT,
  DEFAULT_QUEUE_TRIAGE_PLANNER_MODEL,
} from "./defaults.js";
import {
  QUEUE_TRIAGE_PLANNER_EFFORTS,
  type QueueTriagePlannerConfig,
  type QueueTriagePlannerEffort,
} from "./planner-effort.js";

function readQueueTriagePlannerEffort(
  value: unknown,
): QueueTriagePlannerEffort | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (QUEUE_TRIAGE_PLANNER_EFFORTS as readonly string[]).includes(
    normalized,
  )
    ? (normalized as QueueTriagePlannerEffort)
    : null;
}

export function resolveQueueTriagePlannerConfig(input: {
  planner_model?: unknown;
  planner_effort?: unknown;
}): QueueTriagePlannerConfig {
  return {
    plannerModel:
      typeof input.planner_model === "string"
        ? input.planner_model
        : DEFAULT_QUEUE_TRIAGE_PLANNER_MODEL,
    plannerEffort:
      readQueueTriagePlannerEffort(input.planner_effort) ??
      DEFAULT_QUEUE_TRIAGE_PLANNER_EFFORT,
  };
}
