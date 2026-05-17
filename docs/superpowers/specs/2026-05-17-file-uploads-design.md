# File Uploads — Design

Status: draft, awaiting user review (2026-05-17).

## 1. Overview and motivation

Pagent pages today accept structured input (A2UI forms) and display
rich content (HTML). Neither path lets a user attach a file — a resume
PDF, an invoice screenshot, a CSV data dump — and hand it back to the
agent.

This spec adds file upload support to A2UI forms. A new field type
`file` lets spec authors declare file inputs with accept filters, size
caps, and required/optional semantics. The user picks files in the
browser; the renderer uploads them to Supabase Storage; the agent
receives file metadata (and download URLs) alongside the form result.

Three submission paths are supported:

| Caller         | How files arrive                                                    |
| -------------- | ------------------------------------------------------------------- |
| Browser user   | `<input type="file">` in the renderer, multipart upload to the API  |
| MCP agent      | `submit_form` passes local file paths; the MCP server reads + uploads |
| REST agent     | Two-step: `POST /:id/files` (upload) then `POST /:id/result` (submit with file_id refs) |

Files share the page's TTL — when the page expires and the background
sweep deletes it, the sweep also removes all associated files from
Supabase Storage. No files outlive their page.

### Non-goals

- **File uploads on HTML pages.** HTML pages are view-only. They never
  produce a result, so there is no submission pipeline to attach files
  to. If a future format needs file uploads, it must define its own
  result semantics.
- **Direct download from the browser.** The renderer does not need to
  download uploaded files — only the agent reads them via signed URLs in
  `GET /:id/result`. If a future requirement adds user-visible file
  previews, that is a separate spec.
- **Virus/malware scanning.** V1 stores files as opaque blobs. The agent
  is responsible for what it does with them. If abuse becomes a signal,
  add ClamAV or a cloud scanning step in a follow-up.
- **Multi-page file references.** Files are scoped to a single page.
  There is no mechanism to reference a file uploaded to page A in
  page B's result.
- **Resumable uploads.** The 10 MB cap is small enough that retry-on-
  failure is adequate. tus/resumable-upload is out of scope.

---

## 2. Database schema

A new `files` table tracks uploaded files. Each row maps a file to the
page and field that owns it. The `uploaded_by` column is nullable —
browser submissions are anonymous; future auth will populate it.

```sql
-- Migration: add files table
CREATE TABLE IF NOT EXISTS files (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id       text        NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  field_name    text        NOT NULL,
  storage_path  text        NOT NULL,
  original_name text        NOT NULL,
  mime_type     text        NOT NULL,
  size_bytes    integer     NOT NULL CHECK (size_bytes > 0),
  uploaded_by   uuid,       -- nullable; reserved for future auth
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS files_page_id_idx ON files (page_id);
```

### Design notes

- **ON DELETE CASCADE**: when `deleteExpiredPages` deletes a `pages` row,
  Postgres cascades to `files` automatically. The sweep still needs to
  delete the blobs from Supabase Storage before deleting the DB rows
  (see section 9).
- **`size_bytes` is integer** (max ~2 GB), not bigint. The enforced
  per-file cap is 10 MB, so integer is sufficient and avoids JS
  BigInt friction.
- **No unique constraint on `(page_id, field_name)`**: a single field
  may accept multiple files in a future extension. V1 enforces
  single-file-per-field at the API validation layer, not the schema.
- **`storage_path`** is the full Supabase Storage object path within the
  `page-files` bucket (e.g., `abc123/resume/7f3a...b2c1.pdf`).

### db.ts additions

