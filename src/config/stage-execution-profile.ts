import { REASONING_EFFORTS, type ReasoningEffort } from "../domain/model.js";
import {
  STAGE_EXECUTION_BACKENDS,
  STAGE_EXECUTION_MISSING_CAPSULE_POLICIES,
  STAGE_EXECUTION_PHASES,
  STAGE_EXECUTION_ROLES,
  type StageExecutionBackend,
  type StageExecutionMissingCapsulePolicy,
  type StageExecutionPhase,
  type StageExecutionProfile,
  type StageExecutionRole,
  type StageExecutionValidationError,
} from "./types.js";

export function parseStageExecutionProfile(
  value: unknown,
  path: string,
): {
  profile: StageExecutionProfile | null;
  errors: StageExecutionValidationError[];
} {
  if (value === undefined || value === null) {
    return { profile: null, errors: [] };
  }

  const errors: StageExecutionValidationError[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      profile: null,
      errors: [
        executionValidationError(
          path,
          value,
          `${path} must be an object when present.`,
        ),
      ],
    };
  }

  const record = value as Record<string, unknown>;
  const role = readRequiredExecutionEnum<StageExecutionRole>(
    record.role,
    `${path}.role`,
    STAGE_EXECUTION_ROLES,
    errors,
  );
  const phase = readRequiredExecutionEnum<StageExecutionPhase>(
    record.phase,
    `${path}.phase`,
    STAGE_EXECUTION_PHASES,
    errors,
  );
  const backend =
    readOptionalExecutionEnum<StageExecutionBackend>(
      record.backend,
      `${path}.backend`,
      STAGE_EXECUTION_BACKENDS,
      errors,
    ) ?? "current-runner";
  const profileId = readOptionalIdentifier(
    record.profile,
    `${path}.profile`,
    errors,
  );
  const reasoningEffortSource =
    record.reasoning_effort === undefined || record.reasoning_effort === null
      ? { path: `${path}.thinking`, value: record.thinking }
      : { path: `${path}.reasoning_effort`, value: record.reasoning_effort };
  const reasoningEffort = readOptionalReasoningEffort(
    reasoningEffortSource.value,
    reasoningEffortSource.path,
    errors,
  );

  return {
    profile: {
      role,
      phase,
      backend,
      provider: readOptionalNonBlankString(
        record.provider,
        `${path}.provider`,
        errors,
      ),
      model: readOptionalNonBlankString(record.model, `${path}.model`, errors),
      reasoningEffort,
      profile: profileId,
      artifacts: parseStageExecutionArtifactContract(record, path, errors),
      timeoutMs: readOptionalPositiveInteger(
        record.timeout_ms,
        `${path}.timeout_ms`,
        errors,
      ),
      budget: parseStageExecutionBudgetPolicy(
        record.budget,
        `${path}.budget`,
        errors,
      ),
      dependencies: parseStageExecutionDependencyPolicy(
        record.dependencies,
        `${path}.dependencies`,
        errors,
      ),
      runGroup: parseStageExecutionRunGroup(
        record.run_group,
        `${path}.run_group`,
        errors,
      ),
      capsules: parseStageExecutionCapsulePaths(
        record.capsules,
        `${path}.capsules`,
        errors,
      ),
    },
    errors,
  };
}

