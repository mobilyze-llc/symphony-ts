import type { CuratedPlannerComment } from "../agent/planner-comment-curation.js";
import type { CodeGroundingClaim } from "./code-grounding.js";
import {
  extractGroundingEvidenceCandidates,
  extractGroundingPathHints,
} from "./code-grounding.js";

export interface GroundingClaimSource {
  id: string;
  label: string;
  text: string | null | undefined;
}

export interface PlannerGroundingCandidate {
  id: string;
  identifier?: string | null;
  title: string;
  body?: string | null;
  description?: string | null;
  comments?: readonly CuratedPlannerComment[];
  citations?: readonly string[];
}

export interface GroundingClaimMapping {
  findingId: string;
  candidateId: string;
  candidateIdentifier: string | null;
}

export interface BuildGroundingClaimsResult {
  claims: CodeGroundingClaim[];
  mappings: GroundingClaimMapping[];
}

export function buildGroundingClaimsForPlannerCandidate(
  candidate: PlannerGroundingCandidate,
): BuildGroundingClaimsResult {
  const sources: GroundingClaimSource[] = [
    { id: "title", label: "title", text: candidate.title },
    {
      id: "body",
      label: "body",
      text: candidate.body ?? candidate.description ?? null,
    },
    ...(candidate.comments ?? []).map((comment) => ({
      id: `comment:${comment.id}`,
      label: `comment ${comment.id}`,
      text: comment.body,
    })),
    ...(candidate.citations ?? []).map((citation, index) => ({
      id: `citation:${index}`,
      label: `citation ${index + 1}`,
      text: citation,
    })),
  ];
  return buildGroundingClaimsForSources({
    findingId: synthesizePlannerFindingId(candidate),
    candidateId: candidate.id,
    candidateIdentifier: candidate.identifier ?? null,
    summary: `Planner grounding claims for ${candidate.identifier ?? candidate.id}: ${candidate.title}`,
    sources,
  });
}

export function buildGroundingClaimsForSources(input: {
  findingId: string;
  candidateId: string;
  candidateIdentifier?: string | null;
  summary: string;
  sources: readonly GroundingClaimSource[];
}): BuildGroundingClaimsResult {
  const sourceTexts = input.sources
    .map((source) => ({
      ...source,
      text: normalizeSourceText(source.text),
    }))
    .filter((source) => source.text !== "");
  const combinedText = sourceTexts.map((source) => source.text).join("\n");
  const explicitClaims = extractExplicitClaims(combinedText);
  if (explicitClaims.length === 0) {
    return { claims: [], mappings: [] };
  }

  const evidence = [
    "Claim sources:",
    ...sourceTexts.flatMap((source) => [`[${source.label}]`, source.text, ""]),
    "Extracted explicit claims:",
    ...explicitClaims.map((claim) => `- \`${claim}\``),
  ].join("\n");

  return {
    claims: [
      {
        findingId: input.findingId,
        type: "other",
        issueIdentifiers:
          input.candidateIdentifier === null ||
          input.candidateIdentifier === undefined
            ? [input.candidateId]
            : [input.candidateIdentifier],
        summary: input.summary,
        evidence,
        confidence: "medium",
      },
    ],
    mappings: [
      {
        findingId: input.findingId,
        candidateId: input.candidateId,
        candidateIdentifier: input.candidateIdentifier ?? null,
      },
    ],
  };
}

export function extractExplicitGroundingClaims(
  text: string | null | undefined,
): string[] {
  return extractExplicitClaims(normalizeSourceText(text));
}

function extractExplicitClaims(text: string): string[] {
  const claims: string[] = [];
  const seen = new Set<string>();
  const add = (claim: string): void => {
    if (seen.has(claim)) {
      return;
    }
    seen.add(claim);
    claims.push(claim);
  };
  for (const path of extractGroundingPathHints(text, { maxHints: 100 })) {
    add(path);
  }
  const candidates = extractGroundingEvidenceCandidates(text);
  for (const path of candidates.paths) {
    add(path.raw);
  }
  for (const symbol of candidates.symbols) {
    add(symbol);
  }
  return claims;
}

function normalizeSourceText(text: string | null | undefined): string {
  return (text ?? "").trim();
}

function synthesizePlannerFindingId(
  candidate: Pick<PlannerGroundingCandidate, "id" | "identifier">,
): string {
  return `planner:${sanitizeFindingId(candidate.identifier ?? candidate.id)}`;
}

function sanitizeFindingId(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9_.:-]+/g, "-");
  return normalized === "" ? "candidate" : normalized.slice(0, 72);
}
