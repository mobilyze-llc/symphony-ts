# symphony-capability-retest

> **Status:** CANONICAL · **Template:** operations-doc v1.0 (`docs/operations/_TEMPLATE.md`) · **Owner:** Symphony
> **Source of truth:** `src/cli/capability-retest.ts`, `src/audit/altitude-reliability.ts`, `src/audit/clustering-benchmark.ts`
> The **Usage** block is auto-synced by `scripts/docs-sync.mjs`; `pnpm test` fails if it drifts.

## Purpose

Run either the fixed SYMPH-968 altitude-reliability corpus or the SYMPH-1106 clustering golden set against one planner model alias. Both modes use the planner's production crabrunner path, print a scored result, and append to a dedicated non-compacting capability ledger. Altitude mode also records a non-authoritative dispatcher-journal observation. Clustering mode reconstructs committed issue snapshots as of their frozen cutoff, invokes the current production structural-advisory prompt and context assembler, and records pairwise precision/recall, root accuracy, negative-control false-cluster rate, invalid-member count/rate, and repeat spread. The command does not mutate Linear or dispatch work.

## Installed location

| | |
|---|---|
| **On PATH** | `symphony-capability-retest` |
| **Package bin** | `dist/src/cli/capability-retest.js` |
| **Source** | `src/cli/capability-retest.ts` |

## Usage

<!-- AUTOGEN:help START — managed by scripts/docs-sync.mjs; edit src/cli/capability-retest.ts renderUsage() -->
```text
Usage: symphony-capability-retest --model <alias> [--benchmark altitude|clustering] [options]

Run either the fixed altitude-reliability corpus or the frozen clustering
golden set through the planner's crabrunner model path, append the score to
a non-compacting capability ledger, then print the full result as JSON.

Required:
  --model <alias>       Planner model alias to score (for example, opus)

Options:
  --benchmark <name>  altitude (default) or clustering
  --repeats <count>    Clustering repeats; gate-authoritative runs require >=3 (default 3)
  --fixture-dir <path> Frozen clustering fixtures (default tests/fixtures/clustering-golden-set)
  --workspace <path>    Source workspace and durable-ledger root (default current directory)
  --out-dir <path>      Crabrunner prompt/artifact directory (default system temp)
  --help                Show this help text

Exit codes:
  0  Capability bar passed
  1  Usage error
  2  Altitude capability bar failed (the scored ledger entries are still written)
  3  Runner, verdict parsing, journal, or capability-ledger write unavailable
```
<!-- AUTOGEN:help END -->

## Flags / inputs

`--model` is required and is passed unchanged to crabrunner. `--benchmark` selects `altitude` (default) or `clustering`. `--workspace` selects the source repository used to create an answer-key-free evaluation snapshot and the durable ledger root. The snapshot contains production source/configuration but excludes tests, docs, plans, fixture answer keys, runtime state, and original git history; it is removed after the run. `--out-dir` retains prompts and crabrunner artifacts. Clustering mode reads only committed JSON from `--fixture-dir`; gate-authoritative evidence requires at least three repeats.

## Examples

```bash
# Score the current production planner alias and retain model artifacts
symphony-capability-retest --model opus --workspace /path/to/symphony-ts --out-dir /tmp/altitude-retest-opus

# Score the frozen clustering fixtures three times and report metric spread
symphony-capability-retest --model opus --benchmark clustering --repeats 3 --workspace /path/to/symphony-ts --out-dir /tmp/clustering-benchmark-opus
```

## Edge cases & gotchas

- A failed capability bar is a completed measurement: the command writes the ledger row, prints the score, and exits `2`.
- Runner, response-parsing, journal-write, and capability-ledger-write failures exit `3` and do not claim a gate-authoritative scored run.
- The command writes the non-authoritative dispatcher observation first. If the capability-ledger append then fails, the surviving journal row remains explicitly non-authoritative and the Phase-A gate stays unarmed.
- Gate-authoritative capability evidence exists only in `.symphony/capability-ledger/altitude-reliability.jsonl` and survives dispatcher journal checkpoint compaction.
- Gate-authoritative clustering evidence exists only in `.symphony/capability-ledger/clustering-benchmark.jsonl`; the CLI rejects fewer than three repeats.
- Clustering fixtures are versioned evidence. Never regenerate them from live Linear; update provenance, cutoff, source commit, issue snapshots, and re-adjudication together in review.
- The corpus and bar are contract data restored from SYMPH-968. Change them only by superseding that contract.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The model passed the capability bar. |
| `1` | Arguments were invalid. |
| `2` | The model completed the corpus but failed the bar. |
| `3` | The run could not produce and persist a valid score. |

## Deploy

Run `pnpm build && pnpm docs:sync`, deploy the package build through the standard process in `docs/operations/05-deploy.md`, and confirm the package bin is on the operator PATH. No service restart is required for a one-shot invocation.

## Maintenance

Edit CLI behavior and `renderUsage()` in `src/cli/capability-retest.ts`, then run `pnpm build && pnpm docs:sync`. The Vitest operations-doc drift gate enforces the generated block. Keep this document aligned with operations-doc template v1.0.
