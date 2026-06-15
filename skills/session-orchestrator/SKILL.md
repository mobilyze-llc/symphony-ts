---
name: session-orchestrator
description: Run temporary Codex-led orchestration sessions for Symphony bootstrap work. Use when planning or executing Symphony tickets outside the autonomous scheduler, especially queue-clearing waves, high-risk invariant tickets, review-loop discipline, worker delegation, Linear claim hygiene, cap-hit synthesis, or backlog normalization while Symphony reliability and review-substrate trust are still being restored.
---

# Session Orchestrator

Use this skill when a Codex root session is acting as the temporary Symphony
operator/orchestrator instead of letting Symphony autonomously consume the
backlog. The orchestrator owns inspection, classification, assignment, monitoring, synthesis,
review decisions, Linear/GitHub closeout, and durable reporting. Implementation
work belongs in bounded worker threads or in the current thread only when the
scope is intentionally small.

## Source And Install Model

The canonical skill source lives in `skills/session-orchestrator` in the stable
`symphony-ts` checkout. Cross-repo discovery should use the user-level symlink
`~/.agents/skills/session-orchestrator` pointing at that stable source
directory. Repo-local discovery uses `.agents/skills/session-orchestrator` as a
symlink to the same canonical repo directory. Do not install a copied global
skill under `~/.codex/skills/session-orchestrator`; copy-style installs drift.

## Source Threads

Ground decisions in current truth, not in memory:

- Live Linear issue, comments, project membership, and state via
  `linear-pp-cli ... --agent --data-source live`.
- Current GitHub PR, branch, merge queue, and CI state via `gh`.
- Current repo docs and handoffs, especially `handoffs/` in the stable
  `symphony-ts` checkout.
- `SPEC.mobilyze.md` for fork-specific behavior and `SPEC.upstream.md` for
  upstream compatibility.
- The repo-local `spec-review-lane` skill before implementation of each newly
  picked ticket in this interactive Codex-led session. This is distinct from
  autonomous Symphony worker ticket review, which uses Symphony's out-of-band
  review process.
- Live Linear discovery instead of hardcoded ticket memory. Search for active
  issues and docs by current labels, keywords, project membership, and recent
  comments before creating or prioritizing process work.

## Skill Contents

Read these references only when needed:

| File | Contents | When to read |
| --- | --- | --- |
| `references/worker-prompts.md` | Copy-ready prompts for implementation workers and read-only review/triage workers. | Before delegating, refreshing, or forward-testing worker instructions. |
| `references/operator-decision-brief.md` | Cap-hit and operator decision brief template. | When a ticket reaches review cap, budget cap, substrate degradation, unclear split/merge choice, or a non-autonomous decision boundary. |

## Session Start Checklist

1. Read the latest stable-root handoffs:
   `MAIN_ROOT=$(git worktree list --porcelain | awk 'NR==1 && $1=="worktree" {print $2}')`
   then inspect `$MAIN_ROOT/handoffs/`.
2. Fetch current main and verify baseline:
   `git fetch origin main --prune`, `git rev-parse origin/main`,
   `git status --short --branch`, and the relevant `gh pr view` or
   `gh run list` commands.
3. Read the live Linear issues before touching state. For each candidate:
   `linear-pp-cli issues <ISSUE-ID> --agent --data-source live --select identifier,title,description,state.name,url,project.name,parent.identifier,labels.name`.
4. Classify each candidate with the risk taxonomy below before assigning work.
5. For every newly picked ticket that will be implemented in this session, run
   the repo-local `$spec-review-lane` skill in `observe` mode before
   implementation. Use the direct-ticket path with `--force` so the ticket does
   not need autonomous Symphony pickup first. Record the readiness/verdict,
   artifact path, and next action in `update_plan` or the checkpoint before
   coding. If the lane reports `needs_operator_context`, `privacy_blocked`,
   `failed`, `runner_failed`, or `invalid_artifact`, resolve or route that state
   before starting implementation unless the operator explicitly scopes the run
   to implementation-only.
