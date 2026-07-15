import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { PlannerContext } from "../../src/agent/triage-planner.js";
import type { Issue } from "../../src/domain/model.js";
import {
  TRIAGE_PREP_ARTIFACT_NAME,
  buildTriagePrepEvidenceBatch,
  extractTriageFinding,
  inspectTriagePrepRepository,
  loadTriagePrepLedgerRows,
  prepareTriagePlannerContext,
} from "../../src/orchestrator/triage-prep.js";

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function issue(
  identifier: string,
  description: string,
  overrides: Partial<Issue> = {},
): Issue {
  return {
    id: identifier.toLowerCase(),
    identifier,
    title: `Finding ${identifier}`,
    description,
    priority: 2,
    state: "Triage",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
    ...overrides,
  };
}

function context(issues: readonly Issue[]): PlannerContext {
  return {
    backlog: issues.map((item) => ({
      issueId: item.id,
      issueIdentifier: item.identifier,
      title: item.title,
      priority: item.priority,
      state: item.state,
      blockedBy: [],
      description: item.description,
    })),
    openPrs: [],
    recentlyMerged: [],
    inFlight: [],
    envelope: {
      version: 1,
      concurrencyCeiling: 2,
      allowedRisk: "medium",
      allowedModes: ["parallel-isolated"],
    },
  };
}

describe("extractTriageFinding", () => {
  it("extracts regular legacy anchors, fingerprints, and enumerable classes", () => {
    const extracted = extractTriageFinding(
      issue(
        "MOB-1147",
        "crabrunner/src/client.ts:409-427::378dfacd0b emits provider_auth_unavailable",
      ),
    );

    expect(extracted.format).toBe("legacy");
    expect(extracted.failureClasses).toEqual(["provider_auth_unavailable"]);
    expect(extracted.councilFingerprints).toEqual([
      "crabrunner/src/client.ts:409-427::378dfacd0b",
    ]);
    expect(extracted.anchors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "crabrunner/src/client.ts",
          lineRange: [409, 427],
        }),
      ]),
    );
  });

  it("reads exact recurrence fields only from marked MOB-1227 metadata", () => {
    const extracted = extractTriageFinding(
      issue(
        "MOB-1300",
        `scripts/supervisor-classify.mjs::attempt-boundary
<!-- mob-1227 finding_metadata
post_done_recurrence_count: 9
recurrence_count: 4
distinct_sessions: 3
post_done_recurrences: 1
done_twins: 1
-->`,
      ),
    );

    expect(extracted.format).toBe("mob_1227_metadata");
    expect(extracted.recurrenceMetadata).toEqual({
      recurrenceCount: 4,
      sessionCount: 3,
      postDoneRecurrenceCount: 9,
      doneTwinCount: 1,
    });
  });

  it("matches failure classes only at ASCII identifier boundaries", () => {
    for (const embedded of [
      "xprovider_auth_unavailable",
      "provider_auth_unavailablex",
      "_provider_auth_unavailable",
      "provider_auth_unavailable_",
    ]) {
      expect(
        extractTriageFinding(issue("MOB-1300", embedded)).failureClasses,
      ).not.toContain("provider_auth_unavailable");
    }

    expect(
      extractTriageFinding(issue("MOB-1300", "éprovider_auth_unavailableé"))
        .failureClasses,
    ).toContain("provider_auth_unavailable");
  });

  it("reads quoted, case-insensitive numeric metadata aliases", () => {
    const extracted = extractTriageFinding(
      issue(
        "MOB-1300",
        `<!-- recurrence_metadata
"RECURRENCES" = 12
'Sessions': 7
"post_done_recurrence_count"=3
'DONE_TWIN_COUNT': 2
-->`,
      ),
    );

    expect(extracted.recurrenceMetadata).toEqual({
      recurrenceCount: 12,
      sessionCount: 7,
      postDoneRecurrenceCount: 3,
      doneTwinCount: 2,
    });
  });

  it("extracts legacy calibration evidence from a Linear rescope comment", () => {
    const extracted = extractTriageFinding(
      issue("MOB-1150", "The original body predates deterministic intake."),
      [
        "Rescope: inspect `skills/session-orchestrator/scripts/lib/supervisor-classify.mjs:410-425`; the observed class is provider_auth_unavailable.",
      ],
    );

    expect(extracted).toMatchObject({
      issueIdentifier: "MOB-1150",
      format: "legacy",
      failureClasses: ["provider_auth_unavailable"],
    });
    expect(extracted.anchors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "skills/session-orchestrator/scripts/lib/supervisor-classify.mjs",
          lineRange: [410, 425],
        }),
      ]),
    );
  });

  it("consumes the installed findings-intake v2 identity without invented numeric counters", () => {
    const extracted = extractTriageFinding(
      issue(
        "MOB-1301",
        `## Finding metadata

<!-- findings-intake-metadata:v2
{"schema":"crucible.findings-intake.v2","failure_class":"reviewer_output_dropped","anchor_fingerprint":"0123456789abcdef","anchors":["skills/session-orchestrator/scripts/lib/reviewer-output-drop.mjs:classifyDrop"]}
fkeyfedcba9876543210
-->

- Related Done twin: [MOB-1299](https://linear.app/mobilyze/issue/MOB-1299)`,
      ),
      ["Recurrence observed 2026-07-14T12:00:00.000Z."],
    );

    expect(extracted).toMatchObject({
      format: "findings_intake_v2",
      failureClasses: ["reviewer_output_dropped"],
      recurrenceIdentityKeys: ["fkeyfedcba9876543210"],
      recurrenceObservationCount: 1,
      relatedIssueIdentifiers: ["MOB-1299"],
      recurrenceMetadata: null,
      findingsIntakeV2: {
        schema: "crucible.findings-intake.v2",
        failureClass: "reviewer_output_dropped",
        anchorFingerprint: "0123456789abcdef",
        anchors: [
          "skills/session-orchestrator/scripts/lib/reviewer-output-drop.mjs:classifyDrop",
        ],
        fkey: "fkeyfedcba9876543210",
      },
    });
    expect(extracted.anchors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "skills/session-orchestrator/scripts/lib/reviewer-output-drop.mjs",
          fingerprint: "classifyDrop",
          lineRange: null,
        }),
      ]),
    );
  });
});

