const ARTIFACT_SECTION_HEADINGS = [
  "Verdict",
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
  const trimmedArtifact = artifact.replace(/^(?:\s|\uFEFF)+/u, "");
  if (artifactStartsWithVerdict(trimmedArtifact)) {
    return trimmedArtifact;
  }

  const afterTitle = stripSingleLeadingTitleLine(trimmedArtifact);
  if (afterTitle !== null && artifactStartsWithVerdict(afterTitle)) {
    return afterTitle;
  }

  const verdictIndex = findFirstArtifactVerdictIndex(trimmedArtifact);
  if (
    verdictIndex > 0 &&
    isPlainTextArtifactPreamble(trimmedArtifact.slice(0, verdictIndex))
  ) {
    return trimmedArtifact.slice(verdictIndex).replace(/^(?:\s|\uFEFF)+/u, "");
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
  const titleMatch = artifact.match(/^#[ \t]+[^\n]*\n/);
  if (titleMatch === null) {
    return null;
  }
  const titleLine = titleMatch[0];
  if (DIFF_INJECTION_TOKEN_PATTERN.test(titleLine)) {
    return null;
  }
  return artifact.slice(titleLine.length).replace(/^(?:\s|﻿)+/u, "");
}

export function artifactStartsWithVerdict(artifact: string): boolean {
  return (
    /^## Verdict\s*\n\s*(PASS|FINDINGS|FAIL)\b/i.test(artifact) ||
    /^Verdict:\s*(PASS|FINDINGS|FAIL)\b/i.test(artifact)
  );
}

function findFirstArtifactVerdictIndex(artifact: string): number {
  const headingIndex = artifact.search(
    /^## Verdict\s*\n\s*(PASS|FINDINGS|FAIL)\b/im,
  );
  const inlineIndex = artifact.search(/^Verdict:\s*(PASS|FINDINGS|FAIL)\b/im);
  const indexes = [headingIndex, inlineIndex].filter((index) => index >= 0);
  return indexes.length === 0 ? -1 : Math.min(...indexes);
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
  const headingPattern = /^(#{2,3})\s+(.+?)\s*$/gim;
  let match = headingPattern.exec(artifact);
  while (match !== null) {
    const marker = match[1];
    const rawText = match[2];
    if (marker !== undefined && rawText !== undefined) {
      const candidate: ArtifactHeadingMatch = {
        startIndex: match.index,
        endIndex: match.index + match[0].length,
        level: marker.length === 2 ? 2 : 3,
        normalizedText: normalizeArtifactHeadingText(rawText),
      };
      if (predicate(candidate)) {
        return candidate;
      }
    }
    match = headingPattern.exec(artifact);
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
  const marker = line
    .replace(/^[-*+]\s*/, "")
    .replace(/^[_*]+/, "")
    .replace(/[_*]+$/, "")
    .trim();
  return /^None(?:\s+found)?\.?$/i.test(marker);
}
