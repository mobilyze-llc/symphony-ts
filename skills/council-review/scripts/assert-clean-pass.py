#!/usr/bin/env python3
"""Fail closed unless council-review artifacts prove a PR-backed clean PASS."""

from pathlib import Path
import re
import sys


PASS_MODE = "PR-backed draft"
SAFE_BASE_EQUIVALENCE = {"exact", "origin-prefix-equivalent"}
SHA_RE = re.compile(r"[0-9a-fA-F]{7,64}")
REQUIRED_ARTIFACTS = (
    "pr-mode.txt",
    "pr-is-draft.txt",
    "pr-view-exit-code.txt",
    "git-status-short.txt",
    "pr-diff-provenance.txt",
    "pr-base-equivalence.txt",
    "pr-head-sha.txt",
    "local-head-sha.txt",
    "pr-base-sha.txt",
    "resolved-base-sha.txt",
)


def read_text(artifact_dir: Path, name: str, required: bool = True) -> str:
    path = artifact_dir / name
    if not path.exists():
        if required:
            raise FileNotFoundError(f"missing required artifact: {name}")
        return ""
    return path.read_text(encoding="utf-8").strip()


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: assert-clean-pass.py COUNCIL_DIR", file=sys.stderr)
        return 2

    artifact_dir = Path(sys.argv[1])
    failures = []
    missing = [name for name in REQUIRED_ARTIFACTS if not (artifact_dir / name).exists()]

    if missing:
        print("FAIL council-review clean PASS assertion")
        for name in missing:
            print(f"- missing required artifact: {name}")
        return 1

    pr_mode = read_text(artifact_dir, "pr-mode.txt")
    pr_is_draft = read_text(artifact_dir, "pr-is-draft.txt")
    pr_view_exit = read_text(artifact_dir, "pr-view-exit-code.txt")
    git_status = read_text(artifact_dir, "git-status-short.txt")
    provenance = read_text(artifact_dir, "pr-diff-provenance.txt")
    base_equivalence = read_text(artifact_dir, "pr-base-equivalence.txt")
    pr_head_sha = read_text(artifact_dir, "pr-head-sha.txt")
    local_head_sha = read_text(artifact_dir, "local-head-sha.txt")
    pr_base_sha = read_text(artifact_dir, "pr-base-sha.txt")
    resolved_base_sha = read_text(artifact_dir, "resolved-base-sha.txt")

    if pr_mode != PASS_MODE:
        failures.append(f"pr-mode.txt must be {PASS_MODE!r}, got {pr_mode!r}")
    if pr_is_draft != "true":
        failures.append(f"pr-is-draft.txt must be 'true', got {pr_is_draft!r}")
    if pr_view_exit != "0":
        failures.append(f"pr-view-exit-code.txt must be '0', got {pr_view_exit!r}")
    if git_status:
        failures.append("git-status-short.txt must be empty for a clean PASS")
    if provenance != "match":
        failures.append(f"pr-diff-provenance.txt must be 'match', got {provenance!r}")
    if base_equivalence not in SAFE_BASE_EQUIVALENCE:
        failures.append(
            "pr-base-equivalence.txt must be one of "
            f"{sorted(SAFE_BASE_EQUIVALENCE)!r}, got {base_equivalence!r}"
        )
    if not pr_head_sha or pr_head_sha != local_head_sha:
        failures.append("PR head SHA must match local HEAD")
    if not pr_base_sha or pr_base_sha != resolved_base_sha:
        failures.append("PR base SHA must match the resolved local base ref")
    for label, value in (
        ("pr-head-sha.txt", pr_head_sha),
        ("local-head-sha.txt", local_head_sha),
        ("pr-base-sha.txt", pr_base_sha),
        ("resolved-base-sha.txt", resolved_base_sha),
    ):
        if not SHA_RE.fullmatch(value or ""):
            failures.append(f"{label} must be a 7-64 character hex object ID")

    if failures:
        print("FAIL council-review clean PASS assertion")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print("PASS council-review clean PASS assertion")
    print(f"- mode: {pr_mode}")
    print(f"- draft: {pr_is_draft}")
    print(f"- pr head/local HEAD: {pr_head_sha}")
    print(f"- base equivalence: {base_equivalence}")
    print(f"- pr base/resolved base: {pr_base_sha}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
