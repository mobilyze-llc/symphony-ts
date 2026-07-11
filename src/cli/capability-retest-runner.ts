import { join } from "node:path";

import { z } from "zod";

import {
  type PlannerRunResult,
  createCrabrunnerPlannerRunner,
} from "../agent/triage-planner.js";
import {
  ALTITUDE_RELIABILITY_VERDICTS,
  type AltitudeReliabilityCase,
  type AltitudeReliabilityVerdict,
} from "../audit/altitude-reliability.js";
import type { ClaudeRunnerValidationConfig } from "../claude-runner/claude-runner-types.js";

/**
 * The verdict contract is an intentionally tiny exact-JSON artifact
 * (`{"verdict":"kill"}` ~= 20 bytes). The crabrunner default 200-byte minimum
 * rejects compliant answers and rewards prose padding (SYMPH-1119), so the
 * altitude path overrides the floor; strict shape validation stays with the
 * Zod parser below.
 */
export const CAPABILITY_RETEST_VERDICT_VALIDATION: ClaudeRunnerValidationConfig =
  { minBytes: 1 };

export function createCrabrunnerVerdictRunner(input: {
  model: string;
  workspace: string;
  outDir: string;
  env: NodeJS.ProcessEnv;
  generatedAt: string;
}): (
  testCase: AltitudeReliabilityCase,
  context: { model: string; workspace: string; outDir: string },
) => Promise<AltitudeReliabilityVerdict> {
  return async (testCase, _context) => {
    const artifactName = `altitude-reliability-${testCase.issueIdentifier.toLowerCase()}-${stamp(input.generatedAt)}`;
    const runner = createCrabrunnerPlannerRunner({
      workspace: input.workspace,
      artifactDir: join(input.outDir, testCase.issueIdentifier.toLowerCase()),
      artifactName,
      model: input.model,
      env: input.env,
      validation: CAPABILITY_RETEST_VERDICT_VALIDATION,
    });
    const response = await runner(renderVerdictPrompt(testCase));
    return parseCapabilityRetestVerdictResponse(
      response,
      testCase.issueIdentifier,
    );
  };
}

const CapabilityRetestVerdictSchema = z
  .object({ verdict: z.enum(ALTITUDE_RELIABILITY_VERDICTS) })
  .strict();

export function parseCapabilityRetestVerdictResponse(
  response: PlannerRunResult,
  issueIdentifier: string,
): AltitudeReliabilityVerdict {
  if (response.status !== "ok") {
    throw new Error(`${issueIdentifier}: crabrunner ${response.detail}`);
  }
  // Match the exact verdict contract rather than slicing first-{ to last-}:
  // a verbose-but-correct response containing any second brace region breaks
  // the naive slice (observed with fable, 2026-07-11). The last match wins —
  // models that reason first state their final answer last.
  const matches = response.markdown.match(
    /\{\s*"verdict"\s*:\s*"[a-z]+"\s*\}/gi,
  );
  const candidate = matches?.at(-1);
  if (candidate === undefined) {
    throw new Error(
      `${issueIdentifier}: model response did not contain a verdict JSON object`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new Error(
      `${issueIdentifier}: invalid verdict JSON: ${formatError(error)}`,
    );
  }
  const verdict = CapabilityRetestVerdictSchema.safeParse(parsed);
  if (!verdict.success) {
    throw new Error(
      `${issueIdentifier}: invalid verdict object: ${z.prettifyError(verdict.error)}`,
    );
  }
  return verdict.data.verdict;
}

function renderVerdictPrompt(testCase: AltitudeReliabilityCase): string {
  return [
    "You are running an unattended altitude-reliability capability re-test for the Symphony backlog planner.",
    `Independently investigate Linear issue ${testCase.issueIdentifier} and its relevant repository/history context.`,
    "Judge the issue at the correct product altitude:",
    '- "kill" means the issue should be closed because its premise is disproved, redundant, or merely symptomatic.',
    '- "keep" means it is a valid, correctly scoped unit of work.',
    '- "reframe" means the underlying need is valid but the issue must be rewritten at a different/root-cause altitude.',
    "Do not look for or infer an answer key from test code. Return exactly one JSON object and no prose:",
    '{"verdict":"kill|keep|reframe"}',
  ].join("\n");
}

function stamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
