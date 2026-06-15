import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { BacklogAuditFinding } from "../../src/audit/backlog-audit.js";
import {
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

  it("sweeps expired inactive checkouts while preserving active leases", async () => {
    const workspaceRoot = await tempRoot("symph-cg-workspace-");
    const baseRoot = join(workspaceRoot, ".symphony", "code-grounding");
    const staleCheckout = join(baseRoot, "checkouts", "cg-stale");
    const staleCheckoutLock = join(baseRoot, "checkouts", "cg-stale.lock");
    const activeCheckout = join(baseRoot, "checkouts", "cg-active");
    await mkdir(staleCheckout, { recursive: true });
    await mkdir(staleCheckoutLock, { recursive: true });
    await mkdir(activeCheckout, { recursive: true });
    await writeFile(join(staleCheckout, "file.txt"), "stale");
    await writeFile(join(staleCheckoutLock, "owner.json"), "{}\n");
    await writeFile(join(activeCheckout, "file.txt"), "active");
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
              artifactRoot: join(baseRoot, "artifacts", "stale"),
              createdAt: "2026-06-13T00:00:00.000Z",
              lastUsedAt: "2026-06-13T00:00:00.000Z",
              activeRunIds: [],
            },
            "cg-active": {
              checkoutId: "cg-active",
              repoUrl: "repo",
              commitSha: "def",
              checkoutPath: activeCheckout,
              artifactRoot: join(baseRoot, "artifacts", "active"),
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
      readFile(join(activeCheckout, "file.txt"), "utf8"),
    ).resolves.toBe("active");
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
    baseDir: join(".symphony", "code-grounding"),
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
