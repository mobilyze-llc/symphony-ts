import type {
  DispatcherDecisionCategory,
  DispatcherDecisionEvent,
  DispatcherDecisionOutcome,
  DispatcherDecisionQualityBucket,
  DispatcherDecisionQualitySummary,
  DispatcherRunJournal,
  DispatcherRunJournalEntry,
} from "../domain/model.js";

export function createEmptyDecisionQualityBucket(): DispatcherDecisionQualityBucket {
  return {
    total: 0,
    measured: 0,
    pending: 0,
    exactMatches: 0,
    corrected: 0,
    truePositive: 0,
    falsePositive: 0,
    falseNegative: 0,
    trueNegative: 0,
    unclassified: 0,
    costSensitiveRoutingMisses: 0,
  };
}

export function evaluateDispatcherDecisionQuality(
  events: readonly DispatcherDecisionEvent[],
): DispatcherDecisionQualitySummary {
  const categories: DispatcherDecisionQualitySummary["categories"] = {
    right_sizing: createEmptyDecisionQualityBucket(),
    admission: createEmptyDecisionQualityBucket(),
    re_steer: createEmptyDecisionQualityBucket(),
    model_routing: createEmptyDecisionQualityBucket(),
  };
  const summary: DispatcherDecisionQualitySummary = {
    ...createEmptyDecisionQualityBucket(),
    latestEventAt: null,
    categories,
  };

  for (const event of events) {
    applyDecisionEventMetrics(summary, event);
    applyDecisionEventMetrics(categories[event.category], event);
    if (
      summary.latestEventAt === null ||
      Date.parse(event.timestamp) > Date.parse(summary.latestEventAt)
    ) {
      summary.latestEventAt = event.timestamp;
    }
  }

  return summary;
}

export function extractDispatcherDecisionEvents(
  journal: DispatcherRunJournal,
): DispatcherDecisionEvent[] {
  return journal
    .filter((entry) => entry.kind === "dispatcher_decision")
    .map(readDecisionEventFromEntry)
    .filter((event): event is DispatcherDecisionEvent => event !== null)
    .sort(
      (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
    );
}

function applyDecisionEventMetrics(
  bucket: DispatcherDecisionQualityBucket,
  event: DispatcherDecisionEvent,
): void {
  bucket.total += 1;
  if (event.operatorCorrection !== null) {
    bucket.corrected += 1;
  }

  const referenceOutcome = resolveReferenceOutcome(event);
  if (referenceOutcome === null) {
    bucket.pending += 1;
    return;
  }

  bucket.measured += 1;
  if (referenceOutcome.decision === event.expectedOutcome.decision) {
    bucket.exactMatches += 1;
  }

  const expectedClass = event.expectedOutcome.classification;
  const referenceClass = referenceOutcome.classification;
  if (expectedClass === null || referenceClass === null) {
    bucket.unclassified += 1;
  } else if (expectedClass === "positive" && referenceClass === "positive") {
    bucket.truePositive += 1;
  } else if (expectedClass === "positive" && referenceClass === "negative") {
    bucket.falsePositive += 1;
  } else if (expectedClass === "negative" && referenceClass === "positive") {
    bucket.falseNegative += 1;
  } else {
    bucket.trueNegative += 1;
  }

  if (
    event.category === "model_routing" &&
    event.expectedOutcome.decision === "stay_deterministic" &&
    referenceOutcome.decision === "route_to_strong"
  ) {
    bucket.costSensitiveRoutingMisses += 1;
  }
}

function resolveReferenceOutcome(
  event: DispatcherDecisionEvent,
): DispatcherDecisionOutcome | null {
  return event.operatorCorrection?.outcome ?? event.observedOutcome;
}

function readDecisionEventFromEntry(
  entry: DispatcherRunJournalEntry,
): DispatcherDecisionEvent | null {
  const decision = entry.metadata.decisionEvent;
  if (!isDispatcherDecisionEvent(decision)) {
    return null;
  }
  return decision;
}

function isDispatcherDecisionEvent(
  value: unknown,
): value is DispatcherDecisionEvent {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.decisionId === "string" &&
    isDispatcherDecisionCategory(value.category) &&
    (value.classifier === null || typeof value.classifier === "string") &&
    typeof value.issueId === "string" &&
    typeof value.issueIdentifier === "string" &&
    typeof value.operation === "string" &&
    (value.stage === null || typeof value.stage === "string") &&
    (value.attempt === null || typeof value.attempt === "number") &&
    typeof value.timestamp === "string" &&
    isDecisionContext(value.context) &&
    isDecisionOutcome(value.expectedOutcome) &&
    (value.observedOutcome === null ||
      isDecisionOutcome(value.observedOutcome)) &&
    (value.operatorCorrection === null ||
      isDecisionCorrection(value.operatorCorrection))
  );
}

function isDispatcherDecisionCategory(
  value: unknown,
): value is DispatcherDecisionCategory {
  return (
    value === "right_sizing" ||
    value === "admission" ||
    value === "re_steer" ||
    value === "model_routing"
  );
}

function isDecisionContext(
  value: unknown,
): value is DispatcherDecisionEvent["context"] {
  return (
    isRecord(value) &&
    typeof value.reason === "string" &&
    isStringArray(value.triggerHits) &&
    isStringArray(value.findingKinds) &&
    isStringArray(value.files) &&
    isStringArray(value.workerIds) &&
    isRecord(value.details)
  );
}

function isDecisionOutcome(value: unknown): value is DispatcherDecisionOutcome {
  return (
    isRecord(value) &&
    typeof value.decision === "string" &&
    (value.classification === null ||
      value.classification === "positive" ||
      value.classification === "negative") &&
    typeof value.rationale === "string" &&
    (value.costWeight === null ||
      value.costWeight === "low" ||
      value.costWeight === "medium" ||
      value.costWeight === "high")
  );
}

function isDecisionCorrection(
  value: unknown,
): value is DispatcherDecisionEvent["operatorCorrection"] {
  return (
    isRecord(value) &&
    isDecisionOutcome(value.outcome) &&
    (value.source === "operator" ||
      value.source === "meta_eval" ||
      value.source === "runtime") &&
    typeof value.recordedAt === "string" &&
    (value.note === null || typeof value.note === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}
