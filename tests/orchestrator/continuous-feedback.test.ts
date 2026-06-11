import { describe, expect, it } from "vitest";

import type { ContinuousFeedbackLane } from "../../src/domain/model.js";
import {
  feedbackFindingCarriesNewSignal,
  getOpenContinuousFeedbackFindings,
  mergeContinuousFeedbackCheckpoint,
} from "../../src/orchestrator/continuous-feedback.js";

const WORKER_LANE: ContinuousFeedbackLane = {
  runner: "codex",
  model: null,
  role: "worker",
};
const REVIEWER_LANE: ContinuousFeedbackLane = {
  runner: "pi",
  model: "deepseek-v4-flash",
  role: "reviewer",
};

function checkpoint(
  findings: Parameters<typeof mergeContinuousFeedbackCheckpoint>[1]["findings"],
  checkedAt = "2026-06-11T00:00:00.000Z",
) {
  return {
    issueId: "1",
    issueIdentifier: "ISSUE-1",
    event: "checkpoint" as const,
    checkedAt,
    workerLane: WORKER_LANE,
    reviewerLane: REVIEWER_LANE,
    findings,
  };
}

describe("feedback injection-hygiene policy (SYMPH-378)", () => {
  it("admits blockers and evidence-grounded findings; rejects ungrounded advisories", () => {
    expect(
      feedbackFindingCarriesNewSignal({
        title: "scope stop: editing files outside the task",
        severity: "blocking",
      }),
    ).toBe(true);
    expect(
      feedbackFindingCarriesNewSignal({
        title: "off-by-one in retry window",
        severity: "warning",
        file: "src/orchestrator/core.ts",
        line: 12,
      }),
    ).toBe(true);
    expect(
      feedbackFindingCarriesNewSignal({
        title: "remember to follow the spec and add tests",
        severity: "warning",
      }),
    ).toBe(false);
    expect(
      feedbackFindingCarriesNewSignal({
        title: "consider being more thorough",
        severity: "info",
      }),
    ).toBe(false);
  });

  it("suppressed findings never bounce: not open, checkpoint status is pass", () => {
    const state = mergeContinuousFeedbackCheckpoint(
      undefined,
      checkpoint([
        { title: "restate: implement the issue per the description" },
      ]),
    );

    expect(state.status).toBe("pass");
    expect(state.findings).toHaveLength(1);
    expect(state.findings[0]?.status).toBe("suppressed");
    expect(getOpenContinuousFeedbackFindings(state)).toHaveLength(0);
  });

  it("a grounded finding still opens and flips the checkpoint to finding", () => {
    const state = mergeContinuousFeedbackCheckpoint(
      undefined,
      checkpoint([
        { title: "ungrounded advice" },
        {
          title: "broken null guard",
          severity: "warning",
          file: "src/foo.ts",
          line: 4,
        },
      ]),
    );

    expect(state.status).toBe("finding");
    const open = getOpenContinuousFeedbackFindings(state);
    expect(open).toHaveLength(1);
    expect(open[0]?.title).toBe("broken null guard");
  });

  it("re-classifies on every arrival: a suppressed finding returning with evidence opens", () => {
    const first = mergeContinuousFeedbackCheckpoint(
      undefined,
      checkpoint([{ signature: "sig-1", title: "vague concern" }]),
    );
    expect(first.findings[0]?.status).toBe("suppressed");

    const second = mergeContinuousFeedbackCheckpoint(
      first,
      checkpoint(
        [
          {
            signature: "sig-1",
            title: "vague concern, now located",
            file: "src/foo.ts",
            line: 9,
          },
        ],
        "2026-06-11T00:05:00.000Z",
      ),
    );
    expect(second.findings[0]?.status).toBe("open");
    expect(second.status).toBe("finding");
    expect(second.findings[0]?.occurrences).toBe(2);
  });
});
