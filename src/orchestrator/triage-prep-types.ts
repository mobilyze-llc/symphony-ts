import type { PlannerContext } from "../agent/triage-planner.js";
import type { Issue } from "../domain/model.js";
import type { FreshCodeGroundingTarget } from "./code-grounding-fresh-checkout.js";
import type { CodeGroundingConfig } from "./code-grounding.js";

export const TRIAGE_PREP_ARTIFACT_NAME = "triage-prep-evidence.json";
export const TRIAGE_PREP_SCHEMA = "symphony.triage-prep-evidence.v1";
export const TRIAGE_PREP_REPOSITORIES_ENV = "SYMPHONY_TRIAGE_PREP_REPOSITORIES";
/** Per-issue ceiling for raw, read-only triage-prep comment hydration. */
export const TRIAGE_PREP_COMMENT_MAX_PAGES = 10;

/**
 * Enumerable legacy-matching vocabulary mirrored from Crucible's
 * `lib/supervisor-classify.mjs` FAILURE_CLASS_MAP plus its typed queue cases.
 */
export const SUPERVISOR_FAILURE_CLASSES = [
  "controller_crabrunner_entrypoint_missing",
  "out_dir_missing",
  "invalid_spec",
  "missing_dependency",
  "dependency_rejected",
  "dependency_cancelled",
  "dependency_cycle",
  "missing_capability",
  "worker_registry_missing",
  "worker_model_unsupported",
  "provider_auth_unavailable",
  "provider_auth_missing",
  "provider_balance_insufficient",
  "provider_binary_missing",
  "provider_context_unresolvable",
  "model_denied",
  "admission_lock_timeout",
  "staged_runtime_not_ready",
  "staging_failed",
  "staging_build_failed",
  "staging_chmod_failed",
  "staging_lock_timeout",
  "staging_move_failed",
  "staging_output_missing",
  "staging_smoke_failed",
  "staged_path_marker_failed",
  "crabrunner_missing",
  "capacity_contended",
  "host_saturated",
  "queue_saturated",
  "host_unhealthy",
  "host_runtime_unproven",
  "host_unavailable",
  "ssh_fork_eagain",
  "crabbox_exit_7",
  "crabbox_spawn_eagain",
  "crabbox_status_timeout",
  "crabbox_status_observation_failed",
  "crabbox_status_unreconciled_no_artifact",
  "crabbox_submit_timeout",
  "host_unreachable",
  "host_ssh_auth_unavailable",
  "stale_capacity_snapshot",
  "workspace_materialization_failed",
  "workspace_scan_failed",
  "workspace_sync_failed",
  "workspace_sync_apply_failed",
  "workspace_sync_missing",
  "workspace_sync_unsupported",
  "reverse_sync_failed",
  "evidence_unavailable",
  "evidence_unusable",
  "supervisor_events_unreadable",
  "review_p1",
  "review_p2",
  "validation_failed",
  "workspace_validation_failed",
  "acceptance_gate_failed",
  "merge_proof_missing",
  "review_proof_missing",
  "codex_usage_limit",
  "codex_stream_timeout_after_diff",
  "provider_stream_error_after_diff",
  "cursor_cloud_provider_503",
  "crabrunner_unhandled",
  "submit_sync_unprimed",
  "state_integrity",
  "subject_drift",
  "subject_unrepresented",
  "control_plane_unreachable",
] as const;

/**
 * Current findings-intake metadata may carry classes newer than this fork's
 * legacy vocabulary.
 */
export type TriageFailureClass = string;
type TriageAnchorStatus = "exists" | "moved" | "gone";

export interface TriagePrepRepository {
  key: string;
  target: FreshCodeGroundingTarget;
}

export interface ExtractedTriageAnchor {
  key: string;
  raw: string;
  path: string;
  fingerprint: string | null;
  lineRange: [number, number] | null;
}

export interface ExtractedRecurrenceMetadata {
  recurrenceCount: number;
  sessionCount: number | null;
  postDoneRecurrenceCount: number | null;
  doneTwinCount: number | null;
}

export interface ExtractedFindingsIntakeV2Metadata {
  schema: "crucible.findings-intake.v2";
  failureClass: string;
  anchorFingerprint: string;
  anchors: string[];
  fkey: string;
}

export interface ExtractedTriageFinding {
  issueId: string;
  issueIdentifier: string;
  format: "findings_intake_v2" | "mob_1227_metadata" | "legacy";
  anchors: ExtractedTriageAnchor[];
  failureClasses: TriageFailureClass[];
  councilFingerprints: string[];
  recurrenceIdentityKeys: string[];
  recurrenceObservationCount: number;
  relatedIssueIdentifiers: string[];
  recurrenceMetadata: ExtractedRecurrenceMetadata | null;
  findingsIntakeV2: ExtractedFindingsIntakeV2Metadata | null;
}

export interface TriagePrepCommit {
  sha: string;
  title: string;
}

export interface TriagePrepAnchorEvidence {
  anchorKey: string;
  repository: string;
  originMainSha: string;
  status: TriageAnchorStatus;
  currentPath: string | null;
  commitsSinceFiling: TriagePrepCommit[];
  historyPrecision: "cited_lines" | "cited_file";
  reason: string;
}

