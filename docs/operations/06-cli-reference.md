# CLI help reference

This page is generated from each shipped CLI's `--help` output. Run
`pnpm build && pnpm docs:sync` after changing a CLI usage surface.

## symphony

<!-- AUTOGEN:help:symphony START — managed by scripts/docs-sync.mjs -->
```text
Usage: symphony [path-to-WORKFLOW.md] [options]

Options:
  --acknowledge-high-trust-preview  required before startup
  --logs-root <path>           override the logs root directory
  --port <number>              override the HTTP server port
  --help                       show this help text
```
<!-- AUTOGEN:help:symphony END -->

## symphony-backlog-audit

<!-- AUTOGEN:help:symphony-backlog-audit START — managed by scripts/docs-sync.mjs -->
```text
Usage: symphony-backlog-audit [WORKFLOW.md] --state-base-url <url> [--out <file>] --model-base-url <url> --model <name>

Runs the SYMPH-482 disposable backlog audit against live Linear backlog
and runtime JSON read-models. Model endpoint must be local/OpenAI-compatible.

Options:
  --state-base-url <url>    Symphony dashboard base URL (for /api/v1/state and /state/delta)
  --out <file>              Markdown report path (default: ./queue-backlog-audit-<timestamp>.md)
  --model-base-url <url>    Local OpenAI-compatible base URL, or SYMPHONY_QUEUE_AUDIT_BASE_URL
  --model <name>            Local model name, or SYMPHONY_QUEUE_AUDIT_MODEL
  --api-key <key>           Optional local endpoint API key, or SYMPHONY_QUEUE_AUDIT_API_KEY
  --timeout-ms <ms>         Runtime read-model and local judge timeout (default: 600000)
                            Also governs local model connect/header/body waits; pin .local endpoints to IPv4 if mDNS address selection is unreliable.
  --states <csv>            Linear states to audit (default: workflow active_states)
  --max-state-bytes <n>          Approx max /state JSON bytes in the judge prompt (default: 3000, or SYMPHONY_QUEUE_AUDIT_MAX_STATE_BYTES)
  --max-state-delta-entries <n>  Max /state/delta entries in the judge prompt (default: 5, or SYMPHONY_QUEUE_AUDIT_MAX_STATE_DELTA_ENTRIES)
  --max-state-delta-bytes <n>    Approx max /state/delta JSON bytes in the judge prompt (default: 2000, or SYMPHONY_QUEUE_AUDIT_MAX_STATE_DELTA_BYTES)
  --max-issue-description-chars <n>  Max ticket description chars in the judge prompt (default: 80, or SYMPHONY_QUEUE_AUDIT_MAX_ISSUE_DESCRIPTION_CHARS)
  --chunk-size <n>          Issues per local-model call (default: 4, or SYMPHONY_QUEUE_AUDIT_CHUNK_SIZE)
  --relationship-context-window-size <n>  Max tickets per relationship context window before pairwise bounded passes (default: 32, or SYMPHONY_QUEUE_AUDIT_RELATIONSHIP_CONTEXT_WINDOW_SIZE)
```
<!-- AUTOGEN:help:symphony-backlog-audit END -->

## symphony-calibration-digest

<!-- AUTOGEN:help:symphony-calibration-digest START — managed by scripts/docs-sync.mjs -->
```text
Usage: symphony-calibration-digest [workspace-root] [--out <file>]

Joins dispatcher run-journal verdict events against terminal outcomes
and writes a markdown calibration digest (SYMPH-411).

Arguments:
  workspace-root   Directory containing .symphony/run-journals/
                   (default: current working directory)
  --out <file>     Write the digest to a file instead of stdout
```
<!-- AUTOGEN:help:symphony-calibration-digest END -->

## claude-runner

<!-- AUTOGEN:help:claude-runner START — managed by scripts/docs-sync.mjs -->
```text
Usage: claude-runner --purpose <purpose> --workspace <dir> --prompt-file <file> --artifact-dir <dir> --artifact-name <name> [options]

Calls Claude through crabrunner and validates the direct artifact before reporting success.

Options:
  --purpose <name>             review|research|spec-review|spec-partner|development-agent|critique|custom
  --workspace <dir>            Readable workspace root for Claude
  --prompt-file <file>         Prompt file inside the workspace
  --artifact-dir <dir>         Directory for prompt/output/status/result files
  --artifact-name <name>       Basename for the Claude artifact
  --model <name>               Claude model alias (default: opus)
  --profile <name>             Crabrunner Claude profile (default: read-only)
  --timeout-seconds <n>        Lane timeout (default: 1800)
  --source <file>              Extra source file that must be readable inside workspace (repeatable)
  --required-heading <text>    Markdown heading required in artifact (repeatable)
  --require-first-heading <h>  First non-empty line must be this heading
  --verdict-enum <value>       Allowed verdict/status enum (repeatable)
  --required-json-section <h>  Heading whose section must contain one fenced JSON object (repeatable)
  --min-bytes <n>              Minimum artifact byte size
  --diagnostic-byte-limit <n>  Max stdout/stderr bytes retained in result diagnostics (default: 16384, max: 262144)
  --retry-on-invalid           Unsupported for crabrunner execution; exits with usage error
  --help                       Show this help
```
<!-- AUTOGEN:help:claude-runner END -->

## symphony-manager-run-import

<!-- AUTOGEN:help:symphony-manager-run-import START — managed by scripts/docs-sync.mjs -->
```text
Usage: symphony-manager-run-import --input <ledger.json> [--output <manager-runs.jsonl>]

Import a curated historical manager lane ledger into Symphony manager-run JSONL entries.
When --output is omitted or set to -, JSONL is written to stdout.

Example:
  symphony-manager-run-import --input tests/fixtures/manager-run-ledgers/019ea74a-0df6-7983-bbff-60c7df539e80.json --output /tmp/manager-runs.jsonl
```
<!-- AUTOGEN:help:symphony-manager-run-import END -->

