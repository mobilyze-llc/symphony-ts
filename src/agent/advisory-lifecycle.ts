import { createHash } from "node:crypto";

import type { StructuralAdvisory } from "../domain/structural-advisory.js";

const ROOT_SLUG_LIMIT = 120;

export interface AdvisoryLifecycleConfig {
  dormantOkTicks: number;
  renderCap: number;
}

interface AdvisoryLifecycleEvent {
  kind: "emitted" | "invalid_members" | "transition" | "conflict" | "truncated";
  memberSetHash?: string;
  advisoryFingerprint?: string;
  from?: string;
  to?: string;
  memberCount?: number;
  invalidMemberCount?: number;
  conflictIssueIdentifiers?: string[];
  emittedCount?: number;
  renderedCount?: number;
}

export interface ApplyAdvisoryLifecycleInput {
  emitted: readonly StructuralAdvisory[];
  previous: readonly StructuralAdvisory[];
  presentedIssueIdentifiers: ReadonlySet<string>;
  terminalIssueIdentifiers?: ReadonlySet<string>;
  conflictIssueIdentifiers?: ReadonlySet<string>;
  config: AdvisoryLifecycleConfig;
  resolveRootIssueIdentifier?: (identifier: string) => Promise<boolean>;
  /** False means the advisory-input scan was unavailable, so absence is no-signal. */
  scanComplete?: boolean;
}

export interface ApplyAdvisoryLifecycleResult {
  advisories: StructuralAdvisory[];
  events: AdvisoryLifecycleEvent[];
}

export function structuralAdvisoryMemberSetHash(
  identifiers: readonly string[],
): string {
  return hash(
    [...new Set(identifiers.map((identifier) => identifier.trim()))]
      .filter(Boolean)
      .sort()
      .join("\n"),
  );
}

export function structuralAdvisoryFingerprint(
  memberSetHash: string,
  rootCauseHypothesis: string,
): string {
  return hash(`${memberSetHash}\n${normalizeRootSlug(rootCauseHypothesis)}`);
}

export async function applyAdvisoryLifecycle(
  input: ApplyAdvisoryLifecycleInput,
): Promise<ApplyAdvisoryLifecycleResult> {
  const events: AdvisoryLifecycleEvent[] = [];
  const previousByMembers = new Map<string, StructuralAdvisory>();
  const previousFingerprints = new Set<string>();
  for (const advisory of input.previous) {
    if (advisory.memberSetHash !== undefined) {
      previousByMembers.set(advisory.memberSetHash, advisory);
    }
    if (advisory.advisoryFingerprint !== undefined) {
      previousFingerprints.add(advisory.advisoryFingerprint);
    }
  }
  const seenMemberSets = new Set<string>();
  const active: StructuralAdvisory[] = [];

  for (const emitted of input.emitted) {
    const members = [
      ...new Set(emitted.memberIssueIdentifiers.map((id) => id.trim())),
    ]
      .filter(Boolean)
      .sort();
    const invalid = members.filter(
      (identifier) => !input.presentedIssueIdentifiers.has(identifier),
    );
    if (members.length === 0 || invalid.length > 0) {
      if (input.scanComplete !== false) {
        events.push({
          kind: "invalid_members",
          memberCount: members.length,
          invalidMemberCount: invalid.length,
        });
      }
      continue;
    }
    const memberSetHash = structuralAdvisoryMemberSetHash(members);
    const advisoryFingerprint = structuralAdvisoryFingerprint(
      memberSetHash,
      emitted.rootCauseHypothesis,
    );
    seenMemberSets.add(memberSetHash);
    const prior = previousByMembers.get(memberSetHash);
    const terminalCount = members.filter((identifier) =>
      input.terminalIssueIdentifiers?.has(identifier),
    ).length;
    const terminalState = prior?.lifecycleState;
    const lifecycleState =
      terminalState === "graded" || terminalState === "withdrawn"
        ? terminalState
        : terminalCount > members.length / 2
          ? "withdrawn"
          : "active";
    const conflicts = members.filter((identifier) =>
      input.conflictIssueIdentifiers?.has(identifier),
    );
    const root = await validateRoot(emitted.rootIssueIdentifier, input);
    const advisory: StructuralAdvisory = {
      ...emitted,
      memberIssueIdentifiers: members,
      memberSetHash,
      advisoryFingerprint,
      lifecycleState,
      absentOkTicks: 0,
      conflictIssueIdentifiers: conflicts,
      rendered: false,
      rootIssueIdentifier: root.resolved,
      proposedRootIssueIdentifier: root.proposed,
    };
    active.push(advisory);
    if (!previousFingerprints.has(advisoryFingerprint)) {
      events.push({ kind: "emitted", memberSetHash, advisoryFingerprint });
    }
    if (prior?.lifecycleState === "dormant" && lifecycleState === "active") {
      events.push({
        kind: "transition",
        memberSetHash,
        from: "dormant",
        to: "active",
      });
    } else if (
      prior?.lifecycleState === "active" &&
      lifecycleState === "withdrawn"
    ) {
      events.push({
        kind: "transition",
        memberSetHash,
        from: "active",
        to: "withdrawn",
      });
    }
    if (conflicts.length > 0) {
      events.push({
        kind: "conflict",
        memberSetHash,
        conflictIssueIdentifiers: conflicts,
      });
    }
  }

  const dormant = input.previous.flatMap((prior) => {
    const memberSetHash = prior.memberSetHash;
    if (memberSetHash === undefined || seenMemberSets.has(memberSetHash)) {
      return [];
    }
    if (input.scanComplete === false) return [prior];
    if (
      prior.lifecycleState === "withdrawn" ||
      prior.lifecycleState === "graded"
    ) {
      return [];
    }
    const absentOkTicks = (prior.absentOkTicks ?? 0) + 1;
    const lifecycleState: StructuralAdvisory["lifecycleState"] =
      absentOkTicks >= input.config.dormantOkTicks ? "withdrawn" : "dormant";
    if (lifecycleState !== prior.lifecycleState) {
      events.push({
        kind: "transition",
        memberSetHash,
        from: prior.lifecycleState ?? "active",
        to: lifecycleState,
      });
    }
    return [{ ...prior, lifecycleState, absentOkTicks, rendered: false }];
  });

  const renderable = active.filter(
    (advisory) => advisory.lifecycleState === "active",
  );
  let renderedCount = 0;
  const advisories = [
    ...active.map((advisory) => {
      const rendered =
        advisory.lifecycleState === "active" &&
        renderedCount < input.config.renderCap;
      if (rendered) renderedCount += 1;
      return { ...advisory, rendered };
    }),
    ...dormant,
  ];
  if (renderable.length > input.config.renderCap) {
    events.push({
      kind: "truncated",
      emittedCount: renderable.length,
      renderedCount,
    });
  }
  return { advisories, events };
}

function normalizeRootSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ROOT_SLUG_LIMIT);
}

async function validateRoot(
  identifier: string | null | undefined,
  input: ApplyAdvisoryLifecycleInput,
): Promise<{ resolved: string | null; proposed: string | null }> {
  const proposed = identifier?.trim() ?? "";
  if (proposed === "") return { resolved: null, proposed: null };
  try {
    if (await input.resolveRootIssueIdentifier?.(proposed)) {
      return { resolved: proposed, proposed: null };
    }
  } catch {
    // Lookup failure is unresolved by definition; never create a link target.
  }
  return { resolved: null, proposed };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
