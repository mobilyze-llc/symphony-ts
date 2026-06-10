# Mobile Dashboard Gap Analysis — SYMPH-207

## Summary

Compared the SYMPH-207 spec (parent + 7 subtasks) against the live deployment at `pro16.local:8090/mobile-dashboard.html` backed by `pro16.local:4321`. Found **10 functional gaps** — 3 backend bugs, 6 frontend bugs, and 1 UX issue explicitly requested by the user.

---

## Gaps

### 1. Queue tab hits wrong URL (frontend bug)
**File:** `.symphony/reports/mobile-dashboard.html:1348`
**Spec:** AC4 — GitHub Queue tab shows merge queue with CI status and alerts
**Bug:** Frontend fetches `GET /api/v1/queue` but the backend endpoint is `GET /api/v1/github/queue`. The server interprets "queue" as an issue identifier and returns 404. The Queue tab never loads data.
**Fix:** Change the fetch URL from `/api/v1/queue` to `/api/v1/github/queue`.

### 2. Queue tab uses wrong field name for merged PRs (frontend bug)
**File:** `.symphony/reports/mobile-dashboard.html:1377`
**Spec:** AC4 — merged PRs should display
**Bug:** `renderQueue()` reads `data.merged` but the `GitHubQueueResponse` returns `recently_merged`. Even if gap #1 is fixed, merged PRs won't render.
**Fix:** Change `data.merged` to `data.recently_merged`.

### 3. GitHub Queue endpoint fails on repos with issues disabled (backend bug)
**File:** `src/observability/dashboard-server.ts:592-617`
**Bug:** `fetchGitHubQueue()` runs `gh pr list` and `gh issue list` in parallel via `Promise.all`. If the repo has issues disabled (as symphony-ts does), `gh issue list --label pipeline-halt` fails and the entire endpoint returns a 502. The PR data (which succeeds) is lost.
**Fix:** Run the two gh calls independently with individual try/catch. Return PR data even if the issue list call fails. Return an empty `alerts` array on failure instead of crashing the whole endpoint.

### 4. Deploy execute uses wrong URL and wrong method (frontend bug)
**File:** `.symphony/reports/mobile-dashboard.html:1604`
**Spec:** AC5 — Deploy screen streams live output
**Bug:** Frontend creates `new EventSource(${baseUrl}/api/v1/deploy/stream)` but:
  - Wrong path: backend is `POST /api/v1/deploy`, not `/api/v1/deploy/stream`
  - Wrong method: `EventSource` uses GET, but the endpoint requires POST
The deploy button will never successfully stream output.
**Fix:** Replace EventSource with `fetch(POST /api/v1/deploy)` and read the response body as a readable stream, parsing SSE lines manually. Or switch the backend to accept GET for the streaming endpoint.

### 5. Deploy script path resolves to wrong directory (backend bug)
**File:** `src/observability/dashboard-server.ts:644-649`
**Spec:** AC5 — Deploy preview and execute
**Bug:** `resolveDeployScriptPath()` navigates from `dist/src/observability/` up 2 levels to `dist/`, then appends `ops/symphony-deploy`. The correct path should go up 3 levels to the repo root. Error: `spawn .../dist/ops/symphony-deploy ENOENT`.
**Fix:** Change `pathResolve(dirname(thisFile), "..", "..")` to `pathResolve(dirname(thisFile), "..", "..", "..")`.

### 6. Linear URLs are malformed (frontend bug)
**File:** `.symphony/reports/mobile-dashboard.html:966, 1134`
**Spec:** AC2 — Deep links to Linear
**Bug:** Linear URLs are generated as `https://linear.app/issue/SYMPH-123` but the correct format requires the workspace slug: `https://linear.app/mobilyze-llc/issue/SYMPH-123`. Current links produce 404s on Linear.
**Fix:** Change the URL template to include the workspace slug. Either hardcode `mobilyze-llc` or extract it from a config/env var.

