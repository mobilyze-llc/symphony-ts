import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SKILL_ROOT = resolve(ROOT, "skills/council-review");

function readSkillFile(path: string): string {
  return readFileSync(resolve(SKILL_ROOT, path), "utf-8");
}

function expectAll(content: string, snippets: readonly string[]): void {
  for (const snippet of snippets) {
    expect(content).toContain(snippet);
  }
}

describe("council-review manual skill", () => {
  const skill = readSkillFile("SKILL.md");
  const opusPrompt = readSkillFile("templates/phase1-opus-prompt.md");
  const piPrompt = readSkillFile("templates/phase1-pi-prompt.md");
  const codexCrossExam = readSkillFile("templates/cross-exam-codex-prompt.md");
  const opusCrossExam = readSkillFile("templates/cross-exam-opus-prompt.md");
  const reportTemplate = readSkillFile("templates/council-report.md");

  it("defines distinct initial and convergence review modes", () => {
    for (const prompt of [opusPrompt, piPrompt]) {
      expectAll(prompt, [
        "Initial broad pass:",
        "Convergence pass:",
        "`previous_reviewed_head..HEAD`",
        "semantic",
        "Do not reopen unrelated P3/Track items",
      ]);
    }

    expectAll(skill, [
      "initial broad pass",
      "convergence passes",
      "`previous_reviewed_head..HEAD`",
      "falsify the named invariant",
    ]);
  });

  it("requires current-head evidence for every P1/P2", () => {
    for (const prompt of [opusPrompt, piPrompt, codexCrossExam]) {
      expectAll(prompt, [
        "Current head SHA",
        "Exact file:line evidence",
        "contract violated",
        "reachable failure mode",
        "test/proof gap",
      ]);
    }

    expectAll(reportTemplate, [
      "current-head file:line",
      "contract violated",
      "reachable failure mode",
      "test/proof gap",
    ]);
  });

  it("does not let stale or degraded artifacts become blockers by themselves", () => {
    for (const prompt of [
      opusPrompt,
      piPrompt,
      codexCrossExam,
      opusCrossExam,
    ]) {
      expectAll(prompt, [
        "Stale-base",
        "degraded-lane",
        "not merge-blocking by itself",
      ]);
    }

    expect(reportTemplate).toContain(
      "Stale-base, degraded-lane, malformed, partial, or empty artifact evidence is unavailable evidence",
    );
  });

  it("forces cold-read Track items and reviewer immutability", () => {
    for (const prompt of [
      opusPrompt,
      piPrompt,
      codexCrossExam,
      opusCrossExam,
    ]) {
      expectAll(prompt, [
        "cold-read acceptance criteria",
        "source refs",
        "verification steps",
        "Do not edit files, create commits, update PRs",
        "mutate the target worktree",
      ]);
    }
  });

  it("records cap-hit and same-family operator decision behavior", () => {
    expectAll(skill, [
      "same-family finding reopens",
      "operator-decision brief",
      "Do not silently launch another broad review loop.",
    ]);

    expectAll(reportTemplate, [
      "Operator Decision Brief",
      "round cap is hit",
      "same family reopens twice",
      "Exact next question",
    ]);
  });

  it("captures a forward-test that narrows the historical stale Pipeline family", () => {
    const forwardTest = readFileSync(
      resolve(ROOT, "docs/council-review-forward-test.md"),
      "utf-8",
    );

    expectAll(forwardTest, [
      "stale Pipeline attachment",
      "Review mode: convergence pass",
      "`previous_reviewed_head..HEAD`",
      "Do not launch another broad whole-diff round.",
      "unavailable evidence, not as a merge blocker",
    ]);
  });
});
