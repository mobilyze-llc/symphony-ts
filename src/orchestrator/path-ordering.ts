export function comparePathStrings(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

export function sortPaths(paths: readonly string[]): string[] {
  return [...paths].sort(comparePathStrings);
}

export function uniqueSortedPaths(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort(comparePathStrings);
}
