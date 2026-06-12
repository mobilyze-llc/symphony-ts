import { describe, expect, it } from "vitest";
import { normalizeErrorSignature } from "../../src/errors/signature.js";
import {
  SignatureClusterRegistry,
  formatWatchdogTicketBody,
} from "../../src/orchestrator/signature-cluster.js";

// A realistic non-transient agent failure. Normalization strips the workspace
// path to a basename but preserves the EPERM shape, so two distinct issues
// failing in their own workspaces share one signature.
const EPERM_RAW_A =
  "Error: EPERM: operation not permitted, open '/tmp/symphony/workspaces/3f9a/.git/index.lock'";
const EPERM_RAW_B =
  "Error: EPERM: operation not permitted, open '/tmp/symphony/workspaces/8c21/.git/index.lock'";

function normalized(raw: string) {
  const n = normalizeErrorSignature(raw);
  return {
    signature: n.signature,
    errorClass: n.class,
    normalizedText: n.normalizedText,
  };
}

const T0 = new Date("2026-06-11T00:00:00.000Z");
const atOffset = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("SignatureClusterRegistry — clustering / SYSTEMIC detection", () => {
  it("two distinct issues with the same signature fire SYSTEMIC (threshold 2)", () => {
    const reg = new SignatureClusterRegistry({ systemicThreshold: 2 });
    const sigA = normalized(EPERM_RAW_A);
    const sigB = normalized(EPERM_RAW_B);
    expect(sigA.signature).toBe(sigB.signature);

    const r1 = reg.recordFailure({
      ...sigA,
      issueId: "id-1",
      issueIdentifier: "SYMPH-1",
      stageName: "implement",
      now: T0,
    });
    expect(r1.clusterSize).toBe(1);
    expect(r1.isSystemic).toBe(false);
    expect(r1.shouldAlert).toBe(false);

    const r2 = reg.recordFailure({
      ...sigB,
      issueId: "id-2",
      issueIdentifier: "SYMPH-2",
      stageName: "implement",
      now: atOffset(MIN),
    });
    expect(r2.clusterSize).toBe(2);
    expect(r2.isSystemic).toBe(true);
    expect(r2.shouldAlert).toBe(true);
  });

  it("the same issue failing twice does NOT cross threshold (distinct-issue count)", () => {
    const reg = new SignatureClusterRegistry({ systemicThreshold: 2 });
    const sig = normalized(EPERM_RAW_A);
    reg.recordFailure({
      ...sig,
      issueId: "id-1",
      issueIdentifier: "SYMPH-1",
      stageName: "implement",
      now: T0,
    });
    const second = reg.recordFailure({
      ...sig,
      issueId: "id-1",
      issueIdentifier: "SYMPH-1",
      stageName: "implement",
      now: atOffset(MIN),
    });
    expect(second.clusterSize).toBe(1);
    expect(second.shouldAlert).toBe(false);
  });

  it("membership PERSISTS through terminal park: issue 2 fails after issue 1 parked → SYSTEMIC", () => {
    // This is the SYMPH-330/332 regression. A parked issue must keep counting.
    const reg = new SignatureClusterRegistry({ systemicThreshold: 2 });
    const sigA = normalized(EPERM_RAW_A);
    const sigB = normalized(EPERM_RAW_B);

    reg.recordFailure({
      ...sigA,
      issueId: "id-1",
      issueIdentifier: "SYMPH-1",
      stageName: "implement",
      now: T0,
    });

    // Issue 1 terminally parks. clearTerminalIssueRuntimeState must NOT touch
    // cluster membership — only resume does. We assert membership survives by
    // *not* calling clearIssueFromCluster here (mirrors core.ts after the fix).

    const r2 = reg.recordFailure({
      ...sigB,
      issueId: "id-2",
      issueIdentifier: "SYMPH-2",
      stageName: "implement",
      now: atOffset(10 * MIN),
    });
    expect(r2.clusterSize).toBe(2);
    expect(r2.isSystemic).toBe(true);
    expect(r2.shouldAlert).toBe(true);
  });

  it("clearing a RESUMED issue removes only that issue, dropping the cluster back below threshold", () => {
    const reg = new SignatureClusterRegistry({ systemicThreshold: 2 });
    const sigA = normalized(EPERM_RAW_A);
    const sigB = normalized(EPERM_RAW_B);
    reg.recordFailure({
      ...sigA,
      issueId: "id-1",
      issueIdentifier: "SYMPH-1",
      stageName: "implement",
      now: T0,
    });
    reg.recordFailure({
      ...sigB,
      issueId: "id-2",
      issueIdentifier: "SYMPH-2",
      stageName: "implement",
      now: atOffset(MIN),
    });

    // Operator resumes issue 1 → it is cleared from the cluster (re-counts fresh).
    reg.clearIssueFromCluster("id-1");
    const cluster = reg.getClusters().get(sigA.signature);
    expect(cluster?.members.size).toBe(1);
    expect(cluster?.members.has("id-2")).toBe(true);
  });

  it("re-alerts exactly once on cluster growth, not zero or twice", () => {
    const reg = new SignatureClusterRegistry({ systemicThreshold: 2 });
    const sig = normalized(EPERM_RAW_A);
    const fire = (id: string, ms: number) =>
      reg.recordFailure({
        ...sig,
        issueId: id,
        issueIdentifier: id.toUpperCase(),
        stageName: "implement",
        now: atOffset(ms),
      });

    expect(fire("a", 0).shouldAlert).toBe(false); // size 1
    expect(fire("b", MIN).shouldAlert).toBe(true); // size 2 → first alert
    // Same members re-failing does not grow the cluster → no re-alert.
    expect(fire("a", 2 * MIN).shouldAlert).toBe(false); // size still 2
    expect(fire("b", 3 * MIN).shouldAlert).toBe(false); // size still 2
    // A third DISTINCT issue grows the cluster → exactly one more alert.
    expect(fire("c", 4 * MIN).shouldAlert).toBe(true); // size 3 → re-alert
    expect(fire("c", 5 * MIN).shouldAlert).toBe(false); // size still 3
  });
});

