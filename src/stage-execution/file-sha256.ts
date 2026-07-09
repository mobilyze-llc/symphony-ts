import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** Read a file and fail closed if its exact bytes cannot be hashed. */
export async function fileSha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
