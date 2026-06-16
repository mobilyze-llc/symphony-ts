import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { BacklogAuditFinding } from "../../src/audit/backlog-audit.js";
import {
  CODE_GROUNDING_CHECKOUT_RETENTION_POLICY,
  CODE_GROUNDING_CLONE_SOURCE_POLICY,
  CODE_GROUNDING_CONTENTION_POLICY,
  CODE_GROUNDING_LOCK_DOMAIN,
  CODE_GROUNDING_SUPPORTED_PATH_PREFIXES,
  CODE_GROUNDING_SYMBOL_PRECISION,
  decideCodeGroundingEvidenceStatus,
  getCodeGroundingMutexRegistrySizesForTests,
  removeAbandonedCodeGroundingFileLock,
  resolveCodeGroundingPaths,
  runManagedCodeGrounding,
  sweepCodeGroundingCheckouts,
  validateModelFindingAgainstEvidence,
} from "../../src/orchestrator/code-grounding.js";

const execFileAsync = promisify(execFile);

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("managed code grounding (SYMPH-596)", () => {
  it("publishes the v1 grounding policy contracts for reviewers and callers", () => {
    expect(CODE_GROUNDING_SYMBOL_PRECISION).toBe(
      "textual_declaration_regex_after_comment_literal_stripping_scoped_to_cited_path",
    );
    expect(CODE_GROUNDING_CHECKOUT_RETENTION_POLICY).toBe(
      "delete_expired_or_lru_over_cap_unless_live_lock_owner",
    );
    expect(CODE_GROUNDING_CONTENTION_POLICY).toBe(
      "serialize_same_process_wait_cross_process_file_lock_then_timeout",
    );
    expect(CODE_GROUNDING_LOCK_DOMAIN).toBe(
      "code_grounding_separate_from_dispatcher_journal",
    );
    expect(CODE_GROUNDING_CLONE_SOURCE_POLICY).toBe(
      "clone_from_target_source_path_for_tests_otherwise_repo_url",
    );
    expect(CODE_GROUNDING_SUPPORTED_PATH_PREFIXES).toEqual([
      "src",
      "tests",
      "docs",
      "skills",
      "scripts",
      "apps",
    ]);
  });

  it("keeps the deterministic and model status decision table explicit", () => {
    expect(
      decideCodeGroundingEvidenceStatus({
        deterministicStatus: "verified",
        modelClaimStatus: "absent",
      }),
    ).toBe("verified");
    expect(
      decideCodeGroundingEvidenceStatus({
        deterministicStatus: "verified",
        modelClaimStatus: "verified",
      }),
    ).toBe("model_suggested_verified");
    expect(
      decideCodeGroundingEvidenceStatus({
        deterministicStatus: "verified",
        modelClaimStatus: "unverified",
      }),
    ).toBe("model_argued_unverified");
    expect(
      decideCodeGroundingEvidenceStatus({
        deterministicStatus: "not_found",
        modelClaimStatus: "verified",
      }),
    ).toBe("model_argued_unverified");
    expect(
      decideCodeGroundingEvidenceStatus({
        deterministicStatus: "contradicted",
        modelClaimStatus: "verified",
      }),
    ).toBe("model_argued_unverified");
  });

  it("verifies extracted path and symbol evidence in a managed checkout", async () => {
    const sourceRepo = await createSourceRepo();
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const commitSha = await git(sourceRepo, ["rev-parse", "HEAD"]);
    const finding = backlogFinding({
      evidence:
        "Implemented in `src/orchestrator/queue.ts` via `runQueueTriage`.",
    });
    let lockOwnerSeen = false;

    const report = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "run-1",
      config: codeGroundingConfig(),
      target: {
        repoUrl: sourceRepo,
        sourcePath: sourceRepo,
        commitSha,
        repoScope: "symphony",
      },
      findings: [finding],
      afterDeterministicScan: async ({ checkoutId }) => {
        const owner = await readFile(
          join(
            workspaceRoot,
            ".symphony",
            "code-grounding",
            "checkouts",
            `${checkoutId}.lock`,
            "owner.json",
          ),
          "utf8",
        );
        lockOwnerSeen = owner.includes("ownerToken");
      },
    });

    expect(report.status).toBe("verified");
    expect(lockOwnerSeen).toBe(true);
    expect(report.cleanup.leaseReleased).toBe(true);
    expect(report.checkout.checkoutId).toMatch(/^cg-[a-f0-9]{32}$/);
    expect(report.checkout.path).toContain(
      join(workspaceRoot, ".symphony", "code-grounding", "checkouts"),
    );
    expect(report.entries[0]).toMatchObject({
      findingId: "F-1",
      status: "verified",
      missing: [],
    });
    expect(
      report.entries[0]?.citations.map((citation) => citation.path),
    ).toEqual(expect.arrayContaining(["src/orchestrator/queue.ts"]));
    await expect(
      readdir(join(workspaceRoot, ".symphony", "code-grounding", "artifacts")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const leaseIndex = JSON.parse(
      await readFile(
        join(workspaceRoot, ".symphony", "code-grounding", "leases.json"),
        "utf8",
      ),
    ) as {
      checkouts: Record<string, { activeRunIds: string[] }>;
    };
    expect(
      leaseIndex.checkouts[report.checkout.checkoutId!]?.activeRunIds,
    ).toEqual([]);
    await expect(
      readFile(
        join(
          workspaceRoot,
          ".symphony",
          "code-grounding",
          "checkouts",
          `${report.checkout.checkoutId}.lock`,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(
        join(workspaceRoot, ".symphony", "code-grounding", "leases.lock"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns not_attempted for non-Symphony repositories without checkout side effects", async () => {
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const report = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "run-non-symphony",
      config: codeGroundingConfig(),
      target: {
        repoUrl: "https://example.com/other.git",
        commitSha: "abc123",
        repoScope: "non_symphony",
      },
      findings: [backlogFinding()],
    });

    expect(report.status).toBe("not_attempted");
    expect(report.checkout.checkoutId).toBeNull();
    await expect(
      readFile(
        join(workspaceRoot, ".symphony", "code-grounding", "leases.json"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns not_attempted when code grounding is disabled without checkout side effects", async () => {
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const report = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "run-disabled",
      config: { ...codeGroundingConfig(), enabled: false },
      target: {
        repoUrl: "https://github.com/mobilyze-llc/symphony-ts.git",
        commitSha: "abc123",
        repoScope: "symphony",
      },
      findings: [backlogFinding()],
    });

    expect(report.status).toBe("not_attempted");
    expect(report.warnings).toEqual(["code grounding disabled"]);
    await expect(
      readFile(
        join(workspaceRoot, ".symphony", "code-grounding", "leases.json"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects dangerous git transports and option-shaped revisions before invoking git", async () => {
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const commandRunner = vi.fn();

    const dangerousTransport = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "dangerous-transport-run",
      config: codeGroundingConfig(),
      target: {
        repoUrl: "ext::sh -c touch /tmp/symphony-owned",
        commitSha: "abc123",
        repoScope: "symphony",
      },
      findings: [backlogFinding({ evidence: "`src/orchestrator/queue.ts`" })],
      commandRunner,
    });
    const optionRevision = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "option-revision-run",
      config: codeGroundingConfig(),
      target: {
        repoUrl: "https://github.com/mobilyze-llc/symphony-ts.git",
        commitSha: "--upload-pack=sh",
        repoScope: "symphony",
      },
      findings: [backlogFinding({ evidence: "`src/orchestrator/queue.ts`" })],
      commandRunner,
    });
    const optionSourcePath = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "option-source-run",
      config: codeGroundingConfig(),
      target: {
        repoUrl: "https://github.com/mobilyze-llc/symphony-ts.git",
        sourcePath: "--upload-pack=sh",
        commitSha: "abc123",
        repoScope: "symphony",
      },
      findings: [backlogFinding({ evidence: "`src/orchestrator/queue.ts`" })],
      commandRunner,
    });
    const controlSourcePath = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "control-source-run",
      config: codeGroundingConfig(),
      target: {
        repoUrl: "https://github.com/mobilyze-llc/symphony-ts.git",
        sourcePath: "/tmp/source\n--upload-pack=sh",
        commitSha: "abc123",
        repoScope: "symphony",
      },
      findings: [backlogFinding({ evidence: "`src/orchestrator/queue.ts`" })],
      commandRunner,
    });
    const blankSourcePath = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "blank-source-run",
      config: codeGroundingConfig(),
      target: {
        repoUrl: "https://github.com/mobilyze-llc/symphony-ts.git",
        sourcePath: "",
        commitSha: "abc123",
        repoScope: "symphony",
      },
      findings: [backlogFinding({ evidence: "`src/orchestrator/queue.ts`" })],
      commandRunner,
    });
    const tabSourcePath = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "tab-source-run",
      config: codeGroundingConfig(),
      target: {
        repoUrl: "https://github.com/mobilyze-llc/symphony-ts.git",
        sourcePath: "/tmp/source\twith-tab",
        commitSha: "abc123",
        repoScope: "symphony",
      },
      findings: [backlogFinding({ evidence: "`src/orchestrator/queue.ts`" })],
      commandRunner,
    });
    const delSourcePath = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "del-source-run",
      config: codeGroundingConfig(),
      target: {
        repoUrl: "https://github.com/mobilyze-llc/symphony-ts.git",
        sourcePath: "/tmp/source\u007fwith-del",
        commitSha: "abc123",
        repoScope: "symphony",
      },
      findings: [backlogFinding({ evidence: "`src/orchestrator/queue.ts`" })],
      commandRunner,
    });

    expect(commandRunner).not.toHaveBeenCalled();
    expect(dangerousTransport).toMatchObject({
      status: "not_attempted",
      warnings: ["code-grounding target repoUrl uses an unsupported transport"],
    });
    expect(optionRevision).toMatchObject({
      status: "not_attempted",
      warnings: [
        "code-grounding target commitSha is option-shaped and was rejected",
      ],
    });
    expect(optionSourcePath).toMatchObject({
      status: "not_attempted",
      warnings: [
        "code-grounding target sourcePath is option-shaped and was rejected",
      ],
    });
    expect(controlSourcePath).toMatchObject({
      status: "not_attempted",
      warnings: [
        "code-grounding target sourcePath is option-shaped and was rejected",
      ],
    });
    expect(blankSourcePath).toMatchObject({
      status: "not_attempted",
      warnings: [
        "code-grounding target sourcePath is option-shaped and was rejected",
      ],
    });
    expect(tabSourcePath).toMatchObject({
      status: "not_attempted",
      warnings: [
        "code-grounding target sourcePath is option-shaped and was rejected",
      ],
    });
    expect(delSourcePath).toMatchObject({
      status: "not_attempted",
      warnings: [
        "code-grounding target sourcePath is option-shaped and was rejected",
      ],
    });
  });

  it("records the current lease before sweeping stale records for the same checkout", async () => {
    const sourceRepo = await createSourceRepo();
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const commitSha = await git(sourceRepo, ["rev-parse", "HEAD"]);
    const target = {
      repoUrl: sourceRepo,
      sourcePath: sourceRepo,
      commitSha,
      repoScope: "symphony" as const,
    };
    const paths = resolveCodeGroundingPaths({
      workspaceRoot,
      runId: "same-checkout-sweep-run",
      config: codeGroundingConfig(),
      target,
    });
    await mkdir(paths.baseRoot, { recursive: true });
    await writeFile(
      paths.leaseIndexPath,
      `${JSON.stringify(
        {
          version: 1,
          checkouts: {
            [paths.checkoutId]: {
              checkoutId: paths.checkoutId,
              repoUrl: target.repoUrl,
              commitSha,
              checkoutPath: paths.checkoutPath,
              artifactRoot: join(
                paths.artifactsRoot,
                "same-checkout-sweep-run",
              ),
              createdAt: "2026-06-13T00:00:00.000Z",
              lastUsedAt: "2026-06-13T00:00:00.000Z",
              activeRunIds: [],
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    let lockOwnerSeen = false;

    const report = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "same-checkout-sweep-run",
      config: { ...codeGroundingConfig(), ttlMs: 1 },
      target,
      findings: [backlogFinding({ evidence: "`src/orchestrator/queue.ts`" })],
      afterDeterministicScan: async ({ checkoutId }) => {
        const owner = await readFile(
          join(paths.checkoutsRoot, `${checkoutId}.lock`, "owner.json"),
          "utf8",
        );
        lockOwnerSeen = owner.includes("ownerToken");
      },
    });

    expect(report.status).toBe("verified");
    expect(lockOwnerSeen).toBe(true);
  });

  it("does not reserve per-run artifact roots for new managed grounding leases", async () => {
    const sourceRepo = await createSourceRepo();
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const commitSha = await git(sourceRepo, ["rev-parse", "HEAD"]);

    const report = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "no-artifact-reservation-run",
      config: codeGroundingConfig(),
      target: {
        repoUrl: sourceRepo,
        sourcePath: sourceRepo,
        commitSha,
        repoScope: "symphony",
      },
      findings: [backlogFinding({ evidence: "`src/orchestrator/queue.ts`" })],
    });
    const leaseIndex = JSON.parse(
      await readFile(
        join(workspaceRoot, ".symphony", "code-grounding", "leases.json"),
        "utf8",
      ),
    ) as {
      checkouts: Record<string, { artifactRoot?: unknown }>;
    };

    expect(report.status).toBe("verified");
    expect(
      leaseIndex.checkouts[report.checkout.checkoutId ?? ""]?.artifactRoot,
    ).toBeUndefined();
  });

  it("purges a checkout that becomes dirty during the read-only scan", async () => {
    const sourceRepo = await createSourceRepo();
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const commitSha = await git(sourceRepo, ["rev-parse", "HEAD"]);

    const report = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "dirty-run",
      config: codeGroundingConfig(),
      target: {
        repoUrl: sourceRepo,
        sourcePath: sourceRepo,
        commitSha,
        repoScope: "symphony",
      },
      findings: [backlogFinding({ evidence: "`src/orchestrator/queue.ts`" })],
      afterDeterministicScan: async ({ checkoutPath }) => {
        await writeFile(join(checkoutPath, "dirty.txt"), "mutated");
      },
    });

    expect(report.status).toBe("contaminated");
    expect(report.cleanup.checkoutPurged).toBe(true);
    expect(report.cleanup.dirtyState?.porcelain).toContain("dirty.txt");
    await expect(readFile(report.checkout.path!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("verifies exact cited paths even when the scanner would not index the file", async () => {
    const sourceRepo = await createSourceRepo();
    await writeFile(
      join(sourceRepo, "src", "orchestrator", "queue.go"),
      [
        "package orchestrator",
        "",
        "func RunQueueTriage() string {",
        '  return "grounded"',
        "}",
        "",
      ].join("\n"),
    );
    await git(sourceRepo, ["add", "."]);
    await git(sourceRepo, ["commit", "-m", "Add Go evidence"]);
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const commitSha = await git(sourceRepo, ["rev-parse", "HEAD"]);

    const report = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "exact-path-run",
      config: codeGroundingConfig(),
      target: {
        repoUrl: sourceRepo,
        sourcePath: sourceRepo,
        commitSha,
        repoScope: "symphony",
      },
      findings: [
        backlogFinding({
          evidence: "Implemented in `src/orchestrator/queue.go`.",
        }),
      ],
    });

    expect(report.status).toBe("verified");
    expect(report.entries[0]).toMatchObject({
      status: "verified",
      missing: [],
    });
    expect(report.entries[0]?.citations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/orchestrator/queue.go" }),
      ]),
    );
  });

  it("verifies supported line-range citation forms", async () => {
    const sourceRepo = await createSourceRepo();
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const commitSha = await git(sourceRepo, ["rev-parse", "HEAD"]);

    const report = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "line-range-citations-run",
      config: codeGroundingConfig(),
      target: {
        repoUrl: sourceRepo,
        sourcePath: sourceRepo,
        commitSha,
        repoScope: "symphony",
      },
      findings: [
        backlogFinding({
          evidence: [
            "Implemented in `src/orchestrator/queue.ts:1`.",
            "Reviewed in `src/orchestrator/queue.ts:1:3`.",
            "Column form `src/orchestrator/queue.ts:2:1`.",
            "Covered by `src/orchestrator/queue.ts:1-3`.",
            "Linked at `src/orchestrator/queue.ts#L1`.",
            "Linked range `src/orchestrator/queue.ts#L1-L3`.",
          ].join(" "),
        }),
      ],
    });

    expect(report.status).toBe("verified");
    expect(
      report.entries[0]?.citations.map((citation) => [
        citation.matchedSpan,
        citation.lineRange,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["src/orchestrator/queue.ts:1", [1, 1]],
        ["src/orchestrator/queue.ts:1:3", [1, 3]],
        ["src/orchestrator/queue.ts:2:1", [2, 2]],
        ["src/orchestrator/queue.ts:1-3", [1, 3]],
        ["src/orchestrator/queue.ts#L1", [1, 1]],
        ["src/orchestrator/queue.ts#L1-L3", [1, 3]],
      ]),
    );
  });

  it("rejects unsupported line citation forms deterministically", async () => {
    const sourceRepo = await createSourceRepo();
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const commitSha = await git(sourceRepo, ["rev-parse", "HEAD"]);

    const report = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "invalid-citation-form-run",
      config: codeGroundingConfig(),
      target: {
        repoUrl: sourceRepo,
        sourcePath: sourceRepo,
        commitSha,
        repoScope: "symphony",
      },
      findings: [
        backlogFinding({
          evidence: "Malformed citation `src/orchestrator/queue.ts#L1-Lx`.",
        }),
      ],
    });

    expect(report.status).toBe("not_found");
    expect(report.entries[0]).toMatchObject({
      status: "not_found",
      citations: [],
      missing: ["src/orchestrator/queue.ts#L1-Lx"],
    });
  });

  it("does not index extensionless files for v1 symbol-only grounding", async () => {
    const sourceRepo = await createSourceRepo();
    await writeFile(
      join(sourceRepo, "src", "orchestrator", "Makefile"),
      "export const HiddenSymbol = true;\n",
    );
    await git(sourceRepo, ["add", "."]);
    await git(sourceRepo, ["commit", "-m", "Add extensionless evidence"]);
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const commitSha = await git(sourceRepo, ["rev-parse", "HEAD"]);

    const report = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "extensionless-symbol-run",
      config: codeGroundingConfig(),
      target: {
        repoUrl: sourceRepo,
        sourcePath: sourceRepo,
        commitSha,
        repoScope: "symphony",
      },
      findings: [
        backlogFinding({
          evidence: "Implemented via `HiddenSymbol`.",
        }),
      ],
    });

    expect(report.status).toBe("not_found");
    expect(report.entries[0]).toMatchObject({
      status: "not_found",
      missing: ["HiddenSymbol"],
    });
  });

  it("surfaces a warning when the scan index reaches the file cap", async () => {
    const sourceRepo = await createSourceRepo();
    await mkdir(join(sourceRepo, "src", "many"), { recursive: true });
    await Promise.all(
      Array.from({ length: 501 }, (_, index) =>
        writeFile(
          join(sourceRepo, "src", "many", `file-${index}.ts`),
          `export const cappedSymbol${index} = true;\n`,
        ),
      ),
    );
    await git(sourceRepo, ["add", "."]);
    await git(sourceRepo, ["commit", "-m", "Add many scan files"]);
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const commitSha = await git(sourceRepo, ["rev-parse", "HEAD"]);

    const report = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "scan-cap-run",
      config: codeGroundingConfig(),
      target: {
        repoUrl: sourceRepo,
        sourcePath: sourceRepo,
        commitSha,
        repoScope: "symphony",
      },
      findings: [backlogFinding()],
    });

    expect(report.warnings).toContain(
      "code-grounding scan reached 500 file cap; path and symbol index truncated",
    );
  });

  it("rejects line-suffixed path evidence when the cited line is outside the file", async () => {
    const sourceRepo = await createSourceRepo();
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const commitSha = await git(sourceRepo, ["rev-parse", "HEAD"]);

    const report = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "invalid-line-run",
      config: codeGroundingConfig(),
      target: {
        repoUrl: sourceRepo,
        sourcePath: sourceRepo,
        commitSha,
        repoScope: "symphony",
      },
      findings: [
        backlogFinding({
          evidence: "Implemented in `src/orchestrator/queue.ts:999999`.",
        }),
      ],
    });

    expect(report.status).toBe("not_found");
    expect(report.entries[0]).toMatchObject({
      status: "not_found",
      citations: [],
      missing: ["src/orchestrator/queue.ts:999999"],
    });
  });

  it("does not verify noncanonical repo-relative path evidence after filesystem resolution", async () => {
    const sourceRepo = await createSourceRepo();
    await writeFile(join(sourceRepo, "package.json"), '{"private":true}\n');
    await git(sourceRepo, ["add", "."]);
    await git(sourceRepo, ["commit", "-m", "Add package manifest"]);
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const commitSha = await git(sourceRepo, ["rev-parse", "HEAD"]);

    const report = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "noncanonical-path-run",
      config: codeGroundingConfig(),
      target: {
        repoUrl: sourceRepo,
        sourcePath: sourceRepo,
        commitSha,
        repoScope: "symphony",
      },
      findings: [
        backlogFinding({
          evidence: "Implemented in `src/../package.json`.",
        }),
      ],
    });

    expect(report.status).toBe("not_found");
    expect(report.entries[0]).toMatchObject({
      status: "not_found",
      citations: [],
      missing: ["src/../package.json"],
    });
  });

  it("keeps symbol verification scoped to cited paths when both are claimed", async () => {
    const sourceRepo = await createSourceRepo();
    await writeFile(
      join(sourceRepo, "src", "orchestrator", "core.ts"),
      "export const runCore = true;\n",
    );
    await git(sourceRepo, ["add", "."]);
    await git(sourceRepo, ["commit", "-m", "Add core module"]);
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const commitSha = await git(sourceRepo, ["rev-parse", "HEAD"]);

    const report = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "path-symbol-scope-run",
      config: codeGroundingConfig(),
      target: {
        repoUrl: sourceRepo,
        sourcePath: sourceRepo,
        commitSha,
        repoScope: "symphony",
      },
      findings: [
        backlogFinding({
          evidence:
            "Implemented in `src/orchestrator/core.ts` via `runQueueTriage`.",
        }),
      ],
    });

    expect(report.status).toBe("contradicted");
    expect(report.entries[0]).toMatchObject({
      status: "contradicted",
      missing: ["runQueueTriage"],
    });
    expect(report.entries[0]?.citations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/orchestrator/core.ts" }),
      ]),
    );
  });

  it("rejects exact cited paths that are symlinks out of the checkout", async () => {
    const sourceRepo = await createSourceRepo();
    const outsideRoot = await tempRoot("symph-cg-outside-");
    await writeFile(
      join(outsideRoot, "escape.ts"),
      "export const escape = true;\n",
    );
    await symlink(
      join(outsideRoot, "escape.ts"),
      join(sourceRepo, "src", "orchestrator", "escape.ts"),
    );
    await git(sourceRepo, ["add", "."]);
    await git(sourceRepo, ["commit", "-m", "Add symlink evidence"]);
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const commitSha = await git(sourceRepo, ["rev-parse", "HEAD"]);

    const report = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "symlink-run",
      config: codeGroundingConfig(),
      target: {
        repoUrl: sourceRepo,
        sourcePath: sourceRepo,
        commitSha,
        repoScope: "symphony",
      },
      findings: [
        backlogFinding({
          evidence: "Implemented in `src/orchestrator/escape.ts`.",
        }),
      ],
    });

    expect(report.status).toBe("not_found");
    expect(report.entries[0]).toMatchObject({
      status: "not_found",
      citations: [],
      missing: ["src/orchestrator/escape.ts"],
    });
  });

  it("rejects exact cited paths that escape through symlinked directories", async () => {
    const sourceRepo = await createSourceRepo();
    const outsideRoot = await tempRoot("symph-cg-outside-");
    await mkdir(join(outsideRoot, "linked"), { recursive: true });
    await writeFile(
      join(outsideRoot, "linked", "secret.ts"),
      "export const secret = true;\n",
    );
    await symlink(
      join(outsideRoot, "linked"),
      join(sourceRepo, "src", "linked"),
    );
    await git(sourceRepo, ["add", "."]);
    await git(sourceRepo, ["commit", "-m", "Add symlink directory evidence"]);
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const commitSha = await git(sourceRepo, ["rev-parse", "HEAD"]);

    const report = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "symlink-directory-run",
      config: codeGroundingConfig(),
      target: {
        repoUrl: sourceRepo,
        sourcePath: sourceRepo,
        commitSha,
        repoScope: "symphony",
      },
      findings: [
        backlogFinding({
          evidence: "Implemented in `src/linked/secret.ts`.",
        }),
      ],
    });

    expect(report.status).toBe("not_found");
    expect(report.entries[0]).toMatchObject({
      status: "not_found",
      citations: [],
      missing: ["src/linked/secret.ts"],
    });
  });

  it("does not index symbols through symlinked directories", async () => {
    const sourceRepo = await createSourceRepo();
    const outsideRoot = await tempRoot("symph-cg-outside-");
    await mkdir(join(outsideRoot, "linked"), { recursive: true });
    await writeFile(
      join(outsideRoot, "linked", "secret.ts"),
      "export const secretSymbol = true;\n",
    );
    await symlink(
      join(outsideRoot, "linked"),
      join(sourceRepo, "src", "linked"),
    );
    await git(sourceRepo, ["add", "."]);
    await git(sourceRepo, ["commit", "-m", "Add symlink directory symbol"]);
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const commitSha = await git(sourceRepo, ["rev-parse", "HEAD"]);

    const report = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "symlink-directory-symbol-run",
      config: codeGroundingConfig(),
      target: {
        repoUrl: sourceRepo,
        sourcePath: sourceRepo,
        commitSha,
        repoScope: "symphony",
      },
      findings: [
        backlogFinding({
          evidence: "Implemented via `secretSymbol`.",
        }),
      ],
    });

    expect(report.status).toBe("not_found");
    expect(report.entries[0]).toMatchObject({
      status: "not_found",
      citations: [],
      missing: ["secretSymbol"],
    });
  });

  it("does not verify symbols declared only inside comments or string literals", async () => {
    const sourceRepo = await createSourceRepo();
    await writeFile(
      join(sourceRepo, "src", "orchestrator", "symbols.ts"),
      [
        "// export function CommentOnlySymbol() {}",
        "/* export function BlockCommentOnlySymbol() {} */",
        'const source = "export class StringOnlySymbol {}";',
        "const template = `export const TemplateOnlySymbol = true;`;",
        "const matcher = /['\"]/;",
        "export function AfterRegexSymbol() {",
        "  return matcher.test(source);",
        "}",
        "export function RealSymbol() {",
        "  return source + template + String(AfterRegexSymbol);",
        "}",
        "",
      ].join("\n"),
    );
    await git(sourceRepo, ["add", "."]);
    await git(sourceRepo, ["commit", "-m", "Add symbol extraction cases"]);
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const commitSha = await git(sourceRepo, ["rev-parse", "HEAD"]);

    const report = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "symbol-false-positive-run",
      config: codeGroundingConfig(),
      target: {
        repoUrl: sourceRepo,
        sourcePath: sourceRepo,
        commitSha,
        repoScope: "symphony",
      },
      findings: [
        backlogFinding({
          findingId: "F-comment",
          evidence: "Implemented via `CommentOnlySymbol`.",
        }),
        backlogFinding({
          findingId: "F-string",
          evidence: "Implemented via `StringOnlySymbol`.",
        }),
        backlogFinding({
          findingId: "F-block-comment",
          evidence: "Implemented via `BlockCommentOnlySymbol`.",
        }),
        backlogFinding({
          findingId: "F-template",
          evidence: "Implemented via `TemplateOnlySymbol`.",
        }),
        backlogFinding({
          findingId: "F-after-regex",
          evidence: "Implemented via `AfterRegexSymbol`.",
        }),
        backlogFinding({
          findingId: "F-real",
          evidence: "Implemented via `RealSymbol`.",
        }),
      ],
    });

    expect(report.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          findingId: "F-comment",
          status: "not_found",
          missing: ["CommentOnlySymbol"],
        }),
        expect.objectContaining({
          findingId: "F-string",
          status: "not_found",
          missing: ["StringOnlySymbol"],
        }),
        expect.objectContaining({
          findingId: "F-block-comment",
          status: "not_found",
          missing: ["BlockCommentOnlySymbol"],
        }),
        expect.objectContaining({
          findingId: "F-template",
          status: "not_found",
          missing: ["TemplateOnlySymbol"],
        }),
        expect.objectContaining({
          findingId: "F-after-regex",
          status: "verified",
          missing: [],
        }),
        expect.objectContaining({
          findingId: "F-real",
          status: "verified",
          missing: [],
        }),
      ]),
    );
  });

  it("does not treat division after object literals as a regex that hides later declarations", async () => {
    const sourceRepo = await createSourceRepo();
    await writeFile(
      join(sourceRepo, "src", "orchestrator", "division.ts"),
      [
        "const denominator = 2;",
        "const ratio = { value: 8 } / denominator;",
        "export function AfterObjectDivisionSymbol() {",
        "  return String(ratio);",
        "}",
        "",
      ].join("\n"),
    );
    await git(sourceRepo, ["add", "."]);
    await git(sourceRepo, ["commit", "-m", "Add object division symbol"]);
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const commitSha = await git(sourceRepo, ["rev-parse", "HEAD"]);

    const report = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "object-division-symbol-run",
      config: codeGroundingConfig(),
      target: {
        repoUrl: sourceRepo,
        sourcePath: sourceRepo,
        commitSha,
        repoScope: "symphony",
      },
      findings: [
        backlogFinding({
          evidence: "Implemented via `AfterObjectDivisionSymbol`.",
        }),
      ],
    });

    expect(report.entries[0]).toMatchObject({
      status: "verified",
      missing: [],
    });
  });

  it("replaces an unusable cached checkout before scanning", async () => {
    const sourceRepo = await createSourceRepo();
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const commitSha = await git(sourceRepo, ["rev-parse", "HEAD"]);
    const target = {
      repoUrl: sourceRepo,
      sourcePath: sourceRepo,
      commitSha,
      repoScope: "symphony" as const,
    };
    const paths = resolveCodeGroundingPaths({
      workspaceRoot,
      runId: "broken-checkout-run",
      config: codeGroundingConfig(),
      target,
    });
    await mkdir(paths.checkoutPath, { recursive: true });
    await writeFile(join(paths.checkoutPath, "partial.txt"), "not a git repo");

    const report = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "broken-checkout-run",
      config: codeGroundingConfig(),
      target,
      findings: [backlogFinding({ evidence: "`src/orchestrator/queue.ts`" })],
    });

    expect(report.status).toBe("verified");
    await expect(
      realpath(await git(paths.checkoutPath, ["rev-parse", "--show-toplevel"])),
    ).resolves.toBe(await realpath(paths.checkoutPath));
    await expect(
      readFile(join(paths.checkoutPath, "partial.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers malformed stale checkout lock owners during acquisition", async () => {
    const sourceRepo = await createSourceRepo();
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const commitSha = await git(sourceRepo, ["rev-parse", "HEAD"]);
    const target = {
      repoUrl: sourceRepo,
      sourcePath: sourceRepo,
      commitSha,
      repoScope: "symphony" as const,
    };
    const paths = resolveCodeGroundingPaths({
      workspaceRoot,
      runId: "malformed-owner-run",
      config: codeGroundingConfig(),
      target,
    });
    const lockPath = join(paths.checkoutsRoot, `${paths.checkoutId}.lock`);
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, "owner.json"), "{");
    const staleTime = new Date(Date.now() - 2 * 60 * 60_000);
    await utimes(lockPath, staleTime, staleTime);

    const report = await runManagedCodeGrounding({
      workspaceRoot,
      runId: "malformed-owner-run",
      config: codeGroundingConfig(),
      target,
      findings: [backlogFinding({ evidence: "`src/orchestrator/queue.ts`" })],
    });

    expect(report.status).toBe("verified");
    expect(report.cleanup.leaseReleased).toBe(true);
  });

  it("does not delete a fresh lock that replaces a stale owner during recovery", async () => {
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const lockPath = join(
      workspaceRoot,
      ".symphony",
      "code-grounding",
      "checkouts",
      "cg-racy.lock",
    );
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: 999_999_999,
        ownerToken: "stale-owner",
        acquiredAt: "2026-06-15T00:00:00.000Z",
      })}\n`,
    );
    const staleTime = new Date(Date.now() - 2 * 60 * 60_000);
    await utimes(lockPath, staleTime, staleTime);
    await expect(
      removeAbandonedCodeGroundingFileLock(lockPath, {
        beforeRecoveryRename: async () => {
          await writeFile(
            join(lockPath, "owner.json"),
            `${JSON.stringify({
              pid: process.pid,
              ownerToken: "fresh-owner",
              acquiredAt: new Date().toISOString(),
            })}\n`,
          );
          const freshTime = new Date();
          await utimes(lockPath, freshTime, freshTime);
        },
      }),
    ).resolves.toBe(false);

    await expect(
      readFile(join(lockPath, "owner.json"), "utf8"),
    ).resolves.toContain("fresh-owner");
  });

  it("reaps old lock tombstones without deleting fresh tombstones or live locks", async () => {
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const baseRoot = join(workspaceRoot, ".symphony", "code-grounding");
    const checkoutsRoot = join(baseRoot, "checkouts");
    const oldBaseTombstone = join(
      baseRoot,
      "leases.lock.stale-123-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    );
    const oldCheckoutTombstone = join(
      checkoutsRoot,
      "cg-old.lock.stale-123-bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
    );
    const freshCheckoutTombstone = join(
      checkoutsRoot,
      "cg-fresh.lock.stale-123-cccccccc-cccc-4ccc-cccc-cccccccccccc",
    );
    const liveLock = join(checkoutsRoot, "cg-live.lock");
    await mkdir(oldBaseTombstone, { recursive: true });
    await mkdir(oldCheckoutTombstone, { recursive: true });
    await mkdir(freshCheckoutTombstone, { recursive: true });
    await mkdir(liveLock, { recursive: true });
    await writeFile(join(liveLock, "owner.json"), "{}\n");
    // ctime is not directly settable; the future clock makes just-created
    // old tombstones old by ctime while fresh mtime tombstones stay young.
    const now = new Date(Date.now() + 2 * 60 * 60_000);
    const oldTime = new Date("2026-06-13T00:00:00.000Z");
    const freshTime = new Date(now.getTime() - 60_000);
    await utimes(oldBaseTombstone, oldTime, oldTime);
    await utimes(oldCheckoutTombstone, oldTime, oldTime);
    await utimes(freshCheckoutTombstone, freshTime, freshTime);

    await sweepCodeGroundingCheckouts({
      workspaceRoot,
      config: codeGroundingConfig(),
      now,
    });

    await expect(
      readFile(join(oldBaseTombstone, "owner.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(oldCheckoutTombstone, "owner.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(freshCheckoutTombstone)).resolves.toEqual([]);
    await expect(readFile(join(liveLock, "owner.json"), "utf8")).resolves.toBe(
      "{}\n",
    );
  });

  it("preserves backdated lock tombstones until their rename ctime is stale", async () => {
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const baseRoot = join(workspaceRoot, ".symphony", "code-grounding");
    const checkoutsRoot = join(baseRoot, "checkouts");
    const backdatedTombstone = join(
      checkoutsRoot,
      "cg-backdated.lock.stale-123-dddddddd-dddd-4ddd-dddd-dddddddddddd",
    );
    await mkdir(backdatedTombstone, { recursive: true });
    const oldTime = new Date("2026-06-13T00:00:00.000Z");
    await utimes(backdatedTombstone, oldTime, oldTime);
    const now = new Date(Date.now() + 5 * 60_000);

    await sweepCodeGroundingCheckouts({
      workspaceRoot,
      config: codeGroundingConfig(),
      now,
    });

    await expect(readdir(backdatedTombstone)).resolves.toEqual([]);
  });

  it("fails loudly instead of resetting malformed lease indexes", async () => {
    const sourceRepo = await createSourceRepo();
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const commitSha = await git(sourceRepo, ["rev-parse", "HEAD"]);
    await mkdir(join(workspaceRoot, ".symphony", "code-grounding"), {
      recursive: true,
    });
    await writeFile(
      join(workspaceRoot, ".symphony", "code-grounding", "leases.json"),
      '{"version":1,"checkouts":"oops"}\n',
    );

    await expect(
      runManagedCodeGrounding({
        workspaceRoot,
        runId: "malformed-lease-run",
        config: codeGroundingConfig(),
        target: {
          repoUrl: sourceRepo,
          sourcePath: sourceRepo,
          commitSha,
          repoScope: "symphony",
        },
        findings: [backlogFinding({ evidence: "`src/orchestrator/queue.ts`" })],
      }),
    ).rejects.toThrow("Invalid code-grounding lease index");

    expect(
      await readFile(
        join(workspaceRoot, ".symphony", "code-grounding", "leases.json"),
        "utf8",
      ),
    ).toBe('{"version":1,"checkouts":"oops"}\n');
  });

  it("serializes concurrent scans that share the same managed checkout", async () => {
    const sourceRepo = await createSourceRepo();
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const commitSha = await git(sourceRepo, ["rev-parse", "HEAD"]);
    let activeScans = 0;
    let maxActiveScans = 0;

    const run = (runId: string) =>
      runManagedCodeGrounding({
        workspaceRoot,
        runId,
        config: codeGroundingConfig(),
        target: {
          repoUrl: sourceRepo,
          sourcePath: sourceRepo,
          commitSha,
          repoScope: "symphony",
        },
        findings: [
          backlogFinding({
            evidence:
              "Implemented in `src/orchestrator/queue.ts` via `runQueueTriage`.",
          }),
        ],
        afterDeterministicScan: async () => {
          activeScans++;
          maxActiveScans = Math.max(maxActiveScans, activeScans);
          await delay(25);
          activeScans--;
        },
      });

    const [first, second] = await Promise.all([run("run-a"), run("run-b")]);

    expect(first.status).toBe("verified");
    expect(second.status).toBe("verified");
    expect(maxActiveScans).toBe(1);
    expect(getCodeGroundingMutexRegistrySizesForTests()).toEqual({
      lease: 0,
      checkout: 0,
    });
  });

  it("evicts code-grounding mutex registry entries across distinct workspace roots", async () => {
    const sourceRepo = await createSourceRepo();
    const commitSha = await git(sourceRepo, ["rev-parse", "HEAD"]);

    for (let index = 0; index < 3; index++) {
      const workspaceRoot = await tempRoot(`symph-cg-workspace-${index}-`);
      const report = await runManagedCodeGrounding({
        workspaceRoot,
        runId: `registry-eviction-${index}`,
        config: codeGroundingConfig(),
        target: {
          repoUrl: sourceRepo,
          sourcePath: sourceRepo,
          commitSha,
          repoScope: "symphony",
        },
        findings: [
          backlogFinding({
            evidence:
              "Implemented in `src/orchestrator/queue.ts` via `runQueueTriage`.",
          }),
        ],
      });

      expect(report.status).toBe("verified");
    }

    expect(getCodeGroundingMutexRegistrySizesForTests()).toEqual({
      lease: 0,
      checkout: 0,
    });
  });

  it("downgrades model verification when deterministic evidence did not verify it", () => {
    const downgraded = validateModelFindingAgainstEvidence({
      deterministic: {
        findingId: "F-1",
        status: "not_found",
        summary: "No symbols found",
        citations: [],
        missing: ["MissingSymbol"],
      },
      modelFinding: {
        findingId: "F-1",
        status: "verified",
        summary: "Model says this exists",
      },
    });

    expect(downgraded.status).toBe("model_argued_unverified");
    expect(downgraded.summary).toContain(
      "without matching deterministic citation",
    );
  });

  it("downgrades model disagreement even when deterministic evidence verified", () => {
    const downgraded = validateModelFindingAgainstEvidence({
      deterministic: {
        findingId: "F-1",
        status: "verified",
        summary: "Path exists",
        citations: [],
        missing: [],
      },
      modelFinding: {
        findingId: "F-1",
        status: "unverified",
        summary: "Model argues this is not proven",
      },
    });

    expect(downgraded.status).toBe("model_argued_unverified");
    expect(downgraded.summary).toBe("Model argues this is not proven");
  });

  it("sweeps expired inactive checkouts while preserving active leases", async () => {
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const baseRoot = join(workspaceRoot, ".symphony", "code-grounding");
    const staleCheckout = join(baseRoot, "checkouts", "cg-stale");
    const staleCheckoutLock = join(baseRoot, "checkouts", "cg-stale.lock");
    const activeCheckout = join(baseRoot, "checkouts", "cg-active");
    const activeCheckoutLock = join(baseRoot, "checkouts", "cg-active.lock");
    const staleArtifact = join(baseRoot, "artifacts", "stale");
    const activeArtifact = join(baseRoot, "artifacts", "active");
    await mkdir(staleCheckout, { recursive: true });
    await mkdir(staleCheckoutLock, { recursive: true });
    await mkdir(activeCheckout, { recursive: true });
    await mkdir(activeCheckoutLock, { recursive: true });
    await mkdir(staleArtifact, { recursive: true });
    await mkdir(activeArtifact, { recursive: true });
    await writeFile(join(staleCheckout, "file.txt"), "stale");
    await writeFile(join(staleCheckoutLock, "owner.json"), "{}\n");
    await writeFile(join(activeCheckout, "file.txt"), "active");
    await writeFile(join(staleArtifact, "report.json"), "{}\n");
    await writeFile(join(activeArtifact, "report.json"), "{}\n");
    await writeFile(
      join(activeCheckoutLock, "owner.json"),
      `${JSON.stringify({
        pid: process.pid,
        ownerToken: "active-owner",
        acquiredAt: "2026-06-15T00:00:00.000Z",
      })}\n`,
    );
    await mkdir(baseRoot, { recursive: true });
    await writeFile(
      join(baseRoot, "leases.json"),
      `${JSON.stringify(
        {
          version: 1,
          checkouts: {
            "cg-stale": {
              checkoutId: "cg-stale",
              repoUrl: "repo",
              commitSha: "abc",
              checkoutPath: staleCheckout,
              artifactRoot: staleArtifact,
              createdAt: "2026-06-13T00:00:00.000Z",
              lastUsedAt: "2026-06-13T00:00:00.000Z",
              activeRunIds: [],
            },
            "cg-active": {
              checkoutId: "cg-active",
              repoUrl: "repo",
              commitSha: "def",
              checkoutPath: activeCheckout,
              artifactRoot: activeArtifact,
              createdAt: "2026-06-13T00:00:00.000Z",
              lastUsedAt: "2026-06-13T00:00:00.000Z",
              activeRunIds: ["run-active"],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    await sweepCodeGroundingCheckouts({
      workspaceRoot,
      config: {
        ...codeGroundingConfig(),
        ttlMs: 1,
      },
      now: new Date("2026-06-15T00:00:00.000Z"),
    });

    await expect(
      readFile(join(staleCheckout, "file.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(staleCheckoutLock, "owner.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(staleArtifact, "report.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(activeCheckout, "file.txt"), "utf8"),
    ).resolves.toBe("active");
    await expect(
      readFile(join(activeArtifact, "report.json"), "utf8"),
    ).resolves.toBe("{}\n");
  });

  it("reports artifact cleanup failures without preserving stale leases", async () => {
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const baseRoot = join(workspaceRoot, ".symphony", "code-grounding");
    const staleCheckout = join(baseRoot, "checkouts", "cg-stale");
    const artifactsRoot = join(baseRoot, "artifacts");
    await mkdir(staleCheckout, { recursive: true });
    await mkdir(artifactsRoot, { recursive: true });
    await writeFile(join(staleCheckout, "file.txt"), "stale");
    const leaseIndexPath = join(baseRoot, "leases.json");
    await writeFile(
      leaseIndexPath,
      `${JSON.stringify(
        {
          version: 1,
          checkouts: {
            "cg-stale": {
              checkoutId: "cg-stale",
              repoUrl: "repo",
              commitSha: "abc",
              checkoutPath: staleCheckout,
              artifactRoot: artifactsRoot,
              createdAt: "2026-06-13T00:00:00.000Z",
              lastUsedAt: "2026-06-13T00:00:00.000Z",
              activeRunIds: [],
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    const result = await sweepCodeGroundingCheckouts({
      workspaceRoot,
      config: {
        ...codeGroundingConfig(),
        ttlMs: 1,
      },
      now: new Date("2026-06-15T00:00:00.000Z"),
    });

    expect(result.warnings).toEqual([
      "code-grounding artifact cleanup skipped for cg-stale: Error",
    ]);
    await expect(
      readFile(join(staleCheckout, "file.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const leaseIndex = JSON.parse(await readFile(leaseIndexPath, "utf8")) as {
      checkouts: Record<string, unknown>;
    };
    expect(leaseIndex.checkouts["cg-stale"]).toBeUndefined();
    await expect(readdir(artifactsRoot)).resolves.toEqual([]);
  });

  it("sweeps least-recently-used inactive checkouts over the per-repo cap", async () => {
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const baseRoot = join(workspaceRoot, ".symphony", "code-grounding");
    const firstCheckout = join(baseRoot, "checkouts", "cg-first");
    const secondCheckout = join(baseRoot, "checkouts", "cg-second");
    await mkdir(firstCheckout, { recursive: true });
    await mkdir(secondCheckout, { recursive: true });
    await writeFile(join(firstCheckout, "file.txt"), "first");
    await writeFile(join(secondCheckout, "file.txt"), "second");
    await mkdir(baseRoot, { recursive: true });
    const leaseIndexPath = join(baseRoot, "leases.json");
    await writeFile(
      leaseIndexPath,
      `${JSON.stringify(
        {
          version: 1,
          checkouts: {
            "cg-first": {
              checkoutId: "cg-first",
              repoUrl: "repo",
              commitSha: "abc",
              checkoutPath: firstCheckout,
              artifactRoot: join(baseRoot, "artifacts", "first"),
              createdAt: "2026-06-13T00:00:00.000Z",
              lastUsedAt: "2026-06-13T00:00:00.000Z",
              activeRunIds: [],
            },
            "cg-second": {
              checkoutId: "cg-second",
              repoUrl: "repo",
              commitSha: "def",
              checkoutPath: secondCheckout,
              artifactRoot: join(baseRoot, "artifacts", "second"),
              createdAt: "2026-06-14T00:00:00.000Z",
              lastUsedAt: "2026-06-14T00:00:00.000Z",
              activeRunIds: [],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    await sweepCodeGroundingCheckouts({
      workspaceRoot,
      config: {
        ...codeGroundingConfig(),
        maxCheckoutsPerRepo: 1,
      },
      now: new Date("2026-06-15T00:00:00.000Z"),
    });

    await expect(
      readFile(join(firstCheckout, "file.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(secondCheckout, "file.txt"), "utf8"),
    ).resolves.toBe("second");
    const leaseIndex = JSON.parse(await readFile(leaseIndexPath, "utf8")) as {
      checkouts: Record<string, unknown>;
    };
    expect(leaseIndex.checkouts["cg-first"]).toBeUndefined();
    expect(leaseIndex.checkouts["cg-second"]).toBeDefined();
  });

  it("sweeps expired checkouts with stale active run ids when no lock owner is alive", async () => {
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const baseRoot = join(workspaceRoot, ".symphony", "code-grounding");
    const crashedCheckout = join(baseRoot, "checkouts", "cg-crashed");
    await mkdir(crashedCheckout, { recursive: true });
    await writeFile(join(crashedCheckout, "file.txt"), "crashed");
    await mkdir(baseRoot, { recursive: true });
    const leaseIndexPath = join(baseRoot, "leases.json");
    await writeFile(
      leaseIndexPath,
      `${JSON.stringify(
        {
          version: 1,
          checkouts: {
            "cg-crashed": {
              checkoutId: "cg-crashed",
              repoUrl: "repo",
              commitSha: "abc",
              checkoutPath: crashedCheckout,
              artifactRoot: join(baseRoot, "artifacts", "crashed"),
              createdAt: "2026-06-13T00:00:00.000Z",
              lastUsedAt: "2026-06-13T00:00:00.000Z",
              activeRunIds: ["crashed-run"],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    await sweepCodeGroundingCheckouts({
      workspaceRoot,
      config: {
        ...codeGroundingConfig(),
        ttlMs: 1,
      },
      now: new Date("2026-06-15T00:00:00.000Z"),
    });

    await expect(
      readFile(join(crashedCheckout, "file.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const leaseIndex = JSON.parse(await readFile(leaseIndexPath, "utf8")) as {
      checkouts: Record<string, unknown>;
    };
    expect(leaseIndex.checkouts["cg-crashed"]).toBeUndefined();
  });

  it("does not sweep an inactive checkout while its lock owner is alive", async () => {
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const baseRoot = join(workspaceRoot, ".symphony", "code-grounding");
    const lockedCheckout = join(baseRoot, "checkouts", "cg-locked");
    const lockedCheckoutLock = join(baseRoot, "checkouts", "cg-locked.lock");
    await mkdir(lockedCheckout, { recursive: true });
    await mkdir(lockedCheckoutLock, { recursive: true });
    await writeFile(join(lockedCheckout, "file.txt"), "locked");
    await writeFile(
      join(lockedCheckoutLock, "owner.json"),
      `${JSON.stringify({
        pid: process.pid,
        ownerToken: "live-owner",
        acquiredAt: "2026-06-13T00:00:00.000Z",
      })}\n`,
    );
    await mkdir(baseRoot, { recursive: true });
    const leaseIndexPath = join(baseRoot, "leases.json");
    await writeFile(
      leaseIndexPath,
      `${JSON.stringify(
        {
          version: 1,
          checkouts: {
            "cg-locked": {
              checkoutId: "cg-locked",
              repoUrl: "repo",
              commitSha: "abc",
              checkoutPath: lockedCheckout,
              artifactRoot: join(baseRoot, "artifacts", "locked"),
              createdAt: "2026-06-13T00:00:00.000Z",
              lastUsedAt: "2026-06-13T00:00:00.000Z",
              activeRunIds: [],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    await sweepCodeGroundingCheckouts({
      workspaceRoot,
      config: {
        ...codeGroundingConfig(),
        ttlMs: 1,
      },
      now: new Date("2026-06-15T00:00:00.000Z"),
    });

    await expect(
      readFile(join(lockedCheckout, "file.txt"), "utf8"),
    ).resolves.toBe("locked");
    await expect(
      readFile(join(lockedCheckoutLock, "owner.json"), "utf8"),
    ).resolves.toContain("live-owner");
    const leaseIndex = JSON.parse(await readFile(leaseIndexPath, "utf8")) as {
      checkouts: Record<string, unknown>;
    };
    expect(leaseIndex.checkouts["cg-locked"]).toBeDefined();
  });

  it("reaps old orphaned artifact directories while preserving young artifacts", async () => {
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const baseRoot = join(workspaceRoot, ".symphony", "code-grounding");
    const oldArtifact = join(baseRoot, "artifacts", "old-orphan");
    const youngArtifact = join(baseRoot, "artifacts", "young-orphan");
    await mkdir(oldArtifact, { recursive: true });
    await mkdir(youngArtifact, { recursive: true });
    await writeFile(join(oldArtifact, "report.json"), "{}\n");
    await writeFile(join(youngArtifact, "report.json"), "{}\n");
    await utimes(
      oldArtifact,
      new Date("2026-06-13T00:00:00.000Z"),
      new Date("2026-06-13T00:00:00.000Z"),
    );
    await utimes(
      youngArtifact,
      new Date("2026-06-14T12:00:00.000Z"),
      new Date("2026-06-14T12:00:00.000Z"),
    );

    await sweepCodeGroundingCheckouts({
      workspaceRoot,
      config: codeGroundingConfig(),
      now: new Date("2026-06-15T00:00:00.000Z"),
    });
    await sweepCodeGroundingCheckouts({
      workspaceRoot,
      config: codeGroundingConfig(),
      now: new Date("2026-06-15T00:00:00.000Z"),
    });

    await expect(
      readFile(join(oldArtifact, "report.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(youngArtifact, "report.json"), "utf8"),
    ).resolves.toBe("{}\n");
  });

  it("skips orphaned artifact symlinks without deleting their targets", async () => {
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const outsideRoot = await tempRoot("symph-cg-outside-");
    const baseRoot = join(workspaceRoot, ".symphony", "code-grounding");
    const artifactsRoot = join(baseRoot, "artifacts");
    const outsideArtifact = join(outsideRoot, "artifact");
    const artifactLink = join(artifactsRoot, "linked-artifact");
    await mkdir(artifactsRoot, { recursive: true });
    await mkdir(outsideArtifact, { recursive: true });
    await writeFile(join(outsideArtifact, "report.json"), "{}\n");
    await symlink(outsideArtifact, artifactLink);

    await sweepCodeGroundingCheckouts({
      workspaceRoot,
      config: codeGroundingConfig(),
      now: new Date("2026-06-15T00:00:00.000Z"),
    });

    await expect(
      readFile(join(outsideArtifact, "report.json"), "utf8"),
    ).resolves.toBe("{}\n");
    await expect(
      readFile(join(artifactLink, "report.json"), "utf8"),
    ).resolves.toBe("{}\n");
  });

  it("skips symlink artifact roots while reaping stale leases", async () => {
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const outsideRoot = await tempRoot("symph-cg-outside-");
    const baseRoot = join(workspaceRoot, ".symphony", "code-grounding");
    const staleCheckout = join(baseRoot, "checkouts", "cg-stale");
    const artifactsRoot = join(baseRoot, "artifacts");
    const outsideArtifact = join(outsideRoot, "artifact");
    const artifactLink = join(artifactsRoot, "linked-artifact");
    await mkdir(staleCheckout, { recursive: true });
    await mkdir(artifactsRoot, { recursive: true });
    await mkdir(outsideArtifact, { recursive: true });
    await writeFile(join(staleCheckout, "file.txt"), "stale");
    await writeFile(join(outsideArtifact, "report.json"), "{}\n");
    await symlink(outsideArtifact, artifactLink);
    await writeFile(
      join(baseRoot, "leases.json"),
      `${JSON.stringify(
        {
          version: 1,
          checkouts: {
            "cg-stale": {
              checkoutId: "cg-stale",
              repoUrl: "repo",
              commitSha: "abc",
              checkoutPath: staleCheckout,
              artifactRoot: artifactLink,
              createdAt: "2026-06-13T00:00:00.000Z",
              lastUsedAt: "2026-06-13T00:00:00.000Z",
              activeRunIds: [],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    await sweepCodeGroundingCheckouts({
      workspaceRoot,
      config: {
        ...codeGroundingConfig(),
        ttlMs: 1,
      },
      now: new Date("2026-06-15T00:00:00.000Z"),
    });

    await expect(
      readFile(join(staleCheckout, "file.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(outsideArtifact, "report.json"), "utf8"),
    ).resolves.toBe("{}\n");
    const leaseIndex = JSON.parse(
      await readFile(join(baseRoot, "leases.json"), "utf8"),
    ) as {
      checkouts: Record<string, unknown>;
    };
    expect(leaseIndex.checkouts["cg-stale"]).toBeUndefined();
  });

  it("ignores artifact cleanup paths outside the artifacts root while reaping stale leases", async () => {
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const outsideRoot = await tempRoot("symph-cg-outside-");
    const baseRoot = join(workspaceRoot, ".symphony", "code-grounding");
    const staleCheckout = join(baseRoot, "checkouts", "cg-stale");
    const leaseIndexPath = join(baseRoot, "leases.json");
    const outsideArtifact = join(outsideRoot, "artifact");
    await mkdir(staleCheckout, { recursive: true });
    await mkdir(outsideArtifact, { recursive: true });
    await writeFile(join(staleCheckout, "file.txt"), "stale");
    await writeFile(join(outsideArtifact, "report.json"), "{}\n");
    await mkdir(baseRoot, { recursive: true });
    await writeFile(
      leaseIndexPath,
      `${JSON.stringify(
        {
          version: 1,
          checkouts: {
            "cg-stale": {
              checkoutId: "cg-stale",
              repoUrl: "repo",
              commitSha: "abc",
              checkoutPath: staleCheckout,
              artifactRoot: outsideArtifact,
              createdAt: "2026-06-13T00:00:00.000Z",
              lastUsedAt: "2026-06-13T00:00:00.000Z",
              activeRunIds: [],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    await sweepCodeGroundingCheckouts({
      workspaceRoot,
      config: {
        ...codeGroundingConfig(),
        ttlMs: 1,
      },
      now: new Date("2026-06-15T00:00:00.000Z"),
    });
    await sweepCodeGroundingCheckouts({
      workspaceRoot,
      config: {
        ...codeGroundingConfig(),
        ttlMs: 1,
      },
      now: new Date("2026-06-15T00:00:00.000Z"),
    });

    await expect(
      readFile(join(staleCheckout, "file.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(outsideArtifact, "report.json"), "utf8"),
    ).resolves.toBe("{}\n");
    const leaseIndex = JSON.parse(await readFile(leaseIndexPath, "utf8")) as {
      checkouts: Record<string, unknown>;
    };
    expect(leaseIndex.checkouts["cg-stale"]).toBeUndefined();
  });
});

function backlogFinding(
  overrides: Partial<BacklogAuditFinding> = {},
): BacklogAuditFinding {
  return {
    findingId: overrides.findingId ?? "F-1",
    type: overrides.type ?? "stale",
    issueIdentifiers: overrides.issueIdentifiers ?? ["SYMPH-1"],
    summary: overrides.summary ?? "Ground this finding",
    evidence: overrides.evidence ?? "No code evidence.",
    confidence: overrides.confidence ?? "medium",
  };
}

function codeGroundingConfig() {
  return {
    enabled: true,
    baseDir: ".symphony/code-grounding",
    ttlMs: 86_400_000,
    maxCheckoutsPerRepo: 5,
  };
}

async function createSourceRepo(): Promise<string> {
  const repo = await tempRoot("symph-cg-source-");
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test User"]);
  await mkdir(join(repo, "src", "orchestrator"), { recursive: true });
  await writeFile(
    join(repo, "src", "orchestrator", "queue.ts"),
    [
      "export function runQueueTriage(): string {",
      '  return "grounded";',
      "}",
      "",
    ].join("\n"),
  );
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "Initial"]);
  return repo;
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
