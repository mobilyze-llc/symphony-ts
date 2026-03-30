import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { parse } from "yaml";

import type { WorkflowDefinition } from "../domain/model.js";
import { ERROR_CODES } from "../errors/codes.js";
import { WORKFLOW_FILENAME } from "./defaults.js";

export class WorkflowLoaderError extends Error {
  readonly code: string;
  readonly workflowPath: string;

  constructor(input: { code: string; message: string; workflowPath: string }) {
    super(input.message);
    this.name = "WorkflowLoaderError";
    this.code = input.code;
    this.workflowPath = input.workflowPath;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMergeConfigs(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };

  for (const key of Object.keys(override)) {
    const baseVal = base[key];
    const overrideVal = override[key];

    if (isPlainObject(baseVal) && isPlainObject(overrideVal)) {
      result[key] = deepMergeConfigs(baseVal, overrideVal);
    } else {
      result[key] = overrideVal;
    }
  }

  return result;
}

export function resolveWorkflowPath(workflowPath?: string): string {
  if (workflowPath && workflowPath.trim() !== "") {
    return resolve(workflowPath);
  }

  return resolve(process.cwd(), WORKFLOW_FILENAME);
}

export async function loadWorkflowDefinition(
  workflowPath?: string,
): Promise<
  WorkflowDefinition & { workflowPath: string; baseConfigPath?: string }
> {
  const resolvedWorkflowPath = resolveWorkflowPath(workflowPath);

  let content: string;
  try {
    content = await readFile(resolvedWorkflowPath, "utf8");
  } catch (error) {
    const errorCode =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      error.code === "ENOENT"
        ? ERROR_CODES.missingWorkflowFile
        : ERROR_CODES.workflowReadFailed;

    throw new WorkflowLoaderError({
      code: errorCode,
      message: `Unable to read workflow file at ${resolvedWorkflowPath}.`,
      workflowPath: resolvedWorkflowPath,
    });
  }

  const workflow = parseWorkflowContent(content, resolvedWorkflowPath);

  if (typeof workflow.config.base_config === "string") {
    const baseConfigRelative = workflow.config.base_config;
    const baseConfigPath = resolve(
      dirname(resolvedWorkflowPath),
      baseConfigRelative,
    );

    let baseContent: string;
    try {
      baseContent = await readFile(baseConfigPath, "utf8");
    } catch (error) {
      const errorCode =
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string" &&
        error.code === "ENOENT"
          ? ERROR_CODES.missingWorkflowFile
          : ERROR_CODES.baseConfigReadFailed;

      throw new WorkflowLoaderError({
        code: errorCode,
        message: `Unable to read base_config file at ${baseConfigPath}.`,
        workflowPath: resolvedWorkflowPath,
      });
    }

    const baseWorkflow = parseWorkflowContent(baseContent, baseConfigPath);

    if (typeof baseWorkflow.config.base_config === "string") {
      throw new WorkflowLoaderError({
        code: ERROR_CODES.baseConfigCircularReference,
        message: `Base config file at ${baseConfigPath} itself contains a base_config reference. Only one level of base_config indirection is allowed.`,
        workflowPath: resolvedWorkflowPath,
      });
    }

    const { base_config: _removed, ...productConfigWithoutBase } =
      workflow.config;
    const mergedConfig = deepMergeConfigs(
      baseWorkflow.config,
      productConfigWithoutBase,
    );

    const productBody = workflow.promptTemplate;
    const baseBody = baseWorkflow.promptTemplate;
    let mergedBody: string;

    if (productBody.length > 0) {
      mergedBody =
        baseBody.length > 0 ? `${baseBody}\n${productBody}` : productBody;
    } else {
      mergedBody = baseBody;
    }

    return {
      config: mergedConfig,
      promptTemplate: mergedBody,
      workflowPath: resolvedWorkflowPath,
      baseConfigPath,
    };
  }

  return {
    ...workflow,
    workflowPath: resolvedWorkflowPath,
  };
}

export function parseWorkflowContent(
  content: string,
  workflowPath = WORKFLOW_FILENAME,
): WorkflowDefinition {
  if (!content.startsWith("---")) {
    return {
      config: {},
      promptTemplate: content.trim(),
    };
  }

  const frontMatterResult = splitFrontMatter(content, workflowPath);
  const parsedConfig = parseYamlFrontMatter(
    frontMatterResult.frontMatter,
    workflowPath,
  );

  return {
    config: parsedConfig,
    promptTemplate: frontMatterResult.body.trim(),
  };
}

function splitFrontMatter(
  content: string,
  workflowPath: string,
): {
  frontMatter: string;
  body: string;
} {
  const normalizedContent = content.replace(/\r\n/g, "\n");
  const lines = normalizedContent.split("\n");

  if (lines[0] !== "---") {
    return {
      frontMatter: "",
      body: normalizedContent,
    };
  }

  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line === "---",
  );
  if (closingIndex === -1) {
    throw new WorkflowLoaderError({
      code: ERROR_CODES.workflowParseError,
      message: "Workflow front matter is missing a closing delimiter.",
      workflowPath,
    });
  }

  return {
    frontMatter: lines.slice(1, closingIndex).join("\n"),
    body: lines.slice(closingIndex + 1).join("\n"),
  };
}

function parseYamlFrontMatter(
  yamlSource: string,
  workflowPath: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parse(yamlSource);
  } catch (error) {
    const details = error instanceof Error ? ` ${error.message}` : "";
    throw new WorkflowLoaderError({
      code: ERROR_CODES.workflowParseError,
      message: `Workflow front matter could not be parsed as YAML.${details}`,
      workflowPath,
    });
  }

  if (parsed === null) {
    throw new WorkflowLoaderError({
      code: ERROR_CODES.workflowFrontMatterNotAMap,
      message: "Workflow front matter must decode to a map/object.",
      workflowPath,
    });
  }

  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkflowLoaderError({
      code: ERROR_CODES.workflowFrontMatterNotAMap,
      message: "Workflow front matter must decode to a map/object.",
      workflowPath,
    });
  }

  return parsed as Record<string, unknown>;
}
