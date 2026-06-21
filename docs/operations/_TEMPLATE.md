# <command-or-surface-name>

<!--
OPERATIONS DOC TEMPLATE — version 1.0.
Copy to docs/operations/NN-<topic>.md (numbered, kebab-case) and fill in. Keep it
concise and equally useful for HUMANS and AGENTS: prose + copy-paste commands +
exact paths and exit codes. Keep the heading order; delete sections that don't apply.
If the surface has a generated `--help` (or similar), wrap it in the AUTOGEN markers
below and wire scripts/docs-sync.mjs + a vitest gate so it can't drift from code.
Otherwise delete the Usage AUTOGEN block and paste a short usage example instead.
Delete this comment in the real doc. See docs/operations/02-symphony-manager-plan.md
for a worked example.
-->

> **Status:** CANONICAL | DRAFT | ARCHIVED · **Template:** operations-doc v1.0 (`docs/operations/_TEMPLATE.md`) · **Owner:** <team>
> **Source of truth:** `<path(s) the behavior actually comes from>`
> <If a block is auto-synced, name the generator + gate, e.g. "Usage is auto-synced by `scripts/docs-sync.mjs`; `pnpm test` fails if it drifts.">

## Purpose

<One short paragraph: what it does, what it deliberately does NOT do, and key safety properties (e.g. output-only, idempotent, writes nothing).>

## Installed location

| | |
|---|---|
| **On PATH** | <how it's invoked> |
| **Wrapper / entry** | <wrapper script and what it does> |
| **Source** | <built artifact ← source file> |

## Usage

<!-- AUTOGEN:help START — managed by scripts/docs-sync.mjs; edit <source> renderUsage() -->
```text
(generated — run `pnpm build && pnpm docs:sync`)
```
<!-- AUTOGEN:help END -->

## Flags / inputs

<Grouped. Mark required vs optional and defaults. Note additive vs mutually-exclusive semantics.>

## Examples

```bash
# <intent>
<command>
```

## Edge cases & gotchas

- <Surprising behavior, failure modes, "looks broken but isn't".>

## Exit codes

| Code | Meaning |
|---|---|
| `0` | <ok> |

## Deploy

<Exact steps to make a new build live. Whether a service restart is required. Host-worktree hygiene notes (e.g. keep tracked tree clean for `--ff-only`).>

## Future direction

- <Known, tracked next steps (link Linear issues). Remove items as they ship.>

## Maintenance

<Where to change behavior; how to regenerate AUTOGEN blocks; what enforces freshness. Reference this template + version.>

---
Template changelog:
- v1.0 — initial operations-doc shape: Purpose · Installed location · Usage (AUTOGEN) · Flags/inputs · Examples · Edge cases · Exit codes · Deploy · Future direction · Maintenance.
