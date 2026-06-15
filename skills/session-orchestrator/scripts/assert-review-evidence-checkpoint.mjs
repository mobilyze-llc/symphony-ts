#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

const USAGE =
  "usage: assert-review-evidence-checkpoint.mjs --evidence FILE --reported-head SHA [--trivial-justification TEXT]";
const SHA_RE = /^[0-9a-fA-F]{7,64}$/;

function fail(message, details = []) {
  const result = {
    schemaVersion: 1,
    status: "blocked",
    reason: message,
    details,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 1;
}

function pass(status, evidence, details = []) {
  const result = {
    schemaVersion: 1,
    status,
    reviewedHeadSha: evidence.reviewedHeadSha ?? null,
    prUrl: evidence.prUrl ?? null,
    councilArtifactPath: evidence.councilArtifactPath ?? null,
    degradedReason: evidence.degradedReason ?? null,
    trivialJustification: evidence.trivialJustification ?? null,
    details,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

function readArgs(argv) {
  const args = {
    evidencePath: null,
    reportedHead: null,
    trivialJustification: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--evidence") {
      args.evidencePath = argv[++index] ?? null;
      continue;
    }
    if (token === "--reported-head") {
      args.reportedHead = argv[++index] ?? null;
      continue;
    }
    if (token === "--trivial-justification") {
      args.trivialJustification = argv[++index] ?? null;
      continue;
    }
    if (token === "--help" || token === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function readEvidence(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error("evidence JSON must be an object");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `cannot read evidence JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateReviewedHead(evidence, reportedHead) {
  if (!isNonEmptyString(evidence.reviewedHeadSha)) {
    return "reviewedHeadSha is required";
  }
  if (!SHA_RE.test(evidence.reviewedHeadSha)) {
    return "reviewedHeadSha must be a 7-64 character hex object ID";
  }
  if (!SHA_RE.test(reportedHead)) {
    return "reported head must be a 7-64 character hex object ID";
  }
  if (evidence.reviewedHeadSha !== reportedHead) {
    return `reviewed head ${evidence.reviewedHeadSha} does not match reported head ${reportedHead}`;
  }
  return null;
}

function validatePassEvidence(evidence, reportedHead) {
  const failures = [];
  const headFailure = validateReviewedHead(evidence, reportedHead);
  if (headFailure !== null) {
    failures.push(headFailure);
  }
  if (!isNonEmptyString(evidence.prUrl)) {
    failures.push("prUrl is required for pass evidence");
  }
  if (!isNonEmptyString(evidence.councilArtifactPath)) {
    failures.push("councilArtifactPath is required for pass evidence");
  } else if (!existsSync(evidence.councilArtifactPath)) {
    failures.push(
      `councilArtifactPath does not exist: ${evidence.councilArtifactPath}`,
    );
  }
  if (evidence.cleanPassAssertionExitCode !== 0) {
    failures.push("cleanPassAssertionExitCode must be 0 for pass evidence");
  }
  return failures;
}

function validateDegradedEvidence(evidence, reportedHead) {
  const failures = [];
  const headFailure = validateReviewedHead(evidence, reportedHead);
  if (headFailure !== null) {
    failures.push(headFailure);
  }
  if (!isNonEmptyString(evidence.degradedReason)) {
    failures.push("degradedReason is required for degraded evidence");
  }
  if (!isNonEmptyString(evidence.dirtyState)) {
    failures.push(
      "dirtyState must describe staged, unstaged, and untracked inclusion/exclusion for degraded evidence",
    );
  }
  return failures;
}

function main() {
  let args;
  try {
    args = readArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`,
    );
    return 2;
  }

  if (!isNonEmptyString(args.reportedHead)) {
    process.stderr.write(`--reported-head is required\n${USAGE}\n`);
    return 2;
  }

  if (!isNonEmptyString(args.evidencePath)) {
    if (isNonEmptyString(args.trivialJustification)) {
      return pass("trivial", {
        reviewedHeadSha: args.reportedHead,
        trivialJustification: args.trivialJustification,
      });
    }
    return fail("missing review evidence checkpoint", [
      "default classification is non-trivial; provide pass/degraded evidence or an explicit trivial justification",
    ]);
  }

  if (!existsSync(args.evidencePath)) {
    return fail(`review evidence checkpoint is missing: ${args.evidencePath}`);
  }

  let evidence;
  try {
    evidence = readEvidence(args.evidencePath);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  if (evidence.outcome === "blocked") {
    return fail(
      isNonEmptyString(evidence.reason)
        ? evidence.reason
        : "review evidence checkpoint is blocked",
    );
  }
  if (evidence.outcome === "pass") {
    const failures = validatePassEvidence(evidence, args.reportedHead);
    return failures.length === 0
      ? pass("pass", evidence)
      : fail("invalid pass review evidence checkpoint", failures);
  }
  if (evidence.outcome === "degraded") {
    const failures = validateDegradedEvidence(evidence, args.reportedHead);
    return failures.length === 0
      ? pass("degraded", evidence, [
          "degraded review evidence is operator-visible and must not be reported as a clean done state",
        ])
      : fail("invalid degraded review evidence checkpoint", failures);
  }

  return fail(
    "review evidence checkpoint outcome must be pass, degraded, or blocked",
  );
}

process.exitCode = main();
