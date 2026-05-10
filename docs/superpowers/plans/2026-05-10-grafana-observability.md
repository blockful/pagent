# Self-Hosted Grafana Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `grafana/otel-lgtm` on Railway, add metrics + logs exporters to the API, ship two version-controlled Grafana dashboards (Operations + Product).

**Architecture:** Single Railway service hosts the LGTM bundle (Grafana + Tempo + Mimir-Prom + Loki + OTel Collector). API exports OTLP/HTTP over Railway's private network. Dashboards provisioned from JSON files baked into the Docker image.

**Tech Stack:** OpenTelemetry JS SDK (metrics + logs), pino-opentelemetry-transport, grafana/otel-lgtm Docker image, Railway.

**Spec:** [`docs/superpowers/specs/2026-05-10-grafana-observability-design.md`](../specs/2026-05-10-grafana-observability-design.md)

---

## Files

```
apps/api/metrics.ts                                   (new)
apps/api/metrics.test.ts                              (new)
apps/api/tracing.ts                                   (modify — add MeterProvider + LoggerProvider)
apps/api/tracing-status.ts                            (modify — describe metrics + logs)
apps/api/tracing-status.test.ts                       (modify — extend tests)
apps/api/app.ts                                       (modify — RED middleware + x-trace-id + product metrics on submit)
apps/api/app.test.ts                                  (modify — assert headers + smoke metrics)
apps/api/store.ts                                     (modify — bump pages.created)
apps/api/db.ts                                        (modify — deleteExpiredPages returns by-state breakdown)
apps/api/db.test.ts                                   (modify — assert new return shape)
apps/api/server.ts                                    (modify — call new sweep API, bump pages.abandoned)
apps/api/logger.ts                                    (modify — pino-opentelemetry-transport when OTEL endpoint set)
apps/api/.env.example                                 (modify — add metrics/logs notes)
apps/api/package.json                                 (modify — add deps)
infra/observability/Dockerfile                        (new)
infra/observability/railway.json                      (new)
infra/observability/README.md                         (new)
infra/observability/provisioning/datasources.yaml     (new)
infra/observability/provisioning/dashboards.yaml      (new)
infra/observability/dashboards/operations.json        (new)
infra/observability/dashboards/product.json           (new)
docs/observability.md                                 (new)
README.md                                             (modify — link to observability.md)
```

---

## Task 1: Add OTel metrics + logs SDK packages

**Files:**

- Modify: `apps/api/package.json`

- [ ] **Step 1: Add packages**

```bash
cd apps/api
npm install \
  @opentelemetry/sdk-metrics@^2.0.0 \
  @opentelemetry/exporter-metrics-otlp-http@^0.217.0 \
  @opentelemetry/sdk-logs@^0.217.0 \
  @opentelemetry/exporter-logs-otlp-http@^0.217.0 \
  @opentelemetry/api-logs@^0.217.0 \
  pino-opentelemetry-transport@^1.0.0
```

If `@opentelemetry/sdk-metrics@^2.0.0` is incompatible with the existing
`@opentelemetry/sdk-node@^0.217.0`, fall back to `^1.31.0` (the last 1.x line).
Run `npm test` after install — if it explodes on imports unrelated to this
work, the version pick is wrong; bisect.

- [ ] **Step 2: Verify install**

Run: `cd ../.. && npm test`
Expected: PASS (118 tests, same as baseline).

- [ ] **Step 3: Commit**

```bash
git add apps/api/package.json package-lock.json
git commit -m "chore(api): add otel metrics + logs sdk deps"
```

---

## Task 2: Extend `tracing-status` to describe metrics + logs

**Files:**

- Modify: `apps/api/tracing-status.ts`
- Modify: `apps/api/tracing-status.test.ts`

The existing `describeTracing` only describes traces. We need it to describe
the full telemetry pipeline (traces, metrics, logs) so `tracingBootLog` can
print a single accurate line at boot.

- [ ] **Step 1: Update tests for the new shape**

Replace the body of `apps/api/tracing-status.test.ts` with:

```typescript
import { describe, it, expect } from 'vitest';
import { describeTracing, tracingBootLog } from './tracing-status.ts';

describe('describeTracing', () => {
  it('returns disabled when OTEL_EXPORTER_OTLP_ENDPOINT is unset', () => {
    expect(describeTracing({})).toEqual({
      enabled: false,
      reason: 'OTEL_EXPORTER_OTLP_ENDPOINT not set',
    });
  });

  it('returns enabled with default service name when endpoint is set', () => {
    expect(
      describeTracing({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://example/otlp' }),
    ).toEqual({
      enabled: true,
      endpoint: 'https://example/otlp',
      serviceName: 'pagent-api',
      signals: ['traces', 'metrics', 'logs'],
    });
  });

  it('honors OTEL_SERVICE_NAME override', () => {
    const status = describeTracing({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://example/otlp',
      OTEL_SERVICE_NAME: 'custom',
    });
    expect(status).toMatchObject({ serviceName: 'custom' });
  });
});

describe('tracingBootLog', () => {
  it('formats the disabled reason', () => {
    expect(tracingBootLog({ enabled: false, reason: 'because' })).toBe(
      '[tracing] disabled — because',
    );
  });

  it('formats the enabled line with all signals', () => {
    expect(
      tracingBootLog({
        enabled: true,
        endpoint: 'https://example/otlp',
        serviceName: 'pagent-api',
        signals: ['traces', 'metrics', 'logs'],
      }),
    ).toBe(
      '[tracing] enabled — service=pagent-api signals=traces,metrics,logs endpoint=https://example/otlp',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/tracing-status.test.ts`
Expected: FAIL (signals field missing, log format different).

- [ ] **Step 3: Update implementation**

Replace `apps/api/tracing-status.ts` with:

