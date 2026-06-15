#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const DEFAULT_LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_TEAM_KEY = "SYMPH";
const DEFAULT_PIPELINE_HALT_LABEL = "pipeline-halt";
const CALVER_TRACKING_ISSUE = "SYMPH-267";
const POST_MERGE_GATE_TITLE_PREFIX = "pipeline-halt: post-merge gate failure";
// Keep parsePostMergeGateMarker's regex anchored to this marker family.
const POST_MERGE_GATE_MARKER_PREFIX = "<!-- post-merge-gate";

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
  const prNumber = process.env.POST_MERGE_GATE_PR_NUMBER || null;
  const failedSteps = failedStepsFromEnv();
  const failedStepLines =
    failedSteps.length > 0
      ? failedSteps.map((step) => `- ${step}`).join("\n")
      : "- Gate failed before a named validation step reported failure";

  const prLine = prNumber ? `**PR:** #${prNumber}\n` : "";
  const marker = buildPostMergeGateMarker({ commitSha, prNumber });

  return {
    commitSha,
    shortSha,
    runUrl,
    prNumber: prNumber ?? null,
    failedStepLines,
    marker,
    title: `${POST_MERGE_GATE_TITLE_PREFIX} on ${shortSha}`,
    description: [
      marker,
      "",
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
    comment: [
      marker,
      "",
      "## Post-Merge Gate Failure Rerun",
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

function buildPostMergeGateMarker({ commitSha, prNumber }) {
  return `${POST_MERGE_GATE_MARKER_PREFIX} sha=${commitSha} pr=${prNumber ?? "none"} -->`;
}

function parsePostMergeGateMarker(text) {
  const pattern =
    /<!--\s*post-merge-gate\s+sha=([a-f0-9]{7,64})\s+pr=([0-9]+|none)\s*-->/i;
  const match = pattern.exec(text ?? "");
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  return {
    sha: match[1],
    pr: match[2] === "none" ? null : match[2],
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

function assertIssueLookupShape(data) {
  const nodes = data?.issues?.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error(
      `Malformed Linear issue lookup response: ${JSON.stringify(data)}`,
    );
  }
  return nodes.map((node) => {
    if (
      typeof node?.id !== "string" ||
      typeof node?.identifier !== "string" ||
      typeof node?.url !== "string" ||
      typeof node?.title !== "string" ||
      typeof node?.description !== "string" ||
      typeof node?.state?.type !== "string"
    ) {
      throw new Error(
        `Malformed Linear issue lookup node: ${JSON.stringify(node)}`,
      );
    }
    return node;
  });
}

function findMatchingPipelineHaltIssue(nodes, context) {
  const matches = nodes.filter((node) => {
    if (!node.title.startsWith(POST_MERGE_GATE_TITLE_PREFIX)) {
      return false;
    }
    if (["completed", "canceled"].includes(node.state.type)) {
      return false;
    }
    const marker = parsePostMergeGateMarker(node.description);
    if (marker === null) {
      return false;
    }
    return (
      marker.sha === context.commitSha ||
      (context.prNumber !== null && marker.pr === context.prNumber)
    );
  });
  if (matches.length > 1) {
    throw new Error(
      `Found multiple matching post-merge gate halt issues: ${matches
        .map((issue) => issue.identifier)
        .join(", ")}`,
    );
  }
  return matches[0] ?? null;
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

  const context = buildFailureIssueContent();
  const existingIssueData = await requestLinear(
    endpoint,
    apiKey,
    `query FindExistingPipelineHaltIssues($teamKey: String!, $labelName: String!) {
      issues(
        first: 50,
        filter: {
          team: { key: { eq: $teamKey } },
          labels: { name: { eq: $labelName } },
          state: { type: { nin: ["completed", "canceled"] } }
        }
      ) {
        nodes {
          id
          identifier
          url
          title
          description
          state { type }
        }
      }
    }`,
    { teamKey, labelName },
  );
  const existingIssue = findMatchingPipelineHaltIssue(
    assertIssueLookupShape(existingIssueData),
    context,
  );
  if (existingIssue !== null) {
    const commentData = await requestLinear(
      endpoint,
      apiKey,
      `mutation CommentExistingPipelineHaltIssue($input: CommentCreateInput!) {
        commentCreate(input: $input) { comment { id url } success }
      }`,
      {
        input: {
          issueId: existingIssue.id,
          body: context.comment,
        },
      },
    );
    const comment = commentData?.commentCreate?.comment;
    if (!comment?.id) {
      throw new Error(
        `Failed to comment on existing Linear issue: ${JSON.stringify(commentData)}`,
      );
    }

    const result = { ...existingIssue, action: "updated", comment };
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        `::notice::Updated Linear issue ${existingIssue.identifier}: ${existingIssue.url}`,
      );
    }
    return;
  }

  const issueData = await requestLinear(
    endpoint,
    apiKey,
    `mutation CreatePipelineHaltIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) { issue { id identifier url } success }
    }`,
    {
      input: {
        teamId,
        title: context.title,
        description: context.description,
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
    console.log(JSON.stringify({ ...issue, action: "created" }, null, 2));
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