### 7. Parent issue link missing from detail view (frontend bug)
**File:** `.symphony/reports/mobile-dashboard.html` (renderDetailFromRunning, renderDetailFromApi)
**Spec:** AC2 — Issue cards show deep links to "Linear/parent spec"
**Bug:** The `IssueDetailResponse` includes a `parent` field (added in SYMPH-211), and the API returns it, but neither `renderDetailFromRunning()` nor `renderDetailFromApi()` renders the parent link. The spec explicitly requires a deep link to the parent spec issue.
**Fix:** Add a "Parent Spec" deep link in the Links section when `parent` data is available.

### 8. Reports screen shows fake date links (frontend bug)
**File:** `.symphony/reports/mobile-dashboard.html:1662-1708`
**Spec:** AC6 — Reports tab lists daily token reports
**Bug:** The Reports screen generates links for the last 7 days by date pattern, but doesn't validate whether reports actually exist. Links point to `${baseUrl}/reports/${date}.html` but there's no `/reports/` route on the dashboard server. Every link 404s.
**Fix:** Either add a `/api/v1/reports` endpoint that lists available report files from `~/.symphony/reports/`, or link to the report server on port 8090 instead (which already serves static files from that directory).

### 9. Stop checklist never shows per-step progress (backend/frontend mismatch)
**File:** `.symphony/reports/mobile-dashboard.html:1285` vs `src/observability/dashboard-server.ts:101-105`
**Spec:** AC3 — Stop action with progress checklist
**Bug:** The frontend expects `data.steps` (array of `{id, success, error}`) from the stop response, but `StopIssueResponse` only returns `{issue_identifier, stopped, reason}`. The 4-step checklist animation (signal → cancel → cleanup → status) never gets per-step feedback — it either marks all as success or all as failed.
**Fix:** Either extend the backend `StopIssueResponse` to include per-step results, or simplify the frontend to show a single success/failure status instead of a fake multi-step checklist.

### 10. Port config overlay should be removed (UX — user-requested)
**File:** `.symphony/reports/mobile-dashboard.html:559-568, 696-740`
**Bug:** The dashboard shows a "Connect to dashboard server" overlay requiring manual host:port input. Since the HTML is served from the same network as the dashboard server, it should auto-detect the correct base URL or be pre-configured.
**Fix:** Auto-detect the dashboard API URL from the page's serving context. If served from `pro16.local:8090`, the API is at `pro16.local:4321` (same host, known port). Alternatively, inject the API base URL at serve time, or embed the port mapping as a config constant.

---

## Stale TODO comments to clean up

Two TODO comments remain from the pre-SYMPH-214 implementation:
- Line 1346: `// TODO: Backend endpoint GET /api/v1/queue not yet implemented`
- Line 1472: `// TODO: Backend endpoint POST /api/v1/deploy/preview not yet implemented`
Both endpoints now exist — these comments are misleading.

---

## Priority order for fixes

| Priority | Gap | Effort | Impact |
|----------|-----|--------|--------|
| P0 | #1 Queue URL | 1 line | Queue tab completely broken |
| P0 | #2 Queue field name | 1 line | Merged PRs invisible |
| P0 | #4 Deploy stream URL/method | ~20 lines | Deploy execute completely broken |
| P0 | #5 Deploy script path | 1 line | Deploy preview + execute broken on server |
| P1 | #3 GitHub queue error handling | ~15 lines | Queue fails on repos with issues disabled |
| P1 | #6 Linear URLs | 2 lines | All Linear deep links 404 |
| P1 | #10 Port config removal | ~30 lines | Bad UX, manual step on every visit |
| P2 | #7 Parent issue link | ~10 lines | Missing spec-required feature |
| P2 | #8 Reports screen | ~30 lines | Reports tab links all 404 |
| P2 | #9 Stop checklist | ~20 lines | Cosmetic — stop works but feedback is fake |