describe("SignatureClusterRegistry — circuit breaker lifecycle", () => {
  it("breaker opens on SYSTEMIC, resume closes it, same-signature recurrence reopens it", () => {
    const reg = new SignatureClusterRegistry({
      systemicThreshold: 2,
      circuitBreakerEnabled: true,
    });
    const sigA = normalized(EPERM_RAW_A);
    const sigB = normalized(EPERM_RAW_B);

    reg.recordFailure({
      ...sigA,
      issueId: "id-1",
      issueIdentifier: "SYMPH-1",
      stageName: "implement",
      now: T0,
    });
    const opened = reg.recordFailure({
      ...sigB,
      issueId: "id-2",
      issueIdentifier: "SYMPH-2",
      stageName: "implement",
      now: atOffset(MIN),
    });
    expect(opened.shouldOpenBreaker).toBe(true);
    expect(reg.isBreakerOpen("implement")).toBe(true);
    expect(reg.getBreakerEntry("implement")?.openedForIssueIds).toContain(
      "id-1",
    );

    // Operator resumes issue 1 → breaker closes (openedForIssueIds includes it).
    const resetStages = reg.resetBreakersForIssue("id-1");
    expect(resetStages.map((entry) => entry.stageName)).toEqual(["implement"]);
    expect(reg.isBreakerOpen("implement")).toBe(false);

    // Half-open canary: a recurrence of the same signature re-crosses
    // threshold and reopens the breaker through the normal path. With the
    // decoupled-reopening fix, the breaker fires as soon as the cluster is
    // systemic again and the stage is clear — on the id-1 recurrence itself
    // (cluster = {id-1, id-2}, size 2 >= threshold, no breaker on stage).
    reg.clearIssueFromCluster("id-1"); // resume also re-counts the issue fresh
    const canary = reg.recordFailure({
      ...sigA,
      issueId: "id-1",
      issueIdentifier: "SYMPH-1",
      stageName: "implement",
      now: atOffset(2 * MIN),
    });
    expect(canary.shouldOpenBreaker).toBe(true);
    expect(reg.isBreakerOpen("implement")).toBe(true);
    // A further failure with the same (or a new) issue does not double-open.
    const further = reg.recordFailure({
      ...sigB,
      issueId: "id-3",
      issueIdentifier: "SYMPH-3",
      stageName: "implement",
      now: atOffset(3 * MIN),
    });
    expect(further.shouldOpenBreaker).toBe(false); // breaker already open
    expect(reg.isBreakerOpen("implement")).toBe(true);
  });

  it("resetBreakersForIssue leaves breakers opened for other issues untouched", () => {
    const reg = new SignatureClusterRegistry({ systemicThreshold: 2 });
    const sig = normalized(EPERM_RAW_A);
    reg.recordFailure({
      ...sig,
      issueId: "id-1",
      issueIdentifier: "SYMPH-1",
      stageName: "implement",
      now: T0,
    });
    reg.recordFailure({
      ...sig,
      issueId: "id-2",
      issueIdentifier: "SYMPH-2",
      stageName: "implement",
      now: atOffset(MIN),
    });
    expect(reg.isBreakerOpen("implement")).toBe(true);

    // Resuming an issue the breaker was NOT opened for is a no-op.
    expect(reg.resetBreakersForIssue("id-999")).toEqual([]);
    expect(reg.isBreakerOpen("implement")).toBe(true);
  });

  it("does not open a breaker when circuitBreakerEnabled is false", () => {
    const reg = new SignatureClusterRegistry({
      systemicThreshold: 2,
      circuitBreakerEnabled: false,
    });
    const sigA = normalized(EPERM_RAW_A);
    const sigB = normalized(EPERM_RAW_B);
    reg.recordFailure({
      ...sigA,
      issueId: "id-1",
      issueIdentifier: "SYMPH-1",
      stageName: "implement",
      now: T0,
    });
    const r = reg.recordFailure({
      ...sigB,
      issueId: "id-2",
      issueIdentifier: "SYMPH-2",
      stageName: "implement",
      now: atOffset(MIN),
    });
    expect(r.shouldAlert).toBe(true);
    expect(r.shouldOpenBreaker).toBe(false);
    expect(reg.isBreakerOpen("implement")).toBe(false);
  });

  it("latest signature wins when a second signature opens a breaker on the same stage", () => {
    const reg = new SignatureClusterRegistry({ systemicThreshold: 2 });
    const sigEperm = normalized(EPERM_RAW_A);
    const sigOom = normalized("FATAL: JavaScript heap out of memory");
    expect(sigEperm.signature).not.toBe(sigOom.signature);

    // First signature opens the breaker.
    reg.recordFailure({
      ...sigEperm,
      issueId: "id-1",
      issueIdentifier: "SYMPH-1",
      stageName: "implement",
      now: T0,
    });
    reg.recordFailure({
      ...sigEperm,
      issueId: "id-2",
      issueIdentifier: "SYMPH-2",
      stageName: "implement",
      now: atOffset(MIN),
    });
    expect(reg.getBreakerEntry("implement")?.signature).toBe(
      sigEperm.signature,
    );

    // A second, distinct signature reaches threshold on the same stage and
    // takes over the breaker (latest wins — the reported cause is the most
    // recent systemic one).
    reg.recordFailure({
      ...sigOom,
      issueId: "id-3",
      issueIdentifier: "SYMPH-3",
      stageName: "implement",
      now: atOffset(2 * MIN),
    });
    reg.recordFailure({
      ...sigOom,
      issueId: "id-4",
      issueIdentifier: "SYMPH-4",
      stageName: "implement",
      now: atOffset(3 * MIN),
    });
    expect(reg.getBreakerEntry("implement")?.signature).toBe(sigOom.signature);
  });

  it("resume canary recurrence reopens the breaker even when cluster returns to the previously-alerted size (Fix 1+2)", () => {
    // Regression: resume shrinks membership but does not lower lastAlertSize.
    // When the canary recurs the cluster returns to size 2 which is NOT > 2,
    // so shouldAlert was false; and the old code gated shouldOpenBreaker on
    // shouldAlert, so the breaker stayed closed. Both fixes together ensure:
    //   (a) lastAlertSize is clamped on clear, so re-growth re-alerts, and
    //   (b) breaker reopening is decoupled from the alert gate.
    //
    // Note: sigA and sigB normalize to the same signature (verified above), so
    // id-1 (sigA) and id-2 (sigB) belong to the same cluster. After clearing
    // id-1, the cluster shrinks to {id-2} size=1. When id-1 recurs it is the
    // *first* call that re-crosses the threshold (size becomes 2 again), so the
    // alert and breaker reopen on that call, not on a subsequent one.
    const reg = new SignatureClusterRegistry({
      systemicThreshold: 2,
      circuitBreakerEnabled: true,
    });
    const sigA = normalized(EPERM_RAW_A);
    const sigB = normalized(EPERM_RAW_B);
    expect(sigA.signature).toBe(sigB.signature); // same cluster

    // id-1 + id-2 open the breaker; lastAlertSize = 2.
    reg.recordFailure({
      ...sigA,
      issueId: "id-1",
      issueIdentifier: "SYMPH-1",
      stageName: "implement",
      now: T0,
    });
    reg.recordFailure({
      ...sigB,
      issueId: "id-2",
      issueIdentifier: "SYMPH-2",
      stageName: "implement",
      now: atOffset(MIN),
    });
    expect(reg.isBreakerOpen("implement")).toBe(true);

    // Operator resumes id-1: clear + reset breaker. Cluster now has {id-2}
    // size=1; lastAlertSize is clamped to 1 (was 2).
    reg.resetBreakersForIssue("id-1");
    reg.clearIssueFromCluster("id-1");
    expect(reg.isBreakerOpen("implement")).toBe(false);
    expect(reg.getClusters().get(sigA.signature)?.lastAlertSize).toBe(1);

    // id-1 fails again — cluster grows from 1 → 2. shouldAlert fires (2 > 1).
    // Breaker is decoupled from the alert gate, so it also reopens here even
    // though under the old code it would not (shouldOpenBreaker was gated on
    // shouldAlert which was false when size == lastAlertSize == 2 pre-fix).
    const canary = reg.recordFailure({
      ...sigA,
      issueId: "id-1",
      issueIdentifier: "SYMPH-1",
      stageName: "implement",
      now: atOffset(2 * MIN),
    });
    expect(canary.shouldAlert).toBe(true);
    expect(canary.shouldOpenBreaker).toBe(true);
    expect(reg.isBreakerOpen("implement")).toBe(true);
  });

  it("displaced signature can reopen the breaker after reset (Fix 2: per-stage truth)", () => {
    // Regression: when signature B overwrites signature A's breaker on a stage,
    // A's entry kept breakerOpen=true. After reset, A could never reopen.
    // With the single-source-of-truth refactor, openness is derived exclusively
    // from stageBreakers, so A can always reopen once the stage is clear.
    const reg = new SignatureClusterRegistry({
      systemicThreshold: 2,
      circuitBreakerEnabled: true,
    });
    const sigEperm = normalized(EPERM_RAW_A);
    const sigOom = normalized("FATAL: JavaScript heap out of memory");

    // Sig A (eperm) opens the breaker first.
    reg.recordFailure({
      ...sigEperm,
      issueId: "id-1",
      issueIdentifier: "SYMPH-1",
      stageName: "implement",
      now: T0,
    });
    reg.recordFailure({
      ...sigEperm,
      issueId: "id-2",
      issueIdentifier: "SYMPH-2",
      stageName: "implement",
      now: atOffset(MIN),
    });
    expect(reg.getBreakerEntry("implement")?.signature).toBe(
      sigEperm.signature,
    );

    // Sig B (OOM) crosses threshold and displaces A from the stage breaker.
    reg.recordFailure({
      ...sigOom,
      issueId: "id-3",
      issueIdentifier: "SYMPH-3",
      stageName: "implement",
      now: atOffset(2 * MIN),
    });
    reg.recordFailure({
      ...sigOom,
      issueId: "id-4",
      issueIdentifier: "SYMPH-4",
      stageName: "implement",
      now: atOffset(3 * MIN),
    });
    expect(reg.getBreakerEntry("implement")?.signature).toBe(sigOom.signature);

    // Operator resets the breaker (e.g. resumes id-3).
    reg.resetBreakersForIssue("id-3");
    expect(reg.isBreakerOpen("implement")).toBe(false);

    // Now a new issue fails with sig A. The stage is clear, so sig A must be
    // able to reopen the breaker — the displaced-entry bug would block this.
    reg.clearIssueFromCluster("id-1");
    reg.clearIssueFromCluster("id-2");
    reg.recordFailure({
      ...sigEperm,
      issueId: "id-1",
      issueIdentifier: "SYMPH-1",
      stageName: "implement",
      now: atOffset(4 * MIN),
    });
    const reopened = reg.recordFailure({
      ...sigEperm,
      issueId: "id-2",
      issueIdentifier: "SYMPH-2",
      stageName: "implement",
      now: atOffset(5 * MIN),
    });

    expect(reopened.shouldOpenBreaker).toBe(true);
    expect(reg.isBreakerOpen("implement")).toBe(true);
    expect(reg.getBreakerEntry("implement")?.signature).toBe(
      sigEperm.signature,
    );
  });
});

