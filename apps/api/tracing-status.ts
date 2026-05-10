// Pure helpers for describing the tracing configuration at boot time.
// Kept in a separate file so they can be unit-tested without loading the
// OpenTelemetry SDK or any other side-effectful module.

export type TracingStatus =
  | { enabled: true; endpoint: string; serviceName: string }
  | { enabled: false; reason: string };

type TracingEnv = {
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_SERVICE_NAME?: string;
};

export function describeTracing(env: TracingEnv): TracingStatus {
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
  };
}

export function tracingBootLog(status: TracingStatus): string {
  if (status.enabled) {
    return `[tracing] enabled — service=${status.serviceName} endpoint=${status.endpoint}`;
  }
  return `[tracing] disabled — ${status.reason}`;
}
