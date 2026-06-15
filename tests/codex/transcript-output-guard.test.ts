import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const FIXTURE_PATH = "tests/fixtures/codex/transcript-bounded-output.jsonl";
const TOOL_OUTPUT_THRESHOLD_BYTES = 256;
const TOOL_OUTPUT_KEYS = new Set(["output", "stdout", "stderr", "text"]);

describe("Codex transcript output guard fixtures", () => {
  it("keeps preserved transcript fixture tool outputs below the configured threshold", async () => {
    const entries = await readJsonlFixture(FIXTURE_PATH);

    expect(() =>
      assertNoOversizedToolOutput(entries, TOOL_OUTPUT_THRESHOLD_BYTES),
    ).not.toThrow();
  });

  it("fails if a direct oversized tool output is injected into the transcript", async () => {
    const entries = await readJsonlFixture(FIXTURE_PATH);
    const mutated = structuredClone(entries);
    mutated.push({
      type: "response_item",
      payload: {
        type: "tool_call_output",
        tool_name: "exec_command",
        output: "x".repeat(TOOL_OUTPUT_THRESHOLD_BYTES + 1),
      },
    });

    expect(() =>
      assertNoOversizedToolOutput(mutated, TOOL_OUTPUT_THRESHOLD_BYTES),
    ).toThrow(/oversized tool output/);
  });
});

async function readJsonlFixture(path: string): Promise<unknown[]> {
  const contents = await readFile(path, "utf8");
  return contents
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function assertNoOversizedToolOutput(
  entries: readonly unknown[],
  maxBytes: number,
): void {
  for (const [entryIndex, entry] of entries.entries()) {
    for (const finding of collectToolOutputFields(entry)) {
      const bytes = Buffer.byteLength(finding.value, "utf8");
      if (bytes > maxBytes) {
        throw new Error(
          `oversized tool output at entry ${entryIndex} field ${finding.path}: ${bytes} bytes > ${maxBytes}`,
        );
      }
    }
  }
}

function collectToolOutputFields(
  value: unknown,
  path = "$",
): Array<{ path: string; value: string }> {
  if (value === null || typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectToolOutputFields(item, `${path}[${index}]`),
    );
  }

  const record = value as Record<string, unknown>;
  const isToolOutputEnvelope =
    record.type === "tool_call_output" ||
    typeof record.tool_name === "string" ||
    typeof record.toolName === "string";
  const findings: Array<{ path: string; value: string }> = [];
  for (const [key, child] of Object.entries(record)) {
    const childPath = `${path}.${key}`;
    if (
      isToolOutputEnvelope &&
      TOOL_OUTPUT_KEYS.has(key) &&
      typeof child === "string"
    ) {
      findings.push({ path: childPath, value: child });
    }
    findings.push(...collectToolOutputFields(child, childPath));
  }

  return findings;
}
