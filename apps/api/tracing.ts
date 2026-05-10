// OTel bootstrap — imported first by server.ts so that auto-instrumentation
// can wrap http/postgres before they are required. No-op when
// OTEL_EXPORTER_OTLP_ENDPOINT is not set.
//
// Uses console.log (not the pino logger) for the boot line because this
// module loads before pino is instrumented by PinoInstrumentation.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { env } from './schemas.ts';
import { describeTracing, tracingBootLog } from './tracing-status.ts';

const status = describeTracing(env);

let sdk: NodeSDK | undefined;

if (status.enabled) {
  sdk = new NodeSDK({
    serviceName: status.serviceName,
    traceExporter: new OTLPTraceExporter({
      // The exporter appends /v1/traces. Grafana Cloud's gateway accepts the
      // base /otlp path; users set OTEL_EXPORTER_OTLP_ENDPOINT to that base.
      url: `${status.endpoint.replace(/\/$/, '')}/v1/traces`,
      headers: parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
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
}

console.log(tracingBootLog(status));

export async function shutdownTracing(): Promise<void> {
  if (sdk) await sdk.shutdown();
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
