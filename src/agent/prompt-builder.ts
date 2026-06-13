import { dirname, normalize, resolve, sep } from "node:path";
import { Liquid } from "liquidjs";

import type { Issue, WorkflowDefinition } from "../domain/model.js";
import { ERROR_CODES } from "../errors/codes.js";
import type { ModeScopedPermissionPolicy } from "../policy/hard-stops.js";
import { withModePermissionEnvelope } from "../policy/hard-stops.js";

export const DEFAULT_WORKFLOW_PROMPT =
  "You are working on an issue from Linear.";

const DEFAULT_PARTIAL_ROOTS = [".", "pipeline-config"] as const;

type RenderPromptWorkflow = Pick<WorkflowDefinition, "promptTemplate"> & {
  workflowPath?: string;
};

export class PromptTemplateError extends Error {
  readonly code: string;
  readonly kind: "template_parse_error" | "template_render_error";

  constructor(
    kind: "template_parse_error" | "template_render_error",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PromptTemplateError";
    this.code =
      kind === "template_parse_error"
        ? ERROR_CODES.templateParseError
        : ERROR_CODES.templateRenderError;
    this.kind = kind;
  }
}

export interface RenderPromptInput {
  workflow: RenderPromptWorkflow;
  issue: Issue;
  attempt: number | null;
  stageName?: string | null;
  reworkCount?: number;
  /**
   * Frozen gate-passed AC snapshot (SYMPH-374). Always rendered into the
   * context as `acceptance_criteria` ("" when absent) so templates can
   * reference it unconditionally under strictVariables.
   */
  acceptanceCriteria?: string | null;
  modePolicy?: ModeScopedPermissionPolicy | null;
}

export interface BuildTurnPromptInput extends RenderPromptInput {
  turnNumber: number;
  maxTurns: number;
}

export function getEffectivePromptTemplate(promptTemplate: string): string {
  const trimmed = promptTemplate.trim();

  return trimmed.length > 0 ? trimmed : DEFAULT_WORKFLOW_PROMPT;
}

export async function renderPrompt(input: RenderPromptInput): Promise<string> {
  const template = getEffectivePromptTemplate(input.workflow.promptTemplate);
  const engine = createLiquidEngine(input.workflow.workflowPath);

  try {
    const parsedTemplate = engine.parse(template);

    const rendered = await engine.render(parsedTemplate, {
      issue: toTemplateIssue(input.issue),
      attempt: input.attempt,
      stageName: input.stageName ?? null,
      reworkCount: input.reworkCount ?? 0,
      acceptance_criteria: input.acceptanceCriteria ?? "",
    });

    return withModePermissionEnvelope({
      prompt: rendered,
      policy: input.modePolicy ?? null,
    });
  } catch (error) {
    throw toPromptTemplateError(error);
  }
}

function createLiquidEngine(workflowPath?: string): Liquid {
  return new Liquid({
    partials: resolvePartialRoots(workflowPath),
    strictVariables: true,
    strictFilters: true,
    ownPropertyOnly: true,
  });
}

function resolvePartialRoots(workflowPath?: string): string[] {
  if (workflowPath === undefined) {
    return [...DEFAULT_PARTIAL_ROOTS];
  }

  const workflowDirectory = normalize(dirname(workflowPath));
  const pipelineConfigDirectory =
    resolvePipelineConfigDirectory(workflowDirectory);

  return Array.from(
    new Set([
      workflowDirectory,
      pipelineConfigDirectory,
      resolve(pipelineConfigDirectory, ".."),
      ...DEFAULT_PARTIAL_ROOTS,
    ]),
  );
}

function resolvePipelineConfigDirectory(workflowDirectory: string): string {
  const marker = `${sep}pipeline-config`;
  const markerIndex = workflowDirectory.lastIndexOf(marker);
  if (markerIndex !== -1) {
    return workflowDirectory.slice(0, markerIndex + marker.length);
  }

  return resolve(workflowDirectory, "pipeline-config");
}

export async function buildTurnPrompt(
  input: BuildTurnPromptInput,
): Promise<string> {
  if (input.turnNumber <= 1) {
    return await renderPrompt(input);
  }

  return buildContinuationPrompt({
    issue: input.issue,
    attempt: input.attempt,
    turnNumber: input.turnNumber,
    maxTurns: input.maxTurns,
    stageName: input.stageName ?? null,
    modePolicy: input.modePolicy ?? null,
  });
}

