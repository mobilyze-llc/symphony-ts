# Stage Usage Measurement Contract

Symphony records legacy numeric token counters for backward compatibility, but
the durable cost/usage contract is `StageUsageMeasurement` from
`src/domain/stage-usage.ts`.

## Shape

Each measurement records:

- runner/provider/model/profile identity
- token counts, with unavailable fields as `null`
- measurement quality: `true`, `estimated`, `proxy`, `unsupported`, `partial`,
  `unavailable`, or `unknown`
- dollar cost metadata, including amount, currency, source, authority, and
  source description

`null` means the provider or runner did not report a value. It is not zero.
Compatibility counters may still expose zero to keep older reducers stable, but
operators and new code must read `usageMeasurement` before interpreting cost or
quality.

## Cost Authority

Provider-returned billing data and explicit API pricing catalog rows may be
`authoritative`. Subscription or OAuth equivalents are always `advisory`, even
when they use list-price math. Missing cost is `unavailable`, never
authoritative zero spend.

## Current Mappers

- Codex app-server: true token telemetry, no authoritative billing spend.
- Claude Code AI SDK: true/partial/unavailable token telemetry, subscription
  dollars only as advisory.
- Gemini AI SDK: true/partial/unavailable token telemetry. API-key callers with
  an explicit pricing row should use the generic pricing-catalog mapper rather
  than treating Gemini CLI subscription/OAuth telemetry as billed spend.
- Crabrunner: terminal usage artifacts map into the same contract; explicit
  `usage_unavailable` maps to null token counts with `measurementQuality:
  "unavailable"`, while absent or null usage maps to `"unknown"`.

Runtime snapshots expose the current stage measurement as
`usage_measurement`, and completed stage records preserve it in
`execution_history[].usageMeasurement`.
