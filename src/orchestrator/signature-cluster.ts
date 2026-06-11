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
 * The registry is pure in-memory with no journal hydration: on process restart
 * the cluster is empty and SYSTEMIC counting restarts from zero. That is
 * acceptable for the current 2-3-worker, in-memory design (see CLAUDE.md
 * "in-memory state only"); cross-restart systemic memory is out of scope here.
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
  /** Whether the circuit breaker is open for this signature. */
  breakerOpen: boolean;
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
        breakerOpen: false,
      };
      this.clusters.set(signature, entry);
    }

    // Add or update membership for this issue
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
    const shouldOpenBreaker =
      shouldAlert &&
      this.circuitBreakerEnabled &&
      stageName !== null &&
      !entry.breakerOpen;

    if (shouldAlert) {
      entry.lastAlertSize = clusterSize;
    }

    if (shouldOpenBreaker && stageName !== null) {
      entry.breakerOpen = true;
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
      // Only materialize the member snapshot when a consumer will read it
      // (alert/breaker/file decisions key off shouldAlert).
      members: shouldAlert ? [...entry.members.values()] : [],
      signature,
      normalizedText,
      errorClass,
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
   * The corresponding signature's `breakerOpen` flag is also cleared so the
   * breaker can reopen on a subsequent recurrence and re-alerts on growth
   * remain possible.
   */
  resetCircuitBreaker(stageName: string): void {
    const breaker = this.stageBreakers.get(stageName);
    if (breaker === undefined) {
      return;
    }
    this.stageBreakers.delete(stageName);
    const entry = this.clusters.get(breaker.signature);
    if (entry !== undefined) {
      entry.breakerOpen = false;
    }
  }

  /**
   * Reset every stage breaker that was opened for the given issue. Called when
   * the operator resumes / re-dispatches an issue: that explicit action says
   * "I've looked at this, try again," so we close the stage breaker fully. The
   * resumed issue's first dispatch is the half-open canary — if the same
   * signature recurs it re-crosses threshold and recordFailure reopens the
   * breaker through the normal path. Returns the stage names that were reset.
   */
  resetBreakersForIssue(issueId: string): string[] {
    const reset: string[] = [];
    for (const breaker of [...this.stageBreakers.values()]) {
      if (breaker.openedForIssueIds.includes(issueId)) {
        this.resetCircuitBreaker(breaker.stageName);
        reset.push(breaker.stageName);
      }
    }
    return reset;
  }

  /**
   * Remove an issue from all cluster entries. Called ONLY on resume /
   * re-dispatch (never at terminal park) so a resumed issue is re-counted
   * fresh while a parked issue keeps counting toward SYSTEMIC.
   */
  clearIssueFromCluster(issueId: string): void {
    for (const entry of this.clusters.values()) {
      entry.members.delete(issueId);
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
  members: ClusterMember[];
  signature: string;
  normalizedText: string;
  errorClass: ErrorSignatureClass;
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
}): string {
  const { signature, errorClass, members, stageName, observedAt } = input;

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

  return lines.join("\n");
}
