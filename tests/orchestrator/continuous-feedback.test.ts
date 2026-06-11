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

  it("an empty checkpoint resolves prior opens; a suppressed-only checkpoint does NOT (council R1)", () => {
    const opened = mergeContinuousFeedbackCheckpoint(
      undefined,
      checkpoint([
        {
          signature: "sig-real",
          title: "broken guard",
          severity: "warning",
          file: "src/foo.ts",
        },
      ]),
    );
    expect(opened.findings[0]?.status).toBe("open");

    // Suppressed-only checkpoint: no signal about the prior open — it
    // stays open, the checkpoint stays at "finding", and the open
    // finding remains bounce-eligible.
    const suppressedOnly = mergeContinuousFeedbackCheckpoint(
      opened,
      checkpoint(
        [{ title: "vague ungrounded advice" }],
        "2026-06-11T00:05:00.000Z",
      ),
    );
    expect(
      suppressedOnly.findings.find((f) => f.signature === "sig-real")?.status,
    ).toBe("open");
    expect(suppressedOnly.status).toBe("finding");
    expect(getOpenContinuousFeedbackFindings(suppressedOnly)).toHaveLength(1);

    // Genuinely empty checkpoint: clean by contract — prior opens resolve.
    const emptied = mergeContinuousFeedbackCheckpoint(
      suppressedOnly,
      checkpoint([], "2026-06-11T00:10:00.000Z"),
    );
    expect(
      emptied.findings.find((f) => f.signature === "sig-real")?.status,
    ).toBe("resolved");
    expect(emptied.status).toBe("pass");
  });

  it("an already-open finding is never demoted by a re-sighting that drops its file (council R1)", () => {
    const opened = mergeContinuousFeedbackCheckpoint(
      undefined,
      checkpoint([
        {
          signature: "sig-1",
          title: "null guard",
          severity: "warning",
          file: "src/foo.ts",
          line: 4,
        },
      ]),
    );
    const reSighted = mergeContinuousFeedbackCheckpoint(
      opened,
      checkpoint(
        [{ signature: "sig-1", title: "null guard", severity: "warning" }],
        "2026-06-11T00:05:00.000Z",
      ),
    );
    expect(reSighted.findings[0]?.status).toBe("open");
    expect(reSighted.status).toBe("finding");
    expect(getOpenContinuousFeedbackFindings(reSighted)).toHaveLength(1);
  });

  it("empty or whitespace file does not ground a finding (council R1)", () => {
    expect(
      feedbackFindingCarriesNewSignal({
        title: "add more tests",
        severity: "warning",
        file: "",
      }),
    ).toBe(false);
    expect(
      feedbackFindingCarriesNewSignal({
        title: "add more tests",
        severity: "warning",
        file: "   ",
      }),
    ).toBe(false);
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
