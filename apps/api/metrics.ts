// Centralized OTel metric instruments. Other modules import these names —
// they don't talk to the OTel API directly. Disabled-mode is handled by the
// global no-op MeterProvider that the API ships with when the SDK isn't
// started, so calls here are safe regardless of whether tracing.ts wired up
// the real provider.
import { metrics as otelMetrics } from '@opentelemetry/api';

const meter = otelMetrics.getMeter('pagent-api');

export const metrics = {
  httpRequests: meter.createCounter('http.server.requests', {
    description: 'Count of HTTP requests by method, route, and status',
  }),
  httpRequestDuration: meter.createHistogram('http.server.request.duration', {
    description: 'Duration of HTTP requests',
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

export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx';

// Bucket an HTTP status code into a metric label. Falls back to "5xx" for
// out-of-range codes so we never silently drop a measurement.
export function statusClassFor(status: number): StatusClass {
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 300 && status < 400) return '3xx';
  if (status >= 400 && status < 500) return '4xx';
  return '5xx';
}
