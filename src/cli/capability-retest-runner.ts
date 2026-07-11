import { join } from "node:path";

import { z } from "zod";

import {
  type PlannerRunResult,
  createCrabrunnerPlannerRunner,
} from "../agent/triage-planner.js";
import {
  ALTITUDE_RELIABILITY_VERDICTS,
  type AltitudeReliabilityCase,
  type AltitudeReliabilityContractViolation,
  type AltitudeReliabilityVerdictObservation,
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
) => Promise<AltitudeReliabilityVerdictObservation> {
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
const CapabilityRetestVerdictCoreSchema = z
  .object({ verdict: z.enum(ALTITUDE_RELIABILITY_VERDICTS) })
  .passthrough();

export function parseCapabilityRetestVerdictResponse(
  response: PlannerRunResult,
  issueIdentifier: string,
): AltitudeReliabilityVerdictObservation {
  if (response.status !== "ok") {
    throw new Error(`${issueIdentifier}: crabrunner ${response.detail}`);
  }
  const markdown = response.markdown;
  const start = markdown.indexOf("{");
  const end = markdown.lastIndexOf("}");
  if (start === -1 || end < start) {
    throw new Error(`${issueIdentifier}: model response did not contain JSON`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(markdown.slice(start, end + 1));
  } catch (error) {
    throw new Error(
      `${issueIdentifier}: invalid verdict JSON: ${formatError(error)}`,
    );
  }
  const core = CapabilityRetestVerdictCoreSchema.safeParse(parsed);
  if (!core.success) {
    throw new Error(
      `${issueIdentifier}: invalid verdict object: ${z.prettifyError(core.error)}`,
    );
  }
  const violations = [
    ...contractProseViolations(markdown, start, end),
    ...contractShapeViolations(parsed),
  ];
  if (violations.length === 0) return core.data.verdict;
  return {
    verdict: core.data.verdict,
    contractViolation: modelContractViolation(violations.join("; ")),
  };
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

function contractProseViolations(
  markdown: string,
  start: number,
  end: number,
): string[] {
  const violations: string[] = [];
  if (markdown.slice(0, start).trim() !== "") {
    violations.push("response included prose before the verdict JSON");
  }
  if (markdown.slice(end + 1).trim() !== "") {
    violations.push("response included prose after the verdict JSON");
  }
  return violations;
}

function contractShapeViolations(parsed: unknown): string[] {
  const strict = CapabilityRetestVerdictSchema.safeParse(parsed);
  if (strict.success) return [];
  return ["verdict JSON had extra or malformed fields"];
}

function modelContractViolation(
  detail: string,
): AltitudeReliabilityContractViolation {
  return { type: "output_contract_violation", detail };
}
