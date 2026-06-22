#!/usr/bin/env bash
set -euo pipefail

# deploy-train.sh — mechanized deploy train for symphony-ts (SYMPH-346)
#
# WHEN TO USE THIS vs symphony-deploy (SYMPH-708):
#   - symphony-deploy is the routine, canonical deploy: it pulls + builds +
#     restarts the stable IN-PLACE checkout that symphony-ctl serves from. Use
#     it for normal deploys.
#   - deploy-train.sh is the heavyweight flow for when lanes may be running and
#     you want the strong safety gates below (drain gate + version gate). It
#     operates on a DISPOSABLE, DETACHED runtime checkout that it resets --hard
#     and checks out --detach — never point it at the stable in-place root (a
#     coherence guard refuses that; override with DEPLOY_TRAIN_ALLOW_STABLE_ROOT=1).
#   See docs/operations/05-deploy.md for the full decision and operator guidance.
#
# Sequence:
#   1. fetch origin, resolve expected SHA (origin/main, or --expect)
#      and capture the full origin/main SHA as a moving-main guard
#   2. sync + frozen-lockfile install + build the DETACHED runtime checkout
#      (early failure: a broken build aborts before any service downtime)
#   3. drain gate — require running_lane_count==0 AND retrying_lane_count==0
#      for 3 CONSECUTIVE checks 30s apart (exit→redispatch gaps false-positive
#      on single checks). --force skips.
#   4. stop the service (closes the post-drain dispatch race and the
#      mixed old/new file hazard while updating the serve checkout)
#   5. if the LaunchAgent still serves a separate checkout, sync +
#      frozen-lockfile install + build that SERVE checkout. NO auto-stash, NO
#      reset: dirty/diverged state fails loudly instead (stash-churn caused the
#      2026-06-10 stale deploy). The expected steady state is serve checkout ==
#      detached runtime checkout.
#   6. start the service
#   7. version gate — poll stdout.log for symphony_version and ASSERT it
#      contains the expected short SHA. Loud failure on mismatch.
#
# Failure modes this mechanizes away (all observed live 2026-06-10):
#   - skipped pnpm install after a lockfile delta → ERR_MODULE_NOT_FOUND crash
#   - building the runtime checkout while the service serves the dev checkout
#   - stash-churn conflict in the dev checkout → silent stale deploy,
#     restart "succeeded" on the wrong SHA with no version assertion
#   - origin/main moving after the initial fetch → stale deploy that still
#     passes the version gate for the old SHA
#
# Serve checkout: the LaunchAgent plist should point ProgramArguments and
# WorkingDirectory at the detached runtime checkout. symphony_version is
# resolved at process start via `git rev-parse --short=7 HEAD` in the service's
# working directory, so this script reads the real serve path from the plist and
# keeps a separate serve-checkout branch only for stale or custom plists.

SCRIPT_DIR="$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")" && pwd)"

# Defaults — override via environment
SYMPHONY_PROJECT="${SYMPHONY_PROJECT:-symphony}"
SERVICE_LABEL="com.symphony.${SYMPHONY_PROJECT}"
PLIST_PATH="$HOME/Library/LaunchAgents/${SERVICE_LABEL}.plist"
RUNTIME_CHECKOUT="${SYMPHONY_RUNTIME_CHECKOUT:-$HOME/.codex/worktrees/symphony-ts-runtime-main}"
CTL="$SCRIPT_DIR/symphony-ctl"
STABLE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

DRAIN_INTERVAL_SECS="${DEPLOY_DRAIN_INTERVAL_SECS:-30}"
DRAIN_REQUIRED_CONSECUTIVE=3
DRAIN_TIMEOUT_SECS="${DEPLOY_DRAIN_TIMEOUT_SECS:-3600}"
VERSION_GATE_TIMEOUT_SECS="${DEPLOY_VERSION_GATE_TIMEOUT_SECS:-180}"
VERSION_GATE_POLL_SECS=3