interface TriagePrepClassEmissionEvidence {
  failureClass: TriageFailureClass;
  repository: string;
  originMainSha: string;
  emittedInProduction: boolean;
  sites: Array<{ path: string; line: number }>;
}

export interface TriagePrepRepositoryInspection {
  repository: string;
  originMainSha: string | null;
  anchors: TriagePrepAnchorEvidence[];
  classEmissions: TriagePrepClassEmissionEvidence[];
  error: string | null;
}

export interface TriagePrepLedgerRow {
  fingerprint: string;
  location: {
    path: string;
    lineRange: [number, number] | null;
  } | null;
  verdict: "confirmed" | "downgraded" | "refuted" | "unknown";
  round: string | number | null;
}

interface TriagePrepCoverageCheck {
  status: "ran" | "partial" | "n/a";
  reason: string;
}

interface TriagePrepRelationSummary {
  identifier: string | null;
  title: string | null;
  state: string | null;
}

export interface TriagePrepEvidenceSheet {
  issueIdentifier: string;
  title: string;
  filedAt: string | null;
  extraction: ExtractedTriageFinding;
  anchorDrift: TriagePrepAnchorEvidence[];
  classEmission: {
    strength: "weak_signal";
    note: string;
    classes: Array<{
      failureClass: TriageFailureClass;
      emittedInProduction: boolean | null;
      emittedAtCitedSite: boolean | null;
      sites: Array<{ repository: string; path: string; line: number }>;
    }>;
  };
  adjudicationHistory: {
    confirmed: number;
    downgraded: number;
    refuted: number;
    unknown: number;
    rounds: Array<string | number>;
  };
  recurrence: {
    source:
      | "mob_1227_metadata"
      | "findings_intake_v2_best_effort"
      | "legacy_best_effort"
      | "unavailable";
    exact: boolean;
    recurrenceCount: number | null;
    sessionCount: number | null;
    postDoneRecurrenceCount: number | null;
    doneTwinCount: number | null;
    visibleRecurrenceCommentCount: number;
    relatedIssueIdentifiers: string[];
  };
  family: {
    parent: TriagePrepRelationSummary | null;
    relations: Array<TriagePrepRelationSummary & { type: string }>;
    sameClassOpenSiblings: string[];
    sameAnchorOpenSiblings: string[];
    members: string[];
  };
  coverage: {
    level: "full" | "partial";
    line: string;
    checks: {
      anchorDrift: TriagePrepCoverageCheck;
      classEmission: TriagePrepCoverageCheck;
      adjudicationHistory: TriagePrepCoverageCheck;
      recurrence: TriagePrepCoverageCheck;
      family: TriagePrepCoverageCheck;
    };
  };
}

export interface TriagePrepEvidenceBatch {
  schema: typeof TRIAGE_PREP_SCHEMA;
  generatedAt: string;
  ephemeral: true;
  sourceRef: "fresh origin/main";
  mutationPolicy: "read_only_no_linear_writes";
  sheets: TriagePrepEvidenceSheet[];
  families: Array<{
    key: string;
    sharedFailureClasses: TriageFailureClass[];
    sharedAnchors: string[];
    members: string[];
    allAnchorsLive: boolean | null;
  }>;
  warnings: string[];
}

export interface PrepareTriagePlannerContextInput {
  context: PlannerContext;
  candidates: readonly Issue[];
  familyCandidates?: readonly Issue[];
  artifactDir: string;
  workspaceRoot: string;
  repositories: readonly TriagePrepRepository[];
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  codeGroundingConfig?: CodeGroundingConfig;
  inspectRepository?: TriagePrepRepositoryInspector;
  loadLedgerRows?: TriagePrepLedgerLoader;
  /**
   * Existing Linear read seam used only for bounded raw evidence hydration.
   * Bodies are not curated, actor-filtered, persisted, or written back.
   */
  fetchIssueComments?: (
    issueId: string,
    options: { maxPages?: number },
  ) => Promise<readonly { body: string }[]>;
}

export type TriagePrepRepositoryInspector = (input: {
  repository: TriagePrepRepository;
  anchors: readonly ExtractedTriageAnchor[];
  failureClasses: readonly TriageFailureClass[];
  filedAtByAnchor: ReadonlyMap<string, string | null>;
  workspaceRoot: string;
  runId: string;
  config: CodeGroundingConfig;
}) => Promise<TriagePrepRepositoryInspection>;

type TriagePrepLedgerLoader = () => Promise<{
  rows: TriagePrepLedgerRow[];
  available: boolean;
  reason: string;
}>;

export interface PrepareTriagePlannerContextResult {
  context: PlannerContext;
  batch: TriagePrepEvidenceBatch;
  artifactPath: string;
}

export interface ShadowTriagePrepInput {
  context: PlannerContext;
  candidates: readonly Issue[];
  familyCandidates: readonly Issue[];
  fetchIssueComments?: PrepareTriagePlannerContextInput["fetchIssueComments"];
  now: () => Date;
}