export function buildContinuationPrompt(input: {
  issue: Issue;
  attempt: number | null;
  turnNumber: number;
  maxTurns: number;
  stageName?: string | null;
  modePolicy?: ModeScopedPermissionPolicy | null;
}): string {
  const attemptLine =
    input.attempt === null
      ? "This worker session started from the initial dispatch."
      : `This worker session is running retry/continuation attempt ${input.attempt}.`;

  const lines = [
    `Continue working on issue ${input.issue.identifier}: ${input.issue.title}.`,
    `This is continuation turn ${input.turnNumber} of ${input.maxTurns} in the current worker session.`,
    attemptLine,
    `Current tracker state: ${input.issue.state}.`,
    "Reuse the existing thread context and current workspace state.",
    "Do not restate the original task prompt unless it is strictly needed.",
    "Headless output budget still applies: write noisy command output to .symphony/validation/ and return only command metadata, exit code, log path, and a short tail/summary.",
    "Start broad inspection with path/count-only commands such as `rg -l`, `rg -c`, `find ... | sed -n '1,80p'`, and `git diff --stat`; then inspect relevant files with bounded contextual commands such as `rg -n ... -m 50 path` or `sed -n '<start>,<end>p'`. Do not stream broad match lines across the whole repo.",
    "Keep direct shell output under roughly 2,000 tokens. When a tool supports `max_output_tokens`, set it to 1,500 or less and also bound the command itself with `sed`, `head`, `tail`, `jq`, or `wc`.",
    "Shell snippets must be zsh-safe: do not assign to `status`; use `cmd_status`, `exit_code`, or another neutral variable name.",
    "Make the next best progress on the issue, then stop when this session has no further useful work to do.",
  ];

  if (input.stageName) {
    lines.push(`Current stage: ${input.stageName}.`);

    switch (input.stageName) {
      case "investigate":
        lines.push(
          "CONSTRAINT: You are in the INVESTIGATE stage. Do NOT implement code, create branches, or open PRs. Investigation and planning only.",
          "Investigation Token Brake: first inspect latest Linear issue comments/workpad/resume notes. Do not trust repo-root scratch files such as `workpad.md` or `INVESTIGATION-BRIEF.md` unless they explicitly name the current issue and stage. If the Linear context already identifies the next implementation move, reuse that plan instead of rediscovering the repo. Spend at most 6 shell/tool calls before posting the workpad unless a command fails and one retry is necessary. Use `max_output_tokens` of 800 or less. Do not run multi-file `sed` batches, broad `rg -n` over multiple top-level directories, full docs scans, or source dumps.",
          "If more discovery is truly required, write the open questions into the workpad and output [STAGE_COMPLETE]; the implement stage can do targeted reads while making changes. When you have posted your investigation findings, output the exact text [STAGE_COMPLETE] as the last line of your final message.",
        );
        break;
      case "implement":
        lines.push(
          "You are in the IMPLEMENT stage. Focus on implementing the code changes and running tests. Open a PR only when the Mode Permission Envelope allows PR creation; otherwise stop after verification and report BLOCKED-needs-human if a PR is required. When the permitted implement work is complete and all verify commands pass, output the exact text [STAGE_COMPLETE] as the last line of your final message.",
          "Headless output budget: do not stream high-volume searches, logs, JSON, lockfiles, validation commands, or generated output directly into the turn. Write full stdout/stderr to .symphony/validation/ and return only command metadata, exit code, log path, and a short tail/summary capped near 4 KB.",
        );
        break;
      case "merge":
        lines.push(
          "You are in the MERGE stage. Verify merge readiness, but do not run PR merge, auto-merge, admin, or bypass commands unless the Mode Permission Envelope explicitly allows them. Current mode policies deny auto-merge and gate bypass; report BLOCKED-needs-human when a denied merge action is required. When the permitted merge-stage work is complete, output the exact text [STAGE_COMPLETE] as the last line of your final message.",
        );
        break;
      default:
        lines.push(
          `When you have completed the ${input.stageName} stage, output the exact text [STAGE_COMPLETE] as the last line of your final message.`,
        );
        break;
    }
  }

  return withModePermissionEnvelope({
    prompt: lines.join("\n"),
    policy: input.modePolicy ?? null,
  });
}

function toTemplateIssue(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: issue.state,
    branch_name: issue.branchName,
    url: issue.url,
    labels: [...issue.labels],
    blocked_by: issue.blockedBy.map((blocker) => ({
      id: blocker.id,
      identifier: blocker.identifier,
      state: blocker.state,
    })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function toPromptTemplateError(error: unknown): PromptTemplateError {
  if (error instanceof PromptTemplateError) {
    return error;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string"
  ) {
    if (getErrorMessage(error).includes("undefined filter")) {
      return new PromptTemplateError(
        "template_render_error",
        getErrorMessage(error),
        { cause: error },
      );
    }

    if (error.name === "ParseError" || error.name === "TokenizationError") {
      return new PromptTemplateError(
        "template_parse_error",
        getErrorMessage(error),
        { cause: error },
      );
    }
  }

  return new PromptTemplateError(
    "template_render_error",
    getErrorMessage(error),
    {
      cause: error,
    },
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Prompt rendering failed";
}
