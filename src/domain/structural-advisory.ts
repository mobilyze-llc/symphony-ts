export interface StructuralAdvisory {
  memberIssueIdentifiers: string[];
  rootCauseHypothesis: string;
  structuralFix: string;
  confidenceNote: string;
}

export function isStructuralAdvisories(
  value: unknown,
): value is StructuralAdvisory[] {
  return Array.isArray(value) && value.every(isStructuralAdvisory);
}

function isStructuralAdvisory(value: unknown): value is StructuralAdvisory {
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
    (value as StructuralAdvisory).confidenceNote.trim().length > 0
  );
}