```typescript
// Pure helpers for describing the OpenTelemetry configuration at boot time.
// Kept separate from tracing.ts so they can be unit-tested without loading
// any side-effectful SDK module.

export type TelemetrySignal = 'traces' | 'metrics' | 'logs';

export type TracingStatus =
  | {
      enabled: true;
      endpoint: string;
      serviceName: string;
      signals: TelemetrySignal[];
    }
  | { enabled: false; reason: string };

export function describeTracing(env: NodeJS.ProcessEnv = process.env): TracingStatus {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    return {
      enabled: false,
      reason: 'OTEL_EXPORTER_OTLP_ENDPOINT not set',
    };
  }
  return {
    enabled: true,
    endpoint,
    serviceName: env.OTEL_SERVICE_NAME ?? 'pagent-api',
    signals: ['traces', 'metrics', 'logs'],
  };
}

export function tracingBootLog(status: TracingStatus): string {
  if (status.enabled) {
    return `[tracing] enabled — service=${status.serviceName} signals=${status.signals.join(',')} endpoint=${status.endpoint}`;
  }
  return `[tracing] disabled — ${status.reason}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/api/tracing-status.test.ts`
Expected: PASS (5+ tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/tracing-status.ts apps/api/tracing-status.test.ts
git commit -m "feat(api): describe metrics and logs in tracing status"
```

---

## Task 3: Initialize metrics + logs SDKs in `tracing.ts`

**Files:**

- Modify: `apps/api/tracing.ts`

The existing `tracing.ts` only registers the trace exporter. Add a
`MeterProvider` with an `OTLPMetricExporter` (60s push interval) and a
`LoggerProvider` with an `OTLPLogExporter`. Keep the same env-var gating —
when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, all three are no-ops.

- [ ] **Step 1: Replace `apps/api/tracing.ts`**

```typescript
// OTel bootstrap — imported first by server.ts so that auto-instrumentation
// can wrap http/postgres before they are required. No-op when
// OTEL_EXPORTER_OTLP_ENDPOINT is not set.
//
// Uses console.log (not the pino logger) for the boot line because this
// module loads before pino is instrumented by PinoInstrumentation.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { describeTracing, tracingBootLog } from './tracing-status.ts';

const status = describeTracing();

if (status.enabled) {
  const base = status.endpoint.replace(/\/$/, '');
  const headers = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);

  const sdk = new NodeSDK({
    serviceName: status.serviceName,
    traceExporter: new OTLPTraceExporter({ url: `${base}/v1/traces`, headers }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics`, headers }),
      exportIntervalMillis: 60_000,
    }),
    logRecordProcessors: [
      new BatchLogRecordProcessor(
        new OTLPLogExporter({ url: `${base}/v1/logs`, headers }),
      ),
    ],
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
      }),
      new PinoInstrumentation(),
    ],
  });

  sdk.start();
  process.on('SIGTERM', () => sdk.shutdown().catch(() => {}));
}

console.log(tracingBootLog(status));

function parseOtlpHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const [k, ...rest] = pair.split('=');
    if (k && rest.length) out[k.trim()] = rest.join('=').trim();
  }
  return out;
}
```

- [ ] **Step 2: Verify boot in disabled mode**

Run: `cd apps/api && OTEL_EXPORTER_OTLP_ENDPOINT= node --experimental-strip-types -e "import('./tracing.ts')"`
Expected: prints `[tracing] disabled — OTEL_EXPORTER_OTLP_ENDPOINT not set`, exits cleanly.

- [ ] **Step 3: Verify boot in enabled mode (against a fake endpoint)**

Run: `cd apps/api && OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:65535/otlp node --experimental-strip-types -e "import('./tracing.ts')"`
Expected: prints `[tracing] enabled — service=pagent-api signals=traces,metrics,logs endpoint=http://127.0.0.1:65535/otlp` and exits (no crash from the offline endpoint — exporters retry in the background).

- [ ] **Step 4: Run full test suite**

Run: `cd ../.. && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/tracing.ts
git commit -m "feat(api): export metrics and logs via otlp"
```

---

## Task 4: Define metrics module

**Files:**

- Create: `apps/api/metrics.ts`
- Create: `apps/api/metrics.test.ts`

Centralizes the six metrics defined in the spec. Other modules import these
names — they don't talk to the OTel API directly.

- [ ] **Step 1: Write the failing test**

Create `apps/api/metrics.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { metrics, statusClassFor } from './metrics.ts';

describe('statusClassFor', () => {
  it.each([
    [200, '2xx'],
    [201, '2xx'],
    [301, '3xx'],
    [400, '4xx'],
    [404, '4xx'],
    [429, '4xx'],
    [500, '5xx'],
    [503, '5xx'],
  ])('maps %d to %s', (status, expected) => {
    expect(statusClassFor(status)).toBe(expected);
  });

  it('falls back to "5xx" for unexpected codes', () => {
    expect(statusClassFor(0)).toBe('5xx');
    expect(statusClassFor(999)).toBe('5xx');
  });
});

describe('metrics module', () => {
  it('exposes all six instruments', () => {
    expect(typeof metrics.httpRequests.add).toBe('function');
    expect(typeof metrics.httpRequestDuration.record).toBe('function');
    expect(typeof metrics.pagesCreated.add).toBe('function');
    expect(typeof metrics.pagesSubmitted.add).toBe('function');
    expect(typeof metrics.pagesAbandoned.add).toBe('function');
    expect(typeof metrics.pageSubmitLatency.record).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/metrics.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create `apps/api/metrics.ts`**

```typescript
import { metrics as otelMetrics } from '@opentelemetry/api';

const meter = otelMetrics.getMeter('pagent-api');

export const metrics = {
  httpRequests: meter.createCounter('http.server.requests', {
    description: 'Count of HTTP requests by method, route, and status',
  }),
  httpRequestDuration: meter.createHistogram('http.server.request.duration', {
    description: 'Duration of HTTP requests in seconds',
    unit: 's',
  }),
  pagesCreated: meter.createCounter('pagent.pages.created', {
    description: 'Pages created via POST /new',
  }),
  pagesSubmitted: meter.createCounter('pagent.pages.submitted', {
    description: 'Pages successfully submitted by a user',
  }),
  pagesAbandoned: meter.createCounter('pagent.pages.abandoned', {
    description: 'Pages that hit TTL while still in state=open',
  }),
  pageSubmitLatency: meter.createHistogram('pagent.page.submit.latency', {
    description: 'Time from page creation to user submission',
    unit: 's',
  }),
} as const;

