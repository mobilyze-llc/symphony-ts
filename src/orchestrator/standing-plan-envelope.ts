import type { PlanBatch, PlanEnvelope } from "../domain/standing-plan.js";

// ---------------------------------------------------------------------------
// Envelope read contract (SYMPH-793)
//
// The envelope { concurrency ceiling, allowed risk, allowed batch modes } is
// what the Manager reads and plans within. v2 sources it statically; the Ramp
// Governor (Track 4) will write it later WITHOUT spine changes, because the
// read contract below is the stable seam. `version` is the only field the
// re-plan trigger watches (consumer guard #4, SYMPH-787).
//
// The pure resolver lives in domain/standing-plan.ts so the config layer can
// resolve an envelope from frontmatter without importing the orchestrator;
// it is re-exported here for orchestrator-side callers.
// ---------------------------------------------------------------------------

export {
  DEFAULT_ENVELOPE_ALLOWED_MODES,
  DEFAULT_ENVELOPE_ALLOWED_RISK,
  resolveStandingPlanEnvelope,
  type StandingPlanEnvelopeInput,
} from "../domain/standing-plan.js";

export interface EnvelopeValidationResult {
  ok: boolean;
  violations: string[];
}

/**
 * Validate that a set of batches plans/dispatches strictly within the envelope.
 * v2 enforces the allowed-mode contract (a batch whose mode is not permitted is
 * a violation); the concurrency ceiling is enforced at dispatch time by the
 * consumer (SYMPH-787), which reads `envelope.concurrencyCeiling` directly.
 */
export function validatePlanAgainstEnvelope(
  batches: readonly PlanBatch[],
  envelope: PlanEnvelope,
): EnvelopeValidationResult {
  const allowed = new Set(envelope.allowedModes);
  const violations: string[] = [];
  for (const batch of batches) {
    if (!allowed.has(batch.mode)) {
      violations.push(
        `batch ${batch.batchId} mode "${batch.mode}" is outside the envelope (allowed: ${envelope.allowedModes.join(", ")})`,
      );
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Whether the envelope version changed — the single trigger the re-plan path
 * watches (a clamp or widen by Track 4 bumps the version).
 */
export function envelopeVersionChanged(
  previous: PlanEnvelope,
  next: PlanEnvelope,
): boolean {
  return previous.version !== next.version;
}
