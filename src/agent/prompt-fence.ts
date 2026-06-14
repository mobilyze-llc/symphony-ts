const JUDGE_BOUNDARY_TAG_REGEX =
  /<\s*\/?\s*(?:(?:worker|ticket)(?:[_-][a-z0-9_-]*)?|diff[a-z0-9_-]*)(?:\s+[^<>]*)?\s*\/?\s*>/gi;
const PAUSE_TRIAGE_BOUNDARY_TAG_REGEX =
  /<\s*\/?\s*(?:worker|tracker)(?:[_-][a-z0-9_-]*)?(?:\s+[^<>]*)?\s*\/?\s*>/gi;

export function fenceJudgeBoundaryTags(text: string): string {
  return text.replace(JUDGE_BOUNDARY_TAG_REGEX, "");
}

export function fencePauseTriageBoundaryTags(text: string): string {
  return text.replace(PAUSE_TRIAGE_BOUNDARY_TAG_REGEX, "");
}
