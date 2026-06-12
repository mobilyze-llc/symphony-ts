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
