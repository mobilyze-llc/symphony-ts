# Stage Provider Capabilities

This matrix is the stage-runner provider contract. It separates what the
current repository actually wires from what is target/buildable so a facade
cannot silently drop control semantics.

The code source of truth is
`src/runners/provider-capabilities.ts`; tests fail when a runner registered in
`src/runners/factory.ts` has no matrix row.

| Provider | Execution Shape | Warm Resume | Mid-run Injection | MCP/tool Policy | Usage Quality | Abort Semantics | Durable Artifact |
|---|---|---|---|---|---|---|---|
| Codex app-server | Current: persistent thread. Target: persistent thread. | Current: supported by the app-server session path. Target: keep. | Current: app-server control path and dynamic tools. Target: keep. | Current: Codex dynamic tools plus turn sandbox and mode policy. Target: keep parity. | Current: true token telemetry via `StageUsageMeasurement`. Target: true. | Current: cooperative close plus RuntimeHost tracked PID/process-group kill. Target: keep. | Current: Codex session artifact directory. Target: keep. |
| Codex CLI one-shot provider | Current: not wired, one-shot capability only. Target: one-shot for non-control stages only. | Current: not wired. Target: not supported unless provider adds it. | Current: not supported. Target: not supported. | Current: not wired. Target: explicit non-control policy mapping before use. | Current: unavailable. Target: partial if a provider reports usage. | Current: not wired. Target: bounded process cancellation. | Current: none. Target: terminal transcript or provider output artifact. |
| Claude Code AI SDK | Current: one-shot `generateText` turn. Target: one-shot with explicit parity limits. | Current: not wired in `AgentRunner`. Target: provider resume only if exposed and tested. | Current: not supported; hooks observe tool use. Target: not supported. | Current: Claude hooks plus Symphony mode-permission envelope. Target: same policy mapped deliberately. | Current: partial or true when AI SDK usage reports tokens; dollars are advisory/unavailable. Target: true token quality where provider supports it. | Current: AI SDK `AbortSignal`; no tracked app-server PID. Target: subprocess cleanup proof. | Current: runner events only. Target: provider transcript/session artifact when exposed. |
| Gemini CLI AI SDK | Current: one-shot `generateText` turn. Target: one-shot with explicit parity limits. | Current: not wired. Target: not supported unless provider adds it. | Current: not supported. Target: not supported. | Current: provider defaults; no Symphony tool-policy hook. Target: explicit provider policy contract if supported. | Current: partial or true when AI SDK usage reports tokens. Target: true token quality where provider supports it. | Current: no `AbortSignal` wired in the runner. Target: abort signal when supported. | Current: runner events only. Target: provider transcript/session artifact when exposed. |
| Crabrunner delegated worker | Current: backend contract and terminal evidence only. Target: delegated lane worker. | Current: not wired. Target: lane-side resume if exposed. | Current: not wired. Target: lane-side control protocol. | Current: backend contract only; lane policy is not enforced by submit/status/collect callers. Target: lane-side profile/tool policy. | Current: unavailable unless terminal evidence supplies usage. Target: true via scheduler usage ledger. | Current: backend-specific. Target: lane-side budget/stall/kill enforcement. | Current: backend terminal evidence when supplied. Target: scheduler artifact bundle and usage ledger. |

Control-needing stages (`execution.control_needing: true`) must resolve to the
current Codex app-server row. Config validation rejects one-shot and delegated
providers for those stages at load time.
