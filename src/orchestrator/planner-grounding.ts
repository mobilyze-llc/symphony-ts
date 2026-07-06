import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  PlannerCandidateGroundingEvidence,
  PlannerContext,
} from "../agent/triage-planner.js";
import {
  DEFAULT_CODE_GROUNDING_BASE_DIR,
  DEFAULT_CODE_GROUNDING_MATERIALIZATION_TIMEOUT_MS,
  DEFAULT_CODE_GROUNDING_MAX_CHECKOUTS_PER_REPO,
  DEFAULT_CODE_GROUNDING_TTL_MS,
  DEFAULT_LINEAR_ENDPOINT,
} from "../config/defaults.js";
import type { ResolvedWorkflowConfig } from "../config/types.js";
import type { Issue } from "../domain/model.js";
import { fetchLinearDocumentContent } from "../tracker/linear-documents.js";
import type {
  CodeGroundingConfig,
  CodeGroundingTarget,
  RunCodeGroundingInput,
} from "./code-grounding.js";
import { followGroundingDocs } from "./doc-follower.js";
import {
  type GroundingExtractionResult,
  extractGroundingEvidence,
} from "./grounding-extractor.js";

export const PLANNER_GROUNDING_REPO_URL_ENV =
  "SYMPHONY_MANAGER_PLAN_GROUNDING_REPO_URL";
export const PLANNER_GROUNDING_COMMIT_ENV =
  "SYMPHONY_MANAGER_PLAN_GROUNDING_COMMIT";
export const PLANNER_GROUNDING_REPO_SCOPE_ENV =
  "SYMPHONY_MANAGER_PLAN_GROUNDING_REPO_SCOPE";
export const PLANNER_GROUNDING_REPO_URL_FALLBACK_ENV = "REPO_URL";

const execFileAsync = promisify(execFile);

export interface BuildPlannerCodeGroundingInput {
  workflowConfig: Pick<
    ResolvedWorkflowConfig,
    "codeGrounding" | "plannerGrounding" | "workspace"
  >;
  runId: string;
  target: CodeGroundingTarget;
  workspaceRoot?: string;
  commandRunner?: RunCodeGroundingInput["commandRunner"];
  afterDeterministicScan?: RunCodeGroundingInput["afterDeterministicScan"];
}

export function buildPlannerCodeGroundingInput(
  input: BuildPlannerCodeGroundingInput,
): Omit<RunCodeGroundingInput, "findings"> | null {
  if (
    input.workflowConfig.plannerGrounding?.enabled !== true ||
    input.workflowConfig.codeGrounding?.enabled !== true
  ) {
    return null;
  }
  return {
    workspaceRoot: input.workspaceRoot ?? input.workflowConfig.workspace.root,
    runId: input.runId,
    config: input.workflowConfig.codeGrounding,
    target: input.target,
    ...(input.commandRunner === undefined
      ? {}
      : { commandRunner: input.commandRunner }),
    ...(input.afterDeterministicScan === undefined
      ? {}
      : { afterDeterministicScan: input.afterDeterministicScan }),
  };
}

export interface PlannerContextGroundingInput {
  context: PlannerContext;
  candidates: readonly Issue[];
  env: NodeJS.ProcessEnv;
  now: () => Date;
  repoUrl: string | null;
  commitSha: string | null;
  repoScope: "symphony" | "non_symphony" | null;
  codeGroundingConfig?: CodeGroundingConfig;
  workspaceRoot?: string;
  checkoutRoot?: string;
  runIdPrefix?: string;
  target?: CodeGroundingTarget;
  extractGroundingEvidence?: typeof extractGroundingEvidence;
  readLinearDocument?: (documentId: string) => Promise<string | null>;
}

export type PlannerContextGroundingResult = { context: PlannerContext };

type ShadowGroundingTickInput = Pick<
  PlannerContextGroundingInput,
  "context" | "candidates" | "now"
>;

export interface BuildShadowGroundingDepInput {
  workflowConfig: Pick<ResolvedWorkflowConfig, "plannerGrounding">;
  env: NodeJS.ProcessEnv;
  workspaceRoot: string;
  checkoutRoot: string;
}

