const ARTIFACT_SECTION_HEADINGS = [
  "Verdict",
  "Findings",
  "P1 Must Fix",
  "P2 Should Fix",
  "Track",
  "Dismissed Or Theoretical",
  "Triage",
  "Reviewer Artifacts",
] as const;

const ARTIFACT_SECTION_HEADING_KEYS = buildArtifactSectionHeadingKeys(
  ARTIFACT_SECTION_HEADINGS,
);
const ARTIFACT_HEADING_LABEL_SEPARATOR_CHARS = [
  ":",
  ".",
  "!",
  "?",
  "-",
  "–",
  "—",
] as const;
const ARTIFACT_HEADING_LABEL_SEPARATOR_SET = new Set<string>(
  ARTIFACT_HEADING_LABEL_SEPARATOR_CHARS,
);
const KNOWN_EXTENSIONLESS_ROOT_FILES = new Set([
  "authors",
  "changelog",
  "changes",
  "codeowners",
  "copying",
  "dockerfile",
  "gemfile",
  "justfile",
  "license",
  "makefile",
  "notice",
  "owners",
  "procfile",
  "rakefile",
  "readme",
  "taskfile",
]);
// SYMPHONY_UNTRUSTED_DIFF matches as a substring (no word boundaries): the
// real boundary token is `SYMPHONY_UNTRUSTED_DIFF_<uuid>` and `\b` fails on
// `_`-suffixed identifiers.
const DIFF_INJECTION_TOKEN_PATTERN =
  /(DIFF_DATA|SYMPHONY_UNTRUSTED_DIFF|diff --git)/;
const MAX_SAFE_ARTIFACT_PREAMBLE_CHARS = 3_000;
const MAX_SAFE_ARTIFACT_PREAMBLE_LINES = 12;
// SYMPH-908: crucible's MOB-348 reviewer-artifact contract is the single binding
// source. The recognized verdict vocabulary is EXACTLY crucible's set
// {PASS, CHANGES_REQUESTED, BLOCKED} — the same tokens crucible's council-triage
// (`production-rollout.mjs council-triage` → `parseReviewerVerdict`) recognizes.
// Symphony conforms to this contract; it does not fork it. The Symphony-only
// legacy tokens `FINDINGS` and `FAIL` were retired here: a verdict token outside
// this set is a `malformed_artifact`. Inbound legacy `FINDINGS` is normalized to
// `CHANGES_REQUESTED` during the deprecation window (see
// `normalizeLegacyFindingsVerdict` in headless-council-gate.ts) BEFORE the artifact
// reaches council-triage, so the spine never downgrades it to partial/fail_open.
export type ArtifactVerdictToken = "PASS" | "CHANGES_REQUESTED" | "BLOCKED";

const ARTIFACT_VERDICT_TOKENS: readonly ArtifactVerdictToken[] = [
  "CHANGES_REQUESTED",
  "PASS",
  "BLOCKED",
];

// SYMPH-908: the single retired legacy token kept solely so the deprecation-window
// normalizer can recognize and rewrite it. It is NOT a member of
// `ArtifactVerdictToken` and never parses as a valid verdict.
export const LEGACY_FINDINGS_VERDICT_TOKEN = "FINDINGS";

export function sectionFindingEntries(section: string): string[] {
  const lines = section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const findings: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (isEmptySectionMarker(line)) {
      continue;
    }
    if (/^[-*+]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) {
      if (current.length > 0) {
        findings.push(current.join(" "));
      }
      current = [stripFindingMarker(line)];
      continue;
    }
    if (current.length === 0) {
      current = [line];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) {
    findings.push(current.join(" "));
  }
  return findings.filter((finding) => finding.trim() !== "");
}

export function passArtifactTriageSectionIsNonBlocking(
  artifact: string,
): boolean {
  return sectionFindingEntries(
    artifactSectionContent(artifact, "Triage"),
  ).every((entry) => {
    const cells = entry
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    const severityCell = cells[0];
    const dispositionCell = cells[1];
    return (
      /^(P1|P2)$/i.test(severityCell ?? "") &&
      /^(track|dismissed|refuted)$/i.test(dispositionCell ?? "")
    );
  });
}

export function artifactSectionHasContent(
  artifact: string,
  heading: string,
): boolean {
  return (
    sectionFindingEntries(artifactSectionContent(artifact, heading)).length > 0
  );
}