describe("SignatureClusterRegistry — watchdog rate limiting (injected clock)", () => {
  it("honors maxFilingsPerHour and reopens the window after an hour", () => {
    const reg = new SignatureClusterRegistry({
      systemicThreshold: 2,
      maxFilingsPerHour: 2,
    });
    const sigA = normalized(EPERM_RAW_A);
    const sigB = normalized(EPERM_RAW_B);
    const sig = sigA.signature;

    // Cross threshold so canFileWatchdogTicket is evaluated.
    reg.recordFailure({
      ...sigA,
      issueId: "id-1",
      issueIdentifier: "SYMPH-1",
      stageName: "implement",
      now: T0,
    });
    const first = reg.recordFailure({
      ...sigB,
      issueId: "id-2",
      issueIdentifier: "SYMPH-2",
      stageName: "implement",
      now: atOffset(MIN),
    });
    expect(first.canFileWatchdogTicket).toBe(true);

    // Record two filings within the hour → limiter is now exhausted.
    reg.recordWatchdogFiling({
      signature: sig,
      issueIdentifier: "WATCH-1",
      now: atOffset(MIN),
    });
    reg.recordWatchdogFiling({
      signature: sig,
      issueIdentifier: "WATCH-2",
      now: atOffset(2 * MIN),
    });

    // A third distinct failure grows the cluster (shouldAlert) but filing is
    // suppressed by the rate limit.
    const third = reg.recordFailure({
      ...sigA,
      issueId: "id-3",
      issueIdentifier: "SYMPH-3",
      stageName: "implement",
      now: atOffset(3 * MIN),
    });
    expect(third.shouldAlert).toBe(true);
    expect(third.canFileWatchdogTicket).toBe(false);

    // After the hour rolls over, the window reopens.
    const fourth = reg.recordFailure({
      ...sigB,
      issueId: "id-4",
      issueIdentifier: "SYMPH-4",
      stageName: "implement",
      now: atOffset(HOUR + 5 * MIN),
    });
    expect(fourth.shouldAlert).toBe(true);
    expect(fourth.canFileWatchdogTicket).toBe(true);
  });

  it("prunes filing records older than one hour on write so the window stays accurate", () => {
    // maxFilingsPerHour = 1: a single in-window record exhausts the limiter.
    const reg = new SignatureClusterRegistry({
      systemicThreshold: 2,
      maxFilingsPerHour: 1,
    });
    const sigA = normalized(EPERM_RAW_A);
    const sigB = normalized(EPERM_RAW_B);
    const sig = sigA.signature;

    // Two stale filings well over an hour before the next write. If pruning on
    // write did not happen, three records would accumulate in the backing
    // array; the rate window only filters at read time, so the behavioral proof
    // is that an old, exhausted window reopens after the records age out.
    reg.recordWatchdogFiling({
      signature: sig,
      issueIdentifier: "WATCH-OLD-1",
      now: T0,
    });
    reg.recordWatchdogFiling({
      signature: sig,
      issueIdentifier: "WATCH-OLD-2",
      now: atOffset(MIN),
    });

    // A fresh write more than an hour later prunes the two stale records and
    // keeps only itself. Now exactly one record is inside the window, which at
    // maxFilingsPerHour=1 means the limiter is exhausted.
    reg.recordWatchdogFiling({
      signature: sig,
      issueIdentifier: "WATCH-FRESH",
      now: atOffset(HOUR + 2 * MIN),
    });

    // Cross threshold shortly after the fresh filing → still inside its window,
    // so filing is suppressed (proves the fresh record is counted).
    reg.recordFailure({
      ...sigA,
      issueId: "id-1",
      issueIdentifier: "SYMPH-1",
      stageName: "implement",
      now: atOffset(HOUR + 3 * MIN),
    });
    const suppressed = reg.recordFailure({
      ...sigB,
      issueId: "id-2",
      issueIdentifier: "SYMPH-2",
      stageName: "implement",
      now: atOffset(HOUR + 4 * MIN),
    });
    expect(suppressed.shouldAlert).toBe(true);
    expect(suppressed.canFileWatchdogTicket).toBe(false);

    // Two hours past the fresh filing, its record has also aged out → filing
    // reopens, proving stale records do not linger and block forever.
    const reopened = reg.recordFailure({
      ...sigA,
      issueId: "id-3",
      issueIdentifier: "SYMPH-3",
      stageName: "implement",
      now: atOffset(3 * HOUR),
    });
    expect(reopened.shouldAlert).toBe(true);
    expect(reopened.canFileWatchdogTicket).toBe(true);
  });
});

