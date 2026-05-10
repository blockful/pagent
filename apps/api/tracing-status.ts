// Pure helpers for describing the OpenTelemetry configuration at boot time.
// Kept in a separate file so they can be unit-tested without loading the
// OpenTelemetry SDK or any other side-effectful module.

export type TelemetrySignal = 'traces' | 'metrics' | 'logs';

export type TracingStatus =
  | {
      enabled: true;
      endpoint: string;
      serviceName: string;
      signals: TelemetrySignal[];
    }
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
    signals: ['traces', 'metrics', 'logs'],
  };
}

export function tracingBootLog(status: TracingStatus): string {
  if (status.enabled) {
    return `[tracing] enabled — service=${status.serviceName} signals=${status.signals.join(',')} endpoint=${status.endpoint}`;
  }
  return `[tracing] disabled — ${status.reason}`;
}
