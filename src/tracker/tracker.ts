import type { Issue } from "../domain/model.js";

export interface IssueStateSnapshot {
  id: string;
  identifier: string;
  state: string;
}

export interface IssueTracker {
  fetchCandidateIssues(): Promise<Issue[]>;
  /**
   * Timestamp (ISO) of the most recent transition INTO the named state, or
   * null when no such transition is visible. Optional: trackers without
   * history support leave the resume guard on observation-only semantics
   * (SYMPH-291).
   */
  fetchLatestStateTransitionAt?(
    issueId: string,
    stateName: string,
  ): Promise<string | null>;
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<IssueStateSnapshot[]>;
  fetchIssuesByLabels?(labelNames: string[]): Promise<Issue[]>;
  fetchOpenIssuesByLabels?(
    labelNames: string[],
    excludeStateNames: string[],
  ): Promise<Issue[]>;
  fetchParent?(
    issueId: string,
  ): Promise<{ identifier: string; title: string; url: string } | null>;
  createIssue?(input: {
    teamId: string;
    title: string;
    projectId: string;
    labelIds: string[];
    description?: string;
    parentId?: string;
  }): Promise<{ id: string; identifier: string; title: string }>;
}