```typescript
export type FileRow = {
  id: string;
  page_id: string;
  field_name: string;
  storage_path: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_by: string | null;
  created_at: Date;
};

export async function insertFile(f: Omit<FileRow, 'created_at'>): Promise<FileRow> {
  return withRetry(async () => {
    const c = client();
    const rows = await c<FileRow[]>`
      INSERT INTO files (id, page_id, field_name, storage_path, original_name, mime_type, size_bytes, uploaded_by)
      VALUES (${f.id}, ${f.page_id}, ${f.field_name}, ${f.storage_path}, ${f.original_name}, ${f.mime_type}, ${f.size_bytes}, ${f.uploaded_by})
      RETURNING *
    `;
    return rows[0]!;
  });
}

export async function getFilesByPageId(pageId: string): Promise<FileRow[]> {
  return withRetry(async () => {
    const c = client();
    return c<FileRow[]>`
      SELECT * FROM files WHERE page_id = ${pageId} ORDER BY created_at
    `;
  });
}

export async function getFileById(id: string): Promise<FileRow | null> {
  return withRetry(async () => {
    const c = client();
    const rows = await c<FileRow[]>`SELECT * FROM files WHERE id = ${id}`;
    return rows[0] ?? null;
  });
}

/**
 * Returns storage_paths for all files belonging to pages that have expired.
 * Called by the sweep before deleting the DB rows (CASCADE handles the row
 * deletion, but blobs must be removed from storage explicitly).
 */
export async function getExpiredFilesPaths(): Promise<string[]> {
  return withRetry(async () => {
    const c = client();
    const rows = await c<{ storage_path: string }[]>`
      SELECT f.storage_path
      FROM files f
      JOIN pages p ON f.page_id = p.id
      WHERE p.expires_at <= now()
    `;
    return rows.map((r) => r.storage_path);
  });
}
```

The `init()` function in `db.ts` gains the `CREATE TABLE IF NOT EXISTS
files` migration (and the index), executed after the `pages` table
migration, identical to how the `format` column migration runs today.

---

## 3. API endpoints

### 3.1. `POST /:id/files` — Upload a file

Uploads a single file for a specific page and field. The page must be
in state `open` and must have a `file` field in its spec matching the
provided `field_name`.

**Request:**

```
POST /:id/files
Content-Type: multipart/form-data

Parts:
  field_name: "resume"          (text part — the A2UI field name)
  file: <binary file content>   (file part)
```

**Success response (201):**

```json
{
  "file_id": "7f3a0b1c-...-b2c1",
  "field_name": "resume",
  "original_name": "my-resume.pdf",
  "mime_type": "application/pdf",
  "size_bytes": 245760
}
```

**Error responses:**

| Status | Error code              | When                                                                 |
| ------ | ----------------------- | -------------------------------------------------------------------- |
| 400    | `bad_request`           | Missing `field_name` or `file` part; `field_name` not in page spec   |
| 400    | `invalid_field_type`    | The named field exists but is not `type: "file"`                     |
| 400    | `invalid_for_format`    | Page format is `html` (view-only, no uploads)                        |
| 400    | `file_too_large`        | File exceeds the field's `maxSizeMB` (or the global 10 MB default)   |
| 400    | `invalid_mime_type`     | File MIME type does not match the field's `accept` filter             |
| 400    | `file_already_uploaded` | A file was already uploaded for this field (V1: one file per field)   |
| 404    | `not_found`             | Page not found or expired                                            |
| 409    | `conflict`              | Page already submitted (state is not `open`)                         |
| 413    | `payload_too_large`     | Wire body exceeds the multipart body limit (11 MB, see below)        |
| 429    | `rate_limited`          | Per-IP rate limit exceeded                                           |
| 500    | `internal_error`        | Storage or database failure                                          |

**Body limit:** The `bodyLimit` middleware for this route is set to
11 MB (10 MB file + 1 MB overhead for multipart boundaries and the
`field_name` text part). This is separate from the existing 1 MB cap
on `POST /new`.

**Validation sequence:**

1. Parse page ID from path; 404 if invalid or expired.
2. Verify page format is `a2ui`; 400 `invalid_for_format` if `html`.
3. Verify page state is `open`; 409 if already submitted.
4. Parse multipart body; extract `field_name` text part and `file` part.
5. Look up `field_name` in the page spec's component tree.
6. Verify the component is `type: "file"`; 400 `invalid_field_type` if not.
7. Check no file already exists for `(page_id, field_name)` in the
   `files` table; 400 `file_already_uploaded` if so.
8. Validate file size against `maxSizeMB` from the field spec (default 10).
9. Validate MIME type against the field's `accept` list (if specified).
10. Upload to Supabase Storage at `{page_id}/{field_name}/{uuid}.{ext}`.
11. Insert row into `files` table.
12. Return 201 with file metadata.

### 3.2. `POST /:id/result` — Submit with file references (updated)

The existing `POST /:id/result` endpoint is updated to accept two
content types:

