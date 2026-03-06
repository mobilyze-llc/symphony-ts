import type { Issue } from "../domain/model.js";

export interface IssueStateSnapshot {
  id: string;
  identifier: string;
  state: string;
}

export interface IssueTracker {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<IssueStateSnapshot[]>;
}
