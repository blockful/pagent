# 05 -- MCP tool (get_audit_log)

## Description

Register a `get_audit_log` MCP tool that lets agents query audit events
for a page they created, returning both human-readable text and
structured JSON.

## Files to create/modify

- `apps/api/mcp/tools.ts` -- register `get_audit_log` tool in
  `registerPagentTools()` after `check_result`. Input:
  `page_id` (32-char hex, required) and `limit` (1..100, default 20).
  Output: `content` with formatted text summary, `structuredContent`
  with full event array.
- `apps/api/mcp/http.ts` -- implement `getAuditLog()` on the in-process
  `PageOps` adapter by calling `db.queryAuditLog()` directly.
- `apps/mcp/server.ts` -- implement `getAuditLog()` on the stdio
  adapter by calling `GET /audit?resource_id=<page_id>&resource_type=page&limit=<limit>`.
- `apps/api/mcp/tools.test.ts` -- tests for the new tool.

## Acceptance criteria

- Tool name is `get_audit_log` with title "Get audit log for a page".
- `page_id` input is validated as a 32-char hex string; invalid values
  return an MCP error.
- `limit` defaults to 20, capped at 100.
- Text output is a human-readable summary: one line per event with
  timestamp, action, and key metadata.
- `structuredContent` contains `{ page_id, events: [...] }` with full
  event objects (action, created_at, metadata).
- `PageOps` interface gains `getAuditLog(page_id: string, limit: number): Promise<AuditEvent[]>`.
- In-process adapter queries DB directly; stdio adapter calls the REST
  endpoint.
- Tests cover: valid page_id returns events, invalid page_id returns
  error, empty result set, text formatting.

## Dependencies

- **01** (schema and DB layer) -- `queryAuditLog()`.
- **04** (REST endpoint) -- stdio adapter calls `GET /audit`.

## Relevant spec sections

- Section 5 (MCP tool) -- parameters, response format, registration
  code, PageOps extension
