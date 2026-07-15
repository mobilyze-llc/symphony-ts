import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import {
  renderPrompt,
  resolvePromptPartialRoots,
} from "../../src/agent/prompt-builder.js";
import {
  resolveWorkflowConfig,
  validateDispatchConfig,
} from "../../src/config/config-resolver.js";
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
const WORKFLOW_TEMPLATE_PATH = resolve(
  import.meta.dirname,
  "../../pipeline-config/templates/WORKFLOW-template.md",
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
const SHIPPED_PRODUCT_WORKFLOW_CONFIGS = [
  "../../pipeline-config/workflows/WORKFLOW-healthspanners-ui.md",
  "../../pipeline-config/workflows/WORKFLOW-household.md",
  "../../pipeline-config/workflows/WORKFLOW-hs-dash.md",
  "../../pipeline-config/workflows/WORKFLOW-hs-data.md",
  "../../pipeline-config/workflows/WORKFLOW-hs-mobile.md",
  "../../pipeline-config/workflows/WORKFLOW-jony-agent.md",
  "../../pipeline-config/workflows/WORKFLOW-stickerlabs.md",
  "../../pipeline-config/workflows/WORKFLOW-symphony.md",
  "../../pipeline-config/workflows/WORKFLOW-toys.md",
].map((path) => resolve(import.meta.dirname, path));
// SYMPH-347 minimum queue-opening gate: these product queues were named in
// the gate list and must stay explicitly represented even if the broader
// shipped workflow set changes.
const MINIMUM_QUEUE_GATE_PRODUCT_WORKFLOW_NAMES = new Set([
  "WORKFLOW-household.md",
  "WORKFLOW-hs-dash.md",
  "WORKFLOW-hs-data.md",
  "WORKFLOW-hs-mobile.md",
  "WORKFLOW-jony-agent.md",
  "WORKFLOW-stickerlabs.md",
]);
const REQUIRED_PRODUCT_ACTIVE_STATES = [
  "Todo",
  "In Progress",
  "In Review",
  "Resume",
] as const;
const ELIGIBILITY_ON_REWRITE_PARTIAL_PATH = resolve(
  import.meta.dirname,
  "../../pipeline-config/prompts/eligibility-on-ticket-rewrite.liquid",
);
const ELIGIBILITY_ON_REWRITE_INCLUDE =
  "{% render 'prompts/eligibility-on-ticket-rewrite.liquid' %}";
const EXPECTED_ELIGIBILITY_ON_REWRITE_DIRECTIVE = `## Eligibility on Ticket Rewrite (SYMPH-515)

- If you rewrite or rescope a Linear ticket, the edit is incomplete until you record an explicit eligibility decision in the ticket body, workpad, or edit note.
- Recheck at least project, state, labels, owner, and dispatch eligibility before preserving or changing queue placement.
- Treat a rewritten ticket that remains attached to the Pipeline project or another active dispatch surface without that explicit decision as a Council v2 review finding.
- Incident source: the 2026-06-12 retro "Review Convergence Discipline for Journal Invariants" recorded SYMPH-321 retaining stale Pipeline attachment after its runbook rewrite changed the work semantics.`;
const ELIGIBILITY_ON_REWRITE_INCLUDE_SOURCE_PATHS = [
  "../../pipeline-config/prompts/global.liquid",
  "../../pipeline-config/prompts/investigate.liquid",
  "../../pipeline-config/prompts/implement.liquid",
  "../../pipeline-config/WORKFLOW-staged.md",
  "../../pipeline-config/WORKFLOW-flat.md",
  "../../pipeline-config/WORKFLOW-instrumentation.md",
  "../../pipeline-config/templates/WORKFLOW-template.md",
].map((path) => resolve(import.meta.dirname, path));
const ELIGIBILITY_ON_REWRITE_WORKFLOW_CONFIGS = [
  ...SHIPPED_CODEX_WORKFLOW_CONFIGS,
  ...SHIPPED_PRODUCT_WORKFLOW_CONFIGS,
];
const ELIGIBILITY_ON_REWRITE_STAGES = [
  "investigate",
  "implement",
  "review",
  "merge",
] as const;
const ELIGIBILITY_ON_REWRITE_STANDALONE_PROMPTS = [
  "prompts/global.liquid",
  "prompts/investigate.liquid",
  "prompts/implement.liquid",
] as const;
const PROMPT_TEXT_FILE_EXTENSIONS = new Set([".liquid", ".md"]);
const ELIGIBILITY_ON_REWRITE_UNCOVERED_STANDALONE_SURFACES = [
  {
    stageName: "review",
    prompt: null,
    reason:
      "review uses the workflow root to evaluate PR evidence and council artifacts; it has no standalone stage prompt that can rewrite or rescope tracker work",
  },
  {
    stageName: "merge",
    prompt: "prompts/merge.liquid",
    reason:
      "merge verifies and merges an existing PR; it must not rewrite or rescope tracker work",
  },
] as const;
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
  maxTokensPerUnit: 1_200_000,
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
    expect(resolvedConfig.runner).toEqual({
      kind: "codex",
      model: null,
      provider: null,
    });
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

  it("documents scheduler and per-stage reasoning knobs in the workflow template", async () => {
    const config = await readFile(WORKFLOW_TEMPLATE_PATH, "utf8");

    expect(config).toContain("defer_until_reset: false");
    expect(config).toContain("expected_unit_burn_pct: 1");
    expect(config).toContain("defer_jitter_ms: 30000");
    expect(config).toContain("reasoning_effort: low");
    expect(config).toContain("reasoning_effort: medium");
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
        expect(prompt).not.toContain("at most 6 shell/tool calls");
        expect(prompt).not.toContain("max_output_tokens` of 800 or less");
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
    expect(investigateRendered).not.toContain("at most 6 shell/tool calls");
    expect(investigateRendered).not.toContain(
      "max_output_tokens` of 800 or less",
    );
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
    expect(primaryInvestigateRendered).not.toContain(
      "at most 6 shell/tool calls",
    );
    expect(primaryInvestigateRendered).not.toContain(
      "max_output_tokens` of 800 or less",
    );

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
      expect(investigateRendered).not.toContain("at most 6 shell/tool calls");
      expect(investigateRendered).not.toContain(
        "max_output_tokens` of 800 or less",
      );
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

  it("loads each shipped product workflow and covers runtime active states (SYMPH-347)", async () => {
    const workflowDirectory = resolve(
      import.meta.dirname,
      "../../pipeline-config/workflows",
    );
    const discoveredWorkflowConfigs = (await readdir(workflowDirectory))
      .filter((entry) => /^WORKFLOW-.+\.md$/.test(entry))
      .map((entry) => resolve(workflowDirectory, entry))
      .sort();
    const expectedWorkflowConfigs = [
      ...SHIPPED_PRODUCT_WORKFLOW_CONFIGS,
    ].sort();
    const discoveredWorkflowNames = new Set(
      discoveredWorkflowConfigs.map((path) => path.split("/").at(-1)),
    );

    expect(discoveredWorkflowConfigs).toEqual(expectedWorkflowConfigs);
    for (const workflowName of MINIMUM_QUEUE_GATE_PRODUCT_WORKFLOW_NAMES) {
      expect(discoveredWorkflowNames.has(workflowName)).toBe(true);
    }

    const seenProjectSlugs = new Set<string>();
    const seenTeamScopes = new Set<string>();
    const seenPorts = new Set<number>();

    for (const configPath of discoveredWorkflowConfigs) {
      const workflowConfig = await loadWorkflowDefinition(configPath);
      const resolved = resolveWorkflowConfig(workflowConfig, {
        LINEAR_API_KEY: "test-token",
        LOCAL_LLM_API_KEY: "test-local-token",
      });

      expect(validateDispatchConfig(resolved, { hostname: "pro14" })).toEqual({
        ok: true,
      });
      // SYMPH-840: a shipped workflow is validly scoped by EITHER a unique 12-char
      // project slug (legacy) OR a non-empty team_keys list (team-scoped backlog,
      // SYMPH-794/819). validateDispatchConfig above already enforces the either/or;
      // assert slug shape + uniqueness for project-scoped workflows, and a null slug
      // + unique team scope for team-scoped ones (two workflows sharing a team is the
      // SYMPH-383 single-homing race vector that the slug-uniqueness check guarded).
      const teamKeys = resolved.tracker.teamKeys ?? [];
      if (teamKeys.length > 0) {
        expect(resolved.tracker.projectSlug).toBeNull();
        const teamScope = [...teamKeys].sort().join(",");
        expect(seenTeamScopes.has(teamScope)).toBe(false);
        seenTeamScopes.add(teamScope);
      } else {
        expect(resolved.tracker.projectSlug).toMatch(/^[a-z0-9]{12}$/);
        expect(resolved.tracker.projectSlug).not.toBe(
          "<YOUR_PROJECT_SLUG_HERE>",
        );
        expect(seenProjectSlugs.has(resolved.tracker.projectSlug!)).toBe(false);
        seenProjectSlugs.add(resolved.tracker.projectSlug!);
      }

      expect(resolved.server.port).not.toBeNull();
      expect(seenPorts.has(resolved.server.port!)).toBe(false);
      seenPorts.add(resolved.server.port!);

      expect(resolved.tracker.activeStates).toEqual(
        REQUIRED_PRODUCT_ACTIVE_STATES,
      );
      expect(resolved.escalationState).toBe("Blocked");
      expect(resolved.tracker.activeStates).not.toContain("Blocked");

      const stages = resolved.stages;
      expect(stages).not.toBeNull();
      if (stages === null) {
        throw new Error(`Expected staged workflow for ${configPath}`);
      }

      for (const [stageName, stage] of Object.entries(stages.stages)) {
        if (stage.type === "terminal") {
          expect(stage.linearState).not.toBeNull();
          expect(resolved.tracker.terminalStates).toContain(stage.linearState);
          expect(resolved.tracker.activeStates).not.toContain(
            stage.linearState!,
          );
          continue;
        }

        if (stage.linearState === null) {
          continue;
        }
        expect(resolved.tracker.activeStates).toContain(stage.linearState);
        expect(resolved.tracker.terminalStates).not.toContain(
          stage.linearState!,
        );
        expect(stageName).not.toBe("");
      }
    }
  });

  it("declares canary hard-stop budget rails in shipped workflow configs", async () => {
    const { hardStops } = resolvedConfig;
    expect(hardStops).toBeDefined();
    if (hardStops === undefined) {
      throw new Error("Expected resolved workflow hard stops");
    }

    expect(hardStops.maxTokensPerUnit).toBe(1_500_000);
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
      expect(investigateStage.hardStops?.maxTokensPerUnit).toBeGreaterThan(
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
      "do not admit the crabrunner review job group on work that skipped its evidence contract",
    );
    // The review completion message must echo the verified disposition —
    // it is the channel the spec-fidelity judge actually reads (R3).
    expect(output).toContain(
      "echoes the live-proof disposition line you verified",
    );
    expect(output).toContain("Review Infrastructure Retry");
    expect(output).toContain("substrate_stall:<lane>");
    expect(output).toContain("routing_author_provenance_missing");
    expect(output).toContain("review procedure/provenance stop");
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
    expect(output).toContain("routing_author_provenance_missing");
    expect(output).toContain("procedure/provenance stop");
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
    expect(output).toContain("crabrunner-backed review job group");
    expect(output).toContain("registered crabrunner stage backend");
    expect(output).toContain("Crabrunner Review Dispatch");
    expect(output).toContain("full mode for round 1");
    expect(output).toContain(
      "[REVIEW_GATE_RESULT_PATH: <artifact-dir>/review-result.json]",
    );
    expect(output).toContain("review_metadata.reviewed_head_sha");
    expect(output).toContain("review_metadata.base_sha");
    expect(output).toContain("review_metadata.round");
    expect(output).toContain("review_metadata.mode");
    expect(output).toContain("review_routing.decorrelationBasis.mergeEligible");
    expect(output).toContain("review_metadata.decorrelation_merge_eligible");
    expect(output).not.toContain("symphony-council-review-gate");
    expect(output).not.toContain("CMUX_SPAWN_BIN");
    expect(output).not.toContain("SYMPHONY_COUNCIL_REVIEW_GATE");
    expect(output).not.toContain("command -v cmux-spawn");
    expect(output).not.toContain("command -v symphony-council-review-gate");
    expect(output).not.toContain("run_council_gate");
    expect(output).not.toContain("Claude must run through CMUX");
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
    expect(output).toContain("convergence mode");
    expect(output).toContain("round 3");
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
    expect(output).toContain("result.review_metadata?.reviewed_head_sha");
    expect(output).toContain("decorrelationBasis?.mergeEligible");
    expect(output).toContain("decorrelation_merge_eligible");
    expect(output).toContain("If this check fails, do NOT merge");
    expect(output).not.toContain("--assert-fresh-review");
    expect(output).not.toContain("symphony-council-review-gate");
    expect(output).toContain(
      "gh pr view --json number,state,isDraft,mergeStateStatus,mergeable,reviewDecision,statusCheckRollup",
    );
    expect(output).toContain("state,mergedAt,mergeCommit");
    expect(output).toContain("mergedAt");
    expect(output).toContain("Do not use `gh pr checks --watch`");
    expect(output).toContain("queued/waiting");
    expect(output).toContain("merge_queue_pending");
    // SYMPH-645: the post-enqueue wait names a concrete, falsifiable cadence +
    // bound, not just "keep waiting" — rendered via the symphony base template.
    expect(output).toContain(
      "wait 30s before the first re-check, then 60s, then 120s, capping the interval at 300s between checks",
    );
    expect(output).not.toContain("gh pr checks --watch --required --fail-fast");
    expect(output).toContain("[BLOCKED_NEEDS_HUMAN_BLOCKERS:");
    expect(output).toContain("auto_merge_permission_denied");
  });

  it("executes the rendered merge freshness script against real review artifacts", async () => {
    const output = await renderPrompt({
      workflow: { promptTemplate },
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "merge",
      reworkCount: 0,
    });
    const script = extractMergeFreshnessScript(output);
    const tempRoot = await mkdtemp(join(tmpdir(), "symphony-review-gate-"));

    try {
      const head = "abc123";
      const reviewResultPath = join(tempRoot, "review-result.json");
      await writeFile(
        reviewResultPath,
        JSON.stringify({
          verdict: "pass",
          review_metadata: {
            reviewed_head_sha: head,
          },
          review_routing: {
            decorrelationBasis: {
              mergeEligible: true,
            },
          },
        }),
        "utf8",
      );

      const stdout = execFileSync(
        process.execPath,
        ["-e", script, reviewResultPath, head],
        { encoding: "utf8" },
      );
      expect(JSON.parse(stdout)).toMatchObject({
        ok: true,
        code: "fresh",
        verdict: "pass",
        head,
      });

      await writeFile(
        reviewResultPath,
        JSON.stringify({
          verdict: "pass",
          review_metadata: {
            reviewed_head_sha: head,
            decorrelation_merge_eligible: true,
          },
        }),
        "utf8",
      );
      expect(
        JSON.parse(
          execFileSync(
            process.execPath,
            ["-e", script, reviewResultPath, head],
            {
              encoding: "utf8",
            },
          ),
        ),
      ).toMatchObject({
        ok: true,
        code: "fresh",
        verdict: "pass",
        head,
      });

      await writeFile(
        reviewResultPath,
        JSON.stringify({
          verdict: "pass",
          review_metadata: {
            reviewed_head_sha: head,
            decorrelation_merge_eligible: true,
          },
          review_routing: {
            decorrelationBasis: {
              mergeEligible: false,
            },
          },
        }),
        "utf8",
      );

      expect(() =>
        execFileSync(process.execPath, ["-e", script, reviewResultPath, head]),
      ).toThrow();

      await writeFile(
        reviewResultPath,
        JSON.stringify({
          verdict: "pass",
          review_metadata: {
            reviewed_head_sha: head,
          },
        }),
        "utf8",
      );
      expect(() =>
        execFileSync(process.execPath, ["-e", script, reviewResultPath, head]),
      ).toThrow();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps the merge freshness script in sync across partial and template surfaces", async () => {
    const primaryWorkflow = await loadWorkflowDefinition(
      PIPELINE_WORKFLOW_PATH,
    );
    const primaryConfig = resolveWorkflowConfig(primaryWorkflow, {
      LINEAR_API_KEY: "test-token",
      LINEAR_PROJECT_SLUG: "test-project",
    });
    const mergePrompt = primaryConfig.stages?.stages.merge?.prompt;
    expect(mergePrompt).not.toBeNull();

    const mergeLiquid = await readFile(
      resolve(dirname(PIPELINE_WORKFLOW_PATH), mergePrompt!),
      "utf8",
    );
    const template = await readFile(WORKFLOW_TEMPLATE_PATH, "utf8");
    const renderInput = {
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "merge",
      reworkCount: 0,
    } as const;
    const mergeLiquidOutput = await renderPrompt({
      workflow: { promptTemplate: mergeLiquid },
      ...renderInput,
    });
    const templateOutput = await renderPrompt({
      workflow: { promptTemplate: template },
      ...renderInput,
    });

    expect(
      normalizeMergeFreshnessScript(
        extractMergeFreshnessScript(mergeLiquidOutput),
      ),
    ).toBe(
      normalizeMergeFreshnessScript(
        extractMergeFreshnessScript(templateOutput),
      ),
    );
  });

  it("names a bounded merge-queue polling cadence across every merge surface (SYMPH-645)", async () => {
    const cadence =
      "wait 30s before the first re-check, then 60s, then 120s, capping the interval at 300s between checks";

    // Standalone partial rendered by the primary pipeline-config/WORKFLOW.md
    // merge stage (asserted directly so removing it from the partial fails).
    const mergeLiquid = await readFile(
      resolve(
        import.meta.dirname,
        "../../pipeline-config/prompts/merge.liquid",
      ),
      "utf8",
    );
    expect(mergeLiquid).toContain(cadence);
    // The cadence terminates into the existing pending marker, never a tight loop.
    expect(mergeLiquid).toContain("merge_queue_pending");

    // Inline merge surfaces must stay in sync so the cadence cannot silently
    // drift out of one rendered worker prompt.
    for (const configPath of [
      "../../pipeline-config/templates/WORKFLOW-template.md",
      "../../pipeline-config/WORKFLOW-staged.md",
      "../../pipeline-config/WORKFLOW-instrumentation.md",
    ].map((path) => resolve(import.meta.dirname, path))) {
      expect(await readFile(configPath, "utf8")).toContain(cadence);
    }
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

  it("keeps eligibility-on-rewrite in one inspectable prompt partial", async () => {
    const directive = (
      await readFile(ELIGIBILITY_ON_REWRITE_PARTIAL_PATH, "utf8")
    ).trim();
    expect(directive).toBe(EXPECTED_ELIGIBILITY_ON_REWRITE_DIRECTIVE);

    const filesWithDirective = await findFilesContaining(
      resolve(REPO_ROOT, "pipeline-config"),
      "If you rewrite or rescope a Linear ticket",
    );
    expect(filesWithDirective).toEqual([
      "pipeline-config/prompts/eligibility-on-ticket-rewrite.liquid",
    ]);

    for (const sourcePath of ELIGIBILITY_ON_REWRITE_INCLUDE_SOURCE_PATHS) {
      expect(await readFile(sourcePath, "utf8")).toContain(
        ELIGIBILITY_ON_REWRITE_INCLUDE,
      );
    }
  });

  it("renders eligibility-on-rewrite in primary file-backed rewrite prompt surfaces", async () => {
    const primaryWorkflow = await loadWorkflowDefinition(
      PIPELINE_WORKFLOW_PATH,
    );
    const primaryConfig = resolveWorkflowConfig(primaryWorkflow, {
      LINEAR_API_KEY: "test-token",
      LINEAR_PROJECT_SLUG: "test-project",
    });

    const promptFiles = [
      ELIGIBILITY_ON_REWRITE_STANDALONE_PROMPTS[0],
      primaryConfig.stages?.stages.investigate?.prompt,
      primaryConfig.stages?.stages.implement?.prompt,
    ];

    expect(promptFiles).toEqual([...ELIGIBILITY_ON_REWRITE_STANDALONE_PROMPTS]);

    const directive = (
      await readFile(ELIGIBILITY_ON_REWRITE_PARTIAL_PATH, "utf8")
    ).trim();

    for (const promptFile of promptFiles) {
      expect(promptFile).toBeDefined();
      const template = await readFile(
        resolve(dirname(PIPELINE_WORKFLOW_PATH), promptFile!),
        "utf8",
      );
      const output = await renderPrompt({
        workflow: { promptTemplate: template },
        issue: ISSUE_FIXTURE,
        attempt: null,
        stageName: promptFile!.includes("investigate")
          ? "investigate"
          : "implement",
        reworkCount: 0,
      });

      expectEligibilityOnRewriteRule(output, directive);
    }
  });

  it("renders eligibility-on-rewrite through every shipped workflow root", async () => {
    const directive = (
      await readFile(ELIGIBILITY_ON_REWRITE_PARTIAL_PATH, "utf8")
    ).trim();

    for (const configPath of ELIGIBILITY_ON_REWRITE_WORKFLOW_CONFIGS) {
      const workflowConfig = await loadWorkflowDefinition(configPath);

      for (const stageName of ELIGIBILITY_ON_REWRITE_STAGES) {
        const output = await renderPrompt({
          workflow: { promptTemplate: workflowConfig.promptTemplate },
          issue: ISSUE_FIXTURE,
          attempt: null,
          stageName,
          reworkCount: 0,
        });

        expectEligibilityOnRewriteRule(output, directive);
      }
    }
  });

  it("resolves eligibility-on-rewrite partials from the explicit workflow path", async () => {
    const alternateRoot = await mkdtemp(
      join(tmpdir(), "symphony-prompt-root-"),
    );
    try {
      const pipelineConfigDirectory = join(alternateRoot, "pipeline-config");
      const promptsDirectory = join(pipelineConfigDirectory, "prompts");
      const workflowPath = join(pipelineConfigDirectory, "WORKFLOW.md");
      const directive = "Temp workflow-root eligibility directive";
      await mkdir(promptsDirectory, { recursive: true });
      await writeFile(
        join(promptsDirectory, "eligibility-on-ticket-rewrite.liquid"),
        directive,
        "utf8",
      );

      const output = await renderPrompt({
        workflow: {
          promptTemplate:
            "{% render 'prompts/eligibility-on-ticket-rewrite.liquid' %}",
          workflowPath,
        },
        issue: ISSUE_FIXTURE,
        attempt: null,
        stageName: "implement",
        reworkCount: 0,
      });

      expect(output.trim()).toBe(directive);
    } finally {
      await rm(alternateRoot, { recursive: true, force: true });
    }
  });

  it("normalizes relative workflow paths before resolving partial roots", () => {
    const roots = resolvePromptPartialRoots("pipeline-config/WORKFLOW.md");

    expect(roots).toContain(resolve(REPO_ROOT, "pipeline-config"));
    expect(roots).toContain(REPO_ROOT);
    expect(roots).not.toContain(
      resolve(REPO_ROOT, "pipeline-config", "pipeline-config"),
    );
  });

  it("uses the nearest exact pipeline-config ancestor for nested workflow paths", () => {
    const nestedPipelineConfigDirectory = resolve(
      REPO_ROOT,
      "scratch",
      "pipeline-config",
      "copies",
      "pipeline-config",
    );
    const workflowDirectory = resolve(
      nestedPipelineConfigDirectory,
      "variants",
      "deep",
    );
    const roots = resolvePromptPartialRoots(
      join(workflowDirectory, "WORKFLOW.md"),
    );

    expect(roots).toEqual([
      workflowDirectory,
      nestedPipelineConfigDirectory,
      dirname(nestedPipelineConfigDirectory),
    ]);
    expect(roots).not.toContain(resolve(REPO_ROOT, "pipeline-config"));
  });

  it("uses workflow-local partial roots for deeply nested paths without a pipeline-config ancestor", () => {
    const workflowDirectory = resolve(
      REPO_ROOT,
      "scratch",
      "workflow-copies",
      "customers",
      "example",
      "staged",
      "deep",
    );
    const roots = resolvePromptPartialRoots(
      join(workflowDirectory, "WORKFLOW.md"),
    );

    expect(roots).toEqual([
      workflowDirectory,
      resolve(workflowDirectory, "pipeline-config"),
    ]);
    expect(roots).not.toContain(resolve(REPO_ROOT, "pipeline-config"));
    expect(roots).not.toContain(REPO_ROOT);
  });

  it("does not treat pipeline-config-prefixed directories as pipeline-config", () => {
    const roots = resolvePromptPartialRoots("pipeline-config-v2/WORKFLOW.md");

    expect(roots).toContain(resolve(REPO_ROOT, "pipeline-config-v2"));
    expect(roots).toContain(
      resolve(REPO_ROOT, "pipeline-config-v2", "pipeline-config"),
    );
    expect(roots).not.toContain(resolve(REPO_ROOT, "pipeline-config"));
    expect(roots).not.toContain(REPO_ROOT);
  });

  it("documents intentionally uncovered standalone review and merge prompt surfaces", async () => {
    const primaryWorkflow = await loadWorkflowDefinition(
      PIPELINE_WORKFLOW_PATH,
    );
    const primaryConfig = resolveWorkflowConfig(primaryWorkflow, {
      LINEAR_API_KEY: "test-token",
      LINEAR_PROJECT_SLUG: "test-project",
    });
    const directive = (
      await readFile(ELIGIBILITY_ON_REWRITE_PARTIAL_PATH, "utf8")
    ).trim();

    expect(primaryConfig.stages?.stages.review?.prompt ?? null).toBe(
      ELIGIBILITY_ON_REWRITE_UNCOVERED_STANDALONE_SURFACES[0].prompt,
    );
    expect(
      ELIGIBILITY_ON_REWRITE_UNCOVERED_STANDALONE_SURFACES[0].reason,
    ).toContain("no standalone stage prompt");

    const mergePrompt =
      ELIGIBILITY_ON_REWRITE_UNCOVERED_STANDALONE_SURFACES[1].prompt;
    expect(primaryConfig.stages?.stages.merge?.prompt).toBe(mergePrompt);
    expect(
      ELIGIBILITY_ON_REWRITE_UNCOVERED_STANDALONE_SURFACES[1].reason,
    ).toContain("must not rewrite or rescope tracker work");
    expect(mergePrompt).not.toBeNull();

    const mergeTemplate = await readFile(
      resolve(dirname(PIPELINE_WORKFLOW_PATH), mergePrompt!),
      "utf8",
    );
    expect(mergeTemplate).not.toContain(ELIGIBILITY_ON_REWRITE_INCLUDE);
    expect(mergeTemplate).not.toContain(directive);
  });
});

function expectEligibilityOnRewriteRule(
  output: string,
  directive: string,
): void {
  expect(output).toContain(directive);
  expect(countOccurrences(output, directive)).toBe(1);
}

function countOccurrences(output: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }

  let count = 0;
  let index = output.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = output.indexOf(needle, index + needle.length);
  }
  return count;
}

function extractMergeFreshnessScript(output: string): string {
  const match = output.match(
    /node -e '\n(?<script>[\s\S]*?)\n\s*' "\$REVIEW_RESULT_PATH" "\$HEAD_SHA"/,
  );
  const script = match?.groups?.script;
  if (script === undefined) {
    throw new Error(
      "Expected rendered merge prompt to contain node freshness script",
    );
  }
  return script;
}

function normalizeMergeFreshnessScript(script: string): string {
  return script
    .split("\n")
    .map((line) => line.trimStart())
    .join("\n")
    .trim();
}

async function findFilesContaining(
  directoryPath: string,
  needle: string,
): Promise<string[]> {
  const matches: string[] = [];

  async function visit(currentDirectoryPath: string): Promise<void> {
    const entries = await readdir(currentDirectoryPath, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const entryPath = resolve(currentDirectoryPath, entry.name);
      if (entry.isDirectory()) {
        if (PROMPT_SEARCH_SKIPPED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!PROMPT_TEXT_FILE_EXTENSIONS.has(extname(entry.name))) {
        continue;
      }
      const contents = await readFile(entryPath, "utf8");
      if (contents.includes(needle)) {
        matches.push(relative(REPO_ROOT, entryPath));
      }
    }
  }

  await visit(directoryPath);
  return matches.sort();
}

const PROMPT_SEARCH_SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".symphony",
  ".worktrees",
  "coverage",
  "design-refs",
  "dist",
  "node_modules",
  "workspaces",
  "worktrees",
]);

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
