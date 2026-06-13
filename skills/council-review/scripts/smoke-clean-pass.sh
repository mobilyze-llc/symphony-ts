#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSERT="$SCRIPT_DIR/assert-clean-pass.py"
WRITE_TARGET="$SCRIPT_DIR/write-review-target-artifacts.py"
WORK_DIR="${TMPDIR:-/tmp}/council-clean-pass-smoke.$$"
mkdir -p "$WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

write_case() {
  local dir="$1"
  local mode="$2"
  local draft="$3"
  local gh_exit="$4"
  local git_status="$5"
  local provenance="$6"
  local base_equivalence="$7"
  local pr_head="${8:-1111111111111111111111111111111111111111}"
  local local_head="${9:-1111111111111111111111111111111111111111}"
  local pr_base="${10:-2222222222222222222222222222222222222222}"
  local local_base="${11:-2222222222222222222222222222222222222222}"

  mkdir -p "$dir"
  printf '%s\n' "$mode" > "$dir/pr-mode.txt"
  printf '%s\n' "$draft" > "$dir/pr-is-draft.txt"
  printf '%s\n' "$gh_exit" > "$dir/pr-view-exit-code.txt"
  printf '%s' "$git_status" > "$dir/git-status-short.txt"
  printf '%s\n' "$provenance" > "$dir/pr-diff-provenance.txt"
  printf '%s\n' "$base_equivalence" > "$dir/pr-base-equivalence.txt"
  printf '%s\n' "$pr_head" > "$dir/pr-head-sha.txt"
  printf '%s\n' "$local_head" > "$dir/local-head-sha.txt"
  printf '%s\n' "$pr_base" > "$dir/pr-base-sha.txt"
  printf '%s\n' "$local_base" > "$dir/resolved-base-sha.txt"
}

expect_pass() {
  local name="$1"
  local dir="$2"
  "$ASSERT" "$dir" > "$dir/assertion.out"
  echo "PASS $name"
}

expect_fail() {
  local name="$1"
  local dir="$2"
  if "$ASSERT" "$dir" > "$dir/assertion.out" 2> "$dir/assertion.err"; then
    echo "Expected failure but helper passed: $name" >&2
    cat "$dir/assertion.out" >&2
    exit 1
  fi
  echo "PASS $name"
}

clean="$WORK_DIR/clean-draft"
write_case "$clean" "PR-backed draft" "true" "0" "" "match" "exact"
expect_pass "matching PR-backed draft" "$clean"

safe_base="$WORK_DIR/safe-base-equivalence"
write_case "$safe_base" "PR-backed draft" "true" "0" "" "match" "origin-prefix-equivalent"
expect_pass "explicit safe base equivalence" "$safe_base"

head_mismatch="$WORK_DIR/head-mismatch"
write_case "$head_mismatch" "PR-backed draft" "true" "0" "" "mismatch pr-head" "exact" \
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
expect_fail "PR head mismatch or unpushed local HEAD" "$head_mismatch"

base_mismatch="$WORK_DIR/base-mismatch"
write_case "$base_mismatch" "PR-backed draft" "true" "0" "" "mismatch pr-base-sha" "mismatch" \
  "1111111111111111111111111111111111111111" "1111111111111111111111111111111111111111" \
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
expect_fail "base mismatch" "$base_mismatch"

non_draft="$WORK_DIR/non-draft"
write_case "$non_draft" "PR-backed non-draft deviation" "false" "0" "" "match" "exact"
expect_fail "non-draft deviation" "$non_draft"

dirty="$WORK_DIR/dirty"
write_case "$dirty" "DEGRADED dirty working tree" "true" "0" " M council-review/SKILL.md"$'\n' "match" "exact"
expect_fail "dirty tree" "$dirty"

gh_unavailable="$WORK_DIR/gh-unavailable"
write_case "$gh_unavailable" "DEGRADED gh-unavailable" "unknown" "1" "" "unknown" "unknown"
expect_fail "gh-unavailable" "$gh_unavailable"

no_pr="$WORK_DIR/no-pr"
write_case "$no_pr" "committed branch diff" "none" "1" "" "none" "none"
expect_fail "no-PR committed branch diff" "$no_pr"

missing="$WORK_DIR/missing-artifact"
write_case "$missing" "PR-backed draft" "true" "0" "" "match" "exact"
rm "$missing/pr-head-sha.txt"
expect_fail "missing required artifact" "$missing"

sentinel="$WORK_DIR/sentinel-collision"
write_case "$sentinel" "PR-backed draft" "true" "0" "" "match" "exact" \
  "unknown" "unknown" "unknown" "unknown"
expect_fail "sentinel SHA collision" "$sentinel"

sha256="$WORK_DIR/sha256-object-ids"
write_case "$sha256" "PR-backed draft" "true" "0" "" "match" "exact" \
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" \
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
expect_pass "64-char object IDs" "$sha256"

missing_status="$WORK_DIR/missing-git-status"
write_case "$missing_status" "PR-backed draft" "true" "0" "" "match" "exact"
rm "$missing_status/git-status-short.txt"
expect_fail "missing git status artifact" "$missing_status"

helper="$WORK_DIR/write-target-artifacts"
mkdir -p "$helper"
printf '%s\n' "0" > "$helper/pr-view-exit-code.txt"
printf '%s' "" > "$helper/git-status-short.txt"
printf '%s\n' "1111111111111111111111111111111111111111" > "$helper/local-head-sha.txt"
printf '%s\n' "2222222222222222222222222222222222222222" > "$helper/resolved-base-sha.txt"
printf '%s\n' "origin/main" > "$helper/resolved-base-ref.txt"
printf '%s\n' '{"isDraft":true,"headRefOid":"1111111111111111111111111111111111111111","baseRefOid":"2222222222222222222222222222222222222222","baseRefName":"main"}' > "$helper/pr.json"
"$WRITE_TARGET" "$helper"
"$ASSERT" "$helper" > "$helper/assertion.out"
echo "PASS write-review-target-artifacts clean draft"