6. Call `update_plan` with the active issue or activity and a complete
   go-forward list of tickets/tasks in the current queue. Keep this operator
   plan current as work is claimed, delegated, reviewed, merged, closed,
   blocked, split, or expanded.
7. Claim only the tickets you will actively run. Use visible Linear state and
   a short comment that names the orchestrator, branch or worker, scope, and stop
   condition. Do not add orchestrator-run tickets to the `Pipeline` project unless
   the intent is automated Symphony pickup.
8. Decide whether to work in the orchestrator thread or delegate. Keep the
   orchestrator lightweight by default. Before launching any non-trivial
   implementation worker, create a bounded worker packet using the context
   firewall below; small work may stay in the orchestrator thread only when the
   scope and evidence fit without raw transcript ingestion.
9. Write or update a compact persistent checkpoint after material decisions:
   current head, active tickets, active workers, PRs, review state, blocked
   decisions, context-firewall state, and next poll time. Prefer Linear Docs for
   durable session docs; use `handoffs/` at the stable root only for local
   fallback handoffs.

## Spec Review Intake

Before implementing a newly picked ticket, invoke `$spec-review-lane` unless the
operator explicitly says to skip spec review for that ticket. The default shape
is:

```bash
skills/spec-review-lane/scripts/run-spec-review-lane.mjs \
  --workflow WORKFLOW.md \
  --workspace <repo-root> \
  --issue <ISSUE-ID> \
  --mode observe \
  --force
```

The target `--workspace` is always the implementation workspace whose source
should be reviewed. If that workspace is source-only, let the wrapper resolve a
built watcher from `--watcher-runtime-root` /
`SYMPHONY_SPEC_REVIEW_RUNTIME_ROOT`, linked-main discovery, or PATH. Do not
install dependencies in a throwaway implementation worktree merely to launch
spec review, and do not point `--workspace` at the stable checkout unless the
stable checkout is the source being implemented.

Use `--dry-run` first when checking selection only. Treat prompt-only Claude
runner fallback artifacts as manual reconciliation evidence, not durable
spec-review readiness, unless the spec-review watcher wrote the Linear marker
and dispatcher journal row.

## Operator Plan Discipline

Use `update_plan` as the live work ledger for the operator. It should show:

- The ticket number or activity currently being worked.
- Any active worker thread or subagent and its scope.
- The go-forward queue of tickets and tasks, in intended execution order.
- New tickets or Track work added during the run.
- Closed, merged, parked, blocked, or delegated items as their status changes.

Update the plan at every material transition: after live issue discovery,
ticket claiming, delegation, review result, third-failure reset, PR open,
merge, Linear closeout, new follow-up filing, or scope split. The plan is not a
ceremonial TODO list; it is how the orchestrator keeps the operator aware of how
work is structured and how much remains.

## Context Firewall

The root orchestrator is a dispatcher and decision surface, not a long-lived
worker transcript. It may keep queue state, priorities, dependencies, active
worker state, PR/review status, and operator decisions. It must not routinely
ingest full worker transcripts, raw long logs, full council artifacts, or broad
source-search output as closeout evidence.

The dispatcher may inspect raw evidence only for named exceptions:

- Validate a blocker, degraded substrate, or degraded review artifact.
- Resolve a security, ownership, or wrong-workspace risk.
- Verify a closeout claim when compact evidence is insufficient.
- Prepare an operator decision brief.

Record every raw-evidence exception in the checkpoint with the reason, path or
URL, and a compact excerpt or hash. Do not paste raw long logs, full private
comments, or full transcripts into Linear, the checkpoint, or worker prompts.

### Default Packet Budgets

These defaults are conservative, operator-tunable starting points. They sit well
below the observed June 15 burn-session magnitudes: about `4,433`, `1,247`, and
`1,087` tool calls; about `27`, `8`, and `6` compactions; and p90 request sizes
around `354k` to `449k` tokens. Recalibrate after another measured batch.

