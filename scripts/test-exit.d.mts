export interface DerivedExit {
  code: number;
  note: string | null;
}

export function deriveExitCode(
  rawStatus: number | null,
  jsonReportText: string | null,
): DerivedExit;
