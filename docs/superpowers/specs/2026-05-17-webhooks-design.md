# Webhooks on Submit -- Design

Status: draft, awaiting user review (2026-05-17).

## 1. Overview and motivation

Today, agents discover that a user submitted a Pagent form by polling
`check_result` (MCP tool) or `GET /:id/result` (REST). Polling works
but wastes round-trips, adds latency proportional to the poll interval,
and scales poorly when an agent manages many concurrent pages.

Webhooks flip the model: the agent registers a callback URL at page
creation time, and Pagent pushes the submission payload to that URL the
moment the user submits. Polling via `check_result` continues to work
unchanged -- webhooks are strictly additive.

### Design principles

- **Per-page, not per-account.** Each `show_ui` call can specify its
  own `webhook_url` and `webhook_secret`. No global webhook
  configuration, no registration flow, no management UI. The agent
  already holds the page_id; the webhook config travels with it.
- **Fire-and-forget with best-effort retry.** Pagent retries on
  transient failures but does not guarantee delivery. The agent can
  always fall back to `check_result` for reliability.
- **HMAC signing.** When a `webhook_secret` is provided, every delivery
  carries an `X-Pagent-Signature` header so the receiver can verify
  authenticity. When no secret is set, the header is omitted.

### Non-goals

- **Dead-letter queue.** Failed deliveries after all retries are logged
  and discarded. A DLQ is a v3 concern.
- **Webhook management API.** No `GET /webhooks`, no `DELETE /webhooks`.
  The webhook is a property of the page, not a standalone resource.
- **Fanout / multiple URLs per page.** One URL per page. Multi-endpoint
  routing is the receiver's responsibility.
- **Webhook for page expiry.** Only `page.submitted` fires. Expiry
  events are a future consideration.
- **Mutual TLS or OAuth for delivery authentication.** HMAC is the
  sole verification mechanism in v2.

## 2. Database schema changes

The `pages` table gains two nullable columns. Both are added in
`apps/api/db.ts` `init()` using the same idempotent pattern as the
`format` column migration.

### New columns

```sql
ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS webhook_url    text,
  ADD COLUMN IF NOT EXISTS webhook_secret text;
```

### Updated CREATE TABLE (for fresh deployments)

```sql
CREATE TABLE IF NOT EXISTS pages (
  id             text primary key,
  spec           jsonb       not null,
  format         text        not null default 'a2ui'
                             check (format in ('a2ui','html')),
  state          text        not null
                             check (state in ('open','submitted','received')),
  result         jsonb,
  webhook_url    text,
  webhook_secret text,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  submitted_at   timestamptz,
  received_at    timestamptz
);
```

### TypeScript type changes

`apps/api/db.ts` -- the `Page` type grows two optional fields:

```ts
export type Page = {
  id: string;
  spec: unknown;
  format: PageFormat;
  state: PageState;
  result: unknown;
  createdAt: number;
  expiresAt: number;
  webhookUrl?: string | null;
  webhookSecret?: string | null;
};
```

`PageRow` (internal to db.ts) gains matching snake_case fields.

### Data access changes

- `insertPage`: writes `webhook_url` and `webhook_secret` when
  present. Both are nullable; omitting them stores NULL.
- `getActivePage`: selects the two new columns so the submit handler
  can read them.
- `submitPage`: return type `SubmitOutcome` for the `'ok'` variant
  grows `webhookUrl` and `webhookSecret` fields so the caller can
  fire the webhook without a follow-up query:

```ts
export type SubmitOutcome =
  | { kind: 'ok'; createdAt: Date; webhookUrl?: string | null;
      webhookSecret?: string | null; submissionId: string;
      mode: 'single' | 'public'; submittedBy?: string | null;
      files?: WebhookFileRef[] }
  | { kind: 'conflict' }
  | { kind: 'not_found' };
```

The `submitPage` UPDATE ... RETURNING clause adds `webhook_url,
webhook_secret` to the projection.

### Security: secret storage

`webhook_secret` is stored as plaintext in Postgres. This is acceptable
for v2 because:

1. The secret is agent-generated and per-page, not a long-lived
   credential. Single-mode pages expire in 30 minutes; public-mode
   pages default to 7 days.
2. The secret never leaves the API server -- it is used server-side to
   compute the HMAC and is never included in any response body or log.
3. Database access already requires the `DATABASE_URL` credential.

Future consideration: if page TTLs grow significantly, encrypt at rest
with a KMS-derived key.

## 3. MCP tool parameter changes

### `show_ui`

The input schema gains two optional string parameters:

```ts
server.registerTool('show_ui', {
  inputSchema: {
    spec: z.array(z.record(z.unknown())).describe(SHOW_UI_INPUT_DESCRIPTION),
    webhook_url: z.string().url().optional().describe(
      'Optional HTTPS callback URL. When set, Pagent POSTs the submission '
      + 'payload to this URL as soon as the user submits. The agent can '
      + 'still poll check_result -- webhooks are additive, not a replacement.'
    ),
    webhook_secret: z.string().min(16).max(256).optional().describe(
      'Optional shared secret for HMAC-SHA256 webhook signing. When set, '
      + 'every delivery carries an X-Pagent-Signature header: '
      + '"sha256=<hex-hmac>". The receiver MUST verify this signature to '
      + 'authenticate the payload. Minimum 16 characters.'
    ),
  },
  // ...
});
```

### `show_html`

`show_html` also gains the same two optional parameters for
completeness. Although HTML pages are view-only and never transition
to `submitted`, the webhook fires if a future event type (e.g.
`page.viewed`, `page.expired`) is added. For v2, the webhook is stored
but never fired for HTML pages.

### `check_result`

No changes. `check_result` continues to work regardless of whether a
webhook is configured.

### PageOps interface changes

```ts
export interface PageOps {
  showUi(spec: unknown, opts?: {
    webhook_url?: string;
    webhook_secret?: string;
  }): Promise<ShowUiResult>;
  showHtml(html: string, opts?: {
    webhook_url?: string;
    webhook_secret?: string;
  }): Promise<ShowUiResult>;
  checkResult(page_id: string): Promise<CheckResultOutcome>;
}
```

Both the in-process adapter (`apps/api/mcp/http.ts`) and the stdio
adapter (`apps/mcp/server.ts`) pass the webhook options through to
`store.createPage` / `store.createHtmlPage`.

## 4. API changes

### POST /new -- accepting webhook config

The request body schema grows two optional fields at the top level.
Both variants of the discriminated union accept them:

```ts
const webhookFields = {
  webhook_url: z.string().url().optional(),
  webhook_secret: z.string().min(16).max(256).optional(),
};

export const newPageBodySchema = z.union([
  z.object({
    format: z.literal('a2ui').optional().default('a2ui'),
    spec: z.unknown(),
    ...webhookFields,
  }).refine((b) => 'spec' in b, { message: "missing 'spec'" }),
  z.object({
    format: z.literal('html'),
    spec: z.string().min(1).max(HTML_MAX_BYTES),
    ...webhookFields,
  }),
]);
```

Validation rules on `webhook_url`:

1. Must be a valid URL (Zod `.url()` check).
2. Must use the `https:` scheme in production. In development
   (`NODE_ENV !== 'production'`), `http:` is allowed for local
   testing (e.g. `http://localhost:9999/hook`). Enforced by a Zod
   `.refine()` on the schema, not by runtime env checks in the
   handler.
3. Must not resolve to a private/internal IP (SSRF prevention --
   see section 7).

Validation rules on `webhook_secret`:

1. Minimum 16 characters to discourage weak secrets.
2. Maximum 256 characters.
3. Optional. When absent, deliveries are unsigned.

### POST /new handler changes (`newPageHandler`)

After Zod parsing, extract `webhook_url` and `webhook_secret` from
`result.data` and pass them to `store.createPage` /
`store.createHtmlPage`. The new fields are stored on the page row.

The response body is unchanged: `{ id, url, expires_at }`. The
`webhook_url` is intentionally NOT echoed back -- the agent supplied it
and already knows it.