export function buildShadowGroundingDep(input: BuildShadowGroundingDepInput) {
  const { plannerGrounding } = input.workflowConfig;
  if (plannerGrounding?.enabled !== true) {
    return {};
  }
  const repoUrl = input.env[PLANNER_GROUNDING_REPO_URL_FALLBACK_ENV]?.trim();
  if (repoUrl === undefined || repoUrl === "") {
    return {};
  }
  const repoScope = inferPlannerGroundingRepoScope(repoUrl);
  if (repoScope !== "symphony") {
    return {};
  }
  const commitSha = input.env[PLANNER_GROUNDING_COMMIT_ENV]?.trim() || null;
  return {
    groundPlannerContext: ({
      context,
      candidates,
      now,
    }: ShadowGroundingTickInput) =>
      groundPlannerContext({
        context,
        candidates,
        env: input.env,
        now,
        repoUrl,
        commitSha,
        repoScope,
        workspaceRoot: input.workspaceRoot,
        checkoutRoot: input.checkoutRoot,
        runIdPrefix: "standing-plan-shadow",
      }),
  };
}

export async function groundPlannerContext(
  input: PlannerContextGroundingInput,
): Promise<PlannerContextGroundingResult> {
  const target = input.target ?? (await resolvePlannerGroundingTarget(input));
  const candidatesById = new Map(
    input.candidates.map((issue) => [issue.id, issue]),
  );
  const evidenceByIssueId = new Map<
    string,
    PlannerCandidateGroundingEvidence
  >();
  const extract = input.extractGroundingEvidence ?? extractGroundingEvidence;

  for (const candidate of input.context.backlog) {
    const issue = candidatesById.get(candidate.issueId);
    if (issue === undefined) {
      continue;
    }
    const startedAt = input.now().getTime();
    const runId = `${
      input.runIdPrefix ?? "manager-plan"
    }-${input.now().toISOString()}`;
    const rootSources = [
      {
        id: "title",
        text: candidate.title,
      },
      {
        id: "body",
        text: candidate.description,
      },
      ...(candidate.comments ?? []).map((comment) => ({
        id: `comment:${comment.id}`,
        text: comment.body,
      })),
    ];
    const followedDocs = await followGroundingDocs({
      checkoutRoot: input.checkoutRoot ?? process.cwd(),
      candidateId: candidate.issueId,
      candidateIdentifier: candidate.issueIdentifier,
      rootSources,
      attachedDocuments: issue.documentAttachments ?? [],
      ...(input.readLinearDocument === undefined &&
      (input.env.LINEAR_API_KEY === undefined ||
        input.env.LINEAR_API_KEY.trim() === "")
        ? {}
        : {
            readLinearDocument:
              input.readLinearDocument ??
              (async (documentId: string) =>
                (
                  await fetchLinearDocumentContent(
                    {
                      endpoint:
                        input.env.LINEAR_ENDPOINT ?? DEFAULT_LINEAR_ENDPOINT,
                      apiKey: input.env.LINEAR_API_KEY ?? "",
                      fetchFn: fetch,
                    },
                    { documentId },
                  )
                )?.content ?? null),
          }),
    });
    const result = await extract({
      candidateId: candidate.issueId,
      candidateIdentifier: candidate.issueIdentifier,
      sources: [
        {
          id: "title",
          kind: "ticket_title",
          label: "ticket title",
          text: candidate.title,
        },
        {
          id: "body",
          kind: "ticket_body",
          label: "ticket body",
          text: candidate.description,
        },
        ...(candidate.comments ?? []).map((comment) => ({
          id: `comment:${comment.id}`,
          kind: "comment" as const,
          label: `comment ${comment.id}`,
          text: comment.body,
        })),
        ...followedDocs.followedDocs.map((document) => ({
          id: `document:${document.key}`,
          kind: "document" as const,
          label:
            document.title ?? `${document.kind} document ${document.reference}`,
          text: document.content,
        })),
      ],
      grounding: {
        workspaceRoot: input.workspaceRoot ?? process.cwd(),
        runId,
        config:
          input.codeGroundingConfig ?? defaultPlannerCodeGroundingConfig(),
        target,
      },
    });
    evidenceByIssueId.set(
      candidate.issueId,
      toPlannerCandidateGroundingEvidence(
        result,
        Math.max(0, input.now().getTime() - startedAt),
        followedDocs.warnings,
      ),
    );
  }

  return {
    context: {
      ...input.context,
      backlog: input.context.backlog.map((candidate) => {
        const groundingEvidence = evidenceByIssueId.get(candidate.issueId);
        return {
          ...candidate,
          ...(groundingEvidence === undefined ? {} : { groundingEvidence }),
        };
      }),
    },
  };
}

