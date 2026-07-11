const STRUCTURAL_ADVISORY_LIFECYCLE_STATES = [
  "active",
  "dormant",
  "withdrawn",
  "graded",
] as const;

type StructuralAdvisoryLifecycleState =
  (typeof STRUCTURAL_ADVISORY_LIFECYCLE_STATES)[number];

export interface StructuralAdvisory {
  memberIssueIdentifiers: string[];
  rootCauseHypothesis: string;
  structuralFix: string;
  confidenceNote: string;
  /** Optional model-proposed existing root. Retained only when Linear resolves it. */
  rootIssueIdentifier?: string | null | undefined;
  /** Unresolved proposed identifier, rendered as free text rather than a link target. */
  proposedRootIssueIdentifier?: string | null | undefined;
  memberSetHash?: string;
  advisoryFingerprint?: string;
  lifecycleState?: StructuralAdvisoryLifecycleState;
  absentOkTicks?: number;
  conflictIssueIdentifiers?: string[];
  rendered?: boolean;
  /** Exact rejected member set revived because at least one member changed. */
  previouslyRejectedWithNewEvidence?: boolean;
}

export function isStructuralAdvisories(
  value: unknown,
): value is StructuralAdvisory[] {
  return Array.isArray(value) && value.every(isStructuralAdvisory);
}

function isStructuralAdvisory(value: unknown): value is StructuralAdvisory {
  const advisory = value as StructuralAdvisory;
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as StructuralAdvisory).memberIssueIdentifiers) &&
    (value as StructuralAdvisory).memberIssueIdentifiers.length > 0 &&
    (value as StructuralAdvisory).memberIssueIdentifiers.every(
      (identifier) =>
        typeof identifier === "string" && identifier.trim().length > 0,
    ) &&
    typeof (value as StructuralAdvisory).rootCauseHypothesis === "string" &&
    (value as StructuralAdvisory).rootCauseHypothesis.trim().length > 0 &&
    typeof (value as StructuralAdvisory).structuralFix === "string" &&
    (value as StructuralAdvisory).structuralFix.trim().length > 0 &&
    typeof (value as StructuralAdvisory).confidenceNote === "string" &&
    (value as StructuralAdvisory).confidenceNote.trim().length > 0 &&
    isOptionalString((value as StructuralAdvisory).rootIssueIdentifier) &&
    isOptionalString(
      (value as StructuralAdvisory).proposedRootIssueIdentifier,
    ) &&
    isOptionalString((value as StructuralAdvisory).memberSetHash) &&
    isOptionalString((value as StructuralAdvisory).advisoryFingerprint) &&
    ((value as StructuralAdvisory).lifecycleState === undefined ||
      (typeof advisory.lifecycleState === "string" &&
        STRUCTURAL_ADVISORY_LIFECYCLE_STATES.includes(
          advisory.lifecycleState,
        ))) &&
    ((value as StructuralAdvisory).absentOkTicks === undefined ||
      (typeof advisory.absentOkTicks === "number" &&
        Number.isInteger(advisory.absentOkTicks) &&
        advisory.absentOkTicks >= 0)) &&
    ((value as StructuralAdvisory).conflictIssueIdentifiers === undefined ||
      (Array.isArray(advisory.conflictIssueIdentifiers) &&
        advisory.conflictIssueIdentifiers.every(
          (identifier) => typeof identifier === "string",
        ))) &&
    ((value as StructuralAdvisory).rendered === undefined ||
      typeof (value as StructuralAdvisory).rendered === "boolean") &&
    (advisory.previouslyRejectedWithNewEvidence === undefined ||
      typeof advisory.previouslyRejectedWithNewEvidence === "boolean")
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}
