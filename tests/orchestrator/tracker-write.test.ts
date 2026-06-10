import { describe, expect, it, vi } from "vitest";

import {
  type TrackerIssueReference,
  type TrackerIssueWriteRequest,
  type TrackerIssueWriterClient,
  writeTrackerIssueFromBoundary,
} from "../../src/orchestrator/tracker-write.js";

describe("writeTrackerIssueFromBoundary", () => {
  it("creates a cold-readable follow-up issue with parent linkage", async () => {
    const resolveLabelIdsByNames = vi.fn(async (labelNames: string[]) =>
      labelNames.flatMap((label) => {
        if (label === "supervision") {
          return [{ id: "label-supervision", name: label }];
        }
        if (label === "risk:high") {
          return [{ id: "label-risk-high", name: label }];
        }
        return [];
      }),
    );
    const createIssue = vi.fn(async () => ({
      id: "follow-up-1",
      identifier: "SYMPH-200",
      title:
        "Dispatcher follow-up: actual_write_collision for ISSUE-1 + ISSUE-2",
    }));
    const client = createClient({
      createIssue,
      sourceIssues: [
        createSourceIssue(),
        createSourceIssue({
          id: "2",
          identifier: "ISSUE-2",
          title: "Second issue",
          url: "https://linear.app/mobilyze-llc/issue/ISSUE-2",
          labels: ["risk:high"],
        }),
      ],
      resolveLabelIdsByNames,
    });

    const result = await writeTrackerIssueFromBoundary({
      client,
      request: createRequest(),
      terminalStates: ["Done", "Canceled"],
      now: () => new Date("2026-06-08T23:55:00.000Z"),
    });

    expect(result).toEqual({
      operation: "created",
      issueTitle:
        "Dispatcher follow-up: actual_write_collision for ISSUE-1 + ISSUE-2",
      issueIdentifier: "SYMPH-200",
      parentIdentifier: "MOB-52",
    });
    expect(createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "team-1",
        projectId: "project-1",
        parentId: "parent-1",
        labelIds: expect.arrayContaining([
          "label-supervision",
          "label-risk-high",
        ]),
        title:
          "Dispatcher follow-up: actual_write_collision for ISSUE-1 + ISSUE-2",
        description: expect.stringContaining("## Acceptance Criteria"),
      }),
    );
    expect(resolveLabelIdsByNames).toHaveBeenCalledWith(
      expect.arrayContaining(["supervision", "risk:high"]),
      "SYMPH",
    );
    const createCalls = createIssue.mock.calls as unknown as Array<
      [
        {
          description: string;
        },
      ]
    >;
    const createInput = createCalls[0]?.[0];
    if (createInput === undefined) {
      throw new Error("Expected createIssue to be called.");
    }
    const description = createInput.description;
    expect(description).toContain("## Parent Issue");
    expect(description).toContain(
      "[MOB-52](https://linear.app/mobilyze-llc/issue/MOB-52)",
    );
    expect(description).toContain("## Related Issues");
    expect(description).toContain(
      "[ISSUE-1](https://linear.app/mobilyze-llc/issue/ISSUE-1)",
    );
    expect(description).toContain(
      "[ISSUE-2](https://linear.app/mobilyze-llc/issue/ISSUE-2)",
    );
    expect(description).toContain("## Relevant Labels");
    expect(description).toContain("- supervision");
    expect(description).toContain("- risk:high");
  });

  it("updates an existing open follow-up instead of creating a duplicate", async () => {
    const updateIssue = vi.fn(async () => ({
      id: "follow-up-1",
      identifier: "SYMPH-200",
      title:
        "Dispatcher follow-up: actual_write_collision for ISSUE-1 + ISSUE-2",
    }));
    const client = createClient({
      updateIssue,
      openIssuesByTitle: [
        createSourceIssue({
          id: "follow-up-1",
          identifier: "SYMPH-200",
          title:
            "Dispatcher follow-up: actual_write_collision for ISSUE-1 + ISSUE-2",
          description: [
            "<!-- symphony-tracker-write -->",
            "<!-- boundary:explicit_finding:running:actual_write_collision -->",
            "<!-- source-issue-ids:1,2 -->",
          ].join("\n"),
          projectId: "project-1",
          teamId: "team-1",
          parent: null,
          labels: [],
          url: "https://linear.app/mobilyze-llc/issue/SYMPH-200",
        }),
      ],
    });

    const result = await writeTrackerIssueFromBoundary({
      client,
      request: createRequest(),
      terminalStates: ["Done", "Canceled"],
    });

    expect(result.operation).toBe("updated");
    expect(updateIssue).toHaveBeenCalledTimes(1);
    expect(client.createIssue).not.toHaveBeenCalled();
  });

  it("creates a new follow-up when a same-title issue lacks matching source refs", async () => {
    const client = createClient({
      openIssuesByTitle: [
        createSourceIssue({
          id: "follow-up-1",
          identifier: "SYMPH-200",
          title:
            "Dispatcher follow-up: actual_write_collision for ISSUE-1 + ISSUE-2",
          description: "## Scope\nUnrelated work item.",
          projectId: "project-1",
          teamId: "team-1",
          parent: null,
          labels: [],
          url: "https://linear.app/mobilyze-llc/issue/SYMPH-200",
        }),
      ],
    });

    await writeTrackerIssueFromBoundary({
      client,
      request: createRequest(),
      terminalStates: ["Done", "Canceled"],
    });

    expect(client.createIssue).toHaveBeenCalledTimes(1);
    expect(client.updateIssue).not.toHaveBeenCalled();
  });

  it("creates a bounded follow-up issue for prototype promotion boundaries", async () => {
    const createIssue = vi.fn(async () => ({
      id: "follow-up-2",
      identifier: "SYMPH-201",
      title: "Dispatcher follow-up: prototype promotion for ISSUE-1",
    }));
    const client = createClient({
      createIssue,
      sourceIssues: [
        createSourceIssue({
          labels: ["mode:prototype", "risk:high"],
        }),
      ],
    });

    const result = await writeTrackerIssueFromBoundary({
      client,
      request: createPromotionBoundaryRequest(),
      terminalStates: ["Done", "Canceled"],
      now: () => new Date("2026-06-09T00:20:00.000Z"),
    });

    expect(result).toEqual({
      operation: "created",
      issueTitle: "Dispatcher follow-up: prototype promotion for ISSUE-1",
      issueIdentifier: "SYMPH-201",
      parentIdentifier: "MOB-52",
    });
    expect(createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "team-1",
        projectId: "project-1",
        parentId: "parent-1",
        labelIds: expect.arrayContaining([
          "label-mode-prototype",
          "label-risk-high",
        ]),
        title: "Dispatcher follow-up: prototype promotion for ISSUE-1",
        description: expect.stringContaining(
          "Prototype boundary reached for ISSUE-1; promotion requires a new gated production unit.",
        ),
      }),
    );
  });

  it("updates an existing open promotion-boundary follow-up instead of creating a duplicate", async () => {
    const updateIssue = vi.fn(async () => ({
      id: "follow-up-2",
      identifier: "SYMPH-201",
      title: "Dispatcher follow-up: prototype promotion for ISSUE-1",
    }));
    const client = createClient({
      updateIssue,
      openIssuesByTitle: [
        createSourceIssue({
          id: "follow-up-2",
          identifier: "SYMPH-201",
          title: "Dispatcher follow-up: prototype promotion for ISSUE-1",
          description: [
            "<!-- symphony-tracker-write -->",
            "<!-- boundary:promotion_boundary:prototype promotion for ISSUE-1 -->",
            "<!-- source-issue-ids:1 -->",
          ].join("\n"),
          projectId: "project-1",
          teamId: "team-1",
          parent: null,
          labels: [],
          url: "https://linear.app/mobilyze-llc/issue/SYMPH-201",
        }),
      ],
    });

    const result = await writeTrackerIssueFromBoundary({
      client,
      request: createPromotionBoundaryRequest(),
      terminalStates: ["Done", "Canceled"],
    });

    expect(result.operation).toBe("updated");
    expect(updateIssue).toHaveBeenCalledTimes(1);
    expect(client.createIssue).not.toHaveBeenCalled();
  });

  it("reports failures with request context before rethrowing", async () => {
    const onFailure = vi.fn();
    const client = createClient({
      fetchIssueReferencesByIds: vi.fn(async () => {
        throw new Error("tracker unavailable");
      }),
    });

    await expect(
      writeTrackerIssueFromBoundary({
        client,
        request: createRequest(),
        terminalStates: ["Done", "Canceled"],
        onFailure,
      }),
    ).rejects.toThrow("tracker unavailable");

    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        title:
          "Dispatcher follow-up: actual_write_collision for ISSUE-1 + ISSUE-2",
        sourceIssueIds: ["1", "2"],
        error: expect.any(Error),
      }),
    );
  });

  it("reports label resolution failures with follow-up context before rethrowing", async () => {
    const onFailure = vi.fn();
    const error = Object.assign(
      new Error("Linear API request failed with HTTP 400."),
      {
        code: "linear_api_status",
        status: 400,
        details: {
          operationName: "SymphonyIssueLabelsByNames",
          variables: {
            teamKey: "SYMPH",
            labelNames: ["supervision"],
          },
        },
      },
    );
    const client = createClient({
      resolveLabelIdsByNames: vi.fn(async () => {
        throw error;
      }),
    });

    await expect(
      writeTrackerIssueFromBoundary({
        client,
        request: createRequest(),
        terminalStates: ["Done", "Canceled"],
        onFailure,
      }),
    ).rejects.toThrow("Linear API request failed with HTTP 400.");

    expect(client.createIssue).not.toHaveBeenCalled();
    expect(client.updateIssue).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        title:
          "Dispatcher follow-up: actual_write_collision for ISSUE-1 + ISSUE-2",
        sourceIssueIds: ["1", "2"],
        error,
      }),
    );
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["blank", "   "],
  ] as const)(
    "fails closed before label resolution when the source issue team key is %s",
    async (_label, teamKey) => {
      const onFailure = vi.fn();
      const client = createClient({
        sourceIssues: [createSourceIssue({ teamKey })],
      });

      await expect(
        writeTrackerIssueFromBoundary({
          client,
          request: createRequest(),
          terminalStates: ["Done", "Canceled"],
          onFailure,
        }),
      ).rejects.toThrow(
        "Tracker write source issue ISSUE-1 is missing team/project context.",
      );

      expect(client.resolveLabelIdsByNames).not.toHaveBeenCalled();
      expect(client.createIssue).not.toHaveBeenCalled();
      expect(client.updateIssue).not.toHaveBeenCalled();
      expect(onFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          title:
            "Dispatcher follow-up: actual_write_collision for ISSUE-1 + ISSUE-2",
          sourceIssueIds: ["1", "2"],
          error: expect.objectContaining({
            message:
              "Tracker write source issue ISSUE-1 is missing team/project context.",
          }),
        }),
      );
    },
  );
});

