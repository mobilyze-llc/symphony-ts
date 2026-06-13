import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SKILL_DIR = resolve(__dirname, "../../skills/symphony-manual-manager");
const DISCOVERY_DIR = resolve(
  __dirname,
  "../../.agents/skills/symphony-manual-manager",
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

describe("symphony-manual-manager skill", () => {
  it("has trigger metadata for temporary Symphony manual manager work", () => {
    expect(skillContent).toMatch(/^name: symphony-manual-manager$/m);
    expect(skillContent).toMatch(/manual manager sessions/i);
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

  it("requires live current-truth orientation before execution", () => {
    expect(skillContent).toContain(
      "linear-pp-cli ... --agent --data-source live",
    );
    expect(skillContent).toContain("git fetch origin main --prune");
    expect(skillContent).toContain("SPEC.mobilyze.md");
    expect(skillContent).toContain("handoffs/");
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

  it("guards unsafe headless Claude/Codex reviewer lanes until SYMPH-546 lands", () => {
    expect(skillContent).toContain("SYMPH-546");
    expect(skillContent).toMatch(
      /do not\s+treat headless Claude\/Codex reviewer lanes/i,
    );
    expect(skillContent).toContain("Use Pi plus in-session Codex review");
    expect(workerPrompts).toContain(
      "Until SYMPH-546 is live-verified Done and merged",
    );
  });

  it("keeps durable follow-up in Linear and references existing process tickets", () => {
    expect(skillContent).toContain("Search before create");
    expect(skillContent).toContain("linear-pp-cli similar");
    expect(skillContent).toContain("SYMPH-376");
    expect(skillContent).toContain("SYMPH-340");
    expect(skillContent).not.toContain("docs/tracked-items.md");
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

  it("includes an isolated dry-run prompt for forward testing", () => {
    expect(workerPrompts).toContain("Dry-Run Planning Prompt");
    expect(workerPrompts).toContain("This is a dry run");
    expect(workerPrompts).toContain(
      "do not edit files, call Linear, call GitHub",
    );
    expect(workerPrompts).toContain("risk classification");
    expect(workerPrompts).toContain("review-loop discipline");
  });

  it("includes a SYMPH-376 aligned operator decision brief", () => {
    expect(decisionBrief).toContain("aligned with `SYMPH-376`");
    expect(decisionBrief).toContain("## Recommendation");
    expect(decisionBrief).toContain("## Current Truth");
    expect(decisionBrief).toContain("## Options");
    expect(decisionBrief).toContain("## Next Prompt If Continuing");
    expect(decisionBrief).toContain("create or update the Linear issue");
  });
});
