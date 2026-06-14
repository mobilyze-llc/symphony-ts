import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
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

  it("documents the stable source and user-level symlink install model", () => {
    expect(skillContent).toContain("Source And Install Model");
    expect(skillContent).toContain("skills/spec-review-lane");
    expect(skillContent).toContain("~/.agents/skills/spec-review-lane");
    expect(skillContent).toContain("~/.codex/skills/spec-review-lane");
    expect(skillContent).toContain("copy-style installs drift");
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
    expect(scriptContent).toContain("workspace_dist");
    expect(scriptContent).toContain("stale_watcher");
    expect(scriptContent).toContain("missing_executable");
    expect(scriptContent).toContain("nextActionForReadiness");
    expect(scriptContent).toContain(
      "const resolvedPath = isAbsolute(path) ? path : resolve(workspace, path);",
    );
    expect(scriptContent).toContain(
      "return existsSync(resolvedPath) ? resolvedPath : null;",
    );
    expect(scriptContent).toContain('"--artifact-root"');
    expect(scriptContent).toContain('"--source-ref"');
    expect(scriptContent).toContain("supply_operator_context");
    expect(scriptContent).toContain("rerun_or_inspect_artifact");
    expect(scriptContent).toContain("handle_out_of_band");
  });

  it("redacts path-bearing watcher args when watcher output is not JSON", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "spec-review-lane-"));
    try {
      const watcherPath = resolve(tempDir, "watcher.cjs");
      writeFileSync(
        watcherPath,
        [
          "#!/usr/bin/env node",
          'if (process.argv.includes("--help")) {',
          '  process.stdout.write("--issue-direct\\n--ticket\\n");',
          "  process.exit(0);",
          "}",
          'process.stdout.write("not-json");',
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
        watcherBin: string;
        watcherArgs: string[];
      };
      expect(summary.watcherBin).toBe("[path]");
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

  it("uses the workspace built watcher by default and passes direct-ticket args", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "spec-review-lane-"));
    try {
      const watcherPath = resolve(tempDir, "dist/src/cli/spec-review-watch.js");
      mkdirSync(resolve(tempDir, "dist/src/cli"), { recursive: true });
      writeFileSync(
        watcherPath,
        [
          "#!/usr/bin/env node",
          'const { writeFileSync } = require("node:fs");',
          'const { resolve } = require("node:path");',
          'if (process.argv.includes("--help")) {',
          '  process.stdout.write("--issue-direct\\n--ticket\\n");',
          "  process.exit(0);",
          "}",
          'writeFileSync(resolve(process.cwd(), "seen-args.json"), JSON.stringify(process.argv.slice(2)));',
          "process.stdout.write(JSON.stringify({",
          "  selectedCount: 0,",
          "  decisions: [],",
          "  summary: { exitCode: 0 }",
          "}));",
          "",
        ].join("\n"),
      );

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
          "--force",
          "--dry-run",
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: "",
            SYMPHONY_SPEC_REVIEW_WATCH_BIN: "",
          },
        },
      );

      const summary = JSON.parse(output) as {
        status: string;
        watcherSource: string;
        selectedCount: number;
      };
      const seenArgs = JSON.parse(
        readFileSync(resolve(tempDir, "seen-args.json"), "utf-8"),
      ) as string[];
      expect(summary.status).toBe("completed");
      expect(summary.watcherSource).toBe("workspace_dist");
      expect(summary.selectedCount).toBe(0);
      expect(seenArgs).toContain("--issue-direct");
      expect(seenArgs).toContain("SYMPH-1");
      expect(seenArgs).toContain("--force");
      expect(seenArgs).toContain("--dry-run");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves relative watcher overrides from the workspace for preflight and run", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "spec-review-lane-"));
    try {
      const watcherPath = resolve(tempDir, "watcher.cjs");
      writeFileSync(
        watcherPath,
        [
          "#!/usr/bin/env node",
          'const { writeFileSync } = require("node:fs");',
          'const { resolve } = require("node:path");',
          'if (process.argv.includes("--help")) {',
          '  process.stdout.write("--issue-direct\\n--ticket\\n");',
          "  process.exit(0);",
          "}",
          'writeFileSync(resolve(process.cwd(), "relative-override-seen.json"), JSON.stringify(process.argv.slice(2)));',
          "process.stdout.write(JSON.stringify({",
          "  selectedCount: 0,",
          "  decisions: [],",
          "  summary: { exitCode: 0 }",
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
          "--workflow",
          resolve(tempDir, "WORKFLOW.md"),
          "--symphony-spec-review-watch-bin",
          "./watcher.cjs",
        ],
        {
          cwd: __dirname,
          encoding: "utf8",
        },
      );

      const summary = JSON.parse(output) as {
        status: string;
        watcherSource: string;
      };
      const seenArgs = JSON.parse(
        readFileSync(resolve(tempDir, "relative-override-seen.json"), "utf-8"),
      ) as string[];
      expect(summary.status).toBe("completed");
      expect(summary.watcherSource).toBe("override");
      expect(seenArgs).toContain("--issue-direct");
      expect(seenArgs).toContain("SYMPH-1");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("treats backslash-bearing watcher overrides as path-like", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "spec-review-lane-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          SCRIPT_PATH,
          "--workspace",
          tempDir,
          "--issue",
          "SYMPH-1",
          "--workflow",
          resolve(tempDir, "WORKFLOW.md"),
          "--symphony-spec-review-watch-bin",
          ".\\missing-watcher.cjs",
        ],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      const summary = JSON.parse(result.stdout) as {
        diagnostic: { kind: string };
        watcherBin: string;
        watcherSource: string;
      };
      expect(summary.diagnostic.kind).toBe("missing_executable");
      expect(summary.watcherBin).toBe("[path]");
      expect(summary.watcherSource).toBe("override");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("distinguishes a missing watcher executable from review failure", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "spec-review-lane-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          SCRIPT_PATH,
          "--workspace",
          tempDir,
          "--issue",
          "SYMPH-1",
          "--workflow",
          resolve(tempDir, "WORKFLOW.md"),
          "--dry-run",
        ],
        {
          encoding: "utf8",
          env: { ...process.env, PATH: "" },
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Spec review watcher is not available");
      const summary = JSON.parse(result.stdout) as {
        status: string;
        diagnostic: { kind: string };
        rawOutputBytes: number;
        watcherSource: string;
      };
      expect(summary.status).toBe("failed");
      expect(summary.diagnostic.kind).toBe("missing_executable");
      expect(summary.rawOutputBytes).toBe(0);
      expect(summary.watcherSource).toBe("path");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("distinguishes a stale built watcher that lacks issue-direct support", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "spec-review-lane-"));
    try {
      const watcherPath = resolve(tempDir, "dist/src/cli/spec-review-watch.js");
      mkdirSync(resolve(tempDir, "dist/src/cli"), { recursive: true });
      writeFileSync(
        watcherPath,
        [
          "#!/usr/bin/env node",
          'if (process.argv.includes("--help")) {',
          '  process.stdout.write("--issue\\n--force\\n");',
          "  process.exit(0);",
          "}",
          'process.stdout.write("{}");',
          "",
        ].join("\n"),
      );

      const result = spawnSync(
        process.execPath,
        [
          SCRIPT_PATH,
          "--workspace",
          tempDir,
          "--issue",
          "SYMPH-1",
          "--workflow",
          resolve(tempDir, "WORKFLOW.md"),
          "--dry-run",
        ],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("appears stale");
      const summary = JSON.parse(result.stdout) as {
        status: string;
        diagnostic: { kind: string };
        watcherSource: string;
      };
      expect(summary.status).toBe("failed");
      expect(summary.diagnostic.kind).toBe("stale_watcher");
      expect(summary.watcherSource).toBe("workspace_dist");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not accept substring-only direct-ticket help flags", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "spec-review-lane-"));
    try {
      const watcherPath = resolve(tempDir, "dist/src/cli/spec-review-watch.js");
      mkdirSync(resolve(tempDir, "dist/src/cli"), { recursive: true });
      writeFileSync(
        watcherPath,
        [
          "#!/usr/bin/env node",
          'if (process.argv.includes("--help")) {',
          '  process.stdout.write("--issue-direct-extra\\n--ticket-extra\\n");',
          "  process.exit(0);",
          "}",
          'process.stdout.write("{}");',
          "",
        ].join("\n"),
      );

      const result = spawnSync(
        process.execPath,
        [
          SCRIPT_PATH,
          "--workspace",
          tempDir,
          "--issue",
          "SYMPH-1",
          "--workflow",
          resolve(tempDir, "WORKFLOW.md"),
          "--dry-run",
        ],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      const summary = JSON.parse(result.stdout) as {
        diagnostic: { kind: string };
      };
      expect(summary.diagnostic.kind).toBe("stale_watcher");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("distinguishes watcher help preflight failure from stale build", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "spec-review-lane-"));
    try {
      const watcherPath = resolve(tempDir, "dist/src/cli/spec-review-watch.js");
      mkdirSync(resolve(tempDir, "dist/src/cli"), { recursive: true });
      writeFileSync(
        watcherPath,
        [
          "#!/usr/bin/env node",
          'if (process.argv.includes("--help")) {',
          '  process.stderr.write("preflight exploded");',
          "  process.exit(7);",
          "}",
          'process.stdout.write("{}");',
          "",
        ].join("\n"),
      );

      const result = spawnSync(
        process.execPath,
        [
          SCRIPT_PATH,
          "--workspace",
          tempDir,
          "--issue",
          "SYMPH-1",
          "--workflow",
          resolve(tempDir, "WORKFLOW.md"),
          "--dry-run",
        ],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(7);
      expect(result.stderr).toContain("help preflight failed");
      const summary = JSON.parse(result.stdout) as {
        status: string;
        diagnostic: { kind: string; exitCode: number };
        watcherSource: string;
      };
      expect(summary.status).toBe("failed");
      expect(summary.diagnostic.kind).toBe("preflight_failed");
      expect(summary.diagnostic.exitCode).toBe(7);
      expect(summary.watcherSource).toBe("workspace_dist");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps downstream watcher review failure separate from wrapper diagnostics", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "spec-review-lane-"));
    try {
      const watcherPath = resolve(tempDir, "dist/src/cli/spec-review-watch.js");
      mkdirSync(resolve(tempDir, "dist/src/cli"), { recursive: true });
      writeFileSync(
        watcherPath,
        [
          "#!/usr/bin/env node",
          'if (process.argv.includes("--help")) {',
          '  process.stdout.write("--issue-direct\\n--ticket\\n");',
          "  process.exit(0);",
          "}",
          "process.stdout.write(JSON.stringify({",
          "  selectedCount: 1,",
          "  summary: { exitCode: 1, exitReason: 'error_results' },",
          "  results: [{",
          "    issueIdentifier: 'SYMPH-1',",
          "    readinessState: 'runner_failed',",
          "    verdict: null,",
          "    artifactPath: null,",
          "    linearDocUrl: null",
          "  }]",
          "}));",
          "process.exit(1);",
          "",
        ].join("\n"),
      );

      const result = spawnSync(
        process.execPath,
        [
          SCRIPT_PATH,
          "--workspace",
          tempDir,
          "--issue",
          "SYMPH-1",
          "--workflow",
          resolve(tempDir, "WORKFLOW.md"),
        ],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      const summary = JSON.parse(result.stdout) as {
        status: string;
        diagnostic: null;
        results: Array<{ readinessState: string; nextAction: string }>;
        watcherSource: string;
      };
      expect(summary.status).toBe("failed");
      expect(summary.diagnostic).toBeNull();
      expect(summary.watcherSource).toBe("workspace_dist");
      expect(summary.results[0]).toMatchObject({
        readinessState: "runner_failed",
        nextAction: "rerun_or_inspect_artifact",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports missing watcher artifact paths as null", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "spec-review-lane-"));
    try {
      const watcherPath = resolve(tempDir, "watcher.mjs");
      const relativeArtifact = "artifact.md";
      writeFileSync(resolve(tempDir, relativeArtifact), "review");
      const missingArtifact = resolve(tempDir, "missing-artifact.md");
      const missingSelection = resolve(tempDir, "missing-selection.json");
      writeFileSync(
        watcherPath,
        [
          "#!/usr/bin/env node",
          'if (process.argv.includes("--help")) {',
          '  process.stdout.write("--issue-direct\\n--ticket\\n");',
          "  process.exit(0);",
          "}",
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
          "  }, {",
          "    issueIdentifier: 'SYMPH-2',",
          "    readinessState: 'valid',",
          "    verdict: 'ready_as_written',",
          `    artifactPath: ${JSON.stringify(relativeArtifact)},`,
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
      expect(summary.results[1]?.artifactPath).toBe(
        resolve(tempDir, relativeArtifact),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
