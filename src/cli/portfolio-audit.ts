#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Issue } from "../domain/model.js";
import {
  renderPortfolioAuditReport,
  runPortfolioTaxonomyAudit,
} from "../portfolio/audit.js";
import type { LivePortfolioProject } from "../portfolio/taxonomy.js";

export async function runPortfolioAuditCli(
  argv: readonly string[],
  io = defaultIo(),
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.stdout(renderUsage());
    return 0;
  }
  try {
    const issues = normalizeIssues(
      unwrapLinearEnvelope(
        JSON.parse(
          readFileSync(readRequiredFlag(argv, "--issues-file"), "utf8"),
        ),
      ),
    );
    const projectsFile = readOptionalFlag(argv, "--projects-file");
    const liveProjects =
      projectsFile === null
        ? undefined
        : normalizeLiveProjects(
            unwrapLinearEnvelope(
              JSON.parse(readFileSync(projectsFile, "utf8")),
            ),
          );
    const json = argv.includes("--json");
    const auditInput: Parameters<typeof runPortfolioTaxonomyAudit>[0] = {
      issues,
    };
    if (liveProjects !== undefined) {
      auditInput.liveProjects = liveProjects;
    }
    const generatedAt = readOptionalFlag(argv, "--generated-at");
    if (generatedAt !== null) {
      auditInput.generatedAt = generatedAt;
    }
    const intakeStaleDays = parseOptionalPositiveInt(
      readOptionalFlag(argv, "--intake-stale-days"),
    );
    if (intakeStaleDays !== undefined) {
      auditInput.intakeStaleDays = intakeStaleDays;
    }
    const report = runPortfolioTaxonomyAudit(auditInput);
    io.stdout(
      json
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${renderPortfolioAuditReport(report)}\n`,
    );
    return report.ok ? 0 : 2;
  } catch (error) {
    io.stderr(`${formatError(error)}\n${renderUsage()}`);
    return 1;
  }
}

function normalizeIssues(value: unknown): Issue[] {
  const nodes = Array.isArray(value)
    ? value
    : value !== null &&
        typeof value === "object" &&
        "issues" in value &&
        Array.isArray((value as { issues?: unknown }).issues)
      ? (value as { issues: unknown[] }).issues
      : [];
  return nodes as Issue[];
}

function normalizeLiveProjects(value: unknown): LivePortfolioProject[] {
  const nodes = readProjectNodes(value);
  return nodes.map((project) => {
    const record = project as {
      id?: unknown;
      slugId?: unknown;
      name?: unknown;
      teamKeys?: unknown;
      teams?: { nodes?: Array<{ key?: unknown }> };
    };
    return {
      id: requireString(record.id, "project.id"),
      slugId: typeof record.slugId === "string" ? record.slugId : null,
      name: requireString(record.name, "project.name"),
      teamKeys: Array.isArray(record.teamKeys)
        ? record.teamKeys.filter(
            (team): team is string => typeof team === "string",
          )
        : (record.teams?.nodes ?? [])
            .map((team) => team.key)
            .filter((team): team is string => typeof team === "string"),
      initiative: null,
    };
  });
}

function readProjectNodes(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  const data = isRecord(value) ? value.data : null;
  const projects = isRecord(data) ? data.projects : null;
  const nodes = isRecord(projects) ? projects.nodes : null;
  return Array.isArray(nodes) ? nodes : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unwrapLinearEnvelope(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    "results" in value &&
    (value as { results?: unknown }).results !== undefined
  ) {
    return (value as { results: unknown }).results;
  }
  return value;
}

function readRequiredFlag(argv: readonly string[], flag: string): string {
  const value = readOptionalFlag(argv, flag);
  if (value === null) {
    throw new Error(`Missing required ${flag}.`);
  }
  return value;
}

function readOptionalFlag(
  argv: readonly string[],
  flag: string,
): string | null {
  const index = argv.indexOf(flag);
  const value = index === -1 ? undefined : argv[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

function parseOptionalPositiveInt(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got ${value}.`);
  }
  return parsed;
}

function requireString(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  throw new Error(`Invalid ${field}.`);
}

function renderUsage(): string {
  return [
    "Usage:",
    "  symphony-portfolio-audit --issues-file <issues.json> [--projects-file <projects.json>] [--json]",
    "",
  ].join("\n");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultIo() {
  return {
    stdout: (message: string) => process.stdout.write(message),
    stderr: (message: string) => process.stderr.write(message),
  };
}

function shouldRunAsCli(moduleUrl: string, argv1?: string): boolean {
  if (argv1 === undefined) {
    return false;
  }
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (shouldRunAsCli(import.meta.url, process.argv[1])) {
  process.exitCode = await runPortfolioAuditCli(process.argv.slice(2));
}
