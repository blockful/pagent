# Observability

Self-hosted Grafana stack on Railway. Observes the live pagent API via
metrics, traces, and logs.

## What's collected

- **Traces** — every HTTP request and every postgres query, auto-instrumented.
- **Metrics** — RED (rate / errors / duration) per route, plus four pagent
  counters/histograms (pages created / submitted / abandoned / submit
  latency).
- **Logs** — structured pino logs, exported via OTLP, queryable in Loki with
  `trace_id` correlation back to Tempo.

## Architecture

```
pagent-api  ──OTLP/HTTP──▶  pagent-observability (Railway service)
                            └─ grafana/otel-lgtm (Grafana :3000, OTLP :4318)
```

One Railway service runs the bundled `grafana/otel-lgtm` image. The API
exports OTLP/HTTP over Railway's **private** network. Grafana itself is
exposed publicly with admin auth.

## Deploying the observability service to Railway

Two paths — pick one.

### A. Railway CLI (reproducible)

From the repo root, with `railway login` already done and the right project
linked:

```bash
# 1. Create the empty service
railway add --service pagent-observability

# 2. Set the admin password (generate a strong one) and the deploy envs.
#    Each of these is required — without them the service either won't be
#    reachable, will leak admin access, or won't load our dashboards.
#      GF_SERVER_HTTP_ADDR=0.0.0.0  — image binds to localhost otherwise;
#                                     Railway's edge sees 502.
#      GF_AUTH_ANONYMOUS_ENABLED=false  — image defaults to anon-admin.
#      PORT=3000  — Railway uses this for both routing and the default port.
#      GF_PATHS_PROVISIONING=/etc/grafana/provisioning  — image sets
#                                     GF_PATHS_HOME=/data/grafana, which
#                                     re-roots provisioning under /data/...;
#                                     this points it back at our baked-in
#                                     /etc/grafana/provisioning tree.
PASS=$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")
for kv in \
  "GF_SECURITY_ADMIN_PASSWORD=$PASS" \
  "GF_SERVER_HTTP_ADDR=0.0.0.0" \
  "GF_AUTH_ANONYMOUS_ENABLED=false" \
  "PORT=3000" \
  "GF_PATHS_PROVISIONING=/etc/grafana/provisioning"; do
  railway variable set "$kv" --service pagent-observability --skip-deploys
done

# 3. Attach a 1 GB volume at /data (link the service first)
railway service link pagent-observability
railway volume add --mount-path /data

# 4. Deploy the Dockerfile (path-as-root makes infra/observability the
#    service's source root, so railway.json's "Dockerfile" path resolves)
railway up ./infra/observability --path-as-root \
  --service pagent-observability --ci

# 5. Expose port 3000 publicly (Grafana UI). 4318 stays private.
railway domain --service pagent-observability --port 3000
```

### B. Railway UI

1. **Project → New service → Empty service.**
2. **Settings → Source → Connect GitHub repo**, root directory
   `infra/observability`.
3. **Variables** (all required):
   - `GF_SECURITY_ADMIN_PASSWORD` — strong random value (Railway's
     "Generate" works).
   - `GF_SERVER_HTTP_ADDR` = `0.0.0.0` — the image binds to `localhost`
     by default; Railway's edge can't reach it without this.
   - `GF_AUTH_ANONYMOUS_ENABLED` = `false` — image defaults to enabling
     anonymous **admin** access (intended for local dev).
   - `PORT` = `3000` — Railway uses this for routing.
   - `GF_PATHS_PROVISIONING` = `/etc/grafana/provisioning` — image sets
     `GF_PATHS_HOME=/data/grafana`, which re-roots provisioning under
     `/data/...`; this points Grafana back at our baked-in tree so the
     Pagent dashboards load.
4. **Volumes:** attach a 1 GB volume mounted at `/data`.
5. **Networking:** expose port `3000` publicly. Ports `4317`/`4318` stay
   private.
6. **Deploy.**

After deploy, copy the service's **internal** address
(`pagent-observability.railway.internal`) and the **public** Grafana URL.

> **Notes on Railway-specific behavior:**
>
> - **No `VOLUME` directive in the Dockerfile.** Railway rejects it with
>   "docker VOLUME at Line N is not supported, use Railway Volumes."
>   Persistence is configured via the Railway Volume API (step 3 above).
> - **`GF_SERVER_HTTP_ADDR=0.0.0.0` is required.** The bundled `grafana.ini` in `grafana/otel-lgtm` binds Grafana to `localhost`, so Railway's reverse-proxy returns `502 Application failed to respond` even though the container is up.
> - **First boot with a fresh volume takes ~2.5 minutes** (the image
>   normally cold-starts in ~10 s without a mount; persisting `/data`
>   slows initial dir creation). Subsequent boots are fast. We omit
>   `healthcheckPath` for that reason — pairing it with a 2-minute window
>   makes cold starts flap. Without a healthcheck, Railway falls back to
>   TCP-on-the-public-port, which is sufficient.

