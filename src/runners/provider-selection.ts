export interface ResolveStageRunnerProviderSelectorInput {
  runnerKind: string;
  defaultRunnerKind: string;
  stageRunner: string | null | undefined;
  executionProvider: string | null | undefined;
  defaultRunnerProvider: string | null | undefined;
}

export function resolveStageRunnerProviderSelector(
  input: ResolveStageRunnerProviderSelectorInput,
): string | null {
  const stageOverridesRunner =
    normalizeSelector(input.stageRunner) !== null &&
    normalizeSelector(input.stageRunner) !==
      normalizeSelector(input.defaultRunnerKind);
  const providerSelector =
    input.executionProvider ??
    (stageOverridesRunner ? null : input.defaultRunnerProvider);
  return providerSelector ?? input.runnerKind;
}

function normalizeSelector(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return null;
  }
  return trimmed.toLowerCase();
}
