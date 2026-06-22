import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { expect, it } from "vitest";

// ops/fence-sync is an interim bash stopgap (SYMPH-891). It mirrors the OPEN
// issues of a Linear Release into the orchestrator dispatch fence. These are
// structural-invariant assertions over the script source (same approach as
// deploy-train.test.ts), since the script's runtime hits live Linear + the
// running control plane and is not unit-mockable.

const SCRIPT_PATH = resolve("ops/fence-sync");
const SCRIPT = readFileSync(SCRIPT_PATH, "utf8");

it("is an executable bash script", () => {
  expect(SCRIPT.startsWith("#!/usr/bin/env bash")).toBe(true);
  expect(SCRIPT).toContain("set -euo pipefail");
  // chmod +x — the launchd job execs it directly
  expect(statSync(SCRIPT_PATH).mode & 0o111).not.toBe(0);
});

it("only fences OPEN issues — excludes completed and canceled", () => {
  expect(SCRIPT).toContain('.state.type != "completed"');
  expect(SCRIPT).toContain('.state.type != "canceled"');
});

it("refuses to set an empty fence when the release is drained (would block all dispatch)", () => {
  expect(SCRIPT).toMatch(/\$\{#OPEN_IDS\[@\]\}"?\s*-eq\s*0/);
  expect(SCRIPT).toContain("DRAINED");
  // the drained branch must exit BEFORE the symphonyctl fence call
  const drainedIdx = SCRIPT.indexOf("DRAINED");
  const fenceIdx = SCRIPT.indexOf('"$SYMPHONYCTL_JS" fence');
  expect(drainedIdx).toBeGreaterThan(-1);
  expect(fenceIdx).toBeGreaterThan(drainedIdx);
});

it("dies on a fetch/parse failure instead of misreporting a drained release", () => {
  expect(SCRIPT).toContain("jq -e -c '.data.release.issues.nodes'");
  expect(SCRIPT).toContain("could not parse release issues");
});

it("refuses to apply a partial fence when the release exceeds one page (>250)", () => {
  expect(SCRIPT).toContain("hasNextPage");
  expect(SCRIPT).toContain("does not paginate");
});

it("applies the fence via symphonyctl (not a new dispatch-control surface)", () => {
  expect(SCRIPT).toContain('"$SYMPHONYCTL_JS" fence');
  expect(SCRIPT).toContain("symphonyctl.js");
});

it("requires LINEAR_API_KEY and sources .env rather than baking a secret", () => {
  expect(SCRIPT).toContain('[[ -n "${LINEAR_API_KEY:-}" ]]');
  expect(SCRIPT).toMatch(/\.\s+"\$ENV_FILE"/);
});

it("defaults to the R1 release and supports override + dry-run", () => {
  expect(SCRIPT).toContain(
    'FENCE_RELEASE_ID="${FENCE_RELEASE_ID:-82b930d0-ada7-4c1f-b328-56ef8cb785a8}"',
  );
  expect(SCRIPT).toContain("FENCE_DRY_RUN");
});

it("is marked as a throwaway tied to SYMPH-891 so it is findable for deletion", () => {
  expect(SCRIPT).toContain("SYMPH-891");
  expect(SCRIPT.toLowerCase()).toContain("stopgap");
});
