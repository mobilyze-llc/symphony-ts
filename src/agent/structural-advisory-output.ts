import { z } from "zod";

import type { StructuralAdvisory } from "../domain/structural-advisory.js";
import { sanitizeForLinear } from "../shared/egress.js";

const STRUCTURAL_ADVISORY_SCHEMA = z.object({
  memberIssueIdentifiers: z.array(z.string()).min(1),
  rootCauseHypothesis: z.string(),
  structuralFix: z.string(),
  confidenceNote: z.string(),
  rootIssueIdentifier: z.string().nullable().optional(),
});

export const STRUCTURAL_ADVISORIES_SCHEMA = z.array(STRUCTURAL_ADVISORY_SCHEMA);

export function parseStructuralAdvisories(
  values: readonly unknown[],
): StructuralAdvisory[] {
  return values.flatMap((value) => {
    const parsed = STRUCTURAL_ADVISORY_SCHEMA.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

export const STRUCTURAL_ADVISORY_PROMPT_JSON_LINES = [
  '  "structural_advisories": [',
  "    {",
  '      "memberIssueIdentifiers": ["SYMPH-1", "SYMPH-2"],',
  '      "rootCauseHypothesis": "suspected shared root cause",',
  '      "structuralFix": "structural fix that would supersede the members",',
  '      "confidenceNote": "confidence and evidence limits",',
  '      "rootIssueIdentifier": "SYMPH-123 or null"',
  "    }",
  "  ]",
] as const;

export const STRUCTURAL_ADVISORY_PROMPT_INSTRUCTION_LINES = [
  "- In `structural_advisories`, scan candidates for symptom clusters that may share one root cause. Name the member issue identifiers, suspected root cause, structural fix that would supersede the members, and a confidence note.",
  "- Structural advisories are non-binding and report-only. They never authorize dispatch, mutation, cancellation, or dependency changes. Use an empty array when no supported cluster exists.",
  "- Prefer non-overlapping member partitions. When naming an existing Linear root, set `rootIssueIdentifier`; otherwise leave it null and describe the proposed new root in `rootCauseHypothesis`.",
] as const;

const MEMBER_IDENTIFIER_LIMIT = 100;
const ROOT_HYPOTHESIS_LIMIT = 500;
const STRUCTURAL_FIX_LIMIT = 1_000;
const CONFIDENCE_NOTE_LIMIT = 500;
const OPTION_MARKER = /(?<![\w-])\[?opt-\d+(?::r\d+)?\]?(?![\w-])/gi;

export function normalizeStructuralAdvisories(
  advisories: readonly StructuralAdvisory[] | undefined,
): StructuralAdvisory[] {
  return (advisories ?? [])
    .map((advisory) => ({
      ...advisory,
      memberIssueIdentifiers: advisory.memberIssueIdentifiers
        .map((identifier) => normalizeText(identifier, MEMBER_IDENTIFIER_LIMIT))
        .filter((identifier) => identifier.length > 0),
      rootCauseHypothesis: normalizeText(
        advisory.rootCauseHypothesis,
        ROOT_HYPOTHESIS_LIMIT,
      ),
      structuralFix: normalizeText(
        advisory.structuralFix,
        STRUCTURAL_FIX_LIMIT,
      ),
      confidenceNote: normalizeText(
        advisory.confidenceNote,
        CONFIDENCE_NOTE_LIMIT,
      ),
      rootIssueIdentifier:
        advisory.rootIssueIdentifier == null
          ? null
          : normalizeText(
              advisory.rootIssueIdentifier,
              MEMBER_IDENTIFIER_LIMIT,
            ),
    }))
    .filter(
      (advisory) =>
        advisory.memberIssueIdentifiers.length > 0 &&
        advisory.rootCauseHypothesis.length > 0 &&
        advisory.structuralFix.length > 0 &&
        advisory.confidenceNote.length > 0,
    );
}

export function renderStructuralAdvisoryDetails(
  advisories: readonly StructuralAdvisory[] | undefined,
): string[] {
  const lines: string[] = [];
  const rendered = normalizeStructuralAdvisories(advisories).filter(
    (advisory) => advisory.rendered !== false,
  );
  for (const [index, advisory] of rendered.entries()) {
    lines.push(`### Advisory ${index + 1}`);
    lines.push(`- Members: ${advisory.memberIssueIdentifiers.join(", ")}`);
    lines.push(`- Root hypothesis: ${advisory.rootCauseHypothesis}`);
    lines.push(`- Structural fix: ${advisory.structuralFix}`);
    lines.push(`- Confidence: ${advisory.confidenceNote}`);
    if (advisory.rootIssueIdentifier) {
      lines.push(`- Existing root: ${advisory.rootIssueIdentifier}`);
    } else if (advisory.proposedRootIssueIdentifier) {
      lines.push(
        `- Proposed new root (unresolved identifier): ${advisory.proposedRootIssueIdentifier}`,
      );
    }
    if (advisory.lifecycleState !== undefined) {
      lines.push(`- Lifecycle: ${advisory.lifecycleState}`);
    }
    if ((advisory.conflictIssueIdentifiers?.length ?? 0) > 0) {
      lines.push(
        `- Conflict: hygiene kill annotation on ${advisory.conflictIssueIdentifiers?.join(", ")}`,
      );
    }
  }
  return lines;
}

function normalizeText(value: string, limit: number): string {
  const neutralized = value.replace(
    OPTION_MARKER,
    "[option marker neutralized]",
  );
  const sanitized = sanitizeForLinear(neutralized, { maxLen: limit });
  const singleLine = sanitized.replace(/\s+/g, " ").trim();
  return singleLine.length > limit ? singleLine.slice(0, limit) : singleLine;
}
