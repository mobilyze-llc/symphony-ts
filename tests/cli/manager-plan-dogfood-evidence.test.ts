import { describe, expect, it } from "vitest";

import {
  MANAGER_PLAN_DOGFOOD_CONTROLLER_COMMAND,
  type ManagerPlanDogfoodEvidence,
  assessManagerPlanDogfoodEvidence,
  parseManagerPlanDogfoodEvidence,
} from "../../src/cli/manager-plan-dogfood-evidence.js";

function completeEvidence(
  overrides: Partial<ManagerPlanDogfoodEvidence> = {},
): ManagerPlanDogfoodEvidence {
  return {
    schemaVersion: 1,
    kind: "symphony-manager-plan-dogfood-evidence",
    projectSlugId: "9c1064215e8d",
    generatedByCommand: MANAGER_PLAN_DOGFOOD_CONTROLLER_COMMAND,
    promptOnly: true,
    liveEquivalent: true,
    promptArtifactPath:
      "/tmp/symphony-manager-plan-SYMPH-961-prompt-only/manager-plan-prompt.txt",
    classifications: [
      {
        category: "a",
        issueIdentifiers: ["SYMPH-941"],
        rationale: "Single ready backlog candidate.",
      },
      {
        category: "b",
        issueIdentifiers: ["SYMPH-877", "SYMPH-878", "SYMPH-947"],
        rationale: "Related candidates with a newer coordination ticket.",
      },
      {
        category: "c",
        issueIdentifiers: ["SYMPH-839", "SYMPH-950"],
        rationale: "Candidate affected by in-flight work.",
      },
    ],
    phase0Gate: {
      decision: "defer",
      rationale: "Controller must attach live Linear evidence before pass.",
    },
    ...overrides,
  };
}

describe("manager-plan dogfood evidence (SYMPH-961)", () => {
  it("records the exact controller-side prompt-only command", () => {
    expect(MANAGER_PLAN_DOGFOOD_CONTROLLER_COMMAND).toBe(
      [
        "scripts/symphony-manager-plan",
        "--project 9c1064215e8d",
        "--state Backlog",
        "--state Todo",
        "--runtime-state-base-url http://127.0.0.1:4321",
        "--prompt-only",
        "--out-dir /tmp/symphony-manager-plan-SYMPH-961-prompt-only",
      ].join(" "),
    );
  });

  it("passes a complete live-equivalent prompt-only evidence record", () => {
    const parsed = parseManagerPlanDogfoodEvidence(
      JSON.parse(JSON.stringify(completeEvidence())),
    );
    expect(parsed).not.toBeNull();
    expect(assessManagerPlanDogfoodEvidence(parsed)).toEqual({
      complete: true,
      reasons: [],
    });
  });

  it("fails closed when a required reclassification group is absent", () => {
    const evidence = completeEvidence({
      classifications: completeEvidence().classifications.slice(0, 2),
    });

    expect(assessManagerPlanDogfoodEvidence(evidence)).toEqual({
      complete: false,
      reasons: ["manager_plan_dogfood_missing_group:SYMPH-839+SYMPH-950"],
    });
  });

  it("fails closed for malformed evidence", () => {
    expect(
      parseManagerPlanDogfoodEvidence({
        kind: "symphony-manager-plan-dogfood-evidence",
        schemaVersion: 1,
        classifications: "not-array",
      }),
    ).toBeNull();
    expect(assessManagerPlanDogfoodEvidence(null)).toEqual({
      complete: false,
      reasons: ["manager_plan_dogfood_missing"],
    });
  });

  it("fails closed when classification identifiers include non-strings", () => {
    const evidence = completeEvidence({
      classifications: [
        {
          category: "a",
          issueIdentifiers: ["SYMPH-941", 123] as unknown as string[],
          rationale: "Malformed identifiers must not be normalized away.",
        },
        ...completeEvidence().classifications.slice(1),
      ],
    });

    expect(
      parseManagerPlanDogfoodEvidence(JSON.parse(JSON.stringify(evidence))),
    ).toBeNull();
  });
});
