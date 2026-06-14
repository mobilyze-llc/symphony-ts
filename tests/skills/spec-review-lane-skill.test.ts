import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SKILL_DIR = resolve(__dirname, "../../skills/spec-review-lane");
const DISCOVERY_DIR = resolve(
  __dirname,
  "../../.agents/skills/spec-review-lane",
);
const SKILL_PATH = resolve(SKILL_DIR, "SKILL.md");
const SCRIPT_PATH = resolve(SKILL_DIR, "scripts/run-spec-review-lane.mjs");
const skillContent = readFileSync(SKILL_PATH, "utf-8");
const scriptContent = readFileSync(SCRIPT_PATH, "utf-8");

describe("spec-review-lane skill", () => {
  it("documents the durable watcher as the default path", () => {
    expect(skillContent).toMatch(/^name: spec-review-lane$/m);
    expect(skillContent).toContain("symphony-spec-review-watch");
    expect(skillContent).toContain("--issue-direct");
    expect(skillContent).toContain("--force");
    expect(skillContent).toContain("durable watcher path");
  });

  it("is exposed through the repo-local Codex discovery root", () => {
    expect(existsSync(DISCOVERY_DIR)).toBe(true);
    expect(lstatSync(DISCOVERY_DIR).isSymbolicLink()).toBe(true);
    expect(realpathSync(DISCOVERY_DIR)).toBe(realpathSync(SKILL_DIR));
    expect(existsSync(resolve(DISCOVERY_DIR, "SKILL.md"))).toBe(true);
  });

  it("keeps prompt-only fallback manual and non-durable", () => {
    expect(skillContent).toContain("manual reconciliation");
    expect(skillContent).toMatch(/not durable\s+spec-review readiness state/);
    expect(skillContent).toContain("do not write a `spec_review_result`");
    expect(skillContent).toContain("generated readiness marker");
  });

  it("wraps the watcher and derives deterministic next actions", () => {
    expect(scriptContent).toContain("symphony-spec-review-watch");
    expect(scriptContent).toContain("--issue-direct");
    expect(scriptContent).toContain("nextActionForReadiness");
    expect(scriptContent).toContain(
      "return path !== null && existsSync(path) ? path : null;",
    );
    expect(scriptContent).toContain('"--artifact-root"');
    expect(scriptContent).toContain('"--source-ref"');
    expect(scriptContent).toContain('"--symphony-spec-review-watch-bin"');
    expect(scriptContent).toContain("supply_operator_context");
    expect(scriptContent).toContain("rerun_or_inspect_artifact");
    expect(scriptContent).toContain("handle_out_of_band");
  });

  it("redacts path-bearing watcher args when watcher output is not JSON", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "spec-review-lane-"));
    try {
      const watcherPath = resolve(tempDir, "watcher.mjs");
      writeFileSync(
        watcherPath,
        ["#!/usr/bin/env node", 'process.stdout.write("not-json");', ""].join(
          "\n",
        ),
      );
      chmodSync(watcherPath, 0o755);

      const output = execFileSync(
        process.execPath,
        [
          SCRIPT_PATH,
          "--workspace",
          tempDir,
          "--issue",
          "SYMPH-1",
          "--workflow",
          resolve(tempDir, "WORKFLOW.md"),
          "--source-ref",
          resolve(tempDir, "SPEC.mobilyze.md"),
          "--artifact-root",
          resolve(tempDir, "artifacts"),
          "--cmux-spawn-bin",
          resolve(tempDir, "cmux-spawn"),
          "--symphony-spec-review-watch-bin",
          watcherPath,
        ],
        { encoding: "utf8" },
      );

      const summary = JSON.parse(output) as {
        watcherArgs: string[];
      };
      expect(summary.watcherArgs).toEqual([
        "[path]",
        "--workspace",
        "[path]",
        "--mode",
        "observe",
        "--issue-direct",
        "SYMPH-1",
        "--source-ref",
        "[path]",
        "--artifact-root",
        "[path]",
        "--cmux-spawn-bin",
        "[path]",
      ]);
      expect(summary.watcherArgs.join(" ")).not.toContain(tempDir);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports missing watcher artifact paths as null", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "spec-review-lane-"));
    try {
      const watcherPath = resolve(tempDir, "watcher.mjs");
      const missingArtifact = resolve(tempDir, "missing-artifact.md");
      const missingSelection = resolve(tempDir, "missing-selection.json");
      writeFileSync(
        watcherPath,
        [
          "#!/usr/bin/env node",
          "process.stdout.write(JSON.stringify({",
          "  selectedCount: 1,",
          `  selectionArtifactPath: ${JSON.stringify(missingSelection)},`,
          "  summary: { validCount: 1 },",
          "  results: [{",
          "    issueIdentifier: 'SYMPH-1',",
          "    readinessState: 'valid',",
          "    verdict: 'ready_as_written',",
          `    artifactPath: ${JSON.stringify(missingArtifact)},`,
          "    linearDocUrl: null",
          "  }]",
          "}));",
          "",
        ].join("\n"),
      );
      chmodSync(watcherPath, 0o755);

      const output = execFileSync(
        process.execPath,
        [
          SCRIPT_PATH,
          "--workspace",
          tempDir,
          "--issue",
          "SYMPH-1",
          "--symphony-spec-review-watch-bin",
          watcherPath,
        ],
        { encoding: "utf8" },
      );

      const summary = JSON.parse(output) as {
        selectionArtifactPath: string | null;
        results: Array<{ artifactPath: string | null }>;
      };
      expect(summary.selectionArtifactPath).toBeNull();
      expect(summary.results[0]?.artifactPath).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
