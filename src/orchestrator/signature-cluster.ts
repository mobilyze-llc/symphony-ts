/**
 * Cross-ticket signature clustering, stage circuit breaker, and watchdog
 * ticket filer (SYMPH-398).
 *
 * The registry is the single source of truth for:
 *   - How many distinct issues have seen a given normalized failure signature
 *     (clustering). When count hits systemic_threshold a SYSTEMIC alert fires
 *     (once-per-signature, re-alert on count growth).
 *   - Which stages are open-circuited. An open breaker parks arriving issues
 *     at the dispatch boundary with a distinct reason; it resets when the
 *     operator resumes any issue that the breaker was opened for, via
 *     resetBreakersForIssue (there is no self-healing timer). The first
 *     dispatch after that reset is the half-open canary: if the same signature
 *     recurs and re-crosses threshold, recordFailure reopens the breaker
 *     through the normal path.
 *   - Rate-limited watchdog ticket filing (max_filings_per_hour per
 *     signature). The registry holds the filing timestamps per sig so the
 *     filer can suppress duplicates without a tracker round-trip.
 *
 * LIFECYCLE DISCIPLINE: cluster membership is the count of DISTINCT issues that
 * have seen a signature, and it must survive terminal park — a parked issue
 * still counts so a second, distinct issue failing later tips the cluster to
 * SYSTEMIC (the SYMPH-330/332 motivation). Membership is therefore removed at
 * exactly ONE point: clearIssueFromCluster, called only on resume / re-dispatch
 * of that issue, so a resumed issue is counted fresh rather than carrying stale
 * membership. It is deliberately NOT removed at terminal cleanup.
 *
 * REPLAY HYDRATION (SYMPH-405): the orchestrator journals `cluster_transition`
 * and `breaker_transition` events and feeds them back through hydrateCluster /
 * hydrateBreakerOpen / resetCircuitBreaker on recovery, so a deploy in the
 * middle of a systemic signature does not silently reset the count below K
 * (the SYMPH-398 restart-amnesia hole). Each journaled cluster_transition
 * carries the full membership snapshot; hydration is latest-entry-wins per
 * signature. Resume-clearing is NOT replayed — a resumed issue is cleared by
 * the live isDispatchEligible path after recovery.
 */

import type { ErrorSignatureClass } from "../errors/signature.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClusterMember {
  issueId: string;
  issueIdentifier: string;
  stageName: string | null;
  recordedAt: string;
  /** Normalized text of the failure that triggered membership. */
  normalizedText: string;
}

export interface SignatureClusterEntry {
  signature: string;
  errorClass: ErrorSignatureClass;
  normalizedText: string;
  members: Map<string, ClusterMember>;
  /**
   * The cluster size at which the SYSTEMIC alert was last fired. Re-alert
   * fires when current size > lastAlertSize.
   */
  lastAlertSize: number;
}

export interface CircuitBreakerEntry {
  stageName: string;
  signature: string;
  openedAt: string;
  openedForIssueIds: string[];
}

export interface WatchdogFilingRecord {
  signature: string;
  filedAt: string;
  issueIdentifier: string;
}

/** Serializable cluster summary for the state document (SYMPH-407). */
export interface WatchdogClusterSnapshot {
  signature: string;
  error_class: ErrorSignatureClass;
  cluster_size: number;
  member_issue_identifiers: string[];
  last_alert_size: number;
}

/** Serializable open-breaker summary for the state document (SYMPH-407). */
export interface WatchdogBreakerSnapshot {
  stage_name: string;
  signature: string;
  opened_at: string;
  opened_for_issue_ids: string[];
}

export interface WatchdogRegistrySnapshot {
  clusters: WatchdogClusterSnapshot[];
  openBreakers: WatchdogBreakerSnapshot[];
}

export interface SignatureClusterRegistryOptions {
  /** Minimum cluster size (inclusive) to declare SYSTEMIC. Default: 2. */
  systemicThreshold?: number;
  /** Whether to open stage circuit breakers on SYSTEMIC. Default: true. */
  circuitBreakerEnabled?: boolean;
  /**
   * Maximum watchdog tickets filed per signature per hour. Default: 3.
   * The filer checks this before attempting a Linear write.
   */
  maxFilingsPerHour?: number;
}

// ---------------------------------------------------------------------------
// SignatureClusterRegistry
// ---------------------------------------------------------------------------

export class SignatureClusterRegistry {
  private readonly systemicThreshold: number;
  private readonly circuitBreakerEnabled: boolean;
  private readonly maxFilingsPerHour: number;

