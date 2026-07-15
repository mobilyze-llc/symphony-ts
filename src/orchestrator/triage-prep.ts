import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import {
  DEFAULT_CODE_GROUNDING_BASE_DIR,
  DEFAULT_CODE_GROUNDING_MATERIALIZATION_TIMEOUT_MS,
  DEFAULT_CODE_GROUNDING_MAX_CHECKOUTS_PER_REPO,
  DEFAULT_CODE_GROUNDING_TTL_MS,
} from "../config/defaults.js";
import type { ResolvedWorkflowConfig } from "../config/types.js";
import type { Issue } from "../domain/model.js";
import type { CodeGroundingConfig } from "./code-grounding.js";
import {
  extractTriageFinding,
  loadTriagePrepLedgerRows,
  parseTriagePrepRepositories,
} from "./triage-prep-extraction.js";
import { buildFamilySummaries } from "./triage-prep-family.js";
import { inspectTriagePrepRepository } from "./triage-prep-repository.js";
import { buildTriagePrepSheet } from "./triage-prep-sheet.js";
import {
  type ExtractedTriageAnchor,
  type ExtractedTriageFinding,
  type PrepareTriagePlannerContextInput,
  type PrepareTriagePlannerContextResult,
  type ShadowTriagePrepInput,
  TRIAGE_PREP_ARTIFACT_NAME,
  TRIAGE_PREP_COMMENT_MAX_PAGES,
  TRIAGE_PREP_REPOSITORIES_ENV,
  TRIAGE_PREP_SCHEMA,
  type TriagePrepEvidenceBatch,
  type TriagePrepLedgerRow,
  type TriagePrepRepositoryInspection,
} from "./triage-prep-types.js";

export {
  TRIAGE_PREP_ARTIFACT_NAME,
  TRIAGE_PREP_REPOSITORIES_ENV,
  type PrepareTriagePlannerContextResult,
  type ShadowTriagePrepInput,
  type TriagePrepRepository,
} from "./triage-prep-types.js";
export {
  extractTriageFinding,
  loadTriagePrepLedgerRows,
  parseTriagePrepRepositories,
} from "./triage-prep-extraction.js";
export { inspectTriagePrepRepository } from "./triage-prep-repository.js";

export function buildShadowTriagePrepDep(input: {
  workflowConfig: Pick<ResolvedWorkflowConfig, "queueTriage">;
  env: NodeJS.ProcessEnv;
  workspaceRoot: string;
  artifactDir: string;
}) {
  if (input.workflowConfig.queueTriage?.triagePrep !== true) return {};
  return {
    prepareTriagePlannerContext: (tick: ShadowTriagePrepInput) =>
      prepareTriagePlannerContext({
        context: tick.context,
        candidates: tick.candidates,
        familyCandidates: tick.familyCandidates,
        artifactDir: input.artifactDir,
        workspaceRoot: input.workspaceRoot,
        repositories: parseTriagePrepRepositories(
          input.env[TRIAGE_PREP_REPOSITORIES_ENV],
        ),
        env: input.env,
        ...(tick.fetchIssueComments === undefined
          ? {}
          : { fetchIssueComments: tick.fetchIssueComments }),
        now: tick.now,
      }),
  };
}

