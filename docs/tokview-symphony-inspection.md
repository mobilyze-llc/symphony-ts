# Tokview Inspection For Symphony Runs

Use `tokview` after importing Codex and Claude history to attribute recent
Symphony token spend. Keep raw exports outside chat transcripts; paste compact
summaries only.

## Recent Window

```bash
tokview sessions \
  --since "2026-06-15 00:00 America/New_York" \
  --until "2026-06-15 00:55 America/New_York" \
  --json > .symphony/validation/tokview-sessions.json
```

Report these fields per session:

- request count
- average input context per request
- cache-read tokens and cache-read share
- model output tokens and output share
- total estimated cost
- top command families by estimated tool-output bytes

## Map Session IDs To Transcripts

Codex session IDs in tokview map to local JSONL files under the Codex session
history. Use a path-only search first, then inspect bounded snippets.

```bash
rg -l "019ec96a" ~/.codex/sessions ~/.codex/history \
  | sed -n '1,20p'
```

For a matched transcript, count large tool outputs without streaming them:

```bash
jq -r '
  .. | objects
  | select(.type? == "tool_call_output" or .tool_name? or .toolName?)
  | [.tool_name // .toolName // "unknown",
     ((.output // .stdout // .stderr // .text // "") | length)]
  | @tsv
' <transcript.jsonl> \
  | sort -k2,2nr \
  | sed -n '1,25p'
```

If a raw command log is needed, preserve it as an artifact:

```bash
node scripts/symphony-run-logged.mjs \
  --label tokview-recent \
  --tail-bytes 4000 \
  -- tokview sessions --since "24 hours ago" --json
```
