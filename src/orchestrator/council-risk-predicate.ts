import {
  COUNCIL_RISK_PREDICATE_TRIGGERS,
  type CouncilRiskPredicateMatch,
  type CouncilRiskPredicateResult,
  type CouncilRiskPredicateTrigger,
} from "../domain/model.js";
import { comparePathStrings, uniqueSortedPaths } from "./path-ordering.js";

interface CouncilRiskRule {
  trigger: CouncilRiskPredicateTrigger;
  kind: "exact" | "prefix";
  pattern: string;
  rationale: string;
}

const COUNCIL_RISK_RULES: readonly CouncilRiskRule[] = [
  {
    trigger: "journal_producer",
    kind: "exact",
    pattern: "src/logging/run-journal.ts",
    rationale: "Dispatcher run-journal persistence and validation.",
  },
  {
    trigger: "journal_producer",
    kind: "exact",
    pattern: "src/logging/manager-run-journal.ts",
    rationale: "Manager-run journal persistence and validation.",
  },
  {
    trigger: "journal_producer",
    kind: "exact",
    pattern: "src/orchestrator/runtime-host.ts",
    rationale: "Runtime host hydrates and persists dispatcher journal entries.",
  },
  {
    trigger: "journal_producer",
    kind: "exact",
    pattern: "src/orchestrator/core.ts",
    rationale: "Orchestrator core emits dispatcher journal entries.",
  },
  {
    trigger: "journal_producer",
    kind: "exact",
    pattern: "src/orchestrator/manager-run.ts",
    rationale: "Manager-run reducer emits manager journal entries.",
  },
  {
    trigger: "journal_replay_reducer",
    kind: "exact",
    pattern: "src/orchestrator/core.ts",
    rationale: "Dispatcher run-journal replay reducers restore runtime state.",
  },
  {
    trigger: "journal_replay_reducer",
    kind: "exact",
    pattern: "src/orchestrator/decision-quality.ts",
    rationale: "Decision-quality reducers read journaled dispatcher decisions.",
  },
  {
    trigger: "dispatcher_event_vocabulary",
    kind: "exact",
    pattern: "src/domain/model.ts",
    rationale: "Dispatcher run-journal event kinds and schemas live here.",
  },
  {
    trigger: "state_journal_projection",
    kind: "exact",
    pattern: "src/logging/runtime-snapshot.ts",
    rationale: "Runtime snapshot and state delta project journal-backed state.",
  },
  {
    trigger: "state_journal_projection",
    kind: "exact",
    pattern: "src/orchestrator/runtime-host.ts",
    rationale: "Runtime host exposes snapshot and state-delta journal reads.",
  },
  {
    trigger: "high_risk_path",
    kind: "exact",
    pattern: "WORKFLOW.md",
    rationale: "Workflow contract changes can alter dispatch behavior.",
  },
  {
    trigger: "high_risk_path",
    kind: "exact",
    pattern: "package.json",
    rationale: "Package metadata changes can alter runtime and build behavior.",
  },
  {
    trigger: "high_risk_path",
    kind: "exact",
    pattern: "pnpm-lock.yaml",
    rationale: "Dependency graph changes can alter runtime and build behavior.",
  },
  {
    trigger: "high_risk_path",
    kind: "exact",
    pattern: "pnpm-workspace.yaml",
    rationale: "Workspace graph changes can alter package resolution.",
  },
  {
    trigger: "high_risk_path",
    kind: "exact",
    pattern: "SPEC.mobilyze.md",
    rationale: "Fork-specific behavior contract changes affect acceptance.",
  },
  {
    trigger: "high_risk_path",
    kind: "exact",
    pattern: "SPEC.upstream.md",
    rationale: "Upstream compatibility contract changes affect acceptance.",
  },
  {
    trigger: "high_risk_path",
    kind: "exact",
    pattern: "biome.json",
    rationale: "Formatter/linter contract changes affect the full repo.",
  },
  {
    trigger: "high_risk_path",
    kind: "exact",
    pattern: "tsconfig.build.json",
    rationale: "Build type-check contract changes affect compiled output.",
  },
  {
    trigger: "high_risk_path",
    kind: "exact",
    pattern: "tsconfig.json",
    rationale: "Type-check contract changes affect the full repo.",
  },
  {
    trigger: "high_risk_path",
    kind: "prefix",
    pattern: "src/cli/",
    rationale: "CLI changes affect operator control surfaces.",
  },
  {
    trigger: "high_risk_path",
    kind: "prefix",
    pattern: "src/config/",
    rationale: "Configuration changes affect dispatch and runtime behavior.",
  },
  {
    trigger: "high_risk_path",
    kind: "prefix",
    pattern: "src/orchestrator/",
    rationale: "Orchestrator changes affect dispatch, supervision, and replay.",
  },
  {
    trigger: "high_risk_path",
    kind: "prefix",
    pattern: "src/tracker/",
    rationale: "Tracker changes affect external issue state mutation.",
  },
  {
    trigger: "high_risk_path",
    kind: "prefix",
    pattern: "src/workspace/",
    rationale:
      "Workspace changes affect checked-out code and worker isolation.",
  },
] as const;

const TRIGGER_ORDER = new Map(
  COUNCIL_RISK_PREDICATE_TRIGGERS.map((trigger, index) => [trigger, index]),
);

export function classifyCouncilRiskPaths(
  paths: readonly string[],
): CouncilRiskPredicateResult {
  const normalizedPaths = uniqueSortedPaths(
    paths.map(normalizePathForRiskPredicate).filter(isNonEmptyString),
  );
  const matches: CouncilRiskPredicateMatch[] = [];

  for (const path of normalizedPaths) {
    for (const rule of COUNCIL_RISK_RULES) {
      if (!matchesRule(path, rule)) {
        continue;
      }
      matches.push({
        trigger: rule.trigger,
        path,
        matchedPattern:
          rule.kind === "prefix" ? `${rule.pattern}*` : rule.pattern,
        rationale: rule.rationale,
      });
    }
  }

  matches.sort(compareRiskMatches);

  return {
    triggerHits: uniqueByTriggerOrder(matches.map((match) => match.trigger)),
    matchedPaths: uniqueSortedPaths(matches.map((match) => match.path)),
    matches,
  };
}

function matchesRule(path: string, rule: CouncilRiskRule): boolean {
  switch (rule.kind) {
    case "exact":
      return path === rule.pattern;
    case "prefix":
      return path.startsWith(rule.pattern);
  }
}

function normalizePathForRiskPredicate(path: string): string {
  let normalized = path.trim().replaceAll("\\", "/");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

function isNonEmptyString(value: string): boolean {
  return value.length > 0;
}

function uniqueByTriggerOrder(
  values: readonly CouncilRiskPredicateTrigger[],
): CouncilRiskPredicateTrigger[] {
  return [...new Set(values)].sort(
    (left, right) =>
      (TRIGGER_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (TRIGGER_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER),
  );
}

function compareRiskMatches(
  left: CouncilRiskPredicateMatch,
  right: CouncilRiskPredicateMatch,
): number {
  const pathComparison = comparePathStrings(left.path, right.path);
  if (pathComparison !== 0) {
    return pathComparison;
  }
  return (
    (TRIGGER_ORDER.get(left.trigger) ?? Number.MAX_SAFE_INTEGER) -
    (TRIGGER_ORDER.get(right.trigger) ?? Number.MAX_SAFE_INTEGER)
  );
}