  /** Per-signature cluster entries. */
  private readonly clusters = new Map<string, SignatureClusterEntry>();

  /** Per-stage circuit breakers. Keyed by stage name. */
  private readonly stageBreakers = new Map<string, CircuitBreakerEntry>();

  /** Per-signature filing records for rate-limiting. */
  private readonly filingRecords = new Map<string, WatchdogFilingRecord[]>();

  constructor(options: SignatureClusterRegistryOptions = {}) {
    this.systemicThreshold = options.systemicThreshold ?? 2;
    this.circuitBreakerEnabled = options.circuitBreakerEnabled ?? true;
    this.maxFilingsPerHour = options.maxFilingsPerHour ?? 3;
  }

  /**
   * Record a failure for an issue. Returns a SystemicClusterResult describing
   * the actions that should be taken: fire SYSTEMIC alert, open circuit
   * breaker, file watchdog ticket.
   *
   * Must only be called from the orchestrator's event-serialized path to
   * avoid races.
   */
  recordFailure(input: {
    signature: string;
    errorClass: ErrorSignatureClass;
    normalizedText: string;
    issueId: string;
    issueIdentifier: string;
    stageName: string | null;
    now: Date;
  }): RecordFailureResult {
    const {
      signature,
      errorClass,
      normalizedText,
      issueId,
      issueIdentifier,
      stageName,
      now,
    } = input;

    let entry = this.clusters.get(signature);
    if (entry === undefined) {
      entry = {
        signature,
        errorClass,
        normalizedText,
        members: new Map(),
        lastAlertSize: 0,
      };
      this.clusters.set(signature, entry);
    }

    // Add or update membership for this issue
    const memberAdded = !entry.members.has(issueId);
    entry.members.set(issueId, {
      issueId,
      issueIdentifier,
      stageName,
      recordedAt: now.toISOString(),
      normalizedText,
    });

    const clusterSize = entry.members.size;
    const isSystemic = clusterSize >= this.systemicThreshold;
    const shouldAlert = isSystemic && clusterSize > entry.lastAlertSize;

    // Breaker reopening is decoupled from the alert-once-on-growth gate.
    // A recurrence that keeps the cluster systemic must reopen the breaker
    // even when no new alert is due (e.g. canary resumed → recurred at the
    // same cluster size where lastAlertSize was already set). The sole source
    // of breaker state is stageBreakers; per-entry flags are not used.
    const currentBreaker =
      stageName !== null ? this.stageBreakers.get(stageName) : undefined;
    const stageHasBreakerForThisSignature =
      currentBreaker !== undefined && currentBreaker.signature === signature;
    const shouldOpenBreaker =
      isSystemic &&
      this.circuitBreakerEnabled &&
      stageName !== null &&
      !stageHasBreakerForThisSignature;

    if (shouldAlert) {
      entry.lastAlertSize = clusterSize;
    }

    if (shouldOpenBreaker && stageName !== null) {
      const breakerEntry: CircuitBreakerEntry = {
        stageName,
        signature,
        openedAt: now.toISOString(),
        openedForIssueIds: [...entry.members.keys()],
      };
      // One breaker per stage; the latest signature to cross threshold wins so
      // the reported reason/signature reflects the most recent systemic cause.
      this.stageBreakers.set(stageName, breakerEntry);
    }

    const canFile = shouldAlert && this.canFileWatchdogTicket(signature, now);

    return {
      isSystemic,
      shouldAlert,
      shouldOpenBreaker,
      canFileWatchdogTicket: canFile,
      clusterSize,
      memberAdded,
      // Always materialized: the cluster_transition journal entry (SYMPH-405)
      // carries the full membership snapshot for replay hydration.
      members: [...entry.members.values()],
      signature,
      normalizedText,
      errorClass,
      lastAlertSize: entry.lastAlertSize,
    };
  }

  /**
   * Returns true when the circuit breaker is open for the given stage.
   * Called at the dispatch boundary before assigning a worker.
   */
  isBreakerOpen(stageName: string): boolean {
    return this.stageBreakers.has(stageName);
  }

  /**
   * Returns the open circuit breaker entry for a stage, or null if closed.
   */
  getBreakerEntry(stageName: string): CircuitBreakerEntry | null {
    return this.stageBreakers.get(stageName) ?? null;
  }

  /**
   * Reset the circuit breaker for a single stage (full close, not half-open).
   * Breaker state lives exclusively in stageBreakers; deleting the entry is
   * sufficient. The cluster entry's lastAlertSize is untouched so re-growth
   * past the current size triggers a fresh SYSTEMIC alert.
   */
  resetCircuitBreaker(stageName: string): void {
    this.stageBreakers.delete(stageName);
  }