function createClient(overrides?: {
  sourceIssues?: TrackerIssueReference[];
  openIssuesByTitle?: TrackerIssueReference[];
  fetchIssueReferencesByIds?: TrackerIssueWriterClient["fetchIssueReferencesByIds"];
  findOpenIssuesByTitle?: TrackerIssueWriterClient["findOpenIssuesByTitle"];
  resolveLabelIdsByNames?: TrackerIssueWriterClient["resolveLabelIdsByNames"];
  createIssue?: TrackerIssueWriterClient["createIssue"];
  updateIssue?: TrackerIssueWriterClient["updateIssue"];
}) {
  const createIssue = vi.fn(
    overrides?.createIssue ??
      (async () => ({
        id: "follow-up-1",
        identifier: "SYMPH-200",
        title:
          "Dispatcher follow-up: actual_write_collision for ISSUE-1 + ISSUE-2",
      })),
  );
  const updateIssue = vi.fn(
    overrides?.updateIssue ??
      (async () => ({
        id: "follow-up-1",
        identifier: "SYMPH-200",
        title:
          "Dispatcher follow-up: actual_write_collision for ISSUE-1 + ISSUE-2",
      })),
  );

  return {
    fetchIssueReferencesByIds:
      overrides?.fetchIssueReferencesByIds ??
      vi.fn(async () => overrides?.sourceIssues ?? [createSourceIssue()]),
    findOpenIssuesByTitle:
      overrides?.findOpenIssuesByTitle ??
      vi.fn(async () => overrides?.openIssuesByTitle ?? []),
    resolveLabelIdsByNames:
      overrides?.resolveLabelIdsByNames ??
      vi.fn(async (labelNames: string[]) =>
        labelNames.flatMap((label) => {
          if (label === "supervision") {
            return [{ id: "label-supervision", name: label }];
          }
          if (label === "mode:prototype") {
            return [{ id: "label-mode-prototype", name: label }];
          }
          if (label === "risk:high") {
            return [{ id: "label-risk-high", name: label }];
          }
          return [];
        }),
      ),
    createIssue,
    updateIssue,
  };
}

