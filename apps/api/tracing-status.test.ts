import { describe, expect, it } from 'vitest';
import { describeTracing, tracingBootLog } from './tracing-status.ts';

describe('describeTracing', () => {
  it('returns disabled when endpoint is unset', () => {
    const status = describeTracing({});
    expect(status.enabled).toBe(false);
    if (!status.enabled) {
      expect(status.reason).toContain('OTEL_EXPORTER_OTLP_ENDPOINT not set');
    }
  });

  it('returns enabled with defaults when only endpoint is set', () => {
    const status = describeTracing({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://x.example/otlp' });
    expect(status.enabled).toBe(true);
    if (status.enabled) {
      expect(status.endpoint).toBe('https://x.example/otlp');
      expect(status.serviceName).toBe('pagent-api');
    }
  });

  it('uses OTEL_SERVICE_NAME override when provided', () => {
    const status = describeTracing({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://x.example/otlp',
      OTEL_SERVICE_NAME: 'pagent-api-stage',
    });
    expect(status.enabled).toBe(true);
    if (status.enabled) {
      expect(status.serviceName).toBe('pagent-api-stage');
    }
  });
});

describe('tracingBootLog', () => {
  it('produces a one-line enabled message containing endpoint and service name', () => {
    const line = tracingBootLog({
      enabled: true,
      endpoint: 'https://x.example/otlp',
      serviceName: 'pagent-api-test',
    });
    expect(line).toContain('enabled');
    expect(line).toContain('https://x.example/otlp');
    expect(line).toContain('pagent-api-test');
    expect(line.split('\n').length).toBe(1);
  });

  it('produces a one-line disabled message containing the reason', () => {
    const line = tracingBootLog({
      enabled: false,
      reason: 'OTEL_EXPORTER_OTLP_ENDPOINT not set',
    });
    expect(line).toContain('disabled');
    expect(line).toContain('OTEL_EXPORTER_OTLP_ENDPOINT not set');
    expect(line.split('\n').length).toBe(1);
  });
});
