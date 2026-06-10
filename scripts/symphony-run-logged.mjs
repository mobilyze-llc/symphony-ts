#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_TAIL_BYTES = 4_000;

function parsePositiveInt(value, flagName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer.`);
  }
  return parsed;
}

function printUsage() {
  console.error(
    [
      "Usage: node scripts/symphony-run-logged.mjs [--label name] [--log-dir dir] [--tail-bytes n] -- <command> [args...]",
      "",
      "Runs a validation command with full stdout/stderr written to a log file,",
      "then prints only command metadata and a bounded tail for model context.",
      "The log combines stdout and stderr in the order Node receives chunks.",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const separatorIndex = argv.indexOf("--");
  if (separatorIndex === -1 || separatorIndex === argv.length - 1) {
    printUsage();
    process.exitCode = 64;
    return null;
  }

  let label = "validation";
  let logDir =
    process.env.SYMPHONY_VALIDATION_LOG_DIR ?? ".symphony/validation";
  let tailBytes = DEFAULT_TAIL_BYTES;

  for (let index = 0; index < separatorIndex; index += 1) {
    const token = argv[index];
    if (token === "--label") {
      label = argv[++index] ?? "";
      continue;
    }
    if (token.startsWith("--label=")) {
      label = token.slice("--label=".length);
      continue;
    }
    if (token === "--log-dir") {
      logDir = argv[++index] ?? "";
      continue;
    }
    if (token.startsWith("--log-dir=")) {
      logDir = token.slice("--log-dir=".length);
      continue;
    }
    if (token === "--tail-bytes") {
      tailBytes = parsePositiveInt(argv[++index] ?? "", "--tail-bytes");
      continue;
    }
    if (token.startsWith("--tail-bytes=")) {
      tailBytes = parsePositiveInt(
        token.slice("--tail-bytes=".length),
        "--tail-bytes",
      );
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }

  const command = argv.slice(separatorIndex + 1);
  if (label.trim().length === 0) {
    throw new Error("--label cannot be empty.");
  }
  if (logDir.trim().length === 0) {
    throw new Error("--log-dir cannot be empty.");
  }

  return {
    label,
    logDir,
    tailBytes,
    command,
  };
}

function shellQuote(tokens) {
  return tokens
    .map((token) =>
      /^[A-Za-z0-9_./:=@%+-]+$/.test(token)
        ? token
        : `'${token.replaceAll("'", "'\\''")}'`,
    )
    .join(" ");
}

function sanitizeLabel(label) {
  return label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function trimToBytes(input, maxBytes) {
  if (Buffer.byteLength(input, "utf8") <= maxBytes) {
    return input;
  }

  const codePoints = Array.from(input);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = codePoints.slice(mid).join("");
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return codePoints.slice(low).join("");
}

function openLogStream(logPath) {
  try {
    const fd = openSync(logPath, "wx");
    return {
      stream: createWriteStream(logPath, { fd, autoClose: true }),
      error: null,
    };
  } catch (error) {
    return {
      stream: null,
      error,
    };
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printUsage();
    process.exitCode = 64;
    return;
  }
  if (options === null) {
    return;
  }

  try {
    mkdirSync(options.logDir, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[symphony-run-logged] log_dir_error: ${message}`);
    process.exitCode = 74;
    return;
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = join(
    options.logDir,
    `${timestamp}-${sanitizeLabel(options.label) || "validation"}.log`,
  );
  const openedLog = openLogStream(logPath);
  if (openedLog.stream === null) {
    const message =
      openedLog.error instanceof Error
        ? openedLog.error.message
        : String(openedLog.error);
    console.error(`[symphony-run-logged] log_open_error: ${message}`);
    process.exitCode = 74;
    return;
  }
  const logStream = openedLog.stream;

  let totalBytes = 0;
  let totalLines = 0;
  let tail = "";
  let childError = null;
  let logError = null;
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  const child = spawn(options.command[0], options.command.slice(1), {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  logStream.on("error", (error) => {
    logError = error;
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  });

  const recordText = (text) => {
    if (text.length === 0) {
      return;
    }
    totalLines += (text.match(/\n/g) ?? []).length;
    tail = trimToBytes(`${tail}${text}`, options.tailBytes);
  };

  const recordChunk = (chunk, decoder) => {
    totalBytes += chunk.length;
    recordText(decoder.write(chunk));
    logStream.write(chunk);
  };

  child.stdout.on("data", (chunk) => recordChunk(chunk, stdoutDecoder));
  child.stderr.on("data", (chunk) => recordChunk(chunk, stderrDecoder));
  child.on("error", (error) => {
    childError = error;
    const message = Buffer.from(`${error.message}\n`);
    totalBytes += message.length;
    recordText(message.toString("utf8"));
    logStream.write(message);
  });

  const { code, signal } = await new Promise((resolve) => {
    let settled = false;
    const settle = (exitCode, exitSignal) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ code: exitCode, signal: exitSignal });
    };
    child.on("close", settle);
    child.on("error", () => settle(null, null));
  });

  recordText(stdoutDecoder.end());
  recordText(stderrDecoder.end());

  await new Promise((resolve) => {
    logStream.end(resolve);
  });

  if (logError !== null) {
    const message =
      logError instanceof Error ? logError.message : String(logError);
    console.error(`[symphony-run-logged] log_write_error: ${message}`);
    process.exitCode = 74;
    return;
  }

  const exitCode = childError !== null ? 127 : (code ?? 1);
  const commandText = shellQuote(options.command);
  console.log(`[symphony-run-logged] command: ${commandText}`);
  console.log(`[symphony-run-logged] exit_code: ${exitCode}`);
  if (signal !== null) {
    console.log(`[symphony-run-logged] signal: ${signal}`);
  }
  console.log(`[symphony-run-logged] log: ${logPath}`);
  console.log(`[symphony-run-logged] output_bytes: ${totalBytes}`);
  console.log(`[symphony-run-logged] output_lines: ${totalLines}`);
  console.log(`[symphony-run-logged] tail_bytes: ${options.tailBytes}`);
  console.log("[symphony-run-logged] streams: stdout/stderr combined");
  if (tail.trim().length > 0) {
    console.log("--- log tail ---");
    console.log(tail.trimEnd());
    console.log("--- end log tail ---");
  }

  process.exitCode = exitCode;
}

await main();
