export const QUEUE_TRIAGE_PLANNER_EFFORTS = [
  "low",
  "medium",
  "high",
  "max",
] as const;

export type QueueTriagePlannerEffort =
  (typeof QUEUE_TRIAGE_PLANNER_EFFORTS)[number];

export interface QueueTriagePlannerConfig {
  /** Version-floating model alias and explicit effort; defaults opus/max. */
  plannerModel: string;
  plannerEffort: QueueTriagePlannerEffort;
}