## symphony-portfolio-audit

<!-- AUTOGEN:help:symphony-portfolio-audit START — managed by scripts/docs-sync.mjs -->
```text
Usage:
  symphony-portfolio-audit --issues-file <issues.json> [--projects-file <projects.json>] [--json]
```
<!-- AUTOGEN:help:symphony-portfolio-audit END -->

## symphony-portfolio-classify

<!-- AUTOGEN:help:symphony-portfolio-classify START — managed by scripts/docs-sync.mjs -->
```text
Usage:
  symphony-portfolio-classify classify --issue-file <issue.json>
  symphony-portfolio-classify validate-registry --projects-file <projects.json>
```
<!-- AUTOGEN:help:symphony-portfolio-classify END -->

## symphony-linear-portfolio

<!-- AUTOGEN:help:symphony-linear-portfolio START — managed by scripts/docs-sync.mjs -->
```text
Usage:
  symphony-linear-portfolio create --team <SYMPH|MOB> --title <title> --description-file <file> [--project <id|name|slug>] [--dry-run]
  symphony-linear-portfolio edit <ISSUE> --team <SYMPH|MOB> --description-file <file> [--title <title>] [--project <id|name|slug>] [--dry-run]
```
<!-- AUTOGEN:help:symphony-linear-portfolio END -->

## symphony-investigate-productivity-report

<!-- AUTOGEN:help:symphony-investigate-productivity-report START — managed by scripts/docs-sync.mjs -->
```text
Usage: symphony-investigate-productivity-report --workspace <repo-root> [--output <file>]

Reads durable dispatcher stage_record telemetry and prints investigate productivity JSON.

Options:
  --workspace <dir>  Workspace containing .symphony/run-journals/dispatcher.jsonl
  --output <file>    Also write the JSON report to this file
  --help             Show this help
```
<!-- AUTOGEN:help:symphony-investigate-productivity-report END -->

## symphony-spec-review-watch

<!-- AUTOGEN:help:symphony-spec-review-watch START — managed by scripts/docs-sync.mjs -->
```text
Usage: symphony-spec-review-watch [WORKFLOW.md] --workspace <repo> [options]

Runs the durable spec-time Claude review watcher in observe/warn/enforce mode.

Options:
  --workspace <dir>         Claude-readable repo/workspace root (default: cwd)
  --artifact-root <dir>     Artifact root (default: <workspace>/.symphony/spec-review)
  --mode <mode>             observe|warn|enforce (default: observe)
  --states <csv>            Linear states to scan (default: workflow active states)
  --issue <identifier>      Restrict to an issue identifier (repeatable)
  --issue-direct <id>       Fetch and review an issue identifier directly, outside state/project scans (repeatable)
  --ticket <id>             Alias for --issue-direct
  --force, --review-now     Review targeted issues even when normal selection heuristics would skip them
  --source-ref <path>       Source-of-truth file to include (repeatable, default: SPEC.mobilyze.md)
  --dry-run                 Select and print candidates without invoking Claude or writing Linear
  --help                    Show this help

Exit status:
  0 when all selected reviews are healthy or every selected candidate is privacy-blocked
  1 when selected work fails, runner/artifact errors occur, or enforce mode finds operator context is required
  2 for usage errors
```
<!-- AUTOGEN:help:symphony-spec-review-watch END -->

## symphonyctl

<!-- AUTOGEN:help:symphonyctl START — managed by scripts/docs-sync.mjs -->
```text
Usage: symphonyctl <command> [options]

Commands:
  state                          Pretty summary of GET /api/v1/state
  preflight                      Verify operator bearer auth with GET /api/v1/operator/whoami
  intent <verb> --issue <id> --reason <text> [--hint <text>] [--fence <seq>] [--stage <stage>]
                                 POST /api/v1/intents (verbs: park, release, anchor, unanchor, halt, retry_once, rework_with_hint, escalate_human, resume)
  anchor <issue> (--top|--above <ref>|--below <ref>) (--until-merged|--until <iso-timestamp>) [--reason <text>]
                                 POST an anchor intent with operator attribution
  unanchor <issue> [--reason <text>]
                                 POST an unanchor intent with operator attribution
  pause [--reason <text>]        POST /api/v1/pipeline/pause
  resume [--reason <text>]       POST /api/v1/pipeline/resume
  stop --hard [--reason <text>]  POST /api/v1/pipeline/stop (emergency stop)
  fence <issue> [issue...] [--reason <text>]
                                 POST /api/v1/dispatch-fence with a positive allowlist
  unfence                       DELETE /api/v1/dispatch-fence

Cold-shell hard stop:
  curl -fsS -X POST "${SYMPHONYCTL_BASE_URL:-http://127.0.0.1:4321}/api/v1/pipeline/stop" \
    -H 'content-type: application/json' \
    -H "authorization: Bearer ${SYMPHONY_OPERATOR_TOKEN}" \
    --data '{"reason":"emergency stop from shell"}'

Options:
  --base-url <url>               Dashboard base URL (default http://127.0.0.1:4321,
                                 or SYMPHONYCTL_BASE_URL)
  --operator-token <token>        Operator bearer token (default SYMPHONY_OPERATOR_TOKEN)
  --until <iso-timestamp>         Anchor expiry timestamp must be a full ISO-8601 timestamp with timezone, for example 2026-06-11T11:00:00.000Z or 2026-06-11T07:00:00-04:00
```
<!-- AUTOGEN:help:symphonyctl END -->
