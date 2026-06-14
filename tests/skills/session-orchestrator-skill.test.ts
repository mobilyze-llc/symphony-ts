import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SKILL_DIR = resolve(__dirname, "../../skills/session-orchestrator");
const DISCOVERY_DIR = resolve(
  __dirname,
  "../../.agents/skills/session-orchestrator",
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

  it("requires live current-truth orientation before execution", () => {
    expect(skillContent).toContain(
      "linear-pp-cli ... --agent --data-source live",
    );
    expect(skillContent).toContain("git fetch origin main --prune");
    expect(skillContent).toContain("SPEC.mobilyze.md");
    expect(skillContent).toContain("handoffs/");
  });

  it("keeps the operator-facing plan current while work changes", () => {
    expect(skillContent).toContain("Call `update_plan`");
    expect(skillContent).toContain("go-forward list of tickets/tasks");
    expect(skillContent).toContain("Operator Plan Discipline");
    expect(skillContent).toContain("third-failure reset");
    expect(skillContent).toContain("how much remains");
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
