import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const OWNER = "src/stage-execution/collected-artifact.ts";

const FORBIDDEN = [
  /\bparseTarString\b/,
  /\breadTarString\b/,
  /\bfindTarEntry\w*\b/,
  /\.endsWith\(["']\.tar["']\)/,
  /["'][^"']*\.tar["']/,
  /\btar\s+(?:-x|--extract)\b/,
  /\bfrom\s+["'](?:tar|tar-stream|node-tar)["']/,
  /\bproducerPath\b/,
] as const;

describe("crabrunner collected artifact owner boundary", () => {
  it("keeps tar parsing and producerPath dereferences out of Symphony consumers", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(join(process.cwd(), "src"))) {
      const repoPath = relative(process.cwd(), file);
      const content = await readFile(file, "utf8");
      for (const pattern of FORBIDDEN) {
        if (pattern.test(content) && repoPath !== OWNER) {
          offenders.push(`${repoPath}: ${pattern.source}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return await sourceFiles(path);
      }
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return files.flat();
}
