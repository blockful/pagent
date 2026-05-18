# Agent Form Submission (`submit_form`) -- Design

Status: draft, awaiting user review (2026-05-17).

## Goal

Allow agents to fill and submit Pagent forms programmatically, without a
browser. A new MCP tool `submit_form` and a dual-format REST endpoint let
an agent read a page's spec, validate field data locally, upload files,
and submit -- all over the existing API surface.

## Motivation

Today, only a human in a browser can submit a Pagent form. The browser
renderer captures user input as an A2UI client-action (`{ name,
surfaceId, context, timestamp }`) and POSTs it to `POST /:id/result`.
There is no path for a second agent to fill that form on behalf of a
user or as part of an agent-to-agent pipeline.

### Use cases

1. **Agent-to-agent coordination.** Agent A creates a form (approval
   request, configuration wizard, intake form). Agent B -- running in a
   different session, possibly a different host -- fills the form with
   computed values and submits it. Agent A reads the result through the
   existing `check_result` flow, unmodified.

2. **Automated testing.** Integration tests can exercise the full
   create-fill-submit-read cycle without spinning up a headless browser.

3. **Workflow orchestration.** A central orchestrator agent creates a
   page, dispatches the URL to a specialist agent, and collects the
   result. The specialist agent uses `submit_form` to answer.

4. **Bulk / batch operations.** An agent creates multiple pages (one per
   item in a batch) and another agent fills them in a loop, enabling
   parallelism across page boundaries.

## Non-goals

- **Replacing browser submission.** The browser renderer continues to
  post A2UI client-actions exactly as it does today. `submit_form` is an
  alternative submission channel, not a replacement.

- **Multi-turn form filling.** Pages remain single-shot. `submit_form`
  does not introduce a "save draft" or "partial submit" concept.

- **Spec generation.** `submit_form` does not create pages. It submits
  to existing pages created by `show_ui`.

- **HTML page submission.** HTML pages are view-only by design (see
  html-format-design.md). `submit_form` rejects HTML pages with the
  existing `invalid_for_format` error.

## Dependencies

This spec depends on two features that ship in the same v2 batch:

1. **Auth (OAuth tokens).** `submit_form` carries the submitting agent's
   identity from its OAuth token. Agent identity comes from OAuth tokens;
   the auth feature provides `user_id` and `email` claims on the token.

2. **File uploads (`POST /:id/files`).** `submit_form` supports file
   attachments. The MCP tool reads files from local disk, uploads them to
   the file upload endpoint, and references the returned file IDs in the
   submission payload. The file upload endpoint and Supabase Storage
   integration must exist before `submit_form` can handle files.

Both dependencies ship in the same v2 batch. `submit_form` can ship in a
reduced form (no files, anonymous identity) ahead of them, but the full
design assumes they exist.

---

## 1. MCP Tool Definition

### Tool: `submit_form`

```
Name:        submit_form
Title:       Submit a form on behalf of the agent
```

#### Description (model-facing)

```
Fill and submit a Pagent form programmatically. Use this when you need to
answer a form created by another agent (or yourself) without waiting for
a human in a browser.

Fetches the page spec, validates your data against the declared fields,
uploads any files, and submits. Returns { submission_id } on success or
detailed field-level validation errors on failure.

The page must be in state "open" (not already submitted). HTML pages
(format: html) cannot be submitted -- they are view-only.

After submission, the creating agent reads the result through
check_result exactly as if a human had submitted in the browser.
```

#### Input schema

```typescript
{
  page_id: z.string()
    .regex(/^[a-f0-9]{32}$/)
    .describe('The page_id of the form to submit. Must be an open a2ui page.'),

  data: z.record(z.unknown())
    .describe(
      'Field values keyed by component ID. Each key must match a component ' +
      'ID in the page spec that accepts input (TextField, CheckBox, Slider, ' +
      'ChoicePicker, DateTimeInput). Values must match the expected type for ' +
      'that component. Example: { "tf-email": "alice@example.com", "cb-terms": true }'
    ),

  files: z.record(z.string())
    .optional()
    .describe(
      'File attachments keyed by component ID. Each value is an absolute ' +
      'path to a local file. The tool reads the file, uploads it to the ' +
      'page\'s file endpoint, and includes the file reference in the ' +
      'submission. Example: { "upload-field": "/tmp/report.pdf" }'
    ),
}
```

#### Response

**Success:**
```json
{
  "content": [{ "type": "text", "text": "Form submitted successfully." }],
  "structuredContent": {
    "submission_id": "<page_id>",
    "page_id": "<page_id>",
    "submitted_at": "2026-05-17T12:00:00.000Z"
  }
}
```

**Validation failure (does not submit):**
```json
{
  "content": [{ "type": "text", "text": "Validation failed for 2 fields." }],
  "structuredContent": {
    "page_id": "<page_id>",
    "valid": false,
    "errors": [
      { "field": "tf-email", "message": "Expected string, got number" },
      { "field": "cb-terms", "message": "Required field missing" }
    ]
  }
}
```

**Error cases:**

