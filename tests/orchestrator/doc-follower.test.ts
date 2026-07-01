import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearDocFollowerCache,
  followGroundingDocs,
} from "../../src/orchestrator/doc-follower.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doc-follower-"));
  clearDocFollowerCache();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  clearDocFollowerCache();
});

describe("doc follower", () => {
  it("resolves a prose filesystem doc ref and extracts its citations", async () => {
    await writeFile(
      join(root, "plan.md"),
      "# Plan\n\nTouches `src/orchestrator/doc-follower.ts`.",
    );

    const result = await followGroundingDocs({
      checkoutRoot: root,
      candidateId: "issue-1",
      candidateIdentifier: "SYMPH-1",
      rootSources: [{ id: "body", text: "See `plan.md`." }],
    });

    expect(result.followedDocs.map((doc) => doc.reference)).toEqual([
      "plan.md",
    ]);
    expect(result.claims[0]?.evidence).toContain(
      "`src/orchestrator/doc-follower.ts`",
    );
  });

  it("follows attached-but-unreferenced Linear docs read-only", async () => {
    const result = await followGroundingDocs({
      checkoutRoot: root,
      candidateId: "issue-2",
      rootSources: [],
      attachedDocuments: [
        {
          title: "Attached plan",
          url: "https://linear.app/acme/document/legacy-plan",
          documentId: "legacy-plan",
        },
      ],
      readLinearDocument: async (documentId) =>
        documentId === "legacy-plan" ? "Use `src/foo.ts`." : null,
    });

    expect(result.followedDocs).toMatchObject([
      { kind: "linear", reference: "legacy-plan" },
    ]);
    expect(result.claims[0]?.evidence).toContain("`src/foo.ts`");
  });

  it("resolves legacy Linear document URLs from prose", async () => {
    const result = await followGroundingDocs({
      checkoutRoot: root,
      candidateId: "issue-3",
      rootSources: [
        {
          id: "body",
          text: "Legacy doc https://linear.app/acme/document/old-plan.",
        },
      ],
      readLinearDocument: async (documentId) =>
        documentId === "old-plan" ? "Mentions `src/old.ts`." : null,
    });

    expect(result.followedDocs[0]).toMatchObject({
      kind: "linear",
      reference: "old-plan",
    });
    expect(result.claims[0]?.evidence).toContain("`src/old.ts`");
  });

  it("follows transitive refs within the depth cap and terminates cycles", async () => {
    await writeFile(join(root, "a.md"), "See `b.md` and `src/a.ts`.");
    await writeFile(join(root, "b.md"), "See `a.md` and `src/b.ts`.");

    const result = await followGroundingDocs({
      checkoutRoot: root,
      candidateId: "issue-4",
      rootSources: [{ id: "body", text: "Read `a.md`." }],
      maxDepth: 2,
    });

    expect(result.followedDocs.map((doc) => doc.reference).sort()).toEqual([
      "a.md",
      "b.md",
    ]);
    expect(result.claims[0]?.evidence).toContain("`src/a.ts`");
    expect(result.claims[0]?.evidence).toContain("`src/b.ts`");
  });

  it("enforces depth and breadth bounds", async () => {
    await writeFile(join(root, "a.md"), "See `b.md` and `c.md`. `src/a.ts`.");
    await writeFile(join(root, "b.md"), "See `d.md`. `src/b.ts`.");
    await writeFile(join(root, "c.md"), "`src/c.ts`.");
    await writeFile(join(root, "d.md"), "`src/d.ts`.");

    const depthLimited = await followGroundingDocs({
      checkoutRoot: root,
      candidateId: "issue-5",
      rootSources: [{ id: "body", text: "Read `a.md`." }],
      maxDepth: 1,
      maxDocuments: 10,
    });
    expect(depthLimited.followedDocs.map((doc) => doc.reference)).toEqual([
      "a.md",
    ]);

    const breadthLimited = await followGroundingDocs({
      checkoutRoot: root,
      candidateId: "issue-5",
      rootSources: [{ id: "body", text: "Read `a.md`." }],
      maxDepth: 3,
      maxDocuments: 2,
    });
    expect(breadthLimited.followedDocs).toHaveLength(2);
  });

  it("rejects filesystem path escapes", async () => {
    const result = await followGroundingDocs({
      checkoutRoot: root,
      candidateId: "issue-6",
      rootSources: [{ id: "body", text: "Read `../outside.md`." }],
    });

    expect(result.followedDocs).toEqual([]);
    expect(result.rejectedRefs).toEqual(["../outside.md"]);
    expect(result.warnings[0]).toMatch(/outside checkout root/i);
  });

  it("reuses extraction cached by doc-content hash", async () => {
    await writeFile(join(root, "a.md"), "`src/a.ts`.");
    await writeFile(join(root, "b.md"), "`src/a.ts`.");

    const result = await followGroundingDocs({
      checkoutRoot: root,
      candidateId: "issue-7",
      rootSources: [{ id: "body", text: "Read `a.md` and `b.md`." }],
    });

    expect(result.followedDocs).toHaveLength(2);
    expect(result.cacheHits).toBe(1);
  });

  it("keeps per-document evidence labels when content-hash cache hits", async () => {
    await writeFile(join(root, "a.md"), "`src/shared.ts`.");
    await writeFile(join(root, "b.md"), "`src/shared.ts`.");

    const result = await followGroundingDocs({
      checkoutRoot: root,
      candidateId: "issue-8",
      rootSources: [{ id: "body", text: "Read `a.md` and `b.md`." }],
    });

    expect(result.cacheHits).toBe(1);
    expect(result.claims[0]?.evidence).toContain("[filesystem doc a.md]");
    expect(result.claims[0]?.evidence).toContain("[filesystem doc b.md]");
  });

  it("recomputes queued ref depth when a content-hash cache hit occurs at a new depth", async () => {
    await writeFile(join(root, "parent.md"), "Read `b.md`.");
    await writeFile(join(root, "b.md"), "See `child.md`.");
    await writeFile(join(root, "a.md"), "See `child.md`.");
    await writeFile(join(root, "child.md"), "`src/child.ts`.");

    const deeperFirst = await followGroundingDocs({
      checkoutRoot: root,
      candidateId: "issue-9",
      rootSources: [{ id: "body", text: "Read `parent.md`." }],
      maxDepth: 2,
    });
    expect(deeperFirst.followedDocs.map((doc) => doc.reference)).toEqual([
      "parent.md",
      "b.md",
    ]);

    const shallowerCacheHit = await followGroundingDocs({
      checkoutRoot: root,
      candidateId: "issue-9",
      rootSources: [{ id: "body", text: "Read `a.md`." }],
      maxDepth: 2,
    });
    expect(shallowerCacheHit.cacheHits).toBe(1);
    expect(shallowerCacheHit.followedDocs.map((doc) => doc.reference)).toEqual([
      "a.md",
      "child.md",
    ]);
    expect(shallowerCacheHit.claims[0]?.evidence).toContain("`src/child.ts`");
  });

  it("records read failures as rejected refs and keeps following other docs", async () => {
    await writeFile(join(root, "bad.md"), "unreadable");
    await writeFile(join(root, "good.md"), "`src/good.ts`.");

    const result = await followGroundingDocs({
      checkoutRoot: root,
      candidateId: "issue-10",
      rootSources: [{ id: "body", text: "Read `bad.md` and `good.md`." }],
      readFile: async (absolutePath) => {
        if (absolutePath.endsWith("bad.md")) {
          throw new Error("denied");
        }
        return "`src/good.ts`.";
      },
    });

    expect(result.followedDocs.map((doc) => doc.reference)).toEqual([
      "good.md",
    ]);
    expect(result.rejectedRefs).toEqual(["bad.md"]);
    expect(result.warnings[0]).toMatch(/not readable/i);
    expect(result.claims[0]?.evidence).toContain("`src/good.ts`");
  });
});
