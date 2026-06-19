import type {
  PlanBatch,
  StandingPlan,
  StandingPlanJournal,
} from "../domain/standing-plan.js";

// ---------------------------------------------------------------------------
// 6a — Living control doc render (SYMPH-790)
//
// Renders the standing plan as the body of a single, in-place-edited, team-level
// Linear document — the operator control surface AND the visibility narrative.
// Pure: the I/O (create/update the doc + Slack ping) lives in the publisher.
// Sections (top→bottom): recently shipped · in flight / in queue · proposed
// next batch(es) · options block ([opt-N] markers, revision-bound) · revision
// changelog. The store is truth; this is a view.
// ---------------------------------------------------------------------------

export const STANDING_PLAN_DOC_TITLE = "🚦Ticket Triage Controls";

export interface DocShippedEntry {
  issueIdentifier: string;
  /** Optional — batch outcomes carry identifiers, not titles (SYMPH-803). */
  title?: string;
}

export interface DocInFlightEntry {
  issueIdentifier: string;
  stage: string;
}

export interface DocChangelogEntry {
  revision: number;
  createdAt: string;
  rationale: string;
}

export interface RenderStandingPlanControlDocInput {
  plan: StandingPlan;
  recentlyShipped: DocShippedEntry[];
  inFlight: DocInFlightEntry[];
  changelog: DocChangelogEntry[];
}

export function renderStandingPlanControlDoc(
  input: RenderStandingPlanControlDocInput,
): string {
  const { plan } = input;
  const lines: string[] = [];

  lines.push(`# ${STANDING_PLAN_DOC_TITLE}`);
  lines.push("");
  lines.push(
    `_Revision ${plan.revision} · updated ${plan.updatedAt} · plan ${plan.planId}_`,
  );
  lines.push("");
  lines.push(plan.rationale.trim().length > 0 ? `> ${plan.rationale}` : "> —");

  lines.push("", "## Recently shipped");
  lines.push(
    input.recentlyShipped.length === 0
      ? "- (none)"
      : input.recentlyShipped
          .map((entry) =>
            entry.title === undefined || entry.title.length === 0
              ? `- ${entry.issueIdentifier}`
              : `- ${entry.issueIdentifier} — ${entry.title}`,
          )
          .join("\n"),
  );

  lines.push("", "## In flight / in queue");
  lines.push(
    input.inFlight.length === 0
      ? "- (none)"
      : input.inFlight
          .map((entry) => `- ${entry.issueIdentifier} (${entry.stage})`)
          .join("\n"),
  );

  lines.push("", "## Proposed next batch(es)");
  const lookahead = plan.batches.filter(
    (batch) => batch.status === "lookahead",
  );
  if (lookahead.length === 0) {
    lines.push("- (none)");
  } else {
    for (const batch of lookahead) {
      lines.push("", `### ${batch.batchId} — ${batch.mode}`);
      lines.push(`Rationale: ${batch.rationale}`);
      lines.push(
        `Members: ${batch.members
          .map((member) => member.issueIdentifier)
          .join(", ")}`,
      );
      const canaryLine = renderCanaryLine(batch);
      if (canaryLine !== null) {
        lines.push(canaryLine);
      }
    }
  }

  lines.push("", "## Options");
  lines.push(
    `_Comment on an option line below to act (operator-gated; bound to revision ${plan.revision})._`,
  );
  if (plan.options.length === 0) {
    lines.push("- (none)");
  } else {
    for (const option of plan.options) {
      // Revision-stamp the marker so a comment quoting this exact line binds to
      // THIS revision; a superseded line's stamp won't resolve against a later
      // revision's reused [opt-N] (SYMPH-791 revision binding).
      const stampedMarker = option.marker.replace(/\]$/, `:r${plan.revision}]`);
      lines.push(`- ${stampedMarker} ${option.label}`);
    }
  }

  lines.push("", "## Revision log");
  lines.push(
    input.changelog.length === 0
      ? "- (none)"
      : input.changelog
          .map(
            (entry) =>
              `- Revision ${entry.revision} (${entry.createdAt}): ${entry.rationale}`,
          )
          .join("\n"),
  );

  return lines.join("\n");
}

function renderCanaryLine(batch: PlanBatch): string | null {
  if (batch.canary === null) {
    return null;
  }
  return `Canary: head [${batch.canary.headIssueIdentifiers.join(
    ", ",
  )}] → contingent [${batch.canary.contingentIssueIdentifiers.join(", ")}]`;
}

/**
 * The most recently SHIPPED (merged) issues, newest first, for the doc's
 * "Recently shipped" section (SYMPH-803). Sourced from the standing-plan journal
 * outcomes — the single source of truth — and de-duped by identifier (a re-run
 * that re-merges shows once, at its latest sequence). Bounded by `limit`.
 */
export function computeRecentlyShipped(
  journal: StandingPlanJournal,
  limit: number,
): DocShippedEntry[] {
  const merged: Array<{ identifier: string; sequence: number }> = [];
  for (const entry of journal) {
    if (entry.kind === "plan_outcome" && entry.outcome.result === "merged") {
      for (const identifier of entry.outcome.issueIdentifiers) {
        merged.push({ identifier, sequence: entry.sequence });
      }
    }
  }
  merged.sort((a, b) => b.sequence - a.sequence);
  const seen = new Set<string>();
  const shipped: DocShippedEntry[] = [];
  for (const candidate of merged) {
    if (seen.has(candidate.identifier)) {
      continue;
    }
    seen.add(candidate.identifier);
    shipped.push({ issueIdentifier: candidate.identifier });
    if (shipped.length >= limit) {
      break;
    }
  }
  return shipped;
}