# Colors (disabled if not a terminal)
if [[ -t 1 ]]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; CYAN=''; NC=''
fi

ts()    { date '+%Y-%m-%dT%H:%M:%S%z'; }
info()  { echo -e "${CYAN}▸${NC} [$(ts)] $*"; }
ok()    { echo -e "${GREEN}✓${NC} [$(ts)] $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} [$(ts)] $*" >&2; }
die()   { echo -e "${RED}✗${NC} [$(ts)] $*" >&2; exit 1; }

# Coherence guard (SYMPH-708): this flow resets --hard and checks out --detach
# the runtime checkout, so its target must be a disposable detached checkout —
# never the stable in-place root that symphony-deploy / symphony-ctl serve from.
# Running against the stable root would discard local state and leave the live
# checkout detached. Refuse unless explicitly overridden.
check_runtime_checkout_not_stable_root() {
  [[ "${DEPLOY_TRAIN_ALLOW_STABLE_ROOT:-}" == "1" ]] && return 0

  local stable_real runtime_real
  stable_real="$(cd "$STABLE_ROOT" 2>/dev/null && pwd -P)" || return 0
  runtime_real="$(cd "$RUNTIME_CHECKOUT" 2>/dev/null && pwd -P)" || return 0

  if [[ "$stable_real" == "$runtime_real" ]]; then
    die "Refusing to run the detached deploy train against the stable in-place checkout: $runtime_real. This flow resets --hard and detaches its target; use 'symphony-deploy' for in-place stable-root deploys, point SYMPHONY_RUNTIME_CHECKOUT at a disposable detached checkout, or set DEPLOY_TRAIN_ALLOW_STABLE_ROOT=1 to override."
  fi
}

usage() {
  cat <<EOF
deploy-train.sh — mechanized deploy train for symphony-ts (SYMPH-346)

Usage: deploy-train.sh [flags]

Flags:
  --expect <sha>   Override the SHA asserted by the version gate
                   (default: origin/main resolved at script start)
  --force          Skip the drain gate (NOT recommended while lanes may run)
  --dry-run        Resolve everything, print the deploy plan, change nothing
  -h, --help       Show this help

Environment:
  SYMPHONY_PROJECT              Project name for service label/logs (default: symphony)
  SYMPHONY_RUNTIME_CHECKOUT     Disposable, DETACHED runtime checkout path. This
                                flow resets --hard and checks out --detach this
                                path, so it must NOT be the stable in-place root
                                that symphony-deploy / symphony-ctl serve from.
                                (default: ~/.codex/worktrees/symphony-ts-runtime-main)
  DEPLOY_TRAIN_ALLOW_STABLE_ROOT  Set to 1 to bypass the coherence guard that
                                refuses to run against the stable in-place root
                                (default: refuse)
  DEPLOY_DRAIN_INTERVAL_SECS    Seconds between drain checks (default: 30)
  DEPLOY_DRAIN_TIMEOUT_SECS     Max seconds to wait for drain (default: 3600)
  DEPLOY_VERSION_GATE_TIMEOUT_SECS  Max seconds to wait for symphony_version
                                    after restart (default: 180)

The serve path (where the LaunchAgent runs dist/ from) is read from the plist
at $HOME/Library/LaunchAgents/com.symphony.<project>.plist — not assumed.

EOF
}

# --- Flags ---

EXPECT_OVERRIDE=""
FORCE=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect)
      [[ $# -ge 2 ]] || die "--expect requires a SHA argument"
      EXPECT_OVERRIDE="$2"; shift ;;
    --force)    FORCE=true ;;
    --dry-run)  DRY_RUN=true ;;
    -h|--help)  usage; exit 0 ;;
    *)          die "Unknown flag: $1" ;;
  esac
  shift
done

# --- Preconditions ---

