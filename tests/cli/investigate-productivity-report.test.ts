import {
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isDirectRun,
  runInvestigateProductivityReportCli,
} from "../../src/cli/investigate-productivity-report.js";

function tmpDir(): string {
  return join(
    tmpdir(),
    `investigate-productivity-cli-${Math.random().toString(16).slice(2)}`,
  );
}

describe("investigate productivity report CLI", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = tmpDir();
    mkdirSync(workspace, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("returns usage errors without throwing", async () => {
    let stderr = "";
    const code = await runInvestigateProductivityReportCli([], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(code).toBe(2);
    expect(stderr).toContain("--workspace is required");
  });

  it("rejects an empty workspace value", async () => {
    const code = await runInvestigateProductivityReportCli(
      ["--workspace", ""],
      {
        stdout: () => {},
        stderr: () => {},
      },
    );

    expect(code).toBe(2);
  });

  it("emits an empty report for a workspace without a journal", async () => {
    let stdout = "";
    const code = await runInvestigateProductivityReportCli(
      ["--workspace", workspace],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
      },
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      source: "dispatcher_run_journal",
      totalUnits: 0,
    });
  });

  it("detects direct invocation through symlinked bin paths", () => {
    const realScript = join(workspace, "real.js");
    const symlinkedScript = join(workspace, "linked.js");
    const differentScript = join(workspace, "other.js");
    writeFileSync(realScript, "");
    writeFileSync(differentScript, "");
    symlinkSync(realScript, symlinkedScript);

    expect(
      isDirectRun(
        pathToFileURL(realpathSync(realScript)).href,
        symlinkedScript,
      ),
    ).toBe(true);
    expect(isDirectRun(pathToFileURL(realScript).href, undefined)).toBe(false);
    expect(isDirectRun(pathToFileURL(realScript).href, "/missing/bin")).toBe(
      false,
    );
    expect(
      isDirectRun(
        pathToFileURL(realpathSync(realScript)).href,
        differentScript,
      ),
    ).toBe(false);
  });
});
