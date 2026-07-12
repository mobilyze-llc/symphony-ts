import { join } from "node:path";

import { z } from "zod";

import type { PlannerRunResult } from "../agent/triage-planner.js";
import {
  ALTITUDE_RELIABILITY_VERDICTS,
  type AltitudeReliabilityCase,
  type AltitudeReliabilityContractViolation,
  type AltitudeReliabilityVerdict,
  type AltitudeReliabilityVerdictObservation,
} from "../audit/altitude-reliability.js";
import { createToolFreeClusteringPlannerRunner } from "./clustering-tool-free-runner.js";

export function createCrabrunnerVerdictRunner(input: {
  model: string;
  reasoningLevel: string;
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
    const runner = createToolFreeClusteringPlannerRunner({
      workspace: input.workspace,
      artifactDir: join(input.outDir, testCase.issueIdentifier.toLowerCase()),
      artifactName,
      model: input.model,
      reasoningLevel: input.reasoningLevel,
      env: input.env,
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
  const candidate = findVerdictJsonCandidate(markdown, issueIdentifier);
  const violations = [
    ...contractProseViolations(markdown, candidate.start, candidate.end),
    ...contractShapeViolations(candidate.parsed),
  ];
  if (violations.length === 0) return candidate.verdict;
  return {
    verdict: candidate.verdict,
    contractViolation: modelContractViolation(violations.join("; ")),
  };
}

export function renderVerdictPrompt(testCase: AltitudeReliabilityCase): string {
  return [
    "You are running an unattended altitude-reliability capability re-test for the Symphony backlog planner.",
    `Classify Linear issue ${testCase.issueIdentifier} from this prompt alone.`,
    "This benchmark provides a frozen issue snapshot and no live Linear access, git history, docs, tests, or answer-key context. Do not use tools, inspect files, or try to recover other context.",
    "",
    "<issue_snapshot>",
    `Identifier: ${testCase.issueIdentifier}`,
    `Title: ${testCase.snapshot.title}`,
    "Description:",
    testCase.snapshot.description,
    "</issue_snapshot>",
    "",
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

function findVerdictJsonCandidate(
  markdown: string,
  issueIdentifier: string,
): {
  start: number;
  end: number;
  parsed: unknown;
  verdict: AltitudeReliabilityVerdict;
} {
  let searchFrom = 0;
  let firstParseError: string | null = null;
  let firstCoreError: z.ZodError | null = null;
  while (searchFrom < markdown.length) {
    const start = markdown.indexOf("{", searchFrom);
    if (start === -1) break;
    const end = findJsonObjectEnd(markdown, start);
    if (end === null) {
      firstParseError ??= "incomplete JSON object";
      searchFrom = start + 1;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(markdown.slice(start, end + 1));
    } catch (error) {
      firstParseError ??= formatError(error);
      searchFrom = start + 1;
      continue;
    }
    const core = CapabilityRetestVerdictCoreSchema.safeParse(parsed);
    if (core.success) {
      return { start, end, parsed, verdict: core.data.verdict };
    }
    firstCoreError ??= core.error;
    searchFrom = end + 1;
  }
  if (firstCoreError !== null) {
    throw new Error(
      `${issueIdentifier}: invalid verdict object: ${z.prettifyError(firstCoreError)}`,
    );
  }
  if (firstParseError !== null) {
    throw new Error(
      `${issueIdentifier}: invalid verdict JSON: ${firstParseError}`,
    );
  }
  throw new Error(`${issueIdentifier}: model response did not contain JSON`);
}

function findJsonObjectEnd(markdown: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < markdown.length; index += 1) {
    const char = markdown[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return null;
    }
  }
  return null;
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
