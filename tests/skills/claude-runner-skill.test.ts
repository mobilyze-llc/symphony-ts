import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(__dirname, "../../skills/claude-runner");
const DISCOVERY_DIR = resolve(__dirname, "../../.agents/skills/claude-runner");
const SKILL_PATH = resolve(SKILL_DIR, "SKILL.md");
const skillContent = readFileSync(SKILL_PATH, "utf-8");

function expectAll(snippets: readonly string[]): void {
  for (const snippet of snippets) {
    expect(skillContent).toContain(snippet);
  }
}

describe("claude-runner skill", () => {
  it("defines the reusable agent-facing Claude crabrunner entrypoint", () => {
    expect(skillContent).toMatch(/^name: claude-runner$/m);
    expect(skillContent).toContain("# Claude Runner");
    expect(skillContent).toContain("claude-runner");
    expect(skillContent).toContain("crabrunner execution substrate");
    expect(skillContent).toContain("bounded Claude lane");
  });

  it("documents the stable source and user-level symlink install model", () => {
    expect(skillContent).toContain("Source And Install Model");
    expect(skillContent).toContain("skills/claude-runner");
    expect(skillContent).toContain("~/.agents/skills/claude-runner");
    expect(skillContent).toContain("~/.codex/skills/claude-runner");
    expect(skillContent).toContain("symphony-claude-runner");
  });

  it("is exposed through the repo-local agent discovery root", () => {
    expect(existsSync(DISCOVERY_DIR)).toBe(true);
    expect(lstatSync(DISCOVERY_DIR).isSymbolicLink()).toBe(true);
    expect(realpathSync(DISCOVERY_DIR)).toBe(realpathSync(SKILL_DIR));
    expect(existsSync(resolve(DISCOVERY_DIR, "SKILL.md"))).toBe(true);
  });

  it("prohibits unmanaged direct Claude subprocesses", () => {
    expectAll([
      "Do not call `claude -p`, `claude --bg`, or hand-written unmanaged Claude",
      "Do not invent a parallel",
    ]);
  });

  it("documents every supported generic runner purpose with copy-ready templates", () => {
    for (const purpose of [
      "spec-partner",
      "spec-review",
      "research",
      "critique",
      "review",
      "development-agent",
      "custom",
    ]) {
      expect(skillContent).toContain(`--purpose ${purpose}`);
      expect(skillContent).toContain(`### \`${purpose}\``);
    }
  });

  it("explains required runner inputs and crabrunner configuration", () => {
    expectAll([
      "`WORKSPACE_ROOT`",
      "`PROMPT_FILE`",
      "`ARTIFACT_DIR`",
      "`ARTIFACT_NAME`",
      "`PURPOSE`",
      "`SOURCE` files",
      "`MODEL` and `PROFILE`",
      "`TIMEOUT_SECONDS`",
      "`SYMPHONY_CRABRUNNER_ROOT`",
      "Crabrunner owns admission",
    ]);
  });

  it("keeps prompts and sources inside the workspace before model invocation", () => {
    expectAll([
      "Prompts and sources must be inside the workspace.",
      "checks prompt and",
      "source visibility before scheduler submission",
      "sourceVisibility.status",
      "invalid_source_path",
    ]);
  });

  it("covers artifact validation and result JSON inspection", () => {
    expectAll([
      "--required-heading <text>",
      "--require-first-heading <text>",
      "--verdict-enum <value>",
      "--required-json-section <heading>",
      "--min-bytes <n>",
      "--diagnostic-byte-limit <n>",
      'Treat only `"status": "passed"` as success.',
      "`validationErrors`",
      "`attempts`",
      "`diagnostics`",
    ]);
  });

  it("documents quiet-lane polling instead of treating silence as failure", () => {
    expectAll([
      "Silence is not failure.",
      "Do not kill or restart a lane merely because stdout is idle.",
      "<ARTIFACT_DIR>/<ARTIFACT_NAME>.md",
      "<ARTIFACT_DIR>/<ARTIFACT_NAME>.crabrunner.json",
      "<ARTIFACT_DIR>/<ARTIFACT_NAME>.result.json",
    ]);
  });

  it("routes durable spec-review work to the watcher instead of the generic runner", () => {
    expectAll([
      "For durable spec-time ticket review, use `symphony-spec-review-watch`",
      "The watcher owns ticket selection",
      "Linear Doc publication",
    ]);
  });

  it("documents one-shot invalid-artifact handling", () => {
    expectAll([
      "Crabrunner lanes are one-shot.",
      "deliberately submit a new lane",
      "invalid_artifact",
      "terminal evidence",
    ]);
  });
});
