import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import { renderPrompt } from "../../src/agent/prompt-builder.js";
import { resolveWorkflowConfig } from "../../src/config/config-resolver.js";
import { loadWorkflowDefinition } from "../../src/config/workflow-loader.js";
import type { Issue } from "../../src/domain/model.js";

const WORKFLOW_PATH = resolve(
  import.meta.dirname,
  "../../pipeline-config/workflows/WORKFLOW-symphony.md",
);
const PIPELINE_WORKFLOW_PATH = resolve(
  import.meta.dirname,
  "../../pipeline-config/WORKFLOW.md",
);
const CODEX_LOW_APP_SERVER_COMMAND =
  "codex --disable plugins --disable hooks --disable plugin_hooks --disable apps --disable browser_use --disable browser_use_external --disable computer_use --disable multi_agent --disable goals --disable memories --disable tool_call_mcp_elicitation --config 'model_reasoning_effort=\"low\"' --config 'project_doc_max_bytes=0' --config 'features.codex_hooks=false' app-server";
const SHIPPED_CODEX_WORKFLOW_CONFIGS = [
  "../../pipeline-config/WORKFLOW.md",
  "../../pipeline-config/WORKFLOW-staged.md",
  "../../pipeline-config/WORKFLOW-flat.md",
  "../../pipeline-config/WORKFLOW-instrumentation.md",
  "../../pipeline-config/templates/WORKFLOW-template.md",
].map((path) => resolve(import.meta.dirname, path));
const INLINE_WORKER_PROMPT_CONFIGS = SHIPPED_CODEX_WORKFLOW_CONFIGS.filter(
  (path) => !path.endsWith("/pipeline-config/WORKFLOW.md"),
);
const PRIMARY_PROMPT_PARTIALS = [
  "../../pipeline-config/prompts/global.liquid",
  "../../pipeline-config/prompts/investigate.liquid",
  "../../pipeline-config/prompts/implement.liquid",
].map((path) => resolve(import.meta.dirname, path));
const RESOLVED_CODEX_WORKFLOW_CONFIGS = [
  ...SHIPPED_CODEX_WORKFLOW_CONFIGS,
  WORKFLOW_PATH,
];
const OBSERVED_CODEX_LOW_FIRST_TURN_TOKENS = 233_719;
const EXPECTED_INVESTIGATE_HARD_STOPS = {
  maxIterations: 4,
  maxTokensPerUnit: 200_000,
  maxDollarBudgetUsd: 4,
  premiumBudgetPauseRatio: 0.9,
};
const REPO_ROOT = resolve(import.meta.dirname, "../..");

const DESCRIPTION_SENTINEL = "DESCRIPTION_SENTINEL: do not leak to merge";

const ISSUE_FIXTURE: Issue = {
  id: "test-issue-id",
  identifier: "TEST-1",
  title: "Test issue title",
  description: DESCRIPTION_SENTINEL,
  state: "In Progress",
  branchName: "feature/test-1",
  url: "https://linear.app/example/issue/TEST-1",
  labels: [],
  blockedBy: [],
  priority: 1,
  createdAt: "2026-03-28T00:00:00.000Z",
  updatedAt: "2026-03-28T01:00:00.000Z",
};

const workflow = await loadWorkflowDefinition(WORKFLOW_PATH);
const { promptTemplate } = workflow;
const resolvedConfig = resolveWorkflowConfig(workflow, {
  LINEAR_API_KEY: "test-token",
});

