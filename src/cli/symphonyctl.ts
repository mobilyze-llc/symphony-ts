#!/usr/bin/env node

/**
 * symphonyctl — deliberately disposable thin client over the dashboard
 * HTTP API (SYMPH-408b). No business logic lives here: every command is
 * HTTP + formatting over endpoints whose semantics belong to the
 * orchestrator's intent-verb layer. If the endpoints change, rewrite this
 * file; do not grow it.
 */

import { hostname } from "node:os";

import { fileURLToPath } from "node:url";

import {
  type AnchorExpiry,
  type AnchorPlacement,
  INTENT_VERBS,
  type IntentVerb,
} from "../orchestrator/intent.js";

/** Dashboard port of the symphony product's own WORKFLOW config. */
export const DEFAULT_BASE_URL = "http://127.0.0.1:4321";

export interface SymphonyctlCommand {
  command:
    | "state"
    | "intent"
    | "anchor"
    | "unanchor"
    | "pause"
    | "resume"
    | "stop"
    | "help";
  baseUrl: string;
  verb?: IntentVerb;
  issue?: string;
  reason?: string;
  hint?: string;
  fence?: number;
  stage?: string;
  anchorPlacement?: AnchorPlacement;
  anchorExpiry?: AnchorExpiry;
  hard?: boolean;
}

export class SymphonyctlUsageError extends Error {}

const USAGE = `Usage: symphonyctl <command> [options]

Commands:
  state                          Pretty summary of GET /api/v1/state
  intent <verb> --issue <id> --reason <text> [--hint <text>] [--fence <seq>] [--stage <stage>]
                                 POST /api/v1/intents (verbs: ${INTENT_VERBS.join(", ")})
  anchor <issue> (--top|--above <ref>|--below <ref>) (--until-merged|--until <date>) [--reason <text>]
                                 POST an anchor intent with operator attribution
  unanchor <issue> [--reason <text>]
                                 POST an unanchor intent with operator attribution
  pause [--reason <text>]        POST /api/v1/pipeline/pause
  resume [--reason <text>]       POST /api/v1/pipeline/resume
  stop --hard [--reason <text>]  POST /api/v1/pipeline/stop (emergency stop)

Cold-shell hard stop:
  curl -fsS -X POST "\${SYMPHONYCTL_BASE_URL:-${DEFAULT_BASE_URL}}/api/v1/pipeline/stop" \\
    -H 'content-type: application/json' \\
    --data '{"reason":"emergency stop from shell"}'

Options:
  --base-url <url>               Dashboard base URL (default ${DEFAULT_BASE_URL},
                                 or SYMPHONYCTL_BASE_URL)
`;

export function parseSymphonyctlArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): SymphonyctlCommand {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const booleanFlags = new Set(["top", "until-merged", "hard"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { command: "help", baseUrl: DEFAULT_BASE_URL };
    }
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (booleanFlags.has(name)) {
        flags.set(name, "true");
        continue;
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new SymphonyctlUsageError(`Flag ${arg} requires a value.`);
      }
      flags.set(name, value);
      i += 1;
      continue;
    }
    positional.push(arg);
  }

  const baseUrl = (
    flags.get("base-url") ??
    env.SYMPHONYCTL_BASE_URL ??
    DEFAULT_BASE_URL
  ).replace(/\/$/, "");

  const command = positional[0];
  if (command === undefined || command === "help") {
    return { command: "help", baseUrl };
  }

  if (command === "state" || command === "pause" || command === "resume") {
    const result: SymphonyctlCommand = { command, baseUrl };
    const reason = flags.get("reason");
    if (reason !== undefined) {
      result.reason = reason;
    }
    return result;
  }

  if (command === "anchor") {
    const issue = positional[1];
    if (issue === undefined) {
      throw new SymphonyctlUsageError("anchor requires an issue identifier.");
    }
    const placement = parseAnchorPlacementFlags(flags);
    const expiry = parseAnchorExpiryFlags(flags);
    const result: SymphonyctlCommand = {
      command: "anchor",
      baseUrl,
      issue,
      anchorPlacement: placement,
      anchorExpiry: expiry,
    };
    const reason = flags.get("reason");
    if (reason !== undefined) {
      result.reason = reason;
    }
    return result;
  }

  if (command === "unanchor") {
    const issue = positional[1];
    if (issue === undefined) {
      throw new SymphonyctlUsageError("unanchor requires an issue identifier.");
    }
    const result: SymphonyctlCommand = { command: "unanchor", baseUrl, issue };
    const reason = flags.get("reason");
    if (reason !== undefined) {
      result.reason = reason;
    }
    return result;
  }

  if (command === "stop") {
    if (flags.get("hard") !== "true") {
      throw new SymphonyctlUsageError("stop requires --hard.");
    }
    const result: SymphonyctlCommand = { command, baseUrl, hard: true };
    const reason = flags.get("reason");
    if (reason !== undefined) {
      result.reason = reason;
    }
    return result;
  }

  if (command === "intent") {
    const verb = positional[1];
    if (
      verb === undefined ||
      !(INTENT_VERBS as readonly string[]).includes(verb)
    ) {
      throw new SymphonyctlUsageError(
        `intent requires a verb: ${INTENT_VERBS.join(", ")}`,
      );
    }
    const issue = flags.get("issue");
    const reason = flags.get("reason");
    if (issue === undefined || reason === undefined) {
      throw new SymphonyctlUsageError(
        "intent requires --issue <id> and --reason <text>.",
      );
    }
    const result: SymphonyctlCommand = {
      command: "intent",
      baseUrl,
      verb: verb as IntentVerb,
      issue,
      reason,
    };
    const hint = flags.get("hint");
    if (hint !== undefined) {
      result.hint = hint;
    }
    const stage = flags.get("stage");
    if (stage !== undefined) {
      result.stage = stage;
    }
    const fence = flags.get("fence");
    if (fence !== undefined) {
      if (!/^[1-9]\d*$/.test(fence)) {
        throw new SymphonyctlUsageError("--fence must be a positive integer.");
      }
      result.fence = Number.parseInt(fence, 10);
    }
    return result;
  }

  throw new SymphonyctlUsageError(`Unknown command: ${command}`);
}

