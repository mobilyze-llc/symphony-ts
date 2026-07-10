import { createHash } from "node:crypto";

import type {
  PlanDecisionKind,
  StandingPlan,
} from "../domain/standing-plan.js";
import type {
  LinearDocumentComment,
  LinearDocumentRef,
} from "../tracker/linear-documents.js";
import { resolveDocComment } from "./standing-plan-comment-resolve.js";
import {
  type DocChangelogEntry,
  type DocInFlightEntry,
  type DocShippedEntry,
  type RenderStandingPlanControlDocInput,
  STANDING_PLAN_DOC_TITLE,
  renderStandingPlanControlDoc,
} from "./standing-plan-doc-render.js";

// ---------------------------------------------------------------------------
// Control-surface orchestration (SYMPH-790 publish + SYMPH-791 ingest).
//
// Both functions take injected dependencies (doc client, store callbacks,
// notifier, allowlist) so the orchestration is unit-testable without the Linear
// network. The runtime-host wires the production deps; the live document API is
// verified at deploy (shadow).
// ---------------------------------------------------------------------------

type LogFn = (
  event: string,
  message: string,
  fields: Record<string, unknown>,
) => void | Promise<void>;

export interface PublishControlDocDeps {
  plan: StandingPlan;
  context: {
    recentlyShipped: DocShippedEntry[];
    inFlight: DocInFlightEntry[];
    changelog: DocChangelogEntry[];
    triageIntake?: RenderStandingPlanControlDocInput["triageIntake"];
  };
  teamId: string;
  docClient: {
    create: (input: {
      teamId: string;
      title: string;
      content: string;
    }) => Promise<LinearDocumentRef>;
    update: (input: {
      documentId: string;
      content: string;
      title?: string;
    }) => Promise<{ id: string }>;
  };
  loadDocRef: () => Promise<LinearDocumentRef | null>;
  saveDocRef: (ref: LinearDocumentRef) => Promise<void>;
  /**
   * Hash of the doc content at the previous publish (persisted by the caller).
   * When it equals the freshly-rendered content's hash, the update + Slack
   * ping are skipped — the control-surface tick runs every poll but the doc
   * only changes on a real re-plan/merge/in-flight delta (SYMPH-820).
   */
  lastPublishedContentHash?: string | null;
  notify?: (url: string) => void;
  log: LogFn;
}

export async function publishControlDoc(deps: PublishControlDocDeps): Promise<{
  action: "created" | "updated" | "unchanged";
  ref: LinearDocumentRef;
  contentHash: string;
}> {
  const content = renderStandingPlanControlDoc({
    plan: deps.plan,
    recentlyShipped: deps.context.recentlyShipped,
    inFlight: deps.context.inFlight,
    changelog: deps.context.changelog,
    ...(deps.context.triageIntake === undefined
      ? {}
      : { triageIntake: deps.context.triageIntake }),
  });
  const contentHash = createHash("sha256").update(content).digest("hex");

  const existing = await deps.loadDocRef();
  if (existing !== null) {
    // Throttle: skip the Linear write AND the Slack ping when the rendered
    // doc is byte-identical to the last publish (SYMPH-820). Comment ingestion
    // still runs every tick — only the noisy re-publish/re-ping is gated.
    if (
      deps.lastPublishedContentHash != null &&
      deps.lastPublishedContentHash === contentHash
    ) {
      await deps.log(
        "queue_triage_doc_unchanged",
        "Control doc unchanged since last publish; skipped republish + ping.",
        { outcome: "ok", action: "unchanged", revision: deps.plan.revision },
      );
      return { action: "unchanged", ref: existing, contentHash };
    }
    await deps.docClient.update({
      documentId: existing.id,
      content,
      title: STANDING_PLAN_DOC_TITLE,
    });
    deps.notify?.(existing.url);
    await deps.log(
      "queue_triage_doc_published",
      "Updated the living control doc in place.",
      {
        outcome: "ok",
        action: "updated",
        url: existing.url,
        revision: deps.plan.revision,
      },
    );
    return { action: "updated", ref: existing, contentHash };
  }

  const ref = await deps.docClient.create({
    teamId: deps.teamId,
    title: STANDING_PLAN_DOC_TITLE,
    content,
  });
  await deps.saveDocRef(ref);
  deps.notify?.(ref.url);
  await deps.log(
    "queue_triage_doc_published",
    "Created the living control doc.",
    {
      outcome: "ok",
      action: "created",
      url: ref.url,
      revision: deps.plan.revision,
    },
  );
  return { action: "created", ref, contentHash };
}

