## CLI Reference Card - cmux-spawn

All external reviewer CLIs in this skill (Opus through Claude Code,
Pi through hosted DeepSeek, and optional Kimi K2.7 shadow diagnostics)
are spawned through `cmux-spawn`, Crucible's universal agent-lane CLI.
The substrate handles preflight, cmux
workspace lifecycle, artifact writes, status JSON, usage telemetry,
pane logs, and cross-process concurrency caps.

Codex is the lead in the current session, so this skill does not spawn a
separate Codex lane.

See `~/.agents/skills/cmux-spawn/SKILL.md` for the full CLI surface.
Reference source: `$HOME/projects/crucible/docs/cmux-spawn.md`.

### Setup

```bash
CMUX_SPAWN_LOCAL_BIN="${CMUX_SPAWN_LOCAL_BIN:-$HOME/projects/crucible/bin/cmux-spawn}"
CMUX_SPAWN_REMOTE_BIN="${CMUX_SPAWN_REMOTE_BIN:-$HOME/projects/crucible/bin/cmux-spawn-remote}"
CMUX_SPAWN_REMOTE_HOST="${CMUX_SPAWN_REMOTE_HOST:-clawdilize@pro16.local}"
CMUX_SPAWN_LOCAL_HOST="${CMUX_SPAWN_LOCAL_HOST:-pro14}"

test -x "$CMUX_SPAWN_REMOTE_BIN" || {
  echo "cmux-spawn-remote not installed at $CMUX_SPAWN_REMOTE_BIN" >&2
  exit 1
}
test -x "$CMUX_SPAWN_LOCAL_BIN" || {
  echo "cmux-spawn not installed at $CMUX_SPAWN_LOCAL_BIN" >&2
  exit 1
}

if CMUX_SPAWN_REMOTE_HOST="$CMUX_SPAWN_REMOTE_HOST" "$CMUX_SPAWN_REMOTE_BIN" preflight --json > "$COUNCIL_DIR/preflight-remote.json" 2> "$COUNCIL_DIR/preflight-remote.stderr"; then
  export CMUX_SPAWN_BIN="$CMUX_SPAWN_REMOTE_BIN"
  export CMUX_SPAWN_REMOTE_HOST
  export CMUX_SPAWN_SUBSTRATE_TIER=remote-pro16
  export CMUX_SPAWN_SUBSTRATE_HOST="$CMUX_SPAWN_REMOTE_HOST"
  cp "$COUNCIL_DIR/preflight-remote.json" "$COUNCIL_DIR/preflight.json"
elif "$CMUX_SPAWN_LOCAL_BIN" preflight --caffeinate --json > "$COUNCIL_DIR/preflight-local.json" 2> "$COUNCIL_DIR/preflight-local.stderr"; then
  export CMUX_SPAWN_BIN="$CMUX_SPAWN_LOCAL_BIN"
  export CMUX_SPAWN_SUBSTRATE_TIER=degraded-local-pro14
  export CMUX_SPAWN_SUBSTRATE_HOST="$CMUX_SPAWN_LOCAL_HOST"
  cp "$COUNCIL_DIR/preflight-local.json" "$COUNCIL_DIR/preflight.json"
  echo "cmux-spawn remote preflight failed; degraded to local pro14. See $COUNCIL_DIR/preflight-remote.*" >&2
else
  echo "cmux-spawn preflight failed for remote pro16 and local pro14" >&2
  exit 1
fi
```

Default routing is `remote-pro16`; `degraded-local-pro14` is an
explicit fallback after remote preflight fails. If both preflights fail,
stop. Do not fall back to direct `claude`, `pi`, or `codex`
subprocesses.

### Artifact Convention

For every `cmux-spawn run` invocation, set:

- `--artifact-dir "$COUNCIL_DIR"`
- `--artifact-name phase1-opus`, `phase1-pi`, `phase2-opus`, or
  `kimi-k27-shadow`
- `--lane-id opus`, `pi`, or `kimi-k27-shadow`
- omit `--phase` unless you intentionally need a different file stem

The substrate writes:

| Path | What |
| --- | --- |
| `$COUNCIL_DIR/<artifact-name>.md` | Final reviewer response; consume this |
| `$COUNCIL_DIR/<artifact-name>.status.json` | Terminal state and message |
| `$COUNCIL_DIR/<artifact-name>.usage.json` | Token/cost telemetry when available |
| `$COUNCIL_DIR/<artifact-name>.events.jsonl` | One cmux lifecycle event per line |
| `$COUNCIL_DIR/<artifact-name>.pane.log` | Captured pane scrollback |
| `$COUNCIL_DIR/<artifact-name>.provenance.json` | Substrate host/tier and native workspace provenance |
| `$COUNCIL_DIR/<artifact-name>.cli.json` | cmux-spawn stdout final JSON |
| `$COUNCIL_DIR/<artifact-name>.cli.stderr` | cmux-spawn stderr diagnostics |

The status file's `state` is authoritative. State `complete` plus a
non-empty `.md` artifact means the lane is usable.

Kimi shadow is non-merge-authoritative and enabled by default. If it is
explicitly disabled or unavailable, write
`$COUNCIL_DIR/kimi-k27-shadow.disabled.json` with:

```json
{"enabled":false,"reason":"disabled-by-config","mergeAuthoritative":false}
```

Allowed reasons are `disabled-by-config`, `substrate-unavailable`, and
`preflight-failed`. A missing Kimi artifact and missing disabled marker
is a manual-council defect.

### Opus Via Claude

