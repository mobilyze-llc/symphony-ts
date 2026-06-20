#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyPortfolioIssue,
  upsertPortfolioClassificationBlock,
} from "../portfolio/classifier.js";
import { findPortfolioProject } from "../portfolio/taxonomy.js";

export interface LinearPortfolioWriteIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface LinearPortfolioWriteDependencies {
  io?: LinearPortfolioWriteIo;
  runCommand?: (command: string, args: readonly string[]) => Promise<string>;
}

export async function runLinearPortfolioWriteCli(
  argv: readonly string[],
  dependencies: LinearPortfolioWriteDependencies = {},
): Promise<number> {
  const io = dependencies.io ?? defaultIo();
  if (argv.includes("--help") || argv.length === 0) {
    io.stdout(renderUsage());
    return 0;
  }
  try {
    const command = argv[0];
    const linearBin = readOptionalFlag(argv, "--linear-bin") ?? "linear-pp-cli";
    const dryRun = argv.includes("--dry-run");
    const runCommand = dependencies.runCommand ?? defaultRunCommand;
    const parsed =
      command === "create"
        ? parseCreate(argv)
        : command === "edit"
          ? parseEdit(argv)
          : null;
    if (parsed === null) {
      throw new Error(`Unknown command: ${command ?? "(none)"}.`);
    }

    const description = readFileSync(parsed.descriptionFile, "utf8");
    const explicitProject =
      parsed.project === null
        ? null
        : findPortfolioProject({
            id: parsed.project,
            slugId: parsed.project,
            name: parsed.project,
          });
    const classification = classifyPortfolioIssue({
      identifier: parsed.issueIdentifier,
      title: parsed.title,
      description,
      teamKey: parsed.team,
      projectId: explicitProject?.id ?? null,
      projectSlug: explicitProject?.slugId ?? null,
      projectName: explicitProject?.name ?? parsed.project,
    });
    const targetProject =
      classification.targetProject ?? classification.intakeProject;
    if (targetProject === null) {
      throw new Error("Portfolio classifier did not produce a target project.");
    }

    const descriptionFile = writeDescriptionWithClassification(
      upsertPortfolioClassificationBlock(description, classification),
    );
    const args: string[] = ["issues"];
    if (command === "create") {
      args.push(
        "create",
        "--team",
        parsed.team,
        "--title",
        parsed.title,
        "--description-file",
        descriptionFile,
        "--project",
        targetProject.id,
        "--agent",
      );
    } else {
      if (parsed.issueIdentifier === null) {
        throw new Error("Missing issue identifier for edit.");
      }
      args.push(
        "edit",
        parsed.issueIdentifier,
        "--description-file",
        descriptionFile,
        "--project",
        targetProject.id,
        "--agent",
      );
    }

    if (dryRun) {
      io.stdout(
        `${JSON.stringify({ command: linearBin, args, classification }, null, 2)}\n`,
      );
      return 0;
    }

    const output = await runCommand(linearBin, args);
    io.stdout(output.endsWith("\n") ? output : `${output}\n`);
    return 0;
  } catch (error) {
    io.stderr(`${formatError(error)}\n${renderUsage()}`);
    return 1;
  }
}

function parseCreate(argv: readonly string[]) {
  return {
    team: readRequiredFlag(argv, "--team"),
    title: readRequiredFlag(argv, "--title"),
    descriptionFile: readRequiredFlag(argv, "--description-file"),
    project: readOptionalFlag(argv, "--project"),
    issueIdentifier: null,
  };
}

function parseEdit(argv: readonly string[]) {
  const issueIdentifier = argv[1];
  if (issueIdentifier === undefined || issueIdentifier.startsWith("--")) {
    throw new Error("Missing issue identifier for edit.");
  }
  return {
    team: readRequiredFlag(argv, "--team"),
    title: readOptionalFlag(argv, "--title") ?? issueIdentifier,
    descriptionFile: readRequiredFlag(argv, "--description-file"),
    project: readOptionalFlag(argv, "--project"),
    issueIdentifier,
  };
}

function writeDescriptionWithClassification(
  classifiedDescription: string,
): string {
  const dir = mkdtempSync(join(tmpdir(), "symphony-linear-portfolio-"));
  const path = join(dir, "description.md");
  writeFileSync(path, classifiedDescription);
  return path;
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

function defaultRunCommand(
  command: string,
  args: readonly string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || `Command failed with exit ${code}.`));
      }
    });
  });
}

function renderUsage(): string {
  return [
    "Usage:",
    "  symphony-linear-portfolio create --team <SYMPH|MOB> --title <title> --description-file <file> [--project <id|name|slug>] [--dry-run]",
    "  symphony-linear-portfolio edit <ISSUE> --team <SYMPH|MOB> --description-file <file> [--title <title>] [--project <id|name|slug>] [--dry-run]",
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
  process.exitCode = await runLinearPortfolioWriteCli(process.argv.slice(2));
}
