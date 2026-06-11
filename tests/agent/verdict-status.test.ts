import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ExecGitFn,
  type PublishVerdictStatusInput,
  parseGitHubRepo,
  publishVerdictStatus,
} from "../../src/agent/verdict-status.js";

const SHA = "f7f48ab36080aa01205fd928ffa85b2c96a4beef";

function fakeExec(outputs: Record<string, string>): ExecGitFn {
  return (file, args) => {
    const key = `${file} ${args.join(" ")}`;
    const output = outputs[key];
    if (output === undefined) {
      throw new Error(`unexpected exec: ${key}`);
    }
    return output;
  };
}

const HAPPY_EXEC = fakeExec({
  "git rev-parse HEAD": `${SHA}\n`,
  "git config --get remote.origin.url":
    "https://github.com/mobilyze-llc/symphony-ts.git\n",
});

function publishInput(
  overrides?: Partial<PublishVerdictStatusInput>,
): PublishVerdictStatusInput {
  return {
    workspacePath: "/tmp/workspace",
    issueIdentifier: "SYMPH-355",
    context: "symphony/spec-fidelity",
    verdict: "pass",
    description: "pass: all ACs satisfied",
    token: "ghp_test-token",
    execFn: HAPPY_EXEC,
    ...overrides,
  };
}

describe("parseGitHubRepo", () => {
  it("parses https remotes with and without .git", () => {
    expect(
      parseGitHubRepo("https://github.com/mobilyze-llc/symphony-ts.git"),
    ).toEqual({ owner: "mobilyze-llc", repo: "symphony-ts" });
    expect(
      parseGitHubRepo("https://github.com/mobilyze-llc/symphony-ts"),
    ).toEqual({ owner: "mobilyze-llc", repo: "symphony-ts" });
  });

  it("parses ssh remotes with and without .git", () => {
    expect(
      parseGitHubRepo("git@github.com:mobilyze-llc/symphony-ts.git"),
    ).toEqual({ owner: "mobilyze-llc", repo: "symphony-ts" });
    expect(parseGitHubRepo("git@github.com:mobilyze-llc/symphony-ts")).toEqual({
      owner: "mobilyze-llc",
      repo: "symphony-ts",
    });
  });

  it("returns null for non-GitHub remotes and malformed URLs", () => {
    expect(parseGitHubRepo("https://gitlab.com/owner/repo.git")).toBeNull();
    expect(parseGitHubRepo("git@bitbucket.org:owner/repo.git")).toBeNull();
    expect(parseGitHubRepo("https://github.com/owner-only")).toBeNull();
    expect(parseGitHubRepo("not a remote at all")).toBeNull();
    expect(parseGitHubRepo("")).toBeNull();
  });
});

describe("publishVerdictStatus", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("POSTs a success status to the harness-measured owner/repo/sha for a pass verdict", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input);
        expect(url).toBe(
          `https://api.github.com/repos/mobilyze-llc/symphony-ts/statuses/${SHA}`,
        );
        expect(init?.method).toBe("POST");
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe("Bearer ghp_test-token");
        expect(headers.Accept).toBe("application/vnd.github+json");
        const body = JSON.parse(String(init?.body));
        expect(body.state).toBe("success");
        expect(body.context).toBe("symphony/spec-fidelity");
        expect(body.target_url).toBeUndefined();
        return new Response("{}", { status: 201 });
      },
    );

    const published = await publishVerdictStatus(
      publishInput({ fetchFn: fetchFn as unknown as typeof fetch }),
    );

    expect(published).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("maps a rework verdict to a failure state and truncates the description to 140 chars", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const longDescription = `rework: ${"missing AC evidence ".repeat(20)}`;
    const fetchFn = vi.fn(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.state).toBe("failure");
        expect(body.description).toHaveLength(140);
        expect(body.description).toBe(longDescription.slice(0, 140));
        return new Response("{}", { status: 201 });
      },
    );

    const published = await publishVerdictStatus(
      publishInput({
        verdict: "rework",
        description: longDescription,
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    );

    expect(published).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("includes target_url when provided", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = vi.fn(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.target_url).toBe("https://example.com/evidence");
        return new Response("{}", { status: 201 });
      },
    );

    const published = await publishVerdictStatus(
      publishInput({
        targetUrl: "https://example.com/evidence",
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    );

    expect(published).toBe(true);
  });

  it("returns false without calling fetch when no token is available", async () => {
    vi.stubEnv("GITHUB_TOKEN", undefined);
    vi.stubEnv("GH_TOKEN", undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = vi.fn();

    const { token: _token, ...inputWithoutToken } = publishInput({
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const published = await publishVerdictStatus(inputWithoutToken);

    expect(published).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns false without calling fetch when git state is unreadable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = vi.fn();

    const published = await publishVerdictStatus(
      publishInput({
        execFn: () => {
          throw new Error("not a git repository");
        },
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    );

    expect(published).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns false without calling fetch when the remote is not GitHub", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = vi.fn();

    const published = await publishVerdictStatus(
      publishInput({
        execFn: fakeExec({
          "git rev-parse HEAD": `${SHA}\n`,
          "git config --get remote.origin.url":
            "https://gitlab.com/owner/repo.git\n",
        }),
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    );

    expect(published).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns false on a non-2xx response instead of throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = vi.fn(
      async () => new Response("validation failed", { status: 422 }),
    );

    const published = await publishVerdictStatus(
      publishInput({ fetchFn: fetchFn as unknown as typeof fetch }),
    );

    expect(published).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns false when fetch itself rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = vi.fn(async () => {
      throw new Error("network unreachable");
    });

    const published = await publishVerdictStatus(
      publishInput({ fetchFn: fetchFn as unknown as typeof fetch }),
    );

    expect(published).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });
});