1. **`application/json`** (existing) — Body is an A2UI action object.
   If the page spec has `file` fields, the `context` object may contain
   `file_id` references:

   ```json
   {
     "name": "submitted",
     "surfaceId": "main",
     "sourceComponentId": "submit-btn",
     "context": {
       "resume": { "__file_id": "7f3a0b1c-...-b2c1" },
       "cover_letter": "I am excited to apply..."
     }
   }
   ```

   The server validates that each `__file_id` reference points to a
   file that exists in the `files` table and belongs to this page.

2. **`multipart/form-data`** (new) — For browser submissions where the
   file is uploaded inline with the form result. The renderer uses this
   path. Parts:

   - `action`: JSON-encoded A2UI action (text part)
   - `{field_name}`: file binary (file part, one per file field)

   The server uploads each file part to Supabase Storage, inserts rows
   into the `files` table, and rewrites the action's context to include
   `__file_id` references before storing the result.

**Validation additions:**

- For each file field in the page spec marked `required: true`, the
  submission must include either an inline file or a valid `__file_id`
  reference. If missing, return 400 `missing_required_file`.
- For each `__file_id` reference, verify the file belongs to this page.
  If not, return 400 `invalid_file_reference`.

### 3.3. `GET /:id/result` — Result with download URLs (updated)

When the result contains file references, the response replaces
`__file_id` values with download metadata including a signed URL:

```json
{
  "state": "submitted",
  "format": "a2ui",
  "result": {
    "name": "submitted",
    "surfaceId": "main",
    "context": {
      "resume": {
        "file_id": "7f3a0b1c-...-b2c1",
        "original_name": "my-resume.pdf",
        "mime_type": "application/pdf",
        "size_bytes": 245760,
        "download_url": "https://xyz.supabase.co/storage/v1/object/sign/page-files/abc123/resume/7f3a...pdf?token=..."
      },
      "cover_letter": "I am excited to apply..."
    }
  }
}
```

The signed URL is generated on-the-fly with a short expiry (60 minutes,
matching the remaining page TTL or a floor of 5 minutes, whichever is
greater). The agent must download the file within that window.

**Implementation in `store.ts`:**

A new `hydrateFileUrls(result, pageId)` function:
1. Walks the result's `context` object.
2. For each value that is an object with a `__file_id` key, looks up the
   file in the `files` table.
3. Generates a Supabase Storage signed URL via `storage.from('page-files')
   .createSignedUrl(path, expirySeconds)`.
4. Replaces the `__file_id` object with the full file metadata object
   (including `download_url`).

This function is called in `advanceResult()` before returning the result.

---

## 4. Supabase Storage integration

### 4.1. Bucket configuration

Create a `page-files` bucket in Supabase Storage:

```sql
-- Run once via Supabase dashboard or migration
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'page-files',
  'page-files',
  false,                          -- private bucket; access via signed URLs only
  10485760,                       -- 10 MB per file
  NULL                            -- MIME filtering done at app layer, not bucket layer
);
```

The bucket is **private** — no anonymous access. All reads go through
signed URLs generated by the API server using the service role key.

### 4.2. Path structure

```
page-files/
  {page_id}/
    {field_name}/
      {uuid}.{ext}
```

Example: `page-files/c0f2ec161aac8b1a8d26222f45ca812d/resume/7f3a0b1c-d4e5-4f6a-b7c8-9d0e1f2a3b4c.pdf`

- **page_id** groups all files for one page, making bulk deletion easy.
- **field_name** disambiguates when a form has multiple file fields.
- **uuid.ext** prevents name collisions and preserves the original
  extension for MIME-type hinting by download clients.

### 4.3. Signed URLs

Generated via the Supabase JS client:

```typescript
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function createSignedUrl(storagePath: string, expirySeconds: number): Promise<string> {
  const { data, error } = await supabase.storage
    .from('page-files')
    .createSignedUrl(storagePath, expirySeconds);
  if (error) throw new Error(`Failed to create signed URL: ${error.message}`);
  return data.signedUrl;
}
```

Signed URL expiry is calculated as:

```typescript
const remainingTtlSeconds = Math.floor((page.expiresAt - Date.now()) / 1000);
const expirySeconds = Math.max(remainingTtlSeconds, 300); // floor: 5 minutes
```

### 4.4. Upload

```typescript
async function uploadFile(
  storagePath: string,
  fileBuffer: Buffer,
  mimeType: string,
): Promise<void> {
  const { error } = await supabase.storage
    .from('page-files')
    .upload(storagePath, fileBuffer, {
      contentType: mimeType,
      upsert: false,  // fail if path already exists (defensive)
    });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
}
```