| Condition | Behavior |
|-----------|----------|
| Page not found / expired | MCP error: "Page {page_id} not found (expired or deleted)." |
| Page is HTML format | MCP error: "Page {page_id} is HTML (view-only). submit_form only works with a2ui pages." |
| Page already submitted | MCP error: "Page {page_id} was already submitted. Create a new page if you need another submission." |
| Validation failure | Returns structured validation errors (not an MCP error -- the tool succeeds but reports invalid data) |
| File not found on disk | MCP error: "File not found: /path/to/file" |
| File upload fails | MCP error: "File upload failed for field {field}: {reason}" |
| Auth: private page, email not in allowlist | MCP error: "Access denied. Your email ({email}) is not in this page's access list." |

---

## 2. API Endpoint Changes

### `POST /:id/result` -- dual-format

The existing endpoint accepts A2UI client-actions from the browser. It
gains a second payload format for agent submissions, distinguished by
the `source` field.

#### Payload discrimination

The handler inspects the parsed JSON body:

1. If the body has a `source` field with value `"agent"`, treat it as an
   agent submission (new path).
2. Otherwise, treat it as a browser submission (existing path -- A2UI
   client-action with `name`, `surfaceId`, etc.).

This is backward-compatible: existing browser payloads never include a
`source` field.

#### Agent submission payload

```typescript
// Zod schema
const agentResultBodySchema = z.object({
  source: z.literal('agent'),

  data: z.record(z.unknown()),
  // Field values keyed by component ID.
  // Example: { "tf-email": "alice@co", "cb-terms": true, "sl-bright": 75 }

  file_refs: z.record(z.string()).optional(),
  // File references keyed by component ID.
  // Each value is a file_id returned by POST /:id/files.
  // Example: { "upload-field": "file_abc123" }

  submitted_by: z.string().email().optional(),
  // Populated server-side from the OAuth token. Agents do not set this
  // directly; the server overwrites any client-supplied value.
});
```

#### Full request body schema (updated)

```typescript
const resultBodySchema = z.union([
  // Branch 1: Agent submission (new)
  agentResultBodySchema,

  // Branch 2: Browser submission (existing, unchanged)
  z.object({
    name: z.string().min(1),
    surfaceId: z.string().min(1),
    sourceComponentId: z.string().optional(),
    context: z.record(z.unknown()).optional().default({}),
    timestamp: z.string().datetime().optional(),
  }).passthrough(),
]);
```

#### Stored result shape

When an agent submits, the stored `result` in the `pages` table is:

```json
{
  "source": "agent",
  "data": { "tf-email": "alice@co", "cb-terms": true },
  "file_refs": { "upload-field": "file_abc123" },
  "submitted_by": "agent-b@example.com",
  "submitted_at": "2026-05-17T12:00:00.000Z"
}
```

When a browser submits (existing), the stored `result` is the A2UI
client-action shape as before:

```json
{
  "name": "submitted",
  "surfaceId": "main",
  "sourceComponentId": "submit",
  "context": { "name": "Alex" },
  "timestamp": "2026-05-17T12:00:00.000Z"
}
```

The `check_result` consumer (Agent A) can distinguish by checking for
`result.source === "agent"`.

#### Server-side validation (agent submissions)

When the server receives an agent submission, it performs validation
before storing:

1. **Page lookup.** Same as today: fetch the page, check it exists and
   is not expired, check format is `a2ui`, check state is `open`.

2. **Spec parsing.** Extract the component tree from the page's stored
   spec. Build a map of `component_id -> component_definition`.

3. **Field validation.** For each key in `data`, find the matching
   component and validate the value against the component type (see
   section 4). Collect all errors.

4. **Required field check.** Walk the spec's input components. Any
   component with no corresponding key in `data` and no default value is
   flagged as missing (warning, not hard error in v1 -- the creating
   agent may not have marked fields as required).

5. **File reference check.** For each key in `file_refs`, verify the
   file_id exists in storage and belongs to this page.

6. If validation passes, store the result and transition `open ->
   submitted` exactly as the existing path does.

#### Response codes

| Status | Condition |
|--------|-----------|
| 200 | Submitted successfully. Body: `{ ok: true, submission_id: "<page_id>" }` |
| 400 `bad_request` | Malformed body (fails schema parse) |
| 400 `validation_failed` | Data does not match spec (field-level errors returned) |
| 400 `invalid_for_format` | Page is HTML (view-only) |
| 404 `not_found` | Page not found or expired |
| 403 `access_denied` | Private page, submitter email not in allowlist |
| 409 `conflict` | Page already submitted |

#### Validation error response (400 `validation_failed`)

```json
{
  "error": "validation_failed",
  "message": "2 field(s) failed validation",
  "fields": [
    {
      "field": "tf-email",
      "component": "TextField",
      "expected": "string",
      "got": "number",
      "message": "Expected a string value for TextField"
    },
    {
      "field": "cb-terms",
      "component": "CheckBox",
      "expected": "boolean",
      "got": "undefined",
      "message": "Required field missing"
    }
  ]
}
```

---

## 3. Result body schema update in `schemas.ts`

The `resultBodySchema` in `apps/api/schemas.ts` changes from a single
object schema to a discriminated union.

**Current:**

```typescript
export const resultBodySchema = z
  .object({
    name: z.string().min(1),
    surfaceId: z.string().min(1),
    sourceComponentId: z.string().optional(),
    context: z.record(z.unknown()).optional().default({}),
    timestamp: z.string().datetime().optional(),
  })
  .passthrough();
```

**New:**

