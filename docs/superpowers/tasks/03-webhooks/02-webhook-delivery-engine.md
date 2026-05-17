# 02 -- Webhook delivery engine

## Description

Create the core `apps/api/webhook.ts` module that handles payload
construction, HMAC signing, delivery with retry, and SSRF prevention.
This is a self-contained module with no coupling to HTTP handlers or
MCP tools -- it exports `deliverWebhook()` and the supporting types.

## Files to create/modify

- `apps/api/webhook.ts` -- **new**
- `apps/api/webhook.test.ts` -- **new**
- `apps/api/webhook-ssrf.test.ts` -- **new**

## Changes

### `apps/api/webhook.ts`

1. **Types** -- export `WebhookPayload` and `WebhookFileRef`:
   ```ts
   type WebhookFileRef = {
     file_id: string;
     field_name: string;
     original_name: string;
     mime_type: string;
     size_bytes: number;
     download_url: string;
   };

   type WebhookPayload = {
     event: 'page.submitted';
     page_id: string;
     submission_id: string;
     mode: 'single' | 'public';
     result: unknown;
     submitted_at: string;
     submitted_by: string | null;
     files: WebhookFileRef[];
   };
   ```

2. **`signPayload(secret, body)`** -- HMAC-SHA256 signature function
   returning `"sha256=<hex>"`. Uses `node:crypto` `createHmac`.

3. **`isPrivateHost(hostname)`** -- DNS-based SSRF check. Resolves
   hostname via `dns.promises.lookup()`, checks resolved IP against
   blocked CIDRs (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12,
   192.168.0.0/16, 169.254.0.0/16, ::1, fc00::/7, fe80::/10, 0.0.0.0).
   IP literals checked directly via `net.isIP()`. Bypassed when
   `WEBHOOK_ALLOW_PRIVATE_IPS` env var is `true`.

4. **`deliverWebhook(opts)`** -- main entry point. Parameters:
   `pageId`, `submissionId`, `mode`, `webhookUrl`, `webhookSecret?`,
   `result`, `submittedAt`, `submittedBy?`, `files?`, `log`.
   - Constructs `WebhookPayload`, serializes to JSON once.
   - Computes HMAC signature if secret is provided.
   - Runs SSRF check on the URL hostname before first attempt.
   - Retries up to 3 times with delays [0ms, 1000ms, 5000ms] and
     +/-25% jitter.
   - Sets `redirect: 'error'` on fetch to prevent redirect-based SSRF.
   - Sets `AbortSignal.timeout(10_000)` per attempt.
   - Sends headers: `Content-Type`, `User-Agent: Pagent-Webhook/1.0`,
     `X-Pagent-Event`, `X-Pagent-Delivery` (UUID), and
     `X-Pagent-Signature` (when secret set).
   - Success: any 2xx. No retry on 4xx (except 429). Retry on 5xx,
     429, network errors.
   - Logs via provided `log` object (info on success, warn on retry,
     error on final failure). Never logs `webhookSecret`.
   - Records metrics (see task 03).

### `apps/api/webhook.test.ts`

Unit tests with mocked `fetch` (14 tests per spec section 9):

1. Successful delivery on first attempt (200).
2. Retry on 500 then succeed (200).
3. Retry on network error then succeed.
4. Permanent failure after 3 retries (always 502).
5. No retry on 4xx (except 429) -- single attempt, 400.
6. Retry on 429 then succeed.
7. HMAC signing with known secret matches expected value.
8. No `X-Pagent-Signature` header when secret absent.
9. Timeout handling (mock fetch to hang).
10. Payload shape matches `WebhookPayload` schema.
11. Payload includes `submitted_by` when authenticated.
12. Payload `submitted_by` is `null` when unauthenticated.
13. Payload includes `files` array.
14. Public-mode `submission_id` is unique per delivery.

### `apps/api/webhook-ssrf.test.ts`

SSRF prevention tests (5 tests per spec section 9):

1. Block each private IP CIDR (mock DNS).
2. Allow public IPs.
3. Block `localhost` in production.
4. Allow `localhost` when `WEBHOOK_ALLOW_PRIVATE_IPS=true`.
5. Block IP literal in URL (e.g., `https://169.254.169.254/metadata`).

## Acceptance criteria

- [ ] `deliverWebhook` is exported from `apps/api/webhook.ts`.
- [ ] `signPayload` produces correct HMAC-SHA256 signatures.
- [ ] SSRF check blocks all listed private CIDRs before `fetch` is called.
- [ ] SSRF check is bypassed when `WEBHOOK_ALLOW_PRIVATE_IPS=true`.
- [ ] Retry logic follows [0ms, 1s, 5s] schedule with jitter.
- [ ] 4xx (except 429) terminates immediately without retry.
- [ ] 5xx and 429 are retried.
- [ ] `redirect: 'error'` is set on all fetch calls.
- [ ] 10s timeout per attempt via `AbortSignal.timeout`.
- [ ] `webhookSecret` never appears in any log message.
- [ ] All 14 unit tests and 5 SSRF tests pass.

## Dependencies

- **01** (db schema) -- `WebhookPayload` type references fields that
  flow from the `SubmitOutcome` added in task 01.

## Relevant spec sections

- Section 5: Webhook delivery logic (payload, HMAC, delivery request)
- Section 6: Retry strategy
- Section 7: Security considerations (SSRF, secret handling, redirects)
- Section 9: Testing strategy (unit tests, SSRF tests)
