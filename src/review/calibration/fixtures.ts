import { readFileSync } from "node:fs";

export const REVIEW_CALIBRATION_CORPUS_SCHEMA_VERSION = 1;
export const REVIEW_CALIBRATION_OWNER_ISSUE = "SYMPH-493";
export const REVIEW_CALIBRATION_PARENT_ISSUE = "SYMPH-446";

export const REVIEW_CALIBRATION_BUG_CLASSES = [
  "security:path_traversal",
  "security:shell_injection",
  "security:secret_exposure",
  "security:safe_filesystem",
  "security:safe_auth_adjacent",
  "instruction:prompt_injection",
  "workflow:state_transition",
  "frontmatter:metadata_drift",
  "historical:symphony_replay",
  "convergence:same_family_reopen",
  "convergence:fix_round_regression",
  "convergence:replay_event_shape",
] as const;

export type ReviewCalibrationBugClass =
  (typeof REVIEW_CALIBRATION_BUG_CLASSES)[number];

export const REVIEW_CALIBRATION_CATEGORIES = [
  "security",
  "instruction",
  "workflow",
  "frontmatter",
  "historical-replay",
  "targeted-convergence",
] as const;

export type ReviewCalibrationCategory =
  (typeof REVIEW_CALIBRATION_CATEGORIES)[number];

const REVIEW_CALIBRATION_CATEGORY_BY_BUG_CLASS = {
  "security:path_traversal": "security",
  "security:shell_injection": "security",
  "security:secret_exposure": "security",
  "security:safe_filesystem": "security",
  "security:safe_auth_adjacent": "security",
  "instruction:prompt_injection": "instruction",
  "workflow:state_transition": "workflow",
  "frontmatter:metadata_drift": "frontmatter",
  "historical:symphony_replay": "historical-replay",
  "convergence:same_family_reopen": "targeted-convergence",
  "convergence:fix_round_regression": "targeted-convergence",
  "convergence:replay_event_shape": "targeted-convergence",
} as const satisfies Record<
  ReviewCalibrationBugClass,
  ReviewCalibrationCategory
>;

export const REVIEW_CALIBRATION_REVIEWER_DISPOSITIONS = [
  "finding",
  "no_finding",
  "metadata_only",
] as const;

export type ReviewCalibrationReviewerDisposition =
  (typeof REVIEW_CALIBRATION_REVIEWER_DISPOSITIONS)[number];

export const REVIEW_CALIBRATION_SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as const;

export type ReviewCalibrationSeverity =
  (typeof REVIEW_CALIBRATION_SEVERITIES)[number];

export const REVIEW_CALIBRATION_CONFIDENCES = [
  "high",
  "medium",
  "low",
] as const;

export type ReviewCalibrationConfidence =
  (typeof REVIEW_CALIBRATION_CONFIDENCES)[number];

export const REVIEW_CALIBRATION_SOURCE_REF_KINDS = [
  "linear",
  "github_pr",
  "spec",
  "synthetic",
] as const;

export type ReviewCalibrationSourceRefKind =
  (typeof REVIEW_CALIBRATION_SOURCE_REF_KINDS)[number];

export interface ReviewCalibrationCorpus {
  schemaVersion: typeof REVIEW_CALIBRATION_CORPUS_SCHEMA_VERSION;
  ownerIssue: typeof REVIEW_CALIBRATION_OWNER_ISSUE;
  parentIssue: typeof REVIEW_CALIBRATION_PARENT_ISSUE;
  fixtures: ReviewCalibrationFixture[];
}

export interface ReviewCalibrationFixture {
  id: string;
  title: string;
  category: ReviewCalibrationCategory;
  bugClass: ReviewCalibrationBugClass;
  tags: string[];
  scenario: string;
  subject: ReviewCalibrationSubject;
  expectedReviewerOutcome: ReviewCalibrationExpectedOutcome;
  falsePositiveTrap: ReviewCalibrationFalsePositiveTrap | null;
  sourceRefs: ReviewCalibrationSourceRef[];
  futureRefHygiene: ReviewCalibrationFutureRefHygiene;
  replay: ReviewCalibrationReplayMetadata | null;
}

export interface ReviewCalibrationSubject {
  language: string;
  path: string;
  body: string;
}

export interface ReviewCalibrationExpectedOutcome {
  disposition: ReviewCalibrationReviewerDisposition;
  severity: ReviewCalibrationSeverity;
  confidence: ReviewCalibrationConfidence;
  shouldBlock: boolean;
  findingFamily: string | null;
  rationale: string;
}

