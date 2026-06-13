# Review Calibration Corpus

The canonical retrospective replay corpus intentionally requires at least
`RETROSPECTIVE_REPLAY_MIN_CASES` cases. That constant is currently 10, so the
validator rejects corpora with 9 or fewer replay cases instead of preserving the
older loose "roughly 10" compatibility window.

SYMPH-506 confirmed the compatibility surface after PR #426: parseable
retrospective replay corpus copies in the stable checkout, Codex worktrees, and
local postmerge artifacts all had 10 cases. No persisted 8- or 9-case corpus was
found, so no migration is required.

If an operator loads an external 8- or 9-case corpus, the expected failure is:

```text
$.retrospectiveReplay.cases: must include at least 10 replay cases
```

Remediate by adding source-backed replay cases until the corpus reaches
`RETROSPECTIVE_REPLAY_MIN_CASES`; do not pad with invented cases or
runtime/model-call data.
