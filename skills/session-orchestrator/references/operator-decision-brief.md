# Symphony Operator Decision Brief

Use this template when a session-orchestrated ticket hits a non-autonomous boundary:
review round cap, budget cap, repeated same-family reopen, degraded review
substrate, missing live proof, unclear split/merge decision, or conflicting
ownership. Also use it when the context firewall cannot safely build a bounded
packet, when a tripwire requires judgment, or when raw evidence must be
inspected beyond the packet/closeout contract. This is the pause point for
operator judgment instead of another automatic round.

```markdown
# Operator Decision Brief - [issue identifier / PR #123]

## Recommendation
[Continue scoped | split | park | merge Track-only | abandon/rework] because [one concise reason].

## Current Truth
- Issue: [issue identifier, title, and URL]
- PR: [URL or none]
- Branch/head: [branch] @ [head sha]
- Base: [base ref] @ [base sha]
- Linear state: [state]
- CI/local validation: [commands and results]
- Live proof: [evidence or exact blocker]
- Context packet: [path/URL @ hash, or why unavailable]
- Closeout packet: [path/URL @ hash, if any]

## Why This Needs A Decision
[Name the cap, repeated finding family, degraded lane, missing credential, or product choice.]

## Context Firewall State
- Packet freshness: [issue updatedAt, comment cutoff, base SHA, head SHA]
- Tripwire: [none | threshold name and observed tier]
- Raw evidence inspected: [no | yes, reason, path/URL, hash/excerpt]
- Continuation safety: [safe same-worktree rotation | unsafe/stale/ownership conflict | needs operator judgment]

## Work Completed
- [change/fix]
- [tests/proof]
- [Track issues filed or updated]

## Remaining Findings
| Severity | Family | Evidence | Current reachability | Proposed action |
| --- | --- | --- | --- | --- |
| P1/P2/Track | [family] | [file:line or artifact] | [reachable/stale/theoretical] | [fix/split/file/dismiss] |

## Options
| Option | What happens | Cost | Risk |
| --- | --- | --- | --- |
| Continue scoped | [exact next review/implementation prompt] | [time/tokens] | [risk] |
| Split | [new/existing issue IDs] | [cost] | [risk] |
| Park | [state and unblock condition] | [cost] | [risk] |
| Merge Track-only | [why P1/P2 are gone] | [cost] | [risk] |

## Next Prompt If Continuing
```text
[copy-ready worker or review prompt scoped to the named invariant/fix delta]
```

## Durable Links
- Council/review artifacts: [path or URL]
- Linear comments/docs: [URL]
- Report/handoff: [URL/path]
```

Decision brief rules:

- Refresh live Linear and GitHub immediately before writing the brief.
- Do not ask for a decision from stale PR or worker state.
- Include the orchestrator's recommendation. Do not hand the operator an undigested
  list of findings.
- If the brief names durable follow-up, create or update the Linear issue
  before publishing the brief and include the issue ID.
- If the decision is "continue scoped," include the exact next prompt and why
  it is scoped rather than broad.
