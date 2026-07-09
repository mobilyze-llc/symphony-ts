# Architecture guardrails

Symphony measures mechanical code-sprawl deltas in CI. These checks are not
process approvals and do not revive the discarded SYMPH-948 gates. They freeze
new growth while leaving SYMPH-947 decomposition deferred.

## Report-only window

The measurement window opened on 2026-07-09. The `architecture-report` CI job
uses `continue-on-error: true` through the first review on 2026-07-23.
Enforcement is proposed gate by gate only after reviewing the actual Symphony
PR stream; the date alone does not trigger a flip.

- God-file pins: propose blocking when every observed finding represents real
  growth in one of the three pinned files and the full-set main audit has no
  merge-race or stale-pin false positives.
- File-size ratchet: validate the 350-line new-file cap and 600-line no-growth
  threshold against every PR in the window. Propose blocking only with no
  legitimate module rejected without an appropriate expiring waiver.
- Environment registry: propose blocking when new name/read-site pairs are
  stable under ordinary file moves and every finding represents an
  unregistered dependency.
- Dead exports: propose blocking when Knip entrypoint coverage has produced no
  false-positive additions across the window.
- CLI docs sync: `pnpm docs:check` is deterministic and may become blocking
  with the other report-only checks after the 2026-07-23 review.
- Unused imports and variables: one Biome auto-fix pass completed on
  2026-07-09; these rules extend the existing blocking lint job immediately.

Record the observed pass/fail counts and the enforcement decision on
SYMPH-1073. Threshold changes require observed evidence; do not tune them to
make a single PR pass.

## Commands

Run the guard implementation tests and all measurements from the repository
root:

```sh
pnpm architecture:test
pnpm architecture:check
pnpm build && pnpm docs:check
```

The file-size and god-file scripts accept `--base <git-ref>`. CI supplies the
PR, merge-group, or pre-push base SHA.

## God-file pins

Pins live in `config/architecture/god-files.json`. PR checks are diff-scoped;
pushes to `main` also run the full-set audit. The update command is deliberately
downward-only:

```sh
node scripts/architecture/check-god-files.mjs --update-pins
```

If a refactor shrinks a pinned file, run the command and commit the lower pin.
Never raise a pin to accommodate new growth. A stale-low repair is allowed only
when `origin/main` already exceeds the committed value, with
`git show origin/main:<path> | wc -l` evidence recorded in the PR.

Temporary exceptions use the committed waiver shape `{path, rule, reason,
expires}`. Expired waivers stop applying automatically and remain visible in
review history.

## Environment registry

`config/architecture/env-registry.json` records current static environment
names and every production read site under `src/`, `scripts/`, and `ops/`.
Existing reads are baselined; only a new name/read-site pair reports a failure.
After intentionally adding or moving a read, regenerate and review the exact
config diff:

```sh
node scripts/architecture/check-env-registry.mjs --update-baseline
pnpm exec biome format --write config/architecture/env-registry.json
```

## Dead-export baseline

`config/architecture/dead-exports-baseline.json` records Knip's existing dead
exports and exported types without unstable line/column positions. The guard
reports only new keys. To accept an intentional addition, regenerate and review
the exact baseline diff:

```sh
node scripts/architecture/check-dead-exports.mjs --update-baseline
pnpm exec biome format --write config/architecture/dead-exports-baseline.json
```

## Active-state coverage decision

The audit's candidate startup assertion is already implemented by
`src/config/config-contracts.ts`: dispatch validation requires every staged
`linear_state` write and the `Resume` readmission state to appear in
`tracker.active_states`, and rejects an escalation state that would silently
respawn. `tests/config/config-contracts.test.ts` covers the failure paths. No
duplicate report-only gate is added; the existing startup contract remains the
blocking owner of this invariant.
