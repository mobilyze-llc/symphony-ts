# Fix Slack Notifications — Debug Plan

## Root Cause (found)

**The notifier is never instantiated because `SLACK_NOTIFY_CHANNEL` is not configured anywhere.**

The notification code is fully implemented and correct in source:
- 6 event types in `pipeline-notifier.ts`: `pipeline_started`, `pipeline_stopped`, `issue_completed`, `issue_failed`, `stall_killed`, `infra_error`
- `fireWorkerNotification()` in `runtime-host.ts` correctly fires events on worker exit
- `formatNotification()` correctly formats Slack mrkdwn messages
- `createSlackPoster()` correctly uses `@slack/web-api` WebClient
- `SLACK_BOT_TOKEN` IS configured in `.env.enc` ✅

But the notifier creation gate in `main.ts:168-174` requires BOTH conditions:
```typescript
const notifier =
  slackChannel !== null && slackToken !== undefined
    ? new PipelineNotifier({...})
    : null;
```

**`slackChannel` is always `null`** because:
1. No workflow config has `slack_notify_channel` under `server:` — all 8 WORKFLOW files only have `port:`
2. No `SLACK_NOTIFY_CHANNEL` env var in `.env.enc` or `run-pipeline.sh`
3. Config resolver falls through: `readString(server.slack_notify_channel) ?? environment.SLACK_NOTIFY_CHANNEL ?? null` → `null`

All notification call sites use optional chaining (`notifier?.notify(...)`) or guard (`if (this.notifier !== null)`), so everything silently does nothing.

## Additional Finding: Rate Limit Notifications Don't Exist

The user expected rate-limit notifications. Rate limiting is tracked in the dashboard and logs, but there is no `rate_limited` event type in the `PipelineNotificationEvent` union. This is a missing feature, not a broken one.

## Additional Finding: Silent Error Swallowing

The `PipelineNotifier` constructor sets `onError` to `() => {}` by default. If notifications fail after we configure the channel, errors would be silently swallowed with no logging. The CLI doesn't pass an `onError` callback.

## Fix Plan

### Step 1: Configure `SLACK_NOTIFY_CHANNEL` in `.env.enc`
- Determine the target Slack channel ID (ask user)
- Add `SLACK_NOTIFY_CHANNEL=C<channel_id>` to `.env.enc` via sops
- This makes it available to ALL workflows via the env var fallback path, avoiding per-workflow duplication

### Step 2: Add error logging to the notifier
- In `main.ts`, pass an `onError` callback to `PipelineNotifier` that logs warnings
- Without this, if the Slack API call fails (wrong token, wrong channel, network issue), we'll never know

**File**: `src/cli/main.ts` (~line 170)
```typescript
const notifier =
  slackChannel !== null && slackToken !== undefined
    ? new PipelineNotifier({
        channel: slackChannel,
        poster: createSlackPoster({ botToken: slackToken }),
        onError: (error) => {
          // Log but don't crash — best-effort notifications
          console.error("[pipeline-notifier] Slack post failed:", error);
        },
      })
    : null;
```

### Step 3: Add startup log confirming notifier state
- Log whether the notifier was created or skipped, so we can verify in production logs
- This prevents future silent-misconfiguration issues

**File**: `src/cli/main.ts` (after notifier creation)
```typescript
if (notifier !== null) {
  console.log(`[pipeline-notifier] Enabled — channel: ${slackChannel}`);
} else {
  console.warn("[pipeline-notifier] Disabled — missing SLACK_NOTIFY_CHANNEL or SLACK_BOT_TOKEN");
}
```

### Step 4: (Optional) Add rate_limit notification event type
- Add a `RateLimitEvent` to the discriminated union in `pipeline-notifier.ts`
- Fire it from the appropriate location when rate limits are detected
- This is a new feature, not a bug fix — scope depends on user preference

### Step 5: Deploy and verify
- Build (`pnpm build`)
- Deploy to pro16 via `symphony-deploy`
- Verify notifications appear in target Slack channel
- Check logs for the `[pipeline-notifier] Enabled` confirmation

## Files to Change
1. `.env.enc` — add `SLACK_NOTIFY_CHANNEL`
2. `src/cli/main.ts` — add onError callback + startup log
3. (Optional) `src/orchestrator/pipeline-notifier.ts` — add rate_limit event type
4. (Optional) fire site for rate_limit events

## Verification
- `pnpm test` — existing tests should still pass
- `pnpm build` — compiles without errors
- Manual: run pipeline, confirm Slack message appears on pipeline_started
- Manual: check logs for `[pipeline-notifier] Enabled` line
