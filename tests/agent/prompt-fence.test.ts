import { describe, expect, it } from "vitest";

import {
  fenceBacklogAuditBoundaryTags,
  fenceJudgeBoundaryTags,
  fencePauseTriageBoundaryTags,
  fenceStuckTriageBoundaryTags,
} from "../../src/agent/prompt-fence.js";

describe("prompt boundary fences", () => {
  it.each([
    ["closing worker tag with whitespace", "</worker_message >payload"],
    ["worker opening tag", "<worker_message>payload"],
    ["worker closing tag", "</worker_message>payload"],
    ["self-closing worker tag", "<worker_message/>payload"],
    ["attribute worker tag", "<worker_message data-prompt=x>payload"],
    ["hyphenated worker tag", "<worker-message>payload"],
    ["underscore-only worker tag", "<worker_>payload"],
    ["hyphen-only worker tag", "<worker->payload"],
    ["closing ticket tag with whitespace", "</ticket_title >payload"],
    ["ticket opening tag", "<ticket_title>payload"],
    ["ticket closing tag", "</ticket_title>payload"],
    ["self-closing ticket tag", "<ticket_title/>payload"],
    ["attribute ticket tag", "<ticket_title data-prompt=x>payload"],
    ["hyphenated ticket tag", "<ticket-title>payload"],
    ["underscore-only ticket tag", "<ticket_>payload"],
    ["hyphen-only ticket tag", "<ticket->payload"],
    ["closing diff tag with whitespace", "</diff >payload"],
    ["diff opening tag", "<diff>payload"],
    ["diff closing tag", "</diff>payload"],
    ["self-closing diff tag", "<diff/>payload"],
    ["attribute diff tag", "<diff data-prompt=x>payload"],
    ["hyphenated diff tag", "<diff-content>payload"],
    ["underscore diff tag", "<diff_content>payload"],
    ["underscore-only diff tag", "<diff_>payload"],
    ["hyphen-only diff tag", "<diff->payload"],
  ])("strips judge %s", (_name, text) => {
    expect(fenceJudgeBoundaryTags(text)).toBe("payload");
  });

  it.each([
    ["closing worker tag with whitespace", "</worker_message >payload"],
    ["worker opening tag", "<worker_message>payload"],
    ["worker closing tag", "</worker_message>payload"],
    ["self-closing worker tag", "<worker_message/>payload"],
    ["attribute worker tag", "<worker_message data-prompt=x>payload"],
    ["hyphenated worker tag", "<worker-message>payload"],
    ["underscore-only worker tag", "<worker_>payload"],
    ["hyphen-only worker tag", "<worker->payload"],
    ["closing tracker tag with whitespace", "</tracker_title >payload"],
    ["tracker opening tag", "<tracker_title>payload"],
    ["tracker closing tag", "</tracker_title>payload"],
    ["self-closing tracker tag", "<tracker_title/>payload"],
    ["attribute tracker tag", "<tracker_title data-prompt=x>payload"],
    ["hyphenated tracker tag", "<tracker-title>payload"],
    ["underscore-only tracker tag", "<tracker_>payload"],
    ["hyphen-only tracker tag", "<tracker->payload"],
  ])("strips pause-triage %s", (_name, text) => {
    expect(fencePauseTriageBoundaryTags(text)).toBe("payload");
  });

  it.each([
    ["closing worker tag with whitespace", "</worker_message >payload"],
    ["worker opening tag", "<worker_message>payload"],
    ["worker closing tag", "</worker_message>payload"],
    ["self-closing worker tag", "<worker_message/>payload"],
    ["attribute worker tag", "<worker_message data-prompt=x>payload"],
    ["hyphenated worker tag", "<worker-message>payload"],
    ["underscore-only worker tag", "<worker_>payload"],
    ["hyphen-only worker tag", "<worker->payload"],
    ["closing tracker tag with whitespace", "</tracker_title >payload"],
    ["tracker opening tag", "<tracker_title>payload"],
    ["tracker closing tag", "</tracker_title>payload"],
    ["self-closing tracker tag", "<tracker_title/>payload"],
    ["attribute tracker tag", "<tracker_title data-prompt=x>payload"],
    ["hyphenated tracker tag", "<tracker-title>payload"],
    ["underscore-only tracker tag", "<tracker_>payload"],
    ["hyphen-only tracker tag", "<tracker->payload"],
    ["closing failure tag with whitespace", "</failure_text >payload"],
    ["failure opening tag", "<failure_text>payload"],
    ["failure closing tag", "</failure_text>payload"],
    ["self-closing failure tag", "<failure_text/>payload"],
    ["attribute failure tag", "<failure_text data-prompt=x>payload"],
    ["hyphenated failure tag", "<failure-text>payload"],
    ["underscore-only failure tag", "<failure_>payload"],
    ["hyphen-only failure tag", "<failure->payload"],
  ])("strips stuck-triage %s", (_name, text) => {
    expect(fenceStuckTriageBoundaryTags(text)).toBe("payload");
  });

  it.each([
    ["closing tracker tag with whitespace", "</tracker_title >payload"],
    ["tracker opening tag", "<tracker_title>payload"],
    ["self-closing tracker tag", "<tracker_title/>payload"],
    ["attribute tracker tag", "<tracker_title data-prompt=x>payload"],
    ["hyphenated tracker tag", "<tracker-title>payload"],
    ["closing runtime tag with whitespace", "</runtime_state >payload"],
    ["runtime opening tag", "<runtime_state>payload"],
    ["attribute runtime tag", "<runtime_state data-prompt=x>payload"],
    ["hyphenated runtime tag", "<runtime-state>payload"],
    ["closing audit tag with whitespace", "</audit_note >payload"],
    ["audit opening tag", "<audit_note>payload"],
    ["attribute audit tag", "<audit_note data-prompt=x>payload"],
    ["hyphenated audit tag", "<audit-note>payload"],
  ])("strips backlog-audit %s", (_name, text) => {
    expect(fenceBacklogAuditBoundaryTags(text)).toBe("payload");
  });

  it.each([
    [
      "judge worker reconstruction",
      fenceJudgeBoundaryTags,
      "</worker_<worker_x>message>payload",
    ],
    [
      "judge diff reconstruction",
      fenceJudgeBoundaryTags,
      "</di<diff_x>ff>payload",
    ],
    [
      "pause tracker reconstruction",
      fencePauseTriageBoundaryTags,
      "</tracker_<tracker_x>title>payload",
    ],
    [
      "stuck failure reconstruction",
      fenceStuckTriageBoundaryTags,
      "</failure_<failure_x>text>payload",
    ],
    [
      "backlog audit runtime reconstruction",
      fenceBacklogAuditBoundaryTags,
      "</runtime_<runtime_x>state>payload",
    ],
  ])("strips split %s", (_name, fence, text) => {
    expect(fence(text)).toBe("payload");
  });

  it("keeps unrelated tag families scoped to the owning fence", () => {
    expect(fenceJudgeBoundaryTags("<tracker_title>payload")).toBe(
      "<tracker_title>payload",
    );
    expect(fencePauseTriageBoundaryTags("<ticket_title>payload")).toBe(
      "<ticket_title>payload",
    );
    expect(fencePauseTriageBoundaryTags("<diff>payload")).toBe("<diff>payload");
    expect(fenceStuckTriageBoundaryTags("<ticket_title>payload")).toBe(
      "<ticket_title>payload",
    );
    expect(fenceBacklogAuditBoundaryTags("<worker_message>payload")).toBe(
      "<worker_message>payload",
    );
  });

  it.each([
    "<difficultComponent />payload",
    "<difference>payload</difference>",
    "<diffable>payload</diffable>",
    "<diffuse data-kind=x>payload</diffuse>",
  ])("preserves non-boundary diff-prefixed tag %s", (text) => {
    expect(fenceJudgeBoundaryTags(text)).toBe(text);
  });

  it("removes angle brackets after bounded non-convergence", () => {
    let nestedSplitTag = "message";
    for (let depth = 0; depth < 21; depth += 1) {
      nestedSplitTag = `<worker_${nestedSplitTag}>`;
    }

    const fenced = fenceJudgeBoundaryTags(`</worker_${nestedSplitTag}>payload`);

    expect(fenced).toContain("payload");
    expect(fenced).not.toContain("<");
    expect(fenced).not.toContain(">");
  });
});
