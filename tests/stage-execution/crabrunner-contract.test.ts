import { describe, expect, it } from "vitest";

import {
  parseCrabrunnerCollect,
  parseCrabrunnerRunResult,
  parseCrabrunnerStatus,
} from "../../src/stage-execution/crabrunner-contract.js";

describe("crabrunner contract parsing", () => {
  it("parses a versioned status payload", () => {
    expect(
      parseCrabrunnerStatus(ok(status("job-1")), "status", "job-1"),
    ).toMatchObject({
      schema: "crucible.crabrunner.status.v1",
      job_id: "job-1",
      state: "running",
    });
  });

  it("preserves a structured non-zero error payload in the failure", () => {
    expect(() =>
      parseCrabrunnerStatus(
        {
          stdout: JSON.stringify({
            schema: "crucible.crabrunner.error.v1",
            error_code: "admission_lock_timeout",
            message: "admission lock remained held",
            lock_path: "/tmp/admission.lock",
          }),
          stderr: "lock diagnostic",
          exitCode: 1,
        },
        "status",
      ),
    ).toThrow(
      /admission_lock_timeout.*admission lock remained held.*lock_path.*lock diagnostic/,
    );
  });

  it("rejects a collect payload whose nested status belongs to another job", () => {
    expect(() =>
      parseCrabrunnerCollect(
        ok({
          schema: "crucible.crabrunner.collect.v1",
          job_id: "job-1",
          state: "complete",
          status: status("job-2"),
          archive_path: "/tmp/job-1.tgz",
        }),
        "job-1",
      ),
    ).toThrow(/job_id "job-2" but expected "job-1"/);
  });

  it("rejects an unexpected nested collect status schema", () => {
    expect(() =>
      parseCrabrunnerCollect(
        ok({
          schema: "crucible.crabrunner.collect.v1",
          job_id: "job-1",
          state: "complete",
          status: {
            ...status("job-1"),
            schema: "crucible.crabrunner.status.v2",
          },
        }),
        "job-1",
      ),
    ).toThrow(/status schema.*status\.v2.*status\.v1/);
  });

  it("rejects an unexpected run-result schema", () => {
    expect(() =>
      parseCrabrunnerRunResult(
        ok({
          schema: "crucible.crabrunner.collect.v1",
          job_id: "job-1",
          state: "complete",
          status: status("job-1"),
        }),
        "job-1",
      ),
    ).toThrow(/unexpected schema/);
  });

  it("rejects an unexpected nested collect schema in a run result", () => {
    expect(() =>
      parseCrabrunnerRunResult(
        ok({
          schema: "crucible.crabrunner.run-result.v1",
          job_id: "job-1",
          state: "complete",
          status: status("job-1"),
          collect: {
            schema: "crucible.crabrunner.collect.v2",
            job_id: "job-1",
            state: "complete",
            status: status("job-1"),
          },
        }),
        "job-1",
      ),
    ).toThrow(/run collect.*collect\.v2.*collect\.v1/);
  });
});

function status(jobId: string): Record<string, unknown> {
  return {
    schema: "crucible.crabrunner.status.v1",
    job_id: jobId,
    state: "running",
    collectible: false,
  };
}

function ok(payload: unknown): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  return { stdout: JSON.stringify(payload), stderr: "", exitCode: 0 };
}