| Budget | Default |
| --- | --- |
| Issue body inline limit | Include verbatim when `<= 4,000` characters; otherwise summarize to `<= 1,500` characters and keep source refs. |
| Per-comment excerpt cap | `<= 500` characters per selected comment unless the full body is material and still fits the total packet. |
| Total worker packet budget | Target `<= 12,000` characters, hard pause at `> 16,000` characters unless the operator authorizes a larger packet. |
| Comment cutoff | Use the previous packet cutoff when continuing; otherwise use issue `updatedAt`, last state transition, and all comments newer than the last packet or claim comment. |
| Raw artifact excerpt cap | `<= 1,000` characters per artifact, with local path or URL plus hash when useful. |

### Worker Packet Contract

Before delegation, emit a bounded packet containing:

- Issue identifier, title, URL, current Linear state, project membership, and
  `updatedAt`.
- Linear comment freshness metadata: selected comment IDs, actor names or
  emails when available, timestamps, hashes, and the cutoff used.
- Canonical issue body, or a bounded issue-body summary when the body exceeds
  the packet budget.
- Selected comment summaries with short excerpts. Include full comment bodies
  only when material and still under budget.
- Operator/course-changing comment preservation status.
- Source refs, files, or symbols known so far, with hashes when cheap.
- Spec-review readiness, verdict, artifact path, and hash when present.
- GitHub/repo freshness metadata: branch/worktree, base ref and SHA, head SHA
  when known, and whether the worker must refresh before editing.
- Scope, non-goals, expected files/modules, risk class, validation plan,
  live-proof requirement, stop conditions, and no-subdelegation rule.
- Raw-artifact policy: link raw logs or artifacts, include selected excerpts
  only, and explain when the worker may inspect raw evidence.
- Sufficiency check: what the worker should do if the packet is incomplete,
  stale, contradictory, missing material evidence, or too large.

The packet is a bounded starting contract, not a substitute for live truth.
Workers still verify current branch/base/head and inspect the code, tests, docs,
and artifacts needed for correctness.

### Comment Preservation

Separate deterministic preservation from semantic judgment:

- Deterministically preserve comments whose actor identity is the operator by
  stable actor ID or email, not display name alone. Agent comments may post from
  a service account, so `authorClass: unknown` is not safely droppable.
- Preserve comments newer than the prior packet cutoff or newer than the last
  state transition.
- Preserve comments matching scope, acceptance-criteria, review, blocker,
  operator-decision, merge, or validation keywords.
- The orchestrator must semantically check whether any remaining comment changes
  course, scope, acceptance criteria, ownership, or stop conditions.

If the packet budget would force dropping any comment that is not safely
droppable, fail into `needs_operator_context` or an operator decision brief. Do
not silently summarize away course-changing material to satisfy a size cap.

### Worker Closeout Contract

Workers return a compact closeout packet only:

- Branch, PR URL, head SHA, and base SHA.
- Files changed and concise behavior summary.
- Validation commands and results.
- Review artifacts and verdicts by path, URL, and hash when available.
- Linear comments or Track issues created or updated.
- Remaining blockers and exact next action.
- Token/session notes when observable: approximate requests, tool calls,
  compactions, and whether any threshold was crossed.
- Raw-evidence exceptions used by the worker: why, where the raw artifact lives,
  and the excerpt or hash.

The root orchestrator stores or summarizes this closeout. It must not paste or
absorb full worker transcripts.

### Rotation And Tripwires

Tripwires are mandatory pause-and-decide boundaries, not proof of failure. For
continueable work, the normal action is a fresh worker in the same branch or
worktree, using a new packet plus the previous closeout. Unsafe state, stale
base, conflicting ownership, degraded substrate, or product judgment boundaries
route to the existing operator decision brief.