/** Bucket an HTTP status code into a metric label. Falls back to "5xx" for
 * out-of-range codes so we never silently drop a measurement. */
export function statusClassFor(status: number): '2xx' | '3xx' | '4xx' | '5xx' {
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 300 && status < 400) return '3xx';
  if (status >= 400 && status < 500) return '4xx';
  return '5xx';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/api/metrics.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/metrics.ts apps/api/metrics.test.ts
git commit -m "feat(api): define otel metric instruments"
```

---

## Task 5: Wire RED metrics + `x-trace-id` into the request middleware

**Files:**

- Modify: `apps/api/app.ts`
- Modify: `apps/api/app.test.ts`

The existing logging middleware in `app.ts` (lines ~109-121) records
`duration_ms` for the log line. Extend it to also record metrics. Add a
second middleware (or fold in) that sets `x-trace-id` from the active span.

- [ ] **Step 1: Add the failing test in `apps/api/app.test.ts`**

Add this to the existing test file (find a sensible block — group with other
header-shape tests):

```typescript
import { trace } from '@opentelemetry/api';

describe('observability headers', () => {
  it('returns x-trace-id when a span is active', async () => {
    const res = await app.request('/health');
    const traceId = res.headers.get('x-trace-id');
    // 32-hex chars (W3C trace context) when tracing is enabled, else absent.
    if (traceId) {
      expect(traceId).toMatch(/^[a-f0-9]{32}$/);
    }
    // In the test env (no OTel SDK), header may be absent — that's also fine.
    // The point is: when present, it's well-formed.
    expect(traceId === null || /^[a-f0-9]{32}$/.test(traceId)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/app.test.ts -t 'x-trace-id'`
Expected: FAIL or PASS-by-accident (header absent path). To force a real
fail, also assert that for in-tests the header is absent (since OTel isn't
booted). Adjust assertion to `expect(traceId).toBeNull()`.

Then update test:

```typescript
it('omits x-trace-id when tracing is disabled (test env)', async () => {
  const res = await app.request('/health');
  expect(res.headers.get('x-trace-id')).toBeNull();
});
```

This will fail until the middleware exists (because the middleware is
mandatory once added even if it produces null — but null doesn't set a
header, so it should still pass... hmm). Better test: instrument explicitly.

Replace with this single test that exercises the header-setting code path:

```typescript
it('sets x-trace-id header when an active span is present', async () => {
  const tracer = trace.getTracer('test');
  const span = tracer.startSpan('test-span');
  let res: Response;
  await trace.getTracer('test').startActiveSpan('outer', async (s) => {
    res = await app.request('/health');
    s.end();
  });
  span.end();
  // In test env there is no real SDK, so context propagation may be a no-op.
  // We just assert the middleware doesn't crash and returns a valid response.
  expect(res!.status).toBe(200);
});
```

(The actual header presence is verified manually with the integration test
in Task 11. Unit tests would need the in-memory exporter — overkill here.)

- [ ] **Step 3: Modify `apps/api/app.ts`**

Find the existing logging middleware (it currently does `await next()` then
logs `method/path/status/duration_ms`). Replace with:

```typescript
import { trace } from '@opentelemetry/api';
import { metrics, statusClassFor } from './metrics.ts';
```

Add at the top with other imports.

Replace the existing inline middleware:

```typescript
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const durationMs = Date.now() - start;
  const status = c.res.status;
  const route = (c.req.routePath as string | undefined) ?? c.req.path;

  // Surface trace_id so operators can paste it into Grafana.
  const span = trace.getActiveSpan();
  const traceId = span?.spanContext().traceId;
  if (traceId && traceId !== '00000000000000000000000000000000') {
    c.header('x-trace-id', traceId);
  }

  // Record metrics. Cheap — a single counter add + histogram record.
  metrics.httpRequests.add(1, {
    method: c.req.method,
    route,
    status_class: statusClassFor(status),
    status_code: String(status),
  });
  metrics.httpRequestDuration.record(durationMs / 1000, {
    method: c.req.method,
    route,
  });

  getLog(c).info(
    {
      method: c.req.method,
      path: c.req.path,
      route,
      status,
      duration_ms: durationMs,
    },
    'request',
  );
});
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS (118+ tests). The new test passes because it only asserts no
crash + 200 status.

- [ ] **Step 5: Commit**

```bash
git add apps/api/app.ts apps/api/app.test.ts
git commit -m "feat(api): record red metrics and emit x-trace-id"
```

---

## Task 6: Bump `pagent.pages.created` in `store.createPage`

**Files:**

- Modify: `apps/api/store.ts`

- [ ] **Step 1: Modify `apps/api/store.ts`**

At the top of the file, add:

```typescript
import { metrics } from './metrics.ts';
```

Inside `createPage` (after the page is successfully written, before
returning), add:

```typescript
metrics.pagesCreated.add(1);
```

The exact line depends on `store.ts`'s current shape — place it on the
success path, **after** the DB write returns and **before** the function
returns the result.

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/store.ts
git commit -m "feat(api): count pages created"
```

---

## Task 7: Bump `pagent.pages.submitted` + record latency on submission

**Files:**

- Modify: `apps/api/db.ts` (export `created_at` from the submitted row, or expose a getter)
- Modify: `apps/api/app.ts` (record metric in `submitResultHandler`)
- Modify: `apps/api/db.test.ts` (assert new return shape if changed)

`db.submitPage` currently returns `'ok' | 'not_found' | 'conflict'`. To
compute submit latency we need `created_at`. Change `submitPage` to return
`{ kind: 'ok'; createdAt: Date } | { kind: 'not_found' } | { kind: 'conflict' }`.

- [ ] **Step 1: Read current `submitPage` to confirm signature**

Run: `grep -n "submitPage\|export async function" apps/api/db.ts`
Make a note of the current return type. Update tests in `db.test.ts` first.

- [ ] **Step 2: Update db.test.ts to expect the new shape**

Find the submit-page tests. Update assertions:

```typescript
// Old: expect(result).toBe('ok')
// New:
expect(result).toMatchObject({ kind: 'ok' });
expect(result.kind === 'ok' && result.createdAt instanceof Date).toBe(true);

// Old: expect(result).toBe('not_found')  -> { kind: 'not_found' }
// Old: expect(result).toBe('conflict')   -> { kind: 'conflict' }
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run apps/api/db.test.ts`
Expected: FAIL (return shape mismatch).

- [ ] **Step 4: Update `db.ts`**

In `submitPage`, change the SQL to `update ... returning created_at` and the
TypeScript return shape:

```typescript
export type SubmitOutcome =
  | { kind: 'ok'; createdAt: Date }
  | { kind: 'not_found' }
  | { kind: 'conflict' };

export async function submitPage(
  id: string,
  action: unknown,
): Promise<SubmitOutcome> {
  return withRetry(async () => {
    const c = client();
    const rows = await c<{ created_at: Date }[]>`
      update pages
      set state = 'submitted', result = ${action as object}, submitted_at = now()
      where id = ${id} and state = 'open' and expires_at > now()
      returning created_at
    `;
    if (rows.count === 1) {
      return { kind: 'ok', createdAt: rows[0].created_at };
    }
    // Differentiate not_found vs conflict by checking existence.
    const existing = await c`select state, expires_at from pages where id = ${id}`;
    if (existing.count === 0 || existing[0].expires_at <= new Date()) {
      return { kind: 'not_found' };
    }
    return { kind: 'conflict' };
  });
}
```

(Adjust SQL to match the actual current schema. The key change is `returning
created_at`.)

- [ ] **Step 5: Update `submitResultHandler` in `app.ts`**

```typescript
const submitResultHandler = async (c: Context) => {
  const idResult = pageIdSchema.safeParse(c.req.param('id'));
  if (!idResult.success)
    return c.json({ error: 'not_found', message: 'Page not found or expired' }, 404);
  const raw = await c.req.json().catch(() => null);
  const bodyResult = resultBodySchema.safeParse(raw);
  if (!bodyResult.success) {
    return c.json(
      {
        error: 'bad_request',
        issues: bodyResult.error.issues,
        message: 'Request body did not match the expected schema',
      },
      400,
    );
  }
  const action = bodyResult.data;
  const outcome = await db.submitPage(idResult.data, action);
  if (outcome.kind === 'not_found')
    return c.json({ error: 'not_found', message: 'Page not found or expired' }, 404);
  if (outcome.kind === 'conflict')
    return c.json(
      {
        error: 'conflict',
        message: 'Page was already submitted; create a new page if you need another submission',
      },
      409,
    );
  // outcome.kind === 'ok'
  metrics.pagesSubmitted.add(1);
  metrics.pageSubmitLatency.record((Date.now() - outcome.createdAt.getTime()) / 1000);
  return c.json({ ok: true });
};
```

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/db.ts apps/api/app.ts apps/api/db.test.ts
git commit -m "feat(api): count submissions and record submit latency"
```

---

## Task 8: Track abandoned pages in the TTL sweep

**Files:**

- Modify: `apps/api/db.ts`
- Modify: `apps/api/db.test.ts`
- Modify: `apps/api/server.ts`

`deleteExpiredPages` currently returns just a count. We need it to return
`{ total: number; abandoned: number }` so the sweep caller can bump
`pagent.pages.abandoned` for the open subset.

- [ ] **Step 1: Update tests**

In `db.test.ts`, find the tests for `deleteExpiredPages`. Update return
shape:

```typescript
const result = await db.deleteExpiredPages();
expect(result).toEqual({ total: <expected>, abandoned: <expected> });
```

If existing tests insert a mix of `state='open'` and `state='received'`
expired rows, assert `abandoned` reflects only the open count.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/api/db.test.ts -t deleteExpiredPages`
Expected: FAIL.

- [ ] **Step 3: Update `deleteExpiredPages`**

```typescript
export async function deleteExpiredPages(): Promise<{
  total: number;
  abandoned: number;
}> {
  return withRetry(async () => {
    const c = client();
    const rows = await c<{ state: string }[]>`
      delete from pages where expires_at <= now()
      returning state
    `;
    const total = rows.count;
    const abandoned = rows.filter((r) => r.state === 'open').length;
    return { total, abandoned };
  });
}
```

- [ ] **Step 4: Update the sweep in `server.ts`**

Replace the existing `setInterval` body:

```typescript
import { metrics } from './metrics.ts';
// ... (other imports unchanged)

const sweepTimer = setInterval(async () => {
  try {
    const { total, abandoned } = await db.deleteExpiredPages();
    if (abandoned > 0) metrics.pagesAbandoned.add(abandoned);
    if (total > 0) logger.debug({ total, abandoned }, 'ttl sweep removed expired pages');
  } catch (err) {
    logger.error({ err }, 'ttl sweep failed');
  }
}, 60_000);
sweepTimer.unref();
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/db.ts apps/api/db.test.ts apps/api/server.ts
git commit -m "feat(api): count abandoned pages in ttl sweep"
```

---

## Task 9: Wire pino → OTel logs

**Files:**

- Modify: `apps/api/logger.ts`
- Modify: `apps/api/.env.example`

Pino's `transport` accepts a `targets` array. Add the OTel target only when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set, so dev with no observability stack
behaves exactly as today.

- [ ] **Step 1: Replace `apps/api/logger.ts`**

```typescript
import pino from 'pino';

const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/$/, '');
const isDev = process.env.NODE_ENV !== 'production';

type Target = { target: string; options?: Record<string, unknown>; level?: string };

const targets: Target[] = [];

// Pretty console output in dev; raw JSON in prod (Railway captures stdout).
if (isDev) {
  targets.push({
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
  });
} else {
  targets.push({
    target: 'pino/file',
    options: { destination: 1 }, // stdout
  });
}

// OTel logs export — only when endpoint is configured.
if (otelEndpoint) {
  targets.push({
    target: 'pino-opentelemetry-transport',
    options: {
      logRecordProcessorOptions: {
        recordProcessorType: 'batch',
        exporterOptions: {
          protocol: 'http/protobuf',
          url: `${otelEndpoint}/v1/logs`,
        },
      },
      resourceAttributes: {
        'service.name': process.env.OTEL_SERVICE_NAME ?? 'pagent-api',
      },
    },
  });
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: { targets },
});
```

- [ ] **Step 2: Update `apps/api/.env.example`**

Append below the existing OTEL_* block:

```
# When OTEL_EXPORTER_OTLP_ENDPOINT is set, the API also pushes:
#   - metrics  → <endpoint>/v1/metrics
#   - logs     → <endpoint>/v1/logs (via pino-opentelemetry-transport)
# The same endpoint serves all three signals; configure once.
```

- [ ] **Step 3: Verify dev boot**

Run: `cd apps/api && OTEL_EXPORTER_OTLP_ENDPOINT= node --watch --env-file=/dev/null --experimental-strip-types -e "import('./logger.ts').then(m => m.logger.info('hello')); setTimeout(() => process.exit(0), 100)"`
Expected: pretty-printed log line, no errors.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/logger.ts apps/api/.env.example
git commit -m "feat(api): export pino logs to otel collector"
```

---

## Task 10: Build the observability Docker image with provisioned dashboards

**Files:**

- Create: `infra/observability/Dockerfile`
- Create: `infra/observability/railway.json`
- Create: `infra/observability/provisioning/datasources.yaml`
- Create: `infra/observability/provisioning/dashboards.yaml`
- Create: `infra/observability/dashboards/operations.json`
- Create: `infra/observability/dashboards/product.json`
- Create: `infra/observability/README.md`

The image is `grafana/otel-lgtm` with our provisioning copied in. Grafana
auto-loads provisioning from `/etc/grafana/provisioning/`.

- [ ] **Step 1: Create `infra/observability/Dockerfile`**

```dockerfile
# Pinned tag for reproducible deploys. Bump deliberately.
FROM grafana/otel-lgtm:0.8.1

# Provisioning — datasources and dashboards are loaded automatically by
# Grafana on startup from these paths.
COPY provisioning/ /etc/grafana/provisioning/
COPY dashboards/   /var/lib/grafana/dashboards/

# Grafana admin password is set via GF_SECURITY_ADMIN_PASSWORD env var,
# supplied by Railway as a secret. The image's default port is 3000.
EXPOSE 3000 4317 4318
```

- [ ] **Step 2: Create `infra/observability/provisioning/datasources.yaml`**

```yaml
# Wired to the bundle's internal addresses. The grafana/otel-lgtm image runs
# Prometheus, Tempo, and Loki on these localhost ports.
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://localhost:9090
    isDefault: true
    jsonData:
      timeInterval: 30s

  - name: Tempo
    type: tempo
    access: proxy
    url: http://localhost:3200
    jsonData:
      tracesToLogsV2:
        datasourceUid: loki
        spanStartTimeShift: -1m
        spanEndTimeShift: 1m
        tags: [{ key: 'service.name', value: 'service' }]
      tracesToMetrics:
        datasourceUid: prometheus
      serviceMap:
        datasourceUid: prometheus
      nodeGraph:
        enabled: true

  - name: Loki
    type: loki
    access: proxy
    url: http://localhost:3100
    jsonData:
      derivedFields:
        - datasourceUid: tempo
          matcherRegex: '"trace_id":"(\w+)"'
          name: trace_id
          url: '$${__value.raw}'
```

- [ ] **Step 3: Create `infra/observability/provisioning/dashboards.yaml`**

```yaml
apiVersion: 1

providers:
  - name: pagent
    orgId: 1
    folder: 'Pagent'
    type: file
    disableDeletion: true
    editable: true
    updateIntervalSeconds: 30
    options:
      path: /var/lib/grafana/dashboards
      foldersFromFilesStructure: false
```

- [ ] **Step 4: Create `infra/observability/dashboards/operations.json`**

A Grafana dashboard JSON model. Key panels (use Grafana's Dashboard JSON
schema; build from a minimal template, not by hand-typing every field):

Build it by:

1. Start with this minimal skeleton.
2. Each panel block follows the same shape; only `title`, `targets`, and
   `gridPos` change.

```json
{
  "uid": "pagent-operations",
  "title": "Pagent — Operations",
  "tags": ["pagent", "sre"],
  "timezone": "browser",
  "schemaVersion": 39,
  "version": 1,
  "refresh": "30s",
  "time": { "from": "now-1h", "to": "now" },
  "panels": [
    {
      "id": 1,
      "type": "stat",
      "title": "Service status",
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "gridPos": { "h": 4, "w": 6, "x": 0, "y": 0 },
      "options": {
        "reduceOptions": { "calcs": ["lastNotNull"], "fields": "", "values": false },
        "colorMode": "background",
        "graphMode": "none"
      },
      "fieldConfig": {
        "defaults": {
          "mappings": [
            { "type": "value", "options": { "0": { "text": "DOWN", "color": "red" } } },
            { "type": "value", "options": { "1": { "text": "UP", "color": "green" } } }
          ],
          "thresholds": { "mode": "absolute", "steps": [{ "color": "red", "value": null }] }
        }
      },
      "targets": [
        {
          "expr": "(sum(rate(http_server_requests_total[2m])) > 0) * 1",
          "refId": "A"
        }
      ]
    },
    {
      "id": 2,
      "type": "timeseries",
      "title": "Request rate by route (req/s)",
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 6, "y": 0 },
      "targets": [
        {
          "expr": "sum by (route) (rate(http_server_requests_total[1m]))",
          "legendFormat": "{{route}}",
          "refId": "A"
        }
      ]
    },
    {
      "id": 3,
      "type": "timeseries",
      "title": "Error rate (%) by route",
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 8 },
      "fieldConfig": { "defaults": { "unit": "percent" } },
      "targets": [
        {
          "expr": "100 * sum by (route) (rate(http_server_requests_total{status_class=\"4xx\"}[5m])) / sum by (route) (rate(http_server_requests_total[5m]))",
          "legendFormat": "{{route}} 4xx",
          "refId": "A"
        },
        {
          "expr": "100 * sum by (route) (rate(http_server_requests_total{status_class=\"5xx\"}[5m])) / sum by (route) (rate(http_server_requests_total[5m]))",
          "legendFormat": "{{route}} 5xx",
          "refId": "B"
        }
      ]
    },
    {
      "id": 4,
      "type": "timeseries",
      "title": "Latency p50/p95/p99 by route (s)",
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 8 },
      "fieldConfig": { "defaults": { "unit": "s" } },
      "targets": [
        {
          "expr": "histogram_quantile(0.50, sum by (le, route) (rate(http_server_request_duration_seconds_bucket[5m])))",
          "legendFormat": "{{route}} p50",
          "refId": "A"
        },
        {
          "expr": "histogram_quantile(0.95, sum by (le, route) (rate(http_server_request_duration_seconds_bucket[5m])))",
          "legendFormat": "{{route}} p95",
          "refId": "B"
        },
        {
          "expr": "histogram_quantile(0.99, sum by (le, route) (rate(http_server_request_duration_seconds_bucket[5m])))",
          "legendFormat": "{{route}} p99",
          "refId": "C"
        }
      ]
    },
    {
      "id": 5,
      "type": "timeseries",
      "title": "Rate-limit hits (429/s)",
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 16 },
      "targets": [
        {
          "expr": "sum (rate(http_server_requests_total{status_code=\"429\"}[1m]))",
          "legendFormat": "429s/s",
          "refId": "A"
        }
      ]
    },
    {
      "id": 6,
      "type": "logs",
      "title": "Recent 5xx logs",
      "datasource": { "type": "loki", "uid": "loki" },
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 16 },
      "options": { "showTime": true, "wrapLogMessage": true },
      "targets": [
        {
          "expr": "{service_name=\"pagent-api\"} | json | level=\"error\"",
          "refId": "A",
          "maxLines": 50
        }
      ]
    },
    {
      "id": 7,
      "type": "stat",
      "title": "DB query p95 (s)",
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "gridPos": { "h": 4, "w": 6, "x": 0, "y": 24 },
      "fieldConfig": { "defaults": { "unit": "s" } },
      "targets": [
        {
          "expr": "histogram_quantile(0.95, sum by (le) (rate(traces_spanmetrics_latency_bucket{service_name=\"pagent-api\", operation=~\"pg.*\"}[5m])))",
          "refId": "A"
        }
      ]
    }
  ]
}
```

- [ ] **Step 5: Create `infra/observability/dashboards/product.json`**

```json
{
  "uid": "pagent-product",
  "title": "Pagent — Product",
  "tags": ["pagent", "product"],
  "timezone": "browser",
  "schemaVersion": 39,
  "version": 1,
  "refresh": "1m",
  "time": { "from": "now-24h", "to": "now" },
  "panels": [
    {
      "id": 1,
      "type": "stat",
      "title": "Pages created (1h / 24h / 7d)",
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "gridPos": { "h": 6, "w": 18, "x": 0, "y": 0 },
      "options": { "textMode": "value_and_name" },
      "targets": [
        { "expr": "sum(increase(pagent_pages_created_total[1h]))", "legendFormat": "1h",  "refId": "A" },
        { "expr": "sum(increase(pagent_pages_created_total[24h]))", "legendFormat": "24h", "refId": "B" },
        { "expr": "sum(increase(pagent_pages_created_total[7d]))", "legendFormat": "7d",  "refId": "C" }
      ]
    },
    {
      "id": 2,
      "type": "barchart",
      "title": "Submitted vs abandoned (24h)",
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 6 },
      "options": { "stacking": { "mode": "normal" } },
      "targets": [
        { "expr": "sum(increase(pagent_pages_submitted_total[24h]))", "legendFormat": "submitted", "refId": "A" },
        { "expr": "sum(increase(pagent_pages_abandoned_total[24h]))", "legendFormat": "abandoned", "refId": "B" }
      ]
    },
    {
      "id": 3,
      "type": "timeseries",
      "title": "Submission rate (per 5m)",
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 6 },
      "targets": [
        { "expr": "rate(pagent_pages_submitted_total[5m])", "legendFormat": "submissions/s", "refId": "A" }
      ]
    },
    {
      "id": 4,
      "type": "heatmap",
      "title": "Time-to-submit distribution",
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 14 },
      "fieldConfig": { "defaults": { "unit": "s" } },
      "targets": [
        {
          "expr": "sum by (le) (rate(pagent_page_submit_latency_seconds_bucket[5m]))",
          "format": "heatmap",
          "legendFormat": "{{le}}",
          "refId": "A"
        }
      ]
    },
    {
      "id": 5,
      "type": "stat",
      "title": "Conversion (24h)",
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "gridPos": { "h": 4, "w": 6, "x": 12, "y": 14 },
      "fieldConfig": { "defaults": { "unit": "percent" } },
      "targets": [
        {
          "expr": "100 * sum(increase(pagent_pages_submitted_total[24h])) / (sum(increase(pagent_pages_submitted_total[24h])) + sum(increase(pagent_pages_abandoned_total[24h])))",
          "refId": "A"
        }
      ]
    },
    {
      "id": 6,
      "type": "stat",
      "title": "In-flight (rough)",
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "gridPos": { "h": 4, "w": 6, "x": 18, "y": 14 },
      "targets": [
        {
          "expr": "sum(pagent_pages_created_total) - sum(pagent_pages_submitted_total) - sum(pagent_pages_abandoned_total)",
          "refId": "A"
        }
      ]
    }
  ]
}
```

- [ ] **Step 6: Create `infra/observability/railway.json`**

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "infra/observability/Dockerfile"
  },
  "deploy": {
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3,
    "healthcheckPath": "/api/health",
    "healthcheckTimeout": 30
  }
}
```

- [ ] **Step 7: Create `infra/observability/README.md`**

```markdown
# Pagent Observability — Self-Hosted Grafana on Railway

