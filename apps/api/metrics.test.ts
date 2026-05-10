import { describe, expect, it } from 'vitest';
import { metrics, statusClassFor } from './metrics.ts';

describe('statusClassFor', () => {
  it.each([
    [200, '2xx'],
    [201, '2xx'],
    [301, '3xx'],
    [400, '4xx'],
    [404, '4xx'],
    [429, '4xx'],
    [500, '5xx'],
    [503, '5xx'],
  ] as const)('maps %d to %s', (status, expected) => {
    expect(statusClassFor(status)).toBe(expected);
  });

  it('falls back to "5xx" for unexpected codes', () => {
    expect(statusClassFor(0)).toBe('5xx');
    expect(statusClassFor(999)).toBe('5xx');
  });
});

describe('metrics module', () => {
  it('exposes all six instruments with the expected APIs', () => {
    expect(typeof metrics.httpRequests.add).toBe('function');
    expect(typeof metrics.httpRequestDuration.record).toBe('function');
    expect(typeof metrics.pagesCreated.add).toBe('function');
    expect(typeof metrics.pagesSubmitted.add).toBe('function');
    expect(typeof metrics.pagesAbandoned.add).toBe('function');
    expect(typeof metrics.pageSubmitLatency.record).toBe('function');
  });
});
