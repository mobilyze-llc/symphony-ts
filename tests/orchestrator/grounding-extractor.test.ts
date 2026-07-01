import { describe, expect, it, vi } from "vitest";

import type {
  CodeGroundingReport,
  CodeGroundingVerificationStatus,
  RunCodeGroundingInput,
} from "../../src/orchestrator/code-grounding.js";
import {
  type GroundingExtractorModelRunner,
  createPiGroundingExtractorModelRunner,
  extractGroundingEvidence,
  isGroundingCommentStatusUpdate,
  resolveGroundingExtractorModelRuntime,
  scoreGroundingCommentRelevance,
} from "../../src/orchestrator/grounding-extractor.js";
import type { GROUNDING_EXTRACTOR_ROUTE } from "../../src/orchestrator/grounding-extractor.js";

describe("grounding extractor", () => {
  it("resolves the Pi DeepSeek Pro route for the default local runtime", () => {
    expect(
      resolveGroundingExtractorModelRuntime({
        env: {
          SYMPHONY_GROUNDING_EXTRACTOR_BASE_URL:
            " http://studio2.local:8000/v1 ",
          SYMPHONY_GROUNDING_EXTRACTOR_API_KEY: "local-key",
          SYMPHONY_GROUNDING_EXTRACTOR_TIMEOUT_MS: "3000",
        },
      }),
    ).toMatchObject({
      baseUrl: "http://studio2.local:8000/v1",
      model: "deepseek/deepseek-v4-pro",
      apiKey: "local-key",
      timeoutMs: 3000,
    });
  });

  it("distinguishes bare status updates from prose ending in a status word", () => {
    expect(isGroundingCommentStatusUpdate("moved to In Progress")).toBe(true);
    expect(isGroundingCommentStatusUpdate("Done")).toBe(true);
    expect(
      isGroundingCommentStatusUpdate("The upstream issue was closed"),
    ).toBe(false);

    expect(
      scoreGroundingCommentRelevance({
        body: "The upstream issue was closed",
        automationNoise: false,
      }),
    ).toMatchObject({
      score: 0.5,
      rationale: "general issue discussion",
    });
  });

  it("scores plural verification phrasing as implementation signal", () => {
    expect(
      scoreGroundingCommentRelevance({
        body: "Ready once tests are passing in CI.",
        automationNoise: false,
      }),
    ).toMatchObject({
      score: 0.68,
      rationale: "implementation or verification signal",
    });
  });

  it("uses the committed Pi DeepSeek route and verifies prose path claims", async () => {
    let routeSeen: typeof GROUNDING_EXTRACTOR_ROUTE | null = null;
    const modelRunner: GroundingExtractorModelRunner = async (input) => {
      routeSeen = input.route;
      return {
        digest: "Implement the planner renderer change.",
        claims: [
          {
            id: "claim-renderer",
            sourceId: "body",
            kind: "path_symbol",
            text: "src/agent/triage-planner.ts",
            summary: "Renderer module is part of the work.",
          },
        ],
      };
    };

    const result = await extractGroundingEvidence({
      candidateId: "issue-1",
      candidateIdentifier: "SYMPH-1",
      sources: [
        {
          id: "body",
          kind: "ticket_body",
          label: "body",
          text: "Planner renderer work.",
        },
      ],
      modelRunner,
      grounding: groundingInput("verified"),
    });

    expect(routeSeen).toEqual({
      runner: "pi",
      model: "deepseek/deepseek-v4-pro",
    });
    expect(result.route.model).toBe("deepseek/deepseek-v4-pro");
    expect(result.route.model).not.toContain("flash");
    expect(result.claims[0]).toMatchObject({
      id: "claim-renderer",
      status: "verified",
    });
  });

  it("calls the Pi OpenAI-compatible extractor runner before verification", async () => {
    const fetchFn = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        expect(String(input)).toContain("studio2.local:8000");
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe("deepseek/deepseek-v4-pro");
        expect(JSON.stringify(body.messages ?? body.prompt ?? "")).toContain(
          "central local grounding extractor",
        );
        return chatCompletionResponse(
          JSON.stringify({
            digest: "Implement the planner renderer change.",
            claims: [
              {
                id: "claim-renderer",
                sourceId: "body",
                kind: "path_symbol",
                text: "src/agent/triage-planner.ts",
                summary: "Renderer module is part of the work.",
              },
            ],
          }),
        );
      },
    );

    const result = await extractGroundingEvidence({
      candidateId: "issue-1",
      candidateIdentifier: "SYMPH-1",
      sources: [
        {
          id: "body",
          kind: "ticket_body",
          label: "body",
          text: "Planner renderer work.",
        },
      ],
      modelRunner: createPiGroundingExtractorModelRunner({
        baseUrl: "http://studio2.local:8000/v1",
        model: "deepseek/deepseek-v4-pro",
        apiKey: "test-key",
        fetchFn: fetchFn as unknown as typeof fetch,
        timeoutMs: 1000,
        env: {},
      }),
      grounding: groundingInput("verified"),
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.extractorCallCount).toBe(1);
    expect(result.claims[0]).toMatchObject({
      id: "claim-renderer",
      status: "verified",
    });
  });

  it("backstops hallucinated extractor claims as not_found", async () => {
    const result = await extractGroundingEvidence({
      candidateId: "issue-2",
      sources: [
        {
          id: "doc",
          kind: "document",
          label: "plan",
          text: "The model may hallucinate.",
        },
      ],
      modelRunner: async () => ({
        claims: [
          {
            id: "claim-missing",
            kind: "path_symbol",
            text: "src/does-not-exist.ts",
          },
        ],
      }),
      grounding: groundingInput("not_found"),
    });

    expect(result.claims[0]?.status).toBe("not_found");
    expect(result.claims[0]?.missing).toEqual(["src/does-not-exist.ts"]);
  });

  it("falls back to deterministic extraction when the local model is unavailable", async () => {
    const result = await extractGroundingEvidence({
      candidateId: "issue-fallback",
      sources: [
        {
          id: "body",
          kind: "ticket_body",
          label: "body",
          text: "Fallback still checks `src/orchestrator/core.ts`.",
        },
      ],
      modelRunner: async () => {
        throw new Error("connection refused");
      },
    });

    expect(result.extractorCallCount).toBe(1);
    expect(result.warnings[0]).toContain(
      "grounding extractor model unavailable",
    );
    expect(result.claims[0]).toMatchObject({
      text: "src/orchestrator/core.ts",
      status: "not_attempted",
    });
  });

  it("maps a multi-unit wave-spanning plan to per-unit completion states", async () => {
    const result = await extractGroundingEvidence({
      candidateId: "issue-3",
      sources: [
        {
          id: "plan",
          kind: "document",
          label: "plan",
          text: "Wave 1 and Wave 2 plan.",
        },
      ],
      modelRunner: async () => ({
        claims: [
          { id: "claim-u9", kind: "path_symbol", text: "src/u9.ts" },
          { id: "claim-u10", kind: "path_symbol", text: "src/u10.ts" },
        ],
        units: [
          {
            unitId: "U9",
            title: "Extractor",
            wave: "Wave 1",
            claimIds: ["claim-u9"],
          },
          {
            unitId: "U10",
            title: "Comment relevance",
            wave: "Wave 2",
            claimIds: ["claim-u10"],
          },
        ],
      }),
      grounding: {
        ...groundingInput("verified"),
        runGrounding: async (input) =>
          reportFor(input, (findingId) =>
            findingId === "claim-u9" ? "verified" : "not_found",
          ),
      },
    });

    expect(result.units).toEqual([
      expect.objectContaining({
        unitId: "U9",
        wave: "Wave 1",
        completionState: "verified_presence",
        alreadyDone: false,
      }),
      expect.objectContaining({
        unitId: "U10",
        wave: "Wave 2",
        completionState: "not_found",
        alreadyDone: false,
      }),
    ]);
  });

  it("bounds the digest and flags behavioral claims unverified", async () => {
    const result = await extractGroundingEvidence({
      candidateId: "issue-4",
      config: { digestCharLimit: 24 },
      sources: [
        {
          id: "comment",
          kind: "comment",
          label: "comment",
          text: "Already handles retries in the orchestrator.",
        },
      ],
      modelRunner: async () => ({
        digest: "x".repeat(200),
        claims: [
          {
            id: "behavior",
            kind: "behavioral",
            text: "Already handles retries in the orchestrator.",
          },
        ],
      }),
      grounding: groundingInput("verified"),
    });

    expect(result.digest.text).toHaveLength(24);
    expect(result.digest.truncated).toBe(true);
    expect(result.digest.status).toBe("unverified");
    expect(result.claims[0]).toMatchObject({
      id: "behavior",
      status: "unverified",
      citations: [],
    });
  });

  it("does not conclude already-done when only stub/presence is verified", async () => {
    const result = await extractGroundingEvidence({
      candidateId: "issue-5",
      sources: [
        {
          id: "plan",
          kind: "document",
          label: "plan",
          text: "U8 exists only as a stub.",
        },
      ],
      modelRunner: async () => ({
        claims: [
          { id: "claim-stub", kind: "path_symbol", text: "src/stub.ts" },
        ],
        units: [
          {
            unitId: "U8",
            title: "Stub module",
            wave: "Wave 1",
            claimIds: ["claim-stub"],
          },
        ],
      }),
      grounding: groundingInput("verified"),
    });

    expect(result.units[0]).toMatchObject({
      completionState: "verified_presence",
      alreadyDone: false,
    });
    expect(result.units[0]?.rationale).toMatch(/presence is not treated/i);
  });
});

function chatCompletionResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1782940000,
      model: "deepseek/deepseek-v4-pro",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 500, completion_tokens: 80, total_tokens: 580 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function groundingInput(status: CodeGroundingVerificationStatus) {
  return {
    workspaceRoot: "/workspace",
    runId: "run-1",
    config: {
      enabled: true,
      baseDir: ".grounding",
      ttlMs: 1000,
      maxCheckoutsPerRepo: 1,
    },
    target: {
      repoUrl: "file:///repo",
      commitSha: "sha-1",
      repoScope: "symphony" as const,
    },
    runGrounding: async (input: RunCodeGroundingInput) =>
      reportFor(input, () => status),
  };
}

function reportFor(
  input: RunCodeGroundingInput,
  statusFor: (findingId: string) => CodeGroundingVerificationStatus,
): CodeGroundingReport {
  return {
    generatedAt: "2026-07-01T00:00:00.000Z",
    status: "verified",
    checkout: {
      checkoutId: "checkout",
      path: "/checkout",
      commitSha: input.target.commitSha,
      repoUrl: input.target.repoUrl,
    },
    entries: input.findings.map((finding) => {
      const status = statusFor(finding.findingId);
      return {
        findingId: finding.findingId,
        status,
        summary: "summary",
        citations: [],
        missing:
          status === "not_found"
            ? [finding.evidence.match(/`([^`]+)`/)?.[1] ?? finding.summary]
            : [],
      };
    }),
    cleanup: {
      leaseReleased: true,
      checkoutPurged: false,
      dirtyState: null,
    },
    warnings: [],
  };
}
