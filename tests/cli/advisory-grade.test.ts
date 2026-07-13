import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { readCalibrationJournal } from "../../src/calibration/journal-reader.js";
import {
  ADVISORY_GRADE_EXIT,
  runAdvisoryGradeCli,
} from "../../src/cli/advisory-grade.js";

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (message: string) => out.push(message),
      stderr: (message: string) => err.push(message),
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

const BASE_ARGS = (root: string) => [
  "--members",
  "MOB-1,MOB-2",
  "--root",
  "Shared root",
  "--decision",
  "accept",
  "--actor-host",
  "pro14",
  "--journal-root",
  root,
];

describe("symphony-advisory-grade (SYMPH-1140)", () => {
  it("rejects a missing member set with a usage error", async () => {
    const { io, err } = captureIo();
    const code = await runAdvisoryGradeCli(
      ["--root", "Shared root", "--decision", "accept"],
      { io },
    );
    expect(code).toBe(ADVISORY_GRADE_EXIT.usage);
    expect(err()).toContain("--members is required");
  });

  it("rejects a partial grade without an accepted subset", async () => {
    const { io, err } = captureIo();
    const code = await runAdvisoryGradeCli(
      ["--members", "MOB-1,MOB-2", "--root", "r", "--decision", "partial"],
      { io },
    );
    expect(code).toBe(ADVISORY_GRADE_EXIT.usage);
    expect(err()).toContain("--accepted");
  });

  it("rejects a partial grade containing an identifier outside the advisory", async () => {
    const { io, err } = captureIo();
    const journalGrade = vi.fn();
    const code = await runAdvisoryGradeCli(
      [
        "--members",
        "MOB-1,MOB-2",
        "--root",
        "r",
        "--decision",
        "partial",
        "--accepted",
        "MOB-1,MOB-3",
      ],
      { io, journalGrade },
    );
    expect(code).toBe(ADVISORY_GRADE_EXIT.usage);
    expect(err()).toContain("must belong to --members");
    expect(journalGrade).not.toHaveBeenCalled();
  });

  it("rejects a partial grade accepting the entire advisory member set", async () => {
    const { io, err } = captureIo();
    const journalGrade = vi.fn();
    const code = await runAdvisoryGradeCli(
      [
        "--members",
        "MOB-1,MOB-2",
        "--root",
        "r",
        "--decision",
        "partial",
        "--accepted",
        "MOB-1,MOB-2",
      ],
      { io, journalGrade },
    );
    expect(code).toBe(ADVISORY_GRADE_EXIT.usage);
    expect(err()).toContain("proper subset");
    expect(journalGrade).not.toHaveBeenCalled();
  });

  it("journals a cli-session grade and reports a conflict on immutable re-grade", async () => {
    const root = await mkdtemp(join(tmpdir(), "advisory-grade-"));
    try {
      const first = captureIo();
      const firstCode = await runAdvisoryGradeCli(BASE_ARGS(root), {
        io: first.io,
      });
      expect(firstCode).toBe(ADVISORY_GRADE_EXIT.ok);
      expect(first.out()).toContain("cli-session evidence");

      const journal = await readCalibrationJournal(root);
      const grade = journal.find(
        (entry) => entry.kind === "structural_advisory_grade",
      );
      expect(grade?.metadata.source).toBe("cli-session");
      expect(grade?.metadata.decision).toBe("accept");

      // Same actor + fingerprint → first decision is immutable.
      const second = captureIo();
      const secondCode = await runAdvisoryGradeCli(BASE_ARGS(root), {
        io: second.io,
      });
      expect(secondCode).toBe(ADVISORY_GRADE_EXIT.conflict);
      expect(second.out()).toContain("already graded");
      const after = await readCalibrationJournal(root);
      expect(
        after.filter((entry) => entry.kind === "structural_advisory_grade"),
      ).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