```typescript
// Agent submission shape
export const agentResultBodySchema = z.object({
  source: z.literal('agent'),
  data: z.record(z.unknown()),
  file_refs: z.record(z.string()).optional(),
});

// Browser submission shape (unchanged)
export const browserResultBodySchema = z
  .object({
    name: z.string().min(1),
    surfaceId: z.string().min(1),
    sourceComponentId: z.string().optional(),
    context: z.record(z.unknown()).optional().default({}),
    timestamp: z.string().datetime().optional(),
  })
  .passthrough();

// Union: try agent shape first (has discriminant `source`), fall back
// to browser shape.
export const resultBodySchema = z.union([
  agentResultBodySchema,
  browserResultBodySchema,
]);

export type AgentResult = z.infer<typeof agentResultBodySchema>;
export type BrowserResult = z.infer<typeof browserResultBodySchema>;
export type ResultBody = z.infer<typeof resultBodySchema>;
```

Backward compatibility: existing browser POSTs never include
`source: "agent"`, so they match the second branch. The `.passthrough()`
on the browser branch means extra fields are tolerated, same as today.

---

## 4. A2UI Spec-to-Validation Mapping

When an agent submits via `submit_form`, each value in `data` must match
the type expected by the A2UI component it targets. The mapping below
defines the validation rules per component type from the basic catalog.

### Component type table

| Component | Value type | Validation rules | Notes |
|-----------|-----------|------------------|-------|
| `TextField` (variant: `text`) | `string` | Max 10,000 chars | |
| `TextField` (variant: `number`) | `number` | Must be finite | Strings that parse as numbers are coerced |
| `TextField` (variant: `obscured`) | `string` | Max 10,000 chars | Same as text |
| `TextField` (variant: `longText`) | `string` | Max 50,000 chars | Textarea equivalent |
| `CheckBox` | `boolean` | Must be `true` or `false` | |
| `Slider` | `number` | Must be within `[min, max]` if spec declares bounds | |
| `ChoicePicker` (variant: `singleSelection`) | `string[]` with exactly 1 element | Element must be one of `options[].value` | Array shape matches A2UI's internal model |
| `ChoicePicker` (variant: `multipleSelection`) | `string[]` | Each element must be one of `options[].value` | |
| `DateTimeInput` | `string` | ISO 8601 datetime. If `enableDate: false`, time-only format (`HH:mm`). If `enableTime: false`, date-only format (`YYYY-MM-DD`). | |
| `Button` | _not a data field_ | Ignored in `data` -- buttons are actions, not inputs | |
| `Text` | _not a data field_ | Ignored in `data` | |
| `Image` | _not a data field_ | Ignored in `data` | |
| `Icon` | _not a data field_ | Ignored in `data` | |
| `Divider` | _not a data field_ | Ignored in `data` | |
| `Card` | _not a data field_ | Layout container, ignored in `data` | |
| `Column` | _not a data field_ | Layout container, ignored in `data` | |
| `Row` | _not a data field_ | Layout container, ignored in `data` | |
| `Tabs` | _not a data field_ | Layout container, ignored in `data` | |
| `Modal` | _not a data field_ | Layout container, ignored in `data` | |
| `List` | _not a data field_ | Layout container, ignored in `data` | |

### Input component set

For validation purposes, only these components are "input components"
that accept values in `data`:

```typescript
const INPUT_COMPONENTS = new Set([
  'TextField',
  'CheckBox',
  'Slider',
  'ChoicePicker',
  'DateTimeInput',
]);
```

A key in `data` that targets a non-input component (or a component ID
that does not exist in the spec) produces a validation warning, not an
error. This is lenient by design -- agents may include extra context
keys that the spec does not declare, and stripping them silently is
better than hard-failing.

### Extracting the component map from a spec

The A2UI spec is an array of messages. The component tree lives inside
the `updateComponents` message:

```typescript
function extractComponentMap(
  spec: unknown
): Map<string, { component: string; [key: string]: unknown }> {
  const map = new Map();
  if (!Array.isArray(spec)) return map;

  for (const msg of spec) {
    if (msg?.updateComponents?.components) {
      for (const comp of msg.updateComponents.components) {
        if (comp?.id && comp?.component) {
          map.set(comp.id, comp);
        }
      }
    }
  }
  return map;
}
```

### Validation function