  /**
   * Reset every stage breaker that was opened for the given issue. Called when
   * the operator resumes / re-dispatches an issue: that explicit action says
   * "I've looked at this, try again," so we close the stage breaker fully. The
   * resumed issue's first dispatch is the half-open canary — if the same
   * signature recurs it re-crosses threshold and recordFailure reopens the
   * breaker through the normal path. Returns the breaker entries that were
   * reset (stage + signature) so the caller can journal the close transition.
   */
  resetBreakersForIssue(issueId: string): CircuitBreakerEntry[] {
    const reset: CircuitBreakerEntry[] = [];
    for (const breaker of [...this.stageBreakers.values()]) {
      if (breaker.openedForIssueIds.includes(issueId)) {
        this.resetCircuitBreaker(breaker.stageName);
        reset.push(breaker);
      }
    }
    return reset;
  }

  /**
   * Replay hydration (SYMPH-405): replace the cluster entry for a signature
   * with the journaled membership snapshot. Latest entry per signature wins
   * (callers replay in journal sequence order).
   */
  hydrateCluster(input: {
    signature: string;
    errorClass: ErrorSignatureClass;
    normalizedText: string;
    members: ClusterMember[];
    lastAlertSize: number;
  }): void {
    this.clusters.set(input.signature, {
      signature: input.signature,
      errorClass: input.errorClass,
      normalizedText: input.normalizedText,
      members: new Map(input.members.map((member) => [member.issueId, member])),
      lastAlertSize: input.lastAlertSize,
    });
  }

  /**
   * Replay hydration (SYMPH-405): restore an open stage breaker from a
   * journaled breaker_transition "opened" entry. A later "closed" entry is
   * replayed via resetCircuitBreaker.
   */
  hydrateBreakerOpen(entry: CircuitBreakerEntry): void {
    this.stageBreakers.set(entry.stageName, entry);
  }

  /**
   * Remove an issue from all cluster entries. Called ONLY on resume /
   * re-dispatch (never at terminal park) so a resumed issue is re-counted
   * fresh while a parked issue keeps counting toward SYSTEMIC.
   *
   * lastAlertSize is clamped down to the new membership size so that when the
   * resumed issue recurs and the cluster grows back to its previous size, the
   * growth-based re-alert fires again (Fix 1: canary recurrence re-alerting).
   */
  clearIssueFromCluster(issueId: string): void {
    for (const entry of this.clusters.values()) {
      if (entry.members.delete(issueId)) {
        // Clamp lastAlertSize so re-growth past the shrunken size re-alerts.
        entry.lastAlertSize = Math.min(entry.lastAlertSize, entry.members.size);
      }
    }
  }

  /**
   * Record that a watchdog ticket was filed for a signature. Prunes records
   * older than one hour on write so the backing array stays bounded.
   */
  recordWatchdogFiling(input: {
    signature: string;
    issueIdentifier: string;
    now: Date;
  }): void {
    const oneHourAgoMs = input.now.getTime() - 60 * 60 * 1000;
    const existing = (this.filingRecords.get(input.signature) ?? []).filter(
      (r) => Date.parse(r.filedAt) > oneHourAgoMs,
    );
    existing.push({
      signature: input.signature,
      filedAt: input.now.toISOString(),
      issueIdentifier: input.issueIdentifier,
    });
    this.filingRecords.set(input.signature, existing);
  }

  /**
   * Return all current cluster entries (read-only snapshot for tests/observability).
   */
  getClusters(): ReadonlyMap<string, Readonly<SignatureClusterEntry>> {
    return this.clusters;
  }

  /**
   * Return all open circuit breaker entries.
   */
  getOpenBreakers(): ReadonlyMap<string, Readonly<CircuitBreakerEntry>> {
    return this.stageBreakers;
  }

