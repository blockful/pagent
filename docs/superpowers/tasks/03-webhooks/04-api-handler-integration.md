# 04 -- API handler integration (POST /new and POST /:id/result)

## Description

Wire webhook config into the REST API handlers: accept `webhook_url`
and `webhook_secret` on page creation, and fire the webhook on
submission. After this task, webhooks work end-to-end for REST API
callers (MCP integration is task 05).

## Files to create/modify

- `apps/api/schemas.ts` -- modify
- `apps/api/app.ts` -- modify
- `apps/api/store.ts` -- modify
- `apps/api/app.test.ts` -- modify

## Changes

### `apps/api/schemas.ts`

Add webhook fields to `newPageBodySchema`. Extract a shared
`webhookFields` object and spread it into both union variants:

```ts
const webhookFields = {
  webhook_url: z.string().url().optional(),
  webhook_secret: z.string().min(16).max(256).optional(),
};
```

Add a `.refine()` on `webhook_url` to enforce HTTPS-only in production:
when `NODE_ENV === 'production'`, reject `http:` URLs.

### `apps/api/store.ts`

1. Update `createPage()` signature to accept optional `webhookUrl` and
   `webhookSecret` parameters (add an opts object or extend existing
   params).
2. Pass `webhookUrl` and `webhookSecret` to `db.insertPage()` on the
   `Page` object.
3. Similarly update `createHtmlPage()` to accept and pass through the
   webhook fields.

### `apps/api/app.ts`

1. **`newPageHandler`** -- after Zod parsing, extract `webhook_url` and
   `webhook_secret` from `result.data` and pass them to
   `store.createPage()` / `store.createHtmlPage()`. The response body
   remains `{ id, url, expires_at }` -- do NOT echo `webhook_url` back.

2. **`submitResultHandler`** -- after `db.submitPage()` returns
   `{ kind: 'ok' }`, check `outcome.webhookUrl`. If set, fire
   `deliverWebhook()` from `./webhook.ts` asynchronously
   (`void deliverWebhook(...)` -- fire-and-forget). Pass `pageId`,
   `submissionId`, `mode`, `webhookUrl`, `webhookSecret`, `result`,
   `submittedAt`, `submittedBy`, `files`, and `log`.

3. The webhook delivery MUST NOT block the HTTP response to the
   submitting user.

### `apps/api/app.test.ts`

Add integration tests (6 tests per spec section 9):

1. `POST /new` with `webhook_url` stores it -- assert `db.insertPage`
   receives the webhook URL.
2. `POST /new` rejects invalid `webhook_url` (`'not-a-url'`) -- 400.
3. `POST /new` rejects short `webhook_secret` (< 16 chars) -- 400.
4. `POST /new` without webhook fields works -- existing tests stay green.
5. `POST /:id/result` fires webhook when `webhookUrl` is set -- mock
   `deliverWebhook` module and assert it is called.
6. `POST /:id/result` does NOT fire webhook when `webhookUrl` is null --
   assert `deliverWebhook` is not called.

## Acceptance criteria

- [ ] `POST /new` accepts optional `webhook_url` (valid URL) and
      `webhook_secret` (16-256 chars) in the request body.
- [ ] `POST /new` rejects `http:` webhook URLs in production mode.
- [ ] `POST /new` stores both fields on the page row.
- [ ] `POST /new` response body is unchanged (`{ id, url, expires_at }`).
- [ ] `POST /:id/result` fires `deliverWebhook` asynchronously when
      `webhookUrl` is set on the page.
- [ ] `POST /:id/result` does not call `deliverWebhook` when
      `webhookUrl` is null.
- [ ] The webhook call does not block the 200 response to the user.
- [ ] All 6 new integration tests pass.
- [ ] All existing app.test.ts tests remain green.

## Dependencies

- **01** (db schema) -- `insertPage`, `submitPage`, `Page` type with
  webhook fields.
- **02** (delivery engine) -- `deliverWebhook` function imported by
  `app.ts`.
- **03** (metrics/env) -- `metrics.webhookDeliveries`, env schema for
  HTTPS enforcement.

## Relevant spec sections

- Section 4: API changes (POST /new, POST /:id/result, GET responses)
- Section 5: Webhook delivery logic (trigger point)
- Section 9: Testing strategy (integration tests)