```typescript
type FieldError = {
  field: string;
  component: string;
  expected: string;
  got: string;
  message: string;
};

function validateAgentData(
  data: Record<string, unknown>,
  componentMap: Map<string, { component: string; [k: string]: unknown }>
): FieldError[] {
  const errors: FieldError[] = [];

  for (const [fieldId, value] of Object.entries(data)) {
    const comp = componentMap.get(fieldId);
    if (!comp) continue; // Unknown field: ignore (lenient)
    if (!INPUT_COMPONENTS.has(comp.component)) continue; // Non-input: ignore

    const err = validateFieldValue(fieldId, comp, value);
    if (err) errors.push(err);
  }

  return errors;
}

function validateFieldValue(
  fieldId: string,
  comp: { component: string; [k: string]: unknown },
  value: unknown
): FieldError | null {
  switch (comp.component) {
    case 'TextField': {
      if (comp.variant === 'number') {
        if (typeof value === 'string') {
          const parsed = Number(value);
          if (!Number.isFinite(parsed)) {
            return {
              field: fieldId, component: 'TextField',
              expected: 'number', got: typeof value,
              message: `String "${value}" cannot be parsed as a number`,
            };
          }
          // Coercion succeeds -- caller should use parsed value
          return null;
        }
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return {
            field: fieldId, component: 'TextField',
            expected: 'number', got: typeof value,
            message: 'Expected a finite number',
          };
        }
      } else {
        if (typeof value !== 'string') {
          return {
            field: fieldId, component: 'TextField',
            expected: 'string', got: typeof value,
            message: 'Expected a string value for TextField',
          };
        }
        const maxLen = comp.variant === 'longText' ? 50_000 : 10_000;
        if (value.length > maxLen) {
          return {
            field: fieldId, component: 'TextField',
            expected: `string (max ${maxLen} chars)`, got: `string (${value.length} chars)`,
            message: `Value exceeds ${maxLen} character limit`,
          };
        }
      }
      return null;
    }

    case 'CheckBox': {
      if (typeof value !== 'boolean') {
        return {
          field: fieldId, component: 'CheckBox',
          expected: 'boolean', got: typeof value,
          message: 'Expected true or false',
        };
      }
      return null;
    }

    case 'Slider': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return {
          field: fieldId, component: 'Slider',
          expected: 'number', got: typeof value,
          message: 'Expected a finite number',
        };
      }
      const min = typeof comp.min === 'number' ? comp.min : -Infinity;
      const max = typeof comp.max === 'number' ? comp.max : Infinity;
      if (value < min || value > max) {
        return {
          field: fieldId, component: 'Slider',
          expected: `number in [${min}, ${max}]`, got: String(value),
          message: `Value ${value} is outside the allowed range [${min}, ${max}]`,
        };
      }
      return null;
    }

    case 'ChoicePicker': {
      if (!Array.isArray(value)) {
        return {
          field: fieldId, component: 'ChoicePicker',
          expected: 'string[]', got: typeof value,
          message: 'Expected an array of selected option values',
        };
      }
      const options = Array.isArray(comp.options)
        ? (comp.options as { value: string }[]).map(o => o.value)
        : [];
      for (const v of value) {
        if (typeof v !== 'string') {
          return {
            field: fieldId, component: 'ChoicePicker',
            expected: 'string', got: typeof v,
            message: 'Each selected value must be a string',
          };
        }
        if (options.length > 0 && !options.includes(v)) {
          return {
            field: fieldId, component: 'ChoicePicker',
            expected: `one of [${options.join(', ')}]`, got: v,
            message: `"${v}" is not a valid option`,
          };
        }
      }
      if (comp.variant === 'singleSelection' && value.length !== 1) {
        return {
          field: fieldId, component: 'ChoicePicker',
          expected: 'exactly 1 selected value', got: `${value.length} values`,
          message: 'Single-selection ChoicePicker requires exactly one value',
        };
      }
      return null;
    }

    case 'DateTimeInput': {
      if (typeof value !== 'string') {
        return {
          field: fieldId, component: 'DateTimeInput',
          expected: 'string (ISO 8601)', got: typeof value,
          message: 'Expected an ISO 8601 date/time string',
        };
      }
      // Basic format check. Full ISO 8601 parsing is complex; we check
      // the common shapes the renderer produces.
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
      const timeOnly = /^\d{2}:\d{2}(:\d{2})?$/;
      const dateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
      if (comp.enableDate === false && comp.enableTime !== false) {
        if (!timeOnly.test(value)) {
          return {
            field: fieldId, component: 'DateTimeInput',
            expected: 'HH:mm or HH:mm:ss', got: value,
            message: 'Time-only DateTimeInput expects HH:mm format',
          };
        }
      } else if (comp.enableTime === false && comp.enableDate !== false) {
        if (!dateOnly.test(value)) {
          return {
            field: fieldId, component: 'DateTimeInput',
            expected: 'YYYY-MM-DD', got: value,
            message: 'Date-only DateTimeInput expects YYYY-MM-DD format',
          };
        }
      } else {
        if (!dateTime.test(value) && !dateOnly.test(value)) {
          return {
            field: fieldId, component: 'DateTimeInput',
            expected: 'ISO 8601 datetime', got: value,
            message: 'Expected ISO 8601 datetime (e.g., 2026-05-17T12:00:00Z)',
          };
        }
      }
      return null;
    }

    default:
      return null;
  }
}
```

### Where validation runs

Validation runs in **two places** with the same logic:

1. **MCP tool (client-side).** The `submit_form` tool fetches the spec
   via `GET /:id`, extracts the component map, and validates locally.
   This provides fast feedback: the agent sees errors without a
   round-trip to the submit endpoint.

2. **API server (server-side).** The `POST /:id/result` handler
   validates agent submissions before storing. This is the authoritative
   check -- even if a caller bypasses the MCP tool and POSTs directly,
   the server catches invalid data.

The validation module is shared code that both the MCP server and the
API import from a common location (new file:
`apps/api/validate-agent-data.ts`). The MCP stdio server bundles it;
the API server imports it directly.

---

## 5. File Handling

### Flow: local path to file reference

```
Agent (MCP tool)              API                    Storage
     |                         |                        |
     |  1. read file from      |                        |
     |     local disk          |                        |
     |                         |                        |
     |  2. POST /:id/files     |                        |
     |     multipart/form-data |                        |
     |  ---------------------->|  3. validate, store    |
     |                         |  --------------------->|
     |                         |  <-- file_id ----------|
     |  <-- { file_id } -------|                        |
     |                         |                        |
     |  4. POST /:id/result    |                        |
     |     { source: "agent",  |                        |
     |       data: {...},      |                        |
     |       file_refs: {      |                        |
     |         "field": "id"   |                        |
     |       }                 |                        |
     |  ---------------------->|                        |
     |                         |  5. verify file_id     |
     |                         |     belongs to page    |
     |                         |                        |
     |  <-- { ok: true } ------|                        |
```