export function artifactSectionContent(
  artifact: string,
  heading: string,
): string {
  const sectionMatch = findArtifactSectionHeading(artifact, heading);
  if (sectionMatch === null) {
    return "";
  }

  const sectionStart = sectionMatch.endIndex;
  const sectionTail = artifact.slice(sectionStart);
  const nextHeadingIndex = findNextArtifactSectionBoundary(sectionTail);
  return nextHeadingIndex === -1
    ? sectionTail.trim()
    : sectionTail.slice(0, nextHeadingIndex).trim();
}

export function normalizeArtifactStart(artifact: string): string {
  const trimmedArtifact = artifact.trimStart();
  // SYMPH-908: surface the verdict line for both the contract tokens and the
  // retired legacy `FINDINGS` token, so a preamble-prefixed legacy artifact is
  // normalized to lead with `## Verdict` and the deprecation-window rewrite
  // (`normalizeLegacyFindingsVerdict`) can then run on it.
  if (artifactStartsWithVerdictOrLegacy(trimmedArtifact)) {
    return trimmedArtifact;
  }

  const afterTitle = stripSingleLeadingTitleLine(trimmedArtifact);
  if (afterTitle !== null && artifactStartsWithVerdictOrLegacy(afterTitle)) {
    return afterTitle;
  }

  const verdictIndex = findFirstArtifactVerdictIndex(trimmedArtifact);
  if (
    verdictIndex > 0 &&
    isPlainTextArtifactPreamble(trimmedArtifact.slice(0, verdictIndex))
  ) {
    return trimmedArtifact.slice(verdictIndex).trimStart();
  }

  return trimmedArtifact;
}

export function buildArtifactSectionHeadingKeys(
  headings: readonly string[],
): ReadonlySet<string> {
  const normalizedHeadings = new Map<string, string>();
  for (const heading of headings) {
    const normalizedHeading = normalizeArtifactHeadingText(heading);
    const previousHeading = normalizedHeadings.get(normalizedHeading);
    if (previousHeading !== undefined) {
      throw new Error(
        `Artifact section heading "${heading}" normalizes to "${normalizedHeading}", which is already used by "${previousHeading}". Rename the heading or make the parser collision policy explicit.`,
      );
    }
    normalizedHeadings.set(normalizedHeading, heading);
  }
  return new Set(normalizedHeadings.keys());
}

function stripFindingMarker(line: string): string {
  return line
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();
}

// Safe normalization (SYMPH-298): skip exactly one leading markdown H1 title
// line (e.g. `# Council Review ...`) plus blank lines when the verdict section
// immediately follows. Anything else before the verdict stays subject to the
// diff-injection guard.
function stripSingleLeadingTitleLine(artifact: string): string | null {
  const newlineIndex = artifact.indexOf("\n");
  if (newlineIndex === -1) {
    return null;
  }

  const titleLine = artifact.slice(0, newlineIndex + 1);
  const titleText = trimTrailingCarriageReturn(artifact.slice(0, newlineIndex));
  if (
    !titleText.startsWith("#") ||
    !isHorizontalArtifactWhitespace(titleText.charAt(1))
  ) {
    return null;
  }

  if (DIFF_INJECTION_TOKEN_PATTERN.test(titleLine)) {
    return null;
  }
  return artifact.slice(titleLine.length).trimStart();
}

export function artifactStartsWithVerdict(artifact: string): boolean {
  return artifactStartingVerdictToken(artifact) !== null;
}

export function artifactStartingVerdictToken(
  artifact: string,
): ArtifactVerdictToken | null {
  return artifactVerdictTokenAtLineStart(artifact, 0);
}

/**
 * SYMPH-908 deprecation window: detect a leading legacy `FINDINGS` verdict token.
 *
 * `FINDINGS` was retired from `ArtifactVerdictToken`; crucible's council-triage
 * recognizes only {PASS, CHANGES_REQUESTED, BLOCKED} and downgrades an unrecognized
 * `FINDINGS` token to `parse_quality: partial` → `fail_open: true` (the operator-
 * misleading defect). During the window we recognize the legacy token solely so the
 * consumer can normalize it to `CHANGES_REQUESTED` BEFORE the artifact reaches the
 * spine. Returns the span of the verdict TOKEN (not the heading) so callers can
 * rewrite exactly that token, never an incidental occurrence of the word elsewhere.
 */