describe("formatWatchdogTicketBody — no raw error text egress", () => {
  it("includes signature, class, stage, and member identifiers but NOT raw normalized text", () => {
    const sig = normalized(EPERM_RAW_A);
    const body = formatWatchdogTicketBody({
      signature: sig.signature,
      errorClass: sig.errorClass,
      stageName: "implement",
      observedAt: T0.toISOString(),
      members: [
        {
          issueId: "id-1",
          issueIdentifier: "SYMPH-1",
          stageName: "implement",
          recordedAt: T0.toISOString(),
          normalizedText: sig.normalizedText,
        },
        {
          issueId: "id-2",
          issueIdentifier: "SYMPH-2",
          stageName: "implement",
          recordedAt: atOffset(MIN).toISOString(),
          normalizedText: sig.normalizedText,
        },
      ],
    });

    expect(body).toContain(`watchdog-signature:${sig.signature}`);
    expect(body).toContain(sig.signature);
    expect(body).toContain("permanent");
    expect(body).toContain("implement");
    expect(body).toContain("SYMPH-1");
    expect(body).toContain("SYMPH-2");
    // The raw normalized error text must NOT be embedded (secret/injection
    // surface) — operators read the linked member issues for raw output.
    expect(body).not.toContain(sig.normalizedText);
    expect(body).not.toContain("Normalized Error Pattern");
    expect(body).toContain("Do NOT auto-release");
  });
});