command -v git  &>/dev/null || die "git not found on PATH"
command -v pnpm &>/dev/null || die "pnpm not found on PATH"
command -v curl &>/dev/null || die "curl not found on PATH"
command -v jq   &>/dev/null || die "jq is required for the drain gate. Install with: brew install jq"
[[ -x /usr/libexec/PlistBuddy ]] || die "PlistBuddy not found — this script requires macOS"
[[ -x "$CTL" ]] || die "symphony-ctl not found/executable at $CTL"
[[ -f "$PLIST_PATH" ]] || die "Service plist not found at $PLIST_PATH. Install with: symphony-ctl install"
[[ -d "$RUNTIME_CHECKOUT" ]] || die "Runtime checkout not found at $RUNTIME_CHECKOUT. Set SYMPHONY_RUNTIME_CHECKOUT to override."
git -C "$RUNTIME_CHECKOUT" rev-parse --git-dir &>/dev/null || die "Runtime checkout is not a git repo: $RUNTIME_CHECKOUT"
check_runtime_checkout_not_stable_root

# --- Resolve the serve path from the plist (do NOT assume) ---

plist_read() {
  /usr/libexec/PlistBuddy -c "Print :$1" "$PLIST_PATH" 2>/dev/null
}

SERVE_WORKDIR="$(plist_read WorkingDirectory)" || true
[[ -n "$SERVE_WORKDIR" ]] || die "Could not read WorkingDirectory from $PLIST_PATH"

SERVE_CLI_JS="$(plist_read 'ProgramArguments:1')" || true
[[ -n "$SERVE_CLI_JS" ]] || die "Could not read ProgramArguments:1 (main.js path) from $PLIST_PATH"

SERVE_ROOT="${SERVE_CLI_JS%/dist/src/cli/main.js}"
if [[ "$SERVE_ROOT" == "$SERVE_CLI_JS" ]]; then
  warn "ProgramArguments:1 ($SERVE_CLI_JS) does not end in /dist/src/cli/main.js — falling back to WorkingDirectory"
  SERVE_ROOT="$SERVE_WORKDIR"
fi

if [[ "$SERVE_ROOT" != "$SERVE_WORKDIR" ]]; then
  warn "Plist WorkingDirectory ($SERVE_WORKDIR) differs from dist root ($SERVE_ROOT)."
  warn "symphony_version is resolved from WorkingDirectory; dist is served from the dist root. Both must be at the expected SHA."
fi

git -C "$SERVE_ROOT" rev-parse --git-dir &>/dev/null || die "Serve path is not a git repo: $SERVE_ROOT"

WORKFLOW_FROM_PLIST="$(plist_read 'ProgramArguments:2')" || true

# Log dir: prefer the --logs-root baked into the plist, fall back to convention
LOG_DIR="$HOME/Library/Logs/symphony/${SYMPHONY_PROJECT}"
i=0
while arg="$(plist_read "ProgramArguments:$i")" && [[ -n "$arg" ]]; do
  if [[ "$arg" == "--logs-root" ]]; then
    next="$(plist_read "ProgramArguments:$((i + 1))")" || true
    [[ -n "$next" ]] && LOG_DIR="$next"
    break
  fi
  i=$((i + 1))
done
STDOUT_LOG="$LOG_DIR/stdout.log"
STDERR_LOG="$LOG_DIR/stderr.log"

# Dashboard port: parse WORKFLOW frontmatter (same convention as symphony-ctl)
get_port() {
  if [[ -n "$WORKFLOW_FROM_PLIST" && -f "$WORKFLOW_FROM_PLIST" ]]; then
    local port
    port="$(sed -n '/^---$/,/^---$/p' "$WORKFLOW_FROM_PLIST" | grep -E '^\s*port:' | head -1 | awk '{print $2}')"
    echo "${port:-4321}"
  else
    echo "4321"
  fi
}
STATUS_URL="http://localhost:$(get_port)/api/v1/pipeline/status"

# --- Helpers ---

is_running() {
  launchctl print "gui/$(id -u)/${SERVICE_LABEL}" 2>/dev/null | grep -q 'pid = [0-9]'
}

short_sha() {
  git -C "$1" rev-parse --short=7 "$2" 2>/dev/null
}

