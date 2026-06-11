import { execFileSync } from "node:child_process";

/**
 * Verdict commit-status publisher (SYMPH-355).
 *
 * Publishes judge verdicts (e.g. the spec-fidelity lane) as GitHub commit
 * statuses on the workspace's HEAD commit so branch protection and the
 * merge queue — not the orchestrator — enforce LLM judgment: in-band
 * invocation, out-of-band enforcement. Once the status context is marked
 * required, a commit without a passing status cannot merge, even if the
 * orchestrator is buggy, the worker compromised, or the agent
 * prompt-injected. Authority lives in the envelope.
 *
 * Failure semantics: every failure mode here fails OPEN — warn and return
 * false, never throw. That is the safe direction: a status we fail to
 * post simply never exists, so the (future) required check blocks the
 * merge queue and the issue parks visibly. Throwing would convert a
 * reporting failure into a pipeline outage without adding enforcement.
 *
 * Evidence is harness-measured: the commit SHA and remote URL are read
 * from the workspace's own git state by this process. Worker-supplied
 * sha/remote values are never accepted — a worker could otherwise point
 * a passing status at an arbitrary commit.
 */

export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

const HTTPS_REMOTE_PATTERN =
  /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;
const SSH_REMOTE_PATTERN = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/;

/**
 * Parse a GitHub remote URL — https (`https://github.com/owner/repo`) or
 * ssh (`git@github.com:owner/repo`) form, optional trailing `.git` — into
 * its owner/repo pair. Returns null for anything that is not github.com.
 */
export function parseGitHubRepo(remoteUrl: string): GitHubRepoRef | null {
  const trimmed = remoteUrl.trim();
  const match =
    HTTPS_REMOTE_PATTERN.exec(trimmed) ?? SSH_REMOTE_PATTERN.exec(trimmed);
  if (match === null) {
    return null;
  }
  const owner = match[1];
  const repo = match[2];
  if (owner === undefined || repo === undefined) {
    return null;
  }
  return { owner, repo };
}

/** Minimal execFileSync shape so tests can substitute the git calls. */
export type ExecGitFn = (
  file: string,
  args: readonly string[],
  options: { cwd: string; encoding: "utf-8"; timeout: number },
) => string;

export interface PublishVerdictStatusInput {
  /** Workspace whose HEAD commit receives the status (harness-resolved). */
  workspacePath: string;
  issueIdentifier: string;
  /** Status context, e.g. "symphony/spec-fidelity". */
  context: string;
  verdict: "pass" | "rework";
  /** Human-readable summary; GitHub caps descriptions at 140 chars. */
  description: string;
  /** Optional link to the judged evidence (e.g. the verdict comment). */
  targetUrl?: string;
  /** Token override; defaults to GITHUB_TOKEN, then GH_TOKEN. */
  token?: string;
  fetchFn?: typeof fetch;
  execFn?: ExecGitFn;
}

const GIT_TIMEOUT_MS = 10_000;
const PUBLISH_TIMEOUT_MS = 15_000;
const MAX_DESCRIPTION_CHARS = 140;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * POST the verdict as a commit status on the workspace's HEAD commit.
 * Returns true when GitHub accepted the status; false on every failure
 * mode (missing token, unreadable git state, non-GitHub remote, network
 * error, non-2xx response). Never throws — see module docstring.
 */
export async function publishVerdictStatus(
  input: PublishVerdictStatusInput,
): Promise<boolean> {
  const token = input.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token === undefined || token === "") {
    console.warn(
      `[verdict-status] no GitHub token (GITHUB_TOKEN/GH_TOKEN) — skipping ${input.context} status for ${input.issueIdentifier}`,
    );
    return false;
  }

  const execFn: ExecGitFn =
    input.execFn ??
    ((file, args, options) => execFileSync(file, args, options));

  // Harness-measured: sha and remote come from the workspace's own git
  // state, never from worker-supplied input.
  let sha: string;
  let remoteUrl: string;
  try {
    const gitOptions = {
      cwd: input.workspacePath,
      encoding: "utf-8" as const,
      timeout: GIT_TIMEOUT_MS,
    };
    sha = execFn("git", ["rev-parse", "HEAD"], gitOptions).trim();
    remoteUrl = execFn(
      "git",
      ["config", "--get", "remote.origin.url"],
      gitOptions,
    ).trim();
  } catch (error) {
    console.warn(
      `[verdict-status] could not read workspace git state for ${input.issueIdentifier}: ${describeError(error)}`,
    );
    return false;
  }
  if (sha === "") {
    console.warn(
      `[verdict-status] empty HEAD sha for ${input.issueIdentifier} — skipping ${input.context} status`,
    );
    return false;
  }

  const repoRef = parseGitHubRepo(remoteUrl);
  if (repoRef === null) {
    console.warn(
      `[verdict-status] remote is not a GitHub repo for ${input.issueIdentifier} ("${remoteUrl}") — skipping ${input.context} status`,
    );
    return false;
  }

  const url = `https://api.github.com/repos/${repoRef.owner}/${repoRef.repo}/statuses/${sha}`;
  const fetchFn = input.fetchFn ?? fetch;
  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state: input.verdict === "pass" ? "success" : "failure",
        context: input.context,
        description: input.description.slice(0, MAX_DESCRIPTION_CHARS),
        ...(input.targetUrl === undefined
          ? {}
          : { target_url: input.targetUrl }),
      }),
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(
        `[verdict-status] GitHub rejected ${input.context} status for ${input.issueIdentifier}: HTTP ${response.status}`,
      );
      return false;
    }
    return true;
  } catch (error) {
    console.warn(
      `[verdict-status] publish failed for ${input.issueIdentifier}: ${describeError(error)}`,
    );
    return false;
  }
}