function ctlActor(): { kind: "operator"; host: string; session: string } {
  const label = hostname().split(".")[0];
  return {
    kind: "operator",
    host: label === undefined || label === "" ? hostname() : label,
    session: "symphonyctl",
  };
}

function parseAnchorPlacementFlags(
  flags: ReadonlyMap<string, string>,
): AnchorPlacement {
  const top = flags.has("top");
  const above = flags.get("above");
  const below = flags.get("below");
  const placementCount =
    (top ? 1 : 0) +
    (above === undefined ? 0 : 1) +
    (below === undefined ? 0 : 1);
  if (placementCount !== 1) {
    throw new SymphonyctlUsageError(
      "anchor requires exactly one of --top, --above <ref>, or --below <ref>.",
    );
  }
  if (top) {
    return { kind: "top" };
  }
  if (above !== undefined) {
    return { kind: "above", issueIdentifier: above };
  }
  if (below !== undefined) {
    return { kind: "below", issueIdentifier: below };
  }
  throw new SymphonyctlUsageError("anchor placement is missing.");
}

function parseAnchorExpiryFlags(
  flags: ReadonlyMap<string, string>,
): AnchorExpiry {
  const untilMerged = flags.has("until-merged");
  const until = flags.get("until");
  const expiryCount = (untilMerged ? 1 : 0) + (until === undefined ? 0 : 1);
  if (expiryCount !== 1) {
    throw new SymphonyctlUsageError(
      "anchor requires exactly one of --until-merged or --until <date>.",
    );
  }
  if (untilMerged) {
    return { kind: "until_merged" };
  }
  const parsed = new Date(until ?? "");
  if (Number.isNaN(parsed.valueOf())) {
    throw new SymphonyctlUsageError("--until must be a parseable date.");
  }
  return { kind: "until_date", at: parsed.toISOString() };
}

/** Only a full UUID is treated as an issue id; anything else (e.g. SYMPH-123) is an identifier. */
function issueBody(issue: string): Record<string, string> {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    issue,
  )
    ? { issueId: issue }
    : { issueIdentifier: issue };
}

async function httpJson(
  method: "GET" | "POST",
  url: string,
  body?: unknown,
): Promise<{ status: number; payload: unknown }> {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload: unknown = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // Leave non-JSON payloads as raw text.
  }
  return { status: response.status, payload };
}

export function formatStateSummary(snapshot: Record<string, unknown>): string {
  const lines: string[] = [];
  const counts = snapshot.counts as Record<string, number> | undefined;
  if (counts !== undefined) {
    lines.push(
      `running=${counts.running ?? 0} retrying=${counts.retrying ?? 0} completed=${counts.completed ?? 0} failed=${counts.failed ?? 0}`,
    );
  }
  const running = snapshot.running;
  if (Array.isArray(running) && running.length > 0) {
    lines.push("running:");
    for (const entry of running as Array<Record<string, unknown>>) {
      lines.push(
        `  ${String(entry.issue_identifier ?? entry.identifier ?? "?")} ${String(entry.state ?? "")}`,
      );
    }
  }
  const parked = snapshot.explicit_resume_required;
  if (
    parked !== null &&
    typeof parked === "object" &&
    Object.keys(parked as object).length > 0
  ) {
    lines.push("explicit resume required:");
    for (const [issueId, mark] of Object.entries(
      parked as Record<string, unknown>,
    )) {
      const reason =
        mark !== null && typeof mark === "object"
          ? String((mark as Record<string, unknown>).reason ?? "")
          : "";
      lines.push(`  ${issueId} ${reason}`.trimEnd());
    }
  }
  const anchors = snapshot.anchors;
  if (Array.isArray(anchors) && anchors.length > 0) {
    lines.push("anchors:");
    for (const anchor of anchors as Array<Record<string, unknown>>) {
      const issue = String(
        anchor.issue_identifier ?? anchor.issue_id ?? "unknown",
      );
      lines.push(
        `  ${issue} ${formatSnapshotAnchorPlacement(anchor.placement)} ${formatSnapshotAnchorExpiry(anchor.expiry)} — ${formatSnapshotAnchorProvenance(anchor)}`,
      );
    }
  }
  if (lines.length === 0) {
    lines.push("(no runtime activity)");
  }
  return lines.join("\n");
}

