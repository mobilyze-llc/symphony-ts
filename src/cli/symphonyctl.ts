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

import { INTENT_VERBS, type IntentVerb } from "../orchestrator/intent.js";

/** Dashboard port of the symphony product's own WORKFLOW config. */
export const DEFAULT_BASE_URL = "http://127.0.0.1:4321";

export interface SymphonyctlCommand {
  command: "state" | "intent" | "pause" | "resume" | "help";
  baseUrl: string;
  verb?: IntentVerb;
  issue?: string;
  reason?: string;
  hint?: string;
  fence?: number;
  stage?: string;
}

export class SymphonyctlUsageError extends Error {}

const USAGE = `Usage: symphonyctl <command> [options]

Commands:
  state                          Pretty summary of GET /api/v1/state
  intent <verb> --issue <id> --reason <text> [--hint <text>] [--fence <seq>] [--stage <stage>]
                                 POST /api/v1/intents (verbs: ${INTENT_VERBS.join(", ")})
  pause [--reason <text>]        POST /api/v1/pipeline/pause
  resume [--reason <text>]       POST /api/v1/pipeline/resume

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
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { command: "help", baseUrl: DEFAULT_BASE_URL };
    }
    if (arg.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new SymphonyctlUsageError(`Flag ${arg} requires a value.`);
      }
      flags.set(arg.slice(2), value);
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
      if (!/^\d+$/.test(fence)) {
        throw new SymphonyctlUsageError(
          "--fence must be a non-negative integer.",
        );
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
  if (lines.length === 0) {
    lines.push("(no runtime activity)");
  }
  return lines.join("\n");
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

  if (parsed.command === "pause" || parsed.command === "resume") {
    const { status, payload } = await httpJson(
      "POST",
      `${parsed.baseUrl}/api/v1/pipeline/${parsed.command}`,
      {
        actor: ctlActor(),
        reason: parsed.reason ?? `pipeline ${parsed.command} via symphonyctl`,
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