export interface ReviewCalibrationFalsePositiveTrap {
  trapKind: string;
  expectation: string;
}

export interface ReviewCalibrationSourceRef {
  kind: ReviewCalibrationSourceRefKind;
  id: string;
  note: string;
  url: string | null;
}

export interface ReviewCalibrationFutureRefHygiene {
  ownerIssue: typeof REVIEW_CALIBRATION_OWNER_ISSUE;
  parentIssue: typeof REVIEW_CALIBRATION_PARENT_ISSUE;
  futureConsumers: string[];
  runtimeWiring: "not_wired";
  liveModelCalls: "forbidden";
  rolloutRouting: "forbidden";
  notes: string[];
}

export interface ReviewCalibrationReplayMetadata {
  kind: "historical_symphony_placeholder" | "targeted_convergence";
  status: "metadata_only" | "fixture_ready";
  expectedEventShape: ReviewCalibrationReplayEventShape;
}

export interface ReviewCalibrationReplayEventShape {
  eventName: string;
  requiredFields: string[];
  metadataFields: string[];
  forbiddenRuntimeFields: string[];
  sample: Record<string, unknown>;
}

export interface ReviewCalibrationValidationIssue {
  path: string;
  message: string;
}

export interface ReviewCalibrationValidationResult {
  ok: boolean;
  fixtureCount: number;
  errors: ReviewCalibrationValidationIssue[];
}

export function loadReviewCalibrationCorpusFile(
  corpusPath: string,
): ReviewCalibrationCorpus {
  return parseReviewCalibrationCorpus(
    readFileSync(corpusPath, "utf8"),
    corpusPath,
  );
}

