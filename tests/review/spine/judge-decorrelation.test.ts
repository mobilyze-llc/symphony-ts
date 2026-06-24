import { describe, expect, it } from "vitest";

import {
  decideJudgeDecorrelation,
  normalizeJudgeFamily,
} from "../../../src/review/spine/judge-decorrelation.js";

describe("normalizeJudgeFamily (SYMPH-925)", () => {
  it("keys raw model/agent specs to Symphony's finder-layer family vocabulary", () => {
    expect(normalizeJudgeFamily("codex")).toBe("openai-codex");
    expect(normalizeJudgeFamily("openai/gpt-5-codex")).toBe("openai-codex");
    expect(normalizeJudgeFamily("gpt-4")).toBe("openai-codex");
    expect(normalizeJudgeFamily("anthropic/opus")).toBe("anthropic");
    expect(normalizeJudgeFamily("claude-opus-4-8")).toBe("anthropic");
    expect(normalizeJudgeFamily("claude-opus-4")).toBe("anthropic");
    expect(normalizeJudgeFamily("opus")).toBe("anthropic");
    expect(normalizeJudgeFamily("deepseek/deepseek-v4-pro")).toBe("pi");
    expect(normalizeJudgeFamily("deepseek-v4-pro")).toBe("pi");
    expect(normalizeJudgeFamily("pi")).toBe("pi");
    expect(normalizeJudgeFamily("kimi-k27")).toBe("moonshot-kimi");
    expect(normalizeJudgeFamily("kimi-k2")).toBe("moonshot-kimi");
  });

  it("passes already-normalized Symphony families through unchanged", () => {
    expect(normalizeJudgeFamily("openai-codex")).toBe("openai-codex");
    expect(normalizeJudgeFamily("anthropic")).toBe("anthropic");
    expect(normalizeJudgeFamily("pi")).toBe("pi");
    expect(normalizeJudgeFamily("moonshot-kimi")).toBe("moonshot-kimi");
  });

  it("is robust to surrounding whitespace and case", () => {
    expect(normalizeJudgeFamily(" Openai-Codex ")).toBe("openai-codex");
    expect(normalizeJudgeFamily("  CLAUDE-OPUS-4  ")).toBe("anthropic");
  });

  it("returns null for empty/blank specs (fail-closed signal)", () => {
    expect(normalizeJudgeFamily(null)).toBeNull();
    expect(normalizeJudgeFamily(undefined)).toBeNull();
    expect(normalizeJudgeFamily("")).toBeNull();
    expect(normalizeJudgeFamily("   ")).toBeNull();
  });

  it("returns null for AMBIGUOUS multi-family specs (fail-closed on ambiguity)", () => {
    // SYMPH-925 council P2: a spec matching tokens from MORE THAN ONE recognized
    // family cannot prove a single family → null, NOT the first matcher to fire.
    // Order-dependent first-match would let a substring hijack the family
    // (e.g. "moonshot-codex" → "openai-codex") and mis-read same-provider specs.
    expect(normalizeJudgeFamily("moonshot-codex")).toBeNull();
    expect(normalizeJudgeFamily("deepseek-openai")).toBeNull();
    expect(normalizeJudgeFamily("claude-codex")).toBeNull();
    expect(normalizeJudgeFamily("gpt-kimi")).toBeNull();
  });

  it("returns null for any spec it cannot map to a RECOGNIZED Symphony family (fail-closed)", () => {
    // SYMPH-925 council P2: an unrecognized spec is NOT trusted as a distinct
    // identity. It must be null so decideJudgeDecorrelation fails closed, never
    // read same-provider specs (mistral/large vs mistral/small) as different.
    expect(normalizeJudgeFamily("mistral/large")).toBeNull();
    expect(normalizeJudgeFamily("mistral-large")).toBeNull();
    expect(normalizeJudgeFamily("mistral/small")).toBeNull();
    expect(normalizeJudgeFamily("qwen3")).toBeNull();
  });

  it("returns null for any spec it cannot map to a RECOGNIZED Symphony family (fail-closed)", () => {
    // SYMPH-925 council P2: an unrecognized spec is NOT trusted as a distinct
    // identity. It must be null so decideJudgeDecorrelation fails closed, never
    // read same-provider specs (mistral/large vs mistral/small) as different.
    expect(normalizeJudgeFamily("mistral/large")).toBeNull();
    expect(normalizeJudgeFamily("mistral-large")).toBeNull();
    expect(normalizeJudgeFamily("mistral/small")).toBeNull();
    expect(normalizeJudgeFamily("qwen3")).toBeNull();
  });
});