full_sha() {
  git -C "$1" rev-parse "$2^{commit}" 2>/dev/null
}

same_path() {
  local a b
  a="$(cd "$1" 2>/dev/null && pwd -P)" || return 1
  b="$(cd "$2" 2>/dev/null && pwd -P)" || return 1
  [[ "$a" == "$b" ]]
}

file_size() {
  stat -f%z "$1" 2>/dev/null || echo 0
}

assert_origin_main_unchanged() {
  local checkpoint="$1"

  if [[ -n "$EXPECT_OVERRIDE" ]]; then
    info "Skipping moving origin/main guard before $checkpoint (--expect pins ${EXPECTED_SHA})"
    return 0
  fi

  info "Verifying origin/main has not moved before $checkpoint..."
  git -C "$RUNTIME_CHECKOUT" fetch origin || die "git fetch failed while checking moving origin/main guard in $RUNTIME_CHECKOUT"

  local current_sha
  current_sha="$(full_sha "$RUNTIME_CHECKOUT" origin/main)" || die "Could not resolve origin/main while checking moving-main guard"

  if [[ "$current_sha" != "$EXPECTED_FULL_SHA" ]]; then
    die "origin/main moved during deploy train before $checkpoint: started at ${EXPECTED_FULL_SHA:0:12}, now ${current_sha:0:12}. Aborting instead of deploying a stale build; re-run deploy-train to deploy the new head."
  fi

  ok "origin/main unchanged (${current_sha:0:7})"
}

# Restore-on-failure: if the script dies after stopping the service, bring it
# back up on the previous build so a failed deploy never leaves the pipeline
# silently dead. (set -e alone would exit with the service down.)
SERVICE_STOPPED=false
cleanup_on_exit() {
  local code=$?
  if [[ $code -ne 0 ]] && $SERVICE_STOPPED; then
    warn "Deploy failed after the service was stopped — restarting on the previous build..."
    if "$CTL" start; then
      warn "Service restarted on the PREVIOUS build. The deploy did NOT land."
    else
      warn "Could not restart the service — it is DOWN. Run: $CTL start"
    fi
  fi
  exit "$code"
}
trap cleanup_on_exit EXIT

# --- Step 1: fetch + resolve expected SHA ---

info "=== deploy-train ==="
info "Service:          $SERVICE_LABEL"
info "Serve checkout:   $SERVE_ROOT"
info "Runtime checkout: $RUNTIME_CHECKOUT"
info "Status endpoint:  $STATUS_URL"
info "Stdout log:       $STDOUT_LOG"
echo ""

info "Fetching origin in runtime checkout..."
git -C "$RUNTIME_CHECKOUT" fetch origin || die "git fetch failed in $RUNTIME_CHECKOUT"
if ! same_path "$SERVE_ROOT" "$RUNTIME_CHECKOUT"; then
  info "Fetching origin in serve checkout..."
  git -C "$SERVE_ROOT" fetch origin || die "git fetch failed in $SERVE_ROOT"
fi

if [[ -n "$EXPECT_OVERRIDE" ]]; then
  [[ "$EXPECT_OVERRIDE" =~ ^[0-9a-f]{7,40}$ ]] || die "--expect must be a 7-40 char lowercase hex SHA, got: $EXPECT_OVERRIDE"
  EXPECTED_SHA="${EXPECT_OVERRIDE:0:7}"
  info "Expected SHA (from --expect): $EXPECTED_SHA"
  EXPECTED_FULL_SHA=""
else
  EXPECTED_FULL_SHA="$(full_sha "$RUNTIME_CHECKOUT" origin/main)" || die "Could not resolve origin/main in $RUNTIME_CHECKOUT"
  [[ -n "$EXPECTED_FULL_SHA" ]] || die "Could not resolve origin/main in $RUNTIME_CHECKOUT"
  EXPECTED_SHA="$(short_sha "$RUNTIME_CHECKOUT" origin/main)" || die "Could not resolve origin/main in $RUNTIME_CHECKOUT"
  info "Expected SHA (origin/main):   $EXPECTED_SHA"
