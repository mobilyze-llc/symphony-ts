import type { StructuralAdvisory } from "../domain/structural-advisory.js";
import type { ClusteringGoldenSetFixture } from "./clustering-benchmark-fixture.js";

export interface ClusteringScore {
  pairwisePrecision: number | null;
  pairwiseRecall: number | null;
  rootIdentificationAccuracy: number | null;
  falseClusterRate: number;
  truePositivePairs: number;
  predictedPairs: number;
  answerKeyPairs: number;
  invalidAdvisoryCount: number;
  invalidMemberCount: number;
  totalAttemptedMemberCount: number;
  invalidMemberRate: number;
}

export interface ValidatedStructuralAdvisories {
  accepted: StructuralAdvisory[];
  invalidAdvisoryCount: number;
  invalidMemberCount: number;
  totalAttemptedMemberCount: number;
  invalidMemberRate: number;
}

export function validateStructuralAdvisoryMembers(
  fixture: ClusteringGoldenSetFixture,
  advisories: readonly StructuralAdvisory[],
): ValidatedStructuralAdvisories {
  const exclusions = new Set(
    fixture.answer_key.exclusions.map((entry) => entry.issue_identifier),
  );
  const allowed = new Set(
    fixture.issues
      .map((issue) => issue.identifier)
      .filter((identifier) => !exclusions.has(identifier)),
  );
  const accepted: StructuralAdvisory[] = [];
  let invalidAdvisoryCount = 0;
  let invalidMemberCount = 0;
  let totalMemberCount = 0;
  for (const advisory of advisories) {
    const invalidMembers = advisory.memberIssueIdentifiers.filter(
      (identifier) => !allowed.has(identifier),
    );
    totalMemberCount += advisory.memberIssueIdentifiers.length;
    invalidMemberCount += invalidMembers.length;
    if (invalidMembers.length > 0) {
      invalidAdvisoryCount += 1;
      continue;
    }
    accepted.push(advisory);
  }
  return {
    accepted,
    invalidAdvisoryCount,
    invalidMemberCount,
    totalAttemptedMemberCount: totalMemberCount,
    invalidMemberRate:
      totalMemberCount === 0 ? 0 : invalidMemberCount / totalMemberCount,
  };
}

