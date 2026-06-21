import { describe, expect, it } from "vitest";

import {
  LINEAR_CANDIDATE_ISSUES_BY_SCOPE_QUERY,
  buildCandidateScopeFilter,
} from "../../src/tracker/linear-queries.js";

const STATES = ["Backlog", "Todo"];
const UUID = "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d";

describe("buildCandidateScopeFilter", () => {
  it("team-only scope filters by team key and active states", () => {
    expect(
      buildCandidateScopeFilter({ teamKeys: ["MOB"], activeStates: STATES }),
    ).toEqual({
      team: { key: { in: ["MOB"] } },
      state: { name: { in: STATES } },
    });
  });

  it("project-only scope filters by project slugId", () => {
    expect(
      buildCandidateScopeFilter({
        projectSlug: "abc123",
        activeStates: STATES,
      }),
    ).toEqual({
      project: { slugId: { eq: "abc123" } },
      state: { name: { in: STATES } },
    });
  });

  it("initiative scope filters by name when the value is not a UUID", () => {
    expect(
      buildCandidateScopeFilter({
        initiative: "Healthspanners",
        activeStates: STATES,
      }),
    ).toEqual({
      project: { initiatives: { some: { name: { eq: "Healthspanners" } } } },
      state: { name: { in: STATES } },
    });
  });

  it("initiative scope filters by id when the value is a UUID", () => {
    expect(
      buildCandidateScopeFilter({ initiative: UUID, activeStates: STATES }),
    ).toEqual({
      project: { initiatives: { some: { id: { eq: UUID } } } },
      state: { name: { in: STATES } },
    });
  });

  it("treats an uppercase UUID as an id (case-insensitive detection)", () => {
    const upper = UUID.toUpperCase();
    expect(
      buildCandidateScopeFilter({ initiative: upper, activeStates: STATES }),
    ).toEqual({
      project: { initiatives: { some: { id: { eq: upper } } } },
      state: { name: { in: STATES } },
    });
  });

  it("merges project slugId and initiative into a single project filter", () => {
    expect(
      buildCandidateScopeFilter({
        projectSlug: "abc123",
        initiative: "Healthspanners",
        activeStates: STATES,
      }),
    ).toEqual({
      project: {
        slugId: { eq: "abc123" },
        initiatives: { some: { name: { eq: "Healthspanners" } } },
      },
      state: { name: { in: STATES } },
    });
  });

  it("ANDs team, project, and initiative when all are provided (additive)", () => {
    expect(
      buildCandidateScopeFilter({
        teamKeys: ["MOB"],
        projectSlug: "abc123",
        initiative: UUID,
        activeStates: STATES,
      }),
    ).toEqual({
      team: { key: { in: ["MOB"] } },
      project: {
        slugId: { eq: "abc123" },
        initiatives: { some: { id: { eq: UUID } } },
      },
      state: { name: { in: STATES } },
    });
  });

  it("ignores empty / whitespace-only scope values", () => {
    expect(
      buildCandidateScopeFilter({
        teamKeys: ["MOB", "  "],
        projectSlug: "  ",
        initiative: "",
        activeStates: STATES,
      }),
    ).toEqual({
      team: { key: { in: ["MOB"] } },
      state: { name: { in: STATES } },
    });
  });

  it("throws when no scope (team, project, or initiative) is provided", () => {
    expect(() => buildCandidateScopeFilter({ activeStates: STATES })).toThrow(
      /at least one/i,
    );
    expect(() =>
      buildCandidateScopeFilter({
        teamKeys: [],
        projectSlug: null,
        initiative: null,
        activeStates: STATES,
      }),
    ).toThrow(/at least one/i);
  });

  it("throws when activeStates is empty (builder enforces its own safety contract)", () => {
    expect(() =>
      buildCandidateScopeFilter({ teamKeys: ["MOB"], activeStates: [] }),
    ).toThrow(/active state/i);
  });
});

describe("LINEAR_CANDIDATE_ISSUES_BY_SCOPE_QUERY", () => {
  it("is a composed-filter query reusing the standard issue fields", () => {
    expect(LINEAR_CANDIDATE_ISSUES_BY_SCOPE_QUERY).toContain(
      "SymphonyCandidateIssuesByScope",
    );
    expect(LINEAR_CANDIDATE_ISSUES_BY_SCOPE_QUERY).toContain(
      "$filter: IssueFilter!",
    );
    expect(LINEAR_CANDIDATE_ISSUES_BY_SCOPE_QUERY).toContain("filter: $filter");
    expect(LINEAR_CANDIDATE_ISSUES_BY_SCOPE_QUERY).toMatch(
      /inverseRelations\(first: \$relationFirst\)[\s\S]*pageInfo[\s\S]*hasNextPage/,
    );
  });
});
