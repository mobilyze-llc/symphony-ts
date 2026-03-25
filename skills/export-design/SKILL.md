---
name: export-design
description: Extract Paper design mockups into portable design reference bundles for cross-machine implementation handoff.
argument-hint: <spec-identifier> [artboard-name-or-id]
---

# Export Design — Paper to Design Reference Bundle

You extract a Paper artboard into a portable design reference bundle that implementation agents can consume without Paper MCP access. The bundle is committed to the repo so remote agents pick it up via `git pull`.

## Inputs

1. **spec-identifier** (required): Kebab-case name used as the bundle directory name (e.g., `token-report`, `settings-page`).
2. **artboard** (optional): Paper artboard name or ID. If omitted and only one artboard exists, use it automatically. If multiple exist, list them and ask.
3. **repo-path**: Resolve the same way as spec-gen — explicit path, cwd with project markers, or ask.

**Output directory:** `<repo-path>/pipeline-config/design-refs/<spec-identifier>/`

---

## Step 1: Resolve Inputs & Confirm Paper Connection

1. Parse `spec-identifier` and optional artboard from the skill arguments.
2. Resolve repo-path (explicit → cwd → ask).
3. Call `get_basic_info` — confirms Paper MCP is connected. Note:
   - Available artboard names and IDs
   - Font families loaded in the document
4. Select the artboard:
   - If artboard argument was provided, match by name or ID.
   - If exactly one artboard exists, use it.
   - If multiple and none specified, list them and ask.

---

## Step 2: Map Section Hierarchy

1. Call `get_tree_summary(artboardId, depth=2)` to get the section hierarchy.
2. Each **top-level child** of the artboard = one section. Record for each:
   - Layer name (this becomes the section filename via kebab-case conversion)
   - Dimensions (width × height)
   - Child count
3. Write `structure.md`:

```markdown
# Design Structure: {spec-identifier}

**Artboard**: {artboard-name} ({width}×{height})
**Font families**: {comma-separated from get_basic_info}
**Exported**: {YYYY-MM-DD}

## Sections

| Section | Dimensions | Children |
|---------|-----------|----------|
| {layer-name} | {w}×{h} | {n} |
| ... | ... | ... |
```

**Do NOT include node IDs in structure.md** — they are session-ephemeral and meaningless outside Paper.

---

## Step 3: Export Section JSX

For each top-level section identified in Step 2:

1. Call `get_jsx(sectionNodeId, format="tailwind")`.
2. Save the output to `sections/<kebab-case-layer-name>.jsx`.

**Kebab-case conversion**: lowercase, replace spaces/underscores with hyphens, strip non-alphanumeric characters except hyphens.

Example: layer name `"Executive Summary"` → `sections/executive-summary.jsx`

---

## Step 4: Extract Design Tokens

1. Collect a representative sample of node IDs: all section roots plus 2-3 key text/color nodes per section (e.g., headings, accent-colored elements).
2. Call `get_computed_styles` on these nodes (batch into a single call).
3. Distill into `styles.json`:

```json
{
  "colors": {
    "primary": "#...",
    "secondary": "#...",
    "background": "#...",
    "text": "#...",
    "accent": "#..."
  },
  "typography": {
    "heading": { "fontFamily": "...", "fontSize": "...", "fontWeight": "...", "lineHeight": "..." },
    "subheading": { "fontFamily": "...", "fontSize": "...", "fontWeight": "...", "lineHeight": "..." },
    "body": { "fontFamily": "...", "fontSize": "...", "fontWeight": "...", "lineHeight": "..." },
    "caption": { "fontFamily": "...", "fontSize": "...", "fontWeight": "...", "lineHeight": "..." }
  },
  "spacing": {
    "sectionGap": "...",
    "groupGap": "...",
    "elementGap": "..."
  },
  "borders": {
    "radius": "...",
    "color": "...",
    "width": "..."
  }
}
```

Populate only the keys you observe — omit any category with no clear data.

---

## Step 5: Capture Screenshot via HTTP

Paper MCP's `get_screenshot` tool returns image data inline in the conversation — the agent can see it visually but **cannot extract the raw bytes to write to disk**. Use the Paper MCP HTTP endpoint directly instead:

```bash
# 1. Initialize MCP session
curl -s -D /tmp/paper_headers.txt -X POST "http://localhost:29979/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"export-design","version":"1.0.0"}}}'
SESSION_ID=$(grep -i "mcp-session-id" /tmp/paper_headers.txt | cut -d' ' -f2 | tr -d '\r')

# 2. Send initialized notification
curl -s -X POST "http://localhost:29979/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3. Call get_screenshot, capture SSE response
curl -s -X POST "http://localhost:29979/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_screenshot","arguments":{"nodeId":"ARTBOARD_ID","scale":2,"transparent":false}}}' \
  -o /tmp/paper_screenshot_response.raw

# 4. Extract base64 and decode to PNG
python3 -c "
import json, base64
with open('/tmp/paper_screenshot_response.raw') as f:
    for line in f.read().split('\n'):
        if line.startswith('data: '):
            parsed = json.loads(line[6:])
            img = parsed['result']['content'][0]['data']
            with open('OUTPUT_PATH/screenshot.png', 'wb') as out:
                out.write(base64.b64decode(img))
            break
"
```

Replace `ARTBOARD_ID` with the actual artboard ID from Step 1, and `OUTPUT_PATH` with `<repo-path>/pipeline-config/design-refs/<spec-identifier>`.

**Verify the screenshot is real** (not a placeholder):
```bash
ls -la OUTPUT_PATH/screenshot.png  # Must be > 10KB
```

If the file is under 10KB, the capture failed — re-run the curl sequence.

---

## Step 6: Write Bundle & Verify

Write all files to `<repo-path>/pipeline-config/design-refs/<spec-identifier>/`:

```
pipeline-config/design-refs/{spec-identifier}/
├── screenshot.png
├── structure.md
├── styles.json
└── sections/
    └── <kebab-case-name>.jsx   # One per top-level artboard child
```

### Quality Checklist (verify before declaring done)

- [ ] Every top-level artboard child has a corresponding `.jsx` file in `sections/`
- [ ] `screenshot.png` exists and is > 10KB (smaller means the capture failed)
- [ ] `styles.json` contains at least `colors` and `typography` keys
- [ ] `structure.md` lists all sections with dimensions
- [ ] No node IDs appear in any output file
- [ ] Section filenames are kebab-case derived from Paper layer names

If any check fails, fix the issue before continuing.

---

## Step 7: Commit & Prompt-to-Push Bundle

1. Stage only the bundle directory:
   ```bash
   git add pipeline-config/design-refs/<spec-identifier>/
   ```
2. Commit with the standard message format:
   ```bash
   git commit -m "chore: export design bundle <spec-identifier>"
   ```
3. Ask the user before pushing:
   > "Bundle committed. Push to remote? (The implementation agent needs it in the repo to access it.)"
4. If the user confirms, run:
   ```bash
   git push
   ```
5. If the push fails, show the full error output and suggest manual resolution. For example:
   > "Push failed. You may need to run `git pull --rebase` first, then `git push` again."

**Never auto-push** — the user may want to review the commit or batch multiple exports before pushing.

---

## Gotchas

- **Node IDs are session-ephemeral.** Never include them in output files — they become meaningless once the Paper session ends.
- **Bundle is design intent, not pixel mandate.** Implementation agents should adapt JSX to target codebase conventions (component library, CSS framework, etc.).
- **Commit the bundle.** The transport mechanism is `git push` → `git pull`. The bundle lives in the repo alongside pipeline configs.
- **The bundle MUST be committed before `/spec-gen` runs.** Remote agents access bundles via `git clone`, not the local filesystem. Step 7 commits automatically but prompts before pushing — the user may want to review or batch multiple exports first.
- **One bundle per spec.** Re-running the skill overwrites the previous bundle for that spec-identifier.
- **`get_screenshot` cannot save to disk.** The Paper MCP tool returns image data inline in the conversation layer — the agent sees it visually but cannot extract raw bytes to write a file. Step 5 uses the Paper MCP HTTP endpoint directly via curl to get the base64 data and decode it. If you call `get_screenshot` normally, you'll end up with a tiny placeholder PNG instead of the actual screenshot.

## Related Skills

- `/spec-gen` — Generate structured specs from brain dumps, create parent issue in Draft
- `/spec-freeze` — Freeze a drafted spec into Linear sub-issues for autonomous pipeline execution
