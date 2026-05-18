# 04 -- PageOps Extension and MCP Tool Registration

## Description

Extend the `PageOps` interface with `getPage` and `submitForm` methods. Register the `submit_form` MCP tool in `tools.ts` with the full fetch-validate-submit orchestration logic.

## Files to create/modify

- **Modify** `apps/api/mcp/tools.ts` -- extend `PageOps` with `getPage(page_id)` and `submitForm(page_id, body)`, add `GetPageResult` / `SubmitFormResult` types, register `submit_form` tool via `registerPagentTools`
- **Modify** `apps/api/mcp/tools.test.ts` -- add tests for the `submit_form` tool using a mock `PageOps`

## Acceptance criteria

- `PageOps` interface adds:
  - `getPage(page_id: string): Promise<GetPageResult>` where `GetPageResult` is `{ kind: 'not_found' } | { kind: 'ok', spec, format, state }`.
  - `submitForm(page_id: string, body: AgentResultBody): Promise<SubmitFormResult>` where `SubmitFormResult` covers ok / validation_failed / not_found / conflict / invalid_format / access_denied.
- `submit_form` tool is registered with:
  - Input schema: `{ page_id: z.string().regex(/^[a-f0-9]{32}$/), data: z.record(z.unknown()), files: z.record(z.string()).optional() }`.
  - Model-facing description from spec section 1.
  - Title: "Submit a form on behalf of the agent".
- Tool handler orchestration:
  1. Calls `ops.getPage(page_id)` -- throws MCP error for not_found, HTML format, non-open state.
  2. Extracts component map from spec, validates data locally.
  3. On validation failure: returns structured `{ valid: false, errors }` (not a throw).
  4. On success: calls `ops.submitForm` and returns `{ submission_id, page_id, submitted_at }`.
- File handling (`files` param) is accepted in schema but deferred -- if `files` is provided, throw a clear error: "File uploads not yet supported" (placeholder for task 06).
- Tests verify: successful submit flow, not_found error, HTML rejection, conflict error, local validation failure returns structured errors.

## Dependencies

- 01 (validation module -- imports `extractComponentMap`, `validateAgentData`)
- 02 (schema update -- imports `AgentResult` type)

## Relevant spec sections

- Section 1: MCP Tool Definition (full section)
- Section 9: MCP Stdio Server Implementation (PageOps extension, tool handler orchestration)
- Section 7: Error Responses (error taxonomy, MCP error vs structured return)
