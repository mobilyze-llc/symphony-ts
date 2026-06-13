---
name: symphony-manual-manager
description: Run temporary Codex-led manual manager sessions for Symphony bootstrap work. Use when planning or executing Symphony tickets outside the autonomous scheduler, especially queue-clearing waves, high-risk invariant tickets, review-loop discipline, worker delegation, Linear claim hygiene, cap-hit synthesis, or backlog normalization while Symphony reliability and review-substrate trust are still being restored.
---

# Symphony Manual Manager

Use this skill when a Codex root session is acting as the temporary Symphony
operator/manager instead of letting Symphony autonomously consume the backlog.
The manager owns inspection, classification, assignment, monitoring, synthesis,
review decisions, Linear/GitHub closeout, and durable reporting. Implementation
work belongs in bounded worker threads or in the current thread only when the
scope is intentionally small.

## Source Threads

Ground decisions in current truth, not in memory:

- Live Linear issue, comments, project membership, and state via
  `linear-pp-cli ... --agent --data-source live`.
- Current GitHub PR, branch, merge queue, and CI state via `gh`.
- Current repo docs and handoffs, especially `handoffs/` in the stable
  `symphony-ts` checkout.
- `SPEC.mobilyze.md` for fork-specific behavior and `SPEC.upstream.md` for
  upstream compatibility.
- Existing priority tickets instead of duplicate process lanes:
  `SYMPH-376`, `SYMPH-340`, `SYMPH-371`, `SYMPH-449`, `SYMPH-452`,
  `SYMPH-524`, `SYMPH-526`, `SYMPH-546`, `SYMPH-549`, `SYMPH-553`,
  and `SYMPH-554`.

## Skill Contents

Read these references only when needed:

| File | Contents | When to read |
| --- | --- | --- |
| `references/worker-prompts.md` | Copy-ready prompts for implementation workers and read-only review/triage workers. | Before delegating, refreshing, or forward-testing worker instructions. |
| `references/operator-decision-brief.md` | Cap-hit and operator decision brief template aligned with `SYMPH-376`. | When a ticket reaches review cap, budget cap, substrate degradation, unclear split/merge choice, or a non-autonomous decision boundary. |

## Session Start Checklist

1. Read the latest stable-root handoffs:
   `MAIN_ROOT=$(git worktree list --porcelain | awk 'NR==1 && $1=="worktree" {print $2}')`
   then inspect `$MAIN_ROOT/handoffs/`.
2. Fetch current main and verify baseline:
   `git fetch origin main --prune`, `git rev-parse origin/main`,
   `git status --short --branch`, and the relevant `gh pr view` or
   `gh run list` commands.
3. Read the live Linear issues before touching state. For each candidate:
   `linear-pp-cli issues SYMPH-123 --agent --data-source live --select identifier,title,description,state.name,url,project.name,parent.identifier,labels.name`.
4. Classify each candidate with the risk taxonomy below before assigning work.
5. Claim only the tickets you will actively run. Use visible Linear state and
   a short comment that names the manager, branch or worker, scope, and stop
   condition. Do not add operator-run tickets to the `Pipeline` project unless
   the intent is automated Symphony pickup.
6. Decide whether to work in the manager thread or delegate. Keep the manager
   lightweight by default.
7. Write or update a compact persistent checkpoint after material decisions:
   current head, active tickets, active workers, PRs, review state, blocked
   decisions, and next poll time. Prefer Linear Docs for durable session docs;
   use `handoffs/` at the stable root only for local fallback handoffs.

## Risk Taxonomy

Classify every ticket before execution:

| Class | Use for | Entry requirement | Review shape |
| --- | --- | --- | --- |
| `normal` | Localized code, tests, docs, small CLI or parser work. | Clear issue, bounded files, normal validation path. | One broad review, then scoped convergence or Track filing. |
| `high-risk invariant` | Journal/replay, dispatcher admission, review gates, emergency stop, auth, anchors, comparator behavior, budget or topology boundaries. | State contract table before code. | First pass broad; later passes falsify the named invariant and fix delta. |
| `substrate-degraded` | Reviewer artifacts missing, malformed, stale, mutating, or untrusted; cmux/codex/pi/claude substrate failure. | Identify whether the product diff is blocked or review evidence is degraded. | Do not burn implementation cycles chasing bad evidence; park or route substrate work to existing tickets such as `SYMPH-546`. |
| `backlog-normalization` | Clustering, demoting, deduplicating, or reprioritizing Track tickets. | Search and read existing issues first. | Produce fewer execution clusters, not more unowned prose. |
| `operational-debug` | Live runtime, LAN, launchd, CI, merge queue, or local machine incidents. | Current machine truth and exact repro/status commands. | Verify against the live boundary before closeout. |

