# Self-Hosted Grafana Observability — Design

Status: approved 2026-05-10, proceeding to implementation plan.

## Goal

Stand up a self-hosted Grafana stack on Railway that observes the live pagent
API, with two version-controlled dashboards: an **Operations** dashboard for
SRE-grade signals and a **Product** dashboard for usage signals. Add the
missing telemetry (metrics, logs export) so the dashboards are populated by
real data.

## Why

The API today exports **traces only**. Logs go to stdout — stuck in Railway's
log tail, invisible to Grafana. There are no metrics. As a result we cannot
answer:

- "How many pages did agents create today?"
- "What's our p95 latency on `POST /new`?"
- "Which routes are throwing 5xx?"

Self-hosted (vs Grafana Cloud) was chosen for cost control, retention control,
and to demonstrate the integration end-to-end. Single-container LGTM was
chosen over separate services for simplicity (one Railway service, one volume,
one URL) — pagent's traffic profile does not justify per-signal scaling.

## Architecture

One new Railway service: `pagent-observability`, running the
`grafana/otel-lgtm` image. Bundles Grafana, Tempo (traces), Mimir-Prometheus
(metrics), Loki (logs), and an OTel Collector ingress on port 4318. Persistent
storage on a Railway volume mounted at `/data`.

The API stays where it is. It exports OTLP/HTTP to the LGTM service over
Railway's **private** network — no public OTLP endpoint, no auth needed on the
ingress.

```
pagent-api  ──OTLP/HTTP──▶  pagent-observability (otel-lgtm)
(Railway)                   ├─ OTel Collector :4318  ◀── private network only
                            ├─ Tempo  (traces)
                            ├─ Prom   (metrics)
                            ├─ Loki   (logs)
                            └─ Grafana :3000  ──▶ public Railway URL
```

Grafana exposed publicly with admin password from a Railway secret.

## API instrumentation

### New: Metrics

OTel Metrics SDK with OTLP HTTP exporter, registered alongside the existing
trace SDK. Six metrics — minimal, sufficient.

| Name                           | Type      | Labels                                   | Purpose                        |
| ------------------------------ | --------- | ---------------------------------------- | ------------------------------ |
| `http.server.requests`         | counter   | method, route, status_class, status_code | request rate + error rate      |
| `http.server.request.duration` | histogram | method, route                            | latency distribution (s)       |
| `pagent.pages.created`         | counter   | —                                        | UI generation rate             |
| `pagent.pages.submitted`       | counter   | —                                        | successful submissions         |
| `pagent.pages.abandoned`       | counter   | —                                        | TTL-expired while still `open` |
| `pagent.page.submit.latency`   | histogram | —                                        | created → submitted timing (s) |

Recorded from:

- `app.ts` middleware bumps `http.server.requests` and
  `http.server.request.duration` on every response.
- `store.createPage` bumps `pagent.pages.created`.
- The `POST /:id/result` handler (on success) bumps
  `pagent.pages.submitted` and observes `pagent.page.submit.latency`
  (`now − created_at`, where `created_at` is read from the page row).
- `db.deleteExpiredPages` bumps `pagent.pages.abandoned` by the count of
  rows deleted in `state='open'`. This requires splitting the current
  single `delete` into a count-then-delete pair (or a `delete ... returning
  state` with aggregation in TS) so we can distinguish abandoned pages
  from already-finalized ones.

### New: Logs export

Pino → OTLP logs via `pino-opentelemetry-transport`. Existing pino logs
already carry `trace_id` / `span_id` (from `PinoInstrumentation`), so
click-through from a trace to its logs in Grafana works out of the box.

### Existing: Traces (keep)

Auto-instrumented HTTP + postgres + pino correlation already works. Add only:

- `x-trace-id` response header populated from the active span context, so an
  operator can curl an endpoint and paste the ID into Grafana's Tempo explorer.

### Skipping (YAGNI)

- Custom spans for business events — auto-instrumentation already produces
  HTTP + DB spans at the right granularity.
- Per-status histograms — counter labels cover the error breakdown.
- DB query metrics — postgres auto-instrumentation already produces spans.

## Dashboards

Both provisioned as JSON in `infra/observability/dashboards/`, version
controlled, applied automatically on Grafana startup.

### Operations dashboard

