#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const DEFAULT_LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_TEAM_KEY = "SYMPH";
const DEFAULT_PIPELINE_HALT_LABEL = "pipeline-halt";
const CALVER_TRACKING_ISSUE = "SYMPH-267";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {
    command,
    json: false,
    summary: false,
    packageJson: "package.json",
    today: process.env.POST_MERGE_GATE_TODAY,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--summary") {
      options.summary = true;
    } else if (arg === "--package-json") {
      options.packageJson = rest[index + 1];
      index += 1;
    } else if (arg === "--today") {
      options.today = rest[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/post-merge-gate.mjs calver-plan [--json] [--summary] [--package-json path] [--today YYYY.MM.DD]",
    "  node scripts/post-merge-gate.mjs linear-failure-issue [--json]",
  ].join("\n");
}

function utcToday() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${year}.${month}.${day}`;
}

function readPackageVersion(packageJsonPath) {
  const pkg = JSON.parse(readFileSync(resolve(packageJsonPath), "utf8"));
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error(
      `${packageJsonPath} must contain a non-empty version string.`,
    );
  }
  return pkg.version;
}

function computeNextCalverVersion(currentVersion, today = utcToday()) {
  if (!/^\d{4}\.\d{2}\.\d{2}$/.test(today)) {
    throw new Error(`Invalid calver date: ${today}`);
  }

  const [year, month, day, sequence] = currentVersion.split(".");
  const currentPrefix = [year, month, day].join(".");
  const currentSequence = Number.parseInt(sequence ?? "0", 10);
  const nextSequence =
    currentPrefix === today && Number.isInteger(currentSequence)
      ? currentSequence + 1
      : 1;

  return `${today}.${nextSequence}`;
}

function appendGithubOutput(values) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;

  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  appendFileSync(outputPath, `${lines.join("\n")}\n`);
}

function appendGithubSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  appendFileSync(summaryPath, `${markdown.trim()}\n\n`);
}

function runCalverPlan(options) {
  const currentVersion = readPackageVersion(options.packageJson);
  const today = options.today ?? utcToday();
  const nextVersion = computeNextCalverVersion(currentVersion, today);
  const result = {
    currentVersion,
    nextVersion,
    mode: "non_blocking",
    trackingIssue: CALVER_TRACKING_ISSUE,
    reason:
      "Post-merge direct pushes to main are incompatible with merge queue protection.",
  };

  appendGithubOutput({
    current_version: currentVersion,
    next_version: nextVersion,
    tracking_issue: CALVER_TRACKING_ISSUE,
  });

  const summary = [
    "### Calver bump",
    "",
    `- Current package version: \`${currentVersion}\``,
    `- Next calculated version: \`${nextVersion}\``,
    `- Status: non-blocking; tracked by ${CALVER_TRACKING_ISSUE}`,
    "",
    "The post-merge gate no longer pushes directly to protected `main`.",
  ].join("\n");

  if (options.summary) {
    appendGithubSummary(summary);
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `::notice::Calver bump ${currentVersion} -> ${nextVersion} is tracked by ${CALVER_TRACKING_ISSUE}; direct main pushes are disabled.`,
    );
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function failedStepsFromEnv() {
  const stepOutcomes = [
    ["Lint", process.env.STEP_LINT_OUTCOME],
    ["Typecheck", process.env.STEP_TYPECHECK_OUTCOME],
    ["Test", process.env.STEP_TEST_OUTCOME],
    ["Build", process.env.STEP_BUILD_OUTCOME],
    ["Calver follow-up", process.env.STEP_CALVER_OUTCOME],
  ];

  return stepOutcomes
    .filter(([, outcome]) => outcome === "failure")
    .map(([name]) => name);
}

