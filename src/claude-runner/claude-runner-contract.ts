export const CLAUDE_RUNNER_PURPOSES = [
  "review",
  "research",
  "spec-review",
  "spec-partner",
  "development-agent",
  "critique",
  "custom",
] as const;

export type ClaudeRunnerPurpose = (typeof CLAUDE_RUNNER_PURPOSES)[number];

export type ClaudeRunnerStatus =
  | "passed"
  | "failed"
  | "invalid_artifact"
  | "timed_out"
  | "degraded";

export interface ClaudeRunnerValidationConfig {
  minBytes?: number;
  requiredHeadings?: string[];
  requireFirstHeading?: string;
  verdictEnums?: string[];
  requireSourceReadStatus?: boolean;
  requiredJsonSections?: string[];
}

export interface ClaudeRunnerInput {
  purpose: ClaudeRunnerPurpose;
  workspace: string;
  promptFile: string;
  artifactDir: string;
  artifactName: string;
  model?: string;
  profile?: string;
  laneId?: string;
  phase?: string;
  timeoutSeconds?: number;
  sourcePaths?: string[];
  validation?: ClaudeRunnerValidationConfig;
  diagnosticByteLimit?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ClaudeRunnerSourceVisibility {
  status: "ok" | "invalid_source_path";
  workspace: string;
  sources: Array<{
    kind: "prompt" | "source";
    path: string;
    resolvedPath: string;
    sha256: string | null;
    bytes: number | null;
    readable: boolean;
    insideWorkspace: boolean;
    error: string | null;
  }>;
}

export interface ClaudeRunnerAttempt {
  attempt: number;
  artifactName: string;
  artifactPath: string;
  remoteArtifactPath?: string | null;
  cliJsonPath: string;
  statusPath: string;
  state: string | null;
  exitCode: number;
  validationErrors: string[];
}

export interface ClaudeRunnerBoundedText {
  text: string;
  originalBytes: number;
  omittedBytes: number;
  truncated: boolean;
  maxBytes: number;
}

export interface ClaudeRunnerCommandDiagnostics {
  stdout: ClaudeRunnerBoundedText;
  stderr: ClaudeRunnerBoundedText;
}

export interface ClaudeRunnerDiagnostics {
  diagnosticByteLimit: number;
  preflight: ClaudeRunnerCommandDiagnostics | null;
  attempts: ClaudeRunnerCommandDiagnostics[];
}

export interface ClaudeRunnerResult {
  schemaVersion: 2;
  status: ClaudeRunnerStatus;
  purpose: ClaudeRunnerPurpose;
  model: string;
  profile: string;
  workspace: string;
  promptFile: string;
  promptSha256: string | null;
  artifactDir: string;
  artifactName: string;
  artifactPath: string | null;
  remoteArtifactPath?: string | null;
  resultJsonPath: string;
  runnerBin: string;
  laneId: string;
  phase: string;
  startedAt: string;
  completedAt: string;
  sourceVisibility: ClaudeRunnerSourceVisibility;
  attempts: ClaudeRunnerAttempt[];
  validationErrors: string[];
  diagnostics: ClaudeRunnerDiagnostics;
  usage: Record<string, unknown> | null;
  message: string;
}

const DEFAULT_MIN_ARTIFACT_BYTES = 200;
export const MAX_CLAUDE_RUNNER_DIAGNOSTIC_BYTE_LIMIT = 256 * 1024;

export function isSafeClaudeArtifactName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

export async function validateClaudeArtifact(
  content: string,
  validation: ClaudeRunnerValidationConfig = {},
): Promise<string[]> {
  const errors: string[] = [];
  const bytes = Buffer.byteLength(content, "utf8");
  const minBytes = validation.minBytes ?? DEFAULT_MIN_ARTIFACT_BYTES;
  if (bytes < minBytes) {
    errors.push(`artifact is too small (${bytes} bytes < ${minBytes} bytes)`);
  }
  const firstHeading = validation.requireFirstHeading;
  if (firstHeading !== undefined) {
    const firstNonEmpty = content
      .split(/\r?\n/)
      .find((line) => line.trim() !== "");
    if (
      firstNonEmpty === undefined ||
      !headingLineMatches(firstNonEmpty, firstHeading)
    ) {
      errors.push(`artifact first heading must be "${firstHeading}"`);
    }
  }
  for (const heading of validation.requiredHeadings ?? []) {
    if (!containsMarkdownHeading(content, heading)) {
      errors.push(`artifact is missing required heading "${heading}"`);
    }
  }
  if (
    validation.requireSourceReadStatus === true &&
    !hasSourceReadStatusSection(content)
  ) {
    errors.push("artifact is missing a non-empty Source Read Status section");
  }
  const verdictEnums = validation.verdictEnums ?? [];
  if (verdictEnums.length > 0) {
    const verdict = extractVerdictEnum(content);
    if (verdict === null) {
      errors.push("artifact is missing a verdict enum");
    } else if (
      !verdictEnums.some((entry) => entry.trim().toLowerCase() === verdict)
    ) {
      errors.push(
        `artifact verdict "${verdict}" is not one of ${verdictEnums.join(", ")}`,
      );
    }
  }
  for (const section of validation.requiredJsonSections ?? []) {
    const json = extractJsonFenceInSection(content, section);
    if (json.status === "missing_section") {
      errors.push(`artifact is missing required JSON section "${section}"`);
      continue;
    }
    if (json.status === "missing_fence") {
      errors.push(
        `artifact required JSON section "${section}" is missing a fenced json object`,
      );
      continue;
    }
    if (json.status === "unterminated_fence") {
      errors.push(
        `artifact required JSON section "${section}" has an unterminated fenced json object`,
      );
      continue;
    }
    if (json.status === "multiple_fences") {
      errors.push(
        `artifact required JSON section "${section}" contains multiple fenced json objects`,
      );
      continue;
    }
    try {
      const parsed = JSON.parse(json.text) as unknown;
      if (!isRecord(parsed)) {
        errors.push(
          `artifact required JSON section "${section}" JSON must be an object`,
        );
      }
    } catch (error) {
      errors.push(
        `artifact required JSON section "${section}" contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return errors;
}

export function extractVerdictEnum(text: string): string | null {
  const inline = /verdict(?:\s+enum)?\s*[:：]\s*`?([a-z][a-z0-9_-]+)`?/i.exec(
    text,
  )?.[1];
  const candidate =
    inline ??
    extractMarkdownSection(text, "Verdict")
      ?.content.split(/\r?\n/)
      .map((line) => line.trim().replace(/^`+|`+$/gu, ""))
      .find((line) => line !== "");
  return candidate !== undefined && /^[a-z][a-z0-9_-]*$/iu.test(candidate)
    ? candidate.toLowerCase()
    : null;
}

function containsMarkdownHeading(text: string, heading: string): boolean {
  return text.split(/\r?\n/).some((line) => headingLineMatches(line, heading));
}

function hasSourceReadStatusSection(text: string): boolean {
  const section = extractMarkdownSection(text, "Source Read Status");
  return section !== null && section.content.trim() !== "";
}

type JsonFenceResult =
  | { status: "ok"; text: string }
  | { status: "missing_section" }
  | { status: "missing_fence" }
  | { status: "unterminated_fence" }
  | { status: "multiple_fences" };

function extractJsonFenceInSection(
  text: string,
  heading: string,
): JsonFenceResult {
  const section = extractMarkdownSection(text, heading);
  if (section === null) {
    return { status: "missing_section" };
  }
  const lines = section.content.split(/\r?\n/);
  let foundText: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const opening = parseJsonFenceOpening(lines[index] ?? "");
    if (opening === null) {
      continue;
    }
    const body: string[] = [];
    let closed = false;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor] ?? "";
      if (isClosingFence(candidate, opening)) {
        if (foundText !== null) {
          return { status: "multiple_fences" };
        }
        foundText = body.join("\n");
        index = cursor;
        closed = true;
        break;
      }
      body.push(candidate);
    }
    if (!closed) {
      return { status: "unterminated_fence" };
    }
  }
  return foundText === null
    ? { status: "missing_fence" }
    : { status: "ok", text: foundText };
}

function extractMarkdownSection(
  text: string,
  heading: string,
): { level: number; content: string } | null {
  const lines = text.split(/\r?\n/);
  let activeFence: MarkdownFence | null = null;
  let startIndex: number | null = null;
  let level = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    activeFence = nextFenceState(activeFence, line);
    if (activeFence !== null) {
      continue;
    }
    const parsedHeading = parseMarkdownHeading(line);
    if (parsedHeading === null) {
      continue;
    }
    if (startIndex === null) {
      if (normalizeHeading(parsedHeading.text) === normalizeHeading(heading)) {
        startIndex = index + 1;
        level = parsedHeading.level;
      }
      continue;
    }
    if (parsedHeading.level <= level) {
      return { level, content: lines.slice(startIndex, index).join("\n") };
    }
  }
  return startIndex === null
    ? null
    : { level, content: lines.slice(startIndex).join("\n") };
}

interface MarkdownFence {
  marker: "`" | "~";
  length: number;
}

function nextFenceState(
  activeFence: MarkdownFence | null,
  line: string,
): MarkdownFence | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (match?.[1] === undefined) {
    return activeFence;
  }
  const marker = match[1][0] as "`" | "~";
  if (activeFence === null) {
    return { marker, length: match[1].length };
  }
  if (activeFence.marker === marker && match[1].length >= activeFence.length) {
    return null;
  }
  return activeFence;
}

function parseMarkdownHeading(
  line: string,
): { level: number; text: string } | null {
  const trimmed = line.trim();
  let level = 0;
  while (level < 6 && trimmed[level] === "#") {
    level += 1;
  }
  if (level === 0 || trimmed[level] === "#" || !isWhitespace(trimmed[level])) {
    return null;
  }
  let contentStart = level;
  while (isWhitespace(trimmed[contentStart])) {
    contentStart += 1;
  }
  let text = trimmed.slice(contentStart).trimEnd();
  if (text === "") {
    return null;
  }
  let closingStart = text.length;
  while (closingStart > 0 && text[closingStart - 1] === "#") {
    closingStart -= 1;
  }
  if (
    closingStart < text.length &&
    closingStart > 0 &&
    /\s/.test(text[closingStart - 1] ?? "")
  ) {
    text = text.slice(0, closingStart).trimEnd();
  }
  return { level, text };
}

function isWhitespace(value: string | undefined): boolean {
  return value !== undefined && /\s/u.test(value);
}

function parseJsonFenceOpening(line: string): MarkdownFence | null {
  const match = /^ {0,3}(`{3,}|~{3,})\s*json\s*$/i.exec(line);
  const fence = match?.[1];
  return fence === undefined
    ? null
    : { marker: fence[0] as "`" | "~", length: fence.length };
}

function isClosingFence(line: string, fence: MarkdownFence): boolean {
  const trimmed = line.trim();
  let count = 0;
  while (trimmed[count] === fence.marker) {
    count += 1;
  }
  return count >= fence.length && trimmed.slice(count).trim() === "";
}

function headingLineMatches(line: string, heading: string): boolean {
  const parsedHeading = parseMarkdownHeading(line);
  return (
    parsedHeading !== null &&
    normalizeHeading(parsedHeading.text) === normalizeHeading(heading)
  );
}

function normalizeHeading(value: string): string {
  const headingText = parseMarkdownHeading(value)?.text ?? value;
  return headingText
    .replaceAll(/[`*_]/g, "")
    .replace(/[:.!?–—-]\s*$/u, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
