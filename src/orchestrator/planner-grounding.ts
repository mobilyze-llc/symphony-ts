import type { ResolvedWorkflowConfig } from "../config/types.js";
import type {
  CodeGroundingTarget,
  RunCodeGroundingInput,
} from "./code-grounding.js";

export interface BuildPlannerCodeGroundingInput {
  workflowConfig: Pick<
    ResolvedWorkflowConfig,
    "codeGrounding" | "plannerGrounding" | "workspace"
  >;
  runId: string;
  target: CodeGroundingTarget;
  workspaceRoot?: string;
  commandRunner?: RunCodeGroundingInput["commandRunner"];
  afterDeterministicScan?: RunCodeGroundingInput["afterDeterministicScan"];
}

export function buildPlannerCodeGroundingInput(
  input: BuildPlannerCodeGroundingInput,
): Omit<RunCodeGroundingInput, "findings"> | null {
  if (
    input.workflowConfig.plannerGrounding?.enabled !== true ||
    input.workflowConfig.codeGrounding?.enabled !== true
  ) {
    return null;
  }
  return {
    workspaceRoot: input.workspaceRoot ?? input.workflowConfig.workspace.root,
    runId: input.runId,
    config: input.workflowConfig.codeGrounding,
    target: input.target,
    ...(input.commandRunner === undefined
      ? {}
      : { commandRunner: input.commandRunner }),
    ...(input.afterDeterministicScan === undefined
      ? {}
      : { afterDeterministicScan: input.afterDeterministicScan }),
  };
}
