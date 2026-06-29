import { readString, recordOrNull } from "../review/record-utils.js";

export const MANAGER_PLAN_DOGFOOD_PROJECT_SLUG_ID = "9c1064215e8d";

export const MANAGER_PLAN_DOGFOOD_CONTROLLER_COMMAND = [
  "scripts/symphony-manager-plan",
  "--project 9c1064215e8d",
  "--state Backlog",
  "--state Todo",
  "--runtime-state-base-url http://127.0.0.1:4321",
  "--prompt-only",
  "--out-dir /tmp/symphony-manager-plan-SYMPH-961-prompt-only",
].join(" ");

export const MANAGER_PLAN_DOGFOOD_REQUIRED_GROUPS = [
  { category: "a", issueIdentifiers: ["SYMPH-941"] },
  {
    category: "b",
    issueIdentifiers: ["SYMPH-877", "SYMPH-878", "SYMPH-947"],
  },
  { category: "c", issueIdentifiers: ["SYMPH-839", "SYMPH-950"] },
] as const;

export type ManagerPlanDogfoodCategory = "a" | "b" | "c";
export type ManagerPlanDogfoodGateDecision = "pass" | "block" | "defer";

export interface ManagerPlanDogfoodClassification {
  category: ManagerPlanDogfoodCategory;
  issueIdentifiers: string[];
  rationale: string;
}

export interface ManagerPlanDogfoodPhase0Gate {
  decision: ManagerPlanDogfoodGateDecision;
  rationale: string;
}

export interface ManagerPlanDogfoodEvidence {
  schemaVersion: 1;
  kind: "symphony-manager-plan-dogfood-evidence";
  projectSlugId: string;
  generatedByCommand: string;
  promptOnly: boolean;
  liveEquivalent: boolean;
  promptArtifactPath: string;
  classifications: ManagerPlanDogfoodClassification[];
  phase0Gate: ManagerPlanDogfoodPhase0Gate;
}

export interface ManagerPlanDogfoodEvidenceAssessment {
  complete: boolean;
  reasons: string[];
}

export function assessManagerPlanDogfoodEvidence(
  evidence: ManagerPlanDogfoodEvidence | null,
): ManagerPlanDogfoodEvidenceAssessment {
  if (evidence === null) {
    return { complete: false, reasons: ["manager_plan_dogfood_missing"] };
  }

  const reasons: string[] = [];
  if (evidence.projectSlugId !== MANAGER_PLAN_DOGFOOD_PROJECT_SLUG_ID) {
    reasons.push("manager_plan_dogfood_wrong_project");
  }
  if (evidence.generatedByCommand.trim() === "") {
    reasons.push("manager_plan_dogfood_missing_command");
  }
  if (!evidence.promptOnly) {
    reasons.push("manager_plan_dogfood_not_prompt_only");
  }
  if (!evidence.liveEquivalent) {
    reasons.push("manager_plan_dogfood_not_live_equivalent");
  }
  if (evidence.promptArtifactPath.trim() === "") {
    reasons.push("manager_plan_dogfood_missing_prompt_artifact");
  }
  if (evidence.phase0Gate.rationale.trim() === "") {
    reasons.push("manager_plan_dogfood_missing_gate_rationale");
  }

  for (const group of MANAGER_PLAN_DOGFOOD_REQUIRED_GROUPS) {
    if (!hasClassificationForGroup(evidence.classifications, group)) {
      reasons.push(
        `manager_plan_dogfood_missing_group:${group.issueIdentifiers.join("+")}`,
      );
    }
  }

  return { complete: reasons.length === 0, reasons };
}

export function parseManagerPlanDogfoodEvidence(
  value: unknown,
): ManagerPlanDogfoodEvidence | null {
  const record = recordOrNull(value);
  if (
    record === null ||
    record.kind !== "symphony-manager-plan-dogfood-evidence" ||
    record.schemaVersion !== 1
  ) {
    return null;
  }

  const classifications = parseClassifications(record.classifications);
  const phase0Gate = parsePhase0Gate(record.phase0Gate);
  if (classifications === null || phase0Gate === null) {
    return null;
  }

  return {
    schemaVersion: 1,
    kind: "symphony-manager-plan-dogfood-evidence",
    projectSlugId: readString(record.projectSlugId),
    generatedByCommand: readString(record.generatedByCommand),
    promptOnly: record.promptOnly === true,
    liveEquivalent: record.liveEquivalent === true,
    promptArtifactPath: readString(record.promptArtifactPath),
    classifications,
    phase0Gate,
  };
}

function hasClassificationForGroup(
  classifications: readonly ManagerPlanDogfoodClassification[],
  group: (typeof MANAGER_PLAN_DOGFOOD_REQUIRED_GROUPS)[number],
): boolean {
  const required = new Set(group.issueIdentifiers);
  return classifications.some((classification) => {
    if (classification.category !== group.category) {
      return false;
    }
    const actual = new Set(classification.issueIdentifiers);
    return (
      required.size === actual.size &&
      [...required].every((identifier) => actual.has(identifier))
    );
  });
}

function parseClassifications(
  value: unknown,
): ManagerPlanDogfoodClassification[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const parsed: ManagerPlanDogfoodClassification[] = [];
  for (const entry of value) {
    const record = recordOrNull(entry);
    if (
      record === null ||
      !isDogfoodCategory(record.category) ||
      !Array.isArray(record.issueIdentifiers)
    ) {
      return null;
    }
    const issueIdentifiers = record.issueIdentifiers.filter(
      (identifier): identifier is string => typeof identifier === "string",
    );
    parsed.push({
      category: record.category,
      issueIdentifiers,
      rationale: readString(record.rationale),
    });
  }
  return parsed;
}

function parsePhase0Gate(value: unknown): ManagerPlanDogfoodPhase0Gate | null {
  const record = recordOrNull(value);
  if (record === null || !isGateDecision(record.decision)) {
    return null;
  }
  return {
    decision: record.decision,
    rationale: readString(record.rationale),
  };
}

function isDogfoodCategory(
  value: unknown,
): value is ManagerPlanDogfoodCategory {
  return value === "a" || value === "b" || value === "c";
}

function isGateDecision(
  value: unknown,
): value is ManagerPlanDogfoodGateDecision {
  return value === "pass" || value === "block" || value === "defer";
}
