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
 *     operator acts (the existing resume / re-dispatch paths clear it by
 *     calling resetCircuitBreaker explicitly — there is no self-healing timer).
 *   - Rate-limited watchdog ticket filing (max_filings_per_hour per
 *     signature). The registry holds the last-filed timestamp per sig so the
 *     filer can suppress duplicates without a tracker round-trip.
 *
 * LIFECYCLE DISCIPLINE: every per-issue entry added here MUST be removed at
 * two points:
 *   1. clearIssueFromCluster — called by OrchestratorCore.clearTerminalIssueRuntimeState
 *   2. Same clearing at resume / re-dispatch points so a resumed issue that
 *      fails again is counted fresh rather than carrying stale membership.
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
      // Only open a single breaker per stage (latest signature wins if two
      // signatures simultaneously reach threshold on the same stage).
      const existing = this.stageBreakers.get(stageName);
      if (existing === undefined || existing.signature === signature) {
        this.stageBreakers.set(stageName, breakerEntry);
      }
    }

    const canFile = shouldAlert && this.canFileWatchdogTicket(signature, now);

    return {
      isSystemic,
      shouldAlert,
      shouldOpenBreaker,
      canFileWatchdogTicket: canFile,
      clusterSize,
      members: [...entry.members.values()],
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
   * Reset the circuit breaker for a stage. Called when the operator acts
   * (resume / re-dispatch path). The corresponding signature's `breakerOpen`
   * flag is also cleared so that re-alerts on growth remain possible.
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
   * Remove an issue from all cluster entries. Called at terminal cleanup
   * and at resume/re-dispatch so a resumed issue is re-counted fresh.
   */
  clearIssueFromCluster(issueId: string): void {
    for (const entry of this.clusters.values()) {
      entry.members.delete(issueId);
    }
  }

  /**
   * Record that a watchdog ticket was filed for a signature.
   */
  recordWatchdogFiling(input: {
    signature: string;
    issueIdentifier: string;
    now: Date;
  }): void {
    const existing = this.filingRecords.get(input.signature) ?? [];
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
 */
export function formatWatchdogTicketBody(input: {
  signature: string;
  normalizedText: string;
  errorClass: ErrorSignatureClass;
  members: ClusterMember[];
  stageName: string | null;
  observedAt: string;
}): string {
  const {
    signature,
    normalizedText,
    errorClass,
    members,
    stageName,
    observedAt,
  } = input;

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
    "## Normalized Error Pattern",
    "",
    "```",
    normalizedText,
    "```",
    "",
    "## Affected Issues",
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
