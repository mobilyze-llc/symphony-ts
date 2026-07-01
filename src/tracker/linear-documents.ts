// ---------------------------------------------------------------------------
// Linear document + document-comment API (SYMPH-790/791).
//
// A focused, injectable client for the document surface the v2 control doc uses
// — Symphony already speaks Linear GraphQL, but the issue-tracker client does
// not cover documents. The GraphQL shapes mirror Linear's documented
// Document/Comment API; they are verified live at deploy (shadow). `fetchFn` is
// injected so this is unit-testable without the network.
// ---------------------------------------------------------------------------

/** Minimal fetch surface (the real global fetch + test fakes both satisfy it). */
export type LinearDocumentFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export interface LinearDocumentClientDeps {
  endpoint: string;
  apiKey: string;
  fetchFn: LinearDocumentFetch;
  networkTimeoutMs?: number;
}

export interface LinearDocumentRef {
  id: string;
  slugId: string;
  url: string;
}

export interface LinearDocumentComment {
  id: string;
  body: string;
  quotedText: string | null;
  createdAt: string;
  /** Normalized lowercase author email, or null for a bot/unknown author. */
  authorEmail: string | null;
  botActorId: string | null;
}

export interface LinearDocumentContent {
  id: string;
  slugId: string | null;
  url: string | null;
  content: string;
}

const DOCUMENT_CREATE_MUTATION = `mutation SymphonyDocumentCreate($input: DocumentCreateInput!) {
  documentCreate(input: $input) {
    success
    document { id slugId url }
  }
}`;

const DOCUMENT_UPDATE_MUTATION = `mutation SymphonyDocumentUpdate($id: String!, $input: DocumentUpdateInput!) {
  documentUpdate(id: $id, input: $input) {
    success
    document { id }
  }
}`;

const DOCUMENT_COMMENTS_QUERY = `query SymphonyDocumentComments($id: String!, $first: Int!) {
  document(id: $id) {
    id
    comments(first: $first) {
      nodes { id body quotedText createdAt user { email } botActor { id } }
    }
  }
}`;

const DOCUMENT_CONTENT_QUERY = `query SymphonyDocumentContent($id: String!) {
  document(id: $id) {
    id
    slugId
    url
    content
  }
}`;

export async function createLinearDocument(
  deps: LinearDocumentClientDeps,
  input: { teamId: string; title: string; content: string },
): Promise<LinearDocumentRef> {
  const data = await postGraphql<{
    documentCreate: { success: boolean; document: LinearDocumentRef | null };
  }>(deps, DOCUMENT_CREATE_MUTATION, {
    input: { teamId: input.teamId, title: input.title, content: input.content },
  });
  const document = data.documentCreate.document;
  if (!data.documentCreate.success || document === null) {
    throw new Error("Linear documentCreate did not return a document");
  }
  return document;
}

export async function updateLinearDocument(
  deps: LinearDocumentClientDeps,
  input: { documentId: string; content: string; title?: string },
): Promise<{ id: string }> {
  const data = await postGraphql<{
    documentUpdate: { success: boolean; document: { id: string } | null };
  }>(deps, DOCUMENT_UPDATE_MUTATION, {
    id: input.documentId,
    input: {
      content: input.content,
      ...(input.title === undefined ? {} : { title: input.title }),
    },
  });
  const document = data.documentUpdate.document;
  if (!data.documentUpdate.success || document === null) {
    throw new Error("Linear documentUpdate did not return a document");
  }
  return document;
}

export async function fetchLinearDocumentComments(
  deps: LinearDocumentClientDeps,
  input: { documentId: string; first?: number },
): Promise<LinearDocumentComment[]> {
  const data = await postGraphql<{
    document: {
      comments: {
        nodes: Array<{
          id: string;
          body: string;
          quotedText: string | null;
          createdAt: string;
          user: { email: string | null } | null;
          botActor: { id: string } | null;
        }>;
      };
    } | null;
  }>(deps, DOCUMENT_COMMENTS_QUERY, {
    id: input.documentId,
    first: input.first ?? 100,
  });
  const nodes = data.document?.comments.nodes ?? [];
  return nodes.map((node) => ({
    id: node.id,
    body: node.body,
    quotedText: node.quotedText,
    createdAt: node.createdAt,
    authorEmail: node.user?.email?.trim().toLowerCase() ?? null,
    botActorId: node.botActor?.id ?? null,
  }));
}

export async function fetchLinearDocumentContent(
  deps: LinearDocumentClientDeps,
  input: { documentId: string },
): Promise<LinearDocumentContent | null> {
  const data = await postGraphql<{
    document: {
      id: string;
      slugId: string | null;
      url: string | null;
      content: string | null;
    } | null;
  }>(deps, DOCUMENT_CONTENT_QUERY, {
    id: input.documentId,
  });
  if (data.document === null) {
    return null;
  }
  return {
    id: data.document.id,
    slugId: data.document.slugId,
    url: data.document.url,
    content: data.document.content ?? "",
  };
}

async function postGraphql<TData>(
  deps: LinearDocumentClientDeps,
  query: string,
  variables: Record<string, unknown>,
): Promise<TData> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    deps.networkTimeoutMs ?? 30_000,
  );
  let response: Response;
  try {
    response = await deps.fetchFn(deps.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: deps.apiKey,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`Linear document API HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    data?: TData;
    errors?: Array<{ message: string }>;
  };
  if (payload.errors && payload.errors.length > 0) {
    throw new Error(
      `Linear document API errors: ${payload.errors.map((e) => e.message).join("; ")}`,
    );
  }
  if (payload.data === undefined) {
    throw new Error("Linear document API returned no data");
  }
  return payload.data;
}