| Tripwire | Default | Observability |
| --- | --- | --- |
| Worker tool calls | `>= 100` in one worker context | Worker-self-attested at closeout; exact counts may be post-hoc only. |
| Ticket/session tokens | `>= 50M` attributed tokens | Heuristic or post-hoc only until token telemetry is live. |
| Compactions | `> 2` in one worker context | Orchestrator-observable when the active thread reports them; otherwise worker-self-attested. |
| p90 request size | `> 250k` tokens | Heuristic or post-hoc only until token telemetry is live. |
| Adjacent ticket bleed | More than two adjacent tickets repeatedly appear in one context | Orchestrator-observable from prompts, closeouts, and visible transcript shape. |
| Broad raw output | Logs, searches, tests, or artifacts enter context without compression | Orchestrator-observable in the current transcript or closeout. |
| Review/process repeat | Budget cap, third same-family reopen, or third failed review turn | Orchestrator-observable from review and plan state. |

### Fresh-Worker Continuation

When a worker hits a tripwire and the ticket remains safely continueable:

1. The current worker writes a compact closeout packet and stops.
2. The root orchestrator records closeout path/hash, tripwire reason, and raw
   evidence exceptions in the checkpoint.
3. The root orchestrator refreshes live Linear issue/comment metadata, GitHub
   PR/branch state, current worktree path, base SHA, and head SHA.
4. The root orchestrator launches a fresh worker in the same worktree/branch
   with a continuation packet containing the original packet, previous closeout
   path/hash, refreshed truth, exact continuation scope, and stop condition.
5. The new worker continues from the verified branch/worktree state without
   inheriting the previous worker transcript.

If multiple rotations happen for one issue, the checkpoint must show the
rotation chain and why each continuation remained scoped and safe.

## Risk Taxonomy

Classify every ticket before execution:

| Class | Use for | Entry requirement | Review shape |
| --- | --- | --- | --- |
| `normal` | Localized code, tests, docs, small CLI or parser work. | Clear issue, bounded files, normal validation path. | One broad review, then scoped convergence or Track filing. |
| `high-risk invariant` | Journal/replay, dispatcher admission, review gates, emergency stop, auth, anchors, comparator behavior, budget or topology boundaries. | State contract table before code. | First pass broad; later passes falsify the named invariant and fix delta. |
| `substrate-degraded` | Reviewer artifacts missing, malformed, stale, mutating, or untrusted; cmux/codex/pi/claude substrate failure. | Identify whether the product diff is blocked or review evidence is degraded. | Do not burn implementation cycles chasing bad evidence; park or route substrate work to the current active issue for that substrate family. |
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

- The root orchestrator is the only control plane. It may create, assign, steer,
  rename, archive, or stop workers. Workers must not spawn or steer workers.
- Do not wait for the operator to suggest subagents or threads. Use them at the
  orchestrator's discretion when they reduce cycle time, isolate risk, provide
  independent review, or let low-risk work proceed in parallel without
  ownership conflict.
- Prefer one bounded implementation worker per issue or tightly related cluster.
  Parallelize only when file ownership, Linear scope, and validation gates are
  separable.
- Put the no-subdelegation rule in every worker prompt.
- Assign one bounded issue or cluster per worker. Include source of truth,
  worker packet path/hash, authorization boundary, current-head proof, review
  plan, live-proof expectation, stop conditions, and closeout expectations.
- Before steering an existing worker, read its latest state. Intervene only for
  explicit blockers, completed work needing the next assignment, repeated
  no-progress failure, wrong repository or issue, unauthorized mutation,
  security risk, or gross task drift.
- Do not raise the bar mid-flight. If the initial prompt omitted a proof gate,
  add the smallest correction needed and explain why it is a blocker.

## Review Loop Discipline

Use the repo's PR-backed pattern for non-trivial changes:

1. Implement on a branch containing the Linear issue ID.
2. Push and open a draft PR with `Linear: <ISSUE-ID>` in the body.
3. Run council-style review on the current PR head.
4. Fix verifiable P1/P2s in the PR.
5. File or update Track findings in Linear before naming them in prose.
6. Rerun scoped convergence until no verifiable P1/P2 remains and any P3 is
   either genuinely useful for merge or filed/dismissed.