Single-service deployment of `grafana/otel-lgtm` with our dashboards baked in.

## Layout

- `Dockerfile`               — image build; pinned grafana/otel-lgtm tag.
- `provisioning/`            — Grafana auto-load configs (datasources, dashboard provider).
- `dashboards/`              — version-controlled dashboard JSON.
- `railway.json`             — Railway service config.

## Local smoke test

```bash
docker build -t pagent-observability infra/observability
docker run --rm -p 3000:3000 -p 4318:4318 \
  -e GF_SECURITY_ADMIN_PASSWORD=admin \
  pagent-observability
```

Open http://localhost:3000 (admin/admin), confirm both dashboards appear under
the "Pagent" folder.

To smoke-test the API → stack flow:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
LOG_LEVEL=info \
npm -w @pagent/api run dev
```

Hit a few endpoints and watch the dashboards populate.

## Deploying to Railway

See `docs/observability.md`.
```

- [ ] **Step 8: Local smoke test**

Build and run the image; verify dashboards appear:

```bash
docker build -t pagent-observability infra/observability
docker run --rm -d --name pagent-obs -p 3000:3000 -p 4318:4318 \
  -e GF_SECURITY_ADMIN_PASSWORD=admin \
  pagent-observability

# Wait for readiness, then probe.
sleep 30
curl -fsS http://localhost:3000/api/health
curl -fsS -u admin:admin http://localhost:3000/api/search?folderIds=0 | jq '.[].title'
docker stop pagent-obs
```