export async function resolvePlannerGroundingTarget(
  input: Pick<
    PlannerContextGroundingInput,
    "repoUrl" | "commitSha" | "repoScope" | "env" | "checkoutRoot"
  > & { cwd?: string },
): Promise<CodeGroundingTarget> {
  const cwd = input.cwd ?? input.checkoutRoot ?? process.cwd();
  const repoUrl =
    input.repoUrl?.trim() ||
    input.env[PLANNER_GROUNDING_REPO_URL_ENV]?.trim() ||
    input.env[PLANNER_GROUNDING_REPO_URL_FALLBACK_ENV]?.trim() ||
    (await readGitValue(["config", "--get", "remote.origin.url"], cwd));
  if (repoUrl === null || repoUrl.trim() === "") {
    throw new Error(
      "planner grounding requires --planner-grounding-repo-url, SYMPHONY_MANAGER_PLAN_GROUNDING_REPO_URL, REPO_URL, or git remote.origin.url",
    );
  }
  const commitSha =
    input.commitSha?.trim() ||
    input.env[PLANNER_GROUNDING_COMMIT_ENV]?.trim() ||
    (await readGitValue(["rev-parse", "HEAD"], cwd));
  if (commitSha === null || commitSha.trim() === "") {
    throw new Error(
      "planner grounding requires --planner-grounding-commit, SYMPHONY_MANAGER_PLAN_GROUNDING_COMMIT, or git rev-parse HEAD",
    );
  }
  const repoScope =
    input.repoScope ??
    readPlannerGroundingRepoScope(input.env) ??
    inferPlannerGroundingRepoScope(repoUrl);
  return {
    repoUrl,
    commitSha,
    repoScope,
  };
}

export function readPlannerGroundingRepoScope(
  env: NodeJS.ProcessEnv,
): "symphony" | "non_symphony" | null {
  const value = env[PLANNER_GROUNDING_REPO_SCOPE_ENV];
  if (value === "symphony" || value === "non_symphony") {
    return value;
  }
  return null;
}

export function inferPlannerGroundingRepoScope(
  repoUrl: string,
): "symphony" | "non_symphony" {
  const normalizedRepoUrl = repoUrl.trim().replace(/\/+$/u, "");
  return /(?:^|[/:])symphony(?:-ts)?(?:\.git)?$/i.test(normalizedRepoUrl)
    ? "symphony"
    : "non_symphony";
}

export function toPlannerCandidateGroundingEvidence(
  result: GroundingExtractionResult,
  wallClockMs: number,
  docWarnings: readonly string[] = [],
): PlannerCandidateGroundingEvidence {
  const reportStatus = result.groundingReport?.status;
  const ungrounded = reportStatus === "ungrounded";
  return {
    status: ungrounded ? "ungrounded" : "grounded",
    reason: ungrounded
      ? "Grounding skipped because the repository is outside the v1 Symphony grounding scope."
      : null,
    digest: result.digest,
    claims: result.claims.map((claim) => ({
      id: claim.id,
      kind: claim.kind,
      text: claim.text,
      summary: claim.summary,
      status: claim.status,
      citations: claim.citations.map((citation) => ({
        path: citation.path,
        lineRange: citation.lineRange,
        matchedSpan: citation.matchedSpan,
      })),
      missing: claim.missing,
    })),
    units: result.units.map((unit) => ({
      unitId: unit.unitId,
      title: unit.title,
      wave: unit.wave,
      completionState: unit.completionState,
      rationale: unit.rationale,
    })),
    warnings: [
      ...docWarnings,
      ...result.warnings,
      ...(result.groundingReport?.warnings ?? []),
    ],
    extractorCallCount: result.extractorCallCount,
    wallClockMs,
  };
}

async function readGitValue(
  args: readonly string[],
  cwd: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", [...args], { cwd });
    const value = stdout.trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

function defaultPlannerCodeGroundingConfig(): CodeGroundingConfig {
  return {
    enabled: true,
    baseDir: DEFAULT_CODE_GROUNDING_BASE_DIR,
    ttlMs: DEFAULT_CODE_GROUNDING_TTL_MS,
    maxCheckoutsPerRepo: DEFAULT_CODE_GROUNDING_MAX_CHECKOUTS_PER_REPO,
    materializationTimeoutMs: DEFAULT_CODE_GROUNDING_MATERIALIZATION_TIMEOUT_MS,
  };
}
