const JUDGE_BOUNDARY_TAG_REGEX =
  /<\s*\/?\s*(?:(?:worker|ticket)(?:[_-][a-z0-9_-]*)?|diff[a-z0-9_-]*)(?:\s+[^<>]*)?\s*\/?\s*>/gi;

export function fenceJudgeBoundaryTags(text: string): string {
  return text.replace(JUDGE_BOUNDARY_TAG_REGEX, "");
}