For `high-risk invariant`, write this state contract before code:

| Contract area | Required answer |
| --- | --- |
| Durable state | What facts survive restart, replay, rebase, or merge-base changes? |
| Side effects | What Linear, GitHub, process, file, or operator-visible effect can happen, and how is it deduped? |
| Ordering | What signal wins when valid signals conflict? |
| Failure mode | What is the fail-safe behavior when the relevant runtime throws, stalls, or returns partial data? |
| Operator proof | What exact output proves complete, blocked, degraded, or unsafe? |
| Replay | What happens when older events are replayed through the new code? |

## Delegation Rules

- The root manager is the only control plane. It may create, assign, steer,
  rename, archive, or stop workers. Workers must not spawn or steer workers.
- Put the no-subdelegation rule in every worker prompt.
- Assign one bounded issue or cluster per worker. Include source of truth,
  authorization boundary, current-head proof, review plan, live-proof
  expectation, stop conditions, and handoff expectations.
- Before steering an existing worker, read its latest state. Intervene only for
  explicit blockers, completed work needing the next assignment, repeated
  no-progress failure, wrong repository or issue, unauthorized mutation,
  security risk, or gross task drift.
- Do not raise the bar mid-flight. If the initial prompt omitted a proof gate,
  add the smallest correction needed and explain why it is a blocker.

## Review Loop Discipline

Use the repo's PR-backed pattern for non-trivial changes:

1. Implement on a branch containing the Linear issue ID.
2. Push and open a draft PR with `Linear: SYMPH-123` in the body.
3. Run council-style review on the current PR head.
4. Fix verifiable P1/P2s in the PR.
5. File or update Track findings in Linear before naming them in prose.
6. Rerun scoped convergence until no verifiable P1/P2 remains and any P3 is
   either genuinely useful for merge or filed/dismissed.
7. Mark ready, merge through the repo's normal method, verify `origin/main`,
   close Linear, and publish the completion report.

Important guard: until `SYMPH-546` is live-verified Done and merged, do not
treat headless Claude/Codex reviewer lanes against mutable PR worktrees as
trusted review evidence. Use Pi plus in-session Codex review when review is
needed, record the lane degradation explicitly, and avoid counting thin,
empty, stale, or malformed artifacts as passes.

Round policy:

- Round 1 is broad.
- Convergence rounds review the fix delta plus the semantic neighborhood of
  the named invariant family.
- Do not reopen unrelated P3 or Track findings unless they create a current
  P1/P2.
- If a round cap, budget cap, or same-family reopen loop is hit, stop and write
  an operator decision brief instead of starting another automatic round.

## Tracking Durable Work

Use the `linear-workflow` and `pp-linear` command family:

- Search before create with `linear-pp-cli similar ... --team SYMPH --agent`
  or live issue reads.
- For new durable work, create or update Linear issues with source refs,
  acceptance criteria, and verification. Use file-backed Markdown bodies.
- Prefer sub-issues under the active issue when the work belongs to the same
  workstream; otherwise file siblings with explicit related or blocked context.
- Apply existing label conventions when labels are available. Do not invent
  labels without checking `linear-pp-cli labels list --team SYMPH --agent`.
- Mention the issue ID in the same message that names the durable follow-up.

Speculative brainstorms are the exception. Say explicitly that the list is
speculative and ask before turning every idea into a ticket.

## Backlog Normalization

When many Track issues exist, normalize before execution:

1. Read live issue descriptions and comments.
2. Cluster by invariant family, files, runtime surface, and dependency order.
3. Keep safety boundaries sharp: auth, topology, reviewer immutability,
   comparator fail-safe, emergency-stop proof, replay/cursor correctness, and
   load control should not be buried under P3 polish.
4. Merge or comment on duplicates instead of creating new work.
5. Convert same-family P3/test/read-model follow-ups into fewer execution
   lanes when possible.
6. Record the normalized order and why it differs from raw creation order.

## Persistent Checkpoint Format

Use this shape for Linear Docs or local handoffs:

```markdown
# Symphony Manual Manager Checkpoint - YYYY-MM-DD HH:mm ET

## Current Truth
- `origin/main`: <sha>
- GitHub/CI: <state and command>
- Linear scope: <issues and state>

## Active Work
| Issue | Worker/branch | PR | State | Stop condition |
| --- | --- | --- | --- | --- |

## Review Evidence
| PR | Reviewed head | Lanes | Verdict | Council dir/report |
| --- | --- | --- | --- | --- |

## Decisions Needed
| Issue/PR | Question | Recommendation | Options |
| --- | --- | --- | --- |

## Next Poll
- <time or condition>
```

Do not put secrets, private bodies, tokens, or raw long transcripts in the
checkpoint. Link to the durable artifact instead.
