/**
 * Pure helpers used by the stdio MCP server.
 *
 * Kept separate from server.ts so tests (and any future consumer) can import
 * them without triggering the McpServer constructor / tool registration that
 * runs at server.ts module load.
 */

/**
 * Build a short, actionable hint from a structured API error body.
 * Rate-limit hint takes precedence over size hint (more urgent signal).
 */
export function formatRetryHint(body: {
  retry_after_seconds?: number;
  max_bytes?: number;
}): string {
  if (typeof body.retry_after_seconds === 'number') {
    return `Retry after ${body.retry_after_seconds}s`;
  }
  if (typeof body.max_bytes === 'number') {
    return `Reduce body to ≤${body.max_bytes} bytes`;
  }
  return '';
}