fi

SERVE_PRE_SHA="$(short_sha "$SERVE_ROOT" HEAD || echo 'unknown')"
RUNTIME_PRE_SHA="$(short_sha "$RUNTIME_CHECKOUT" HEAD || echo 'unknown')"

# --- Dry run: print the plan and exit ---

if $DRY_RUN; then
  echo ""
  info "=== DRY RUN — deploy plan (nothing will be executed) ==="
  info "1. Runtime checkout sync: $RUNTIME_CHECKOUT"
  info "     ${RUNTIME_PRE_SHA} → ${EXPECTED_SHA} (git checkout --detach origin/main; reset --hard first if dirty)"
  info "     pnpm install --frozen-lockfile && pnpm build"
  if $FORCE; then
    info "2. Drain gate: SKIPPED (--force)"
  else
    info "2. Drain gate: require running_lane_count==0 AND retrying_lane_count==0"
    info "     ${DRAIN_REQUIRED_CONSECUTIVE} consecutive checks, ${DRAIN_INTERVAL_SECS}s apart, timeout ${DRAIN_TIMEOUT_SECS}s"
    probe="$(curl -s --max-time 10 "$STATUS_URL" 2>/dev/null || true)"
    if [[ -n "$probe" ]]; then
      running="$(jq -r '.restart_safety.running_lane_count // "?"' <<<"$probe" 2>/dev/null || echo '?')"
      retrying="$(jq -r '.restart_safety.retrying_lane_count // "?"' <<<"$probe" 2>/dev/null || echo '?')"
      info "     current: running=$running retrying=$retrying"
    else
      info "     current: status endpoint unreachable"
    fi
  fi
  info "3. Stop service: $CTL stop"
  if same_path "$SERVE_ROOT" "$RUNTIME_CHECKOUT"; then
    info "4. Serve checkout == runtime checkout — no separate build"
  else
    info "4. Serve checkout sync: $SERVE_ROOT"
    info "     ${SERVE_PRE_SHA} → ${EXPECTED_SHA} (ff-only merge; FAILS LOUDLY if dirty/diverged — no stash)"
    info "     pnpm install --frozen-lockfile && pnpm build"
  fi
  info "5. Start service: $CTL start"
  info "6. Version gate: poll $STDOUT_LOG for symphony_version containing +${EXPECTED_SHA} (timeout ${VERSION_GATE_TIMEOUT_SECS}s)"
  echo ""
  ok "Dry run complete — no changes were made."
  exit 0
fi

# --- Step 2: sync + build the runtime checkout (early failure, no downtime) ---

echo ""
info "=== Runtime checkout: $RUNTIME_CHECKOUT ==="

if ! git -C "$RUNTIME_CHECKOUT" diff-index --quiet HEAD -- 2>/dev/null; then
  warn "Runtime checkout has local modifications — discarding (deploy target has no state worth preserving)"
  git -C "$RUNTIME_CHECKOUT" reset --hard HEAD
fi
info "Detaching to origin/main..."
git -C "$RUNTIME_CHECKOUT" checkout --detach origin/main || die "git checkout --detach origin/main failed in $RUNTIME_CHECKOUT"
ok "Runtime checkout at $(short_sha "$RUNTIME_CHECKOUT" HEAD) (was $RUNTIME_PRE_SHA)"

info "Installing dependencies (frozen lockfile, always — lockfile deltas crashed the service on 2026-06-10)..."
pnpm install --frozen-lockfile --dir "$RUNTIME_CHECKOUT" || die "pnpm install --frozen-lockfile failed in $RUNTIME_CHECKOUT"
ok "Dependencies installed"

info "Building runtime checkout..."
pnpm run --dir "$RUNTIME_CHECKOUT" build || die "Build failed in $RUNTIME_CHECKOUT — aborting before touching the service"
ok "Runtime checkout built"

assert_origin_main_unchanged "drain gate"

