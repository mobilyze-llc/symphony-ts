import type {
  ResolvedWorkflowConfig,
  StageDefinition,
} from "../config/types.js";
import type {
  CouncilRiskPredicateResult,
  Issue,
  ReasoningEffort,
  ReasoningEffortDecision,
  RightSizingBudget,
  RightSizingDecision,
  RightSizingImpactSurface,
  RightSizingMode,
  RightSizingSignals,
} from "../domain/model.js";
import { classifyCouncilRiskPaths } from "./council-risk-predicate.js";
import { sortPaths, uniqueSortedPaths } from "./path-ordering.js";
import { createIssueSupervisionSnapshot } from "./supervision.js";

const EXPLICIT_MODE_LABELS: Record<string, RightSizingMode> = {
  prototype: "prototype",
  "mode:prototype": "prototype",
  trivial: "prototype",
  thin: "thin",
  "mode:thin": "thin",
  full: "full",
  "mode:full": "full",
  "high-risk": "full",
  "risk:high": "full",
};

export interface RightSizingInput {
  issue: Issue;
  config: ResolvedWorkflowConfig;
  stageName: string | null;
  attempt: number | null;
  changedFiles?: readonly string[];
  sameFamilyTripwire?: boolean;
}

export function createRightSizingDecision(
  input: RightSizingInput,
): RightSizingDecision {
  const signals = collectSignals(input);
  const triggerHits = collectTriggerHits(signals);
  if (signals.explicitModeHint !== null) {
    const reasoningEffort = createReasoningEffortDecision({
      configuredEffort: input.config.riskPredicateReasoning?.effort ?? null,
      stageEffort:
        resolveCurrentStage(input.config, input.stageName)?.reasoningEffort ??
        null,
      mode: signals.explicitModeHint,
      stageName: input.stageName,
      riskPredicate: signals.riskPredicate,
      sameFamilyTripwire: input.sameFamilyTripwire === true,
    });
    return {
      classifier: "deterministic-v1",
      mode: signals.explicitModeHint,
      stageName: input.stageName,
      reason: `Issue metadata explicitly selects ${signals.explicitModeHint} mode.`,
      rationale: [
        `Issue metadata explicitly selects ${signals.explicitModeHint} mode.`,
      ],
      triggerHits,
      riskPredicate: signals.riskPredicate,
      signals,
      modelRouting:
        triggerHits.length > 0
          ? {
              allowed: true,
              reason: "risk_trigger",
            }
          : {
              allowed: false,
              reason: "not_needed",
            },
      reasoningEffort,
    };
  }

  const scores = {
    prototype: 0,
    thin: 0,
    full: 0,
  };
  const rationale: string[] = [];

  switch (signals.impactSurface) {
    case "narrow": {
      scores.prototype += 3;
      scores.thin += 1;
      rationale.push("Impact surface stays narrow and reviewable.");
      break;
    }
    case "shared": {
      scores.thin += 2;
      scores.full += 1;
      rationale.push("Impact surface spans shared files or multiple areas.");
      break;
    }
    case "wide": {
      scores.full += 3;
      rationale.push(
        "Impact surface is wide enough to need the fullest harness.",
      );
      break;
    }
  }

  if (signals.highRiskFiles.length > 0) {
    scores.full += 3;
    rationale.push(
      `High-risk files are in scope: ${signals.highRiskFiles.join(", ")}.`,
    );
  }

  if (signals.gateCount === 0 && signals.stageCount <= 2) {
    scores.prototype += 1;
  }
  if (
    signals.gateCount <= 1 &&
    signals.reviewerCount <= 1 &&
    signals.stageCount <= 4
  ) {
    scores.thin += 2;
  }
  if (
    signals.gateCount >= 2 ||
    signals.reviewerCount >= 2 ||
    signals.humanGateCount > 0
  ) {
    scores.full += 2;
    rationale.push("Gate requirements are heavy enough to justify full mode.");
  }

  if (signals.retryCount === 0) {
    scores.prototype += 1;
    scores.thin += 1;
  } else if (signals.retryCount === 1) {
    scores.thin += 1;
    scores.full += 1;
  } else {
    scores.full += 3;
    rationale.push("Repeated retries push the unit into full mode.");
  }

  if (signals.priority === 1) {
    scores.full += 2;
    rationale.push("Highest-priority work gets the safest available harness.");
  }

  if (signals.blockedByCount > 0) {
    scores.thin += 1;
    scores.full += 1;
    rationale.push("Existing blockers favor a more governed path.");
  }

  switch (signals.budget) {
    case "low": {
      scores.prototype += 2;
      break;
    }
    case "medium": {
      scores.thin += 2;
      break;
    }
    case "high": {
      scores.full += 2;
      rationale.push("Planned turn/reviewer budget is high.");
      break;
    }
  }

  const rankedModes = rankModes(scores);
  const [best, second] = rankedModes;
  if (best === undefined || second === undefined) {
    throw new Error("Right-sizing reducer expected at least two ranked modes.");
  }
  const ambiguous = best.score - second.score <= 1;
  const modelRouting =
    ambiguous && best.mode !== second.mode
      ? {
          allowed: true,
          reason: "ambiguous_routing" as const,
        }
      : triggerHits.length > 0
        ? {
            allowed: true,
            reason: "risk_trigger" as const,
          }
        : {
            allowed: false,
            reason: "not_needed" as const,
          };

  const reason =
    rationale[0] ??
    `Deterministic routing selected ${best.mode} based on current issue signals.`;
  const reasoningEffort = createReasoningEffortDecision({
    configuredEffort: input.config.riskPredicateReasoning?.effort ?? null,
    stageEffort:
      resolveCurrentStage(input.config, input.stageName)?.reasoningEffort ??
      null,
    mode: best.mode,
    stageName: input.stageName,
    riskPredicate: signals.riskPredicate,
    sameFamilyTripwire: input.sameFamilyTripwire === true,
  });
  if (reasoningEffort.escalated) {
    rationale.push(
      reasoningEffort.reason === "same_family_tripwire"
        ? `Reasoning effort escalates to ${reasoningEffort.selectedEffort} after a same-family rework trip-wire.`
        : reasoningEffort.reason === "risk_predicate"
          ? `Reasoning effort escalates to ${reasoningEffort.selectedEffort} for shared risk predicate matches: ${reasoningEffort.riskPredicateTriggers.join(", ")}.`
          : `Reasoning effort selects ${reasoningEffort.selectedEffort} from ${reasoningEffort.reason}.`,
    );
  }

  return {
    classifier: "deterministic-v1",
    mode: best.mode,
    stageName: input.stageName,
    reason,
    rationale,
    triggerHits,
    riskPredicate: signals.riskPredicate,
    signals,
    modelRouting,
    reasoningEffort,
  };
}