function createRequest(): TrackerIssueWriteRequest {
  return {
    boundary: {
      type: "explicit_finding",
      phase: "running",
      finding: {
        kind: "actual_write_collision",
        action: "pause",
        workerIds: ["1", "2"],
        issueIdentifiers: ["ISSUE-1", "ISSUE-2"],
        files: ["src/shared/config.ts"],
        message: "ISSUE-1 and ISSUE-2 changed the same file set.",
      },
    },
  };
}

function createPromotionBoundaryRequest(): TrackerIssueWriteRequest {
  return {
    boundary: {
      type: "promotion_boundary",
      label: "prototype promotion for ISSUE-1",
      summary:
        "Prototype boundary reached for ISSUE-1; promotion requires a new gated production unit.",
      sourceIssueIds: ["1"],
    },
  };
}

function createSourceIssue(
  overrides?: Partial<TrackerIssueReference>,
): TrackerIssueReference {
  return {
    id: "1",
    identifier: "ISSUE-1",
    title: "First issue",
    description: null,
    url: "https://linear.app/mobilyze-llc/issue/ISSUE-1",
    teamId: "team-1",
    teamKey: "SYMPH",
    projectId: "project-1",
    projectSlug: "symphony",
    labels: ["risk:high"],
    parent: {
      id: "parent-1",
      identifier: "MOB-52",
      title: "Orchestration spine",
      url: "https://linear.app/mobilyze-llc/issue/MOB-52",
    },
    ...overrides,
  };
}