### MCP tool file handling (stdio server)

```typescript
// In the submit_form handler:

async function uploadFiles(
  pageId: string,
  files: Record<string, string>,
  serviceUrl: string
): Promise<Record<string, string>> {
  const fileRefs: Record<string, string> = {};

  for (const [fieldId, filePath] of Object.entries(files)) {
    // 1. Verify file exists
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }

    // 2. Read file
    const fileBuffer = await fs.readFile(filePath);
    const fileName = path.basename(filePath);
    const mimeType = guessMimeType(fileName); // simple extension lookup

    // 3. Upload via multipart
    const form = new FormData();
    form.append('file', new Blob([fileBuffer], { type: mimeType }), fileName);
    form.append('field_name', fieldId);

    const res = await fetch(`${serviceUrl}/${pageId}/files`, {
      method: 'POST',
      body: form,
      // Auth header: include OAuth Bearer token for agent identity
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        `File upload failed for field "${fieldId}": ${body.message ?? res.status}`
      );
    }

    const result = await res.json() as { file_id: string };
    fileRefs[fieldId] = result.file_id;
  }

  return fileRefs;
}
```

### File constraints

- Max file size: 10 MB per file (enforced by `POST /:id/files`).
- Max files per page: 10 (enforced by the file upload endpoint).
- Allowed MIME types: configurable per deployment; default allowlist
  includes common document, image, and archive types.
- File IDs are scoped to a page -- a file_id from page A cannot be
  referenced in page B's submission.

---

## 6. Auth and Access Control

### Token-based identity

Agent submissions carry identity via OAuth tokens (ships in the same v2
batch):

1. The MCP tool includes the OAuth access token in the
   `Authorization: Bearer <token>` header on both `POST /:id/files`
   and `POST /:id/result`.

2. The server extracts the `email` claim from the token and sets
   `submitted_by` on the stored result.

3. The audit log records `submitted_by` alongside the `page_id` and
   timestamp.

### Private pages

Private pages have an `access_emails` allowlist (array of email
addresses). When a submission arrives:

```
1. Extract email from OAuth token
2. If page.access_emails is non-null and non-empty:
   a. If email is in access_emails -> allow
   b. If email is NOT in access_emails -> 403 access_denied
3. If page.access_emails is null (public page) -> allow
```

Error response for access denied:

```json
{
  "error": "access_denied",
  "message": "Your email (agent-b@example.com) is not in this page's access list",
  "request_id": "..."
}
```

### Anonymous fallback

When the submitting agent has no token (e.g., token expired or not yet
configured), submissions are accepted without identity. The
`submitted_by` field is `null`. Private pages with an `access_emails`
allowlist reject anonymous submissions with 401 (not 403).

### Public mode pages

Pages created with `mode: "public"` accept submissions from anyone
(including agents) without access checks. The `submit_form` tool works
identically regardless of mode -- public mode simply skips the email
allowlist check.

---

## 7. Error Responses

### Error taxonomy for `submit_form`

All errors from the MCP tool are surfaced as either:

- **MCP errors** (tool throws): for conditions where submission cannot
  proceed at all (page not found, access denied, file I/O failure).
  The MCP protocol surfaces these to the calling agent as error
  responses.

- **Structured validation results** (tool returns normally): for data
  validation failures. The tool returns a success response with
  `valid: false` and a `fields` array, so the agent can inspect
  individual field errors and correct them.

This distinction matters: MCP errors are terminal (the agent should not
retry the same call), while validation results are actionable (the agent
can fix the data and resubmit).

### Complete error catalog

| Error code | HTTP | MCP surface | Description |
|------------|------|-------------|-------------|
| `not_found` | 404 | throw | Page does not exist or has expired |
| `invalid_for_format` | 400 | throw | Page is HTML (view-only) |
| `conflict` | 409 | throw | Page already submitted |
| `access_denied` | 403 | throw | Private page, email not in allowlist |
| `unauthorized` | 401 | throw | Private page, no auth token |
| `validation_failed` | 400 | return `{ valid: false, errors }` | Data does not match spec |
| `file_not_found` | -- | throw | Local file path does not exist (MCP only) |
| `file_upload_failed` | varies | throw | Server rejected the file upload |
| `bad_request` | 400 | throw | Malformed request body |
| `rate_limited` | 429 | throw | Too many requests |
| `internal_error` | 500 | throw | Unexpected server error |

---

## 8. Agent-to-Agent Workflow Examples

### Example 1: Approval workflow

Agent A (orchestrator) needs Agent B (reviewer) to approve a deployment.

