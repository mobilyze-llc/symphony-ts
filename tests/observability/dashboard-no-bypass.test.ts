/**
 * SYMPH-408 AC: no mutation path to dispatch/lease/park state exists outside
 * the verb layer. The dashboard server is a transport: every mutation goes
 * through a DashboardServerHost method, and the only orchestrator module it
 * may import is the intent leaf (verb/actor vocabulary + types). This test
 * is the grep-able assertion form of that boundary.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const OBSERVABILITY_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "observability",
);

function observabilitySources(): Array<{ file: string; content: string }> {
  return readdirSync(OBSERVABILITY_DIR)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({
      file,
      content: readFileSync(join(OBSERVABILITY_DIR, file), "utf8"),
    }));
}

describe("dashboard no-bypass boundary (SYMPH-408)", () => {
  it("imports nothing from src/orchestrator except the intent leaf module", () => {
    for (const { file, content } of observabilitySources()) {
      const orchestratorImports = [
        ...content.matchAll(/from\s+"\.\.\/orchestrator\/([^"]+)"/g),
      ].map((match) => match[1]);
      const offending = orchestratorImports.filter(
        (specifier) => specifier !== "intent.js",
      );
      expect
        .soft(
          offending,
          `${file} must not import orchestrator internals (only intent.js is allowed)`,
        )
        .toEqual([]);
    }
  });

  it("never reaches orchestrator state or the write primitives directly", () => {
    // Mutating surfaces live behind host methods; if any of these names
    // appear in the dashboard layer, a bypass mutation path was added.
    const forbidden = [
      "OrchestratorCore",
      ".writeIntent(",
      ".journalPipelineIntent(",
      ".requestStopByIdentifier(",
      "dispatcherRunJournal",
      "issueParkGenerations",
      "resumeRequiredMarks",
      ".getState(",
    ];
    for (const { file, content } of observabilitySources()) {
      for (const name of forbidden) {
        expect
          .soft(
            content.includes(name),
            `${file} must not reference ${name} (mutations go through DashboardServerHost methods)`,
          )
          .toBe(false);
      }
    }
  });

  it("the only host mutation surfaces are the verb-layer-backed methods", () => {
    const serverSource = readFileSync(
      join(OBSERVABILITY_DIR, "dashboard-server.ts"),
      "utf8",
    );
    // Every host call in the request handler must be one of the declared
    // DashboardServerHost methods (all of which route the orchestrator's
    // intent layer or are read-only).
    const hostCalls = [
      ...serverSource.matchAll(/options\.host\.([A-Za-z]+)/g),
    ].map((match) => match[1]);
    const allowed = new Set([
      "getRuntimeSnapshot",
      "getStateDelta",
      "getIssueDetails",
      "requestRefresh",
      "requestIssueStop",
      "subscribeToSnapshots",
      "requestIntent",
      "requestPipelinePause",
      "requestPipelineResume",
      "requestEmergencyStop",
      "requestDispatchFence",
      "requestDispatchFenceClear",
      "getPipelineStatus",
      "requestAnchorFieldEdit",
      "handleLinearWebhookDelivery",
    ]);
    for (const call of hostCalls) {
      expect
        .soft(allowed.has(call ?? ""), `unexpected host surface: ${call}`)
        .toBe(true);
    }
  });
});
