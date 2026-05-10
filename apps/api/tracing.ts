// OTel bootstrap — imported first by server.ts so that auto-instrumentation
// can wrap http/postgres before they are required. No-op when
// OTEL_EXPORTER_OTLP_ENDPOINT is not set.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint) {
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'pagent-api',
    traceExporter: new OTLPTraceExporter({
      // The exporter appends /v1/traces. Grafana Cloud's gateway accepts the
      // base /otlp path; users set OTEL_EXPORTER_OTLP_ENDPOINT to that base.
      url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
      headers: parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Disable instrumentations we don't need to keep the trace stream lean.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
      }),
      new PinoInstrumentation(),
    ],
  });

  sdk.start();
  process.on('SIGTERM', () => sdk.shutdown().catch(() => {}));
}

function parseOtlpHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const [k, ...rest] = pair.split('=');
    if (k && rest.length) out[k.trim()] = rest.join('=').trim();
  }
  return out;
}