```
Step 1: Agent A creates the form
────────────────────────────────
Agent A calls show_ui with a spec:
  - Text: "Deployment Approval for service-x v2.3.1"
  - ChoicePicker (id: "decision"):
      variant: singleSelection
      options: [{ label: "Approve", value: "approve" },
                { label: "Reject", value: "reject" }]
  - TextField (id: "notes"):
      label: "Notes (optional)"
      variant: longText
  - Button: "Submit" with action referencing /decision and /notes

show_ui returns { page_id: "abc123...", url: "https://pagent.link/abc123..." }

Step 2: Agent A sends page_id to Agent B
─────────────────────────────────────────
Agent A communicates the page_id to Agent B through whatever channel
connects them (shared context, message queue, file, etc.).

Step 3: Agent B submits programmatically
────────────────────────────────────────
Agent B calls submit_form:
  page_id: "abc123..."
  data: {
    "decision": ["approve"],
    "notes": "LGTM. Canary metrics look clean."
  }

The tool:
  1. Fetches GET /abc123... to read the spec
  2. Validates: "decision" is ChoicePicker (singleSelection),
     ["approve"] is valid (1 element, in options). "notes" is
     TextField (longText), string value OK.
  3. POSTs to /abc123.../result with source: "agent"
  4. Returns { submission_id: "abc123...", submitted_at: "..." }

Step 4: Agent A reads the result
────────────────────────────────
Agent A calls check_result("abc123..."):
  {
    state: "submitted",
    result: {
      source: "agent",
      data: { "decision": ["approve"], "notes": "LGTM..." },
      submitted_by: "agent-b@example.com",
      submitted_at: "2026-05-17T12:00:00Z"
    }
  }

Agent A proceeds with the deployment.
```

### Example 2: Data collection pipeline with files

Agent A (collector) creates a form for Agent B (analyst) to attach a
report.

```
Step 1: Agent A creates the form
────────────────────────────────
show_ui with a spec containing:
  - TextField (id: "title"): label "Report title"
  - TextField (id: "summary"): label "Summary", variant "longText"
  - (Future: FileUpload component for the attachment)

page_id: "def456..."

Step 2: Agent B submits with a file
───────────────────────────────────
Agent B calls submit_form:
  page_id: "def456..."
  data: {
    "title": "Q2 Revenue Analysis",
    "summary": "Revenue up 12% YoY..."
  }
  files: {
    "attachment": "/tmp/q2-revenue.pdf"
  }

The tool:
  1. Fetches spec, validates text fields
  2. Reads /tmp/q2-revenue.pdf from disk (8.2 MB)
  3. POSTs to /def456.../files with multipart body -> gets file_id
  4. POSTs to /def456.../result with:
     { source: "agent", data: {...}, file_refs: { "attachment": "file_id" } }

Step 3: Agent A reads the result
────────────────────────────────
check_result returns the data + file references. Agent A can
download the file via GET /def456.../files/<file_id>.
```

### Example 3: Validation failure and retry

```
Step 1: Agent B submits with bad data
─────────────────────────────────────
submit_form:
  page_id: "ghi789..."
  data: {
    "decision": "approve",     // Wrong: should be ["approve"]
    "amount": "not a number"   // Wrong: TextField variant=number
  }

The tool validates locally and returns:
  {
    valid: false,
    errors: [
      { field: "decision", component: "ChoicePicker",
        expected: "string[]", got: "string",
        message: "Expected an array of selected option values" },
      { field: "amount", component: "TextField",
        expected: "number", got: "string",
        message: "String \"not a number\" cannot be parsed as a number" }
    ]
  }

Step 2: Agent B fixes and retries
─────────────────────────────────
submit_form:
  page_id: "ghi789..."
  data: {
    "decision": ["approve"],
    "amount": 42
  }

Returns: { submission_id: "ghi789...", submitted_at: "..." }
```

---

## 9. MCP Stdio Server Implementation

### New tool registration

The `submit_form` tool is registered alongside `show_ui`, `show_html`,
and `check_result` in `apps/api/mcp/tools.ts` via
`registerPagentTools`.

#### PageOps extension

```typescript
export interface PageOps {
  showUi(spec: unknown): Promise<ShowUiResult>;
  showHtml(html: string): Promise<ShowUiResult>;
  checkResult(page_id: string): Promise<CheckResultOutcome>;

  // New:
  getPage(page_id: string): Promise<GetPageResult>;
  submitForm(page_id: string, body: AgentResultBody): Promise<SubmitFormResult>;
  uploadFile(page_id: string, fieldId: string, file: FilePayload): Promise<string>;
}

export type GetPageResult =
  | { kind: 'not_found' }
  | { kind: 'ok'; spec: unknown; format: PageFormat; state: PageState };

export type SubmitFormResult =
  | { kind: 'ok'; submission_id: string; submitted_at: string }
  | { kind: 'validation_failed'; errors: FieldError[] }
  | { kind: 'not_found' }
  | { kind: 'conflict' }
  | { kind: 'invalid_format'; format: string }
  | { kind: 'access_denied'; message: string };

export type FilePayload = {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
};
```

#### Stdio adapter (apps/mcp/server.ts)

