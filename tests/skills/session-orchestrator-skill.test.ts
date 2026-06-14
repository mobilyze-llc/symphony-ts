import { execFileSync } from "node:child_process";
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
const workerPrompts = readFileSync(
  resolve(SKILL_DIR, "references/worker-prompts.md"),
  "utf-8",
);
const decisionBrief = readFileSync(
  resolve(SKILL_DIR, "references/operator-decision-brief.md"),
  "utf-8",
);
const skillContent = readFileSync(SKILL_PATH, "utf-8");
const validationScript = readFileSync(
  resolve(__dirname, "../../scripts/validate-skill-installs.mjs"),
  "utf-8",
);
const packageJson = JSON.parse(
  readFileSync(resolve(__dirname, "../../package.json"), "utf-8"),
) as { scripts?: Record<string, string> };

describe("session-orchestrator skill", () => {
  it("has trigger metadata for temporary Symphony session orchestration work", () => {
    expect(skillContent).toMatch(/^name: session-orchestrator$/m);
    expect(skillContent).toMatch(/session orchestration/i);
    expect(skillContent).toMatch(/queue-clearing waves/i);
    expect(skillContent).toMatch(/cap-hit synthesis/i);
    expect(skillContent).toMatch(/backlog normalization/i);
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
    expect(validationScript).toContain("~/.agents/skills/<name>");
    expect(validationScript).toContain("--user-installs");
    expect(validationScript).toContain(".codex/skills");
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
      mkdirSync(resolve(repoRoot, "skills"), { recursive: true });
      mkdirSync(resolve(repoRoot, ".agents/skills"), { recursive: true });
      mkdirSync(userSkillsRoot, { recursive: true });
      mkdirSync(codexSkillsRoot, { recursive: true });

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

  it("discovers the stable main worktree for user-level install targets", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "skill-install-main-"));
    try {
      const stableRoot = resolve(tempDir, "stable");
      const featureRoot = resolve(tempDir, "feature");
      const userSkillsRoot = resolve(tempDir, "home/.agents/skills");
      const codexSkillsRoot = resolve(tempDir, "home/.codex/skills");

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
      mkdirSync(resolve(repoRoot, ".agents/skills"), { recursive: true });
      mkdirSync(userSkillsRoot, { recursive: true });
      mkdirSync(resolve(codexSkillsRoot, "claude-runner"), { recursive: true });
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
    expect(skillContent).toContain("dispatcher journal row");
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