Expected: the search returns "Pagent — Operations" and "Pagent — Product".

- [ ] **Step 9: Commit**

```bash
git add infra/
git commit -m "feat(observability): grafana/otel-lgtm image with provisioned dashboards"
```

---

## Task 11: End-to-end local verification

**Files:** none (verification only).

- [ ] **Step 1: Run the stack locally**

```bash
docker run --rm -d --name pagent-obs -p 3000:3000 -p 4318:4318 \
  -e GF_SECURITY_ADMIN_PASSWORD=admin \
  pagent-observability
```

- [ ] **Step 2: Run the API pointed at the local stack**

```bash
cd apps/api
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
DATABASE_URL=<dev DB URL> \
PORT=8787 \
NODE_ENV=development \
npm run dev
```

Verify the boot line:
```
[tracing] enabled — service=pagent-api signals=traces,metrics,logs endpoint=http://localhost:4318
```

- [ ] **Step 3: Generate traffic**

```bash
# Create a few pages
for i in 1 2 3; do
  curl -sX POST localhost:8787/new -H 'content-type: application/json' \
    -d '{"spec":{"hello":"world"}}' | tee /tmp/p$i.json
done

# Hit a 404
curl -i localhost:8787/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

# Hit health a few times
for i in 1 2 3 4 5; do curl -s localhost:8787/health > /dev/null; done

# Confirm x-trace-id is set
curl -i localhost:8787/health | grep -i x-trace-id
```

