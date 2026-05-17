# 06 -- OpenAPI documentation

## Description

Update the OpenAPI spec to document the `webhook_url` and
`webhook_secret` fields on `POST /new`, the webhook delivery payload
shape, and the delivery headers. This is the final task -- it documents
the feature after all code is in place.

## Files to create/modify

- `docs/openapi.yaml` -- modify

## Changes

### `docs/openapi.yaml`

1. **`POST /new` request body** -- add `webhook_url` and
   `webhook_secret` as optional properties to both union variants
   (a2ui and html):
   - `webhook_url`: type `string`, format `uri`, description from spec
     section 3.
   - `webhook_secret`: type `string`, minLength 16, maxLength 256,
     description from spec section 3.

2. **Webhook payload schema** -- add a `WebhookPayload` schema in
   `components/schemas` documenting the POST body Pagent sends to the
   callback URL:
   - `event`: `page.submitted`
   - `page_id`: string
   - `submission_id`: string
   - `mode`: enum `single` | `public`
   - `result`: object (opaque)
   - `submitted_at`: string (ISO 8601)
   - `submitted_by`: string or null
   - `files`: array of `WebhookFileRef`

3. **`WebhookFileRef` schema** -- add under `components/schemas`:
   - `file_id`, `field_name`, `original_name`, `mime_type` (string)
   - `size_bytes` (integer)
   - `download_url` (string, format uri)

4. **Webhook delivery headers** -- add a description block under
   `POST /new` or a new `x-webhooks` section documenting the headers:
   `Content-Type`, `User-Agent`, `X-Pagent-Event`, `X-Pagent-Delivery`,
   `X-Pagent-Signature`.

5. **Note** that `GET /:id` and `GET /:id/result` responses are
   unchanged -- webhook config is not exposed.

## Acceptance criteria

- [ ] `POST /new` schema includes `webhook_url` and `webhook_secret` as
      optional properties.
- [ ] `WebhookPayload` and `WebhookFileRef` schemas are defined in
      `components/schemas`.
- [ ] Webhook delivery headers are documented.
- [ ] OpenAPI YAML validates (no syntax errors).
- [ ] The Scalar API reference page renders the new fields.

## Dependencies

- **05** (MCP tool integration) -- all code is complete; this documents
  the final API surface.

## Relevant spec sections

- Section 3: MCP tool parameter changes (parameter descriptions)
- Section 4: API changes (POST /new schema)
- Section 5: Webhook delivery logic (payload, headers)
- Section 12: File change summary (docs/openapi.yaml)