function buildFailureIssueContent() {
  const commitSha = requireEnv("GITHUB_SHA");
  const shortSha = commitSha.slice(0, 7);
  const runUrl = `${requireEnv("GITHUB_SERVER_URL")}/${requireEnv(
    "GITHUB_REPOSITORY",
  )}/actions/runs/${requireEnv("GITHUB_RUN_ID")}`;
  const prNumber = process.env.POST_MERGE_GATE_PR_NUMBER;
  const failedSteps = failedStepsFromEnv();
  const failedStepLines =
    failedSteps.length > 0
      ? failedSteps.map((step) => `- ${step}`).join("\n")
      : "- Gate failed before a named validation step reported failure";

  const prLine = prNumber ? `**PR:** #${prNumber}\n` : "";

  return {
    title: `pipeline-halt: post-merge gate failure on ${shortSha}`,
    description: [
      "## Post-Merge Gate Failure",
      "",
      `**Commit:** ${commitSha}`,
      prLine.trimEnd(),
      `**Run:** ${runUrl}`,
      "",
      "**Failed steps:**",
      failedStepLines,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

async function requestLinear(endpoint, apiKey, query, variables) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  const bodyText = await response.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new Error(`Linear returned non-JSON response: ${bodyText}`);
  }

  if (!response.ok) {
    throw new Error(`Linear request failed with HTTP ${response.status}.`);
  }
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new Error(`Linear GraphQL errors: ${JSON.stringify(body.errors)}`);
  }

  return body.data;
}

async function runLinearFailureIssue(options) {
  const apiKey = requireEnv("LINEAR_API_KEY");
  const endpoint = process.env.LINEAR_ENDPOINT ?? DEFAULT_LINEAR_ENDPOINT;
  const teamKey = process.env.LINEAR_TEAM_KEY ?? DEFAULT_TEAM_KEY;
  const labelName =
    process.env.LINEAR_PIPELINE_HALT_LABEL ?? DEFAULT_PIPELINE_HALT_LABEL;

  const lookupData = await requestLinear(
    endpoint,
    apiKey,
    `query PostMergeGateLookup($teamKey: String!, $labelName: String!) {
      teams(filter: { key: { eq: $teamKey } }) { nodes { id } }
      issueLabels(filter: { name: { eq: $labelName } }) { nodes { id } }
    }`,
    { teamKey, labelName },
  );

  const teamId = lookupData?.teams?.nodes?.[0]?.id;
  if (!teamId) {
    throw new Error(`Failed to look up ${teamKey} team ID from Linear.`);
  }

  let labelId = lookupData?.issueLabels?.nodes?.[0]?.id;
  if (!labelId) {
    const labelData = await requestLinear(
      endpoint,
      apiKey,
      `mutation CreatePipelineHaltLabel($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) { issueLabel { id } success }
      }`,
      {
        input: {
          name: labelName,
          color: "#eb5757",
          teamId,
        },
      },
    );
    labelId = labelData?.issueLabelCreate?.issueLabel?.id;
  }

  const { title, description } = buildFailureIssueContent();
  const issueData = await requestLinear(
    endpoint,
    apiKey,
    `mutation CreatePipelineHaltIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) { issue { id identifier url } success }
    }`,
    {
      input: {
        teamId,
        title,
        description,
        ...(labelId ? { labelIds: [labelId] } : {}),
      },
    },
  );

  const issue = issueData?.issueCreate?.issue;
  if (!issue?.url || !issue?.identifier) {
    throw new Error(
      `Failed to create Linear issue: ${JSON.stringify(issueData)}`,
    );
  }

  if (options.json) {
    console.log(JSON.stringify(issue, null, 2));
  } else {
    console.log(
      `::notice::Created Linear issue ${issue.identifier}: ${issue.url}`,
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.command === "calver-plan") {
    runCalverPlan(options);
  } else if (options.command === "linear-failure-issue") {
    await runLinearFailureIssue(options);
  } else {
    throw new Error(usage());
  }
}

main().catch((error) => {
  console.error(
    `::error::${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
