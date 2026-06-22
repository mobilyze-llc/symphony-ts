import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function isDirectRun(
  importMetaUrl: string,
  argvPath: string | undefined,
): boolean {
  if (argvPath === undefined) {
    return false;
  }
  try {
    return importMetaUrl === pathToFileURL(realpathSync(argvPath)).href;
  } catch {
    return false;
  }
}
