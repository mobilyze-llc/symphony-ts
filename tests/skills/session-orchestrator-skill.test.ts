import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SKILL_DIR = resolve(__dirname, "../../skills/session-orchestrator");
const DISCOVERY_DIR = resolve(
  __dirname,
  "../../.agents/skills/session-orchestrator",
);
const GLOBAL_SKILL_PATH = resolve(
  homedir(),
  ".codex/skills/session-orchestrator/SKILL.md",
);
const SKILL_PATH = resolve(SKILL_DIR, "SKILL.md");
const REVIEW_EVIDENCE_CHECKPOINT = resolve(
  SKILL_DIR,
  "scripts/assert-review-evidence-checkpoint.mjs",
);
const workerPrompts = readFileSync(
  resolve(SKILL_DIR, "references/worker-prompts.md"),
  "utf-8",
);
const decisionBrief = readFileSync(
  resolve(SKILL_DIR, "references/operator-decision-brief.md"),
  "utf-8",
);
const skillContent = readFileSync(SKILL_PATH, "utf-8");
const openaiMetadata = readFileSync(
  resolve(SKILL_DIR, "agents/openai.yaml"),
  "utf-8",
);
const validationScript = readFileSync(
  resolve(__dirname, "../../scripts/validate-skill-installs.mjs"),
  "utf-8",
);
const oldDisplayName = ["Symphony", "Session", "Orchestrator"].join(" ");
const packageJson = JSON.parse(
  readFileSync(resolve(__dirname, "../../package.json"), "utf-8"),
) as { scripts?: Record<string, string> };
const HEAD_SHA = "1111111111111111111111111111111111111111";

function runReviewEvidenceCheckpoint(args: string[]) {
  return spawnSync(process.execPath, [REVIEW_EVIDENCE_CHECKPOINT, ...args], {
    encoding: "utf8",
  });
}