  /**
   * Serializable summary of cluster + breaker state for the /api/v1/state
   * watchdog section (SYMPH-407). Same registry the dispatcher consults —
   * no second source of truth.
   */
  toWatchdogSnapshot(): WatchdogRegistrySnapshot {
    const clusters = [...this.clusters.values()]
      .map((entry) => ({
        signature: entry.signature,
        error_class: entry.errorClass,
        cluster_size: entry.members.size,
        member_issue_identifiers: [...entry.members.values()]
          .map((member) => member.issueIdentifier)
          .sort((left, right) => left.localeCompare(right, "en")),
        last_alert_size: entry.lastAlertSize,
      }))
      .sort((left, right) => left.signature.localeCompare(right.signature));
    const openBreakers = [...this.stageBreakers.values()]
      .map((breaker) => ({
        stage_name: breaker.stageName,
        signature: breaker.signature,
        opened_at: breaker.openedAt,
        opened_for_issue_ids: [...breaker.openedForIssueIds],
      }))
      .sort((left, right) => left.stage_name.localeCompare(right.stage_name));
    return { clusters, openBreakers };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private canFileWatchdogTicket(signature: string, now: Date): boolean {
    const records = this.filingRecords.get(signature) ?? [];
    const oneHourAgoMs = now.getTime() - 60 * 60 * 1000;
    const recentFilings = records.filter(
      (r) => Date.parse(r.filedAt) > oneHourAgoMs,
    );
    return recentFilings.length < this.maxFilingsPerHour;
  }
}

// ---------------------------------------------------------------------------
// RecordFailureResult
// ---------------------------------------------------------------------------

export interface RecordFailureResult {
  isSystemic: boolean;
  shouldAlert: boolean;
  shouldOpenBreaker: boolean;
  canFileWatchdogTicket: boolean;
  clusterSize: number;
  /** True when this failure added a NEW distinct issue to the cluster. */
  memberAdded: boolean;
  members: ClusterMember[];
  signature: string;
  normalizedText: string;
  errorClass: ErrorSignatureClass;
  /** Cluster size at which the SYSTEMIC alert last fired (post-update). */
  lastAlertSize: number;
}

// ---------------------------------------------------------------------------
// Watchdog ticket body formatter
// ---------------------------------------------------------------------------

/**
 * Build the Linear issue body for a watchdog ticket. The body includes:
 *   - A machine-parseable signature hash marker for dedupe-by-search
 *   - Evidence bundle (cluster members, stage, class)
 *   - Never-auto-release instruction
 *
 * The raw normalized error text is deliberately NOT embedded: it can carry
 * secrets (URLs/query params, emails, bearer tokens) or adversarial /
 * prompt-injection content from worker output. The signature hash + failure
 * class + member issue identifiers + stage are the full operator triage
 * signal; an operator inspects the linked member issues for the raw text.
 */
export function formatWatchdogTicketBody(input: {
  signature: string;
  errorClass: ErrorSignatureClass;
  members: ClusterMember[];
  stageName: string | null;
  observedAt: string;
  /**
   * Journal sequence of the cluster_transition entry that fired this filing
   * (SYMPH-407): lets an agent fetch the exact event slice via
   * GET /api/v1/state/delta?since_seq=N-1.
   */
  journalSequence?: number | null;
}): string {
  const { signature, errorClass, members, stageName, observedAt } = input;
  const journalSequence = input.journalSequence ?? null;

  // Machine-parseable marker used for deduplication by title + body search.
  const marker = `<!-- watchdog-signature:${signature} -->`;

  const lines: string[] = [
    marker,
    "",
    `## Watchdog: SYSTEMIC failure cluster — signature \`${signature}\``,
    "",
    `**Failure class:** \`${errorClass}\``,
    `**Affected stage:** ${stageName !== null ? `\`${stageName}\`` : "_unknown_"}`,
    `**Cluster size:** ${members.length}`,
    `**First observed at:** ${observedAt}`,
    "",
    "## Affected Issues",
    "",
    "_Inspect the linked issues below for the raw failure output._",
    "",
  ];

  const sortedMembers = [...members].sort((a, b) =>
    a.issueIdentifier.localeCompare(b.issueIdentifier),
  );
  for (const member of sortedMembers) {
    lines.push(
      `- **${member.issueIdentifier}** — stage: ${member.stageName ?? "_unknown_"}, recorded: ${member.recordedAt}`,
    );
  }

  lines.push(
    "",
    "## Acceptance Criteria",
    "",
    "- Identify the root cause of the above normalized failure pattern.",
    "- Land a fix or configuration change that prevents recurrence.",
    "- Verify that Symphony no longer fires this signature after the fix.",
    "",
    "## Notes",
    "",
    "- This ticket was machine-filed by the Symphony watchdog (SYMPH-398). Do NOT auto-release.",
    "- The circuit breaker for the affected stage is open until an operator resets it via resume/re-dispatch.",
    `- Signature hash: \`${signature}\` (stable across path/UUID variations).`,
  );
  if (journalSequence !== null) {
    lines.push(
      `- Journal cursor: seq ${journalSequence} (fetch the exact event slice via \`GET /api/v1/state/delta?since_seq=${Math.max(0, journalSequence - 1)}\`).`,
    );
  }

  return lines.join("\n");
}