export function legacyFindingsVerdictTokenSpan(
  artifact: string,
): { start: number; end: number } | null {
  const span = artifactVerdictTokenSpanAtLineStart(artifact, 0);
  if (span === null) {
    return null;
  }
  const token = artifact.slice(span.start, span.end);
  return equalsIgnoreCase(token, LEGACY_FINDINGS_VERDICT_TOKEN) ? span : null;
}

// SYMPH-908: a leading verdict line carrying a recognized contract token OR the
// retired legacy `FINDINGS` token. Used only by `normalizeArtifactStart` so legacy
// artifacts get their preamble stripped during the deprecation window; the exported
// `artifactStartsWithVerdict` stays recognized-token-only for contract validation.
function artifactStartsWithVerdictOrLegacy(artifact: string): boolean {
  return artifactVerdictTokenSpanAtLineStart(artifact, 0) !== null;
}

function findFirstArtifactVerdictIndex(artifact: string): number {
  let offset = 0;
  while (offset < artifact.length) {
    if (artifactVerdictTokenSpanAtLineStart(artifact, offset) !== null) {
      return offset;
    }
    const nextLineIndex = artifact.indexOf("\n", offset);
    if (nextLineIndex === -1) {
      return -1;
    }
    offset = nextLineIndex + 1;
  }
  return -1;
}

function isPlainTextArtifactPreamble(preamble: string): boolean {
  const trimmed = preamble.replace(/^(?:\s|\uFEFF)+/u, "").trim();
  if (trimmed === "") {
    return true;
  }
  if (trimmed.length > MAX_SAFE_ARTIFACT_PREAMBLE_CHARS) {
    return false;
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length > MAX_SAFE_ARTIFACT_PREAMBLE_LINES) {
    return false;
  }

  return lines.every(isSafeArtifactPreambleLine);
}

function isSafeArtifactPreambleLine(line: string): boolean {
  if (DIFF_INJECTION_TOKEN_PATTERN.test(line)) {
    return false;
  }

  const proseLine = stripArtifactPreambleListPrefix(line);
  if (/^(#{1,6}\s|`{3,}|~{3,}|>\s|\|)/.test(proseLine)) {
    return false;
  }

  return !isArtifactPreambleSectionHeadingLine(proseLine);
}

function stripArtifactPreambleListPrefix(line: string): string {
  let strippedLine = line;
  let previousLine: string;
  do {
    previousLine = strippedLine;
    strippedLine = strippedLine
      .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "")
      .replace(/^\[[ xX]\]\s*/, "");
  } while (strippedLine !== previousLine);
  return strippedLine;
}

interface ArtifactHeadingMatch {
  startIndex: number;
  endIndex: number;
  level: 2 | 3;
  normalizedText: string;
}

function findArtifactSectionHeading(
  artifact: string,
  heading: string,
): ArtifactHeadingMatch | null {
  const target = normalizeArtifactHeadingText(heading);
  return findMarkdownHeading(
    artifact,
    (candidate) => candidate.normalizedText === target,
  );
}

function findNextArtifactSectionBoundary(sectionTail: string): number {
  const boundary = findMarkdownHeading(sectionTail, isArtifactSectionBoundary);
  return boundary?.startIndex ?? -1;
}

function findMarkdownHeading(
  artifact: string,
  predicate: (candidate: ArtifactHeadingMatch) => boolean,
): ArtifactHeadingMatch | null {
  let offset = 0;
  while (offset <= artifact.length) {
    const lineEnd = findArtifactLineEnd(artifact, offset);
    const candidate = artifactMarkdownHeadingAtLine(artifact, offset, lineEnd);
    if (candidate !== null && predicate(candidate)) {
      return candidate;
    }
    if (lineEnd >= artifact.length) {
      break;
    }
    offset = lineEnd + 1;
  }
  return null;
}

function isArtifactSectionBoundary(candidate: ArtifactHeadingMatch): boolean {
  return (
    candidate.level === 2 ||
    ARTIFACT_SECTION_HEADING_KEYS.has(candidate.normalizedText)
  );
}