```bash
# Phase 1 - independent review
"$CMUX_SPAWN_BIN" run \
    --agent claude --model opus \
    --allowed-tools "Read,Grep,Glob,Bash(git diff *),Bash(git log *),Bash(git show *),Bash(find *)" \
    --workspace "$WORKSPACE_PATH" \
    --prompt-file "$COUNCIL_DIR/phase1-opus-prompt.md" \
    --artifact-dir "$COUNCIL_DIR" \
    --artifact-name phase1-opus \
    --lane-id opus \
    --timeout-seconds 1800 \
    > "$COUNCIL_DIR/phase1-opus.cli.json" \
    2> "$COUNCIL_DIR/phase1-opus.cli.stderr"

# Phase 2 - Opus cross-examines Pi findings only
"$CMUX_SPAWN_BIN" run \
    --agent claude --model opus \
    --allowed-tools "Read,Grep,Glob,Bash(git diff *),Bash(git log *),Bash(git show *),Bash(find *)" \
    --workspace "$WORKSPACE_PATH" \
    --prompt-file "$COUNCIL_DIR/cross-exam-opus-prompt.md" \
    --artifact-dir "$COUNCIL_DIR" \
    --artifact-name phase2-opus \
    --lane-id opus \
    --timeout-seconds 1800 \
    > "$COUNCIL_DIR/phase2-opus.cli.json" \
    2> "$COUNCIL_DIR/phase2-opus.cli.stderr"
```

**Opus rules:**

- Use `--agent claude --model opus`.
- Do not call `claude -p` or `claude --bg` directly; cmux-spawn owns
  the Claude background session, daemon-state polling, and cleanup.
- Keep tools read-only. Do not include `Write` or `Edit` during review.
- A Claude lane may be quiet for most of its run. Once `cmux-spawn run`
  is launched, let the process run to its own terminal JSON or
  `--timeout-seconds`; do not stop it only because the interim status
  is unchanged.
- The expected in-progress state is `running`. If an older substrate
  build leaves a live Claude lane at `starting`, treat that as a stale
  progress display, not a failure, unless `.cli.stderr`, `.status.json`,
  or `.pane.log` shows a terminal startup error.
- After artifact and usage collection, cmux-spawn should close the cmux
  workspace and stop the native Claude daemon session. If `ps` still
  shows Claude processes, check `claude daemon status` before assuming
  the council lane is still active.
- If state is not `complete`, inspect `.cli.stderr`, `.status.json`,
  and `.pane.log`, record the failure, and degrade.

### Pi Via Hosted DeepSeek

```bash
"$CMUX_SPAWN_BIN" run \
    --agent pi --provider deepseek --model deepseek-v4-pro --thinking high \
    --tools "read,grep,find,ls" \
    --workspace "$WORKSPACE_PATH" \
    --prompt-file "$COUNCIL_DIR/phase1-pi-prompt.md" \
    --artifact-dir "$COUNCIL_DIR" \
    --artifact-name phase1-pi \
    --lane-id pi \
    --timeout-seconds 1800 \
    > "$COUNCIL_DIR/phase1-pi.cli.json" \
    2> "$COUNCIL_DIR/phase1-pi.cli.stderr"
```

**Pi rules:**

- Use hosted DeepSeek: `--provider deepseek --model deepseek-v4-pro`.
- Restrict tools to `read,grep,find,ls`.
- Pi does not run Phase 2.
- Put the diff in the prompt file; Pi's read-only tool allowlist does
  not include shell access for `git diff`.
- Auth, quota, provider, and capacity failures require user action; do
  not retry blindly.

### Kimi K2.7 Shadow

Kimi shadow is enabled by default. Disable it with
`SYMPHONY_COUNCIL_KIMI_SHADOW_ENABLED=0` (also accept `false`, `no`,
or `off`). It uses the same lane identifier as the headless gate and
does not invent model or provider flags. Its default timeout is 300
seconds so shadow diagnostics cannot impose the full reviewer timeout;
override with `SYMPHONY_COUNCIL_KIMI_TIMEOUT_SECONDS`.

```bash
"$CMUX_SPAWN_BIN" run \
    --agent kimi \
    --workspace "$WORKSPACE_PATH" \
    --prompt-file "$COUNCIL_DIR/kimi-k27-shadow-prompt.md" \
    --artifact-dir "$COUNCIL_DIR" \
    --artifact-name kimi-k27-shadow \
    --lane-id kimi-k27-shadow \
    --timeout-seconds "${SYMPHONY_COUNCIL_KIMI_TIMEOUT_SECONDS:-300}" \
    > "$COUNCIL_DIR/kimi-k27-shadow.cli.json" \
    2> "$COUNCIL_DIR/kimi-k27-shadow.cli.stderr"
```

**Kimi rules:**

- Kimi is Phase 1 shadow diagnostics only.
- The lane is `mergeAuthoritative:false`; it cannot independently set a
  P1/P2, block merge, or satisfy clean-pass evidence.
- If enabled but unavailable, record
  `kimi-k27-shadow.disabled.json` with `reason:"substrate-unavailable"`
  or `reason:"preflight-failed"`.
- Store Kimi output in the normal `$COUNCIL_DIR` beside Opus/Pi
  artifacts so manual council smoke runs can verify presence or the
  explicit disabled marker.

### General Rules

- Always pass `--prompt-file`; cmux-spawn has no inline prompt flag.
- Always capture stdout and stderr separately.
- Never fall back to direct CLI invocations.
- No need to manage `.tmp` files for lane artifacts; cmux-spawn writes
  the final artifact only after the lane reaches a terminal state.
- Use both the shell/tool timeout and `--timeout-seconds` for long runs.
- Claude lanes are capped at 2 concurrent processes system-wide; the
  substrate enforces this via flock.