describe("decideJudgeDecorrelation (SYMPH-925)", () => {
  it("is satisfied when the judge family differs from the keyed author family", () => {
    const decision = decideJudgeDecorrelation({
      authorFamily: "openai-codex",
      judgeFamily: "anthropic/opus",
    });
    expect(decision.satisfied).toBe(true);
    expect(decision.reason).toBeNull();
    expect(decision.authorFamily).toBe("openai-codex");
    expect(decision.judgeFamily).toBe("anthropic");
  });

  it("fails closed when the author/executor family is unkeyable", () => {
    const decision = decideJudgeDecorrelation({
      authorFamily: null,
      judgeFamily: "anthropic/opus",
    });
    expect(decision.satisfied).toBe(false);
    expect(decision.reason).toBe("judge_author_family_missing");
  });

  it("fails closed when the judge's own family is unkeyable", () => {
    const decision = decideJudgeDecorrelation({
      authorFamily: "openai-codex",
      judgeFamily: "",
    });
    expect(decision.satisfied).toBe(false);
    expect(decision.reason).toBe("judge_family_missing");
  });

  it("fails closed when the judge IS the author/executor family (conflict of interest)", () => {
    const decision = decideJudgeDecorrelation({
      authorFamily: "openai-codex",
      // A bare codex judge keyed to the same family the author was keyed to.
      judgeFamily: "codex",
    });
    expect(decision.satisfied).toBe(false);
    expect(decision.reason).toBe("judge_same_family_as_author");
    expect(decision.authorFamily).toBe("openai-codex");
    expect(decision.judgeFamily).toBe("openai-codex");
  });

  it("normalizes both sides before comparing, so cross-spelling same-family is still refused", () => {
    // Author keyed as the canonical family; judge a raw anthropic wire-id. Different
    // here (codex vs anthropic) → satisfied; but flip the judge to a codex wire-id
    // and it must collapse to the same family and fail closed.
    expect(
      decideJudgeDecorrelation({
        authorFamily: "anthropic",
        judgeFamily: "openai/gpt-5-codex",
      }).satisfied,
    ).toBe(true);
    expect(
      decideJudgeDecorrelation({
        authorFamily: "anthropic",
        judgeFamily: "claude-opus-4-8",
      }).reason,
    ).toBe("judge_same_family_as_author");
  });

  it("fails closed when the author family is UNRECOGNIZED (not a recognized Symphony family)", () => {
    const decision = decideJudgeDecorrelation({
      authorFamily: "mistral-large",
      judgeFamily: "anthropic",
    });
    expect(decision.satisfied).toBe(false);
    expect(decision.reason).toBe("judge_author_family_missing");
    expect(decision.authorFamily).toBeNull();
  });

  it("fails closed when the judge family is UNRECOGNIZED (not a recognized Symphony family)", () => {
    const decision = decideJudgeDecorrelation({
      authorFamily: "anthropic",
      judgeFamily: "mistral/small",
    });
    expect(decision.satisfied).toBe(false);
    expect(decision.reason).toBe("judge_family_missing");
    expect(decision.judgeFamily).toBeNull();
  });

  it("fails closed on the council's same-provider fail-open case (mistral-large vs mistral/small)", () => {
    // The exact P2 the reviewer flagged: under the old fail-open fallback these
    // keyed to "mistral-large" vs "mistral", differed, and the same-provider judge
    // RAN. Now both are unrecognized → null → fail closed, never satisfied:true.
    const decision = decideJudgeDecorrelation({
      authorFamily: "mistral-large",
      judgeFamily: "mistral/small",
    });
    expect(decision.satisfied).toBe(false);
    // Author is resolved first, so the unkeyable author short-circuits the reason.
    expect(decision.reason).toBe("judge_author_family_missing");
  });

  it("fails closed when the author spec is AMBIGUOUS (matches >1 recognized family)", () => {
    const decision = decideJudgeDecorrelation({
      // Matches both codex→openai and moonshot→moonshot-kimi → ambiguous → null.
      authorFamily: "moonshot-codex",
      judgeFamily: "anthropic",
    });
    expect(decision.satisfied).toBe(false);
    expect(decision.reason).toBe("judge_author_family_missing");
    expect(decision.authorFamily).toBeNull();
  });

  it("fails closed when the judge spec is AMBIGUOUS (matches >1 recognized family)", () => {
    const decision = decideJudgeDecorrelation({
      authorFamily: "anthropic",
      // Matches both claude→anthropic and codex→openai → ambiguous → null.
      judgeFamily: "claude-codex",
    });
    expect(decision.satisfied).toBe(false);
    expect(decision.reason).toBe("judge_family_missing");
    expect(decision.judgeFamily).toBeNull();
  });
});