// Markdown headings use strict normalization: `:` may stand in for a space and
// whitespace runs collapse, but the broader preamble label separators below are
// only for fail-closed inline label detection before the first real `## Verdict`
// section.
function normalizeArtifactHeadingText(heading: string): string {
  return heading.replace(/:/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeArtifactPreambleLabelText(line: string): string {
  return normalizeArtifactHeadingText(
    stripArtifactPreambleLabelDecorators(line)
      .replace(/[.!?]+$/g, "")
      .trim(),
  );
}

function isArtifactPreambleSectionHeadingLine(line: string): boolean {
  const normalizedLine = normalizeArtifactPreambleLabelText(line);
  if (ARTIFACT_SECTION_HEADING_KEYS.has(normalizedLine)) {
    return true;
  }

  const labelLine = stripArtifactPreambleLabelDecorators(line).trim();
  return ARTIFACT_SECTION_HEADINGS.some((heading) =>
    artifactPreambleLineStartsWithHeadingLabel(labelLine, heading),
  );
}

function stripArtifactPreambleLabelDecorators(line: string): string {
  return line.replace(/[*_`~]/g, "");
}

function artifactPreambleLineStartsWithHeadingLabel(
  line: string,
  heading: string,
): boolean {
  const lowerLine = line.toLowerCase();
  const headingWords = heading.toLowerCase().trim().split(/\s+/);
  let offset = 0;

  for (const word of headingWords) {
    offset = skipArtifactHeadingWordSeparator(lowerLine, offset);
    if (!lowerLine.startsWith(word, offset)) {
      return false;
    }
    offset += word.length;
  }

  const suffix = line.slice(offset);
  return (
    suffix.trim() === "" ||
    artifactHeadingLabelSuffixStartsWithSeparator(suffix, headingWords.length)
  );
}

function artifactHeadingLabelSuffixStartsWithSeparator(
  suffix: string,
  headingWordCount: number,
): boolean {
  const leadingWhitespace = /^\s*/.exec(suffix)?.[0] ?? "";
  const separatorIndex = leadingWhitespace.length;
  const separator = suffix.charAt(separatorIndex);
  if (!isArtifactHeadingLabelSeparatorChar(separator)) {
    return false;
  }

  if (headingWordCount !== 1 || !isArtifactHeadingDashSeparator(separator)) {
    return true;
  }

  if (leadingWhitespace !== "") {
    return true;
  }

  const rest = suffix.slice(separatorIndex + separator.length);
  return (
    rest === "" || /^\s/.test(rest) || isCompactArtifactFindingPathSuffix(rest)
  );
}

function isCompactArtifactFindingPathSuffix(suffix: string): boolean {
  const candidate = suffix.trimStart();
  if (/^\/(?:[a-z0-9_.-]+[\\/])+(?=\s|$)/i.test(candidate)) {
    return true;
  }

  if (
    /^\/(?:[a-z0-9_.-]+[\\/])*[a-z0-9_.-]*\.[a-z0-9][a-z0-9_.-]*(?::\d+(?:\D|$)|(?=\s|$))/i.test(
      candidate,
    )
  ) {
    return true;
  }

  const absoluteRootLineReference =
    /^\/(?:[a-z0-9_.-]+[\\/])*([a-z0-9_.-]+):\d+(?:\D|$)/i.exec(candidate);
  if (
    absoluteRootLineReference?.[1] !== undefined &&
    (isFileNameWithExtension(absoluteRootLineReference[1]) ||
      isLikelyExtensionlessRootFile(absoluteRootLineReference[1]))
  ) {
    return true;
  }

  if (/^(?:\.{1,2}[\\/]|[a-z]:[\\/])/i.test(candidate)) {
    return true;
  }

  if (
    /^(?:[a-z0-9_.-]+[\\/])+(?:[a-z0-9_.-]*\.[a-z0-9][a-z0-9_.-]*(?::\d+(?:\D|$)|(?=\s|$))|[a-z0-9_.-]+:\d+(?:\D|$))/i.test(
      candidate,
    )
  ) {
    return true;
  }

  const rootLineReference = /^([a-z0-9_.-]+):\d+(?:\D|$)/i.exec(candidate);
  if (rootLineReference === null || rootLineReference[1] === undefined) {
    return false;
  }

  return (
    isFileNameWithExtension(rootLineReference[1]) ||
    isLikelyExtensionlessRootFile(rootLineReference[1])
  );
}

function isFileNameWithExtension(filename: string): boolean {
  return /^[a-z0-9_.-]*\.[a-z0-9][a-z0-9_.-]*$/i.test(filename);
}

function isLikelyExtensionlessRootFile(filename: string): boolean {
  return (
    isKnownExtensionlessRootFile(filename) ||
    isUppercaseRootFileName(filename) ||
    isCapitalizedFileStyleName(filename)
  );
}

function isKnownExtensionlessRootFile(filename: string): boolean {
  return KNOWN_EXTENSIONLESS_ROOT_FILES.has(filename.toLowerCase());
}

function isUppercaseRootFileName(filename: string): boolean {
  return /^[A-Z][A-Z0-9_-]*$/.test(filename);
}

function isCapitalizedFileStyleName(filename: string): boolean {
  return /^[A-Z][A-Za-z0-9_-]*file$/.test(filename);
}

function skipArtifactHeadingWordSeparator(
  value: string,
  offset: number,
): number {
  let index = offset;
  while (index < value.length) {
    const char = value.charAt(index);
    if (!isArtifactHeadingLabelSeparator(char)) {
      break;
    }
    index += 1;
  }
  return index;
}

function isArtifactHeadingDashSeparator(char: string): boolean {
  return char === "-" || char === "–" || char === "—";
}

function isArtifactHeadingLabelSeparator(char: string): boolean {
  return isArtifactHeadingLabelSeparatorChar(char) || /\s/.test(char);
}

function isArtifactHeadingLabelSeparatorChar(char: string): boolean {
  return char.length > 0 && ARTIFACT_HEADING_LABEL_SEPARATOR_SET.has(char);
}

function isEmptySectionMarker(line: string): boolean {
  const marker = trimTrailingEmphasisMarkers(
    trimLeadingEmphasisMarkers(stripLeadingListMarker(line)),
  ).trim();
  return isNoneSectionMarker(marker);
}

function artifactVerdictTokenAtLineStart(
  artifact: string,
  offset: number,
): ArtifactVerdictToken | null {
  const span = artifactVerdictTokenSpanAtLineStart(artifact, offset);
  if (span === null) {
    return null;
  }
  return recognizedVerdictToken(artifact.slice(span.start, span.end));
}

// SYMPH-908: locate the verdict-token span at the start of a verdict line,
// recognizing both the current contract tokens and the retired legacy `FINDINGS`
// token (so the deprecation-window normalizer can rewrite it). Returns the token's
// absolute [start, end) offsets in `artifact`, or null when the line at `offset` is
// not a verdict line carrying a known/legacy token.
function artifactVerdictTokenSpanAtLineStart(
  artifact: string,
  offset: number,
): { start: number; end: number } | null {
  const lineEnd = findArtifactLineEnd(artifact, offset);
  const line = trimTrailingCarriageReturn(
    artifact.slice(offset, lineEnd),
  ).trimEnd();
  const heading = artifactMarkdownHeadingAtLine(artifact, offset, lineEnd);
  if (
    heading !== null &&
    heading.normalizedText === normalizeArtifactHeadingText("Verdict")
  ) {
    return artifactVerdictTokenSpanAfterHeadingLine(artifact, lineEnd);
  }

  if (!startsWithIgnoreCase(line, "Verdict:")) {
    return null;
  }

  const labelOffset = offset + "Verdict:".length;
  return artifactVerdictTokenSpanInLine(artifact, labelOffset, lineEnd);
}

function artifactVerdictTokenSpanAfterHeadingLine(
  artifact: string,
  headingLineEnd: number,
): { start: number; end: number } | null {
  let offset = headingLineEnd;
  if (artifact.charAt(offset) === "\n") {
    offset += 1;
  }
  while (
    offset < artifact.length &&
    isArtifactWhitespace(artifact.charAt(offset))
  ) {
    offset += 1;
  }
  if (offset >= artifact.length) {
    return null;
  }
  const tokenLineEnd = findArtifactLineEnd(artifact, offset);
  return artifactVerdictTokenSpanInLine(artifact, offset, tokenLineEnd);
}

function artifactVerdictTokenSpanInLine(
  artifact: string,
  lineStart: number,
  lineEnd: number,
): { start: number; end: number } | null {
  let tokenStart = lineStart;
  while (
    tokenStart < lineEnd &&
    isHorizontalArtifactWhitespace(artifact.charAt(tokenStart))
  ) {
    tokenStart += 1;
  }
  const lineText = trimTrailingCarriageReturn(
    artifact.slice(tokenStart, lineEnd),
  );
  const token = matchLeadingVerdictTokenText(lineText);
  if (token === null) {
    return null;
  }
  return { start: tokenStart, end: tokenStart + token.length };
}

function recognizedVerdictToken(token: string): ArtifactVerdictToken | null {
  for (const candidate of ARTIFACT_VERDICT_TOKENS) {
    if (equalsIgnoreCase(token, candidate)) {
      return candidate;
    }
  }
  return null;
}

// Returns the literal leading token text (preserving the matched token's canonical
// length) when `line` starts with a recognized contract token OR the retired legacy
// `FINDINGS` token at a word boundary; null otherwise.
function matchLeadingVerdictTokenText(line: string): string | null {
  const trimmedLine = line.trimStart();
  const candidates: readonly string[] = [
    ...ARTIFACT_VERDICT_TOKENS,
    LEGACY_FINDINGS_VERDICT_TOKEN,
  ];
  for (const token of candidates) {
    if (
      startsWithIgnoreCase(trimmedLine, token) &&
      isVerdictTokenBoundary(trimmedLine.charAt(token.length))
    ) {
      return trimmedLine.slice(0, token.length);
    }
  }
  return null;
}

function isVerdictTokenBoundary(char: string): boolean {
  return char === "" || !isAsciiWordChar(char);
}

function isAsciiWordChar(char: string): boolean {
  if (char.length !== 1) {
    return false;
  }
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    code === 95 ||
    (code >= 97 && code <= 122)
  );
}

function artifactMarkdownHeadingAtLine(
  artifact: string,
  lineStart: number,
  lineEnd: number,
): ArtifactHeadingMatch | null {
  const line = trimTrailingCarriageReturn(artifact.slice(lineStart, lineEnd));
  const markerLength = markdownHeadingMarkerLength(line);
  if (markerLength !== 2 && markerLength !== 3) {
    return null;
  }
  if (!isArtifactWhitespace(line.charAt(markerLength))) {
    return null;
  }

  const rawText = line.slice(markerLength + 1).trim();
  if (rawText === "") {
    return null;
  }

  return {
    startIndex: lineStart,
    endIndex: lineEnd,
    level: markerLength === 2 ? 2 : 3,
    normalizedText: normalizeArtifactHeadingText(rawText),
  };
}

function markdownHeadingMarkerLength(line: string): number {
  let markerLength = 0;
  while (markerLength < line.length && line.charAt(markerLength) === "#") {
    markerLength += 1;
  }
  return markerLength;
}

function stripLeadingListMarker(line: string): string {
  const marker = line.charAt(0);
  if (marker !== "-" && marker !== "*" && marker !== "+") {
    return line;
  }
  return line.slice(1).trimStart();
}

function trimLeadingEmphasisMarkers(line: string): string {
  let offset = 0;
  while (offset < line.length) {
    const char = line.charAt(offset);
    if (char !== "_" && char !== "*") {
      break;
    }
    offset += 1;
  }
  return line.slice(offset);
}

function trimTrailingEmphasisMarkers(line: string): string {
  let end = line.length;
  while (end > 0) {
    const char = line.charAt(end - 1);
    if (char !== "_" && char !== "*") {
      break;
    }
    end -= 1;
  }
  return line.slice(0, end);
}

function isNoneSectionMarker(marker: string): boolean {
  const normalizedMarker = collapseArtifactWhitespace(marker).toLowerCase();
  const withoutFinalPeriod = normalizedMarker.endsWith(".")
    ? normalizedMarker.slice(0, -1)
    : normalizedMarker;
  return withoutFinalPeriod === "none" || withoutFinalPeriod === "none found";
}

function collapseArtifactWhitespace(value: string): string {
  let result = "";
  let inWhitespace = false;
  for (const char of value) {
    if (isArtifactWhitespace(char)) {
      if (!inWhitespace) {
        result += " ";
      }
      inWhitespace = true;
      continue;
    }
    result += char;
    inWhitespace = false;
  }
  return result.trim();
}

function findArtifactLineEnd(value: string, offset: number): number {
  const newlineIndex = value.indexOf("\n", offset);
  return newlineIndex === -1 ? value.length : newlineIndex;
}

function trimTrailingCarriageReturn(value: string): string {
  return value.endsWith("\r") ? value.slice(0, -1) : value;
}

function isHorizontalArtifactWhitespace(char: string): boolean {
  return char === " " || char === "\t";
}

function isArtifactWhitespace(char: string): boolean {
  return char.length > 0 && char.trim() === "";
}

function startsWithIgnoreCase(value: string, prefix: string): boolean {
  return value.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

function equalsIgnoreCase(left: string, right: string): boolean {
  return left.length === right.length && startsWithIgnoreCase(left, right);
}