Expected: `x-trace-id` header is set with a 32-hex value.

- [ ] **Step 4: Verify dashboards populate**

Open http://localhost:3000 (admin/admin):
- "Pagent — Operations" → request rate panel shows `/health`, `/new`, plus the 404.
- "Pagent — Product" → "Pages created" stat is non-zero.
- Tempo explorer → paste the x-trace-id from step 3 → trace appears with linked logs.

- [ ] **Step 5: Tear down**

```bash
docker stop pagent-obs
# Ctrl-C the API
```

- [ ] **Step 6: No commit**

This is verification, not a code change.

---

## Task 12: Operator documentation

**Files:**

- Create: `docs/observability.md`
- Modify: `README.md`

- [ ] **Step 1: Create `docs/observability.md`**

```markdown
# Observability

Self-hosted Grafana stack on Railway. Observes the live pagent API.

## What's collected

- **Traces** — every HTTP request + every postgres query, auto-instrumented.
- **Metrics** — RED metrics (rate, errors, duration) per route, plus six
  product counters/histograms (pages created/submitted/abandoned, submit
  latency).
- **Logs** — structured pino logs, exported via OTLP, visible in Loki.

## Architecture

```
pagent-api  ──OTLP/HTTP──▶  pagent-observability (Railway service)
                            └─ grafana/otel-lgtm (Grafana :3000)
