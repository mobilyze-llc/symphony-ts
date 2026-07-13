import { createHash } from "node:crypto";

import type { StructuralAdvisory } from "../domain/structural-advisory.js";
import type { StructuralAdvisoryRejection } from "../orchestrator/structural-advisory-journal.js";

const ROOT_SLUG_LIMIT = 120;

export interface AdvisoryLifecycleConfig {
  dormantOkTicks: number;
  renderCap: number;
}

interface AdvisoryLifecycleEvent {
  kind:
    | "emitted"
    | "invalid_members"
    | "transition"
    | "conflict"
    | "truncated"
    | "suppressed";
  memberSetHash?: string;
  advisoryFingerprint?: string;
  from?: string;
  to?: string;
  memberCount?: number;
  invalidMemberCount?: number;
  conflictIssueIdentifiers?: string[];
  emittedCount?: number;
  renderedCount?: number;
  advisory?: StructuralAdvisory;
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
  rejectedMemberSets?: readonly StructuralAdvisoryRejection[];
  issueActivity?: ReadonlyMap<string, string | null>;
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

/**
 * Normalize an emitted member set and validate it against the exact issue
 * identifiers presented to the planner. Shared by the live lifecycle and
 * standalone Manager journaling so out-of-context model identifiers never
 * become lifecycle or calibration evidence.
 */
export function validateStructuralAdvisoryMembers(
  identifiers: readonly string[],
  presentedIssueIdentifiers: ReadonlySet<string>,
): { members: string[]; invalidIdentifiers: string[]; valid: boolean } {
  const members = [...new Set(identifiers.map((id) => id.trim()))]
    .filter(Boolean)
    .sort();
  const invalidIdentifiers = members.filter(
    (identifier) => !presentedIssueIdentifiers.has(identifier),
  );
  return {
    members,
    invalidIdentifiers,
    valid: members.length > 0 && invalidIdentifiers.length === 0,
  };
}

export async function applyAdvisoryLifecycle(
  input: ApplyAdvisoryLifecycleInput,
): Promise<ApplyAdvisoryLifecycleResult> {
  const events: AdvisoryLifecycleEvent[] = [];
  const previousByFingerprint = new Map<string, StructuralAdvisory>();
  const previousByMembers = new Map<string, StructuralAdvisory[]>();
  const previousFingerprints = new Set<string>();
  for (const advisory of input.previous) {
    if (advisory.advisoryFingerprint !== undefined) {
      previousFingerprints.add(advisory.advisoryFingerprint);
      previousByFingerprint.set(advisory.advisoryFingerprint, advisory);
    }
    if (advisory.memberSetHash !== undefined) {
      const group = previousByMembers.get(advisory.memberSetHash) ?? [];
      group.push(advisory);
      previousByMembers.set(advisory.memberSetHash, group);
    }
  }
  const seenFingerprints = new Set<string>();
  const observedMemberSets = new Set<string>();
  const transitionedMemberSets = new Set<string>();
  const active: StructuralAdvisory[] = [];

  for (const emitted of input.emitted) {
    const validation = validateStructuralAdvisoryMembers(
      emitted.memberIssueIdentifiers,
      input.presentedIssueIdentifiers,
    );
    const { members, invalidIdentifiers } = validation;
    if (!validation.valid) {
      if (input.scanComplete !== false) {
        events.push({
          kind: "invalid_members",
          memberCount: members.length,
          invalidMemberCount: invalidIdentifiers.length,
        });
      }
      continue;
    }
    const memberSetHash = structuralAdvisoryMemberSetHash(members);
    const advisoryFingerprint = structuralAdvisoryFingerprint(
      memberSetHash,
      emitted.rootCauseHypothesis,
    );
    // Observation ownership is the exact member set (KTD-1), not the root
    // wording fingerprint. Mark it before suppression so a rejected proposal
    // still counts as observed and cannot fabricate an absence transition.
    observedMemberSets.add(memberSetHash);
    const prior = previousByFingerprint.get(advisoryFingerprint);
    const sharedPrior = (previousByMembers.get(memberSetHash) ?? []).find(
      (candidate) =>
        candidate.lifecycleState !== "graded" &&
        candidate.lifecycleState !== "withdrawn",
    );
    const terminalCount = members.filter((identifier) =>
      input.terminalIssueIdentifiers?.has(identifier),
    ).length;
    const terminalState = prior?.lifecycleState;
    const rejection = latestRejection(
      input.rejectedMemberSets ?? [],
      memberSetHash,
    );
    const rejectedWithNewEvidence =
      rejection !== undefined && hasNewActivity(rejection, input.issueActivity);
    const explicitTerminalRevival =
      terminalState === "graded" &&
      rejection?.advisoryId === advisoryFingerprint &&
      rejectedWithNewEvidence;
    const lifecycleState = explicitTerminalRevival
      ? "active"
      : terminalState === "graded" || terminalState === "withdrawn"
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
    if (rejection !== undefined && lifecycleState === "active") {
      if (!rejectedWithNewEvidence) {
        events.push({
          kind: "suppressed",
          memberSetHash,
          advisoryFingerprint,
          advisory,
        });
        continue;
      }
      advisory.previouslyRejectedWithNewEvidence = true;
    }
    seenFingerprints.add(advisoryFingerprint);
    active.push(advisory);
    if (!previousFingerprints.has(advisoryFingerprint)) {
      events.push({
        kind: "emitted",
        memberSetHash,
        advisoryFingerprint,
        advisory,
      });
    }
    if (!transitionedMemberSets.has(memberSetHash) && explicitTerminalRevival) {
      transitionedMemberSets.add(memberSetHash);
      events.push({
        kind: "transition",
        memberSetHash,
        advisoryFingerprint,
        from: "graded",
        to: "active",
        advisory,
      });
    } else if (
      !transitionedMemberSets.has(memberSetHash) &&
      sharedPrior?.lifecycleState === "dormant" &&
      lifecycleState === "active"
    ) {
      transitionedMemberSets.add(memberSetHash);
      const transitionAdvisory = {
        ...sharedPrior,
        lifecycleState: "active" as const,
        absentOkTicks: 0,
        rendered: false,
      };
      events.push({
        kind: "transition",
        memberSetHash,
        ...(transitionAdvisory.advisoryFingerprint === undefined
          ? {}
          : {
              advisoryFingerprint: transitionAdvisory.advisoryFingerprint,
            }),
        from: "dormant",
        to: "active",
        advisory: transitionAdvisory,
      });
    } else if (
      !transitionedMemberSets.has(memberSetHash) &&
      prior?.lifecycleState === "active" &&
      lifecycleState === "withdrawn"
    ) {
      transitionedMemberSets.add(memberSetHash);
      events.push({
        kind: "transition",
        memberSetHash,
        advisoryFingerprint,
        from: "active",
        to: "withdrawn",
        advisory,
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

  const dormant = [...previousByMembers.entries()].flatMap(
    ([memberSetHash, group]) => {
      const unseen = group.filter(
        (prior) =>
          prior.advisoryFingerprint === undefined ||
          !seenFingerprints.has(prior.advisoryFingerprint),
      );
      if (unseen.length === 0) return [];
      if (input.scanComplete === false) return unseen;
      if (observedMemberSets.has(memberSetHash)) {
        return unseen.map((prior) =>
          prior.lifecycleState === "graded" ||
          prior.lifecycleState === "withdrawn"
            ? { ...prior, rendered: false }
            : {
                ...prior,
                lifecycleState: "active" as const,
                absentOkTicks: 0,
                rendered: false,
              },
        );
      }

      const lifecycleMembers = group.filter(
        (prior) =>
          prior.lifecycleState !== "graded" &&
          prior.lifecycleState !== "withdrawn",
      );
      const owner = lifecycleMembers[0];
      if (owner === undefined) {
        return unseen.map((prior) => ({ ...prior, rendered: false }));
      }
      const terminalCount = owner.memberIssueIdentifiers.filter((identifier) =>
        input.terminalIssueIdentifiers?.has(identifier),
      ).length;
      const absentOkTicks = (owner.absentOkTicks ?? 0) + 1;
      const lifecycleState: StructuralAdvisory["lifecycleState"] =
        terminalCount > owner.memberIssueIdentifiers.length / 2 ||
        absentOkTicks >= input.config.dormantOkTicks
          ? "withdrawn"
          : "dormant";
      if (lifecycleState !== owner.lifecycleState) {
        const transitioned = {
          ...owner,
          lifecycleState,
          absentOkTicks,
          rendered: false,
        };
        events.push({
          kind: "transition",
          memberSetHash,
          ...(owner.advisoryFingerprint === undefined
            ? {}
            : { advisoryFingerprint: owner.advisoryFingerprint }),
          from: owner.lifecycleState ?? "active",
          to: lifecycleState,
          advisory: transitioned,
        });
      }
      return unseen.map((prior) =>
        prior.lifecycleState === "graded" ||
        prior.lifecycleState === "withdrawn"
          ? { ...prior, rendered: false }
          : {
              ...prior,
              lifecycleState,
              absentOkTicks,
              rendered: false,
            },
      );
    },
  );

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

function latestRejection(
  rejections: readonly StructuralAdvisoryRejection[],
  memberSetHash: string,
): StructuralAdvisoryRejection | undefined {
  return rejections
    .filter((rejection) => rejection.memberSetHash === memberSetHash)
    .sort((a, b) => b.gradeSequence - a.gradeSequence)[0];
}

function hasNewActivity(
  rejection: StructuralAdvisoryRejection,
  activity: ReadonlyMap<string, string | null> | undefined,
): boolean {
  if (activity === undefined) return false;
  return Object.entries(rejection.memberActivityAtGrade).some(
    ([identifier, prior]) => {
      const current = activity.get(identifier) ?? null;
      return current !== null && (prior === null || current > prior);
    },
  );
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
