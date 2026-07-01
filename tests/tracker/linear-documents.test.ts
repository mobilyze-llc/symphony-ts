import { describe, expect, it } from "vitest";

import {
  createLinearDocument,
  fetchLinearDocumentComments,
  fetchLinearDocumentContent,
  updateLinearDocument,
} from "../../src/tracker/linear-documents.js";

function fakeFetch(payload: unknown, capture?: (body: unknown) => void) {
  return async (_url: string, init?: { body?: string }) => {
    if (capture && init?.body) {
      capture(JSON.parse(init.body));
    }
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  };
}

const DEPS = (fetchFn: ReturnType<typeof fakeFetch>) => ({
  endpoint: "https://api.linear.app/graphql",
  apiKey: "lin_test",
  fetchFn,
});

describe("linear documents client", () => {
  it("createLinearDocument sends title/content/teamId and returns id/slug/url", async () => {
    let sent: unknown;
    const fetchFn = fakeFetch(
      {
        data: {
          documentCreate: {
            success: true,
            document: { id: "doc-1", slugId: "abc123", url: "https://x/doc" },
          },
        },
      },
      (b) => {
        sent = b;
      },
    );
    const result = await createLinearDocument(DEPS(fetchFn), {
      teamId: "team-1",
      title: "🚦Ticket Triage Controls",
      content: "# body",
    });
    expect(result).toEqual({
      id: "doc-1",
      slugId: "abc123",
      url: "https://x/doc",
    });
    expect(JSON.stringify(sent)).toContain("documentCreate");
    expect(JSON.stringify(sent)).toContain("team-1");
  });

  it("updateLinearDocument sends documentId + content", async () => {
    let sent: unknown;
    const fetchFn = fakeFetch(
      {
        data: { documentUpdate: { success: true, document: { id: "doc-1" } } },
      },
      (b) => {
        sent = b;
      },
    );
    const result = await updateLinearDocument(DEPS(fetchFn), {
      documentId: "doc-1",
      content: "# updated",
    });
    expect(result).toEqual({ id: "doc-1" });
    expect(JSON.stringify(sent)).toContain("doc-1");
    expect(JSON.stringify(sent)).toContain("# updated");
  });

  it("fetchLinearDocumentComments normalizes nodes (body, quotedText, author email)", async () => {
    const fetchFn = fakeFetch({
      data: {
        document: {
          comments: {
            nodes: [
              {
                id: "c1",
                body: "[opt-1] go",
                quotedText: "[opt-1] Release b-aaa",
                createdAt: "2026-06-18T00:10:00.000Z",
                user: { email: "Eric@Litman.org" },
                botActor: null,
              },
              {
                id: "c2",
                body: "auto",
                quotedText: null,
                createdAt: "2026-06-18T00:11:00.000Z",
                user: null,
                botActor: { id: "bot-1" },
              },
            ],
          },
        },
      },
    });
    const comments = await fetchLinearDocumentComments(DEPS(fetchFn), {
      documentId: "doc-1",
    });
    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({
      id: "c1",
      body: "[opt-1] go",
      quotedText: "[opt-1] Release b-aaa",
      authorEmail: "eric@litman.org", // normalized lowercase
    });
    expect(comments[1]).toMatchObject({
      id: "c2",
      quotedText: null,
      authorEmail: null,
    });
  });

  it("fetchLinearDocumentContent reads markdown content without mutation", async () => {
    let sent: unknown;
    const fetchFn = fakeFetch(
      {
        data: {
          document: {
            id: "doc-1",
            slugId: "plan-doc",
            url: "https://linear.app/acme/document/plan-doc",
            content: "# Plan\n\nSee `src/foo.ts`.",
          },
        },
      },
      (b) => {
        sent = b;
      },
    );

    const document = await fetchLinearDocumentContent(DEPS(fetchFn), {
      documentId: "doc-1",
    });

    expect(document).toEqual({
      id: "doc-1",
      slugId: "plan-doc",
      url: "https://linear.app/acme/document/plan-doc",
      content: "# Plan\n\nSee `src/foo.ts`.",
    });
    expect(JSON.stringify(sent)).toContain("document(id: $id)");
    expect(JSON.stringify(sent)).not.toContain("documentUpdate");
  });

  it("fetchLinearDocumentContent returns null when the document is absent", async () => {
    const fetchFn = fakeFetch({ data: { document: null } });
    await expect(
      fetchLinearDocumentContent(DEPS(fetchFn), { documentId: "missing" }),
    ).resolves.toBeNull();
  });

  it("throws on a GraphQL error payload", async () => {
    const fetchFn = fakeFetch({ errors: [{ message: "boom" }] });
    await expect(
      fetchLinearDocumentComments(DEPS(fetchFn), { documentId: "doc-1" }),
    ).rejects.toThrow();
  });
});
