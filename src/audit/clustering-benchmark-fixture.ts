import { readFile } from "node:fs/promises";

import { z } from "zod";

import type { PlannerContext } from "../agent/triage-planner.js";
import type { Issue, IssueRelationRef } from "../domain/model.js";
import { assembleShadowPlannerContext } from "../orchestrator/standing-plan-shadow.js";

const CLUSTERING_GOLDEN_SET_SCHEMA_VERSION = 1;

const TimestampedLabelSchema = z
  .object({ name: z.string().min(1), created_at: z.string().datetime() })
  .strict();
const SnapshotCommentSchema = z
  .object({
    id: z.string().min(1),
    body: z.string(),
    created_at: z.string().datetime(),
  })
  .strict();
const SnapshotRelationSchema = z
  .object({
    type: z.enum([
      "relatesTo",
      "duplicates",
      "duplicatedBy",
      "supersedes",
      "supersededBy",
      "blocks",
      "blockedBy",
      "parent",
      "child",
    ]),
    issue_identifier: z.string().min(1),
    created_at: z.string().datetime(),
  })
  .strict();
const IssueSnapshotSchema = z
  .object({
    identifier: z.string().min(1),
    title: z.string(),
    description: z.string(),
    state: z.string().min(1),
    priority: z.number().int().nullable(),
    labels: z.array(TimestampedLabelSchema),
    comments: z.array(SnapshotCommentSchema),
    relations: z.array(SnapshotRelationSchema),
  })
  .strict();
const AnswerKeyClusterSchema = z
  .object({
    id: z.string().min(1),
    root_issue_identifier: z.string().min(1),
    absorbed_equivalent_root_identifiers: z.array(z.string().min(1)),
    member_issue_identifiers: z.array(z.string().min(1)).min(2),
    rationale: z.string().min(1),
  })
  .strict();
const ExclusionSchema = z
  .object({ issue_identifier: z.string().min(1), rationale: z.string().min(1) })
  .strict();

export const ClusteringGoldenSetFixtureSchema = z
  .object({
    schema_version: z.literal(CLUSTERING_GOLDEN_SET_SCHEMA_VERSION),
    fixture_id: z.string().min(1),
    fixture_kind: z.enum(["positive", "negative_control"]),
    snapshot_cutoff: z.string().datetime(),
    source: z
      .object({
        repository: z.string().min(1),
        document: z.string().min(1),
        commit: z.string().regex(/^[0-9a-f]{40}$/),
      })
      .strict(),
    provenance: z
      .object({
        reconstruction: z.string().min(1),
        re_adjudication: z.string().min(1),
      })
      .strict(),
    issues: z.array(IssueSnapshotSchema).min(1),
    answer_key: z
      .object({
        clusters: z.array(AnswerKeyClusterSchema),
        exclusions: z.array(ExclusionSchema),
      })
      .strict(),
  })
  .strict();

export type ClusteringGoldenSetFixture = z.infer<
  typeof ClusteringGoldenSetFixtureSchema
>;
export async function loadClusteringGoldenSetFixture(
  path: string,
): Promise<ClusteringGoldenSetFixture> {
  const fixture = ClusteringGoldenSetFixtureSchema.parse(
    JSON.parse(await readFile(path, "utf8")),
  );
  validateFixtureReferences(fixture);
  return fixture;
}

export function reconstructFixtureAsOfCutoff(
  fixture: ClusteringGoldenSetFixture,
): ClusteringGoldenSetFixture {
  const cutoff = Date.parse(fixture.snapshot_cutoff);
  return {
    ...fixture,
    issues: fixture.issues.map((issue) => ({
      ...issue,
      labels: issue.labels.filter(
        (label) => Date.parse(label.created_at) <= cutoff,
      ),
      comments: issue.comments.filter(
        (comment) => Date.parse(comment.created_at) <= cutoff,
      ),
      relations: issue.relations.filter(
        (relation) => Date.parse(relation.created_at) <= cutoff,
      ),
    })),
  };
}

export function buildClusteringBenchmarkPlannerContext(
  fixture: ClusteringGoldenSetFixture,
): PlannerContext {
  const reconstructed = reconstructFixtureAsOfCutoff(fixture);
  const excluded = new Set(
    reconstructed.answer_key.exclusions.map((entry) => entry.issue_identifier),
  );
  return assembleShadowPlannerContext({
    candidates: [],
    advisoryInputCandidates: reconstructed.issues
      .filter((issue) => !excluded.has(issue.identifier))
      .map(toIssue),
    structuralAdvisoriesEnabled: true,
    inFlight: [],
    envelope: {
      version: 1,
      concurrencyCeiling: 4,
      allowedRisk: "medium",
      allowedModes: ["parallel-isolated", "shared-surface"],
    },
  });
}

function toIssue(issue: ClusteringGoldenSetFixture["issues"][number]): Issue {
  const identifiers = (
    type: ClusteringGoldenSetFixture["issues"][number]["relations"][number]["type"],
  ): string[] =>
    issue.relations
      .filter((relation) => relation.type === type)
      .map((relation) => relation.issue_identifier);
  const parent = identifiers("parent")?.[0] ?? null;
  const relatesTo = identifiers("relatesTo");
  const duplicates = identifiers("duplicates");
  const duplicatedBy = identifiers("duplicatedBy");
  const supersedes = identifiers("supersedes");
  const supersededBy = identifiers("supersededBy");
  const children = identifiers("child");
  const blockedBy = identifiers("blockedBy");
  return {
    id: issue.identifier,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    state: issue.state,
    priority: issue.priority,
    labels: issue.labels.map((label) => label.name),
    branchName: null,
    url: null,
    blockedBy: blockedBy.map((identifier) => ({
      id: null,
      identifier,
      state: null,
    })),
    relatesTo: relatesTo.map(toIssueRelationRef),
    duplicates: duplicates.map(toIssueRelationRef),
    duplicatedBy: duplicatedBy.map(toIssueRelationRef),
    supersedes: supersedes.map(toIssueRelationRef),
    supersededBy: supersededBy.map(toIssueRelationRef),
    parent: parent === null ? null : toIssueRelationRef(parent),
    children: children.map(toIssueRelationRef),
    createdAt: null,
    updatedAt: null,
  };
}

function toIssueRelationRef(identifier: string): IssueRelationRef {
  return { id: null, identifier, state: null, title: null };
}

function validateFixtureReferences(fixture: ClusteringGoldenSetFixture): void {
  const issueIdentifiers = new Set(
    fixture.issues.map((issue) => issue.identifier),
  );
  const referenced = [
    ...fixture.answer_key.clusters.flatMap((cluster) => [
      cluster.root_issue_identifier,
      ...cluster.absorbed_equivalent_root_identifiers,
      ...cluster.member_issue_identifiers,
    ]),
    ...fixture.answer_key.exclusions.map((entry) => entry.issue_identifier),
  ];
  const missing = referenced.filter(
    (identifier) => !issueIdentifiers.has(identifier),
  );
  if (missing.length > 0) {
    throw new Error(
      `Fixture ${fixture.fixture_id} references missing issues: ${[...new Set(missing)].join(", ")}`,
    );
  }
}
