import { describe, expect, it } from "vitest";

import {
  fenceJudgeBoundaryTags,
  fencePauseTriageBoundaryTags,
} from "../../src/agent/prompt-fence.js";

describe("prompt boundary fences", () => {
  it.each([
    ["closing worker tag with whitespace", "</worker_message >payload"],
    ["self-closing worker tag", "<worker_message/>payload"],
    ["attribute worker tag", "<worker_message data-prompt=x>payload"],
    ["hyphenated worker tag", "<worker-message>payload"],
    ["underscore-only worker tag", "<worker_>payload"],
    ["hyphen-only worker tag", "<worker->payload"],
    ["closing ticket tag with whitespace", "</ticket_title >payload"],
    ["self-closing ticket tag", "<ticket_title/>payload"],
    ["attribute ticket tag", "<ticket_title data-prompt=x>payload"],
    ["hyphenated ticket tag", "<ticket-title>payload"],
    ["underscore-only ticket tag", "<ticket_>payload"],
    ["hyphen-only ticket tag", "<ticket->payload"],
    ["closing diff tag with whitespace", "</diff >payload"],
    ["self-closing diff tag", "<diff/>payload"],
    ["attribute diff tag", "<diff data-prompt=x>payload"],
    ["hyphenated diff tag", "<diff-content>payload"],
  ])("strips judge %s", (_name, text) => {
    expect(fenceJudgeBoundaryTags(text)).toBe("payload");
  });

  it.each([
    ["closing worker tag with whitespace", "</worker_message >payload"],
    ["self-closing worker tag", "<worker_message/>payload"],
    ["attribute worker tag", "<worker_message data-prompt=x>payload"],
    ["hyphenated worker tag", "<worker-message>payload"],
    ["underscore-only worker tag", "<worker_>payload"],
    ["hyphen-only worker tag", "<worker->payload"],
    ["closing tracker tag with whitespace", "</tracker_title >payload"],
    ["self-closing tracker tag", "<tracker_title/>payload"],
    ["attribute tracker tag", "<tracker_title data-prompt=x>payload"],
    ["hyphenated tracker tag", "<tracker-title>payload"],
    ["underscore-only tracker tag", "<tracker_>payload"],
    ["hyphen-only tracker tag", "<tracker->payload"],
  ])("strips pause-triage %s", (_name, text) => {
    expect(fencePauseTriageBoundaryTags(text)).toBe("payload");
  });

  it("keeps unrelated tag families scoped to the owning fence", () => {
    expect(fenceJudgeBoundaryTags("<tracker_title>payload")).toBe(
      "<tracker_title>payload",
    );
    expect(fencePauseTriageBoundaryTags("<ticket_title>payload")).toBe(
      "<ticket_title>payload",
    );
    expect(fencePauseTriageBoundaryTags("<diff>payload")).toBe("<diff>payload");
  });
});