### 4.5. Bulk deletion

```typescript
async function deletePageFiles(pageId: string): Promise<void> {
  const { data: files, error: listError } = await supabase.storage
    .from('page-files')
    .list(pageId, { limit: 1000 });

  if (listError) throw new Error(`Storage list failed: ${listError.message}`);
  if (!files || files.length === 0) return;

  // Supabase Storage .remove() accepts up to 1000 paths per call.
  // For V1 with single-file-per-field, a page will have at most ~10 files.
  // Collect all paths recursively (field_name subdirectories).
  const paths = await collectAllPaths(pageId);
  if (paths.length === 0) return;

  const { error: removeError } = await supabase.storage
    .from('page-files')
    .remove(paths);

  if (removeError) throw new Error(`Storage remove failed: ${removeError.message}`);
}
```

A simpler approach since Supabase Storage does not support recursive
directory deletion natively: use the `files` DB table to look up
`storage_path` values before the CASCADE delete runs.

### 4.6. CORS

Supabase Storage buckets inherit the project-level CORS configuration.
Ensure the Supabase project CORS settings include the renderer origin:

```json
{
  "allowedOrigins": ["https://pagent.link", "http://localhost:5173"],
  "allowedMethods": ["GET", "POST", "PUT", "DELETE"],
  "allowedHeaders": ["*"],
  "maxAge": 3600
}
```

This is configured in the Supabase dashboard under Storage > Settings.
The API server (not the browser) performs all uploads and signed-URL
generation, so browser CORS is only needed if the renderer ever uploads
directly. V1 proxies everything through the API, so CORS on Storage is
a defense-in-depth setting rather than a functional requirement.

---

## 5. A2UI spec extension — file field type

### 5.1. Field schema

A new component type `FileInput` is added to the A2UI spec vocabulary.
It is not part of the upstream basic catalog — it is a Pagent-specific
extension recognized by the Pagent renderer.

```typescript
type FileInputComponent = {
  id: string;
  component: 'FileInput';
  /** Comma-separated list of accepted file extensions or MIME types.
   *  Maps directly to the HTML <input type="file" accept="..."> attribute.
   *  Examples: ".pdf,.png,.jpg", "image/*", "application/pdf" */
  accept?: string;
  /** Maximum file size in megabytes. Default: 10. Max: 10. */
  maxSizeMB?: number;
  /** Whether a file is required for form submission. Default: false. */
  required?: boolean;
  /** Human-readable label displayed above the file input. */
  label?: string;
  /** Help text displayed below the file input. */
  description?: string;
};
```

### 5.2. Spec example

```json
[
  {
    "createSurface": {
      "surfaceId": "main",
      "catalogId": "https://a2ui.org/specification/v0_9/basic_catalog.json"
    }
  },
  {
    "updateComponents": {
      "surfaceId": "main",
      "components": [
        {
          "id": "root",
          "component": "Column",
          "children": ["title", "resume-upload", "submit-btn"]
        },
        {
          "id": "title",
          "component": "Text",
          "text": "Upload your resume",
          "variant": "h2"
        },
        {
          "id": "resume-upload",
          "component": "FileInput",
          "accept": ".pdf,.doc,.docx",
          "maxSizeMB": 5,
          "required": true,
          "label": "Resume",
          "description": "PDF or Word document, up to 5 MB"
        },
        {
          "id": "submit-btn",
          "component": "Button",
          "child": "submit-btn-txt",
          "variant": "primary",
          "action": {
            "event": {
              "name": "submitted",
              "context": {
                "resume": { "path": "/resume-upload" }
              }
            }
          }
        },
        {
          "id": "submit-btn-txt",
          "component": "Text",
          "text": "Submit"
        }
      ]
    }
  }
]
```

### 5.3. Validation in the API

When `POST /:id/files` receives a file, the API must locate the
`FileInput` component in the page's stored spec to read its constraints.
This requires a lightweight spec walker:

