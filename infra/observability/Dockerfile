# Pinned tag for reproducible deploys. Bump deliberately when you want a
# newer Grafana/Tempo/Loki/Prometheus.
FROM grafana/otel-lgtm:0.27.1

# Provisioning: Grafana auto-loads datasources and dashboard providers from
# /etc/grafana/provisioning/, and reads dashboard JSON from whatever path
# the provider config points to (we use /var/lib/grafana/dashboards).
COPY provisioning/ /etc/grafana/provisioning/
COPY dashboards/   /var/lib/grafana/dashboards/

# All persistent state lives under /data — Grafana, Tempo, Loki, Prometheus.
# Mount a Railway volume here or every redeploy wipes dashboards/data.
VOLUME /data

# 3000 = Grafana UI, 4317 = OTLP gRPC, 4318 = OTLP HTTP.
EXPOSE 3000 4317 4318
