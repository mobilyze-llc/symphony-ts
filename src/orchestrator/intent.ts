/**
 * Shared intent-verb layer (SYMPH-399, the "408a" carve-out from SYMPH-408).
 *
 * Intent verbs are idempotent journal writes riding the existing monotonic
 * `sequence` reducer (dispatcher run journal). The operator CLI, the MCP
 * tool (SYMPH-408 phase 3), and the watchdog L2 bounded actions are all
 * callers of the same verbs — never independent mutation paths. Linear
 * states become a *view* of intent.
 *
 * Four semantics (each enforced by OrchestratorCore.writeIntent):
 *
 * 1. Idempotency — re-writing an intent that would not change state (or an
 *    exact duplicate of an already-journaled write) records/returns a
 *    `no_op`; side effects never fire twice.
 * 2. Fencing — verbs racing workers carry the park generation they believe
 *    they are acting on (the park-then-revise nonce pattern); a stale fence
 *    is `rejected_stale` and mutates nothing.
 * 3. Attribution — every intent carries an actor ({kind, host, session?})
 *    and every human-visible side effect of an applied intent renders
 *    "by {actor.kind}@{host}" (the un-parker incident was undiagnosable
 *    precisely because Linear showed a state change with no author).
 * 4. Replay convergence — intent events replay through the same journal
 *    reducer, so replay of park → release converges on released
 *    (SYMPH-368: operator releases were invisible to the journal and
 *    replay re-parked over them).
 *
 * Event schema is a member of the SYMPH-405 verdict-event family: one
 * `schema_version`'d shape, actor kinds shared with that vocabulary, and
 * `failure_signature`/`failure_class` reusing the SYMPH-396 fields. No
 * migration machinery — surfaces must remain deletable.
 */

export const INTENT_SCHEMA_VERSION = 1;

export const INTENT_VERBS = [
  "park",
  "release",
  "anchor",
  "unanchor",
  "halt",
  "retry_once",
  "rework_with_hint",
  "escalate_human",
  /**
   * Authorize one continuation unit for a budget-paused run that has NOT
   * parked (SYMPH-422: the synchronous pause-triage continue path fires
   * before any park exists, so `release` semantics cannot fit). Distinct
   * from `release`, which clears a standing park. Replays as a no-op: the
   * continuation retry is in-memory scheduling, and an un-parked issue is
   * already dispatch-eligible after replay.
   */
  "resume",
] as const;

export type IntentVerb = (typeof INTENT_VERBS)[number];

/**
 * Queue Triage v2 plan-control verbs (SYMPH-789). These are plan/batch-scoped,
 * NOT issue-scoped: they ride the same dashboard/symphonyctl intent surface but
 * are handled at the host level (recorded as revision-bound PlanDecisions in the
 * standing-plan store), so they never enter the issue-scoped writeIntent /
 * applyIntentVerb path or the dispatcher-journal replay.
 */
export const PLAN_CONTROL_VERBS = [
  "release_batch",
  "hold",
  "modify_plan",
] as const;

/** Fingerprint-scoped calibration write; intentionally not revision-bound. */
export const GRADE_INTENT_VERBS = ["grade_advisory"] as const;
export type GradeIntentVerb = (typeof GRADE_INTENT_VERBS)[number];

export type PlanControlVerb = (typeof PLAN_CONTROL_VERBS)[number];

export function isPlanControlVerb(value: string): value is PlanControlVerb {
  return (PLAN_CONTROL_VERBS as readonly string[]).includes(value);
}

export function isGradeIntentVerb(value: string): value is GradeIntentVerb {
  return (GRADE_INTENT_VERBS as readonly string[]).includes(value);
}

export type GradeIntentPayload =
  | {
      target: "structural_advisory";
      fingerprint: string;
      decision: "accept" | "partial" | "reject";
      acceptedIdentifiers?: string[];
    }
  | {
      target: "hygiene_proposal";
      fingerprint: string;
      decision: "accept" | "reject";
    };

/**
 * Payload for a plan-control intent. `revision` binds the operator action to a
 * specific plan revision (a re-plan rotates the revision → stale actions are
 * void). `batchId` targets a batch (required for release_batch / hold; absent
 * for the plan-scoped modify_plan).
 */
export interface PlanControlIntentPayload {
  revision: number;
  batchId?: string;
}

/**
 * Synthetic issue scope for pipeline-wide intents (SYMPH-408b). Pipeline
 * pause/resume has no Linear issue at journal time (the halt issue is the
 * VIEW created after the intent is journaled), so pipeline-scoped entries
 * carry this sentinel instead of a real issue id. Issue-verb replay
 * reduction never matches these verbs, so the sentinel never collides with
 * issue state.
 */