```typescript
function findFileComponent(
  spec: unknown,
  fieldName: string,
): FileInputComponent | null {
  // Walk the updateComponents messages looking for a component
  // with id === fieldName and component === 'FileInput'.
  if (!Array.isArray(spec)) return null;
  for (const msg of spec) {
    const uc = (msg as Record<string, unknown>)?.updateComponents;
    if (!uc || typeof uc !== 'object') continue;
    const components = (uc as Record<string, unknown>).components;
    if (!Array.isArray(components)) continue;
    for (const comp of components) {
      if (
        comp &&
        typeof comp === 'object' &&
        (comp as Record<string, unknown>).id === fieldName &&
        (comp as Record<string, unknown>).component === 'FileInput'
      ) {
        return comp as FileInputComponent;
      }
    }
  }
  return null;
}
```

---

## 6. Frontend renderer changes

### 6.1. FileInput component

The renderer (`apps/web/main.ts`) gains a new Lit component that
renders when it encounters a `FileInput` component type in the A2UI
surface tree. Since `FileInput` is not in the upstream basic catalog,
the renderer handles it as a Pagent-specific override.

**New file: `apps/web/file-input.ts`**

```typescript
import { LitElement, html, css } from 'lit';
import { property, state } from 'lit/decorators.js';

export class PagentFileInput extends LitElement {
  @property() accept = '';
  @property({ type: Number }) maxSizeMB = 10;
  @property({ type: Boolean }) required = false;
  @property() label = '';
  @property() description = '';
  @property() fieldName = '';

  @state() private selectedFile: File | null = null;
  @state() private uploading = false;
  @state() private uploadProgress = 0;
  @state() private uploadedFileId: string | null = null;
  @state() private error: string | null = null;

  static styles = css`
    :host { display: block; }
    /* ... shadcn-aligned styles ... */
  `;

  render() {
    return html`
      ${this.label ? html`<label>${this.label}${this.required ? html`<span class="required">*</span>` : ''}</label>` : ''}
      <div class="dropzone" @dragover=${this.onDragOver} @drop=${this.onDrop}>
        <input type="file"
          accept=${this.accept}
          @change=${this.onFileSelected}
          ?required=${this.required}
        />
        ${this.selectedFile ? this.renderFilePreview() : this.renderPlaceholder()}
      </div>
      ${this.uploading ? html`<progress value=${this.uploadProgress} max="100"></progress>` : ''}
      ${this.error ? html`<div class="error">${this.error}</div>` : ''}
      ${this.description ? html`<p class="description">${this.description}</p>` : ''}
    `;
  }

  private renderPlaceholder() {
    return html`<p>Drag a file here or click to select</p>`;
  }

  private renderFilePreview() {
    const f = this.selectedFile!;
    const sizeKB = (f.size / 1024).toFixed(1);
    return html`
      <div class="file-preview">
        <span class="file-name">${f.name}</span>
        <span class="file-size">${sizeKB} KB</span>
        ${this.uploadedFileId
          ? html`<span class="uploaded-badge">Uploaded</span>`
          : ''}
        <button class="remove" @click=${this.removeFile}>Remove</button>
      </div>
    `;
  }

  // ... event handlers: onFileSelected, onDrop, onDragOver, removeFile, upload
}

customElements.define('pagent-file-input', PagentFileInput);
```

### 6.2. Upload flow

When the user selects a file:

1. **Client-side validation**: Check file size against `maxSizeMB` and
   file extension/type against `accept`. Show an inline error if
   invalid. Do not upload.
2. **Immediate upload**: On valid selection, upload the file to
   `POST /${pageId}/files` with `field_name` in the multipart body.
   Show a progress bar.
3. **Store file_id**: On success, store the returned `file_id` in the
   component state. The submit button's action context will reference
   it.

### 6.3. Form submission integration

The existing action handler in `main.ts` (the `MessageProcessor`
callback) is updated:

- Before POSTing to `/:id/result`, scan the action's `context` for
  any keys whose corresponding component is a `FileInput`.
- For each such key, replace the value with `{ "__file_id": fileId }`
  where `fileId` came from the upload step.
- If a `FileInput` with `required: true` has no `uploadedFileId`, block
  submission and show a validation error.

### 6.4. Alternative: inline multipart submission

Instead of pre-uploading via `POST /:id/files`, the renderer could
submit everything in one `multipart/form-data` POST to `/:id/result`.
This is simpler for the renderer but means the user sees no upload
progress until they hit Submit. The pre-upload approach (6.2) is
preferred because:

- Upload progress is shown immediately on file selection.
- If the upload fails, the user can retry before submitting.
- The submit action stays a fast JSON POST.

