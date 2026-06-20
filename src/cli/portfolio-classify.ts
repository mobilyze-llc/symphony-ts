#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { classifyPortfolioIssue } from "../portfolio/classifier.js";
import type { PortfolioClassificationInput } from "../portfolio/classifier.js";
import {
  type LivePortfolioProject,
  validatePortfolioTaxonomyRegistry,
} from "../portfolio/taxonomy.js";

export const PORTFOLIO_CLASSIFY_EXIT = {
  ok: 0,
  usage: 1,
  invalid: 2,
} as const;

export async function runPortfolioClassifyCli(
  argv: readonly string[],
  io = defaultIo(),
): Promise<number> {
  const command = argv[0];
  if (command === "--help" || command === "-h" || command === undefined) {
    io.stdout(renderUsage());
    return PORTFOLIO_CLASSIFY_EXIT.ok;
  }
  try {
    if (command === "classify") {
      const issueFile = readRequiredFlag(argv, "--issue-file");
      const issue = unwrapLinearEnvelope(
        JSON.parse(readFileSync(issueFile, "utf8")),
      ) as PortfolioClassificationInput;
      io.stdout(`${JSON.stringify(classifyPortfolioIssue(issue), null, 2)}\n`);
      return PORTFOLIO_CLASSIFY_EXIT.ok;
    }
    if (command === "validate-registry") {
      const projectsFile = readRequiredFlag(argv, "--projects-file");
      const payload = unwrapLinearEnvelope(
        JSON.parse(readFileSync(projectsFile, "utf8")),
      );
      const projects = normalizeLiveProjects(payload);
      const findings = validatePortfolioTaxonomyRegistry(projects);
      io.stdout(
        `${JSON.stringify({ ok: findings.length === 0, findings }, null, 2)}\n`,
      );
      return findings.length === 0
        ? PORTFOLIO_CLASSIFY_EXIT.ok
        : PORTFOLIO_CLASSIFY_EXIT.invalid;
    }
  } catch (error) {
    io.stderr(`${formatError(error)}\n${renderUsage()}`);
    return PORTFOLIO_CLASSIFY_EXIT.usage;
  }
  io.stderr(`Unknown command: ${command}\n${renderUsage()}`);
  return PORTFOLIO_CLASSIFY_EXIT.usage;
}

function normalizeLiveProjects(value: unknown): LivePortfolioProject[] {
  const nodes = Array.isArray(value)
    ? value
    : value !== null &&
        typeof value === "object" &&
        "data" in value &&
        typeof value.data === "object" &&
        value.data !== null &&
        "projects" in value.data &&
        typeof value.data.projects === "object" &&
        value.data.projects !== null &&
        "nodes" in value.data.projects &&
        Array.isArray(value.data.projects.nodes)
      ? value.data.projects.nodes
      : [];
  return nodes.map((project) => {
    const record = project as {
      id?: unknown;
      slugId?: unknown;
      name?: unknown;
      teamKeys?: unknown;
      teams?: { nodes?: Array<{ key?: unknown }> };
      initiative?: unknown;
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
      initiative: normalizeInitiative(record.initiative),
    };
  });
}

function normalizeInitiative(
  value: unknown,
): NonNullable<LivePortfolioProject["initiative"]> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const id = (value as { id?: unknown }).id;
  const name = (value as { name?: unknown }).name;
  return typeof id === "string" && typeof name === "string"
    ? { id, name }
    : null;
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
  const index = argv.indexOf(flag);
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing required ${flag}.`);
  }
  return value;
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
    "  symphony-portfolio-classify classify --issue-file <issue.json>",
    "  symphony-portfolio-classify validate-registry --projects-file <projects.json>",
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
  process.exitCode = await runPortfolioClassifyCli(process.argv.slice(2));
}
