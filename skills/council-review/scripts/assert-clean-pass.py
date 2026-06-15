#!/usr/bin/env python3
"""Fail closed unless council-review artifacts prove a PR-backed clean PASS."""

from pathlib import Path
import json
import re
import sys


PASS_MODE = "PR-backed draft"
SAFE_BASE_EQUIVALENCE = {"exact", "origin-prefix-equivalent"}
SHA_RE = re.compile(r"[0-9a-fA-F]{7,64}")
LANE_ARTIFACT_STEMS = ("phase1-opus", "phase1-pi")
MIN_REVIEW_ARTIFACT_BYTES = 400
REQUIRED_REVIEW_HEADINGS = (
    "## Verdict",
    "## Artifact Quality",
)
VERDICT_RE = re.compile(r"\A\s*## Verdict\s*\n\s*(PASS|FINDINGS)\s*(?:\n|\Z)")
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


def read_text(artifact_dir: Path, name: str) -> str:
    path = artifact_dir / name
    return path.read_text(encoding="utf-8").strip()


def optional_text(artifact_dir: Path, name: str) -> str | None:
    path = artifact_dir / name
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8").strip()


def read_json_object(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def has_heading(text: str, heading: str) -> bool:
    return re.search(rf"(?m)^{re.escape(heading)}\s*$", text) is not None


def has_findings_surface(text: str) -> bool:
    if has_heading(text, "## No Findings"):
        return True
    return all(
        has_heading(text, heading)
        for heading in (
            "## P1 Must Fix",
            "## P2 Should Fix",
            "## Track",
        )
    )


def status_claims_blockers(status_message: str) -> bool:
    return re.search(r"\bP[12]s?\b", status_message, re.IGNORECASE) is not None


def validate_review_artifacts(artifact_dir: Path) -> list[str]:
    failures = []
    valid_lane_count = 0
    expected_head = optional_text(artifact_dir, "pr-head-sha.txt") or optional_text(
        artifact_dir, "local-head-sha.txt"
    )

    for stem in LANE_ARTIFACT_STEMS:
        artifact_path = artifact_dir / f"{stem}.md"
        status_path = artifact_dir / f"{stem}.status.json"
        cli_json_path = artifact_dir / f"{stem}.cli.json"
        status = read_json_object(status_path) if status_path.exists() else {}
        status_state = str(status.get("state") or "").strip().lower()
        status_message = str(status.get("message") or "").strip()
        status_artifact = str(status.get("artifact") or "").strip()
        completed = status_state == "complete"
        observed = completed or artifact_path.exists()

        if not observed:
            continue
        lane_failure_count = len(failures)

        resolved_artifact_path = (
            Path(status_artifact)
            if status_artifact
            else artifact_path
        )
        if not resolved_artifact_path.is_absolute():
            resolved_artifact_path = artifact_dir / resolved_artifact_path

        if completed and not artifact_path.exists() and not resolved_artifact_path.exists():
            failures.append(
                f"{stem}: status is complete but reviewer artifact is missing"
            )
            continue

        path_to_read = artifact_path if artifact_path.exists() else resolved_artifact_path
        if not path_to_read.exists():
            failures.append(
                f"{stem}: reviewer artifact path does not exist: {path_to_read}"
            )
            continue

        artifact = path_to_read.read_text(encoding="utf-8", errors="replace")
        byte_count = len(artifact.encode("utf-8"))
        if byte_count < MIN_REVIEW_ARTIFACT_BYTES:
            failures.append(
                f"{stem}: reviewer artifact too thin ({byte_count} bytes; minimum {MIN_REVIEW_ARTIFACT_BYTES}); status message: {status_message or 'n/a'}"
            )
        if not VERDICT_RE.search(artifact):
            failures.append(
                f"{stem}: reviewer artifact must start with ## Verdict followed by PASS or FINDINGS"
            )
        for heading in REQUIRED_REVIEW_HEADINGS:
            if not has_heading(artifact, heading):
                failures.append(
                    f"{stem}: reviewer artifact missing required heading {heading!r}"
                )
        if not has_findings_surface(artifact):
            failures.append(
                f"{stem}: reviewer artifact must include No Findings or structured finding sections"
            )
        if expected_head and expected_head not in artifact:
            failures.append(
                f"{stem}: reviewer artifact must cite current head SHA {expected_head}"
            )
        if status_claims_blockers(status_message) and byte_count < MIN_REVIEW_ARTIFACT_BYTES:
            failures.append(
                f"{stem}: status-message-only P1/P2 claims are non-authoritative without a contract-valid artifact"
            )
        if cli_json_path.exists() and not status_path.exists():
            failures.append(
                f"{stem}: cmux CLI JSON exists but status artifact is missing"
            )
        if len(failures) == lane_failure_count:
            valid_lane_count += 1

    if valid_lane_count == 0:
        failures.append(
            "at least one phase1 reviewer artifact must satisfy the closeout contract"
        )

    return failures


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

    failures.extend(validate_review_artifacts(artifact_dir))

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