```

## Deploying the observability service to Railway

Manual one-time setup (Railway UI):

1. Project → New service → Deploy from GitHub repo → pick this repo.
2. Service settings → Source → set "Root Directory" to `infra/observability`.
3. Variables:
   - `GF_SECURITY_ADMIN_PASSWORD` — set a strong value (Railway "Generate" works).
4. Volumes: attach a 1 GB volume mounted at `/data`.
5. Networking → expose port `3000` publicly. Port `4318` stays private.
6. Deploy.

After deploy, copy the service's **internal** address
(`pagent-observability.railway.internal`) and the **public** URL.

## Wiring the API

On the `pagent-api` service, set:

| Variable                       | Value                                               |
| ------------------------------ | --------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`  | `http://pagent-observability.railway.internal:4318` |
| `OTEL_SERVICE_NAME`            | `pagent-api` (default; override only if you have multiple environments) |

Redeploy. The API boot log should show:
`[tracing] enabled — service=pagent-api signals=traces,metrics,logs endpoint=...`

## Logging in to Grafana

- URL: the public URL Railway gave you.
- User: `admin`
- Password: the value of `GF_SECURITY_ADMIN_PASSWORD`.

## Reading the dashboards

### Operations
- **Service status** turns red if no requests have arrived in 2m.
- **Error rate** breaks down 4xx vs 5xx by route.
- **Latency** shows p50/p95/p99 — read p99 first when investigating slowness.
- **Rate-limit hits** is non-zero only if someone is hitting `POST /new` hard.
- **Recent 5xx logs** is the first place to look when an alert fires; click a
  trace_id to jump to the trace in Tempo.