Both paths are supported by the API (section 3.2), but the renderer
uses the pre-upload path by default.

---

## 7. MCP tool changes

### 7.1. `show_ui` — no changes

The `show_ui` tool already accepts arbitrary A2UI specs. A spec
containing `FileInput` components works without tool changes — the
renderer handles them.

### 7.2. `submit_form` — file path support (stdio MCP only)

The stdio MCP server (`apps/mcp/server.ts`) gains awareness of file
fields. When the agent calls `submit_form` (a hypothetical future tool)
or when the agent builds a result with file paths, the MCP server:

1. Reads the file from the local filesystem via `fs.readFile(path)`.
2. Uploads it to `POST /${pageId}/files` with the appropriate
   `field_name`.
3. Receives the `file_id`.
4. Includes `{ "__file_id": fileId }` in the result context.
5. Submits the result via `POST /${pageId}/result`.

This is a convenience for agents that run locally alongside the MCP
server. Agents using the HTTP MCP transport or the REST API must use
the two-step upload flow directly.

### 7.3. Tool description updates

The `SHOW_UI_DESCRIPTION` and `SHOW_UI_INPUT_DESCRIPTION` strings in
`apps/api/mcp/tools.ts` are updated to mention the `FileInput`
component type:

```
The basic catalog provides Column, Row, Card, Text, TextField, Button,
Checkbox, Image, Divider, List, Tabs, Slider. Additionally, Pagent
supports a FileInput component for file uploads:
  { id: "upload", component: "FileInput", accept: ".pdf,.png", maxSizeMB: 5, required: true, label: "Upload file" }
```

### 7.4. `check_result` — no changes

The `check_result` tool returns the result as-is. File fields in the
result will contain the hydrated file metadata (with `download_url`)
from section 3.3. The agent reads the `download_url` and fetches the
file via a standard HTTP GET.

---

## 8. File validation

### 8.1. MIME type checking

MIME type validation happens at two levels:

1. **Extension-based (client-side)**: The `<input type="file" accept>`
   attribute filters the file picker. This is a UX convenience, not a
   security boundary.

2. **Content-based (server-side)**: The API inspects the file's actual
   content to determine the MIME type, rather than trusting the
   `Content-Type` header from the multipart upload. Use the `file-type`
   npm package for magic-number-based detection:

   ```typescript
   import { fileTypeFromBuffer } from 'file-type';

   async function detectMimeType(buffer: Buffer): Promise<string> {
     const detected = await fileTypeFromBuffer(buffer);
     return detected?.mime ?? 'application/octet-stream';
   }
   ```

   If the field spec has an `accept` list, the server validates the
   detected MIME type against it. The matching logic handles:

   - Exact MIME types: `application/pdf` matches `application/pdf`.
   - Wildcard MIME types: `image/*` matches `image/png`, `image/jpeg`,
     etc.
   - Extensions: `.pdf` maps to `application/pdf` via a lookup table.

### 8.2. Size limits

| Limit              | Value    | Enforced by                                 |
| ------------------ | -------- | ------------------------------------------- |
| Per-file default   | 10 MB    | API validation + Supabase bucket config     |
| Per-file custom    | ≤ 10 MB  | `maxSizeMB` in the `FileInput` spec         |
| Multipart body cap | 11 MB    | `bodyLimit` middleware on `POST /:id/files`  |
| Supabase bucket    | 10 MB    | `file_size_limit` on `page-files` bucket    |

The `maxSizeMB` field in the spec must be between 0 (exclusive) and 10
(inclusive). Values above 10 are clamped to 10 at validation time with
a warning log.

### 8.3. Malware considerations

V1 does not scan uploaded files for malware. Mitigations:

- Files are stored in a private Supabase Storage bucket. No public URLs
  exist. Access requires a signed URL generated by the API.
- Signed URLs are short-lived (capped to page TTL).
- Files are auto-deleted when the page expires (default 30 minutes).
- The `Content-Disposition: attachment` header is set on signed URLs to
  prevent in-browser rendering of uploaded files.

Future consideration: integrate ClamAV via a sidecar container or use
Supabase's built-in virus scanning if it becomes available.

### 8.4. Filename sanitization

The `original_name` stored in the database is sanitized:

