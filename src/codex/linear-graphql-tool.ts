import { type DocumentNode, parse } from "graphql";

import { ERROR_CODES } from "../errors/codes.js";
import { TrackerError } from "../tracker/errors.js";
import {
  LinearTrackerClient,
  type LinearTrackerClientOptions,
} from "../tracker/linear-client.js";
import type { CodexDynamicTool } from "./app-server-client.js";

const LINEAR_GRAPHQL_DESCRIPTION =
  "Execute one GraphQL query or mutation against the configured Linear workspace using Symphony-managed auth.";

type JsonObject = Record<string, unknown>;

export interface LinearGraphqlToolInput {
  query: string;
  variables?: JsonObject;
}

export interface LinearGraphqlToolResult {
  success: boolean;
  response?: {
    status?: number;
    body?: unknown;
  };
  error?: {
    code: string;
    message: string;
    details?: unknown;
    status?: number | null;
  };
}

export interface LinearGraphqlDynamicToolOptions
  extends Pick<
    LinearTrackerClientOptions,
    "endpoint" | "apiKey" | "networkTimeoutMs" | "fetchFn"
  > {}

export const LINEAR_GRAPHQL_TOOL_NAME = "linear_graphql";

export function createLinearGraphqlDynamicTool(
  options: LinearGraphqlDynamicToolOptions,
): CodexDynamicTool {
  const client = new LinearTrackerClient({
    endpoint: options.endpoint,
    apiKey: options.apiKey,
    projectSlug: null,
    activeStates: [],
    ...(options.networkTimeoutMs === undefined
      ? {}
      : { networkTimeoutMs: options.networkTimeoutMs }),
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
  });

  return {
    name: LINEAR_GRAPHQL_TOOL_NAME,
    description: LINEAR_GRAPHQL_DESCRIPTION,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          minLength: 1,
          description: "A single GraphQL query or mutation document.",
        },
        variables: {
          type: "object",
          description: "Optional GraphQL variables object.",
        },
      },
    },
    async execute(input: unknown): Promise<LinearGraphqlToolResult> {
      const normalized = normalizeInput(input);
      if (!normalized.success) {
        return normalized;
      }

      try {
        const response = await client.executeRawGraphql(
          normalized.query,
          normalized.variables,
        );
        const body = response.body;
        const graphqlErrors = extractGraphqlErrors(body);

        if (response.status < 200 || response.status >= 300) {
          return {
            success: false,
            response: {
              status: response.status,
              body,
            },
            error: {
              code: ERROR_CODES.linearApiStatus,
              message: `Linear GraphQL request failed with HTTP ${response.status}.`,
              status: response.status,
            },
          };
        }

        if (graphqlErrors !== null) {
          return {
            success: false,
            response: {
              status: response.status,
              body,
            },
            error: {
              code: ERROR_CODES.linearGraphqlErrors,
              message: "Linear GraphQL returned top-level errors.",
              details: graphqlErrors,
              status: response.status,
            },
          };
        }

        return {
          success: true,
          response: {
            status: response.status,
            body,
          },
        };
      } catch (error) {
        if (error instanceof TrackerError) {
          return {
            success: false,
            error: {
              code: error.code,
              message: error.message,
              details: error.details,
              status: error.status,
            },
          };
        }

        return {
          success: false,
          error: {
            code: ERROR_CODES.linearApiRequest,
            message:
              error instanceof Error
                ? error.message
                : "Linear GraphQL request failed.",
          },
        };
      }
    },
  };
}

function normalizeInput(
  input: unknown,
):
  | (LinearGraphqlToolResult & { success: false })
  | { success: true; query: string; variables: JsonObject } {
  if (typeof input === "string") {
    return validateDocument({
      query: input,
      variables: {},
    });
  }

  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return invalidInput(
      "linear_graphql expects a GraphQL string or an object with query and optional variables.",
    );
  }

  const query = "query" in input ? input.query : undefined;
  if (typeof query !== "string" || query.trim().length === 0) {
    return invalidInput("linear_graphql.query must be a non-empty string.");
  }

  const variablesValue = "variables" in input ? input.variables : undefined;
  if (variablesValue === undefined) {
    return validateDocument({
      query,
      variables: {},
    });
  }

  if (
    variablesValue === null ||
    typeof variablesValue !== "object" ||
    Array.isArray(variablesValue)
  ) {
    return invalidInput("linear_graphql.variables must be a JSON object.");
  }

  return validateDocument({
    query,
    variables: variablesValue as JsonObject,
  });
}

function validateDocument(input: {
  query: string;
  variables: JsonObject;
}):
  | (LinearGraphqlToolResult & { success: false })
  | { success: true; query: string; variables: JsonObject } {
  let document: DocumentNode;

  try {
    document = parse(input.query);
  } catch (error) {
    return invalidInput(
      error instanceof Error
        ? `linear_graphql.query is not valid GraphQL: ${error.message}`
        : "linear_graphql.query is not valid GraphQL.",
    );
  }

  const operationCount = document.definitions.filter(
    (definition) => definition.kind === "OperationDefinition",
  ).length;

  if (operationCount !== 1) {
    return invalidInput(
      "linear_graphql.query must contain exactly one GraphQL operation.",
      { operationCount },
    );
  }

  return {
    success: true,
    query: input.query,
    variables: input.variables,
  };
}

function extractGraphqlErrors(body: unknown): unknown[] | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const errors = (body as JsonObject).errors;
  return Array.isArray(errors) && errors.length > 0 ? errors : null;
}

function invalidInput(
  message: string,
  details?: unknown,
): LinearGraphqlToolResult & { success: false } {
  return {
    success: false,
    error: {
      code: "invalid_input",
      message,
      details: details ?? null,
    },
  };
}