# --- Step 3: drain gate ---

echo ""
if $FORCE; then
  warn "=== Drain gate SKIPPED (--force) ==="
elif ! is_running; then
  warn "=== Drain gate skipped — service is not running (nothing to drain) ==="
else
  info "=== Drain gate: $STATUS_URL ==="
  info "Require running_lane_count==0 AND retrying_lane_count==0 for ${DRAIN_REQUIRED_CONSECUTIVE} consecutive checks ${DRAIN_INTERVAL_SECS}s apart"

  consecutive=0
  drain_deadline=$((SECONDS + DRAIN_TIMEOUT_SECS))
  while true; do
    response="$(curl -s --max-time 15 "$STATUS_URL" 2>/dev/null || true)"
    running=""
    retrying=""
    if [[ -n "$response" ]]; then
      running="$(jq -r '.restart_safety.running_lane_count // empty' <<<"$response" 2>/dev/null || true)"
      retrying="$(jq -r '.restart_safety.retrying_lane_count // empty' <<<"$response" 2>/dev/null || true)"
    fi

    if [[ "$running" == "0" && "$retrying" == "0" ]]; then
      consecutive=$((consecutive + 1))
      info "Drain check ${consecutive}/${DRAIN_REQUIRED_CONSECUTIVE}: idle (running=0 retrying=0)"
    elif [[ -z "$running" || -z "$retrying" ]]; then
      consecutive=0
      warn "Drain check: status endpoint unreachable or missing restart_safety — counter reset"
    else
      consecutive=0
      info "Drain check: lanes active (running=$running retrying=$retrying) — counter reset"
    fi

    if [[ $consecutive -ge $DRAIN_REQUIRED_CONSECUTIVE ]]; then
      ok "Drain gate passed — pipeline idle for ${DRAIN_REQUIRED_CONSECUTIVE} consecutive checks"
      break
    fi
    if [[ $SECONDS -ge $drain_deadline ]]; then
      die "Drain gate timed out after ${DRAIN_TIMEOUT_SECS}s — lanes still active or status unreachable. Re-run later, or use --force ONLY if you are certain nothing is running."
    fi
    sleep "$DRAIN_INTERVAL_SECS"
  done
fi

assert_origin_main_unchanged "service stop"

# --- Step 4: stop the service ---

echo ""
info "=== Stopping service ==="
if is_running; then
  SERVICE_STOPPED=true
  "$CTL" stop || die "symphony-ctl stop failed"
else
  info "Service already stopped"
  SERVICE_STOPPED=true
fi

# --- Step 5: sync + build the serve checkout ---

echo ""
if same_path "$SERVE_ROOT" "$RUNTIME_CHECKOUT"; then
  ok "=== Serve checkout is the runtime checkout — already synced and built ==="
else
  assert_origin_main_unchanged "serve checkout sync"

  info "=== Serve checkout: $SERVE_ROOT ==="
  warn "The service serves dist/ from a separate checkout; expected steady state is a plist rooted at SYMPHONY_RUNTIME_CHECKOUT."

  serve_branch="$(git -C "$SERVE_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown')"

  if ! git -C "$SERVE_ROOT" diff-index --quiet HEAD -- 2>/dev/null; then
    die "Serve checkout $SERVE_ROOT has uncommitted tracked changes. The deploy train will NOT stash (stash-churn caused the 2026-06-10 stale deploy). Commit or stash manually, then re-run."
  fi
  if [[ "$serve_branch" != "main" ]]; then
    die "Serve checkout $SERVE_ROOT is on '$serve_branch', not 'main'. The deploy train will not switch branches in the dev working repo. Check out main manually, then re-run."
  fi

  info "Fast-forwarding main to origin/main..."
  git -C "$SERVE_ROOT" merge --ff-only origin/main || die "main has diverged from origin/main in $SERVE_ROOT — resolve manually (no auto-stash, no reset in the dev checkout)"
  ok "Serve checkout at $(short_sha "$SERVE_ROOT" HEAD) (was $SERVE_PRE_SHA)"

  serve_head="$(short_sha "$SERVE_ROOT" HEAD)"
  if [[ "$serve_head" != "$EXPECTED_SHA" ]]; then
    die "Serve checkout HEAD ($serve_head) != expected SHA ($EXPECTED_SHA) after sync — refusing to deploy a mismatched build"
  fi

  info "Installing dependencies (frozen lockfile, always)..."
  pnpm install --frozen-lockfile --dir "$SERVE_ROOT" || die "pnpm install --frozen-lockfile failed in $SERVE_ROOT"
  ok "Dependencies installed"

  info "Building serve checkout..."
  pnpm run --dir "$SERVE_ROOT" build || die "Build failed in $SERVE_ROOT"
  ok "Serve checkout built"
