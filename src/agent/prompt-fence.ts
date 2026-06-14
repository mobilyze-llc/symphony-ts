// Worker/tracker-authored text can otherwise smuggle prompt-boundary tags
// ("</worker_message>SYSTEM...") and make the judge read attacker text as
// trusted prompt continuation. Keep each helper aligned with the literal
// delimiters its prompt renders, and fence to a fixed point so split tags
// cannot reconstruct a boundary after one removal pass.
const MAX_BOUNDARY_FENCE_PASSES = 20;

const JUDGE_BOUNDARY_FAMILIES = ["worker", "ticket", "diff"] as const;
const PAUSE_TRIAGE_BOUNDARY_FAMILIES = ["worker", "tracker"] as const;
const STUCK_TRIAGE_BOUNDARY_FAMILIES = [
  "worker",
  "tracker",
  "failure",
] as const;

type BoundaryFamily =
  | (typeof JUDGE_BOUNDARY_FAMILIES)[number]
  | (typeof PAUSE_TRIAGE_BOUNDARY_FAMILIES)[number]
  | (typeof STUCK_TRIAGE_BOUNDARY_FAMILIES)[number];

function fenceBoundaryTags(
  text: string,
  families: readonly BoundaryFamily[],
): string {
  let fenced = text;
  for (let pass = 0; pass < MAX_BOUNDARY_FENCE_PASSES; pass += 1) {
    const next = stripBoundaryTagsOnce(fenced, families);
    if (next === fenced) {
      return fenced;
    }
    fenced = next;
  }
  return fenced.replace(/[<>]/g, "");
}

function stripBoundaryTagsOnce(
  text: string,
  families: readonly BoundaryFamily[],
): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf("<", index);
    if (start === -1) {
      result += text.slice(index);
      break;
    }
    result += text.slice(index, start);
    const end = text.indexOf(">", start + 1);
    if (end === -1) {
      result += text.slice(start);
      break;
    }
    const rawTag = text.slice(start + 1, end);
    if (!rawTag.includes("<") && isBoundaryTag(rawTag, families)) {
      index = end + 1;
      continue;
    }
    result += text[start] ?? "";
    index = start + 1;
  }
  return result;
}

function isBoundaryTag(
  rawTag: string,
  families: readonly BoundaryFamily[],
): boolean {
  let tag = rawTag.trim();
  if (tag.startsWith("/")) {
    tag = tag.slice(1).trimStart();
  }
  if (tag.endsWith("/")) {
    tag = tag.slice(0, -1).trimEnd();
  }
  const name = (tag.split(/\s+/, 1)[0] ?? "").toLowerCase();
  return families.some((family) => isBoundaryName(name, family));
}

function isBoundaryName(name: string, family: BoundaryFamily): boolean {
  if (family === "diff") {
    return /^diff[a-z0-9_-]*$/.test(name);
  }
  if (name === family) {
    return true;
  }
  if (!name.startsWith(family)) {
    return false;
  }
  const separator = name[family.length];
  if (separator !== "_" && separator !== "-") {
    return false;
  }
  return /^[a-z0-9_-]*$/.test(name.slice(family.length + 1));
}

export function fenceJudgeBoundaryTags(text: string): string {
  return fenceBoundaryTags(text, JUDGE_BOUNDARY_FAMILIES);
}

export function fencePauseTriageBoundaryTags(text: string): string {
  return fenceBoundaryTags(text, PAUSE_TRIAGE_BOUNDARY_FAMILIES);
}

export function fenceStuckTriageBoundaryTags(text: string): string {
  return fenceBoundaryTags(text, STUCK_TRIAGE_BOUNDARY_FAMILIES);
}