describe("session-orchestrator skill", () => {
  it("has trigger metadata for temporary Symphony session orchestration work", () => {
    expect(skillContent).toMatch(/^name: session-orchestrator$/m);
    expect(skillContent).toMatch(/orchestration sessions/i);
    expect(skillContent).toMatch(/queue-clearing waves/i);
    expect(skillContent).toMatch(/cap-hit synthesis/i);
    expect(skillContent).toMatch(/backlog normalization/i);
  });

  it("uses the current session-orchestrator display name everywhere user-facing", () => {
    expect(skillContent).toContain("# Session Orchestrator");
    expect(skillContent).not.toContain(`# ${oldDisplayName}`);
    expect(workerPrompts).toContain("# Session Orchestrator Worker Prompts");
    expect(workerPrompts).not.toContain(`# ${oldDisplayName} Worker Prompts`);
    expect(openaiMetadata).toContain('display_name: "Session Orchestrator"');
    expect(openaiMetadata).toContain(
      'default_prompt: "Use $session-orchestrator',
    );
    expect(openaiMetadata).not.toContain(`display_name: "${oldDisplayName}"`);
  });

  it("is exposed through the repo-local Codex discovery root", () => {
    expect(existsSync(DISCOVERY_DIR)).toBe(true);
    expect(lstatSync(DISCOVERY_DIR).isSymbolicLink()).toBe(true);
    expect(realpathSync(DISCOVERY_DIR)).toBe(realpathSync(SKILL_DIR));
    expect(existsSync(resolve(DISCOVERY_DIR, "SKILL.md"))).toBe(true);
  });

  it("keeps the global Codex skill location empty", () => {
    expect(existsSync(GLOBAL_SKILL_PATH)).toBe(false);
  });

  it("has a validation script for repo, user-level, and global skill drift", () => {
    expect(validationScript).toContain('"session-orchestrator"');
    expect(validationScript).toContain(".agents/skills");
    expect(validationScript).toContain('"spec-review-lane"');
    expect(validationScript).toContain('"claude-runner"');
    expect(validationScript).toContain('"cmux-spawn"');
    expect(validationScript).toContain("SYMPHONY_CMUX_SPAWN_SKILL_SOURCE");
    expect(validationScript).toContain("~/.agents/skills/<name>");
    expect(validationScript).toContain("--user-installs");
    expect(validationScript).toContain(".codex/skills");
    expect(validationScript).toContain(".claude/skills");
    expect(validationScript).toContain(
      "Canonical source: repo-local skills/<name>/SKILL.md",
    );
    expect(validationScript).toContain("machine-scoped");
    expect(validationScript).toContain("active global copy");
    expect(validationScript).toContain("single discovered source of truth");
    expect(validationScript).toContain("symphony-claude-runner");
  });

  it("validates required user-level symlink installs without using the real home directory", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "skill-install-contract-"));
    try {
      const repoRoot = resolve(tempDir, "repo");
      const userSkillsRoot = resolve(tempDir, "home/.agents/skills");
      const codexSkillsRoot = resolve(tempDir, "home/.codex/skills");
      const claudeSkillsRoot = resolve(tempDir, "home/.claude/skills");
      const cmuxSpawnSource = resolve(
        tempDir,
        "claude-config/skills/cmux-spawn",
      );
      mkdirSync(resolve(repoRoot, "skills"), { recursive: true });
      mkdirSync(resolve(repoRoot, ".agents/skills"), { recursive: true });
      mkdirSync(userSkillsRoot, { recursive: true });
      mkdirSync(codexSkillsRoot, { recursive: true });
      mkdirSync(claudeSkillsRoot, { recursive: true });
      mkdirSync(cmuxSpawnSource, { recursive: true });
      writeFileSync(
        resolve(cmuxSpawnSource, "SKILL.md"),
        "---\nname: cmux-spawn\n---\n",
      );

      for (const skillName of [
        "session-orchestrator",
        "spec-review-lane",
        "claude-runner",
      ]) {
        const skillDir = resolve(repoRoot, "skills", skillName);
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(
          resolve(skillDir, "SKILL.md"),
          `---\nname: ${skillName}\n---\n`,
        );
        symlinkSync(
          `../../skills/${skillName}`,
          resolve(repoRoot, ".agents/skills", skillName),
        );
        symlinkSync(skillDir, resolve(userSkillsRoot, skillName));
      }
      symlinkSync(cmuxSpawnSource, resolve(userSkillsRoot, "cmux-spawn"));

      const output = execFileSync(
        process.execPath,
        [
          resolve(__dirname, "../../scripts/validate-skill-installs.mjs"),
          "--user-installs",
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            SYMPHONY_SKILL_REPO_ROOT: repoRoot,
            SYMPHONY_STABLE_ROOT: repoRoot,
            SYMPHONY_USER_SKILLS_DIR: userSkillsRoot,
            SYMPHONY_CODEX_SKILLS_DIR: codexSkillsRoot,
            SYMPHONY_CLAUDE_SKILLS_DIR: claudeSkillsRoot,
            SYMPHONY_CMUX_SPAWN_SKILL_SOURCE: cmuxSpawnSource,
          },
        },
      );

      expect(JSON.parse(output)).toMatchObject({
        ok: true,
        requireUserInstalls: true,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("warns by default and fails enforcement on byte-divergent user-level skill copies", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "skill-install-copy-drift-"));
    try {
      const repoRoot = resolve(tempDir, "repo");
      const userSkillsRoot = resolve(tempDir, "home/.agents/skills");
      const codexSkillsRoot = resolve(tempDir, "home/.codex/skills");
      const claudeSkillsRoot = resolve(tempDir, "home/.claude/skills");
      const cmuxSpawnSource = resolve(
        tempDir,
        "claude-config/skills/cmux-spawn",
      );
      mkdirSync(resolve(repoRoot, "skills"), { recursive: true });
      mkdirSync(resolve(repoRoot, ".agents/skills"), { recursive: true });
      mkdirSync(userSkillsRoot, { recursive: true });
      mkdirSync(codexSkillsRoot, { recursive: true });
      mkdirSync(claudeSkillsRoot, { recursive: true });
      mkdirSync(cmuxSpawnSource, { recursive: true });
      writeFileSync(
        resolve(cmuxSpawnSource, "SKILL.md"),
        "---\nname: cmux-spawn\n---\n",
      );

      for (const skillName of [
        "session-orchestrator",
        "spec-review-lane",
        "claude-runner",
      ]) {
        const skillDir = resolve(repoRoot, "skills", skillName);
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(
          resolve(skillDir, "SKILL.md"),
          `---\nname: ${skillName}\n---\ncanonical\n`,
        );
        symlinkSync(
          `../../skills/${skillName}`,
          resolve(repoRoot, ".agents/skills", skillName),
        );
        symlinkSync(skillDir, resolve(userSkillsRoot, skillName));
      }
      symlinkSync(cmuxSpawnSource, resolve(userSkillsRoot, "cmux-spawn"));

      rmSync(resolve(userSkillsRoot, "session-orchestrator"));
      mkdirSync(resolve(userSkillsRoot, "session-orchestrator"));
      writeFileSync(
        resolve(userSkillsRoot, "session-orchestrator/SKILL.md"),
        "---\nname: session-orchestrator\n---\nstale copy\n",
      );

      const script = resolve(
        __dirname,
        "../../scripts/validate-skill-installs.mjs",
      );
      const env = {
        ...process.env,
        SYMPHONY_SKILL_REPO_ROOT: repoRoot,
        SYMPHONY_STABLE_ROOT: repoRoot,
        SYMPHONY_USER_SKILLS_DIR: userSkillsRoot,
        SYMPHONY_CODEX_SKILLS_DIR: codexSkillsRoot,
        SYMPHONY_CLAUDE_SKILLS_DIR: claudeSkillsRoot,
        SYMPHONY_CMUX_SPAWN_SKILL_SOURCE: cmuxSpawnSource,
      };

      const warnOutput = execFileSync(process.execPath, [script], {
        encoding: "utf8",
        env,
      });
      expect(JSON.parse(warnOutput)).toMatchObject({
        ok: true,
        requireUserInstalls: false,
        warnings: [expect.stringContaining("byte-divergent SKILL.md")],
      });

      try {
        execFileSync(process.execPath, [script, "--user-installs"], {
          encoding: "utf8",
          env,
        });
        throw new Error("Expected user-install enforcement to fail");
      } catch (error) {
        const stderr =
          typeof error === "object" &&
          error !== null &&
          "stderr" in error &&
          Buffer.isBuffer(error.stderr)
            ? error.stderr.toString("utf8")
            : error instanceof Error
              ? error.message
              : String(error);
        expect(stderr).toContain("session-orchestrator");
        expect(stderr).toContain("not a symlink");
        expect(stderr).toContain("byte-divergent SKILL.md");
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("discovers the stable main worktree for user-level install targets", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "skill-install-main-"));
    try {
      const stableRoot = resolve(tempDir, "stable");
      const featureRoot = resolve(tempDir, "feature");
      const userSkillsRoot = resolve(tempDir, "home/.agents/skills");
      const codexSkillsRoot = resolve(tempDir, "home/.codex/skills");
      const claudeSkillsRoot = resolve(tempDir, "home/.claude/skills");
      const cmuxSpawnSource = resolve(
        tempDir,
        "claude-config/skills/cmux-spawn",
      );

      execFileSync("git", ["init", "--initial-branch=main", stableRoot]);
      execFileSync("git", [
        "-C",
        stableRoot,
        "config",
        "user.email",
        "test@example.com",
      ]);
      execFileSync("git", [
        "-C",
        stableRoot,
        "config",
        "user.name",
        "Test User",
      ]);
      writeFileSync(resolve(stableRoot, "README.md"), "fixture\n");
      execFileSync("git", ["-C", stableRoot, "add", "README.md"]);
      execFileSync("git", ["-C", stableRoot, "commit", "-m", "fixture"]);
      execFileSync("git", [
        "-C",
        stableRoot,
        "worktree",
        "add",
        "-b",
        "feature",
        featureRoot,
      ]);

      mkdirSync(resolve(featureRoot, ".agents/skills"), { recursive: true });
      mkdirSync(userSkillsRoot, { recursive: true });
      mkdirSync(codexSkillsRoot, { recursive: true });
      mkdirSync(claudeSkillsRoot, { recursive: true });
      mkdirSync(cmuxSpawnSource, { recursive: true });
      writeFileSync(
        resolve(cmuxSpawnSource, "SKILL.md"),
        "---\nname: cmux-spawn\n---\n",
      );

      for (const skillName of [
        "session-orchestrator",
        "spec-review-lane",
        "claude-runner",
      ]) {
        for (const root of [stableRoot, featureRoot]) {
          const skillDir = resolve(root, "skills", skillName);
          mkdirSync(skillDir, { recursive: true });
          writeFileSync(
            resolve(skillDir, "SKILL.md"),
            `---\nname: ${skillName}\n---\n`,
          );
        }
        symlinkSync(
          `../../skills/${skillName}`,
          resolve(featureRoot, ".agents/skills", skillName),
        );
        symlinkSync(
          resolve(stableRoot, "skills", skillName),
          resolve(userSkillsRoot, skillName),
        );
      }
      symlinkSync(cmuxSpawnSource, resolve(userSkillsRoot, "cmux-spawn"));

      const output = execFileSync(
        process.execPath,
        [
          resolve(__dirname, "../../scripts/validate-skill-installs.mjs"),
          "--user-installs",
        ],
        {
          cwd: featureRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            SYMPHONY_SKILL_REPO_ROOT: featureRoot,
            SYMPHONY_USER_SKILLS_DIR: userSkillsRoot,
            SYMPHONY_CODEX_SKILLS_DIR: codexSkillsRoot,
            SYMPHONY_CLAUDE_SKILLS_DIR: claudeSkillsRoot,
            SYMPHONY_CMUX_SPAWN_SKILL_SOURCE: cmuxSpawnSource,
          },
        },
      );

      const result = JSON.parse(output) as { ok: boolean; stableRoot: string };
      expect(result).toMatchObject({
        ok: true,
      });
      expect(realpathSync(result.stableRoot)).toBe(realpathSync(stableRoot));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects copied global skills and the stale Claude runner skill name", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "skill-install-drift-"));
    try {
      const repoRoot = resolve(tempDir, "repo");
      const userSkillsRoot = resolve(tempDir, "home/.agents/skills");
      const codexSkillsRoot = resolve(tempDir, "home/.codex/skills");
      const claudeSkillsRoot = resolve(tempDir, "home/.claude/skills");
      mkdirSync(resolve(repoRoot, ".agents/skills"), { recursive: true });
      mkdirSync(userSkillsRoot, { recursive: true });
      mkdirSync(resolve(codexSkillsRoot, "claude-runner"), { recursive: true });
      mkdirSync(claudeSkillsRoot, { recursive: true });
      writeFileSync(
        resolve(codexSkillsRoot, "claude-runner/SKILL.md"),
        "---\nname: claude-runner\n---\n",
      );

      for (const skillName of [
        "session-orchestrator",
        "spec-review-lane",
        "claude-runner",
      ]) {
        const skillDir = resolve(repoRoot, "skills", skillName);
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(
          resolve(skillDir, "SKILL.md"),
          `---\nname: ${skillName}\n---\n`,
        );
        symlinkSync(
          `../../skills/${skillName}`,
          resolve(repoRoot, ".agents/skills", skillName),
        );
      }
      symlinkSync(
        "../../skills/symphony-claude-runner",
        resolve(repoRoot, ".agents/skills/symphony-claude-runner"),
      );

      try {
        execFileSync(
          process.execPath,
          [resolve(__dirname, "../../scripts/validate-skill-installs.mjs")],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              SYMPHONY_SKILL_REPO_ROOT: repoRoot,
              SYMPHONY_STABLE_ROOT: repoRoot,
              SYMPHONY_USER_SKILLS_DIR: userSkillsRoot,
              SYMPHONY_CODEX_SKILLS_DIR: codexSkillsRoot,
              SYMPHONY_CLAUDE_SKILLS_DIR: claudeSkillsRoot,
            },
          },
        );
        throw new Error("Expected validation to fail");
      } catch (error) {
        const stderr =
          typeof error === "object" &&
          error !== null &&
          "stderr" in error &&
          Buffer.isBuffer(error.stderr)
            ? error.stderr.toString("utf8")
            : error instanceof Error
              ? error.message
              : String(error);
        expect(stderr).toMatch(/active global copy|stale skill name/);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate active cmux-spawn installs outside ~/.agents/skills", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "cmux-spawn-install-drift-"));
    try {
      const repoRoot = resolve(tempDir, "repo");
      const userSkillsRoot = resolve(tempDir, "home/.agents/skills");
      const codexSkillsRoot = resolve(tempDir, "home/.codex/skills");
      const claudeSkillsRoot = resolve(tempDir, "home/.claude/skills");
      const cmuxSpawnSource = resolve(
        tempDir,
        "claude-config/skills/cmux-spawn",
      );
      mkdirSync(resolve(repoRoot, ".agents/skills"), { recursive: true });
      mkdirSync(userSkillsRoot, { recursive: true });
      mkdirSync(resolve(codexSkillsRoot, "cmux-spawn"), { recursive: true });
      mkdirSync(claudeSkillsRoot, { recursive: true });
      mkdirSync(cmuxSpawnSource, { recursive: true });
      writeFileSync(
        resolve(cmuxSpawnSource, "SKILL.md"),
        "---\nname: cmux-spawn\n---\n",
      );
      writeFileSync(
        resolve(codexSkillsRoot, "cmux-spawn/SKILL.md"),
        "---\nname: cmux-spawn\n---\ncopy\n",
      );
      symlinkSync(cmuxSpawnSource, resolve(userSkillsRoot, "cmux-spawn"));
      symlinkSync(cmuxSpawnSource, resolve(claudeSkillsRoot, "cmux-spawn"));

      for (const skillName of [
        "session-orchestrator",
        "spec-review-lane",
        "claude-runner",
      ]) {
        const skillDir = resolve(repoRoot, "skills", skillName);
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(
          resolve(skillDir, "SKILL.md"),
          `---\nname: ${skillName}\n---\n`,
        );
        symlinkSync(
          `../../skills/${skillName}`,
          resolve(repoRoot, ".agents/skills", skillName),
        );
      }

      try {
        execFileSync(
          process.execPath,
          [
            resolve(__dirname, "../../scripts/validate-skill-installs.mjs"),
            "--user-installs",
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              SYMPHONY_SKILL_REPO_ROOT: repoRoot,
              SYMPHONY_STABLE_ROOT: repoRoot,
              SYMPHONY_USER_SKILLS_DIR: userSkillsRoot,
              SYMPHONY_CODEX_SKILLS_DIR: codexSkillsRoot,
              SYMPHONY_CLAUDE_SKILLS_DIR: claudeSkillsRoot,
              SYMPHONY_CMUX_SPAWN_SKILL_SOURCE: cmuxSpawnSource,
            },
          },
        );
        throw new Error("Expected validation to fail");
      } catch (error) {
        const stderr =
          typeof error === "object" &&
          error !== null &&
          "stderr" in error &&
          Buffer.isBuffer(error.stderr)
            ? error.stderr.toString("utf8")
            : error instanceof Error
              ? error.message
              : String(error);
        expect(stderr).toContain("active duplicate cmux-spawn skill install");
        expect(stderr).toContain("home/.codex/skills/cmux-spawn/SKILL.md");
        expect(stderr).toContain("home/.claude/skills/cmux-spawn/SKILL.md");
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("runs the drift validation gate before the normal test command", () => {
    expect(packageJson.scripts?.pretest).toBe(
      "pnpm run validate:skill-installs",
    );
    expect(packageJson.scripts?.["validate:skill-installs"]).toBe(
      "node scripts/validate-skill-installs.mjs",
    );
    expect(packageJson.scripts?.["validate:session-orchestrator-skill"]).toBe(
      "pnpm run validate:skill-installs",
    );
  });

  it("requires live current-truth orientation before execution", () => {
    expect(skillContent).toContain(
      "linear-pp-cli ... --agent --data-source live",
    );
    expect(skillContent).toContain("git fetch origin main --prune");
    expect(skillContent).toContain("SPEC.mobilyze.md");
    expect(skillContent).toContain("handoffs/");
  });

  it("documents the stable source and user-level symlink install model", () => {
    expect(skillContent).toContain("Source And Install Model");
    expect(skillContent).toContain("skills/session-orchestrator");
    expect(skillContent).toContain("~/.agents/skills/session-orchestrator");
    expect(skillContent).toContain("~/.codex/skills/session-orchestrator");
    expect(skillContent).toContain("copy-style installs drift");
  });

  it("keeps the operator-facing plan current while work changes", () => {
    expect(skillContent).toContain("Call `update_plan`");
    expect(skillContent).toContain("go-forward list of tickets/tasks");
    expect(skillContent).toContain("Operator Plan Discipline");
    expect(skillContent).toContain("third-failure reset");
    expect(skillContent).toContain("how much remains");
  });

  it("runs spec-review intake for newly picked tickets before implementation", () => {
    expect(skillContent).toContain("$spec-review-lane");
    expect(skillContent).toContain("Spec Review Intake");
    expect(skillContent).toContain("before implementation");
    expect(skillContent).toContain("--mode observe");
    expect(skillContent).toContain("--force");
    expect(skillContent).toContain("--watcher-runtime-root");
    expect(skillContent).toContain("SYMPHONY_SPEC_REVIEW_RUNTIME_ROOT");
    expect(skillContent).toContain("source-only");
    expect(skillContent).toContain(
      "do not point `--workspace` at the stable checkout",
    );
    expect(skillContent).toContain("dispatcher journal row");
  });

  it("distinguishes interactive spec-review intake from autonomous Symphony worker review", () => {
    expect(skillContent).toContain("interactive Codex-led session");
    expect(skillContent).toContain("autonomous Symphony worker ticket review");
    expect(skillContent).toContain("out-of-band");
  });

  it("defines the requested risk taxonomy and high-risk state contract", () => {
    for (const riskClass of [
      "normal",
      "high-risk invariant",
      "substrate-degraded",
      "backlog-normalization",
      "operational-debug",
    ]) {
      expect(skillContent).toContain(riskClass);
    }

    for (const contractArea of [
      "Durable state",
      "Side effects",
      "Ordering",
      "Failure mode",
      "Operator proof",
      "Replay",
    ]) {
      expect(skillContent).toContain(contractArea);
    }
  });

  it("guards unsafe headless Claude/Codex reviewer lanes with live discovery", () => {
    expect(skillContent).toContain("reviewer-immutability");
    expect(skillContent).toContain(
      "before treating headless Claude/Codex reviewer lanes",
    );
    expect(skillContent).toContain("use Pi plus in-session Codex review");
    expect(workerPrompts).toContain(
      "verify the current reviewer-immutability or review-substrate issue",
    );
  });

  it("stops round-cap and provenance-only review failures before product rework", () => {
    expect(skillContent).toContain("product P1/P2 blockers");
    expect(skillContent).toContain("Track-only items");
    expect(skillContent).toContain("substrate/provenance degraded");
    expect(skillContent).toContain(
      "current product P1/P2, targeted same-family invariant check, or",
    );
    expect(skillContent).toContain("non-author-family decorrelation");
    expect(skillContent).toContain("`--author-family`");
    expect(skillContent).toContain(
      "do not launch another product-code review loop",
    );
  });

  it("requires an executable review-evidence checkpoint before completion reporting", () => {
    expect(skillContent).toContain(
      "scripts/assert-review-evidence-checkpoint.mjs",
    );
    expect(skillContent).toContain("--reported-head <head-sha>");
    expect(skillContent).toContain(
      "pass` with PR URL, reviewed head SHA, council artifact path",
    );
    expect(skillContent).toContain("evidence remains operator-visible");
    expect(skillContent).toContain("distinct from spec-time");
    expect(skillContent).toContain("review readiness");
  });

  it("blocks non-trivial closeout when review evidence is missing", () => {
    const checkpoint = runReviewEvidenceCheckpoint([
      "--reported-head",
      HEAD_SHA,
    ]);

    expect(checkpoint.status).toBe(1);
    expect(checkpoint.stdout).toContain("missing review evidence checkpoint");
    expect(checkpoint.stdout).toContain(
      "default classification is non-trivial",
    );
  });

  it("accepts pass evidence only when it is bound to the reported head", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "review-checkpoint-pass-"));
    try {
      const councilReport = resolve(tempDir, "council-report.md");
      const evidencePath = resolve(tempDir, "closeout-review-evidence.json");
      writeFileSync(councilReport, "# Council report\n");
      writeFileSync(
        evidencePath,
        JSON.stringify({
          schemaVersion: 1,
          outcome: "pass",
          prUrl: "https://github.com/mobilyze-llc/symphony-ts/pull/1",
          reviewedHeadSha: HEAD_SHA,
          councilArtifactPath: councilReport,
          cleanPassAssertionExitCode: 0,
        }),
      );

      const checkpoint = runReviewEvidenceCheckpoint([
        "--evidence",
        evidencePath,
        "--reported-head",
        HEAD_SHA,
      ]);

      expect(checkpoint.status).toBe(0);
      expect(JSON.parse(checkpoint.stdout)).toMatchObject({
        status: "pass",
        reviewedHeadSha: HEAD_SHA,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("blocks pass evidence from a stale reviewed head", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "review-checkpoint-stale-"));
    try {
      const councilReport = resolve(tempDir, "council-report.md");
      const evidencePath = resolve(tempDir, "closeout-review-evidence.json");
      writeFileSync(councilReport, "# Council report\n");
      writeFileSync(
        evidencePath,
        JSON.stringify({
          schemaVersion: 1,
          outcome: "pass",
          prUrl: "https://github.com/mobilyze-llc/symphony-ts/pull/1",
          reviewedHeadSha: "2222222222222222222222222222222222222222",
          councilArtifactPath: councilReport,
          cleanPassAssertionExitCode: 0,
        }),
      );

      const checkpoint = runReviewEvidenceCheckpoint([
        "--evidence",
        evidencePath,
        "--reported-head",
        HEAD_SHA,
      ]);

      expect(checkpoint.status).toBe(1);
      expect(checkpoint.stdout).toContain("does not match reported head");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("allows explicitly degraded evidence without rendering it as clean pass", () => {
    const tempDir = mkdtempSync(
      resolve(tmpdir(), "review-checkpoint-degraded-"),
    );
    try {
      const evidencePath = resolve(tempDir, "closeout-review-evidence.json");
      writeFileSync(
        evidencePath,
        JSON.stringify({
          schemaVersion: 1,
          outcome: "degraded",
          reviewedHeadSha: HEAD_SHA,
          degradedReason:
            "PR-backed council review unavailable; dirty worktree reviewed",
          dirtyState:
            "staged: none; unstaged: src/review/headless-council-gate.ts; untracked: none; included: unstaged diff; excluded: none",
        }),
      );

      const checkpoint = runReviewEvidenceCheckpoint([
        "--evidence",
        evidencePath,
        "--reported-head",
        HEAD_SHA,
      ]);

      expect(checkpoint.status).toBe(0);
      expect(JSON.parse(checkpoint.stdout)).toMatchObject({
        status: "degraded",
        degradedReason:
          "PR-backed council review unavailable; dirty worktree reviewed",
      });
      expect(checkpoint.stdout).toContain(
        "must not be reported as a clean done",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps durable follow-up in Linear through live discovery", () => {
    expect(skillContent).toContain("Search before create");
    expect(skillContent).toContain("linear-pp-cli similar");
    expect(skillContent).toContain("area:review-tooling");
    expect(skillContent).toContain("Treat ticket IDs in handoffs");
    expect(skillContent).not.toContain("docs/tracked-items.md");
  });

  it("does not bake dated concrete ticket IDs into the reusable skill", () => {
    expect(skillContent).not.toMatch(/\bSYMPH-\d+\b/);
    expect(workerPrompts).not.toMatch(/\bSYMPH-\d+\b/);
    expect(decisionBrief).not.toMatch(/\bSYMPH-\d+\b/);
  });

  it("provides copy-ready implementation and read-only worker prompt skeletons", () => {
    expect(workerPrompts).toContain(
      "You are a bounded Symphony implementation worker.",
    );
    expect(workerPrompts).toContain(
      "You are a fresh bounded Symphony implementation worker continuing an existing branch.",
    );
    expect(workerPrompts).toContain(
      "You are a read-only Symphony review/triage worker.",
    );
    expect(workerPrompts).toContain(
      "Do not spawn, create, or steer other workers.",
    );
    expect(workerPrompts).toContain("Authorization: read-only.");
    expect(workerPrompts).toContain("current origin/main");
    expect(workerPrompts).toContain("Live proof:");
    expect(workerPrompts).toContain("Stop conditions:");
  });

  it("defines a bounded context firewall for worker delegation and rotation", () => {
    expect(skillContent).toContain("## Context Firewall");
    expect(skillContent).toContain("### Default Packet Budgets");
    expect(skillContent).toContain("Issue body inline limit");
    expect(skillContent).toContain("<= 4,000");
    expect(skillContent).toContain("Total worker packet budget");
    expect(skillContent).toContain("### Worker Packet Contract");
    expect(skillContent).toContain("### Comment Preservation");
    expect(skillContent).toContain("authorClass: unknown");
    expect(skillContent).toContain("### Worker Closeout Contract");
    expect(skillContent).toContain("### Rotation And Tripwires");
    expect(skillContent).toContain(">= 100");
    expect(skillContent).toContain("> 2");
    expect(skillContent).toContain(">= 50M");
    expect(skillContent).toContain("### Fresh-Worker Continuation");
    expect(skillContent).toContain("same worktree/branch");
  });

  it("extends checkpoints and decision briefs with context-firewall evidence", () => {
    expect(skillContent).toContain(
      "| Issue | Worker/branch | PR | State | Packet | Closeout | Stop condition |",
    );
    expect(skillContent).toContain("## Context Firewall");
    expect(skillContent).toContain("Packet freshness: per-issue");
    expect(skillContent).toContain("Raw evidence inspected");
    expect(skillContent).toContain("Rotation chain");

    expect(decisionBrief).toContain("## Context Firewall State");
    expect(decisionBrief).toContain("Packet identity");
    expect(decisionBrief).toContain("Context packet:");
    expect(decisionBrief).toContain("Closeout packet:");
    expect(decisionBrief).toContain("Continuation safety");
  });

  it("keeps implementation workers packet-first without weakening current-head proof", () => {
    expect(workerPrompts).toContain("Worker packet: [path/URL] @ [hash]");
    expect(workerPrompts).toContain("Packet freshness: Linear updatedAt");
    expect(workerPrompts).toContain("Read the worker packet first.");
    expect(workerPrompts).toContain(
      "Verify current branch/base/head before editing",
    );
    expect(workerPrompts).toContain(
      "Do not paste raw long logs, raw transcripts",
    );
    expect(workerPrompts).toContain("needs_operator_context");
    expect(workerPrompts).toContain("Return a compact closeout packet only");
  });

  it("keeps continuation workers bounded by freshness and tripwire stops", () => {
    const continuationSection = workerPrompts.slice(
      workerPrompts.indexOf("## Continuation Implementation Worker"),
      workerPrompts.indexOf("## Read-Only Review Or Triage Worker"),
    );

    expect(continuationSection).toContain("Verified worktree");
    expect(continuationSection).toContain("Current head:");
    expect(continuationSection).toContain("Continuation packet:");
    expect(continuationSection).toContain("Packet freshness:");
    expect(continuationSection).toContain("Stop conditions:");
    expect(continuationSection).toContain(
      "Stop and report if path, branch, head, or base verification fails.",
    );
    expect(continuationSection).toContain(
      "Stop and emit a compact closeout packet when any packet tripwire fires",
    );
    expect(continuationSection).toContain(">=100");
    expect(continuationSection).toContain(">2");
    expect(continuationSection).toContain(
      "Do not ingest the prior worker transcript.",
    );
    expect(continuationSection).toContain("Handoff expectation:");
  });

  it("lets the orchestrator proactively use bounded subagents or threads", () => {
    expect(skillContent).toContain(
      "Do not wait for the operator to suggest subagents or threads",
    );
    expect(skillContent).toContain("orchestrator's discretion");
    expect(skillContent).toContain(
      "one bounded implementation worker per issue",
    );
    expect(skillContent).toContain("Parallelize only when");
  });

  it("requires judgment after a third failed review instead of stopping by default", () => {
    expect(skillContent).toContain("On the third failed review");
    expect(skillContent).toContain("do not simply stop");
    expect(skillContent).toContain("Step back and diagnose");
    expect(skillContent).toContain("use judgment to pick the next move");
    expect(skillContent).toContain("continue with the chosen recovery path");
  });

  it("includes an isolated dry-run prompt for forward testing", () => {
    expect(workerPrompts).toContain("Dry-Run Planning Prompt");
    expect(workerPrompts).toContain("This is a dry run");
    expect(workerPrompts).toContain("Use $session-orchestrator");
    expect(workerPrompts).toContain(
      "do not edit files, call Linear, call GitHub",
    );
    expect(workerPrompts).toContain("risk classification");
    expect(workerPrompts).toContain("review-loop discipline");
    expect(workerPrompts).toContain("Context-firewall scenarios");
    expect(workerPrompts).toContain("authorClass: unknown");
    expect(workerPrompts).toContain("same-worktree continuation worker packet");
    expect(workerPrompts).toContain("SYMPH-E");
    expect(workerPrompts).toContain("operator decision brief");
    expect(workerPrompts).toContain("do not authorize blind implementation");
  });

  it("includes an operator decision brief", () => {
    expect(decisionBrief).toContain("operator judgment");
    expect(decisionBrief).toContain("## Recommendation");
    expect(decisionBrief).toContain("## Current Truth");
    expect(decisionBrief).toContain("## Options");
    expect(decisionBrief).toContain("## Next Prompt If Continuing");
    expect(decisionBrief).toContain("create or update the Linear issue");
  });
});
