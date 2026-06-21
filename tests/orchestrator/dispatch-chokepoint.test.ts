import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as ts from "typescript";
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
 * passing the gate.
 *
 * SYMPH-831 — this proof is now AST/type-checker-resolved, not regex/source-grep.
 * We resolve the `dispatchIssue` SYMBOL in core.ts and inspect every reference to
 * it by symbol identity, so the guarantee holds regardless of call spelling: a
 * `.bind(this)`, bracket access (`this["dispatchIssue"]`), alias, or any future
 * call form resolves to the same symbol and is caught — the regex heuristic could
 * only forbid the spellings it enumerated.
 */

// Single-file program. `noResolve` avoids pulling core.ts's whole import graph
// (fast + hermetic); intra-file `this.dispatchIssue` still resolves because the
// class and method are declared in this file, which is all the chokepoint proof
// needs. Unresolved imports degrade to `any` and are harmless here.
const program = ts.createProgram([CORE_PATH], {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  noResolve: true,
  skipLibCheck: true,
  skipDefaultLibCheck: true,
  noEmit: true,
});
const loadedSource = program.getSourceFile(CORE_PATH);
if (loadedSource === undefined) {
  throw new Error(`dispatch-chokepoint: could not load ${CORE_PATH}`);
}
// Bind to a definitely-typed const so the nested `visit` closures narrow.
const sourceFile: ts.SourceFile = loadedSource;
const checker = program.getTypeChecker();

/** Every `MethodDeclaration` in core.ts whose (identifier) name is `name`. */
function methodDeclarations(name: string): ts.MethodDeclaration[] {
  const found: ts.MethodDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isMethodDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** The name of the nearest enclosing method declaration, or null. */
function enclosingMethodName(node: ts.Node): string | null {
  for (
    let current: ts.Node | undefined = node.parent;
    current !== undefined;
    current = current.parent
  ) {
    if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) {
      return current.name.text;
    }
  }
  return null;
}

/**
 * Every reference to `target`'s symbol EXCLUDING its own declaration name —
 * matched by symbol identity (declarations include `target`), not by spelling.
 * Walks `Identifier` and string-literal nodes (the latter covers bracket access
 * `this["dispatchIssue"]`); the name pre-filter just avoids resolving every
 * identifier in a 15k-line file.
 */
function symbolReferences(target: ts.MethodDeclaration): ts.Node[] {
  if (!ts.isIdentifier(target.name)) {
    throw new Error("dispatch-chokepoint: expected an identifier method name");
  }
  const name = target.name.text;
  const targetSymbol = checker.getSymbolAtLocation(target.name);
  if (targetSymbol === undefined) {
    throw new Error(`dispatch-chokepoint: symbol for ${name} did not resolve`);
  }
  const refs: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (
      node !== target.name &&
      (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
      node.text === name
    ) {
      const symbol = checker.getSymbolAtLocation(node);
      if ((symbol?.getDeclarations() ?? []).includes(target)) {
        refs.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return refs;
}

/** The member-access expression wrapping a reference, or the node itself. */
function accessExpression(refNode: ts.Node): ts.Node {
  const parent = refNode.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === refNode) {
    return parent; // `this.dispatchIssue` (refNode is `.name`)
  }
  if (
    ts.isElementAccessExpression(parent) &&
    parent.argumentExpression === refNode
  ) {
    return parent; // `this["dispatchIssue"]` (refNode is the literal)
  }
  return refNode;
}

/** Whether a reference is the callee of a call expression (an actual call). */
function isCallTarget(refNode: ts.Node): boolean {
  const access = accessExpression(refNode);
  return (
    ts.isCallExpression(access.parent) && access.parent.expression === access
  );
}

describe("dispatch admission chokepoint (SYMPH-825) — AST-resolved (SYMPH-831)", () => {
  const dispatchDecls = methodDeclarations("dispatchIssue");
  const admitDecls = methodDeclarations("admitAndDispatch");

  it("declares the worker-spawning dispatchIssue (and admitAndDispatch) exactly once", () => {
    expect(dispatchDecls.length).toBe(1);
    expect(admitDecls.length).toBe(1);
  });

  it("reaches dispatchIssue from exactly ONE call site, inside admitAndDispatch", () => {
    const decl = dispatchDecls[0];
    expect(decl).toBeDefined();
    if (decl === undefined) {
      return;
    }
    // Exactly one reference to the symbol besides its declaration. More than one
    // means a dispatch path that may skip the gate — the bug class the council
    // found twice. (subsumes the old `count === 1` regex.)
    const refs = symbolReferences(decl);
    expect(refs.length).toBe(1);
    const ref = refs[0];
    expect(ref).toBeDefined();
    if (ref === undefined) {
      return;
    }
    // It is an actual CALL — a `.bind`/alias/capture resolves to the same symbol
    // but is not a call target, so it would fail here (subsumes the old
    // `.bind(`/bracket-access regex forbids).
    expect(isCallTarget(ref)).toBe(true);
    // …and it lives inside admitAndDispatch. A new caller anywhere else, by ANY
    // spelling, adds a reference outside admitAndDispatch and fails this test.
    expect(enclosingMethodName(ref)).toBe("admitAndDispatch");
  });

  it("routes both existing dispatch sites (pollTick, onRetryTimer) through admitAndDispatch", () => {
    const decl = admitDecls[0];
    expect(decl).toBeDefined();
    if (decl === undefined) {
      return;
    }
    const callRefs = symbolReferences(decl).filter(isCallTarget);
    expect(callRefs.length).toBe(2);
    // The chokepoint never calls itself — both callers are upstream methods.
    for (const ref of callRefs) {
      expect(enclosingMethodName(ref)).not.toBe("admitAndDispatch");
    }
  });

  it("enforces the admitted set inside the chokepoint before dispatching", () => {
    const decl = admitDecls[0];
    expect(decl).toBeDefined();
    if (decl === undefined) {
      return;
    }
    // The gate-content check is scoped to the exact method node (AST), not a
    // regex slice of the file: a non-null admitted set lacking the issue must NOT
    // dispatch.
    const body = decl.getText(sourceFile);
    expect(body).toMatch(/admitted !== null/);
    expect(body).toMatch(/\.has\(issue\.identifier\)/);
  });
});
