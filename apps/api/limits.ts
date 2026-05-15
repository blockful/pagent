/**
 * Size limits shared across the API, MCP, and schema layers.
 *
 * Kept in a dedicated module to avoid import cycles: schemas.ts and
 * mcp/tools.ts both need HTML_MAX_BYTES, but app.ts already imports from
 * schemas.ts — so we can't host the constant there.
 */

// 1 MB is the HTML payload cap (per spec). The bodyLimit middleware enforces
// this on the wire body; the format=html branch of newPageBodySchema and the
// show_html MCP tool both enforce it again post-parse for clear error shapes.
export const HTML_MAX_BYTES = 1_000_000;
