/**
 * Shared Markdown/mrkdwn delimiter helpers.
 *
 * Linear Markdown and Slack mrkdwn both use backticks as code delimiters. For
 * dynamic inline-code content, strip those delimiter bytes before wrapping the
 * value so user/error text cannot close the span early.
 */
export function formatMarkdownInlineCode(value: string | number): string {
  return `\`${stripMarkdownInlineCodeDelimiters(String(value))}\``;
}

export function stripMarkdownInlineCodeDelimiters(value: string): string {
  return value.replace(/`/g, "");
}

export function formatMarkdownCodeBlock(value: string): string {
  return `\`\`\`\n${stripMarkdownCodeFenceDelimiters(value)}\n\`\`\``;
}

function stripMarkdownCodeFenceDelimiters(value: string): string {
  return value.replace(/```/g, "");
}
