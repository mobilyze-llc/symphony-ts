import { isAbsolute, resolve } from "node:path";

import { MIN_GATE_AUTHORITATIVE_CLUSTERING_REPEATS } from "../audit/clustering-benchmark.js";

export interface CapabilityRetestCliOptions {
  model: string | null;
  workspace: string;
  outDir: string | null;
  benchmark: "altitude" | "clustering";
  fixtureDir: string | null;
  repeats: number;
  help: boolean;
}

class CapabilityRetestUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityRetestUsageError";
  }
}

export function parseCapabilityRetestCliArgs(
  argv: readonly string[],
  cwd = process.cwd(),
): CapabilityRetestCliOptions {
  let model: string | null = null;
  let workspace = cwd;
  let outDir: string | null = null;
  let benchmark: CapabilityRetestCliOptions["benchmark"] = "altitude";
  let fixtureDir: string | null = null;
  let repeats = MIN_GATE_AUTHORITATIVE_CLUSTERING_REPEATS;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    const inline = splitInlineValue(token);
    const name = inline?.name ?? token;
    const readValue = (flag: string): string =>
      inline?.value ?? readValueFlag(argv, ++index, flag);
    switch (name) {
      case "--model":
        model = readValue("--model");
        break;
      case "--workspace":
        workspace = resolve(cwd, readValue("--workspace"));
        break;
      case "--out-dir":
        outDir = resolvePath(cwd, readValue("--out-dir"));
        break;
      case "--benchmark": {
        const value = readValue("--benchmark");
        if (value !== "altitude" && value !== "clustering") {
          throw new CapabilityRetestUsageError(
            "--benchmark must be altitude or clustering",
          );
        }
        benchmark = value;
        break;
      }
      case "--fixture-dir":
        fixtureDir = resolvePath(cwd, readValue("--fixture-dir"));
        break;
      case "--repeats":
        repeats = Number(readValue("--repeats"));
        if (!Number.isInteger(repeats) || repeats < 1) {
          throw new CapabilityRetestUsageError(
            "--repeats must be a positive integer",
          );
        }
        break;
      default:
        throw new CapabilityRetestUsageError(`Unknown option: ${token}`);
    }
  }
  return { model, workspace, outDir, benchmark, fixtureDir, repeats, help };
}

function resolvePath(cwd: string, value: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

function splitInlineValue(
  token: string,
): { name: string; value: string } | null {
  const equals = token.indexOf("=");
  return equals === -1
    ? null
    : { name: token.slice(0, equals), value: token.slice(equals + 1) };
}

function readValueFlag(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new CapabilityRetestUsageError(`Missing value for ${flag}.`);
  }
  return value;
}
