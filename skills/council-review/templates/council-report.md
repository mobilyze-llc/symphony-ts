## Council Review Report

### Review Target

- Mode: [PR-backed draft / PR-backed non-draft deviation / committed branch diff / DEGRADED dirty working tree / DEGRADED gh-unavailable / DEGRADED pr-diff-provenance]
- Review pass: [initial broad pass / convergence pass]
- Review round: [number]
- Current head SHA: [sha]
- Previous reviewed head SHA: [sha or n/a]
- Named invariant / family: [for convergence, or n/a]
- Artifact status: [complete / partial / stale / malformed / degraded]
- Base ref: [BASE_BRANCH]
- PR: [url, draft=true/false, or "none detected"]
- PR/diff provenance: [`$COUNCIL_DIR/pr-diff-provenance.txt`, `$COUNCIL_DIR/pr-head-sha.txt`, `$COUNCIL_DIR/local-head-sha.txt`, `$COUNCIL_DIR/pr-base-ref.txt`, `$COUNCIL_DIR/resolved-base-ref.txt`, `$COUNCIL_DIR/pr-base-equivalence.txt`, `$COUNCIL_DIR/pr-base-sha.txt`, `$COUNCIL_DIR/resolved-base-sha.txt`]
- Clean PASS assertion: [`$COUNCIL_DIR/clean-pass-helper-path.txt`, `$COUNCIL_DIR/clean-pass-helper-sha256.txt`, `$COUNCIL_DIR/clean-pass-assertion.txt`, `$COUNCIL_DIR/clean-pass-assertion-exit-code.txt`; clean PASS requires helper exit 0]
- Diff: [`$COUNCIL_DIR/diff.patch`, non-empty verified]
- Git status: staged [summary or none]; unstaged [summary or none]; untracked [none or explicitly excluded before rerun]

### Reviewer Status

- Opus Phase 1: [complete/failed/skipped] - [brief note]
- Pi Phase 1: [complete/failed/skipped] - [brief note]
- Kimi K2.7 Shadow: [complete/disabled/failed/skipped] - [brief note; mergeAuthoritative:false]
- Codex Phase 2: [complete] - in-session cross-exam
- Opus Phase 2: [complete/failed/skipped] - [brief note]

### Cost

- Opus Phase 1 tokens/cost: [from phase1-opus.usage.json]
- Opus Phase 2 tokens/cost: [from phase2-opus.usage.json]
- Pi Phase 1 tokens/cost: [from phase1-pi.usage.json]
- Kimi K2.7 shadow tokens/cost: [from kimi-k27-shadow.usage.json or disabled marker]

### Phase 1 Summary

- [O]: [N] findings ([severity breakdown])
- [P]: [N] findings ([severity breakdown])

### Kimi K2.7 Shadow Diagnostics (non-merge-authoritative)

- Status: [complete / disabled / failed / skipped]
- Artifact or disabled marker: [`$COUNCIL_DIR/kimi-k27-shadow.md` or `$COUNCIL_DIR/kimi-k27-shadow.disabled.json`]
- `mergeAuthoritative:false`
- Diagnostics: [summary or None]

Kimi diagnostics never contribute to the authoritative P1/P2 tally,
clean-PASS evidence, or merge-blocking verdict unless Opus, Pi, or
Codex Phase 2 independently confirms the same current-head issue.

### Phase 2 Cross-Examination

For each challenged finding:

- **[CONFIRMED 2/2]** file:line - description
- **[SPLIT 1/1]** file:line - description
- **[REFUTED 2/2]** file:line - description
- **[CODEX ONLY]** file:line - description

### Evidence Quality

- P1/P2 evidence must cite current-head file:line, current head SHA, contract violated, reachable failure mode, and missing test/proof gap.
- Stale-base, degraded-lane, malformed, partial, or empty artifact evidence is unavailable evidence unless independently confirmed against current-head code.
- Thin or non-contract reviewer artifacts are unavailable evidence even when status JSON says `complete`; record artifact path, byte count, status message, and validation reason.
- Convergence scope: [`previous_reviewed_head..HEAD` plus semantic neighborhood / broad initial diff]
- Reviewer immutability: [pre/post dirty-tree assertion or unavailable; no reviewer mutations observed / mutation evidence]

### P1 - Must Fix

- [O/P/C] file:line - finding, current-head evidence, contract violated, reachable failure mode, test/proof gap, planned fix

### P2 - Should Fix

- [O/P/C] file:line - finding, current-head evidence, contract violated, reachable failure mode, test/proof gap, planned fix

### Track

<!-- Omit this section if empty. Full details also go in council-track.json. -->

- Linear ABC-123 - file:line - real risk not introduced by this diff; cold-read acceptance criteria, source refs, verification steps, and follow-up reason

### Dismissed

- [O/P] file:line - why the code is correct or out of scope

### Operator Decision Brief

<!-- Include only when a round cap is hit or the same family reopens twice. -->

- Remaining family:
- Fixed evidence:
- Remaining evidence:
- Tests:
- Recommended action: [merge / restructure / park-with-synthesis / ask operator]
- Exact next question:

### Verdict

[PASS/FAIL] - [summary, including whether the run was PR-backed draft, PR-backed non-draft deviation, or DEGRADED. A run may be called a compliant PR-backed clean PASS only when clean-pass-assertion-exit-code.txt is 0. A PR-backed non-draft deviation may pass correctness review, but is not a compliant PR-backed clean PASS unless the PR was intentionally marked ready after all closeout gates passed and that transition is recorded.]

Attribution key: `[O]` = Opus, `[P]` = Pi/DeepSeek, `[C]` = Codex,
`[K-shadow]` = Kimi K2.7 non-merge-authoritative diagnostics.
Combine for multi-reviewer evidence, for example `[O+C]` or `[P+O+C]`.
