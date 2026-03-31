/**
 * Tests for freeze-and-queue.sh — sub-issue body
 * construction, and scenario matching.
 *
 * Uses --dry-run mode which exercises all parsing logic without Linear API calls.
 * Test specs are written to tmp files and the script's stdout is asserted.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(
  __dirname,
  "../../skills/spec-gen/scripts/freeze-and-queue.sh",
);
const WORKFLOW_PATH = resolve(
  __dirname,
  "../../pipeline-config/workflows/WORKFLOW-symphony.md",
);

let tmpDir: string;

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `freeze-queue-test-${randomBytes(6).toString("hex")}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runDryRun(specContent: string): string {
  const specFile = join(tmpDir, "spec.md");
  writeFileSync(specFile, specContent);
  try {
    return execFileSync(
      "bash",
      [SCRIPT_PATH, "--dry-run", WORKFLOW_PATH, specFile],
      {
        encoding: "utf-8",
        timeout: 15000,
        env: { ...process.env, LINEAR_API_KEY: "" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch (err: unknown) {
    const e = err as {
      stderr?: Buffer | string;
      stdout?: Buffer | string;
      status?: number;
    };
    const stderr =
      typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString() ?? "");
    const stdout =
      typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString() ?? "");
    throw new Error(
      `freeze-and-queue.sh failed (exit ${e.status}):\nSTDERR: ${stderr}\nSTDOUT (last 500): ${stdout.slice(-500)}`,
    );
  }
}

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Scenario matching ───────────────────────────────────────────────────────

describe("scenario matching in sub-issue bodies", () => {
  const specMultiTask = `# Multi Task

## Scenarios

### Feature: Core

\`\`\`gherkin
Scenario: Core initializes
    Given config exists
    When init called
    Then returns ok
    # Verify: echo ok
\`\`\`

\`\`\`gherkin
Scenario: Core handles errors
    Given bad config
    When init called
    Then throws error
    # Verify: echo ok
\`\`\`

### Feature: Utils

\`\`\`gherkin
Scenario: Utils format works
    Given input data
    When format called
    Then output correct
    # Verify: echo ok
\`\`\`

## Boundaries

### Always

* Validate input

### Never

* Swallow errors

## Tasks

### Task 1: Build core

**Priority**: 1
**Scope**: \`src/core.ts\`
**Scenarios**: Core initializes, Core handles errors

### Task 2: Build utils

**Priority**: 2
**Scope**: \`src/utils.ts\`
**Scenarios**: Utils format works
`;

  it("matches correct scenarios to Task 1 (core)", () => {
    const output = runDryRun(specMultiTask);
    const firstBody =
      output.split("SUB-ISSUE 1:")[1]?.split("SUB-ISSUE 2:")[0] ?? "";
    expect(firstBody).toContain("Scenario: Core initializes");
    expect(firstBody).toContain("Scenario: Core handles errors");
    expect(firstBody).not.toContain("Scenario: Utils format works");
  });

  it("matches correct scenario to Task 2 (utils)", () => {
    const output = runDryRun(specMultiTask);
    const secondBody = output.split("SUB-ISSUE 2:")[1] ?? "";
    expect(secondBody).toContain("Scenario: Utils format works");
    expect(secondBody).not.toContain("Scenario: Core initializes");
  });

  it("includes Boundaries in both sub-issue bodies", () => {
    const output = runDryRun(specMultiTask);
    const firstBody =
      output.split("SUB-ISSUE 1:")[1]?.split("SUB-ISSUE 2:")[0] ?? "";
    const secondBody = output.split("SUB-ISSUE 2:")[1] ?? "";
    expect(firstBody).toContain("## Boundaries");
    expect(secondBody).toContain("## Boundaries");
  });
});

// ── Sub-issue body structure ────────────────────────────────────────────────

describe("sub-issue body structure", () => {
  it("includes footer with freeze-and-queue attribution", () => {
    const spec = `# Widget

## Scenarios

\`\`\`gherkin
Scenario: Widget boots
    Given config
    When boot
    Then running
    # Verify: echo ok
\`\`\`

## Boundaries

### Always

* Log everything

## Tasks

### Task 1: Build widget

**Priority**: 1
**Scope**: \`src/widget.ts\`
**Scenarios**: Widget boots
`;
    const output = runDryRun(spec);
    expect(output).toContain(
      "Created by freeze-and-queue.sh from parent spec.",
    );
  });

  it("shows sequential blocking relations for multi-task specs", () => {
    const spec = `# Multi

## Scenarios

\`\`\`gherkin
Scenario: A works
    Given setup
    When action
    Then result
    # Verify: echo ok
\`\`\`

\`\`\`gherkin
Scenario: B works
    Given setup
    When action
    Then result
    # Verify: echo ok
\`\`\`

## Tasks

### Task 1: First

**Priority**: 1
**Scope**: \`a.ts\`
**Scenarios**: A works

### Task 2: Second

**Priority**: 2
**Scope**: \`b.ts\`
**Scenarios**: B works
`;
    const output = runDryRun(spec);
    expect(output).toContain("blocked by Task 1");
    expect(output).toContain("Sequential chain: 1 relations");
  });
});