## Wiring the API service

On the existing `pagent-api` service, set:

| Variable                      | Value                                               |
| ----------------------------- | --------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://pagent-observability.railway.internal:4318` |
| `OTEL_SERVICE_NAME`           | `pagent-api` (default)                              |

Redeploy. The API boot log should show:

```
[tracing] enabled — service=pagent-api signals=traces,metrics,logs endpoint=http://pagent-observability.railway.internal:4318
```

## Logging in to Grafana

- **URL:** the public URL Railway assigned the observability service.
- **User:** `admin`
- **Password:** the value of `GF_SECURITY_ADMIN_PASSWORD`.

## Reading the dashboards

### Operations

- **Service status** turns red if no requests have arrived in the last 2 min.
- **Request rate by route** — RPS, broken out per matched route pattern
  (`/`, `/:id`, `/:id/result`, `/health`, etc.).
- **Error rate (%) by route** — 4xx vs 5xx as separate series. Use this to
  spot a single endpoint regressing in isolation.
- **Latency p50 / p95 / p99 by route** — read p99 first when investigating
  slowness; if p50 is fine but p99 spiked, look for tail-latency causes
  (DB contention, retries).
- **Rate-limit hits (429/s)** — non-zero only when someone is hammering
  `POST /new`.
- **Recent error logs** — Loki panel showing the last 50 error/warn lines.
  Each line's `trace_id` is a clickable link into the Tempo explorer.
- **DB query p95** — derived from postgres spans via Tempo's span metrics.

### Product

- **Pages created** (1h / 24h / 7d) — top-of-funnel.
- **Submitted vs abandoned (24h)** — stacked. The abandonment view.
- **Submission rate** — submissions per second over time.
- **Time-to-submit distribution** — heatmap. Reveals whether users fill the
  form quickly or hesitate.
- **Conversion (24h)** — `submitted / (submitted + abandoned)` as a percent.
- **In-flight (rough)** — pages alive but neither submitted nor expired
  yet. Treat as approximate; not a real-time gauge.

## Tracing one request end-to-end

1. Hit any endpoint, e.g. `curl -i https://api.pagent.link/health`.
2. Note the `x-trace-id` response header.
3. In Grafana, **Explore → Tempo → search by trace ID** → paste the value.
4. The trace shows the full HTTP span and any DB queries.
5. Click a span → "Logs for this span" to see the pino lines correlated
   to that request.

## Updating dashboards

Edit `infra/observability/dashboards/*.json` and redeploy. Grafana picks up
file changes within ~30s on running deploys; on cold start it provisions
from the image.

## Bumping retention

Defaults inside `grafana/otel-lgtm` retain ~1 week. To extend, set on the
observability service:

```
TEMPO_RETENTION=336h  # 14d for traces
LOKI_RETENTION=336h   # 14d for logs
PROM_RETENTION=30d    # for metrics
```

(The image consumes these via its bundled configs.)

## Behavior under collector outage

OTLP exporters and the pino transport retry silently with exponential
backoff. The API does **not** block on telemetry — request handling stays
hot even when the observability service is down. In-memory buffers cap at
a few MB per signal; sustained outages cause the oldest data to be
dropped, but nothing leaks back to the user.

## Troubleshooting

- **Boot log says `[tracing] disabled`.**
  `OTEL_EXPORTER_OTLP_ENDPOINT` isn't set on the API service. Confirm the
  variable is on `pagent-api`, not `pagent-observability`.
- **Dashboards empty.**
  The API can't reach the LGTM service. From the API service shell, run
  `curl -v http://pagent-observability.railway.internal:4318` — should
  return `405 Method Not Allowed`, which means the collector is alive.
  If the connection refuses, check the observability service is up.
- **Logs missing trace_id.**
  `PinoInstrumentation` requires `tracing.ts` to be imported before
  `logger.ts`. `server.ts` already does this. If you change the import
  order, that's likely the cause.
- **`x-trace-id` header is absent.**
  Either tracing is disabled (see above) or you're hitting an endpoint
  before the request middleware runs (none should exist — every route is
  behind the middleware).
- **Volume filling up.**
  Increase the Railway volume size, or tune retention (above).
