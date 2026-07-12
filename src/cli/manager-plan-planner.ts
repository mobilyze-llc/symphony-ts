import {
  type PlannerRunResult,
  createCrabrunnerPlannerRunner,
} from "../agent/triage-planner.js";
import { DEFAULT_QUEUE_TRIAGE_PLANNER_EFFORT } from "../config/defaults.js";
import {
  QUEUE_TRIAGE_PLANNER_EFFORTS,
  type QueueTriagePlannerEffort,
} from "../config/planner-effort.js";

export const DEFAULT_MANAGER_PLAN_EFFORT = DEFAULT_QUEUE_TRIAGE_PLANNER_EFFORT;

export interface ManagerPlanPlannerRunnerInput {
  model: string;
  effort: QueueTriagePlannerEffort;
  artifactDir: string;
  workspace: string;
}

export type CreateManagerPlanPlannerRunner = (
  input: ManagerPlanPlannerRunnerInput,
) => (prompt: string) => Promise<PlannerRunResult>;

export interface ManagerPlanPersistenceSummary {
  workspaceRoot: string;
  recorded: boolean;
  revision: number;
}

export function parseManagerPlanEffort(
  raw: string,
): QueueTriagePlannerEffort | null {
  const normalized = raw.toLowerCase();
  return (QUEUE_TRIAGE_PLANNER_EFFORTS as readonly string[]).includes(
    normalized,
  )
    ? (normalized as QueueTriagePlannerEffort)
    : null;
}

export function createDefaultManagerPlanPlannerRunner(
  artifactName: string,
): CreateManagerPlanPlannerRunner {
  return ({ model, effort, artifactDir, workspace }) =>
    createCrabrunnerPlannerRunner({
      workspace,
      artifactDir,
      model,
      effort,
      artifactName,
    });
}