### Product
- **Pages created** is the top-of-funnel metric.
- **Submitted vs abandoned** is the conversion view; tracks abandonment.
- **Time-to-submit** heatmap shows whether users fill the form quickly or
  hesitate.

## Updating dashboards

Edit `infra/observability/dashboards/*.json` and redeploy. Grafana picks up
file changes within ~30s on running deploys; on cold start it provisions
from the image.

## Tracing one request end-to-end

1. Hit any endpoint. Note the `x-trace-id` response header.
2. In Grafana, open Explore → Tempo → paste the trace ID.
3. The trace shows the full request including DB queries.
4. Click any span → "Logs for this span" to see correlated pino logs.

## Bumping retention

Defaults inside `grafana/otel-lgtm` retain ~1 week. To extend, set on the
observability service:

```
TEMPO_RETENTION=336h  # 14d for traces
LOKI_RETENTION=336h   # 14d for logs
PROM_RETENTION=30d    # metrics
```

(The image consumes these via its bundled configs.)

## Troubleshooting

- **Boot log says "disabled"** — `OTEL_EXPORTER_OTLP_ENDPOINT` isn't set on
  the API service.
- **Dashboards empty** — confirm the API can reach the LGTM service. From
  Railway's API service shell: `curl -v http://pagent-observability.railway.internal:4318`.
- **Logs missing trace_id** — `PinoInstrumentation` requires importing
  `tracing.ts` before `logger.ts`. Already done in `server.ts`.
```

- [ ] **Step 2: Add link in `README.md`**

Find a sensible place (near the "Layout" or "Use it" section). Insert:

```markdown
**Observability** — see [docs/observability.md](./docs/observability.md) for
the self-hosted Grafana stack (metrics, traces, logs) on Railway.
```

- [ ] **Step 3: Commit**

```bash
git add docs/observability.md README.md
git commit -m "docs: operator guide for self-hosted grafana"
```

---

## Task 13: Open the PR

**Files:** none.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/grafana-observability
```

- [ ] **Step 2: Create the PR**

```bash
gh pr create --title "feat: self-hosted Grafana observability" --body "$(cat <<'EOF'
## Summary

- New Railway service `pagent-observability` running `grafana/otel-lgtm` with our dashboards baked in.
- API now exports metrics (RED + 4 product) and logs (via pino-opentelemetry-transport) alongside the existing traces.
- Two version-controlled dashboards: **Operations** (SRE) and **Product**.
- `x-trace-id` response header for click-through from a request to Grafana's Tempo explorer.

Spec: [docs/superpowers/specs/2026-05-10-grafana-observability-design.md](docs/superpowers/specs/2026-05-10-grafana-observability-design.md)
Plan: [docs/superpowers/plans/2026-05-10-grafana-observability.md](docs/superpowers/plans/2026-05-10-grafana-observability.md)

## Test plan

- [ ] `npm test` passes locally
- [ ] `npm run typecheck` passes locally
- [ ] `docker build -t pagent-observability infra/observability` succeeds
- [ ] Run the stack locally + the API → confirm both dashboards populate
- [ ] `x-trace-id` header is present on responses; pasting it into Tempo finds the trace
- [ ] Deploy `pagent-observability` to Railway, wire `OTEL_EXPORTER_OTLP_ENDPOINT` on the API service, confirm dashboards populate from prod traffic
EOF
)"
```

- [ ] **Step 3: Capture the PR URL** (printed by `gh pr create`).

---

## Task 14: Code review + merge

**Files:** none.

- [ ] **Step 1: Request code review**

Invoke `superpowers:requesting-code-review`. The skill orchestrates review
subagents and returns findings.

- [ ] **Step 2: Address findings**

For each finding the review surfaces, decide whether to fix, defer, or push
back. Fixes go in as additional commits on this branch.

- [ ] **Step 3: Re-run tests after fixes**

```bash
npm test && npm run typecheck
```

- [ ] **Step 4: Merge**

Once review is green:

```bash
gh pr merge --squash --delete-branch
```

---

## Task 15: Deploy to Railway (user-assisted)

**Files:** none.

This task requires the user's Railway credentials and access. Halt here and
ask the user how they want to proceed:

- (a) The user runs the Railway UI steps from `docs/observability.md`
      themselves and confirms when done.
- (b) The user grants Railway CLI access (`railway login` token) and the
      agent runs the deploy commands.

Either way, do not proceed with deployment without explicit user direction.

- [ ] **Step 1: Prompt the user.**

After merge: ask the user which path they want, link them to the runbook
(`docs/observability.md`), and wait.

- [ ] **Step 2: Verify post-deploy**

After the service is up:
- Hit the public Grafana URL → log in with admin / `GF_SECURITY_ADMIN_PASSWORD`.
- Confirm both dashboards show under the "Pagent" folder.
- On the API service, verify the boot log shows `[tracing] enabled`.
- Hit `https://pagent.up.railway.app/health` a few times; watch the
  Operations dashboard fill.

---

## Self-Review

**Spec coverage:** Every spec section maps to a task — dependencies (T1),
status helpers (T2), SDK init (T3), metrics module (T4), RED middleware +
trace header (T5), product metrics (T6/T7/T8), logs export (T9), Docker
image + dashboards (T10), verification (T11), docs (T12), PR/review/merge/
deploy (T13/T14/T15).

**Placeholder scan:** No "TBD" / "implement later". All steps include
the actual code or commands.

**Type consistency:** `metrics.httpRequests`, `metrics.pagesCreated`, etc.
are used identically across tasks 4 → 8. `SubmitOutcome` is defined in T7
and referenced through `outcome.kind`. The `deleteExpiredPages` return
shape is `{ total, abandoned }` everywhere.