```typescript
const restOps: PageOps = {
  // ... existing ops unchanged ...

  async getPage(page_id) {
    const res = await fetch(`${SERVICE_URL}/${page_id}`, {
      headers: { accept: 'application/json' },
    });
    if (res.status === 404) return { kind: 'not_found' };
    if (!res.ok) throw await readError(res, 'getPage');
    const body = await res.json() as {
      spec: unknown; format: PageFormat; state: PageState;
    };
    return { kind: 'ok', spec: body.spec, format: body.format, state: body.state };
  },

  async uploadFile(page_id, fieldId, file) {
    const form = new FormData();
    form.append('file', new Blob([file.buffer], { type: file.mimeType }), file.fileName);
    form.append('field_name', fieldId);
    const res = await fetch(`${SERVICE_URL}/${page_id}/files`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) throw await readError(res, 'uploadFile');
    const result = await res.json() as { file_id: string };
    return result.file_id;
  },

  async submitForm(page_id, body) {
    const res = await fetch(`${SERVICE_URL}/${page_id}/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 404) return { kind: 'not_found' };
    if (res.status === 409) return { kind: 'conflict' };
    if (res.status === 403) {
      const b = await res.json().catch(() => ({})) as { message?: string };
      return { kind: 'access_denied', message: b.message ?? 'Access denied' };
    }
    if (res.status === 400) {
      const b = await res.json().catch(() => ({})) as {
        error?: string; fields?: FieldError[];
      };
      if (b.error === 'validation_failed' && b.fields) {
        return { kind: 'validation_failed', errors: b.fields };
      }
      if (b.error === 'invalid_for_format') {
        return { kind: 'invalid_format', format: 'html' };
      }
      throw new Error(`Submit failed (400): ${JSON.stringify(b)}`);
    }
    if (!res.ok) throw await readError(res, 'submitForm');
    const result = await res.json() as { submission_id: string };
    return {
      kind: 'ok',
      submission_id: result.submission_id,
      submitted_at: new Date().toISOString(),
    };
  },
};
```

#### Tool handler orchestration

```typescript
// In registerPagentTools:

server.registerTool(
  'submit_form',
  {
    title: 'Submit a form on behalf of the agent',
    description: SUBMIT_FORM_DESCRIPTION,
    inputSchema: {
      page_id: z.string().regex(/^[a-f0-9]{32}$/),
      data: z.record(z.unknown()),
      files: z.record(z.string()).optional(),
    },
  },
  async ({ page_id, data, files }) => {
    // Step 1: Fetch spec
    const page = await ops.getPage(page_id);
    if (page.kind === 'not_found') {
      throw new Error(
        `Page ${page_id} not found (expired or deleted). ` +
        `Don't retry -- the page no longer exists.`
      );
    }
    if (page.format === 'html') {
      throw new Error(
        `Page ${page_id} is HTML (view-only). ` +
        `submit_form only works with a2ui pages.`
      );
    }
    if (page.state !== 'open') {
      throw new Error(
        `Page ${page_id} is already ${page.state}. ` +
        `Create a new page if you need another submission.`
      );
    }

    // Step 2: Local validation
    const componentMap = extractComponentMap(page.spec);
    const errors = validateAgentData(data, componentMap);
    if (errors.length > 0) {
      return {
        content: [{
          type: 'text',
          text: `Validation failed for ${errors.length} field(s):\n` +
                errors.map(e => `  - ${e.field}: ${e.message}`).join('\n'),
        }],
        structuredContent: {
          page_id,
          valid: false,
          errors,
        },
      };
    }

    // Step 3: Upload files (if any)
    let fileRefs: Record<string, string> | undefined;
    if (files && Object.keys(files).length > 0) {
      fileRefs = {};
      for (const [fieldId, filePath] of Object.entries(files)) {
        const stat = await fs.stat(filePath).catch(() => null);
        if (!stat || !stat.isFile()) {
          throw new Error(`File not found: ${filePath}`);
        }
        const buffer = await fs.readFile(filePath);
        const fileName = path.basename(filePath);
        const mimeType = guessMimeType(fileName);
        fileRefs[fieldId] = await ops.uploadFile(
          page_id, fieldId, { buffer, fileName, mimeType }
        );
      }
    }

    // Step 4: Submit
    const body = {
      source: 'agent' as const,
      data,
      ...(fileRefs ? { file_refs: fileRefs } : {}),
    };
    const result = await ops.submitForm(page_id, body);

    if (result.kind === 'not_found') {
      throw new Error(`Page ${page_id} expired between validation and submit.`);
    }
    if (result.kind === 'conflict') {
      throw new Error(
        `Page ${page_id} was submitted by someone else between ` +
        `validation and submit. Create a new page.`
      );
    }
    if (result.kind === 'invalid_format') {
      throw new Error(`Page ${page_id} is ${result.format} (view-only).`);
    }
    if (result.kind === 'access_denied') {
      throw new Error(result.message);
    }
    if (result.kind === 'validation_failed') {
      // Server-side validation caught something the local check missed
      return {
        content: [{
          type: 'text',
          text: `Server validation failed for ${result.errors.length} field(s).`,
        }],
        structuredContent: {
          page_id,
          valid: false,
          errors: result.errors,
        },
      };
    }

    return {
      content: [{
        type: 'text',
        text: `Form submitted successfully.\n\n` +
              `submission_id: ${result.submission_id}\n` +
              `submitted_at: ${result.submitted_at}`,
      }],
      structuredContent: {
        submission_id: result.submission_id,
        page_id,
        submitted_at: result.submitted_at,
      },
    };
  },
);
```

---

## 10. Backward Compatibility

### Browser submissions: unchanged

The existing browser submission path is completely unaffected:

- The `resultBodySchema` union tries the agent branch first (requires
  `source: "agent"`), then falls back to the browser branch. Browser
  payloads never include `source: "agent"`, so they always match the
  second branch.

- The browser renderer (`apps/web/main.ts`) continues to POST the same
  A2UI client-action shape. No changes to the renderer.

- The `submitResultHandler` in `apps/api/app.ts` handles both branches
  after schema parsing. For browser submissions, behavior is identical
  to today.

### check_result: consumers see a different result shape

The only visible change for existing `check_result` consumers is that
`result` may now be an agent submission object (with `source: "agent"`)
instead of an A2UI client-action. Consumers that inspect `result.name`
or `result.context` need to check `result.source` first.

**Migration guidance for check_result consumers:**

```typescript
const outcome = await ops.checkResult(page_id);
if (outcome.result) {
  if (outcome.result.source === 'agent') {
    // Agent submission: data is in result.data
    const data = outcome.result.data;
    const submittedBy = outcome.result.submitted_by;
  } else {
    // Browser submission: A2UI client-action
    const context = outcome.result.context;
    const name = outcome.result.name;
  }
}
```

### Database: no schema changes

The `pages` table stores `result` as `jsonb`. Both the A2UI
client-action shape and the agent submission shape are valid JSON
objects. No migration is needed.

### MCP tool list: additive only

`submit_form` is a new tool alongside the existing three. No existing
tool signatures change. Clients that only use `show_ui`, `show_html`,
and `check_result` are unaffected.

---

## 11. Implementation Plan

### Phase 1: Core (no files, no auth)

_Ship first. Covers use cases 1, 2, 3 from motivation._

1. **Shared validation module** (`apps/api/validate-agent-data.ts`)
   - `extractComponentMap(spec)` function
   - `validateAgentData(data, componentMap)` function
   - `INPUT_COMPONENTS` set
   - Unit tests covering every component type

2. **Schema update** (`apps/api/schemas.ts`)
   - Add `agentResultBodySchema`
   - Update `resultBodySchema` to a union
   - Export types

3. **API handler update** (`apps/api/app.ts`)
   - `submitResultHandler` branches on parsed body shape
   - Agent branch: extract component map from stored spec, validate,
     store, transition state
   - Browser branch: unchanged
   - New 400 `validation_failed` error response

4. **MCP tool registration** (`apps/api/mcp/tools.ts`)
   - `submit_form` tool definition and description
   - `PageOps` extended with `getPage` and `submitForm`
   - Tool handler with fetch-validate-submit orchestration

5. **Stdio adapter** (`apps/mcp/server.ts`)
   - `restOps.getPage` implementation
   - `restOps.submitForm` implementation
   - No file handling yet

6. **In-process adapter** (`apps/api/mcp/http.ts`)
   - `buildInProcessOps` extended with `getPage` and `submitForm`

7. **Tests**
   - Unit: validation module (all component types, edge cases)
   - Integration: `POST /:id/result` with agent payload
   - Integration: `submit_form` MCP tool via in-process transport
   - Backward compat: browser submissions still work unchanged

### Phase 2: File handling

_Ships after the file upload feature lands._

1. **MCP tool update**: add `files` parameter handling
2. **PageOps**: add `uploadFile` method
3. **Stdio adapter**: file read + upload flow
4. **API handler**: validate `file_refs` against stored file IDs
5. **Tests**: file upload + submit integration

### Phase 3: Auth integration

_Ships in the same v2 batch as OAuth. Agent identity comes from OAuth
tokens._

1. **Token extraction**: server reads `email` from Bearer token
2. **`submitted_by` population**: set on agent submission result
3. **Access control**: private page email allowlist check
4. **Audit log**: record agent identity
5. **Tests**: auth + private page access scenarios

### File locations (new and modified)

| File | Change |
|------|--------|
| `apps/api/validate-agent-data.ts` | **New.** Shared validation module |
| `apps/api/schemas.ts` | Modified. Add agent result schema, update union |
| `apps/api/app.ts` | Modified. `submitResultHandler` branches on body shape |
| `apps/api/mcp/tools.ts` | Modified. Register `submit_form`, extend `PageOps` |
| `apps/mcp/server.ts` | Modified. Implement `restOps.getPage`, `submitForm` |
| `apps/api/mcp/http.ts` | Modified. Extend `buildInProcessOps` |
| `apps/api/validate-agent-data.test.ts` | **New.** Validation unit tests |
| `apps/api/app.test.ts` | Modified. Add agent submission test cases |
| `apps/api/mcp/tools.test.ts` | Modified. Add `submit_form` tool tests |

---

## Open questions

1. **Required fields.** A2UI does not have a standard `required`
   attribute on input components. Should `submit_form` treat all input
   fields as optional (lenient) or should it require agents to supply
   every input component (strict)? This spec takes the lenient approach:
   missing fields are not errors. The creating agent can encode
   "required" in the button action's context paths if needed.

2. **Value coercion scope.** Currently only TextField variant=number
   coerces strings to numbers. Should other coercions exist (e.g.,
   `"true"` -> `true` for CheckBox)? This spec keeps coercion minimal
   to avoid surprising behavior.

3. **Spec-less submission.** Should agents be allowed to submit
   arbitrary data without validation (skip the spec check)? This spec
   says no -- spec awareness is a feature, not overhead. An agent that
   wants to submit raw data can use the REST endpoint directly with a
   browser-style payload (no `source: "agent"`).

4. **Action name.** Browser submissions include `name` (the button
   event name, e.g., "submitted"). Agent submissions do not -- they
   submit data, not actions. Should the server synthesize a
   `name: "agent_submit"` on the stored result for consumers that
   switch on `result.name`? This spec stores the agent shape as-is and
   leaves discrimination to the consumer via `result.source`.