export const PIPELINE_INTENT_ISSUE_ID = "pipeline";
export const PIPELINE_INTENT_ISSUE_IDENTIFIER = "PIPELINE";

/**
 * Case- and whitespace-insensitive match against the reserved pipeline
 * sentinel ("pipeline"/"PIPELINE"/" pipeline "). The sentinel is a synthetic
 * journal scope, never an addressable issue: issue-scoped intent verbs must
 * be rejected at every boundary before they can journal issue state under
 * the pipeline-wide scope (SYMPH-408 council R1/R2).
 */
export function isPipelineSentinelValue(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const lowered = value.trim().toLowerCase();
  return (
    lowered === PIPELINE_INTENT_ISSUE_ID.toLowerCase() ||
    lowered === PIPELINE_INTENT_ISSUE_IDENTIFIER.toLowerCase()
  );
}

/** Actor vocabulary shared with the SYMPH-405 verdict-event family. */
export const INTENT_ACTOR_KINDS = [
  "operator",
  "watchdog-l1",
  "watchdog-l2",
  "pipeline-worker",
  "interactive-agent",
] as const;

export type IntentActorKind = (typeof INTENT_ACTOR_KINDS)[number];

export interface IntentActor {
  kind: IntentActorKind;
  host: string;
  session?: string | null;
}

export type IntentStatus = "applied" | "no_op" | "rejected_stale";

/** Machine-parsable class + human one-liner (SYMPH-405 reason shape). */
export interface IntentReason {
  class: string;
  human: string;
}

export interface IntentFence {
  /**
   * The park generation this intent believes it is acting on. Compared
   * against the issue's current park generation; mismatch rejects the
   * write without mutating anything.
   */
  expectedParkSeq: number;
}

export interface IntentWriteResult {
  status: IntentStatus;
  /** Human-readable explanation of the status (also journaled). */
  detail: string;
  /** Journal sequence of the recorded intent event, when one was written. */
  sequence: number | null;
}

export const ANCHOR_PLACEMENT_KINDS = ["top", "above", "below"] as const;

export type AnchorPlacementKind = (typeof ANCHOR_PLACEMENT_KINDS)[number];

export type AnchorPlacement =
  | { kind: "top" }
  | { kind: "above" | "below"; issueIdentifier: string };

export type AnchorExpiry =
  | { kind: "until_merged" }
  | { kind: "until_date"; at: string };

export interface AnchorIntentPayload {
  placement: AnchorPlacement;
  expiry: AnchorExpiry;
  source: "symphonyctl" | "api" | "linear_field_edit";
  fieldName?: string | null;
  editorEmail?: string | null;
}

/**
 * Render the actor discriminator segment of an intent idempotency key
 * (SYMPH-422). Two DIFFERENT actors minting same-verb-same-generation
 * intents must journal separately — collapsing them loses the second
 * actor's attribution and rationale (worst for state-preserving verbs like
 * escalate_human and for no_op/rejected_stale audit entries). The session
 * IS part of the discriminator: two CLI/MCP sessions from the same
 * kind+host are distinct audit events. The orchestrator's own internal
 * actors are sessionless and host-stable, so its retry-path re-issues of
 * the same verb at the same generation still dedupe.
 */
export function formatIntentActorKey(actor: IntentActor): string {
  const session =
    actor.session === undefined || actor.session === null
      ? ""
      : `#${sanitizeActorKeyComponent(actor.session)}`;
  return `${actor.kind}@${sanitizeActorKeyComponent(actor.host)}${session}`;
}

/**
 * Replace the key delimiters (@ # :) inside an actor-key component so an
 * unusual or hostile host/session string cannot compose into another
 * actor's key (e.g. host "h#a" + session "b" colliding with host "h" +
 * session "a#b"). Lossy by design — the key is an opaque equality token;
 * the journal entry's actor metadata keeps the exact values.
 */
function sanitizeActorKeyComponent(value: string): string {
  return value.replace(/[@#:]/g, "_");
}

/**
 * Render the mandatory human-visible attribution line. Any state-changing
 * surface (Linear comment, Slack alert) produced by an applied intent must
 * include this string.
 */
export function formatIntentAttribution(actor: IntentActor): string {
  const session =
    actor.session === undefined || actor.session === null
      ? ""
      : ` (session ${actor.session})`;
  return `by ${actor.kind}@${actor.host}${session}`;
}

export function isIntentActorKind(value: unknown): value is IntentActorKind {
  return (
    typeof value === "string" &&
    (INTENT_ACTOR_KINDS as readonly string[]).includes(value)
  );
}

export function isIntentVerb(value: unknown): value is IntentVerb {
  return (
    typeof value === "string" &&
    (INTENT_VERBS as readonly string[]).includes(value)
  );
}
