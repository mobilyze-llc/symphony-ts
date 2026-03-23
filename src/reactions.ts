/**
 * Reaction lifecycle helpers for Slack message processing.
 *
 * Manages the emoji reaction indicators that show message processing state:
 * - eyes: processing in progress
 * - white_check_mark: completed successfully
 * - x: completed with error
 * - warning: configuration issue (e.g., unmapped channel)
 */
import type { Adapter } from "chat";

/** Mark a message as being processed (add eyes reaction). */
export async function markProcessing(
  adapter: Adapter,
  threadId: string,
  messageId: string,
): Promise<void> {
  await adapter.addReaction(threadId, messageId, "eyes");
}

/** Mark a message as successfully completed (replace eyes with checkmark). */
export async function markSuccess(
  adapter: Adapter,
  threadId: string,
  messageId: string,
): Promise<void> {
  await adapter.removeReaction(threadId, messageId, "eyes");
  await adapter.addReaction(threadId, messageId, "white_check_mark");
}

/** Mark a message as failed (replace eyes with x). */
export async function markError(
  adapter: Adapter,
  threadId: string,
  messageId: string,
): Promise<void> {
  await adapter.removeReaction(threadId, messageId, "eyes");
  await adapter.addReaction(threadId, messageId, "x");
}

/** Mark a message as having a configuration warning (replace eyes with warning). */
export async function markWarning(
  adapter: Adapter,
  threadId: string,
  messageId: string,
): Promise<void> {
  await adapter.removeReaction(threadId, messageId, "eyes");
  await adapter.addReaction(threadId, messageId, "warning");
}
