# Pagent Observability — Self-Hosted Grafana

Single-service deployment of `grafana/otel-lgtm` with our dashboards baked in.
Bundles Grafana + Loki (logs) + Tempo (traces) + Prometheus/Mimir (metrics) +
OTel Collector ingress in one container.

## Layout

```
Dockerfile                       — pinned grafana/otel-lgtm tag + provisioning copy
provisioning/
  datasources.yaml               — Grafana datasources (Prom, Tempo, Loki) wired to bundled localhost ports
  dashboards.yaml                — Grafana dashboard provider config
dashboards/
  operations.json                — SRE dashboard (RED + DB latency + error logs)
  product.json                   — Product dashboard (creation, conversion, abandonment, latency)
railway.json                     — Railway service config
```

## Local smoke test (requires Docker)

```bash
docker build -t pagent-observability infra/observability
docker run --rm -p 3000:3000 -p 4318:4318 \
  -e GF_SECURITY_ADMIN_PASSWORD=admin \
  pagent-observability
```

Open http://localhost:3000 (admin / admin), confirm both dashboards appear
under the **Pagent** folder.

To exercise the API → stack flow, run the API pointing at the local stack:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
LOG_LEVEL=info \
npm -w @pagent/api run dev
```

Hit a few endpoints and watch the dashboards populate.

## Deploying to Railway

See [`docs/observability.md`](../../docs/observability.md) for the full
runbook. Short version:

1. Create a new Railway service from this repo, root directory `infra/observability`.
2. Set `GF_SECURITY_ADMIN_PASSWORD` (Railway secret).
3. Mount a volume at `/data` (1 GB is enough to start).
4. Expose port `3000` publicly. Port `4318` stays private.
5. Wire the API service: `OTEL_EXPORTER_OTLP_ENDPOINT=http://<service>.railway.internal:4318`.