describe("triage-prep evidence batch", () => {
  it("surfaces calibration signals and groups a shared-class, multi-anchor family", () => {
    const mob1148 = issue(
      "MOB-1148",
      "scripts/supervisor-classify.mjs::safe-site provider_auth_unavailable",
    );
    const mob1150 = issue(
      "MOB-1150",
      "scripts/supervisor-classify.mjs::attempt-a provider_auth_unavailable",
    );
    const mob1151 = issue(
      "MOB-1151",
      "skills/session-orchestrator/scripts/production-rollout.mjs::attempt-b provider_auth_unavailable",
    );
    const extracted = [mob1148, mob1150, mob1151].map((item) =>
      extractTriageFinding(item),
    );
    const inspections = [
      {
        repository: "crucible",
        originMainSha: "abc123",
        error: null,
        anchors: extracted.flatMap((finding) =>
          finding.anchors.map((anchor) => ({
            anchorKey: anchor.key,
            repository: "crucible",
            originMainSha: "abc123",
            status: "exists" as const,
            currentPath: anchor.path,
            commitsSinceFiling: [],
            historyPrecision: "cited_file" as const,
            reason: "live",
          })),
        ),
        classEmissions: [
          {
            failureClass: "provider_auth_unavailable" as const,
            repository: "crucible",
            originMainSha: "abc123",
            emittedInProduction: false,
            sites: [],
          },
        ],
      },
      {
        repository: "symphony",
        originMainSha: "def456",
        error: null,
        anchors: extracted.flatMap((finding) =>
          finding.anchors.map((anchor) => ({
            anchorKey: anchor.key,
            repository: "symphony",
            originMainSha: "def456",
            status: "gone" as const,
            currentPath: null,
            commitsSinceFiling: [],
            historyPrecision: "cited_file" as const,
            reason: "anchor belongs to another repository",
          })),
        ),
        classEmissions: [],
      },
    ];
    const batch = buildTriagePrepEvidenceBatch({
      generatedAt: "2026-07-13T12:00:00.000Z",
      sheetIssues: [mob1148],
      familyIssues: [mob1148, mob1150, mob1151],
      extracted,
      inspections,
      ledger: {
        available: true,
        reason: "fixture ledger",
        rows: [
          {
            fingerprint: "scripts/supervisor-classify.mjs::safe-site",
            location: {
              path: "scripts/supervisor-classify.mjs",
              lineRange: null,
            },
            verdict: "downgraded",
            round: 2,
          },
        ],
      },
    });

    const safeSheet = batch.sheets.find(
      (sheet) => sheet.issueIdentifier === "MOB-1148",
    );
    expect(safeSheet).toMatchObject({
      recurrence: {
        source: "legacy_best_effort",
        exact: false,
        recurrenceCount: 0,
      },
      adjudicationHistory: { downgraded: 1 },
      classEmission: {
        strength: "weak_signal",
        classes: [
          {
            failureClass: "provider_auth_unavailable",
            emittedInProduction: false,
            emittedAtCitedSite: false,
          },
        ],
      },
      coverage: { level: "partial" },
    });
    expect(safeSheet?.coverage.line).toContain("recurrence=partial");

    const family = batch.families.find(
      (item) => item.key === "class:provider_auth_unavailable",
    );
    expect(family?.members).toEqual(["MOB-1148", "MOB-1150", "MOB-1151"]);
    expect(family?.sharedAnchors).toHaveLength(3);
    expect(family?.allAnchorsLive).toBe(true);
  });

  it("preserves moved-anchor commit evidence without turning it into a verdict", () => {
    const finding = issue(
      "MOB-1147",
      "`scripts/supervisor-classify.mjs:10-12` provider_auth_unavailable",
    );
    const extraction = extractTriageFinding(finding);
    const batch = buildTriagePrepEvidenceBatch({
      generatedAt: "2026-07-13T12:00:00.000Z",
      sheetIssues: [finding],
      familyIssues: [finding],
      extracted: [extraction],
      inspections: [
        {
          repository: "crucible",
          originMainSha: "abc123",
          error: null,
          classEmissions: [],
          anchors: [
            {
              anchorKey: extraction.anchors[0]?.key ?? "",
              repository: "crucible",
              originMainSha: "abc123",
              status: "moved",
              currentPath: "scripts/supervisor-classify.mjs",
              commitsSinceFiling: [
                { sha: "4454454", title: "Adjust boundary (#445)" },
                { sha: "4494494", title: "Harden boundary (#449)" },
              ],
              historyPrecision: "cited_lines",
              reason: "lines touched",
            },
          ],
        },
      ],
      ledger: { rows: [], available: true, reason: "fixture ledger" },
    });

    expect(batch.sheets[0]?.anchorDrift[0]).toMatchObject({
      status: "moved",
      commitsSinceFiling: [
        { title: "Adjust boundary (#445)" },
        { title: "Harden boundary (#449)" },
      ],
    });
    expect(JSON.stringify(batch)).not.toContain("safe-by-construction");
  });

  it("matches ledger rows by file/range overlap and honors final Track classification", async () => {
    const root = await mkdtemp(join(tmpdir(), "triage-prep-ledger-"));
    cleanup.push(root);
    const ledgerPath = join(root, "review-quality-ledger.jsonl");
    await writeFile(
      ledgerPath,
      `${[
        {
          fp: "skills/session-orchestrator/scripts/lib/supervisor-classify.mjs::different-hash",
          region: {
            file: "skills/session-orchestrator/scripts/lib/supervisor-classify.mjs",
            line: 435,
          },
          cross_exam_verdict: "none",
          final_classification: "Track",
          round: 3,
        },
        {
          fp: "skills/session-orchestrator/scripts/lib/supervisor-classify.mjs:440-450::another-hash",
          cross_exam_verdict: "none",
          final_classification: "Track",
          round: 4,
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
      "utf8",
    );
    const finding = issue(
      "MOB-1148",
      "skills/session-orchestrator/scripts/lib/supervisor-classify.mjs:430-445 provider_auth_unavailable",
    );
    const extraction = extractTriageFinding(finding);
    const ledger = await loadTriagePrepLedgerRows({
      SYMPHONY_REVIEW_QUALITY_LEDGER: ledgerPath,
    });
    const batch = buildTriagePrepEvidenceBatch({
      generatedAt: "2026-07-15T12:00:00.000Z",
      sheetIssues: [finding],
      familyIssues: [finding],
      extracted: [extraction],
      inspections: [],
      ledger,
    });

    expect(ledger.rows[0]).toMatchObject({
      location: {
        path: "skills/session-orchestrator/scripts/lib/supervisor-classify.mjs",
        lineRange: [435, 435],
      },
      verdict: "downgraded",
    });
    expect(ledger.rows[1]).toMatchObject({
      location: {
        path: "skills/session-orchestrator/scripts/lib/supervisor-classify.mjs",
        lineRange: [440, 450],
      },
      verdict: "downgraded",
    });
    expect(batch.sheets[0]?.adjudicationHistory).toMatchObject({
      downgraded: 2,
      rounds: [3, 4],
    });
  });
});

describe("fresh origin/main inspection and artifact transform", () => {
  it("refreshes the managed checkout and records line-touch commits", async () => {
    const root = await mkdtemp(join(tmpdir(), "triage-prep-repo-"));
    cleanup.push(root);
    const source = join(root, "source");
    await mkdir(source);
    await git(source, ["init", "-b", "main"]);
    await git(source, ["config", "user.email", "test@example.com"]);
    await git(source, ["config", "user.name", "Test"]);
    await mkdir(join(source, "scripts"));
    const sourceFile = join(source, "scripts", "supervisor-classify.mjs");
    await writeFile(sourceFile, "export const value = 'old';\n", "utf8");
    await git(source, ["add", "."]);
    await git(source, ["commit", "-m", "Initial"]);
    await writeFile(
      sourceFile,
      [
        "export const value = 'provider_auth_unavailable';",
        "export const lookalike = 'reviewXp2';",
        "export const literal = 'review.p2';",
        "export const suffixed = 'review.p2_suffix';",
        "",
      ].join("\n"),
      "utf8",
    );
    await git(source, ["add", "."]);
    await git(source, ["commit", "-m", "Adjust boundary (#445)"]);

    const result = await inspectTriagePrepRepository({
      repository: {
        key: "fixture",
        target: {
          repoUrl: pathToFileURL(source).href,
          repoScope: "non_symphony",
          sourcePath: source,
        },
      },
      anchors: [
        {
          key: "scripts/supervisor-classify.mjs:1-1",
          raw: "scripts/supervisor-classify.mjs:1",
          path: "scripts/supervisor-classify.mjs",
          fingerprint: null,
          lineRange: [1, 1],
        },
      ],
      failureClasses: ["provider_auth_unavailable", "review.p2"],
      filedAtByAnchor: new Map([
        ["scripts/supervisor-classify.mjs:1-1", "2000-01-01T00:00:00.000Z"],
      ]),
      workspaceRoot: root,
      runId: "test-run",
      config: {
        enabled: true,
        baseDir: ".grounding",
        ttlMs: 60_000,
        maxCheckoutsPerRepo: 2,
      },
    });

    expect(result.anchors[0]).toMatchObject({
      status: "moved",
      historyPrecision: "cited_lines",
    });
    expect(result.anchors[0]?.commitsSinceFiling).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Adjust boundary (#445)" }),
      ]),
    );
    expect(result.classEmissions[0]).toMatchObject({
      emittedInProduction: true,
      sites: [{ path: "scripts/supervisor-classify.mjs", line: 1 }],
    });
    expect(result.classEmissions[1]).toMatchObject({
      emittedInProduction: true,
      sites: [{ path: "scripts/supervisor-classify.mjs", line: 3 }],
    });
  });

  it("writes one ephemeral batch and returns a context pointer", async () => {
    const root = await mkdtemp(join(tmpdir(), "triage-prep-artifact-"));
    cleanup.push(root);
    const finding = issue(
      "MOB-1300",
      "scripts/supervisor-classify.mjs::attempt-boundary provider_auth_unavailable",
    );
    const prepared = await prepareTriagePlannerContext({
      context: context([finding]),
      candidates: [finding],
      artifactDir: join(root, "run"),
      workspaceRoot: root,
      repositories: [],
      now: () => new Date("2026-07-13T12:00:00.000Z"),
      loadLedgerRows: async () => ({
        rows: [],
        available: false,
        reason: "fixture unavailable",
      }),
    });

    expect(prepared.artifactPath).toBe(
      join(root, "run", TRIAGE_PREP_ARTIFACT_NAME),
    );
    expect(prepared.context.triagePrepEvidence).toMatchObject({
      artifactPath: prepared.artifactPath,
      sheetCount: 1,
    });
    const artifact = JSON.parse(await readFile(prepared.artifactPath, "utf8"));
    expect(artifact).toMatchObject({
      ephemeral: true,
      sourceRef: "fresh origin/main",
      mutationPolicy: "read_only_no_linear_writes",
    });
  });

  it("emits calibration signals for the three live legacy tickets and a current v2 finding", async () => {
    const root = await mkdtemp(join(tmpdir(), "triage-prep-live-contracts-"));
    cleanup.push(root);
    const findings = [
      issue("MOB-1150", "Legacy finding; see the current rescope comment."),
      issue("MOB-1148", "Legacy finding; see the current rescope comment."),
      issue("MOB-1147", "Legacy finding; see the current rescope comment."),
      issue(
        "MOB-1301",
        `<!-- findings-intake-metadata:v2
{"schema":"crucible.findings-intake.v2","failure_class":"reviewer_output_dropped","anchor_fingerprint":"0123456789abcdef","anchors":["skills/session-orchestrator/scripts/lib/reviewer-output-drop.mjs:classifyDrop"]}
fkeyfedcba9876543210
-->`,
      ),
    ];
    // The planner context deliberately contains no admitted/curated candidates.
    // Triage-prep must hydrate every explicit target through the raw reader seam.
    const plannerContext = context([]);
    const fetched: Array<{ issueId: string; maxPages: number | undefined }> =
      [];

    const prepared = await prepareTriagePlannerContext({
      context: plannerContext,
      candidates: findings,
      artifactDir: join(root, "run"),
      workspaceRoot: root,
      repositories: [],
      fetchIssueComments: async (issueId, options) => {
        fetched.push({ issueId, maxPages: options.maxPages });
        const identifier = issueId.toUpperCase();
        if (identifier === "MOB-1301") {
          return [
            {
              body: "Recurrence observed 2026-07-14T12:00:00.000Z: filed fresh visible intake [MOB-1302](https://linear.app/mobilyze/issue/MOB-1302).",
            },
          ];
        }
        return [
          {
            body: `Rescope: \`skills/session-orchestrator/scripts/lib/supervisor-classify.mjs:${identifier === "MOB-1150" ? "410-425" : identifier === "MOB-1148" ? "430-445" : "450-465"}\` emits provider_auth_unavailable.`,
          },
        ];
      },
      now: () => new Date("2026-07-15T12:00:00.000Z"),
      loadLedgerRows: async () => ({
        rows: [],
        available: false,
        reason: "fixture unavailable",
      }),
    });

    expect(fetched).toEqual(
      findings.map((finding) => ({ issueId: finding.id, maxPages: 10 })),
    );
    expect(prepared.batch.sheets).toHaveLength(4);

    for (const identifier of ["MOB-1150", "MOB-1148", "MOB-1147"]) {
      const sheet = prepared.batch.sheets.find(
        (candidate) => candidate.issueIdentifier === identifier,
      );
      expect(sheet?.extraction.failureClasses).toEqual([
        "provider_auth_unavailable",
      ]);
      expect(sheet?.extraction.anchors).toHaveLength(1);
    }
    const current = prepared.batch.sheets.find(
      (candidate) => candidate.issueIdentifier === "MOB-1301",
    );
    expect(current).toMatchObject({
      extraction: {
        format: "findings_intake_v2",
        findingsIntakeV2: { fkey: "fkeyfedcba9876543210" },
      },
      recurrence: {
        source: "findings_intake_v2_best_effort",
        exact: false,
        recurrenceCount: 1,
        sessionCount: null,
        postDoneRecurrenceCount: null,
        doneTwinCount: null,
        visibleRecurrenceCommentCount: 1,
        relatedIssueIdentifiers: ["MOB-1302"],
      },
      family: { members: ["MOB-1301", "MOB-1302"] },
      coverage: { level: "partial" },
    });
    expect(
      prepared.batch.families.find(
        (family) => family.key === "class:reviewer_output_dropped",
      )?.members,
    ).toEqual(["MOB-1301", "MOB-1302"]);
  });
});

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd });
}
