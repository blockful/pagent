# 02 -- Result Body Schema Update

## Description

Update the `resultBodySchema` in `schemas.ts` from a single object schema to a discriminated union that accepts both browser submissions (existing) and agent submissions (new `source: "agent"` shape).

## Files to create/modify

- **Modify** `apps/api/schemas.ts` -- add `agentResultBodySchema`, `browserResultBodySchema`, redefine `resultBodySchema` as a `z.union`, export `AgentResult`, `BrowserResult`, `ResultBody` types
- **Modify** `apps/api/schemas.test.ts` -- add test cases for the new union schema

## Acceptance criteria

- `agentResultBodySchema` validates `{ source: "agent", data: Record<string, unknown>, file_refs?: Record<string, string> }`.
- `browserResultBodySchema` is the existing schema extracted into its own export, with `.passthrough()` preserved.
- `resultBodySchema` is `z.union([agentResultBodySchema, browserResultBodySchema])`.
- Parsing a body with `source: "agent"` matches the agent branch.
- Parsing a body without `source` (e.g., `{ name: "submitted", surfaceId: "main", context: {} }`) matches the browser branch -- backward compatible.
- Parsing a body that matches neither branch fails validation.
- Types `AgentResult`, `BrowserResult`, `ResultBody` are exported.
- Existing tests in `schemas.test.ts` continue to pass unchanged.

## Dependencies

None -- independent of task 01.

## Relevant spec sections

- Section 3: Result body schema update in `schemas.ts`
- Section 2: Agent submission payload (Zod schemas)
