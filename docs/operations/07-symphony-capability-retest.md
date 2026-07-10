# symphony-capability-retest

> **Status:** CANONICAL · **Template:** operations-doc v1.0 (`docs/operations/_TEMPLATE.md`) · **Owner:** Symphony
> **Source of truth:** `src/cli/capability-retest.ts`, `src/audit/altitude-reliability.ts`
> The **Usage** block is auto-synced by `scripts/docs-sync.mjs`; `pnpm test` fails if it drifts.

## Purpose

Run the fixed SYMPH-968 altitude-reliability corpus against one planner model alias. The command uses the planner's production crabrunner path, prints the scored result, and appends it to both `.symphony/capability-ledger/altitude-reliability.jsonl` and `.symphony/run-journals/dispatcher.jsonl`. The dedicated, non-compacting capability ledger is the only gate-authoritative evidence. The dispatcher journal row is an operational measurement observation with `gate_authority: false`; it cannot arm the Phase-A gate. The command does not mutate Linear or dispatch work.

## Installed location

| | |
|---|---|
| **On PATH** | `symphony-capability-retest` |
| **Package bin** | `dist/src/cli/capability-retest.js` |
| **Source** | `src/cli/capability-retest.ts` |

## Usage

<!-- AUTOGEN:help START — managed by scripts/docs-sync.mjs; edit src/cli/capability-retest.ts renderUsage() -->
```text
Usage: symphony-capability-retest --model <alias> [options]

Run the fixed altitude-reliability corpus through the planner's crabrunner
model path, append the authoritative score to the non-compacting capability
ledger and a non-authoritative observation to the dispatcher run journal,
then print the full result as JSON.

Required:
  --model <alias>       Planner model alias to score (for example, opus)

Options:
  --workspace <path>    Source workspace and durable-ledger root (default current directory)
  --out-dir <path>      Crabrunner prompt/artifact directory (default system temp)
  --help                Show this help text

Exit codes:
  0  Capability bar passed
  1  Usage error
  2  Capability bar failed (the scored ledger entries are still written)
  3  Runner, verdict parsing, journal, or capability-ledger write unavailable
```
<!-- AUTOGEN:help END -->

## Flags / inputs

`--model` is required and is passed unchanged to crabrunner. `--workspace` selects the source repository used to create an answer-key-free evaluation snapshot and the durable ledger root. The snapshot contains production source/configuration but excludes tests, docs, plans, the scoring implementation, runtime state, and original git history; it is removed after the run. `--out-dir` retains the five per-case prompts and crabrunner artifacts at a chosen location.

## Examples

```bash
# Score the current production planner alias and retain model artifacts
symphony-capability-retest --model opus --workspace /path/to/symphony-ts --out-dir /tmp/altitude-retest-opus
```

## Edge cases & gotchas

- A failed capability bar is a completed measurement: the command writes the ledger row, prints the score, and exits `2`.
- Runner, response-parsing, journal-write, and capability-ledger-write failures exit `3` and do not claim a gate-authoritative scored run.
- The command writes the non-authoritative dispatcher observation first. If the capability-ledger append then fails, the surviving journal row remains explicitly non-authoritative and the Phase-A gate stays unarmed.
- Gate-authoritative capability evidence exists only in `.symphony/capability-ledger/altitude-reliability.jsonl` and survives dispatcher journal checkpoint compaction.
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

## Future direction

- [SYMPH-1106](https://linear.app/mobilyze/issue/SYMPH-1106) extends this invocation surface with the clustering benchmark.

## Maintenance

Edit CLI behavior and `renderUsage()` in `src/cli/capability-retest.ts`, then run `pnpm build && pnpm docs:sync`. The Vitest operations-doc drift gate enforces the generated block. Keep this document aligned with operations-doc template v1.0.