1. **Service status** — single-stat: green if last metric arrival ≤ 60s.
2. **Request rate by route** — time series, RPS.
3. **Error rate (%) by route** — 4xx and 5xx as separate series.
4. **Latency p50 / p95 / p99 by route** — time series from histogram.
5. **Rate-limit hits** — `status_code="429"` over time.
6. **Recent 5xx logs** — Loki panel, last 50 records, with trace_id
   click-through to Tempo.
7. **DB query p95** — derived from postgres spans via Tempo's span metrics.

### Product dashboard

1. **Pages created** — single-stats over 1h / 24h / 7d.
2. **Submitted vs abandoned (24h)** — stacked bar; the abandonment view.
3. **Submission rate over time** — `rate(pagent_pages_submitted_total[5m])`.
4. **Time-to-submit distribution** — heatmap of
   `pagent_page_submit_latency_seconds`.
5. **Conversion ratio** — `submitted / (submitted + abandoned)` over the
   last 24h.
6. **Active in-flight pages** — `created − submitted − abandoned` (rough
   gauge; pages that are submitted-then-received-then-deleted-at-TTL are
   captured by `submitted`, not `abandoned`).

## Operational

| Concern        | Choice                                                                |
| -------------- | --------------------------------------------------------------------- |
| Image          | `grafana/otel-lgtm` (latest)                                          |
| Persistence    | Railway volume mounted at `/data`                                     |
| Auth           | Grafana admin password via `GF_SECURITY_ADMIN_PASSWORD` Railway secret |
| Public URL     | Railway-generated (`pagent-observability.up.railway.app` or similar)  |
| Retention      | Image defaults (~1 week) — documented as override-able                |
| OTLP auth      | None (private Railway network only)                                   |
| TLS            | Handled by Railway at the edge                                        |

## Files

```
infra/observability/                  (new)
  Dockerfile                          # FROM grafana/otel-lgtm + provisioning
  railway.json                        # Railway service config
  README.md                           # deploy / login / troubleshoot
  dashboards/operations.json          # provisioned dashboard
  dashboards/product.json             # provisioned dashboard
  provisioning/datasources.yaml       # bundled Prom/Tempo/Loki datasources
  provisioning/dashboards.yaml        # dashboard provider config

apps/api/metrics.ts                   # new — Metrics SDK + counters/histograms
apps/api/logs.ts                      # new — pino OTLP transport setup
apps/api/tracing.ts                   # extend — register metrics + logs SDK
apps/api/app.ts                       # + RED middleware, + x-trace-id header
apps/api/db.ts                        # + bump pages.expired
apps/api/store.ts                     # + bump created / submitted / latency
apps/api/.env.example                 # + new vars (metrics endpoint already shared)
apps/api/package.json                 # + @opentelemetry/sdk-metrics
                                      # + @opentelemetry/exporter-metrics-otlp-http
                                      # + @opentelemetry/exporter-logs-otlp-http
                                      # + @opentelemetry/sdk-logs
                                      # + pino-opentelemetry-transport
docs/observability.md                 # operator doc
```

## Out of scope

- SSO / advanced Grafana auth.
- Alerting rules (PagerDuty / email) — dashboards only for v1.
- Multi-environment separation (dev/prod telemetry split).
- Custom Loki / Tempo retention tuning.

## Acceptance criteria

1. New Railway service `pagent-observability` deployed; Grafana reachable at
   the public URL with admin login.
2. API service exports metrics, traces, **and** logs to the LGTM service over
   Railway's internal network.
3. Both dashboards load and display real data after some traffic.
4. Hitting an endpoint returns an `x-trace-id` header that, when pasted into
   Tempo, shows the trace plus its correlated logs.
5. `docs/observability.md` describes how to deploy, how to log in, and how to
   read the dashboards.

## Risks

- **Volume too small.** LGTM defaults can grow quickly under load. Start with
  1 GB; document how to bump.
- **`grafana/otel-lgtm` image upstream changes.** Pin to a specific tag in
  the Dockerfile (not `latest`) so redeploys are reproducible.
- **OTel package version drift.** Metrics + logs SDK packages need to be on
  versions compatible with the existing `@opentelemetry/sdk-node` 0.217.x.
  Pin matching versions during implementation.