function parseStageExecutionArtifactContract(
  execution: Record<string, unknown>,
  executionPath: string,
  errors: StageExecutionValidationError[],
): StageExecutionProfile["artifacts"] {
  const value = execution.artifact_contract;
  const path = `${executionPath}.artifact_contract`;
  if (value === undefined || value === null) {
    return Object.freeze({
      requires: Object.freeze([]),
      produces: Object.freeze([]),
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(
      executionValidationError(
        path,
        value,
        `${path} must be an object with requires/produces lists.`,
      ),
    );
    return Object.freeze({
      requires: Object.freeze([]),
      produces: Object.freeze([]),
    });
  }

  const record = value as Record<string, unknown>;
  return Object.freeze({
    requires: Object.freeze(
      readStringListStrict(record.requires, `${path}.requires`, errors),
    ),
    produces: Object.freeze(
      readStringListStrict(record.produces, `${path}.produces`, errors),
    ),
  });
}

function parseStageExecutionBudgetPolicy(
  value: unknown,
  path: string,
  errors: StageExecutionValidationError[],
): StageExecutionProfile["budget"] {
  if (value === undefined || value === null) {
    return { maxTokens: null, maxUsd: null };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(
      executionValidationError(
        path,
        value,
        `${path} must be an object when present.`,
      ),
    );
    return { maxTokens: null, maxUsd: null };
  }

  const record = value as Record<string, unknown>;
  return {
    maxTokens: readOptionalPositiveInteger(
      record.max_tokens,
      `${path}.max_tokens`,
      errors,
    ),
    maxUsd: readOptionalPositiveNumber(
      record.max_usd,
      `${path}.max_usd`,
      errors,
    ),
  };
}

function parseStageExecutionDependencyPolicy(
  value: unknown,
  path: string,
  errors: StageExecutionValidationError[],
): StageExecutionProfile["dependencies"] {
  if (value === undefined || value === null) {
    return Object.freeze({
      stages: Object.freeze([]),
      capsules: Object.freeze([]),
      missingCapsule: "fail",
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(
      executionValidationError(
        path,
        value,
        `${path} must be an object when present.`,
      ),
    );
    return Object.freeze({
      stages: Object.freeze([]),
      capsules: Object.freeze([]),
      missingCapsule: "fail",
    });
  }

  const record = value as Record<string, unknown>;
  return Object.freeze({
    stages: Object.freeze(
      readStringListStrict(record.stages, `${path}.stages`, errors),
    ),
    capsules: Object.freeze(
      readStringListStrict(record.capsules, `${path}.capsules`, errors),
    ),
    missingCapsule:
      readOptionalExecutionEnum<StageExecutionMissingCapsulePolicy>(
        record.missing_capsule,
        `${path}.missing_capsule`,
        STAGE_EXECUTION_MISSING_CAPSULE_POLICIES,
        errors,
      ) ?? "fail",
  });
}

function parseStageExecutionRunGroup(
  value: unknown,
  path: string,
  errors: StageExecutionValidationError[],
): StageExecutionProfile["runGroup"] {
  if (value === undefined || value === null) {
    return { id: null, key: null };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(
      executionValidationError(
        path,
        value,
        `${path} must be an object when present.`,
      ),
    );
    return { id: null, key: null };
  }

  const record = value as Record<string, unknown>;
  return {
    id: readOptionalIdentifier(record.id, `${path}.id`, errors),
    key: readOptionalIdentifier(record.key, `${path}.key`, errors),
  };
}

function parseStageExecutionCapsulePaths(
  value: unknown,
  path: string,
  errors: StageExecutionValidationError[],
): StageExecutionProfile["capsules"] {
  if (value === undefined || value === null) {
    return Object.freeze({
      consume: Object.freeze([]),
      produce: Object.freeze([]),
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(
      executionValidationError(
        path,
        value,
        `${path} must be an object when present.`,
      ),
    );
    return Object.freeze({
      consume: Object.freeze([]),
      produce: Object.freeze([]),
    });
  }

  const record = value as Record<string, unknown>;
  return Object.freeze({
    consume: Object.freeze(
      readStringListStrict(record.consume, `${path}.consume`, errors),
    ),
    produce: Object.freeze(
      readStringListStrict(record.produce, `${path}.produce`, errors),
    ),
  });
}

function readRequiredExecutionEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
  errors: StageExecutionValidationError[],
): T | null {
  const parsed = readOptionalExecutionEnum(value, path, allowed, errors);
  if (parsed === null && (value === undefined || value === null)) {
    errors.push(
      executionValidationError(
        path,
        value,
        `${path} is required and must be one of: ${allowed.join(", ")}.`,
      ),
    );
  }
  return parsed;
}

function readOptionalExecutionEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
  errors: StageExecutionValidationError[],
): T | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    errors.push(
      executionValidationError(
        path,
        value,
        `${path} must be one of: ${allowed.join(", ")}.`,
      ),
    );
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if ((allowed as readonly string[]).includes(normalized)) {
    return normalized as T;
  }
  errors.push(
    executionValidationError(
      path,
      value,
      `${path} must be one of: ${allowed.join(", ")}.`,
    ),
  );
  return null;
}

function readOptionalIdentifier(
  value: unknown,
  path: string,
  errors: StageExecutionValidationError[],
): string | null {
  const parsed = readOptionalNonBlankString(value, path, errors);
  if (parsed === null) {
    return null;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(parsed)) {
    errors.push(
      executionValidationError(
        path,
        value,
        `${path} must start with an alphanumeric character and contain only alphanumerics, '.', '_', ':', or '-'.`,
      ),
    );
    return null;
  }
  return parsed;
}

function readOptionalNonBlankString(
  value: unknown,
  path: string,
  errors: StageExecutionValidationError[],
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(
      executionValidationError(
        path,
        value,
        `${path} must be a non-empty string.`,
      ),
    );
    return null;
  }
  return value.trim();
}

function readOptionalReasoningEffort(
  value: unknown,
  path: string,
  errors: StageExecutionValidationError[],
): ReasoningEffort | null {
  if (value === undefined || value === null) {
    return null;
  }
  const effort = readReasoningEffort(value);
  if (effort === null) {
    errors.push(
      executionValidationError(
        path,
        value,
        `${path} must be one of: ${REASONING_EFFORTS.join(", ")}.`,
      ),
    );
  }
  return effort;
}

function readOptionalPositiveInteger(
  value: unknown,
  path: string,
  errors: StageExecutionValidationError[],
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const parsed = readPositiveInteger(value);
  if (parsed === null) {
    errors.push(
      executionValidationError(
        path,
        value,
        `${path} must be a positive integer.`,
      ),
    );
  }
  return parsed;
}

function readOptionalPositiveNumber(
  value: unknown,
  path: string,
  errors: StageExecutionValidationError[],
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const parsed = readPositiveNumber(value);
  if (parsed === null) {
    errors.push(
      executionValidationError(
        path,
        value,
        `${path} must be a positive number.`,
      ),
    );
  }
  return parsed;
}

function readStringListStrict(
  value: unknown,
  path: string,
  errors: StageExecutionValidationError[],
): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (typeof value === "string") {
    const entries = value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    if (entries.length > 0) {
      return entries;
    }
    errors.push(
      executionValidationError(
        path,
        value,
        `${path} must include at least one non-empty string.`,
      ),
    );
    return [];
  }
  if (!Array.isArray(value)) {
    errors.push(
      executionValidationError(path, value, `${path} must be a string list.`),
    );
    return [];
  }

  const entries: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      errors.push(
        executionValidationError(
          `${path}.${index}`,
          entry,
          `${path}.${index} must be a non-empty string.`,
        ),
      );
      return;
    }
    entries.push(entry.trim());
  });
  return entries;
}

function readPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

function readPositiveNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!/^(?:[1-9]\d*|0)(?:\.\d+)?$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function readReasoningEffort(value: unknown): ReasoningEffort | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return (REASONING_EFFORTS as readonly string[]).includes(normalized)
    ? (normalized as ReasoningEffort)
    : null;
}

function executionValidationError(
  path: string,
  value: unknown,
  message: string,
): StageExecutionValidationError {
  return {
    path,
    value: stringifyConfigValue(value),
    message,
  };
}

function stringifyConfigValue(value: unknown): string {
  if (value === undefined) {
    return "<missing>";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