### POST /:id/result handler changes (`submitResultHandler`)

After the successful `db.submitPage()` call (outcome `'ok'`), the
handler fires the webhook asynchronously. The webhook delivery MUST
NOT block the HTTP response to the submitting user.

```ts
// In submitResultHandler, after db.submitPage returns 'ok':
if (outcome.webhookUrl) {
  // Fire-and-forget: do not await. The webhook module handles
  // retries internally and logs outcomes.
  void deliverWebhook({
    pageId: idResult.data,
    submissionId: outcome.submissionId,
    mode: outcome.mode,
    webhookUrl: outcome.webhookUrl,
    webhookSecret: outcome.webhookSecret ?? undefined,
    result: bodyResult.data,
    submittedAt: new Date(),
    submittedBy: outcome.submittedBy ?? null,
    files: outcome.files ?? [],
    log: getLog(c),
  });
}
metrics.pagesSubmitted.add(1);
return c.json({ ok: true });
```

### GET /:id response

No changes. `webhook_url` and `webhook_secret` are NOT exposed in the
GET response. The webhook config is an implementation detail between
the agent and the API; the browser client should never see it.

### GET /:id/result response

No changes.

## 5. Webhook delivery logic

New module: `apps/api/webhook.ts`.

### Trigger point

The webhook fires immediately after `db.submitPage()` returns
`{ kind: 'ok' }` in `submitResultHandler`. The delivery is started
asynchronously (fire-and-forget from the HTTP handler's perspective).

### Payload construction

```ts
type WebhookFileRef = {
  file_id: string;
  field_name: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  download_url: string;   // signed URL, valid for 1 hour
};

type WebhookPayload = {
  event: 'page.submitted';
  page_id: string;
  submission_id: string;  // unique per submission
  mode: 'single' | 'public';
  result: unknown;
  submitted_at: string;   // ISO 8601
  submitted_by: string | null;  // email of authenticated user, null if unauthenticated
  files: WebhookFileRef[];      // empty array when no files attached
};
```

Auth and file uploads ship in the same v2 batch, so both fields are
available from launch. `submitted_by` is the email of the authenticated
user who submitted, or `null` for unauthenticated submissions (e.g.
public-mode pages without auth). `files` is an array of file references
with signed download URLs (valid for 1 hour); it is an empty array when
the submission has no file attachments. The payload shape is
forward-compatible: adding new top-level keys is a non-breaking change
for receivers.

### Public-form submissions

The webhook fires once per submission, regardless of page mode. For
public-mode pages (reusable forms that accept multiple submissions),
the same `page.submitted` event is used -- no separate event name. The
`mode` field (`"single"` or `"public"`) lets consumers distinguish
single-use pages from public forms, and the `submission_id` field
uniquely identifies each individual submission within a public page.
Receivers that handle public forms should expect multiple webhook
deliveries for the same `page_id`, each with a distinct
`submission_id`.

The payload is serialized to JSON with `JSON.stringify` once, and the
same string is used for both the HMAC computation and the HTTP body.
This ensures the signature matches the exact bytes sent over the wire.

### HMAC signing

When `webhook_secret` is set:

```ts
import { createHmac } from 'node:crypto';

function signPayload(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}
```

The signature is sent as the `X-Pagent-Signature` header. The receiver
verifies it with constant-time comparison (`crypto.timingSafeEqual`).

### Delivery request

```ts
const res = await fetch(webhookUrl, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'User-Agent': 'Pagent-Webhook/1.0',
    'X-Pagent-Event': 'page.submitted',
    'X-Pagent-Delivery': deliveryId,    // UUID for idempotency
    ...(signature ? { 'X-Pagent-Signature': signature } : {}),
  },
  body: rawBody,
  signal: AbortSignal.timeout(10_000),  // 10s timeout per attempt
});
```

Headers:

| Header               | Value                         | Purpose                        |
| -------------------- | ----------------------------- | ------------------------------ |
| Content-Type         | application/json              | Standard                       |
| User-Agent           | Pagent-Webhook/1.0            | Identifies Pagent deliveries   |
| X-Pagent-Event       | page.submitted                | Event type discriminator       |
| X-Pagent-Delivery    | UUID v4                       | Unique per delivery attempt    |
| X-Pagent-Signature   | sha256=<hex> (when secret set)| HMAC verification              |

### Success criteria

A delivery is considered successful when the receiver responds with
any 2xx status code. The response body is ignored.

## 6. Retry strategy

Three attempts with exponential backoff. Timing:

| Attempt | Delay before   | Cumulative wall time |
| ------- | -------------- | -------------------- |
| 1       | 0 (immediate)  | 0s                   |
| 2       | 1s +/- jitter  | ~1s                  |
| 3       | 5s +/- jitter  | ~6s                  |

If all three attempts fail, the delivery is abandoned and logged as
a permanent failure. No dead-letter queue.

### Retry eligibility

Retried on:

- Network errors (DNS failure, connection refused, timeout).
- HTTP 5xx responses (server-side failures).
- HTTP 429 (rate limited) -- respects `Retry-After` header if present,
  capped at 30s.

NOT retried on:

- HTTP 4xx (except 429) -- client errors indicate the receiver
  rejected the payload permanently.
- HTTP 3xx -- redirects are not followed by default; the agent should
  provide the final URL.

### Jitter

Each delay is jittered by +/- 25% to prevent thundering herd on
retries: `delay * (0.75 + Math.random() * 0.5)`. This matches the
existing `withRetry` pattern in `apps/api/db.ts`.

### Implementation sketch

```ts
const RETRY_DELAYS_MS = [0, 1_000, 5_000];

async function deliverWebhook(opts: {
  pageId: string;
  submissionId: string;
  mode: 'single' | 'public';
  webhookUrl: string;
  webhookSecret?: string;
  result: unknown;
  submittedAt: Date;
  submittedBy?: string | null;
  files?: WebhookFileRef[];
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
}): Promise<void> {
  const deliveryId = randomUUID();
  const payload: WebhookPayload = {
    event: 'page.submitted',
    page_id: opts.pageId,
    submission_id: opts.submissionId,
    mode: opts.mode,
    result: opts.result,
    submitted_at: opts.submittedAt.toISOString(),
    submitted_by: opts.submittedBy ?? null,
    files: opts.files ?? [],
  };
  const rawBody = JSON.stringify(payload);
  const signature = opts.webhookSecret
    ? signPayload(opts.webhookSecret, rawBody)
    : undefined;

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    const delay = RETRY_DELAYS_MS[attempt]!;
    if (delay > 0) {
      const jittered = delay * (0.75 + Math.random() * 0.5);
      await new Promise((r) => setTimeout(r, jittered));
    }

    try {
      const res = await fetch(opts.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Pagent-Webhook/1.0',
          'X-Pagent-Event': 'page.submitted',
          'X-Pagent-Delivery': deliveryId,
          ...(signature ? { 'X-Pagent-Signature': signature } : {}),
        },
        body: rawBody,
        signal: AbortSignal.timeout(10_000),
      });

      if (res.ok) {
        opts.log.info(
          { page_id: opts.pageId, attempt: attempt + 1,
            status: res.status, delivery_id: deliveryId },
          'webhook delivered',
        );
        metrics.webhookDeliveries.add(1, { status: 'success' });
        return;
      }

      // Non-retryable client error (except 429)
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        opts.log.warn(
          { page_id: opts.pageId, attempt: attempt + 1,
            status: res.status, delivery_id: deliveryId },
          'webhook rejected (non-retryable)',
        );
        metrics.webhookDeliveries.add(1, { status: 'rejected' });
        return;
      }

      // Retryable: 5xx or 429
      opts.log.warn(
        { page_id: opts.pageId, attempt: attempt + 1,
          status: res.status, delivery_id: deliveryId },
        'webhook attempt failed (retrying)',
      );
    } catch (err) {
      opts.log.warn(
        { page_id: opts.pageId, attempt: attempt + 1,
          err, delivery_id: deliveryId },
        'webhook attempt error (retrying)',
      );
    }
  }

  // All attempts exhausted
  opts.log.error(
    { page_id: opts.pageId, delivery_id: deliveryId,
      webhook_url: opts.webhookUrl },
    'webhook delivery failed after all retries',
  );
  metrics.webhookDeliveries.add(1, { status: 'failed' });
}
```

## 7. Security considerations

### SSRF prevention

The `webhook_url` is agent-supplied and could point to internal
services (metadata endpoints, internal APIs, localhost services). This
is the primary security concern.

**Mitigation layers:**

1. **URL scheme enforcement.** Only `https:` URLs are accepted in
   production. `http:` is allowed only when `NODE_ENV !== 'production'`
   for local development. Enforced at the Zod schema level.

2. **DNS resolution check before delivery.** Before the first delivery
   attempt, resolve the hostname and reject if it resolves to:
   - `127.0.0.0/8` (loopback)
   - `10.0.0.0/8` (RFC 1918)
   - `172.16.0.0/12` (RFC 1918)
   - `192.168.0.0/16` (RFC 1918)
   - `169.254.0.0/16` (link-local, includes cloud metadata endpoints)
   - `::1` (IPv6 loopback)
   - `fc00::/7` (IPv6 unique local)
   - `fe80::/10` (IPv6 link-local)
   - `0.0.0.0`

   Implementation: use `dns.promises.lookup()` to resolve the hostname,
   check the resolved IP against the blocklist, and reject before
   calling `fetch()`.

   ```ts
   import { promises as dns } from 'node:dns';
   import { isIP } from 'node:net';

   const BLOCKED_CIDRS = [
     { prefix: '127.', bits: 8 },
     { prefix: '10.', bits: 8 },
     // ... full list
   ];

   async function isPrivateHost(hostname: string): Promise<boolean> {
     // If the hostname is already an IP literal, check directly
     if (isIP(hostname)) return isPrivateIp(hostname);
     const { address } = await dns.lookup(hostname);
     return isPrivateIp(address);
   }
   ```

3. **No redirect following.** `fetch()` in Node 22 follows redirects
   by default. Set `redirect: 'error'` to prevent an attacker from
   redirecting from a public URL to an internal one.

   ```ts
   const res = await fetch(opts.webhookUrl, {
     // ...
     redirect: 'error',
   });
   ```

4. **Response body discarded.** The webhook delivery reads only the
   status code; the response body is not consumed or logged. This
   prevents data exfiltration through the response channel.

5. **Development bypass.** In non-production environments, the private
   IP check can be disabled via `WEBHOOK_ALLOW_PRIVATE_IPS=true` to
   support local testing with `localhost` callback URLs.

### Secret handling

- `webhook_secret` is never logged (not even at debug level).
- `webhook_secret` is never included in any API response body.
- `webhook_secret` is never included in error messages.
- Log messages about webhook delivery include `webhook_url` only on
  permanent failure (for debugging); routine success/retry logs use
  `page_id` and `delivery_id` only.

### Payload size

The webhook payload is bounded by the result body size, which is
already capped by the `bodyLimit` middleware (1 MB). The webhook
payload adds a small constant overhead (~200 bytes for the envelope
fields). No additional size cap is needed.

### Rate limiting on webhook delivery

The webhook delivery rate is implicitly limited by the page creation
rate limit (30/min/IP). Each page can fire at most one webhook. No
additional rate limiting on the delivery side is needed for v2.

### Timeout

Each delivery attempt has a 10-second timeout (`AbortSignal.timeout`).
This prevents a slow receiver from holding resources indefinitely.

## 8. Observability

### Structured logging

All webhook events are logged via Pino with structured fields.

| Log level | Event                        | Fields                                                     |
| --------- | ---------------------------- | ---------------------------------------------------------- |
| info      | webhook delivered             | `page_id`, `attempt`, `status`, `delivery_id`             |
| warn      | webhook attempt failed        | `page_id`, `attempt`, `status` or `err`, `delivery_id`   |
| warn      | webhook rejected (4xx)        | `page_id`, `attempt`, `status`, `delivery_id`             |
| error     | webhook delivery failed       | `page_id`, `delivery_id`, `webhook_url`                   |
| warn      | webhook SSRF blocked          | `page_id`, `webhook_url`, `resolved_ip`                   |

`webhook_secret` is NEVER logged at any level.

### OTel metrics

New counter and histogram on the existing `pagent-api` meter:

```ts
// apps/api/metrics.ts additions
webhookDeliveries: meter.createCounter('pagent.webhook.deliveries', {
  description: 'Webhook delivery outcomes by status (success/rejected/failed)',
}),
webhookDeliveryDuration: meter.createHistogram('pagent.webhook.delivery.duration', {
  description: 'Time from submission to final webhook delivery outcome',
  unit: 's',
}),
webhookDeliveryAttempts: meter.createHistogram('pagent.webhook.delivery.attempts', {
  description: 'Number of attempts per webhook delivery (1-3)',
}),
```

Labels on `webhookDeliveries`:
- `status`: `success` | `rejected` | `failed` | `ssrf_blocked`

### Audit log (future)

The v2 roadmap mentions an audit log. Webhook delivery events are
structured for future ingestion into an audit trail:

```ts
{
  action: 'webhook.delivered' | 'webhook.failed',
  page_id: string,
  delivery_id: string,
  attempts: number,
  final_status: number | 'error',
  timestamp: string,
}
```

This structure is emitted as structured log fields today and can be
routed to a dedicated audit table when that feature lands.

## 9. Testing strategy

### Unit tests (`apps/api/webhook.test.ts`)

Tests for the `deliverWebhook` function with mocked `fetch`:

1. **Successful delivery on first attempt.** Mock fetch to return 200.
   Assert: `webhookDeliveries` counter incremented with `success`,
   log.info called once, no retries.

2. **Retry on 500 then succeed.** Mock fetch to return 500, then 200.
   Assert: two attempts, final status `success`, log.warn on first
   attempt, log.info on second.

3. **Retry on network error then succeed.** Mock fetch to throw
   `TypeError('fetch failed')`, then return 200.
   Assert: two attempts, final status `success`.

4. **Permanent failure after 3 retries.** Mock fetch to always return
   502. Assert: three attempts, `webhookDeliveries` counter with
   `failed`, log.error on final failure.

5. **No retry on 4xx (except 429).** Mock fetch to return 400.
   Assert: one attempt, `webhookDeliveries` counter with `rejected`,
   no retry delay.

6. **Retry on 429.** Mock fetch to return 429, then 200.
   Assert: two attempts.

7. **HMAC signing.** Call with a known secret and body. Assert the
   `X-Pagent-Signature` header matches the expected HMAC value.

8. **No signature header when secret is absent.** Assert
   `X-Pagent-Signature` is not set in the fetch headers.

9. **Timeout.** Mock fetch to hang. Assert the delivery times out
   and retries.

10. **Payload shape.** Assert the POST body matches the
    `WebhookPayload` schema, including `submitted_by`, `files`,
    `submission_id`, and `mode` fields.

11. **Payload includes submitted_by when authenticated.** Call with
    a `submittedBy` value. Assert the payload `submitted_by` matches.

12. **Payload submitted_by is null when unauthenticated.** Call
    without `submittedBy`. Assert `submitted_by` is `null`.

13. **Payload includes files array.** Call with a `files` array.
    Assert the payload `files` matches.

14. **Public-mode submission_id is unique per delivery.** Fire two
    webhooks for the same `pageId` with `mode: 'public'`. Assert
    each has a distinct `submission_id`.

### Unit tests (`apps/api/webhook-ssrf.test.ts`)

1. **Block private IPs.** For each blocked CIDR, mock DNS to resolve
   to an IP in that range. Assert: delivery is rejected before fetch
   is called, `ssrf_blocked` metric incremented.

2. **Allow public IPs.** Mock DNS to resolve to `93.184.216.34`.
   Assert: fetch is called.

3. **Block localhost in production.** URL `https://localhost/hook`.
   Assert: blocked.

4. **Allow localhost in development.** With `WEBHOOK_ALLOW_PRIVATE_IPS`,
   mock DNS to resolve to `127.0.0.1`. Assert: fetch is called.

5. **Block IP literal in URL.** URL `https://169.254.169.254/metadata`.
   Assert: blocked without DNS resolution.

### Integration tests (`apps/api/app.test.ts` additions)

1. **POST /new with webhook_url stores it.** Assert `db.insertPage` is
   called with a page object containing the webhook URL.

2. **POST /new rejects invalid webhook_url.** Body with
   `webhook_url: 'not-a-url'`. Assert 400.

3. **POST /new rejects short webhook_secret.** Body with
   `webhook_secret: 'abc'` (< 16 chars). Assert 400.

4. **POST /new without webhook fields works.** Existing tests remain
   green -- webhook fields are optional.

5. **POST /:id/result fires webhook on success.** Mock
   `db.submitPage` to return `{ kind: 'ok', webhookUrl: '...' }`.
   Assert `deliverWebhook` is called (mock the module).

6. **POST /:id/result does not fire webhook when webhookUrl is null.**
   Mock `db.submitPage` to return `{ kind: 'ok', webhookUrl: null }`.
   Assert `deliverWebhook` is not called.

### MCP tool tests (`apps/api/mcp/tools.test.ts` additions)

1. **show_ui passes webhook_url and webhook_secret to ops.showUi.**
   Assert the ops mock receives both fields.

2. **show_ui without webhook fields still works.** Assert opts are
   undefined or empty.

### Local testing

For local development, agents can point `webhook_url` at a local HTTP
server. Two recommended approaches:

1. **`npx @anthropic-ai/webhook-server`** (hypothetical) or any local
   HTTP echo server:

   ```bash
   # Terminal 1: simple echo server
   npx http-echo-server --port 9999

   # Terminal 2: agent sets webhook_url
   # show_ui({ spec: [...], webhook_url: 'http://localhost:9999/hook' })
   ```

2. **ngrok / cloudflared tunnel** for testing with the deployed API:

   ```bash
   ngrok http 9999
   # Use the ngrok HTTPS URL as webhook_url
   ```

The SSRF check is relaxed in development (`NODE_ENV !== 'production'`)
or via `WEBHOOK_ALLOW_PRIVATE_IPS=true` to allow `localhost` URLs.

## 10. Environment variables

| Variable                   | Default   | Required | Description                                          |
| -------------------------- | --------- | -------- | ---------------------------------------------------- |
| `WEBHOOK_ALLOW_PRIVATE_IPS`| `false`   | No       | Set to `true` to skip SSRF IP checks (dev only)      |

No other new environment variables. The webhook feature uses existing
config (`NODE_ENV`, `DATABASE_URL`, etc.).

Add to `apps/api/schemas.ts` `envSchema`:

```ts
WEBHOOK_ALLOW_PRIVATE_IPS: z
  .enum(['true', 'false'])
  .optional()
  .default('false')
  .transform((v) => v === 'true'),
```

## 11. Dependencies

### No new npm packages

The webhook implementation uses only Node.js built-ins:

- `node:crypto` -- `createHmac`, `randomUUID`, `timingSafeEqual`
  (already used in `store.ts` for `randomBytes`)
- `node:dns` -- `promises.lookup` for SSRF hostname resolution
- `node:net` -- `isIP` for IP literal detection
- Global `fetch` -- available in Node 22+ (already used in
  `apps/mcp/server.ts`)
- `AbortSignal.timeout` -- available in Node 22+

No external HTTP client library is needed. Node's native `fetch` is
sufficient for the webhook delivery use case.

### Existing dependencies leveraged

- `pino` -- structured logging (already a dependency)
- `@opentelemetry/api` -- metrics (already a dependency)
- `zod` -- schema validation for webhook fields (already a dependency)

## 12. File change summary

| File                          | Change type | Description                                    |
| ----------------------------- | ----------- | ---------------------------------------------- |
| `apps/api/db.ts`              | modify      | Add columns, update Page type, update queries  |
| `apps/api/schemas.ts`         | modify      | Add webhook fields to newPageBodySchema, env   |
| `apps/api/app.ts`             | modify      | Pass webhook config, fire webhook on submit    |
| `apps/api/store.ts`           | modify      | Accept and pass through webhook options        |
| `apps/api/webhook.ts`         | **new**     | Delivery logic, HMAC signing, retry, SSRF      |
| `apps/api/metrics.ts`         | modify      | Add webhook counters and histograms            |
| `apps/api/mcp/tools.ts`       | modify      | Add webhook params to show_ui, show_html       |
| `apps/api/mcp/http.ts`        | modify      | Pass webhook opts through in-process adapter   |
| `apps/mcp/server.ts`          | modify      | Pass webhook opts through REST adapter         |
| `apps/api/webhook.test.ts`    | **new**     | Unit tests for delivery logic                  |
| `apps/api/webhook-ssrf.test.ts`| **new**    | SSRF prevention tests                          |
| `apps/api/app.test.ts`        | modify      | Integration tests for webhook flow             |
| `apps/api/mcp/tools.test.ts`  | modify      | MCP tool tests for webhook params              |
| `docs/openapi.yaml`           | modify      | Document webhook fields on POST /new           |

## 13. Rollout

### Commit order

Land in one PR with two logical commits:

1. **API + webhook delivery engine.** Schema changes, webhook.ts
   module, SSRF guard, metrics, handler integration. All unit tests.
   Tree is green; webhooks are accepted and stored but no MCP tool
   exposes them yet.

2. **MCP tool integration.** `show_ui` and `show_html` gain
   `webhook_url` and `webhook_secret` parameters. Stdio adapter
   updated. MCP tests. OpenAPI doc updated.

Both commits are individually green. Commit 1 can deploy safely
because no MCP client sends webhook fields yet. Commit 2 enables
the feature for agents.

### Backwards compatibility

- Existing `show_ui` calls without webhook fields continue to work.
  Both new parameters are optional with no default.
- `check_result` is unaffected.
- `POST /new` without webhook fields returns the same response shape.
- The `pages` table migration is additive (new nullable columns).
- No existing API contract is broken.

## 14. Open questions

None blocking implementation. Future considerations:

- **Webhook for page expiry.** Fire `page.expired` when TTL kills an
  open page. Useful for cleanup on the agent side. Spec separately.
- **Webhook for page viewed.** Fire `page.viewed` on first
  `GET /:id`. Useful for "the user saw the form" confirmation.
- **Dead-letter queue.** Persist failed deliveries for manual replay.
  v3 concern per roadmap.
- **Webhook signature rotation.** Per-delivery unique nonce in the
  HMAC input to prevent replay. Low priority given short page TTLs
  (30 min for single mode, 7 days for public mode).

## 15. Decisions summary

| Decision                        | Chosen                              | Rejected                              |
| ------------------------------- | ----------------------------------- | ------------------------------------- |
| Webhook scope                   | Per-page, at creation time          | Per-account global config             |
| Delivery model                  | Fire-and-forget, best-effort retry  | Queue-based guaranteed delivery       |
| Retry count                     | 3 attempts (0s, 1s, 5s)            | 5 attempts / unlimited / no retry     |
| Signing                         | HMAC-SHA256 with shared secret      | JWT / mTLS / unsigned                 |
| SSRF mitigation                 | DNS resolve + IP blocklist          | No mitigation / egress proxy          |
| Secret storage                  | Plaintext (short-lived pages)       | Encrypted at rest                     |
| Webhook URL scheme (production) | HTTPS only                          | Allow HTTP                            |
| Redirect following              | Disabled (`redirect: 'error'`)      | Follow redirects                      |
| Response body handling          | Discard                             | Log / store                           |
| Dead-letter queue               | None (v2)                           | Persist failed deliveries             |
| New dependencies                | None (Node built-ins only)          | axios / got / bull / pg-boss          |
