import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORKFLOW_PROMPT,
  buildContinuationPrompt,
  buildTurnPrompt,
  getEffectivePromptTemplate,
  renderPrompt,
} from "../../src/agent/prompt-builder.js";
import type { PromptTemplateError } from "../../src/agent/prompt-builder.js";
import type { Issue } from "../../src/domain/model.js";
import { ERROR_CODES } from "../../src/errors/codes.js";
import { createModeScopedPermissionPolicy } from "../../src/policy/hard-stops.js";

const ISSUE_FIXTURE: Issue = {
  id: "issue-1",
  identifier: "ABC-123",
  title: "Ship prompt rendering",
  description: "Implement strict Liquid prompt rendering",
  priority: 1,
  state: "In Progress",
  branchName: "feature/abc-123",
  url: "https://linear.app/example/issue/ABC-123",
  labels: ["backend", "automation"],
  blockedBy: [
    {
      id: "issue-0",
      identifier: "ABC-122",
      state: "Todo",
    },
  ],
  createdAt: "2026-03-06T00:00:00.000Z",
  updatedAt: "2026-03-06T01:00:00.000Z",
};

describe("prompt builder", () => {
  it("uses the spec fallback prompt when the workflow body is blank", () => {
    expect(getEffectivePromptTemplate(" \n\t ")).toBe(DEFAULT_WORKFLOW_PROMPT);
  });

  it("renders issue fields, nested arrays, and attempt metadata", async () => {
    const prompt = await renderPrompt({
      workflow: {
        promptTemplate: [
          "# {{ issue.identifier }}",
          "{{ issue.title }}",
          "{% for label in issue.labels %}[{{ label }}]{% endfor %}",
          "{% for blocker in issue.blocked_by %}{{ blocker.identifier }}:{{ blocker.state }}{% endfor %}",
          "{{ issue.branch_name }}",
          "{{ issue.created_at }}",
          "{{ issue.updated_at }}",
          "attempt={{ attempt }}",
        ].join("\n"),
      },
      issue: ISSUE_FIXTURE,
      attempt: 2,
    });

    expect(prompt).toContain("# ABC-123");
    expect(prompt).toContain("Ship prompt rendering");
    expect(prompt).toContain("[backend][automation]");
    expect(prompt).toContain("ABC-122:Todo");
    expect(prompt).toContain("feature/abc-123");
    expect(prompt).toContain("2026-03-06T00:00:00.000Z");
    expect(prompt).toContain("2026-03-06T01:00:00.000Z");
    expect(prompt).toContain("attempt=2");
  });

  it("preserves a null attempt for first-run prompts", async () => {
    const prompt = await renderPrompt({
      workflow: {
        promptTemplate:
          "{% if attempt == nil %}first-run{% else %}retry{% endif %}",
      },
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    expect(prompt).toBe("first-run");
  });

  it("makes stageName available in the template context", async () => {
    const prompt = await renderPrompt({
      workflow: {
        promptTemplate:
          '{% if stageName == "investigate" %}research{% else %}build{% endif %}',
      },
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "investigate",
    });

    expect(prompt).toBe("research");

    const promptNull = await renderPrompt({
      workflow: {
        promptTemplate:
          "{% if stageName == nil %}no-stage{% else %}has-stage{% endif %}",
      },
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    expect(promptNull).toBe("no-stage");
  });

  it("renders the frozen AC snapshot as acceptance_criteria with an empty-string default (SYMPH-374)", async () => {
    const template =
      '{% if acceptance_criteria != "" %}AC:{{ acceptance_criteria }}{% else %}no-acs{% endif %}';

    const withSnapshot = await renderPrompt({
      workflow: { promptTemplate: template },
      issue: ISSUE_FIXTURE,
      attempt: null,
      acceptanceCriteria: "### Acceptance Criteria\n- [ ] `check: ok`",
    });
    expect(withSnapshot).toBe("AC:### Acceptance Criteria\n- [ ] `check: ok`");

    // Absent and explicit-null both render the default — strictVariables
    // must never throw for templates that reference acceptance_criteria.
    const absent = await renderPrompt({
      workflow: { promptTemplate: template },
      issue: ISSUE_FIXTURE,
      attempt: null,
    });
    expect(absent).toBe("no-acs");

    const explicitNull = await renderPrompt({
      workflow: { promptTemplate: template },
      issue: ISSUE_FIXTURE,
      attempt: null,
      acceptanceCriteria: null,
    });
    expect(explicitNull).toBe("no-acs");
  });

  it("renders comment_deltas with an empty-array default under strictVariables", async () => {
    const prompt = await renderPrompt({
      workflow: {
        promptTemplate:
          "{% if comment_deltas.size == 0 %}no-deltas{% endif %}|{{ implementation_comment_context.comments.size }}",
      },
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    expect(prompt).toBe("no-deltas|0");
  });

  it("renders structured implementation comment deltas on first-turn prompts", async () => {
    const prompt = await renderPrompt({
      workflow: {
        promptTemplate: [
          "cutoff={{ implementation_comment_context.cutoff }}",
          "{% for delta in comment_deltas %}{{ delta.id }}:{{ delta.authorClass }}:{{ delta.disposition }}:{{ delta.body }}{% endfor %}",
        ].join("\n"),
      },
      issue: ISSUE_FIXTURE,
      attempt: null,
      implementationCommentDeltas: {
        sourceIntentHash: "source-hash",
        cutoff: "2026-03-06T00:10:00.000Z",
        requiresOperatorContext: false,
        operatorContextReason: null,
        comments: [
          {
            id: "comment-2",
            authorClass: "service_account",
            createdAt: "2026-03-06T00:15:00.000Z",
            updatedAt: "2026-03-06T00:15:00.000Z",
            effectiveAt: "2026-03-06T00:15:00.000Z",
            disposition: "post_cutoff",
            body: "Agent follow-up",
          },
        ],
      },
    });

    expect(prompt).toContain("cutoff=2026-03-06T00:10:00.000Z");
    expect(prompt).toContain(
      "comment-2:service_account:post_cutoff:Agent follow-up",
    );
  });

  it("uses the rendered workflow prompt for the first turn and continuation guidance after that", async () => {
    const first = await buildTurnPrompt({
      workflow: {
        promptTemplate: "Initial {{ issue.identifier }} attempt={{ attempt }}",
      },
      issue: ISSUE_FIXTURE,
      attempt: 3,
      turnNumber: 1,
      maxTurns: 4,
    });
    const second = await buildTurnPrompt({
      workflow: {
        promptTemplate: "Initial {{ issue.identifier }} attempt={{ attempt }}",
      },
      issue: ISSUE_FIXTURE,
      attempt: 3,
      turnNumber: 2,
      maxTurns: 4,
    });

    expect(first).toBe("Initial ABC-123 attempt=3");
    expect(second).toContain("Continue working on issue ABC-123");
    expect(second).toContain("continuation turn 2 of 4");
    expect(second).not.toContain("Initial ABC-123 attempt=3");
  });

  it("prepends a mode permission envelope to first-turn prompts when policy denies PRs", async () => {
    const prompt = await renderPrompt({
      workflow: {
        promptTemplate:
          "Implement the issue and open a PR with `gh pr create`.",
      },
      issue: ISSUE_FIXTURE,
      attempt: null,
      modePolicy: createModeScopedPermissionPolicy({
        mode: "prototype",
        configuredApprovalPolicy: "full-auto",
        configuredThreadSandbox: "workspace-write",
        configuredTurnSandboxPolicy: { type: "workspace-write" },
        maxBudgetUsd: 50,
      }),
    });

    expect(prompt).toContain("## Mode Permission Envelope");
    expect(prompt).toContain("Mode: prototype");
    expect(prompt).toContain("Pull requests: denied");
    expect(prompt).toContain("Auto-merge / merge-queue enqueue: denied");
    expect(prompt).toContain("Gate bypass: denied");
    expect(prompt).toContain("[BLOCKED_NEEDS_HUMAN_BLOCKERS: {...}]");
    expect(prompt).toContain("open a PR with `gh pr create`");
  });

  it("builds continuation guidance with issue and attempt context", () => {
    const prompt = buildContinuationPrompt({
      issue: ISSUE_FIXTURE,
      attempt: null,
      turnNumber: 2,
      maxTurns: 5,
    });

    expect(prompt).toContain("ABC-123");
    expect(prompt).toContain("Ship prompt rendering");
    expect(prompt).toContain("Current tracker state: In Progress.");
    expect(prompt).toContain("initial dispatch");
    expect(prompt).toContain("path/count-only commands");
    expect(prompt).toContain("rg -n ... -m 50 path");
    expect(prompt).toContain("max_output_tokens");
    expect(prompt).toContain("1,500 or less");
  });

  it("fails on unknown variables in strict mode", async () => {
    await expect(
      renderPrompt({
        workflow: {
          promptTemplate: "{{ issue.missingField }}",
        },
        issue: ISSUE_FIXTURE,
        attempt: null,
      }),
    ).rejects.toMatchObject({
      name: "PromptTemplateError",
      code: ERROR_CODES.templateRenderError,
      kind: "template_render_error",
    } satisfies Partial<PromptTemplateError>);
  });

  it("fails on unknown filters in strict mode", async () => {
    await expect(
      renderPrompt({
        workflow: {
          promptTemplate: "{{ issue.title | no_such_filter }}",
        },
        issue: ISSUE_FIXTURE,
        attempt: null,
      }),
    ).rejects.toMatchObject({
      name: "PromptTemplateError",
      code: ERROR_CODES.templateRenderError,
      kind: "template_render_error",
    } satisfies Partial<PromptTemplateError>);
  });

  it("includes investigate constraints and STAGE_COMPLETE in continuation when stageName is investigate", () => {
    const prompt = buildContinuationPrompt({
      issue: ISSUE_FIXTURE,
      attempt: null,
      turnNumber: 2,
      maxTurns: 5,
      stageName: "investigate",
    });

    expect(prompt).toContain("Current stage: investigate.");
    expect(prompt).toContain("Do NOT implement code");
    expect(prompt).toContain("Investigation Token Brake");
    expect(prompt).toContain("at most 6 shell/tool calls");
    expect(prompt).toContain("max_output_tokens` of 800 or less");
    expect(prompt).toContain(
      "latest Linear issue comments/workpad/resume notes",
    );
    expect(prompt).toContain("Do not trust repo-root scratch files");
    expect(prompt).toContain("zsh-safe");
    expect(prompt).toContain("cmd_status");
    expect(prompt).toContain("[STAGE_COMPLETE]");
  });

  it("includes implement constraints and STAGE_COMPLETE in continuation when stageName is implement", () => {
    const prompt = buildContinuationPrompt({
      issue: ISSUE_FIXTURE,
      attempt: null,
      turnNumber: 2,
      maxTurns: 5,
      stageName: "implement",
    });

    expect(prompt).toContain("Current stage: implement.");
    expect(prompt).toContain("IMPLEMENT stage");
    expect(prompt).toContain("Headless output budget");
    expect(prompt).toContain(".symphony/validation/");
    expect(prompt).toContain("zsh-safe");
    expect(prompt).toContain("cmd_status");
    expect(prompt).toContain("[STAGE_COMPLETE]");
  });

  it("includes structured comment deltas in continuation prompts", () => {
    const prompt = buildContinuationPrompt({
      issue: ISSUE_FIXTURE,
      attempt: null,
      turnNumber: 2,
      maxTurns: 5,
      stageName: "implement",
      implementationCommentDeltas: {
        sourceIntentHash: "source-hash",
        cutoff: "2026-03-06T00:10:00.000Z",
        requiresOperatorContext: false,
        operatorContextReason: null,
        comments: [
          {
            id: "comment-3",
            authorClass: "operator",
            createdAt: "2026-03-06T00:00:00.000Z",
            updatedAt: "2026-03-06T00:00:00.000Z",
            effectiveAt: "2026-03-06T00:00:00.000Z",
            disposition: "carried_forward",
            body: "Keep this operator directive live.",
          },
        ],
      },
    });

    expect(prompt).toContain(
      "Implementation comment deltas since canonical spec review:",
    );
    expect(prompt).toContain("Review cutoff: 2026-03-06T00:10:00.000Z.");
    expect(prompt).toContain(
      "comment-3 | author=operator | disposition=carried_forward",
    );
    expect(prompt).not.toContain("full historical comment thread");
  });

  it("prepends an operator-context guard when comment dispositions are uncited", async () => {
    const prompt = await renderPrompt({
      workflow: {
        promptTemplate: "Implement {{ issue.identifier }}",
      },
      issue: ISSUE_FIXTURE,
      attempt: null,
      implementationCommentDeltas: {
        sourceIntentHash: "source-hash",
        cutoff: "2026-03-06T00:10:00.000Z",
        requiresOperatorContext: true,
        operatorContextReason: "comment-4 is uncited.",
        comments: [],
      },
    });

    expect(prompt).toContain(
      "Implementation comment delta guard requires operator context.",
    );
    expect(prompt).toContain("Reason: comment-4 is uncited.");
    expect(prompt).toContain("Do not implement.");
    expect(prompt).toContain("Implement ABC-123");
    expect(prompt.indexOf("Do not implement.")).toBeGreaterThan(
      prompt.indexOf("Implement ABC-123"),
    );
  });

  it("keeps continuation operator-context guards after implement-stage guidance", () => {
    const prompt = buildContinuationPrompt({
      issue: ISSUE_FIXTURE,
      attempt: null,
      turnNumber: 2,
      maxTurns: 5,
      stageName: "implement",
      implementationCommentDeltas: {
        sourceIntentHash: "source-hash",
        cutoff: "2026-03-06T00:10:00.000Z",
        requiresOperatorContext: true,
        operatorContextReason: "comment-4 is uncited.",
        comments: [],
      },
    });

    expect(prompt.indexOf("Do not implement.")).toBeGreaterThan(
      prompt.indexOf("You are in the IMPLEMENT stage."),
    );
  });

  it("wraps merge continuation prompts with PR, merge, and bypass denials", () => {
    const prompt = buildContinuationPrompt({
      issue: ISSUE_FIXTURE,
      attempt: null,
      turnNumber: 2,
      maxTurns: 5,
      stageName: "merge",
      modePolicy: createModeScopedPermissionPolicy({
        mode: "full",
        stageName: "merge",
        configuredApprovalPolicy: "full-auto",
        configuredThreadSandbox: "workspace-write",
        configuredTurnSandboxPolicy: { type: "workspace-write" },
        maxBudgetUsd: 50,
      }),
    });

    expect(prompt).toContain("Mode: full");
    expect(prompt).toContain("Stage: merge");
    expect(prompt).toContain("Pull requests: denied");
    expect(prompt).toContain("Auto-merge / merge-queue enqueue: denied");
    expect(prompt).toContain("Gate bypass: denied");
    expect(prompt).toContain("You are in the MERGE stage");
    expect(prompt).toContain(
      "gh pr view --json mergeStateStatus,statusCheckRollup,reviewDecision,mergeable,state,isDraft",
    );
    expect(prompt).toContain("gh pr checks --required");
    expect(prompt).toContain(
      "Evaluate readiness before any merge permission boundary",
    );
    expect(prompt).toContain("[BLOCKED_NEEDS_HUMAN_BLOCKERS: {...}]");
  });

  it("does not include STAGE_COMPLETE in continuation when stageName is null", () => {
    const prompt = buildContinuationPrompt({
      issue: ISSUE_FIXTURE,
      attempt: null,
      turnNumber: 2,
      maxTurns: 5,
      stageName: null,
    });

    expect(prompt).not.toContain("[STAGE_COMPLETE]");
    expect(prompt).not.toContain("Current stage:");
  });

  it("passes stageName through buildTurnPrompt to continuation on turn > 1", async () => {
    const prompt = await buildTurnPrompt({
      workflow: {
        promptTemplate: "Initial {{ issue.identifier }}",
      },
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "investigate",
      turnNumber: 2,
      maxTurns: 4,
    });

    expect(prompt).toContain("Current stage: investigate.");
    expect(prompt).toContain("Do NOT implement code");
    expect(prompt).toContain("[STAGE_COMPLETE]");
  });

  it("makes reworkCount available in the template context, defaulting to 0", async () => {
    const prompt = await renderPrompt({
      workflow: {
        promptTemplate: "rework={{ reworkCount }}",
      },
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    expect(prompt).toBe("rework=0");
  });

  it("renders reworkCount when explicitly provided", async () => {
    const prompt = await renderPrompt({
      workflow: {
        promptTemplate:
          "{% if reworkCount > 0 %}rework attempt {{ reworkCount }}{% else %}first attempt{% endif %}",
      },
      issue: ISSUE_FIXTURE,
      attempt: null,
      reworkCount: 3,
    });

    expect(prompt).toBe("rework attempt 3");
  });

  it("renders reworkCount as 0 on first attempt", async () => {
    const prompt = await renderPrompt({
      workflow: {
        promptTemplate:
          "{% if reworkCount > 0 %}rework attempt {{ reworkCount }}{% else %}first attempt{% endif %}",
      },
      issue: ISSUE_FIXTURE,
      attempt: null,
      reworkCount: 0,
    });

    expect(prompt).toBe("first attempt");
  });

  it("reports invalid template syntax as a parse error", async () => {
    await expect(
      renderPrompt({
        workflow: {
          promptTemplate: "{% if issue.identifier %}",
        },
        issue: ISSUE_FIXTURE,
        attempt: null,
      }),
    ).rejects.toMatchObject({
      name: "PromptTemplateError",
      code: ERROR_CODES.templateParseError,
      kind: "template_parse_error",
    } satisfies Partial<PromptTemplateError>);
  });
});