export async function prepareTriagePlannerContext(
  input: PrepareTriagePlannerContextInput,
): Promise<PrepareTriagePlannerContextResult> {
  const now = input.now ?? (() => new Date());
  // Triage-prep is report-only, so its explicit target population must not be
  // narrowed by planner admission, in-flight subtraction, or prompt curation.
  const sheetIssues = dedupeIssues(input.candidates);
  const familyIssues = dedupeIssues([
    ...(input.familyCandidates ?? input.candidates),
    ...sheetIssues,
  ]);
  const additionalEvidenceByIssueId = new Map<string, string[]>(
    [...input.context.backlog, ...(input.context.advisoryInput ?? [])].map(
      (candidate) =>
        [
          candidate.issueId,
          (candidate.comments ?? []).map((comment) => comment.body),
        ] as const,
    ),
  );
  const commentHydrationWarnings: string[] = [];
  if (input.fetchIssueComments !== undefined) {
    // Deliberately sequential: every target is hydrated, while at most one
    // bounded Linear page walk is active at a time.
    for (const issue of familyIssues) {
      try {
        const comments = await input.fetchIssueComments(issue.id, {
          maxPages: TRIAGE_PREP_COMMENT_MAX_PAGES,
        });
        additionalEvidenceByIssueId.set(
          issue.id,
          comments.map((comment) => comment.body),
        );
      } catch (error) {
        commentHydrationWarnings.push(
          `${issue.identifier}: raw comment hydration unavailable: ${errorMessage(error)}`,
        );
      }
    }
  }
  const extracted = familyIssues.map((issue) =>
    extractTriageFinding(
      issue,
      additionalEvidenceByIssueId.get(issue.id) ?? [],
    ),
  );
  const anchors = dedupeAnchors(
    extracted.flatMap((finding) => finding.anchors),
  );
  const classes = [
    ...new Set(extracted.flatMap((finding) => finding.failureClasses)),
  ];
  const inspect = input.inspectRepository ?? inspectTriagePrepRepository;
  const inspections = await Promise.all(
    input.repositories.map(async (repository) => {
      try {
        return await inspect({
          repository,
          anchors,
          failureClasses: classes,
          filedAtByAnchor: earliestFiledAtByAnchor(familyIssues, extracted),
          workspaceRoot: input.workspaceRoot,
          runId: `triage-prep-${now().toISOString()}-${repository.key}`,
          config: input.codeGroundingConfig ?? defaultCodeGroundingConfig(),
        });
      } catch (error) {
        return {
          repository: repository.key,
          originMainSha: null,
          anchors: [],
          classEmissions: [],
          error: errorMessage(error),
        } satisfies TriagePrepRepositoryInspection;
      }
    }),
  );
  const ledger = await (
    input.loadLedgerRows ??
    (() => loadTriagePrepLedgerRows(input.env ?? process.env))
  )();
  const batch = buildTriagePrepEvidenceBatch({
    generatedAt: now().toISOString(),
    sheetIssues,
    familyIssues,
    extracted,
    inspections,
    ledger,
  });
  batch.warnings.push(...commentHydrationWarnings);
  if (input.repositories.length === 0) {
    batch.warnings.push(
      `no repositories configured; set ${TRIAGE_PREP_REPOSITORIES_ENV} or provide a manager --triage-prep-repo`,
    );
  }
  const artifactPath = join(input.artifactDir, TRIAGE_PREP_ARTIFACT_NAME);
  await fs.mkdir(dirname(artifactPath), { recursive: true });
  await fs.writeFile(
    artifactPath,
    `${JSON.stringify(batch, null, 2)}\n`,
    "utf8",
  );
  return {
    context: {
      ...input.context,
      triagePrepEvidence: {
        artifactPath,
        sheetCount: batch.sheets.length,
        generatedAt: batch.generatedAt,
      },
    },
    batch,
    artifactPath,
  };
}

export function buildTriagePrepEvidenceBatch(input: {
  generatedAt: string;
  sheetIssues: readonly Issue[];
  familyIssues: readonly Issue[];
  extracted: readonly ExtractedTriageFinding[];
  inspections: readonly TriagePrepRepositoryInspection[];
  ledger: {
    rows: TriagePrepLedgerRow[];
    available: boolean;
    reason: string;
  };
}): TriagePrepEvidenceBatch {
  const extractionById = new Map(
    input.extracted.map((item) => [item.issueId, item]),
  );
  const sheets = input.sheetIssues.flatMap((issue) => {
    const extraction = extractionById.get(issue.id);
    return extraction === undefined
      ? []
      : [
          buildTriagePrepSheet({
            issue,
            extraction,
            allIssues: input.familyIssues,
            extractionById,
            inspections: input.inspections,
            ledger: input.ledger,
          }),
        ];
  });
  return {
    schema: TRIAGE_PREP_SCHEMA,
    generatedAt: input.generatedAt,
    ephemeral: true,
    sourceRef: "fresh origin/main",
    mutationPolicy: "read_only_no_linear_writes",
    sheets,
    families: buildFamilySummaries(
      input.extracted,
      new Map(input.familyIssues.map((issue) => [issue.id, issue.identifier])),
      new Set(input.sheetIssues.map((issue) => issue.identifier)),
      input.inspections.flatMap((item) => item.anchors),
    ),
    warnings: input.inspections.flatMap((inspection) =>
      inspection.error === null
        ? []
        : [`${inspection.repository}: ${inspection.error}`],
    ),
  };
}

function earliestFiledAtByAnchor(
  issues: readonly Issue[],
  extracted: readonly ExtractedTriageFinding[],
): Map<string, string | null> {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const result = new Map<string, string | null>();
  for (const finding of extracted) {
    const filedAt = byId.get(finding.issueId)?.createdAt ?? null;
    for (const anchor of finding.anchors) {
      const current = result.get(anchor.key);
      if (
        current === undefined ||
        (filedAt !== null && (current === null || filedAt < current))
      ) {
        result.set(anchor.key, filedAt);
      }
    }
  }
  return result;
}

function dedupeIssues(issues: readonly Issue[]): Issue[] {
  return [...new Map(issues.map((issue) => [issue.id, issue])).values()];
}

function dedupeAnchors(
  anchors: readonly ExtractedTriageAnchor[],
): ExtractedTriageAnchor[] {
  return [...new Map(anchors.map((anchor) => [anchor.key, anchor])).values()];
}

function defaultCodeGroundingConfig(): CodeGroundingConfig {
  return {
    enabled: true,
    baseDir: DEFAULT_CODE_GROUNDING_BASE_DIR,
    ttlMs: DEFAULT_CODE_GROUNDING_TTL_MS,
    maxCheckoutsPerRepo: DEFAULT_CODE_GROUNDING_MAX_CHECKOUTS_PER_REPO,
    materializationTimeoutMs: DEFAULT_CODE_GROUNDING_MATERIALIZATION_TIMEOUT_MS,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
