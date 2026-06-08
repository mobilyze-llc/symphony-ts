import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  parseManagerRunImportCliArgs,
  runManagerRunImportCli,
} from "../../src/cli/manager-run-import.js";

describe("manager-run import cli", () => {
  it("parses input and output flags", () => {
    expect(
      parseManagerRunImportCliArgs([
        "--input",
        "ledger.json",
        "--output=/tmp/manager-runs.jsonl",
      ]),
    ).toEqual({
      inputPath: "ledger.json",
      outputPath: "/tmp/manager-runs.jsonl",
      help: false,
    });
  });

  it("writes imported manager-run jsonl to disk", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "symph-manager-import-"));
    const fixturePath = resolve(
      import.meta.dirname,
      "../fixtures/manager-run-ledgers/019ea74a-0df6-7983-bbff-60c7df539e80.json",
    );
    const inputPath = join(workspace, "ledger.json");
    const outputPath = join(workspace, "manager-runs.jsonl");
    await writeFile(inputPath, await readFile(fixturePath, "utf8"), "utf8");
    const stdout = vi.fn();
    const stderr = vi.fn();

    const exitCode = await runManagerRunImportCli(
      ["--input", "ledger.json", "--output", "manager-runs.jsonl"],
      {
        cwd: workspace,
        io: { stdout, stderr },
      },
    );

    expect(exitCode).toBe(0);
    expect(await readFile(outputPath, "utf8")).toContain(
      '"type":"manager_run_started"',
    );
    expect(stdout).toHaveBeenCalledWith(
      `Wrote 13 manager-run entries to ${outputPath}\n`,
    );
    expect(stderr).not.toHaveBeenCalled();
  });
});
