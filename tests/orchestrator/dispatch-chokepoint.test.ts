import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const CORE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/orchestrator/core.ts",
);

/**
 * SYMPH-825 — structural proof that EVERY dispatch flows through the single
 * admission chokepoint (admitAndDispatch). The no-ambient-control-surfaces gate
 * (SYMPH-794) was bypassed twice by new dispatch entry points that forgot to gate
 * (council findings A + B, both P1 a green test suite missed). Routing all
 * dispatch through one chokepoint — the SOLE caller of the worker-spawning
 * dispatchIssue — converts "remember to gate every new path" into
 * "can't-not-gate": a new caller physically cannot reach dispatchIssue without
 * passing the gate. These source-structure assertions fail the moment a future
 * edit reintroduces the bypass footgun.
 */
describe("dispatch admission chokepoint (SYMPH-825)", () => {
  const source = readFileSync(CORE_PATH, "utf8");

  it("calls the worker-spawning dispatchIssue from exactly ONE place", () => {
    // More than one call site means a dispatch path that skipped the gate — the
    // exact bug class the council found twice.
    const calls = [...source.matchAll(/this\.dispatchIssue\(/g)];
    expect(calls.length).toBe(1);
  });

  it("makes admitAndDispatch the SOLE caller of dispatchIssue", () => {
    const body = methodBody(source, "private async admitAndDispatch(");
    expect(body).not.toBeNull();
    expect(body).toContain("this.dispatchIssue(");
  });

  it("enforces the admitted set inside the chokepoint before dispatching", () => {
    const body = methodBody(source, "private async admitAndDispatch(");
    expect(body).not.toBeNull();
    // The gate: a non-null admitted set lacking the issue must NOT dispatch.
    expect(body).toMatch(/admitted !== null/);
    expect(body).toMatch(/\.has\(issue\.identifier\)/);
  });

  it("routes both existing dispatch sites (pollTick, onRetryTimer) through the chokepoint", () => {
    const calls = [...source.matchAll(/this\.admitAndDispatch\(/g)];
    expect(calls.length).toBe(2);
  });
});

/** The body of a class method, from its declaration to the next method. */
function methodBody(source: string, decl: string): string | null {
  const start = source.indexOf(decl);
  if (start === -1) {
    return null;
  }
  const rest = source.slice(start + decl.length);
  const next = rest.search(/\n {2}(?:private|public|protected)\b/);
  return next === -1 ? rest : rest.slice(0, next);
}
