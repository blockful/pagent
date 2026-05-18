# 06 — Frontend FileInput component & form submission integration

## Description

Create the `PagentFileInput` Lit web component for the browser renderer and integrate it into the form submission flow. The component renders a file input with drag-and-drop, client-side validation, immediate upload to `POST /:id/files`, and wires the resulting `file_id` into the action context on submit.

## Files to create/modify

- `apps/web/file-input.ts` — new file. `PagentFileInput` Lit component (`<pagent-file-input>`) with:
  - Properties: `accept`, `maxSizeMB` (number, default 10), `required` (boolean), `label`, `description`, `fieldName`.
  - State: `selectedFile`, `uploading`, `uploadProgress`, `uploadedFileId`, `error`.
  - Renders: label (with required indicator), dropzone with `<input type="file">`, file preview (name, size, uploaded badge, remove button), progress bar during upload, error message, description text.
  - Event handlers: `onFileSelected` (from input change), `onDrop`/`onDragOver` (drag-and-drop), `removeFile` (clear selection).
  - Client-side validation: check file size against `maxSizeMB`, check extension/type against `accept`. Show inline error without uploading if invalid.
  - Upload: on valid file selection, POST to `/${pageId}/files` as `multipart/form-data` with `field_name` and `file` parts. Store returned `file_id` in `uploadedFileId`.
  - Styles: shadcn-aligned, consistent with existing Pagent component styling.
- `apps/web/main.ts` — update the A2UI component rendering logic:
  - Import `./file-input.ts`.
  - When encountering a component with `component: "FileInput"` in the surface tree, render `<pagent-file-input>` with the component's props mapped to element attributes.
  - Update the action/submit handler (the `MessageProcessor` callback): before POSTing to `/:id/result`, scan the action's `context` for keys whose corresponding component is a `FileInput`. Replace each value with `{ "__file_id": fileId }` from the component's `uploadedFileId`. If a required `FileInput` has no `uploadedFileId`, block submission and show a validation error.

## Acceptance criteria

- `<pagent-file-input>` is registered as a custom element.
- File picker opens on click and accepts files matching `accept` attribute.
- Drag-and-drop onto the dropzone selects the file.
- Client-side validation rejects files exceeding `maxSizeMB` with an inline error.
- Client-side validation rejects files not matching `accept` with an inline error.
- Valid file selection triggers immediate upload to `POST /${pageId}/files`.
- Upload progress is visible during upload.
- After successful upload, an "Uploaded" badge and remove button are shown.
- Remove button clears the selected file and `uploadedFileId`.
- On form submission, `__file_id` references are injected into the action context.
- Submission is blocked if a required file field has no uploaded file.
- Component styling is consistent with existing Pagent/shadcn patterns.
- No new npm dependencies added to `apps/web`.

## Dependencies

- Task 03 (`POST /:id/files` endpoint must exist for the upload to succeed)

## Relevant spec sections

- Section 5 (A2UI spec extension) — 5.1 FileInputComponent schema, 5.2 spec example
- Section 6 (Frontend renderer changes) — 6.1 FileInput component, 6.2 upload flow, 6.3 form submission integration, 6.4 alternative discussion
