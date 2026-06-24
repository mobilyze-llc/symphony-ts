import { describe, expect, it } from "vitest";

import {
  decideJudgeDecorrelation,
  normalizeJudgeFamily,
} from "../../../src/review/spine/judge-decorrelation.js";

describe("normalizeJudgeFamily (SYMPH-925)", () => {
  it("keys raw model/agent specs to Symphony's finder-layer family vocabulary", () => {
    expect(normalizeJudgeFamily("codex")).toBe("openai-codex");
    expect(normalizeJudgeFamily("openai/gpt-5-codex")).toBe("openai-codex");
    expect(normalizeJudgeFamily("anthropic/opus")).toBe("anthropic");
    expect(normalizeJudgeFamily("claude-opus-4-8")).toBe("anthropic");
    expect(normalizeJudgeFamily("opus")).toBe("anthropic");
    expect(normalizeJudgeFamily("deepseek/deepseek-v4-pro")).toBe("pi");
    expect(normalizeJudgeFamily("pi")).toBe("pi");
    expect(normalizeJudgeFamily("kimi-k27")).toBe("moonshot-kimi");
  });

  it("passes already-normalized Symphony families through unchanged", () => {
    expect(normalizeJudgeFamily("openai-codex")).toBe("openai-codex");
    expect(normalizeJudgeFamily("anthropic")).toBe("anthropic");
    expect(normalizeJudgeFamily("pi")).toBe("pi");
    expect(normalizeJudgeFamily("moonshot-kimi")).toBe("moonshot-kimi");
  });

  it("returns null only for empty/blank specs (fail-closed signal)", () => {
    expect(normalizeJudgeFamily(null)).toBeNull();
    expect(normalizeJudgeFamily(undefined)).toBeNull();
    expect(normalizeJudgeFamily("")).toBeNull();
    expect(normalizeJudgeFamily("   ")).toBeNull();
  });

  it("keeps an unrecognized-but-present family comparable (provider segment / token)", () => {
    // Not null — an opaque family is still a usable identity for same-vs-different
    // (mirrors crucible's `${provider}:${model}` terminal), so it can be excluded.
    expect(normalizeJudgeFamily("mistral/large")).toBe("mistral");
    expect(normalizeJudgeFamily("qwen3")).toBe("qwen3");
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
});
