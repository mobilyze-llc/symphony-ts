import type { IncomingMessage, ServerResponse } from "node:http";

import type { RuntimeSnapshot } from "../logging/runtime-snapshot.js";
import type { DashboardServerHost } from "./dashboard-server.js";

export async function readSnapshot(
  host: DashboardServerHost,
  timeoutMs: number,
): Promise<RuntimeSnapshot> {
  return await withTimeout(host.getRuntimeSnapshot(), timeoutMs, () => {
    return new Error(`Runtime snapshot timed out after ${timeoutMs}ms.`);
  });
}

export function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

export function writeHtml(
  response: ServerResponse,
  statusCode: number,
  html: string,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(html));
  response.end(html);
}

export function writeNotFound(response: ServerResponse, path: string): void {
  response.statusCode = 404;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(`Not found: ${path}`);
}

export async function readRequestBody(request: IncomingMessage): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    request.on("error", reject);
    request.on("end", resolve);
    request.resume();
  });
}

const MAX_REQUEST_BODY_BYTES = 64 * 1024;

/**
 * Typed rejection for bodies over the 64 KiB cap so route handlers can map
 * it to 413 instead of letting it escape to the generic 500 catch.
 */
export class PayloadTooLargeError extends Error {
  constructor() {
    super("Request body exceeds the 64 KiB limit.");
    this.name = "PayloadTooLargeError";
  }
}

/** Drain the request body as UTF-8 text, bounded to 64 KiB. */
export async function readRequestBodyText(
  request: IncomingMessage,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("error", reject);
    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        // Stop consuming but do NOT destroy the socket: the route still
        // needs to deliver a 413 response on it. Node closes the
        // connection after the response when the request was not fully
        // read.
        request.removeAllListeners("data");
        request.pause();
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

export function isSnapshotTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith("Runtime snapshot timed out after ")
  );
}

async function withTimeout<T>(
  promise: Promise<T> | T,
  timeoutMs: number,
  createError: () => Error,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(createError());
    }, timeoutMs);

    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