function collectSignals(input: RightSizingInput): RightSizingSignals {
  const labels = [...input.issue.labels].sort();
  const explicitModeHint = findExplicitModeHint(labels);
  const declaredScopeFiles = sortPaths(
    createIssueSupervisionSnapshot(input.issue).declaredFileScope ?? [],
  );
  const changedFiles = sortPaths(input.changedFiles ?? []);
  const impactFiles = uniqueSortedPaths([
    ...declaredScopeFiles,
    ...changedFiles,
  ]);
  const riskPredicate = classifyCouncilRiskPaths(impactFiles);
  // Compatibility alias for consumers that still read highRiskFiles.
  // Keep this equal to riskPredicate.matchedPaths until those consumers migrate.
  const highRiskFiles = riskPredicate.matchedPaths;
  const stagePath = resolveStagePath(input.config, input.stageName);
  const plannedTurns = stagePath.reduce((sum, stage) => {
    if (stage.type !== "agent") {
      return sum;
    }
    return sum + (stage.maxTurns ?? input.config.agent.maxTurns);
  }, 0);
  const gateStages = stagePath.filter((stage) => stage.type === "gate");
  const gateCount = gateStages.length;
  const reviewerCount = gateStages.reduce(
    (sum, stage) => sum + stage.reviewers.length,
    0,
  );
  const humanGateCount = gateStages.filter(
    (stage) => stage.gateType === "human",
  ).length;

  return {
    explicitModeHint,
    declaredScopeFiles,
    changedFiles,
    impactSurface: classifyImpactSurface(impactFiles, highRiskFiles),
    highRiskFiles,
    riskPredicate,
    stageCount: stagePath.length,
    gateCount,
    reviewerCount,
    humanGateCount,
    blockedByCount: input.issue.blockedBy.length,
    retryCount: input.attempt ?? 0,
    priority: input.issue.priority,
    labels,
    plannedTurns,
    budget: classifyBudget({
      plannedTurns,
      gateCount,
      reviewerCount,
      stageCount: stagePath.length,
    }),
  };
}

