## Council Review Cycle Report

### Development

- Implementation: [brief description]
- Tests before council: [commands/results]
- Review target: [PR-backed draft / PR-backed non-draft deviation / committed branch diff / DEGRADED dirty working tree / DEGRADED gh-unavailable / DEGRADED pr-diff-provenance]
- PR state: [url and draft=true/false, or "none detected"]
- PR/diff provenance: [`$COUNCIL_DIR/pr-diff-provenance.txt`, `$COUNCIL_DIR/pr-head-sha.txt`, `$COUNCIL_DIR/local-head-sha.txt`, `$COUNCIL_DIR/pr-base-ref.txt`, `$COUNCIL_DIR/resolved-base-ref.txt`, `$COUNCIL_DIR/pr-base-equivalence.txt`, `$COUNCIL_DIR/pr-base-sha.txt`, `$COUNCIL_DIR/resolved-base-sha.txt`]
- Clean PASS assertion: [`$COUNCIL_DIR/clean-pass-helper-path.txt`, `$COUNCIL_DIR/clean-pass-helper-sha256.txt`, `$COUNCIL_DIR/clean-pass-assertion.txt`, `$COUNCIL_DIR/clean-pass-assertion-exit-code.txt`; helper exit 0 is required before the run can be called a compliant PR-backed clean PASS]
- Git status: staged [summary or none]; unstaged [summary or none]; untracked [none or explicitly excluded before rerun]
- Diff: [`$COUNCIL_DIR/diff.patch`, non-empty verified against BASE_BRANCH]

### Council Round

- Phase 1 findings: Opus [N], Pi [N]
- Kimi K2.7 shadow diagnostics: [complete/disabled/failed/skipped], mergeAuthoritative:false, [N] diagnostics
- Phase 2 cross-exam: Codex [N] challenged, Opus [N] challenged
- Phase 3 triage: [N] P1, [N] P2, [N] Track, [N] dismissed
- Council value-add: [what cross-exam caught that direct triage would have missed]

### Fixes

- P1 fixed: [N]
- P2 fixed: [N]
- Tests after fixes: [commands/results]

### Convergence

- Round 2+: [summary, or "not needed"]
- Final state: [clean / only P3 remains / blocked]

### Notable Model Behavior

- Opus: [useful catches or recurring false positives]
- Pi: [useful catches or recurring false positives]
- Kimi K2.7 shadow: [diagnostic-only signal, disabled marker, or recurring false positives]
- Codex: [cross-exam/triage notes]
