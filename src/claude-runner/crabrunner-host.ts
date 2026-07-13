/** Resolve the configured crabrunner lane host for logging and telemetry. */
export function resolveCrabrunnerHostLabel(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const host = env.SYMPHONY_CRABRUNNER_HOST;
  return host === undefined || host.trim() === "" ? "local" : host.trim();
}