function resolveStagePath(
  config: ResolvedWorkflowConfig,
  currentStageName: string | null,
): StageDefinition[] {
  const stagesConfig = config.stages;
  if (stagesConfig === null) {
    return [];
  }

  const resolved: StageDefinition[] = [];
  const visited = new Set<string>();
  let nextStageName: string | null =
    currentStageName ?? stagesConfig.initialStage;
  while (nextStageName !== null && !visited.has(nextStageName)) {
    const stage: StageDefinition | undefined =
      stagesConfig.stages[nextStageName];
    if (stage === undefined) {
      break;
    }
    visited.add(nextStageName);
    resolved.push(stage);
    nextStageName =
      stage.type === "gate"
        ? stage.transitions.onApprove
        : stage.transitions.onComplete;
  }

  return resolved;
}

function resolveCurrentStage(
  config: ResolvedWorkflowConfig,
  currentStageName: string | null,
): StageDefinition | null {
  const stagesConfig = config.stages;
  if (stagesConfig === null) {
    return null;
  }
  const stageName = currentStageName ?? stagesConfig.initialStage;
  return stagesConfig.stages[stageName] ?? null;
}

function findExplicitModeHint(
  labels: readonly string[],
): RightSizingMode | null {
  for (const label of labels) {
    const hint = EXPLICIT_MODE_LABELS[label.toLowerCase()];
    if (hint !== undefined) {
      return hint;
    }
  }
  return null;
}

function classifyImpactSurface(
  files: readonly string[],
  highRiskFiles: readonly string[],
): RightSizingImpactSurface {
  if (files.length === 0) {
    return "shared";
  }

  const topLevelSegments = new Set(
    files.map((file) => file.split("/")[0] ?? file),
  );
  if (files.length >= 6 || topLevelSegments.size >= 3) {
    return "wide";
  }
  if (
    files.length >= 3 ||
    topLevelSegments.size >= 2 ||
    highRiskFiles.length > 0
  ) {
    return "shared";
  }
  return "narrow";
}

function classifyBudget(input: {
  plannedTurns: number;
  gateCount: number;
  reviewerCount: number;
  stageCount: number;
}): RightSizingBudget {
  if (
    input.plannedTurns >= 40 ||
    input.gateCount >= 2 ||
    input.reviewerCount >= 2
  ) {
    return "high";
  }
  if (
    input.plannedTurns >= 18 ||
    input.gateCount >= 1 ||
    input.stageCount >= 3
  ) {
    return "medium";
  }
  return "low";
}

