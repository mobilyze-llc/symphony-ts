import { createHash } from "node:crypto";

import type {
  CodeGroundingClaim,
  CodeGroundingReport,
  RunCodeGroundingInput,
} from "./code-grounding.js";
import { runManagedCodeGrounding } from "./code-grounding.js";

export type GroundingConsumer = "planner" | "backlog_hygiene";

export interface RunGroundingServiceInput extends RunCodeGroundingInput {
  consumer: GroundingConsumer;
  runGrounding?: (input: RunCodeGroundingInput) => Promise<CodeGroundingReport>;
}

export class GroundingService {
  private readonly cache = new Map<string, CodeGroundingReport>();

  async run(input: RunGroundingServiceInput): Promise<CodeGroundingReport> {
    const cacheKey = buildGroundingCacheKey(input);
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cloneReport(cached);
    }
    const runGrounding = input.runGrounding ?? runManagedCodeGrounding;
    const report = normalizeGroundingReport(
      await runGrounding(stripServiceInput(input)),
      input,
    );
    this.cache.set(cacheKey, cloneReport(report));
    return report;
  }

  clear(): void {
    this.cache.clear();
  }
}

export const sharedGroundingService = new GroundingService();

export async function runSharedCodeGrounding(
  input: RunGroundingServiceInput,
): Promise<CodeGroundingReport> {
  return sharedGroundingService.run(input);
}

export function buildGroundingCacheKey(input: {
  consumer: GroundingConsumer;
  target: RunCodeGroundingInput["target"];
  findings: readonly CodeGroundingClaim[];
  modelFindings?: RunCodeGroundingInput["modelFindings"];
}): string {
  return hashJson({
    version: 1,
    consumer: input.consumer,
    repoUrl: input.target.repoUrl,
    codeSha: input.target.commitSha,
    repoScope: input.target.repoScope,
    claimSet: input.findings.map((finding) => ({
      findingId: finding.findingId,
      type: finding.type,
      issueIdentifiers: finding.issueIdentifiers,
      summary: finding.summary,
      evidence: finding.evidence,
      confidence: finding.confidence,
      cull: finding.cull ?? null,
    })),
    modelFindings: input.modelFindings ?? [],
  });
}

function normalizeGroundingReport(
  report: CodeGroundingReport,
  input: RunGroundingServiceInput,
): CodeGroundingReport {
  if (
    input.target.repoScope === "symphony" ||
    report.status !== "not_attempted"
  ) {
    return report;
  }
  return {
    ...report,
    status: "ungrounded",
    entries: report.entries.map((entry) => ({
      ...entry,
      status: entry.status === "not_attempted" ? "ungrounded" : entry.status,
      summary:
        entry.status === "not_attempted"
          ? "Grounding skipped because the repository is outside the v1 Symphony grounding scope."
          : entry.summary,
    })),
    warnings:
      report.warnings.length === 0
        ? ["repository is outside the v1 Symphony grounding scope"]
        : report.warnings,
  };
}

function stripServiceInput(
  input: RunGroundingServiceInput,
): RunCodeGroundingInput {
  const {
    consumer: _consumer,
    runGrounding: _runGrounding,
    ...coreInput
  } = input;
  return coreInput;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cloneReport(report: CodeGroundingReport): CodeGroundingReport {
  return {
    ...report,
    checkout: { ...report.checkout },
    entries: report.entries.map((entry) => ({
      ...entry,
      citations: entry.citations.map((citation) => ({
        ...citation,
        lineRange: [citation.lineRange[0], citation.lineRange[1]],
      })),
      missing: [...entry.missing],
    })),
    cleanup: {
      ...report.cleanup,
      dirtyState:
        report.cleanup.dirtyState === null
          ? null
          : { ...report.cleanup.dirtyState },
    },
    warnings: [...report.warnings],
  };
}