7. Mark ready, merge through the repo's normal method, verify `origin/main`,
   close Linear, and publish the completion report.

Important guard: before treating headless Claude/Codex reviewer lanes against
mutable PR worktrees as trusted review evidence, live-discover the current
reviewer-immutability or review-substrate issue, design record, or merged PR.
If no current Done/merged evidence exists, use Pi plus in-session Codex review
when review is needed, record the lane degradation explicitly, and avoid
counting thin, empty, stale, or malformed artifacts as passes.

Round policy:

- Round 1 is broad.
- Convergence rounds review the fix delta plus the semantic neighborhood of
  the named invariant family.
- Do not reopen unrelated P3 or Track findings unless they create a current
  P1/P2.
- Every review checkpoint must separate current round, reviewed head, surviving
  product P1/P2 blockers, Track-only items, and substrate/provenance degraded
  status. Do not collapse those into one "review failed" bucket.
- After the round cap, another review round needs an explicit reason category:
  current product P1/P2, targeted same-family invariant check, or
  review-substrate/provenance repair.
- If reviewer lanes pass and the aggregate gate fails only because author
  provenance or non-author-family decorrelation evidence is missing, stop at a
  review procedure decision. Add the missing invocation metadata, such as
  `--author-family` for a Codex-led implementation, or route substrate repair;
  do not launch another product-code review loop.
- On the third failed review, third same-family reopen, or third review turn
  that leaves the ticket unmergeable, do not simply stop. Step back and diagnose
  why the ticket failed again: wrong invariant, underspecified acceptance
  criteria, stale base, weak proof, substrate degradation, overbroad scope,
  conflicting reviewers, or implementation drift.
- After the third failure diagnosis, use judgment to pick the next move:
  narrow the invariant, rewrite the fix, split the ticket, delegate a fresh
  worker or reviewer, rerun a scoped council, update Linear with a Track item,
  or write an operator decision brief if the next step needs authorization.
  Ask the operator only for decisions outside the current authorization or when
  the safe path genuinely depends on product judgment.
- If a budget cap or unsafe substrate blocks useful progress, park or brief the
  issue with evidence. Otherwise continue with the chosen recovery path and
  update `update_plan` so the operator can see the reset and remaining queue.

## Tracking Durable Work

Use the `linear-workflow` and `pp-linear` command family:

- Search before create with `linear-pp-cli similar ... --team SYMPH --agent`
  or live issue reads.
- For process and review-substrate work, search active Linear issues and docs
  by labels and keywords such as `area:review-tooling`, `kind:test`,
  `substrate_stall`, `reviewer immutability`, `cap-hit`, `operator decision`,
  `backlog normalization`, and `merge queue`.
- Treat ticket IDs in handoffs, comments, or older checkpoints as dated
  pointers. Verify live state and recency before using them as priority or
  dependency signals.
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
# Session Orchestrator Checkpoint - YYYY-MM-DD HH:mm ET

## Current Truth
- `origin/main`: <sha>
- GitHub/CI: <state and command>
- Linear scope: <issues and state>

## Active Work
| Issue | Worker/branch | PR | State | Packet | Closeout | Stop condition |
| --- | --- | --- | --- | --- | --- | --- |

## Review Evidence
| PR | Reviewed head | Lanes | Verdict | Council dir/report |
| --- | --- | --- | --- | --- |

## Context Firewall
- Packet freshness: issue updatedAt/comment cutoff/base SHA/head SHA
- Tripwire status: <none | threshold | rotation | decision brief>
- Raw evidence inspected: <no | yes, reason, path/URL, hash/excerpt>
- Rotation chain: <worker -> closeout -> fresh worker, if any>

## Decisions Needed
| Issue/PR | Question | Recommendation | Options |
| --- | --- | --- | --- |

## Next Poll
- <time or condition>
```

Do not put secrets, private bodies, tokens, or raw long transcripts in the
checkpoint. Link to the durable artifact instead.