- Strip path separators (`/`, `\`) — prevent directory traversal.
- Limit to 255 characters.
- Remove null bytes.
- Preserve the original extension for display purposes.

The actual storage path uses a UUID, so the original filename is purely
metadata — it never appears in a filesystem path.

---

## 9. Cleanup logic — TTL-based deletion

### 9.1. Updated sweep in `server.ts`

The existing `deleteExpiredPages` sweep (60s interval in `server.ts`) is
extended:

```typescript
const sweepTimer = setInterval(async () => {
  try {
    // Step 1: Collect storage paths for files belonging to expired pages.
    const expiredPaths = await db.getExpiredFilesPaths();

    // Step 2: Delete blobs from Supabase Storage (before CASCADE deletes DB rows).
    if (expiredPaths.length > 0) {
      await storage.deleteFiles(expiredPaths);
      logger.debug({ count: expiredPaths.length }, 'ttl sweep removed expired file blobs');
    }

    // Step 3: Delete expired page rows (CASCADE removes file rows too).
    const { total, abandoned } = await db.deleteExpiredPages();
    if (abandoned > 0) metrics.pagesAbandoned.add(abandoned);
    if (total > 0) logger.debug({ total, abandoned }, 'ttl sweep removed expired pages');
  } catch (err) {
    logger.error({ err }, 'ttl sweep failed');
  }
}, 60_000);
```

### 9.2. Storage deletion helper

```typescript
// apps/api/storage.ts

import { createClient } from '@supabase/supabase-js';
import { env } from './schemas.ts';

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

/**
 * Delete files from the page-files bucket. Supabase Storage .remove()
 * accepts up to 1000 paths per call. Batch if needed.
 */
export async function deleteFiles(paths: string[]): Promise<void> {
  const BATCH_SIZE = 1000;
  for (let i = 0; i < paths.length; i += BATCH_SIZE) {
    const batch = paths.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.storage
      .from('page-files')
      .remove(batch);
    if (error) {
      // Log but don't throw — orphaned blobs are less harmful than
      // failing the entire sweep. Supabase lifecycle policies can
      // clean them up later.
      console.error(`Storage delete batch failed: ${error.message}`);
    }
  }
}

export async function uploadFile(
  storagePath: string,
  fileBuffer: Buffer,
  mimeType: string,
): Promise<void> {
  const { error } = await supabase.storage
    .from('page-files')
    .upload(storagePath, fileBuffer, {
      contentType: mimeType,
      upsert: false,
    });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
}

export async function createSignedUrl(
  storagePath: string,
  expirySeconds: number,
): Promise<string> {
  const { data, error } = await supabase.storage
    .from('page-files')
    .createSignedUrl(storagePath, expirySeconds);
  if (error) throw new Error(`Failed to create signed URL: ${error.message}`);
  return data.signedUrl;
}
```

### 9.3. Orphan protection

If the storage delete fails but the DB delete succeeds (CASCADE), the
blobs become orphans. Mitigations:

- **Log the failure**: the sweep logs storage errors so operators see
  them in Grafana.
- **Supabase lifecycle policy**: configure the `page-files` bucket with
  a lifecycle rule that auto-deletes objects older than 24 hours. This
  catches orphans that the sweep missed.
- **Metric**: add `pagent.files.orphaned` counter, incremented when a
  storage delete batch fails.

### 9.4. Ordering guarantee

The sweep MUST delete storage blobs BEFORE deleting DB rows. If it
deleted DB rows first, the CASCADE would remove `files` records and
the sweep would lose the `storage_path` values needed to clean up
blobs. The sequence is:

1. Query `getExpiredFilesPaths()` — reads paths from `files` JOIN
   `pages` WHERE `expires_at <= now()`.
2. Delete blobs from Supabase Storage.
3. Delete expired `pages` rows (CASCADE deletes `files` rows).

---

## 10. Environment variables

New variables added to `apps/api/schemas.ts` `envSchema`:

| Variable                       | Required | Default | Description                                    |
| ------------------------------ | -------- | ------- | ---------------------------------------------- |
| `SUPABASE_URL`                 | Yes      | —       | Supabase project URL (e.g., `https://xyz.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY`    | Yes      | —       | Supabase service role key (secret, not anon)   |
| `FILE_MAX_SIZE_MB`             | No       | `10`    | Global per-file size cap in MB                 |

```typescript
// Addition to envSchema in schemas.ts
SUPABASE_URL: z.string().url(),
SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
FILE_MAX_SIZE_MB: z.coerce.number().int().positive().max(50).default(10),
```

The `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are required in all
environments (dev, production). In development, they point to a local
Supabase instance or a dev project.

### Railway environment

Add both variables to the Railway service environment. The service role
key must be added as a secret (not a shared variable).

### Local development

Add to `apps/api/.env`:

```
SUPABASE_URL=http://localhost:54321
SUPABASE_SERVICE_ROLE_KEY=<local-supabase-service-role-key>
```

---

## 11. Dependencies

### 11.1. `apps/api` — new dependencies

```bash
npm install -w @pagent/api @supabase/supabase-js file-type
```

| Package              | Version  | Purpose                                              |
| -------------------- | -------- | ---------------------------------------------------- |
| `@supabase/supabase-js` | `^2.49`  | Supabase Storage client (upload, signed URLs, delete) |
| `file-type`          | `^19.6`  | Magic-number MIME type detection from file buffers    |

### 11.2. `apps/web` — no new dependencies

The `FileInput` Lit component uses only `lit` (already a dependency).
No additional npm packages are needed for the renderer.

### 11.3. `apps/mcp` — no new dependencies

The stdio MCP server uses `node:fs` (built-in) for reading local files
and the existing `fetch` API for uploading them to the API. No new
packages needed.

### 11.4. Hono multipart parsing

Hono has built-in multipart/form-data support via `c.req.parseBody()`.
No additional package is needed. For the `POST /:id/files` route, the
handler uses:

```typescript
const body = await c.req.parseBody({ all: true });
const fieldName = body['field_name'];  // string
const file = body['file'];            // File object
```

The `bodyLimit` middleware for this specific route is set to 11 MB:

```typescript
app.post(
  '/:id/files',
  bodyLimit({ maxSize: 11 * 1024 * 1024 }),
  uploadFileHandler,
);
```

---

## Appendix A: Migration checklist

1. [ ] Add `files` table migration to `db.ts` `init()`.
2. [ ] Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to `envSchema`.
3. [ ] Create `page-files` bucket in Supabase Storage.
4. [ ] Install `@supabase/supabase-js` and `file-type` in `apps/api`.
5. [ ] Create `apps/api/storage.ts` with upload/delete/signedUrl helpers.
6. [ ] Add `POST /:id/files` route to `app.ts`.
7. [ ] Update `POST /:id/result` to handle multipart and `__file_id` refs.
8. [ ] Update `GET /:id/result` to hydrate file URLs via `hydrateFileUrls`.
9. [ ] Update sweep in `server.ts` to delete storage blobs before DB rows.
10. [ ] Create `apps/web/file-input.ts` Lit component.
11. [ ] Update renderer action handler to include file references in context.
12. [ ] Update MCP tool descriptions to mention `FileInput`.
13. [ ] Add `FILE_MAX_SIZE_MB` to Railway environment.
14. [ ] Add metrics: `pagent.files.uploaded`, `pagent.files.orphaned`.
15. [ ] Update `docs/openapi.yaml` with new endpoint and updated schemas.
16. [ ] Write tests for file upload, validation, result hydration, and sweep.

## Appendix B: Metrics additions

```typescript
// In metrics.ts
filesUploaded: meter.createCounter('pagent.files.uploaded', {
  description: 'Files uploaded via POST /:id/files',
}),
filesOrphaned: meter.createCounter('pagent.files.orphaned', {
  description: 'File blobs that failed to delete from storage during sweep',
}),
fileUploadSize: meter.createHistogram('pagent.files.upload.size', {
  description: 'Size of uploaded files in bytes',
  unit: 'bytes',
}),
```

## Appendix C: Security model

| Layer        | What it does                                             |
| ------------ | -------------------------------------------------------- |
| Body limit   | 11 MB cap on multipart uploads (Hono middleware)         |
| MIME check   | Magic-number detection via `file-type`; reject mismatches |
| Bucket limit | 10 MB per file enforced by Supabase Storage config       |
| Private bucket | No public URLs; signed URLs only                       |
| Signed URL expiry | Capped to page TTL (min 5 min)                      |
| Content-Disposition | `attachment` — prevents in-browser rendering       |
| TTL sweep    | Files auto-deleted with their page (default 30 min)      |
| Path sanitization | UUID-based storage paths; original name is metadata only |
| Filename sanitization | Strip path separators, null bytes, cap at 255 chars |
