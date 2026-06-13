#!/usr/bin/env python3
"""Write council-review target/provenance artifacts from setup facts."""

from __future__ import annotations

from pathlib import Path
import json
import sys


UNKNOWN = "unknown"
NONE = "none"


def read_text(artifact_dir: Path, name: str, default: str = "") -> str:
    path = artifact_dir / name
    if not path.exists():
        return default
    return path.read_text(encoding="utf-8").strip()


def write_text(artifact_dir: Path, name: str, value: str) -> None:
    (artifact_dir / name).write_text(f"{value}\n", encoding="utf-8")


def write_unknown_pr(artifact_dir: Path) -> None:
    for name in (
        "pr-is-draft.txt",
        "pr-head-sha.txt",
        "pr-base-sha.txt",
        "pr-base-ref.txt",
        "pr-base-equivalence.txt",
        "pr-diff-provenance.txt",
    ):
        write_text(artifact_dir, name, UNKNOWN)


def write_no_pr(artifact_dir: Path) -> None:
    for name in (
        "pr-is-draft.txt",
        "pr-head-sha.txt",
        "pr-base-sha.txt",
        "pr-base-ref.txt",
        "pr-base-equivalence.txt",
        "pr-diff-provenance.txt",
    ):
        write_text(artifact_dir, name, NONE)


def equivalent_base_ref(pr_base_ref: str, resolved_base_ref: str) -> str:
    if pr_base_ref == resolved_base_ref:
        return "exact"
    origin_prefix = "origin/"
    resolved_without_origin = (
        resolved_base_ref[len(origin_prefix) :]
        if resolved_base_ref.startswith(origin_prefix)
        else resolved_base_ref
    )
    if pr_base_ref == resolved_without_origin:
        return "origin-prefix-equivalent"
    return "mismatch"


def write_pr_artifacts(artifact_dir: Path, pr: dict[str, object]) -> int:
    is_draft = pr.get("isDraft")
    if not isinstance(is_draft, bool):
        print(
            "Cannot mechanically assert PR draft state from gh/pr.json; "
            "refusing PR-backed clean PASS.",
            file=sys.stderr,
        )
        return 1

    pr_head_sha = str(pr.get("headRefOid") or "")
    pr_base_sha = str(pr.get("baseRefOid") or "")
    pr_base_ref = str(pr.get("baseRefName") or "")
    local_head_sha = read_text(artifact_dir, "local-head-sha.txt")
    resolved_base_sha = read_text(artifact_dir, "resolved-base-sha.txt")
    resolved_base_ref = read_text(artifact_dir, "resolved-base-ref.txt")
    base_equivalence = equivalent_base_ref(pr_base_ref, resolved_base_ref)

    write_text(artifact_dir, "pr-is-draft.txt", str(is_draft).lower())
    write_text(artifact_dir, "pr-head-sha.txt", pr_head_sha)
    write_text(artifact_dir, "pr-base-sha.txt", pr_base_sha)
    write_text(artifact_dir, "pr-base-ref.txt", pr_base_ref)
    write_text(artifact_dir, "pr-base-equivalence.txt", base_equivalence)

    if pr_head_sha != local_head_sha:
        write_text(artifact_dir, "pr-diff-provenance.txt", "mismatch pr-head")
        print(
            "PR head SHA does not match local HEAD; refusing PR-backed clean PASS.",
            file=sys.stderr,
        )
    elif base_equivalence == "mismatch":
        write_text(artifact_dir, "pr-diff-provenance.txt", "mismatch pr-base-ref")
        print(
            "PR base ref does not match resolved BASE_BRANCH or an explicit "
            "safe equivalence; refusing PR-backed clean PASS.",
            file=sys.stderr,
        )
    elif pr_base_sha != resolved_base_sha:
        write_text(artifact_dir, "pr-diff-provenance.txt", "mismatch pr-base-sha")
        print(
            "PR base SHA does not match resolved BASE_BRANCH SHA; refusing "
            "PR-backed clean PASS.",
            file=sys.stderr,
        )
    else:
        write_text(artifact_dir, "pr-diff-provenance.txt", "match")

    return 0


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: write-review-target-artifacts.py COUNCIL_DIR", file=sys.stderr)
        return 2

    artifact_dir = Path(sys.argv[1])
    pr_json_path = artifact_dir / "pr.json"
    pr_view_status = read_text(artifact_dir, "pr-view-exit-code.txt", "127")
    git_status = read_text(artifact_dir, "git-status-short.txt")
    pr_stderr = read_text(artifact_dir, "pr.stderr").lower()
    has_pr_json = pr_json_path.exists() and pr_json_path.stat().st_size > 0
    pr_detection_degraded = False
    pr_diff_provenance_degraded = False

    if has_pr_json:
        try:
            pr = json.loads(pr_json_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            print(f"Cannot parse gh/pr.json: {exc}", file=sys.stderr)
            return 1
        if write_pr_artifacts(artifact_dir, pr) != 0:
            return 1
        pr_diff_provenance_degraded = (
            read_text(artifact_dir, "pr-diff-provenance.txt") != "match"
        )
    elif pr_view_status != "0" and "no pull requests found" not in pr_stderr:
        pr_detection_degraded = True
        write_unknown_pr(artifact_dir)
        print(
            "Cannot determine whether a PR exists or assert draft state; "
            "treating PR detection as degraded.",
            file=sys.stderr,
        )
    else:
        write_no_pr(artifact_dir)

    if pr_detection_degraded:
        mode = "DEGRADED gh-unavailable"
    elif git_status:
        mode = "DEGRADED dirty working tree"
    elif not has_pr_json:
        mode = "committed branch diff"
    elif read_text(artifact_dir, "pr-is-draft.txt") != "true":
        mode = "PR-backed non-draft deviation"
    elif pr_diff_provenance_degraded:
        mode = "DEGRADED pr-diff-provenance"
    elif read_text(artifact_dir, "pr-is-draft.txt") == "true":
        mode = "PR-backed draft"
    else:
        mode = "PR-backed non-draft deviation"

    write_text(artifact_dir, "pr-mode.txt", mode)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