fi

assert_origin_main_unchanged "service start"

# --- Step 6: start the service ---

echo ""
info "=== Starting service ==="
stdout_offset="$(file_size "$STDOUT_LOG")"
"$CTL" start || die "symphony-ctl start failed"
SERVICE_STOPPED=false

# --- Step 7: version gate ---

echo ""
info "=== Version gate: expect symphony_version containing +${EXPECTED_SHA} ==="
info "Polling $STDOUT_LOG (timeout ${VERSION_GATE_TIMEOUT_SECS}s)..."

actual_version=""
gate_deadline=$((SECONDS + VERSION_GATE_TIMEOUT_SECS))
while true; do
  current_size="$(file_size "$STDOUT_LOG")"
  if [[ $current_size -lt $stdout_offset ]]; then
    # Log rotated under us — scan from the top of the new file
    stdout_offset=0
  fi
  line="$(tail -c "+$((stdout_offset + 1))" "$STDOUT_LOG" 2>/dev/null | grep '"symphony_version"' | tail -1 || true)"
  if [[ -n "$line" ]]; then
    actual_version="$(grep -oE '"symphony_version":"[^"]+"' <<<"$line" | head -1 | cut -d'"' -f4)"
    [[ -n "$actual_version" ]] && break
  fi
  if [[ $SECONDS -ge $gate_deadline ]]; then
    echo "" >&2
    warn "================================================================"
    warn "VERSION GATE TIMED OUT after ${VERSION_GATE_TIMEOUT_SECS}s"
    warn "No symphony_version line appeared in $STDOUT_LOG since restart."
    warn "The service may have crashed on startup. Last stderr lines:"
    tail -10 "$STDERR_LOG" 2>/dev/null | sed 's/^/    /' >&2 || true
    warn "================================================================"
    die "Cannot verify the deployed version — treat this deploy as FAILED."
  fi
  sleep "$VERSION_GATE_POLL_SECS"
done

if [[ "$actual_version" == *"+${EXPECTED_SHA}"* ]]; then
  ok "VERSION GATE PASSED: symphony_version=$actual_version contains +${EXPECTED_SHA}"
else
  echo "" >&2
  warn "================================================================"
  warn "VERSION GATE FAILED — THE SERVICE IS RUNNING THE WRONG BUILD"
  warn "  expected symphony_version to contain: +${EXPECTED_SHA}"
  warn "  actual   symphony_version:            ${actual_version}"
  warn "The restart 'succeeded' but did NOT land the expected SHA."
  warn "This is the silent-stale-deploy failure mode from 2026-06-10."
  warn "================================================================"
  die "Version gate failed: expected +${EXPECTED_SHA}, got ${actual_version}"
fi

# --- Summary ---

echo ""
info "=== Summary ==="
printf "  serve checkout:   %s → %s\n" "$SERVE_PRE_SHA" "$(short_sha "$SERVE_ROOT" HEAD)"
printf "  runtime checkout: %s → %s\n" "$RUNTIME_PRE_SHA" "$(short_sha "$RUNTIME_CHECKOUT" HEAD)"
printf "  symphony_version: %s\n" "$actual_version"
ok "Deploy train complete."