export function scoreStructuralAdvisories(
  fixture: ClusteringGoldenSetFixture,
  advisories: readonly StructuralAdvisory[],
): ClusteringScore {
  const validation = validateStructuralAdvisoryMembers(fixture, advisories);
  const exclusions = new Set(
    fixture.answer_key.exclusions.map((entry) => entry.issue_identifier),
  );
  const allowed = new Set(
    fixture.issues
      .map((issue) => issue.identifier)
      .filter((identifier) => !exclusions.has(identifier)),
  );
  const truthPairs = pairSet(
    fixture.answer_key.clusters.map(
      (cluster) => cluster.member_issue_identifiers,
    ),
    allowed,
  );
  // An explicitly named in-corpus root belongs to the cluster it roots:
  // scoring only memberIssueIdentifiers forfeited every root<->member pair
  // when models followed the schema and named the root once, in the root
  // field (recall 0.375 -> ~0.52 counterfactual on the 2026-07-11 runs).
  const augmented = validation.accepted.map((advisory) => {
    const root = normalizeIssueIdentifier(advisory.rootIssueIdentifier);
    if (
      root === null ||
      !allowed.has(root) ||
      advisory.memberIssueIdentifiers.includes(root)
    ) {
      return advisory;
    }
    return {
      ...advisory,
      memberIssueIdentifiers: [...advisory.memberIssueIdentifiers, root],
    };
  });
  const predictedClusters = augmented
    .map((advisory) => [
      ...new Set(
        advisory.memberIssueIdentifiers.filter((identifier) =>
          allowed.has(identifier),
        ),
      ),
    ])
    .filter((members) => members.length >= 2);
  const predictedPairs = pairSet(predictedClusters, allowed);
  const truePositivePairs = [...predictedPairs].filter((pair) =>
    truthPairs.has(pair),
  );
  const rootAssignments = assignPredictionsByOverlap(
    fixture.answer_key.clusters,
    augmented,
  );
  const matchedRoots = fixture.answer_key.clusters.map((cluster, index) => {
    const prediction = rootAssignments.get(index);
    if (prediction === undefined) return false;
    const expectedRoots = new Set(
      [
        cluster.root_issue_identifier,
        ...cluster.absorbed_equivalent_root_identifiers,
      ].filter((identifier): identifier is string => identifier !== null),
    );
    const explicitRoot = normalizeIssueIdentifier(
      prediction.rootIssueIdentifier,
    );
    if (expectedRoots.size === 0) {
      // A null-root key cluster asserts no canonical root exists; declining
      // to name one is the correct answer, not a miss.
      return explicitRoot === null;
    }
    const predictedRoots =
      explicitRoot === null
        ? extractIssueIdentifiers(prediction.rootCauseHypothesis)
        : new Set([explicitRoot]);
    return [...predictedRoots].some((identifier) =>
      expectedRoots.has(identifier),
    );
  });
  const falseClusters = predictedClusters.filter((members) => {
    const pairs = pairSet([members], allowed);
    return pairs.size > 0 && [...pairs].every((pair) => !truthPairs.has(pair));
  }).length;
  return {
    pairwisePrecision:
      predictedPairs.size === 0
        ? null
        : truePositivePairs.length / predictedPairs.size,
    pairwiseRecall:
      truthPairs.size === 0 ? null : truePositivePairs.length / truthPairs.size,
    rootIdentificationAccuracy:
      matchedRoots.length === 0
        ? null
        : matchedRoots.filter(Boolean).length / matchedRoots.length,
    falseClusterRate:
      predictedClusters.length === 0
        ? 0
        : falseClusters / predictedClusters.length,
    truePositivePairs: truePositivePairs.length,
    predictedPairs: predictedPairs.size,
    answerKeyPairs: truthPairs.size,
    invalidAdvisoryCount: validation.invalidAdvisoryCount,
    invalidMemberCount: validation.invalidMemberCount,
    totalAttemptedMemberCount: validation.totalAttemptedMemberCount,
    invalidMemberRate: validation.invalidMemberRate,
  };
}

function pairSet(
  clusters: readonly (readonly string[])[],
  allowed: ReadonlySet<string>,
): Set<string> {
  const pairs = new Set<string>();
  for (const members of clusters) {
    const unique = [
      ...new Set(members.filter((member) => allowed.has(member))),
    ].sort();
    for (let left = 0; left < unique.length; left += 1) {
      for (let right = left + 1; right < unique.length; right += 1) {
        pairs.add(`${unique[left]}\0${unique[right]}`);
      }
    }
  }
  return pairs;
}

function assignPredictionsByOverlap(
  truth: ClusteringGoldenSetFixture["answer_key"]["clusters"],
  predictions: readonly StructuralAdvisory[],
): Map<number, StructuralAdvisory> {
  const pairKeys = truth
    .flatMap((cluster) =>
      predictions.map(
        (prediction) =>
          `${cluster.id}\0${[...new Set(prediction.memberIssueIdentifiers)]
            .sort()
            .join("\0")}`,
      ),
    )
    .sort();
  const pairRank = new Map(pairKeys.map((key, index) => [key, index]));
  const size = Math.max(truth.length, predictions.length);
  if (size === 0) return new Map();
  const pairCount = Math.max(1, truth.length * predictions.length);
  const jaccardFactor = pairCount + 1;
  const overlapFactor = (1_000_000 * jaccardFactor + pairCount) * size + 1;
  const overlaps: number[][] = Array.from({ length: size }, () =>
    Array<number>(size).fill(0),
  );
  const weights: number[][] = Array.from({ length: size }, () =>
    Array<number>(size).fill(0),
  );
  truth.forEach((cluster, truthIndex) => {
    const expected = new Set(cluster.member_issue_identifiers);
    const overlapRow = overlaps[truthIndex];
    const weightRow = weights[truthIndex];
    if (overlapRow === undefined || weightRow === undefined) return;
    predictions.forEach((prediction, predictionIndex) => {
      const predicted = new Set(prediction.memberIssueIdentifiers);
      const overlap = [...expected].filter((identifier) =>
        predicted.has(identifier),
      ).length;
      overlapRow[predictionIndex] = overlap;
      if (overlap === 0) return;
      const union = new Set([...expected, ...predicted]).size;
      const predictionKey = [...predicted].sort().join("\0");
      const key = `${cluster.id}\0${predictionKey}`;
      const tieBonus = pairCount - (pairRank.get(key) ?? pairCount);
      const jaccardUnits = Math.round((overlap / union) * 1_000_000);
      weightRow[predictionIndex] =
        overlap * overlapFactor + jaccardUnits * jaccardFactor + tieBonus;
    });
  });
  const assignments = new Map<number, StructuralAdvisory>();
  for (const [truthIndex, predictionIndex] of maximumWeightAssignment(
    weights,
  )) {
    if ((overlaps[truthIndex]?.[predictionIndex] ?? 0) === 0) continue;
    const prediction = predictions[predictionIndex];
    if (truthIndex < truth.length && prediction !== undefined) {
      assignments.set(truthIndex, prediction);
    }
  }
  return assignments;
}