function formatSnapshotAnchorPlacement(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "top";
  }
  const record = value as Record<string, unknown>;
  const kind =
    record.kind === "above" || record.kind === "below" ? record.kind : "top";
  return kind === "top"
    ? "top"
    : `${kind} ${String(record.issue_identifier ?? "unknown")}`;
}

function formatSnapshotAnchorExpiry(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "until merged";
  }
  const record = value as Record<string, unknown>;
  return record.kind === "until_date"
    ? `until ${String(record.at ?? "unknown")}`
    : "until merged";
}

function formatSnapshotAnchorProvenance(
  anchor: Record<string, unknown>,
): string {
  const provenance =
    anchor.provenance !== null &&
    typeof anchor.provenance === "object" &&
    !Array.isArray(anchor.provenance)
      ? (anchor.provenance as Record<string, unknown>)
      : {};
  const actor =
    provenance.actor !== null &&
    typeof provenance.actor === "object" &&
    !Array.isArray(provenance.actor)
      ? (provenance.actor as Record<string, unknown>)
      : {};
  const actorLabel = `${String(actor.kind ?? "unknown")}@${String(
    actor.host ?? "unknown",
  )}${actor.session === undefined || actor.session === null ? "" : `#${String(actor.session)}`}`;
  const reason =
    provenance.reason !== null &&
    typeof provenance.reason === "object" &&
    !Array.isArray(provenance.reason)
      ? (provenance.reason as Record<string, unknown>)
      : {};
  return [
    actorLabel,
    String(provenance.source ?? "unknown"),
    provenance.editor_email,
    provenance.field_name,
    reason.human,
  ]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join(" · ");
}

export async function runSymphonyctl(
  parsed: SymphonyctlCommand,
  log: (line: string) => void = console.log,
): Promise<number> {
  if (parsed.command === "help") {
    log(USAGE);
    return 0;
  }

  if (parsed.command === "state") {
    const { status, payload } = await httpJson(
      "GET",
      `${parsed.baseUrl}/api/v1/state`,
    );
    if (status !== 200) {
      log(`GET /api/v1/state failed (${status}): ${JSON.stringify(payload)}`);
      return 1;
    }
    log(formatStateSummary(payload as Record<string, unknown>));
    return 0;
  }

  if (
    parsed.command === "pause" ||
    parsed.command === "resume" ||
    parsed.command === "stop"
  ) {
    const action = parsed.command === "stop" ? "stop" : parsed.command;
    const { status, payload } = await httpJson(
      "POST",
      `${parsed.baseUrl}/api/v1/pipeline/${action}`,
      {
        actor: ctlActor(),
        reason:
          parsed.reason ??
          (parsed.command === "stop"
            ? "emergency stop via symphonyctl"
            : `pipeline ${parsed.command} via symphonyctl`),
      },
    );
    log(JSON.stringify(payload, null, 2));
    return status === 200 ? 0 : 1;
  }

  if (parsed.command === "anchor" || parsed.command === "unanchor") {
    const isAnchor = parsed.command === "anchor";
    const { status, payload } = await httpJson(
      "POST",
      `${parsed.baseUrl}/api/v1/intents`,
      {
        verb: parsed.command,
        ...issueBody(parsed.issue ?? ""),
        reason:
          parsed.reason ??
          `${parsed.command} ${parsed.issue ?? "issue"} via symphonyctl`,
        actor: ctlActor(),
        ...(isAnchor
          ? {
              anchor: {
                placement: parsed.anchorPlacement,
                expiry: parsed.anchorExpiry,
                source: "symphonyctl",
              },
            }
          : {}),
      },
    );
    log(JSON.stringify(payload, null, 2));
    return status === 200 ? 0 : 1;
  }

  // intent
  const { status, payload } = await httpJson(
    "POST",
    `${parsed.baseUrl}/api/v1/intents`,
    {
      verb: parsed.verb,
      ...issueBody(parsed.issue ?? ""),
      reason: parsed.reason,
      actor: ctlActor(),
      ...(parsed.fence === undefined
        ? {}
        : { fence: { expectedParkSeq: parsed.fence } }),
      ...(parsed.hint === undefined ? {} : { hint: parsed.hint }),
      ...(parsed.stage === undefined ? {} : { stage: parsed.stage }),
    },
  );
  log(JSON.stringify(payload, null, 2));
  return status === 200 ? 0 : 1;
}

async function main(): Promise<void> {
  let parsed: SymphonyctlCommand;
  try {
    parsed = parseSymphonyctlArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof SymphonyctlUsageError) {
      console.error(error.message);
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  try {
    process.exitCode = await runSymphonyctl(parsed);
  } catch (error) {
    console.error(
      `symphonyctl: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

const isDirectInvocation = (() => {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  void main();
}