export interface IngestControlDocDeps {
  documentId: string;
  plan: StandingPlan;
  operatorAllowlist: ReadonlySet<string>;
  docClient: {
    fetchComments: (input: {
      documentId: string;
    }) => Promise<LinearDocumentComment[]>;
  };
  /** Untrusted-text fence (SYMPH-390) applied before any free text is logged. */
  fence: (text: string) => string;
  recordDecision: (input: {
    kind: PlanDecisionKind;
    revision: number;
    batchId: string | null;
    actor: string;
    note: string | null;
    decisionId: string;
    createdAt: string;
  }) => Promise<{ recorded: boolean; reason?: string }>;
  requestReplan: () => void;
  log: LogFn;
  /** Per-process de-dup so a free-text comment is not re-logged each poll. */
  seen: Set<string>;
  now?: () => Date;
}

export async function ingestControlDocComments(
  deps: IngestControlDocDeps,
): Promise<{ processed: number }> {
  const comments = await deps.docClient.fetchComments({
    documentId: deps.documentId,
  });
  const now = deps.now ?? (() => new Date());
  let processed = 0;

  for (const comment of comments) {
    const resolution = resolveDocComment({
      comment: {
        body: comment.body,
        quotedText: comment.quotedText,
        authorEmail: comment.authorEmail,
        createdAt: comment.createdAt,
      },
      plan: deps.plan,
      operatorAllowlist: deps.operatorAllowlist,
    });

    if (resolution.kind === "intent") {
      // Map ONLY the known plan-control verbs; reject anything else rather than
      // silently treating it as "modify" (council R1, Pi P1). The note is
      // fenced before it is recorded into the durable journal (council R1,
      // Codex+Pi).
      const kind = planControlVerbToDecisionKind(resolution.verb);
      if (kind === null) {
        await deps.log(
          "queue_triage_doc_comment_unexpected_verb",
          "Doc-comment option carried an unrecognized verb; ignored.",
          {
            outcome: "degraded",
            verb: resolution.verb,
            comment_id: comment.id,
          },
        );
        continue;
      }
      // Idempotent on (comment, marker) — safe to re-run.
      const result = await deps.recordDecision({
        kind,
        revision: deps.plan.revision,
        batchId: resolution.batchId,
        actor: `operator:doc-comment:${comment.id}`,
        note: deps.fence(comment.body),
        decisionId: `doccomment:${comment.id}:${resolution.optionMarker}`,
        createdAt: now().toISOString(),
      });
      // Only a recorded modify_plan triggers a re-plan (don't spin on a
      // stale/rejected decision) — parity with the dashboard path (Pi P1).
      if (resolution.verb === "modify_plan" && result.recorded) {
        deps.requestReplan();
      }
      processed += 1;
      continue;
    }

    if (resolution.kind === "free_text" || resolution.kind === "ambiguous") {
      if (!deps.seen.has(comment.id)) {
        deps.seen.add(comment.id);
        // Fence the untrusted text before it is recorded anywhere; the full
        // interpret-then-confirm flow is a tracked follow-up.
        await deps.log(
          "queue_triage_doc_comment_unresolved",
          "Operator doc comment needs interpretation/confirmation (not executed).",
          {
            outcome: "info",
            kind: resolution.kind,
            comment_id: comment.id,
            fenced_text: deps.fence(
              resolution.kind === "free_text" ? resolution.text : comment.body,
            ),
          },
        );
      }
    }
    // ignored (non-operator) / stale: silently skipped.
  }

  return { processed };
}

/** Map a plan-control verb to its decision kind; null for an unknown verb. */
function planControlVerbToDecisionKind(verb: string): PlanDecisionKind | null {
  switch (verb) {
    case "release_batch":
      return "approve";
    case "hold":
      return "hold";
    case "modify_plan":
      return "modify";
    default:
      return null;
  }
}