function maximumWeightAssignment(
  weights: readonly (readonly number[])[],
): Array<[number, number]> {
  const size = weights.length;
  const maxWeight = Math.max(0, ...weights.flat());
  const u = Array<number>(size + 1).fill(0);
  const v = Array<number>(size + 1).fill(0);
  const matchedRow = Array<number>(size + 1).fill(0);
  const predecessor = Array<number>(size + 1).fill(0);
  for (let row = 1; row <= size; row += 1) {
    matchedRow[0] = row;
    const minimum = Array<number>(size + 1).fill(Number.POSITIVE_INFINITY);
    const used = Array<boolean>(size + 1).fill(false);
    let column = 0;
    do {
      used[column] = true;
      const currentRow = matchedRow[column] ?? 0;
      let delta = Number.POSITIVE_INFINITY;
      let nextColumn = 0;
      for (let candidate = 1; candidate <= size; candidate += 1) {
        if (used[candidate]) continue;
        const cost =
          maxWeight - (weights[currentRow - 1]?.[candidate - 1] ?? 0);
        const reduced = cost - (u[currentRow] ?? 0) - (v[candidate] ?? 0);
        if (reduced < (minimum[candidate] ?? Number.POSITIVE_INFINITY)) {
          minimum[candidate] = reduced;
          predecessor[candidate] = column;
        }
        if (
          (minimum[candidate] ?? Number.POSITIVE_INFINITY) < delta ||
          ((minimum[candidate] ?? Number.POSITIVE_INFINITY) === delta &&
            candidate < nextColumn)
        ) {
          delta = minimum[candidate] ?? Number.POSITIVE_INFINITY;
          nextColumn = candidate;
        }
      }
      for (let candidate = 0; candidate <= size; candidate += 1) {
        if (used[candidate]) {
          const assignedRow = matchedRow[candidate] ?? 0;
          u[assignedRow] = (u[assignedRow] ?? 0) + delta;
          v[candidate] = (v[candidate] ?? 0) - delta;
        } else {
          minimum[candidate] =
            (minimum[candidate] ?? Number.POSITIVE_INFINITY) - delta;
        }
      }
      column = nextColumn;
    } while ((matchedRow[column] ?? 0) !== 0);
    do {
      const previous = predecessor[column] ?? 0;
      matchedRow[column] = matchedRow[previous] ?? 0;
      column = previous;
    } while (column !== 0);
  }
  return matchedRow.flatMap((row, column) =>
    column === 0 || row === 0
      ? []
      : [[row - 1, column - 1] as [number, number]],
  );
}

function extractIssueIdentifiers(value: string): Set<string> {
  return new Set(value.toUpperCase().match(/[A-Z][A-Z0-9]+-\d+/g) ?? []);
}

function normalizeIssueIdentifier(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim().toUpperCase() ?? "";
  return /^[A-Z][A-Z0-9]+-\d+$/.test(normalized) ? normalized : null;
}