export function parseReviewCalibrationCorpus(
  raw: string,
  sourceLabel = "review calibration corpus",
): ReviewCalibrationCorpus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${sourceLabel}: ${detail}`);
  }
  assertReviewCalibrationCorpus(parsed, sourceLabel);
  return parsed;
}

export function assertReviewCalibrationCorpus(
  value: unknown,
  sourceLabel = "review calibration corpus",
): asserts value is ReviewCalibrationCorpus {
  const result = validateReviewCalibrationCorpus(value);
  if (!result.ok) {
    const details = result.errors
      .map((error) => `${error.path}: ${error.message}`)
      .join("; ");
    throw new Error(`Invalid ${sourceLabel}: ${details}`);
  }
}

export function validateReviewCalibrationCorpus(
  value: unknown,
): ReviewCalibrationValidationResult {
  const errors: ReviewCalibrationValidationIssue[] = [];
  const addError = (path: string, message: string): void => {
    errors.push({ path, message });
  };

  if (!isRecord(value)) {
    addError("$", "must be an object");
    return { ok: false, fixtureCount: 0, errors };
  }

  if (value.schemaVersion !== REVIEW_CALIBRATION_CORPUS_SCHEMA_VERSION) {
    addError(
      "$.schemaVersion",
      `must be ${REVIEW_CALIBRATION_CORPUS_SCHEMA_VERSION}`,
    );
  }
  if (value.ownerIssue !== REVIEW_CALIBRATION_OWNER_ISSUE) {
    addError("$.ownerIssue", `must be ${REVIEW_CALIBRATION_OWNER_ISSUE}`);
  }
  if (value.parentIssue !== REVIEW_CALIBRATION_PARENT_ISSUE) {
    addError("$.parentIssue", `must be ${REVIEW_CALIBRATION_PARENT_ISSUE}`);
  }
  if (!Array.isArray(value.fixtures)) {
    addError("$.fixtures", "must be an array");
    return { ok: errors.length === 0, fixtureCount: 0, errors };
  }
  if (value.fixtures.length === 0) {
    addError("$.fixtures", "must not be empty");
  }

  const seenIds = new Set<string>();
  value.fixtures.forEach((fixture, index) => {
    validateFixture(fixture, `$.fixtures[${index}]`, seenIds, addError);
  });
  validateBugClassCoverage(value.fixtures, "$.fixtures", addError);

  return {
    ok: errors.length === 0,
    fixtureCount: value.fixtures.length,
    errors,
  };
}

export function findReviewCalibrationFixture(
  corpus: ReviewCalibrationCorpus,
  id: string,
): ReviewCalibrationFixture | null {
  return corpus.fixtures.find((fixture) => fixture.id === id) ?? null;
}

export function getReviewCalibrationFixturesByBugClass(
  corpus: ReviewCalibrationCorpus,
  bugClass: ReviewCalibrationBugClass,
): ReviewCalibrationFixture[] {
  return corpus.fixtures.filter((fixture) => fixture.bugClass === bugClass);
}

export function collectReviewCalibrationFutureRefHygieneGaps(
  corpus: ReviewCalibrationCorpus,
): ReviewCalibrationValidationIssue[] {
  const gaps: ReviewCalibrationValidationIssue[] = [];
  const addGap = (path: string, message: string): void => {
    gaps.push({ path, message });
  };
  corpus.fixtures.forEach((fixture, index) => {
    validateFutureRefHygiene(
      fixture.futureRefHygiene,
      `$.fixtures[${index}].futureRefHygiene`,
      addGap,
    );
  });
  return gaps;
}

function validateFixture(
  value: unknown,
  path: string,
  seenIds: Set<string>,
  addError: (path: string, message: string) => void,
): void {
  if (!isRecord(value)) {
    addError(path, "must be an object");
    return;
  }

  const id = validateString(value.id, `${path}.id`, addError);
  if (id !== null) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      addError(`${path}.id`, "must be kebab-case");
    }
    if (seenIds.has(id)) {
      addError(`${path}.id`, "must be unique");
    }
    seenIds.add(id);
  }

  validateString(value.title, `${path}.title`, addError);
  const category = validateOneOf(
    value.category,
    REVIEW_CALIBRATION_CATEGORIES,
    `${path}.category`,
    addError,
  );
  const bugClass = validateOneOf(
    value.bugClass,
    REVIEW_CALIBRATION_BUG_CLASSES,
    `${path}.bugClass`,
    addError,
  );
  if (
    category !== null &&
    bugClass !== null &&
    REVIEW_CALIBRATION_CATEGORY_BY_BUG_CLASS[bugClass] !== category
  ) {
    addError(
      `${path}.category`,
      `must be ${REVIEW_CALIBRATION_CATEGORY_BY_BUG_CLASS[bugClass]} for bugClass ${bugClass}`,
    );
  }
  validateStringArray(value.tags, `${path}.tags`, addError, {
    allowEmpty: false,
  });
  validateString(value.scenario, `${path}.scenario`, addError);
  validateSubject(value.subject, `${path}.subject`, addError);
  validateExpectedOutcome(
    value.expectedReviewerOutcome,
    `${path}.expectedReviewerOutcome`,
    addError,
  );
  validateFalsePositiveTrap(
    value.falsePositiveTrap,
    `${path}.falsePositiveTrap`,
    addError,
  );
  validateSourceRefs(value.sourceRefs, `${path}.sourceRefs`, addError);
  validateFutureRefHygiene(
    value.futureRefHygiene,
    `${path}.futureRefHygiene`,
    addError,
  );
  validateReplay(value.replay, `${path}.replay`, category, addError);

  if (category === "historical-replay") {
    validateHistoricalSourceRefs(
      value.sourceRefs,
      `${path}.sourceRefs`,
      addError,
    );
    if (!isRecord(value.replay)) {
      addError(
        `${path}.replay`,
        "historical replay fixtures require replay metadata",
      );
    }
  }
  if (category === "targeted-convergence" && !isRecord(value.replay)) {
    addError(
      `${path}.replay`,
      "targeted convergence fixtures require replay metadata",
    );
  }
  if (bugClass?.startsWith("security:") === true) {
    validateSecurityOutcome(value, path, bugClass, addError);
  }
}

function validateSubject(
  value: unknown,
  path: string,
  addError: (path: string, message: string) => void,
): void {
  if (!isRecord(value)) {
    addError(path, "must be an object");
    return;
  }
  validateString(value.language, `${path}.language`, addError);
  validateString(value.path, `${path}.path`, addError);
  validateString(value.body, `${path}.body`, addError);
}

function validateExpectedOutcome(
  value: unknown,
  path: string,
  addError: (path: string, message: string) => void,
): void {
  if (!isRecord(value)) {
    addError(path, "must be an object");
    return;
  }
  validateOneOf(
    value.disposition,
    REVIEW_CALIBRATION_REVIEWER_DISPOSITIONS,
    `${path}.disposition`,
    addError,
  );
  validateOneOf(
    value.severity,
    REVIEW_CALIBRATION_SEVERITIES,
    `${path}.severity`,
    addError,
  );
  validateOneOf(
    value.confidence,
    REVIEW_CALIBRATION_CONFIDENCES,
    `${path}.confidence`,
    addError,
  );
  if (typeof value.shouldBlock !== "boolean") {
    addError(`${path}.shouldBlock`, "must be a boolean");
  }
  if (
    !(typeof value.findingFamily === "string" || value.findingFamily === null)
  ) {
    addError(`${path}.findingFamily`, "must be a string or null");
  }
  validateString(value.rationale, `${path}.rationale`, addError);
}

function validateFalsePositiveTrap(
  value: unknown,
  path: string,
  addError: (path: string, message: string) => void,
): void {
  if (value === null) {
    return;
  }
  if (!isRecord(value)) {
    addError(path, "must be an object or null");
    return;
  }
  validateString(value.trapKind, `${path}.trapKind`, addError);
  validateString(value.expectation, `${path}.expectation`, addError);
}

function validateSourceRefs(
  value: unknown,
  path: string,
  addError: (path: string, message: string) => void,
): void {
  if (!Array.isArray(value)) {
    addError(path, "must be an array");
    return;
  }
  if (value.length === 0) {
    addError(path, "must not be empty");
  }
  value.forEach((sourceRef, index) => {
    if (!isRecord(sourceRef)) {
      addError(`${path}[${index}]`, "must be an object");
      return;
    }
    validateOneOf(
      sourceRef.kind,
      REVIEW_CALIBRATION_SOURCE_REF_KINDS,
      `${path}[${index}].kind`,
      addError,
    );
    validateString(sourceRef.id, `${path}[${index}].id`, addError);
    validateString(sourceRef.note, `${path}[${index}].note`, addError);
    if (!(typeof sourceRef.url === "string" || sourceRef.url === null)) {
      addError(`${path}[${index}].url`, "must be a string or null");
    }
  });
}

function validateHistoricalSourceRefs(
  value: unknown,
  path: string,
  addError: (path: string, message: string) => void,
): void {
  if (!Array.isArray(value)) {
    return;
  }
  const ids = new Set(
    value
      .filter(isRecord)
      .map((sourceRef) => sourceRef.id)
      .filter((id): id is string => typeof id === "string"),
  );
  if (!ids.has("SYMPH-440")) {
    addError(path, "historical replay fixtures must reference SYMPH-440");
  }
  if (!ids.has("PR #392")) {
    addError(path, "historical replay fixtures must reference PR #392");
  }
}

function validateFutureRefHygiene(
  value: unknown,
  path: string,
  addError: (path: string, message: string) => void,
): void {
  if (!isRecord(value)) {
    addError(path, "must be an object");
    return;
  }
  if (value.ownerIssue !== REVIEW_CALIBRATION_OWNER_ISSUE) {
    addError(`${path}.ownerIssue`, `must be ${REVIEW_CALIBRATION_OWNER_ISSUE}`);
  }
  if (value.parentIssue !== REVIEW_CALIBRATION_PARENT_ISSUE) {
    addError(
      `${path}.parentIssue`,
      `must be ${REVIEW_CALIBRATION_PARENT_ISSUE}`,
    );
  }
  validateStringArray(
    value.futureConsumers,
    `${path}.futureConsumers`,
    addError,
    {
      allowEmpty: false,
    },
  );
  if (value.runtimeWiring !== "not_wired") {
    addError(`${path}.runtimeWiring`, "must be not_wired");
  }
  if (value.liveModelCalls !== "forbidden") {
    addError(`${path}.liveModelCalls`, "must be forbidden");
  }
  if (value.rolloutRouting !== "forbidden") {
    addError(`${path}.rolloutRouting`, "must be forbidden");
  }
  validateStringArray(value.notes, `${path}.notes`, addError, {
    allowEmpty: false,
  });
}

function validateReplay(
  value: unknown,
  path: string,
  category: string | null,
  addError: (path: string, message: string) => void,
): void {
  if (value === null) {
    return;
  }
  if (!isRecord(value)) {
    addError(path, "must be an object or null");
    return;
  }
  validateOneOf(
    value.kind,
    ["historical_symphony_placeholder", "targeted_convergence"] as const,
    `${path}.kind`,
    addError,
  );
  validateOneOf(
    value.status,
    ["metadata_only", "fixture_ready"] as const,
    `${path}.status`,
    addError,
  );
  validateReplayEventShape(
    value.expectedEventShape,
    `${path}.expectedEventShape`,
    addError,
  );
  if (
    category === "historical-replay" &&
    value.kind !== "historical_symphony_placeholder"
  ) {
    addError(`${path}.kind`, "historical replay fixtures need historical kind");
  }
  if (
    category === "targeted-convergence" &&
    value.kind !== "targeted_convergence"
  ) {
    addError(
      `${path}.kind`,
      "targeted convergence fixtures need convergence kind",
    );
  }
}

function validateReplayEventShape(
  value: unknown,
  path: string,
  addError: (path: string, message: string) => void,
): void {
  if (!isRecord(value)) {
    addError(path, "must be an object");
    return;
  }
  validateString(value.eventName, `${path}.eventName`, addError);
  validateStringArray(
    value.requiredFields,
    `${path}.requiredFields`,
    addError,
    {
      allowEmpty: false,
    },
  );
  validateStringArray(
    value.metadataFields,
    `${path}.metadataFields`,
    addError,
    {
      allowEmpty: false,
    },
  );
  validateStringArray(
    value.forbiddenRuntimeFields,
    `${path}.forbiddenRuntimeFields`,
    addError,
    { allowEmpty: false },
  );
  if (!isRecord(value.sample)) {
    addError(`${path}.sample`, "must be an object");
    return;
  }
  for (const field of stringArrayValues(value.requiredFields)) {
    if (!Object.hasOwn(value.sample, field)) {
      addError(`${path}.sample.${field}`, "must include required field");
    }
  }
  for (const field of stringArrayValues(value.forbiddenRuntimeFields)) {
    const forbiddenPath = findOwnKeyPathDeep(
      value.sample,
      field,
      `${path}.sample`,
    );
    if (forbiddenPath !== null) {
      addError(forbiddenPath, "must not include forbidden runtime field");
    }
  }
}

function validateBugClassCoverage(
  fixtures: readonly unknown[],
  path: string,
  addError: (path: string, message: string) => void,
): void {
  for (const bugClass of REVIEW_CALIBRATION_BUG_CLASSES) {
    const count = fixtures.filter(
      (fixture) => isRecord(fixture) && fixture.bugClass === bugClass,
    ).length;
    if (count === 0) {
      addError(path, `must include one fixture for bug class ${bugClass}`);
    } else if (count > 1) {
      addError(path, `must include only one fixture for bug class ${bugClass}`);
    }
  }
}

function validateSecurityOutcome(
  fixture: Record<string, unknown>,
  path: string,
  bugClass: ReviewCalibrationBugClass,
  addError: (path: string, message: string) => void,
): void {
  const outcome = fixture.expectedReviewerOutcome;
  if (!isRecord(outcome)) {
    return;
  }

  const isSafeFixture =
    bugClass === "security:safe_filesystem" ||
    bugClass === "security:safe_auth_adjacent";
  if (isSafeFixture) {
    if (outcome.disposition !== "no_finding") {
      addError(
        `${path}.expectedReviewerOutcome.disposition`,
        "safe security fixtures must expect no_finding",
      );
    }
    if (fixture.falsePositiveTrap === null) {
      addError(
        `${path}.falsePositiveTrap`,
        "safe security fixtures must carry a false-positive trap",
      );
    }
    return;
  }

  if (outcome.disposition !== "finding") {
    addError(
      `${path}.expectedReviewerOutcome.disposition`,
      "malicious security fixtures must expect finding",
    );
  }
  if (outcome.shouldBlock !== true) {
    addError(
      `${path}.expectedReviewerOutcome.shouldBlock`,
      "malicious security fixtures must block",
    );
  }
}

function validateString(
  value: unknown,
  path: string,
  addError: (path: string, message: string) => void,
): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    addError(path, "must be a non-empty string");
    return null;
  }
  return value;
}

function validateStringArray(
  value: unknown,
  path: string,
  addError: (path: string, message: string) => void,
  options: { allowEmpty: boolean },
): void {
  if (!Array.isArray(value)) {
    addError(path, "must be an array");
    return;
  }
  if (!options.allowEmpty && value.length === 0) {
    addError(path, "must not be empty");
  }
  value.forEach((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      addError(`${path}[${index}]`, "must be a non-empty string");
    }
  });
}

function stringArrayValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : [];
}

function findOwnKeyPathDeep(
  value: unknown,
  field: string,
  path: string,
): string | null {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findOwnKeyPathDeep(item, field, `${path}[${index}]`);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  if (Object.hasOwn(value, field)) {
    return `${path}.${field}`;
  }
  for (const [key, item] of Object.entries(value)) {
    const found = findOwnKeyPathDeep(item, field, `${path}.${key}`);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function validateOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
  addError: (path: string, message: string) => void,
): T[number] | null {
  if (typeof value !== "string" || !allowed.includes(value)) {
    addError(path, `must be one of ${allowed.join(", ")}`);
    return null;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
