/**
 * Symphony operating policy — the single versioned source of truth for the
 * standing rules that steer model judgment (SYMPH-1141).
 *
 * This module is the ONE place the canonical policy text lives. Both the
 * altitude-reliability verdict prompt and the backlog planner prompt render
 * from `renderOperatingPolicy()` and cite {@link OPERATING_POLICY_PATH}; there
 * are deliberately no duplicated policy constants anywhere else in the tree.
 */

/**
 * Repo-relative path to this file. Rendered into every steering surface as the
 * provenance citation so a reader (or a prompt test) can trace the policy text
 * back to its versioned source without a second copy.
 */
export const OPERATING_POLICY_PATH = "src/policy/operating-policy.ts";

/** Machine-stable identifier for the policy-aware steering surface. */
export const OPERATING_POLICY_PROTOCOL = "snapshot-policy-v2" as const;

/**
 * The nine canonical operating rules, verbatim. Order is stable and rendered
 * as a 1-indexed numbered list; provenance for each rule is captured in
 * {@link OPERATING_POLICY_PROVENANCE}.
 */
export const OPERATING_POLICY_RULES: readonly string[] = [
  'Trace to the root before accepting a remedy. A symptom\'s fix must name the generating cause; a "harden X" that leaves the generator running is deferral, not repair.',
  "Be skeptical of easy answers. An explanation that arrived without evidence, a fix that doesn't change the mechanism, or a result that confirms what was convenient — verify against the artifact before believing it.",
  "The best part is no part. Prefer deleting the need over adding machinery. Every mechanism you add will generate the edge cases that become tomorrow's tickets.",
  "Choose the simple solution that covers the real cases over the complete solution that covers imagined ones.",
  "Leverage determinism for predictable processes. State membership, ordering, validation, and bookkeeping belong in deterministic code and config; spend model judgment only where judgment is genuinely required.",
  "Measure before caps. Limits, thresholds, and floors derive from observed data — report-only first; never guess a number.",
  "Defensive hardening for platforms, configs, or states unreachable in the deployed system is waste: kill it.",
  'When the source review itself says "not a bug" or "safe by construction," decline the work unless a reachable failure is named.',
  "When the evidence undercuts a ticket's premise or its framing sits at the wrong altitude, reframe to the root — don't execute the investigation as written.",
];

/**
 * Provenance of the policy set. Recorded here (not in a prompt) so the origin
 * of each rule stays versioned alongside the text it explains.
 */
export const OPERATING_POLICY_PROVENANCE =
  "Provenance: rules 1/3/6/7/8/9 from standing conventions and the 2026-07-12 altitude A/B preamble; rules 2/4/5 added by the operator 2026-07-12.";

/** Heading rendered above the rules on every steering surface. */
const OPERATING_POLICY_HEADING = `## Operating policy (source of truth: ${OPERATING_POLICY_PATH})`;

/**
 * Render the operating policy as a self-contained steering block: heading with
 * the file-path citation, the 1-indexed rules, then the provenance line. Used
 * verbatim by both the altitude verdict prompt and the planner prompt so the
 * two surfaces never drift.
 */
export function renderOperatingPolicy(): string {
  return [
    OPERATING_POLICY_HEADING,
    "Steer every judgment by these standing rules:",
    ...OPERATING_POLICY_RULES.map((rule, index) => `${index + 1}. ${rule}`),
    OPERATING_POLICY_PROVENANCE,
  ].join("\n");
}
