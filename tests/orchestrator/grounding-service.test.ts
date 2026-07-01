import { describe, expect, it } from "vitest";

import type {
  CodeGroundingClaim,
  CodeGroundingReport,
  RunCodeGroundingInput,
} from "../../src/orchestrator/code-grounding.js";
import { GroundingService } from "../../src/orchestrator/grounding-service.js";

describe("grounding service", () => {
  it("reuses cached reports for identical claim sets at the same SHA", async () => {
    const service = new GroundingService();
    let calls = 0;
    const runGrounding = async (
      input: RunCodeGroundingInput,
    ): Promise<CodeGroundingReport> => {
      calls += 1;
      return reportFor(input, "verified");
    };

    const input = serviceInput({
      findings: [claim("finding-1", "See `src/foo.ts`.")],
      runGrounding,
    });
    await service.run(input);
    await service.run(input);

    expect(calls).toBe(1);
  });

  it("misses the cache when comment/body text changes at the same SHA", async () => {
    const service = new GroundingService();
    let calls = 0;
    const runGrounding = async (
      input: RunCodeGroundingInput,
    ): Promise<CodeGroundingReport> => {
      calls += 1;
      return reportFor(input, "verified");
    };

    await service.run(
      serviceInput({
        findings: [claim("finding-1", "Comment A cites `src/foo.ts`.")],
        runGrounding,
      }),
    );
    await service.run(
      serviceInput({
        findings: [claim("finding-1", "Comment B cites `src/foo.ts`.")],
        runGrounding,
      }),
    );

    expect(calls).toBe(2);
  });

  it("misses the cache when the code SHA advances", async () => {
    const service = new GroundingService();
    let calls = 0;
    const runGrounding = async (
      input: RunCodeGroundingInput,
    ): Promise<CodeGroundingReport> => {
      calls += 1;
      return reportFor(input, "verified");
    };

    await service.run(
      serviceInput({
        targetSha: "sha-1",
        findings: [claim("finding-1", "See `src/foo.ts`.")],
        runGrounding,
      }),
    );
    await service.run(
      serviceInput({
        targetSha: "sha-2",
        findings: [claim("finding-1", "See `src/foo.ts`.")],
        runGrounding,
      }),
    );

    expect(calls).toBe(2);
  });

  it("keeps planner and hygiene cache entries distinct", async () => {
    const service = new GroundingService();
    let calls = 0;
    const runGrounding = async (
      input: RunCodeGroundingInput,
    ): Promise<CodeGroundingReport> => {
      calls += 1;
      return reportFor(input, "verified");
    };

    const findings = [claim("finding-1", "See `src/foo.ts`.")];
    await service.run(
      serviceInput({ consumer: "planner", findings, runGrounding }),
    );
    await service.run(
      serviceInput({ consumer: "backlog_hygiene", findings, runGrounding }),
    );

    expect(calls).toBe(2);
  });

  it("maps non-symphony not_attempted reports to explicit ungrounded entries", async () => {
    const service = new GroundingService();
    const result = await service.run(
      serviceInput({
        repoScope: "non_symphony",
        findings: [claim("finding-1", "See `src/foo.ts`.")],
        runGrounding: async (input) => reportFor(input, "not_attempted"),
      }),
    );

    expect(result.status).toBe("ungrounded");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.status).toBe("ungrounded");
    expect(result.entries[0]?.summary).toMatch(/outside the v1 Symphony/i);
  });
});

function serviceInput(input: {
  findings: CodeGroundingClaim[];
  consumer?: "planner" | "backlog_hygiene";
  targetSha?: string;
  repoScope?: "symphony" | "non_symphony";
  runGrounding: (input: RunCodeGroundingInput) => Promise<CodeGroundingReport>;
}) {
  return {
    workspaceRoot: "/workspace",
    runId: "run-1",
    consumer: input.consumer ?? "planner",
    config: {
      enabled: true,
      baseDir: ".grounding",
      ttlMs: 1000,
      maxCheckoutsPerRepo: 1,
    },
    target: {
      repoUrl: "file:///repo",
      commitSha: input.targetSha ?? "sha-1",
      repoScope: input.repoScope ?? "symphony",
    },
    findings: input.findings,
    runGrounding: input.runGrounding,
  };
}

function claim(findingId: string, evidence: string): CodeGroundingClaim {
  return {
    findingId,
    type: "other",
    issueIdentifiers: ["SYMPH-1"],
    summary: "Claim",
    evidence,
    confidence: "medium",
  };
}

function reportFor(
  input: RunCodeGroundingInput,
  status: CodeGroundingReport["status"],
): CodeGroundingReport {
  return {
    generatedAt: "2026-07-01T00:00:00.000Z",
    status,
    checkout: {
      checkoutId: "checkout",
      path: "/checkout",
      commitSha: input.target.commitSha,
      repoUrl: input.target.repoUrl,
    },
    entries: input.findings.map((finding) => ({
      findingId: finding.findingId,
      status,
      summary: "summary",
      citations: [],
      missing: [],
    })),
    cleanup: {
      leaseReleased: true,
      checkoutPurged: false,
      dirtyState: null,
    },
    warnings: [],
  };
}