describe("WORKFLOW-symphony.md smoke tests", () => {
  it("uses Codex low effort as the primary workflow runner", () => {
    expect(resolvedConfig.runner).toEqual({ kind: "codex", model: null });
    expect(resolvedConfig.codex.command).toBe(CODEX_LOW_APP_SERVER_COMMAND);
    expect(resolvedConfig.codex.ephemeralHome).toBe(true);
    expect(resolvedConfig.codex.disableSkills).toBe(true);
    expect(resolvedConfig.riskPredicateReasoning).toEqual({ effort: "high" });

    const stages = resolvedConfig.stages;
    expect(stages).not.toBeNull();
    expect(stages?.stages.investigate?.runner).toBe("codex");
    expect(stages?.stages.implement?.runner).toBe("codex");
    expect(stages?.stages.review?.runner).toBe("codex");
    expect(stages?.stages.merge?.runner).toBe("codex");
    expect(stages?.stages.review?.model).toBeNull();
    expect(stages?.stages.review?.maxTurns).toBe(8);
    expect(resolvedConfig.codex.stallTimeoutMs).toBe(3_600_000);
  });

  it("uses bare Codex low-effort settings in shipped workflow configs", async () => {
    for (const configPath of SHIPPED_CODEX_WORKFLOW_CONFIGS) {
      const config = await readFile(configPath, "utf8");

      expect(config).toContain(`command: ${CODEX_LOW_APP_SERVER_COMMAND}`);
      expect(config).toContain("risk_predicate_reasoning_effort: high");
      expect(config).toContain("ephemeral_home: true");
      expect(config).toContain("disable_skills: true");
    }
  });

  it("exposes the CI-safe live Codex headless smoke command", async () => {
    expect(packageJson.scripts["probe:codex-skills"]).toBe(
      "node scripts/probe-codex-skills.mjs",
    );
    expect(packageJson.scripts["smoke:codex-headless"]).toBe(
      "node scripts/probe-codex-skills.mjs --ci-smoke",
    );

    const probeScript = await readFile(
      resolve(import.meta.dirname, "../../scripts/probe-codex-skills.mjs"),
      "utf8",
    );
    expect(probeScript).toContain(
      "skipped live Codex headless feature-flag smoke",
    );
    expect(probeScript).toContain(
      "Local verification: pnpm build && pnpm smoke:codex-headless",
    );
  });

  it("keeps shipped worker headless output bounded by log artifacts", async () => {
    for (const promptPath of [
      ...INLINE_WORKER_PROMPT_CONFIGS,
      ...PRIMARY_PROMPT_PARTIALS,
    ]) {
      const prompt = await readFile(promptPath, "utf8");

      expect(prompt).toContain("Headless Output Discipline");
      expect(prompt).toContain("broad `rg`");
      expect(prompt).toContain("scripts/symphony-run-logged.mjs");
      expect(prompt).toContain(".symphony/validation/");
      expect(prompt).toContain("zsh-safe");
      expect(prompt).toContain("cmd_status=$?");
      if (
        promptPath.endsWith(
          "/pipeline-config/templates/WORKFLOW-template.md",
        ) ||
        promptPath.endsWith("/pipeline-config/WORKFLOW-staged.md") ||
        promptPath.endsWith("/pipeline-config/WORKFLOW-instrumentation.md") ||
        promptPath.endsWith("/pipeline-config/prompts/investigate.liquid")
      ) {
        expect(prompt).toContain("Investigation Token Brake");
        expect(prompt).toContain("at most 6 shell/tool calls");
        expect(prompt).toContain("max_output_tokens` of 800 or less");
        expect(prompt).toContain(
          "latest Linear issue comments/workpad/resume notes",
        );
        expect(prompt).toContain("Do not trust repo-root scratch files");
        expect(prompt).toContain("Risk-Predicate State Contract Artifacts");
        expect(prompt).toContain("journal_producer");
        expect(prompt).toContain("### Risk Predicate State Contract");
        expect(prompt).toContain("Live success");
        expect(prompt).toContain("External side effects/idempotency");
        expect(prompt).toContain("risk-contract-artifact: <path>");
      }
      expect(prompt).not.toMatch(/(^|[^A-Za-z0-9_])status=\$\?/);
      expect(prompt).not.toContain("Run `npm test 2>&1`");
      expect(prompt).not.toContain("Do NOT filter or interpret SAST results");
    }

    const rendered = await renderPrompt({
      workflow: { promptTemplate },
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "implement",
    });
    expect(rendered).toContain("Headless Output Discipline");
    expect(rendered).toContain("broad `rg`");
    expect(rendered).toContain("scripts/symphony-run-logged.mjs");
    expect(rendered).toContain("cmd_status=$?");
    expect(rendered).not.toContain("Investigation Token Brake");

    const investigateRendered = await renderPrompt({
      workflow: { promptTemplate },
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "investigate",
    });
    expect(investigateRendered).toContain("Investigation Token Brake");
    expect(investigateRendered).toContain("at most 6 shell/tool calls");
    expect(investigateRendered).toContain("max_output_tokens` of 800 or less");
    expect(investigateRendered).toContain(
      "latest Linear issue comments/workpad/resume notes",
    );
    expect(investigateRendered).toContain(
      "Do not trust repo-root scratch files",
    );
    expect(investigateRendered).toContain(
      "Risk-Predicate State Contract Artifacts",
    );
    expect(investigateRendered).toContain("journal_replay_reducer");
    expect(investigateRendered).toContain("Duplicate/late consume");
  });

  it("does not ship root-level worker scratch artifacts", () => {
    const trackedScratchFiles = execFileSync(
      "git",
      ["ls-files", "--", "workpad.md", "INVESTIGATION-BRIEF.md"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean);

    expect(trackedScratchFiles).toEqual([]);
    expect(isGitIgnored("workpad.md")).toBe(true);
    expect(isGitIgnored("INVESTIGATION-BRIEF.md")).toBe(true);
    expect(isGitIgnored("docs/workpad.md")).toBe(false);
    expect(isGitIgnored("docs/INVESTIGATION-BRIEF.md")).toBe(false);
    expect(isGitIgnored(".claude/worktrees/example.ts")).toBe(true);
  });

  it("does not create, import, or read root investigation briefs from worker instructions", async () => {
    const template = await readFile(
      resolve(
        import.meta.dirname,
        "../../pipeline-config/templates/WORKFLOW-template.md",
      ),
      "utf8",
    );

    expect(template).not.toContain("@INVESTIGATION-BRIEF.md");
    expect(template).not.toMatch(
      /\b(?:append|create|import|read|write)\s+`?INVESTIGATION-BRIEF\.md`?/i,
    );
    expect(template).toContain("Linear Workpad Orientation");
  });

  it("keeps Biome from scanning local agent worktree clones", async () => {
    const biomeConfig = JSON.parse(
      await readFile(resolve(import.meta.dirname, "../../biome.json"), "utf8"),
    ) as { files?: { ignore?: string[] } };

    expect(biomeConfig.files?.ignore).toContain(".claude/worktrees/**");
  });

  it("scopes the investigation token brake to rendered investigate prompts", async () => {
    const primaryWorkflow = await loadWorkflowDefinition(
      PIPELINE_WORKFLOW_PATH,
    );
    const primaryConfig = resolveWorkflowConfig(primaryWorkflow, {
      LINEAR_API_KEY: "test-token",
      LINEAR_PROJECT_SLUG: "test-project",
    });
    const primaryInvestigatePrompt =
      primaryConfig.stages?.stages.investigate?.prompt;
    expect(primaryInvestigatePrompt).toBe("prompts/investigate.liquid");
    const primaryInvestigateTemplate = await readFile(
      resolve(dirname(PIPELINE_WORKFLOW_PATH), primaryInvestigatePrompt!),
      "utf8",
    );
    const primaryInvestigateRendered = await renderPrompt({
      workflow: { promptTemplate: primaryInvestigateTemplate },
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "investigate",
    });
    expect(primaryInvestigateRendered).toContain("Investigation Token Brake");
    expect(primaryInvestigateRendered).toContain("at most 6 shell/tool calls");

    for (const configPath of [
      resolve(import.meta.dirname, "../../pipeline-config/WORKFLOW-staged.md"),
      resolve(
        import.meta.dirname,
        "../../pipeline-config/WORKFLOW-instrumentation.md",
      ),
      resolve(
        import.meta.dirname,
        "../../pipeline-config/templates/WORKFLOW-template.md",
      ),
    ]) {
      const workflowConfig = await loadWorkflowDefinition(configPath);
      const investigateRendered = await renderPrompt({
        workflow: { promptTemplate: workflowConfig.promptTemplate },
        issue: ISSUE_FIXTURE,
        attempt: null,
        stageName: "investigate",
      });
      expect(investigateRendered).toContain("Investigation Token Brake");
      expect(investigateRendered).toContain("at most 6 shell/tool calls");
      expect(investigateRendered).toContain(
        "Risk-Predicate State Contract Artifacts",
      );
      expect(investigateRendered).toContain("state_journal_projection");
      expect(investigateRendered).toContain("risk-contract-artifact: <path>");

      for (const stageName of ["implement", "review", "merge"]) {
        const stageRendered = await renderPrompt({
          workflow: { promptTemplate: workflowConfig.promptTemplate },
          issue: ISSUE_FIXTURE,
          attempt: null,
          stageName,
        });
        expect(stageRendered).not.toContain("Investigation Token Brake");
        expect(stageRendered).not.toContain("at most 6 shell/tool calls");
        expect(stageRendered).not.toContain(
          "Risk-Predicate State Contract Artifacts",
        );
      }
    }
  });

  it("keeps the primary review gate stall budget above the council timeout", async () => {
    const primaryWorkflow = await loadWorkflowDefinition(
      PIPELINE_WORKFLOW_PATH,
    );
    const primaryConfig = resolveWorkflowConfig(primaryWorkflow, {
      LINEAR_API_KEY: "test-token",
      LINEAR_PROJECT_SLUG: "test-project",
    });

    expect(primaryConfig.codex.stallTimeoutMs).toBeGreaterThan(1_800_000);
  });

  it("keeps Resume active in shipped workflow configs", async () => {
    for (const configPath of SHIPPED_CODEX_WORKFLOW_CONFIGS) {
      const workflowConfig = await loadWorkflowDefinition(configPath);
      const resolved = resolveWorkflowConfig(workflowConfig, {
        LINEAR_API_KEY: "test-token",
        LINEAR_PROJECT_SLUG: "test-project",
      });

      expect(resolved.tracker.activeStates).toContain("Resume");
    }
  });

  it("declares canary hard-stop budget rails in shipped workflow configs", async () => {
    const { hardStops } = resolvedConfig;
    expect(hardStops).toBeDefined();
    if (hardStops === undefined) {
      throw new Error("Expected resolved workflow hard stops");
    }

    expect(hardStops.maxTokensPerUnit).toBe(250_000);
    expect(hardStops.maxTokensPerUnit).toBeGreaterThan(
      OBSERVED_CODEX_LOW_FIRST_TURN_TOKENS,
    );
    expect(hardStops.maxDollarBudgetUsd).toBe(12.5);
    expect(hardStops.premiumBudgetPauseRatio).toBe(0.8);

    for (const configPath of RESOLVED_CODEX_WORKFLOW_CONFIGS) {
      const workflowConfig = await loadWorkflowDefinition(configPath);
      const resolved = resolveWorkflowConfig(workflowConfig, {
        LINEAR_API_KEY: "test-token",
        LINEAR_PROJECT_SLUG: "test-project",
      });
      const investigateStage = resolved.stages?.stages.investigate;
      if (investigateStage === undefined) {
        continue;
      }

      expect(investigateStage.hardStops).toEqual(
        EXPECTED_INVESTIGATE_HARD_STOPS,
      );
      expect(investigateStage.hardStops?.maxTokensPerUnit).toBeLessThan(
        OBSERVED_CODEX_LOW_FIRST_TURN_TOKENS,
      );
      for (const stageName of ["implement", "review", "merge"] as const) {
        expect(
          resolved.stages?.stages[stageName]?.hardStops ?? null,
        ).toBeNull();
      }
    }
  });

  it("fast-tracks existing low-risk test labels in the shipped self-host template", () => {
    const fastTrack = resolvedConfig.stages?.fastTrack;

    expect(fastTrack).toEqual({
      label: "trivial",
      labels: ["trivial", "kind:test"],
      initialStage: "implement",
    });
  });

  it("creates bare-clone worker worktrees from refreshed origin/main", async () => {
    const template = await readFile(
      resolve(
        import.meta.dirname,
        "../../pipeline-config/templates/WORKFLOW-template.md",
      ),
      "utf8",
    );

    expect(template).toContain("+refs/heads/*:refs/remotes/origin/*");
    expect(template).toContain(
      "+refs/heads/$BASE_BRANCH:refs/heads/$BASE_BRANCH",
    );
    // SYMPH-372: stale remote-tracking refs are pruned on fetch, and the
    // worktree base is a FULL refname so a poisoned refs/heads/origin/*
    // entry can never make the short name ambiguous (the 2026-06-11
    // incident). Pruning with explicit refspecs only affects the refspec
    // destinations — refs/heads/worktree/* branches are never touched.
    expect(template).toContain("fetch --prune origin");
    expect(template).toContain(
      'WORKTREE_BASE="refs/remotes/origin/$BASE_BRANCH"',
    );
    expect(template).toContain('WORKTREE_BASE="refs/heads/$BASE_BRANCH"');
    expect(template).toContain("poisoned local ref");
    expect(template).toContain(
      'git -C "$BARE_CLONE" worktree add "$WORKSPACE_DIR" -b "$BRANCH_NAME" "$WORKTREE_BASE"',
    );
  });

  it("configures shipped headless workers with workspace network access", async () => {
    for (const configPath of RESOLVED_CODEX_WORKFLOW_CONFIGS) {
      const workflowConfig = await loadWorkflowDefinition(configPath);
      const resolved = resolveWorkflowConfig(workflowConfig, {
        LINEAR_API_KEY: "test-token",
        LINEAR_PROJECT_SLUG: "test-project",
      });

      expect(resolved.codex.approvalPolicy).toBe("never");
      expect(resolved.codex.threadSandbox).toBe("workspace-write");
      expect(resolved.codex.turnSandboxPolicy).toEqual({
        type: "workspace-write",
        network_access: true,
      });
    }
  });

  it("investigate stage contains description and no merge prohibitions", async () => {
    const output = await renderPrompt({
      workflow: { promptTemplate },
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "investigate",
      reworkCount: 0,
    });
    expect(output).toContain(DESCRIPTION_SENTINEL);
    expect(output).not.toMatch(/You MUST NOT/);
  });

  it("implement stage contains description and no merge prohibitions", async () => {
    const output = await renderPrompt({
      workflow: { promptTemplate },
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "implement",
      reworkCount: 0,
    });
    expect(output).toContain(DESCRIPTION_SENTINEL);
    expect(output).not.toMatch(/You MUST NOT/);
  });

  it("implement stage carries the inner verification loop and live-proof contracts (SYMPH-375/377)", async () => {
    const withAcs = await renderPrompt({
      workflow: { promptTemplate },
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "implement",
      reworkCount: 0,
      acceptanceCriteria:
        "### Acceptance Criteria\n- [ ] `check: pnpm lint exits 0`",
    });
    expect(withAcs).toContain("Inner verification loop (SYMPH-375)");
    expect(withAcs).toContain("at most 3 fix-and-rerun attempts");
    expect(withAcs).toContain("Never grade your own `judge:` criteria");
    expect(withAcs).toContain("live-proof: waived");
    expect(withAcs).toContain("live-proof: n/a");
    expect(withAcs).toContain("live-proof: evidence");
    expect(withAcs).toContain("accept an em dash, en dash, or hyphen-minus");
    const acceptedExamples = [
      "live-proof: evidence - <citation>",
      "live-proof: waived – <reason>",
      "live-proof: n/a — <reason>",
    ];
    for (const example of acceptedExamples) {
      expect(withAcs).toContain(`\`${example}\``);
    }
    // Enforcement clauses, not just instruction vocabulary (council R1).
    // The disposition line must reach BOTH council-visible channels (R2):
    expect(withAcs).toContain("BOTH the PR body (append with `gh pr edit");
    expect(withAcs).toContain(
      "live proof is captured or explicitly waived (or stated n/a)",
    );
    expect(withAcs).toContain(
      "`judge:` as `<tag> — judge — <evidence citation>`",
    );
    expect(withAcs).toContain("the bound is per criterion");

    // Without gate-passed ACs the loop contract is absent (nothing to
    // iterate on) but the live-proof contract still applies.
    const withoutAcs = await renderPrompt({
      workflow: { promptTemplate },
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "implement",
      reworkCount: 0,
    });
    expect(withoutAcs).not.toContain("Inner verification loop (SYMPH-375)");
    expect(withoutAcs).toContain("live-proof: waived");
  });

  it("review stage carries the pre-gate evidence check (SYMPH-375/377)", async () => {
    const output = await renderPrompt({
      workflow: { promptTemplate },
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "review",
      reworkCount: 0,
      acceptanceCriteria: "### Acceptance Criteria\n- [ ] `check: x`",
    });
    expect(output).toContain("Pre-gate evidence check");
    // Full-suite criteria defer to CI on the PR head SHA (SYMPH-358/402) —
    // a frozen `check: pnpm test` must not be enforced as a local run.
    expect(output).toContain("CI check-run success on the PR head SHA");
    expect(output).toContain(
      "do NOT fail this check over a red local full-suite log",
    );
    expect(output).toContain("live-proof: waived");
    expect(output).toContain("The PR body carries exactly one live-proof");
    expect(output).toContain("punctuation variants are not evidence failures");
    expect(output).toContain(
      "do not run the council gate on work that skipped its evidence contract",
    );
    // The review completion message must echo the verified disposition —
    // it is the channel the spec-fidelity judge actually reads (R3).
    expect(output).toContain(
      "echoes the live-proof disposition line you verified",
    );
    expect(output).toContain("Review Infrastructure Retry");
    expect(output).toContain("substrate_stall:<lane>");
    expect(output).toContain("Do NOT output `[STAGE_FAILED: review]`");
    expect(output).toContain("parks the issue loudly as infra-blocked");
    expect(output).toContain(
      'reports any other `verdict: "error"` or degraded condition',
    );
    expect(output).toContain("non-PASS review-result");

    // The without-ACs else branch is new code too — render and assert it
    // (council R1: untested Liquid branches are how strictVariables bites).
    const withoutAcs = await renderPrompt({
      workflow: { promptTemplate },
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "review",
      reworkCount: 0,
    });
    expect(withoutAcs).toContain(
      "If the workpad records gate-passed acceptance criteria",
    );
    expect(withoutAcs).toContain("Pre-gate evidence check");
  });

  it("shipped Symphony workflow overlays substrate-stall review routing", async () => {
    const output = await renderPrompt({
      workflow: { promptTemplate },
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "review",
      reworkCount: 0,
    });

    expect(output).toContain("Symphony Review Infrastructure Routing");
    expect(output).toContain('degradedReason: "substrate_stall"');
    expect(output).toContain("## Review Infrastructure Retry");
    expect(output).toContain("[STAGE_FAILED: infra]");
    expect(output).toContain("actual surviving P1/P2 code findings");
    expect(output).toContain('Any other readable `verdict: "error"`');
    expect(output).toContain("Never output `[STAGE_COMPLETE]`");
  });

  it("review stage does NOT contain description", async () => {
    const output = await renderPrompt({
      workflow: { promptTemplate },
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "review",
      reworkCount: 0,
    });
    expect(output).not.toContain(DESCRIPTION_SENTINEL);
    expect(output).toContain("every PR, including low-risk PRs");
    expect(output).toContain(
      "must pass the headless council gate before merge",
    );
    expect(output).toContain("Council is a loop over the merge candidate");
    expect(output).toContain("material post-review change");
    expect(output).toContain("symphony-council-review-gate");
    expect(output).toContain("CMUX_SPAWN_BIN");
    expect(output).toContain("SYMPHONY_COUNCIL_REVIEW_GATE");
    expect(output).toContain("command -v cmux-spawn");
    expect(output).toContain("command -v symphony-council-review-gate");
    expect(output).toContain("run_council_gate");
    expect(output).toContain("--mode full");
    expect(output).toContain("--round 1");
    expect(output).toContain("--timeout-seconds 1800");
    expect(output).toContain("review_metadata.reviewed_head_sha");
    expect(output).toContain("review_metadata.base_sha");
    expect(output).toContain("review_metadata.round");
    expect(output).toContain("review_metadata.mode");
    expect(output).toContain("Claude must run through CMUX");
    expect(output).not.toContain("Build the local CLI");
    expect(output).not.toContain(
      "/Users/ericlitman/projects/crucible/bin/cmux-spawn",
    );
    expect(output).not.toContain("Load and execute the /self-moa-review skill");
    expect(output).not.toContain("issue description contains the frozen spec");
  });

  it("review rework renders convergence mode and incremented round", async () => {
    const output = await renderPrompt({
      workflow: { promptTemplate },
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "review",
      reworkCount: 2,
    });

    expect(output).toContain("### Re-review After Rework (rework #2)");
    expect(output).toContain("--mode convergence");
    expect(output).toContain("--round 3");
  });

  it("merge stage does NOT contain description and HAS prohibitions", async () => {
    const output = await renderPrompt({
      workflow: { promptTemplate },
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "merge",
      reworkCount: 0,
    });
    expect(output).not.toContain(DESCRIPTION_SENTINEL);
    expect(output).toMatch(/MUST NOT/);
    expect(output).toContain("Your ONLY job is to merge the PR");
    expect(output).toContain("--assert-fresh-review");
    expect(output).toContain('code: "stale_review"');
    expect(output).toContain("rerun convergence review against HEAD.");
  });

  it("null stageName renders without error (backward compat)", async () => {
    const output = await renderPrompt({
      workflow: { promptTemplate },
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: null,
      reworkCount: 0,
    });
    expect(output).toBeDefined();
    expect(output.length).toBeGreaterThan(0);
  });

  it("routes generated markdown docs to Linear Docs", async () => {
    const output = await renderPrompt({
      workflow: { promptTemplate },
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "implement",
      reworkCount: 0,
    });

    expect(output).toContain("Put generated markdown docs");
    expect(output).toContain("Linear Docs");
    expect(output).toContain("linear-pp-cli documents create/edit");
    expect(output).toContain("Do not request sandbox, network");
  });

  it("documents eligibility-on-rewrite for ticket rescopes", async () => {
    const output = await renderPrompt({
      workflow: { promptTemplate },
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "implement",
      reworkCount: 0,
    });

    expectEligibilityOnRewriteRule(output);
  });

  it("documents eligibility-on-rewrite in the primary staged implement prompt", async () => {
    const primaryWorkflow = await loadWorkflowDefinition(
      PIPELINE_WORKFLOW_PATH,
    );
    const primaryConfig = resolveWorkflowConfig(primaryWorkflow, {
      LINEAR_API_KEY: "test-token",
      LINEAR_PROJECT_SLUG: "test-project",
    });
    const primaryImplementPrompt =
      primaryConfig.stages?.stages.implement?.prompt;
    expect(primaryImplementPrompt).toBe("prompts/implement.liquid");
    const primaryImplementTemplate = await readFile(
      resolve(dirname(PIPELINE_WORKFLOW_PATH), primaryImplementPrompt!),
      "utf8",
    );
    const output = await renderPrompt({
      workflow: { promptTemplate: primaryImplementTemplate },
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "implement",
      reworkCount: 0,
    });

    expectEligibilityOnRewriteRule(output);
  });
});

function expectEligibilityOnRewriteRule(output: string): void {
  expect(output).toContain("Eligibility on Ticket Rewrite (SYMPH-515)");
  expect(output).toContain("rewrite or rescope a Linear ticket");
  expect(output).toContain(
    "project, state, labels, owner, and dispatch eligibility",
  );
  expect(output).toContain(
    "Pipeline project or another active dispatch surface",
  );
  expect(output).toContain("Council v2 review finding");
  expect(output).toContain(
    '2026-06-12 retro "Review Convergence Discipline for Journal Invariants"',
  );
  expect(output).toContain("SYMPH-321");
}

function isGitIgnored(path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", path], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}
