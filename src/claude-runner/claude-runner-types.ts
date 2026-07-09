export const CLAUDE_RUNNER_PURPOSES = [
  "review",
  "research",
  "spec-review",
  "spec-partner",
  "development-agent",
  "critique",
  "custom",
] as const;

export type ClaudeRunnerPurpose = (typeof CLAUDE_RUNNER_PURPOSES)[number];

export type ClaudeRunnerStatus =
  | "passed"
  | "failed"
  | "invalid_artifact"
  | "timed_out"
  | "degraded";

export interface ClaudeRunnerValidationConfig {
  minBytes?: number;
  requiredHeadings?: string[];
  requireFirstHeading?: string;
  verdictEnums?: string[];
  requireSourceReadStatus?: boolean;
  requiredJsonSections?: string[];
}

export interface ClaudeRunnerInput {
  purpose: ClaudeRunnerPurpose;
  workspace: string;
  promptFile: string;
  artifactDir: string;
  artifactName: string;
  model?: string;
  profile?: string;
  laneId?: string;
  phase?: string;
  timeoutSeconds?: number;
  sourcePaths?: string[];
  validation?: ClaudeRunnerValidationConfig;
  diagnosticByteLimit?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ClaudeRunnerSourceVisibility {
  status: "ok" | "invalid_source_path";
  workspace: string;
  sources: Array<{
    kind: "prompt" | "source";
    path: string;
    resolvedPath: string;
    sha256: string | null;
    bytes: number | null;
    readable: boolean;
    insideWorkspace: boolean;
    error: string | null;
  }>;
}

export interface ClaudeRunnerAttempt {
  attempt: number;
  artifactName: string;
  artifactPath: string;
  remoteArtifactPath?: string | null;
  cliJsonPath: string;
  statusPath: string;
  state: string | null;
  exitCode: number;
  validationErrors: string[];
}

export interface ClaudeRunnerBoundedText {
  text: string;
  originalBytes: number;
  omittedBytes: number;
  truncated: boolean;
  maxBytes: number;
}

export interface ClaudeRunnerCommandDiagnostics {
  stdout: ClaudeRunnerBoundedText;
  stderr: ClaudeRunnerBoundedText;
}

export interface ClaudeRunnerDiagnostics {
  diagnosticByteLimit: number;
  preflight: ClaudeRunnerCommandDiagnostics | null;
  attempts: ClaudeRunnerCommandDiagnostics[];
}

export interface ClaudeRunnerResult {
  schemaVersion: 2;
  status: ClaudeRunnerStatus;
  purpose: ClaudeRunnerPurpose;
  model: string;
  profile: string;
  workspace: string;
  promptFile: string;
  promptSha256: string | null;
  artifactDir: string;
  artifactName: string;
  artifactPath: string | null;
  remoteArtifactPath?: string | null;
  resultJsonPath: string;
  runnerBin: string;
  laneId: string;
  phase: string;
  startedAt: string;
  completedAt: string;
  sourceVisibility: ClaudeRunnerSourceVisibility;
  attempts: ClaudeRunnerAttempt[];
  validationErrors: string[];
  diagnostics: ClaudeRunnerDiagnostics;
  usage: Record<string, unknown> | null;
  message: string;
}