function collectTriggerHits(signals: RightSizingSignals): string[] {
  const hits = new Set<string>();
  if (signals.riskPredicate.triggerHits.length > 0) {
    hits.add("high_risk_files");
  }
  if (signals.retryCount >= 2) {
    hits.add("repeat_retry");
  }
  if (signals.gateCount >= 2 || signals.reviewerCount >= 2) {
    hits.add("heavy_gate_requirements");
  }
  if (signals.priority === 1) {
    hits.add("priority_high");
  }
  if (signals.budget === "high") {
    hits.add("high_cost_budget");
  }
  return [...hits].sort();
}

function createReasoningEffortDecision(input: {
  configuredEffort: ReasoningEffortDecision["configuredEffort"];
  stageEffort: ReasoningEffortDecision["stageEffort"];
  mode: RightSizingMode;
  stageName: string | null;
  riskPredicate: CouncilRiskPredicateResult;
  sameFamilyTripwire: boolean;
}): ReasoningEffortDecision {
  const stageEffort = input.stageEffort ?? null;
  const stageEligible = isReasoningEffortStage(input.stageName);
  const matchedRiskPredicate = input.riskPredicate.triggerHits.length > 0;
  const modeEffort =
    stageEffort === null
      ? null
      : modeReasoningEffort(input.stageName, input.mode, stageEffort);
  const baseEffort = modeEffort ?? stageEffort;
  const riskEffort =
    input.configuredEffort !== null &&
    stageEligible &&
    (input.sameFamilyTripwire || matchedRiskPredicate)
      ? input.configuredEffort
      : null;
  const selectedEffort =
    riskEffort !== null
      ? maxReasoningEffort(baseEffort, riskEffort)
      : baseEffort;
  let reason: ReasoningEffortDecision["reason"];
  if (riskEffort !== null && input.sameFamilyTripwire) {
    reason = "same_family_tripwire";
  } else if (riskEffort !== null && matchedRiskPredicate) {
    reason = "risk_predicate";
  } else if (modeEffort !== null) {
    reason = "mode_mapping";
  } else if (stageEffort !== null) {
    reason = "stage_config";
  } else if (input.configuredEffort === null) {
    reason = "not_configured";
  } else if (!stageEligible) {
    reason = "stage_not_eligible";
  } else {
    reason = "no_risk_match";
  }

  return {
    configuredEffort: input.configuredEffort,
    stageEffort,
    modeEffort,
    selectedEffort,
    escalated: selectedEffort !== null && selectedEffort !== "low",
    reason,
    stageEligible,
    riskPredicateTriggers: input.riskPredicate.triggerHits,
    matchedPaths: input.riskPredicate.matchedPaths,
    sameFamilyTripwire: input.sameFamilyTripwire,
  };
}

function isReasoningEffortStage(stageName: string | null): boolean {
  return stageName === "investigate" || stageName === "implement";
}

function modeReasoningEffort(
  stageName: string | null,
  mode: RightSizingMode,
  stageEffort: ReasoningEffort,
): ReasoningEffort {
  if (stageName === "investigate") {
    return "low";
  }
  if (stageName !== "implement") {
    return stageEffort;
  }
  switch (mode) {
    case "prototype":
      return "low";
    case "thin":
      return "medium";
    case "full":
      return "high";
  }
}

function maxReasoningEffort(
  left: ReasoningEffort | null,
  right: ReasoningEffort,
): ReasoningEffort {
  if (left === null) {
    return right;
  }
  return reasoningRank(left) >= reasoningRank(right) ? left : right;
}

function reasoningRank(effort: ReasoningEffort): number {
  switch (effort) {
    case "low":
      return 0;
    case "medium":
      return 1;
    case "high":
      return 2;
  }
}

function rankModes(scores: Record<RightSizingMode, number>): Array<{
  mode: RightSizingMode;
  score: number;
}> {
  const severity: Record<RightSizingMode, number> = {
    prototype: 0,
    thin: 1,
    full: 2,
  };

  return (Object.entries(scores) as Array<[RightSizingMode, number]>)
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return severity[right[0]] - severity[left[0]];
    })
    .map(([mode, score]) => ({ mode, score }));
}
