import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.ALLOWED_ORIGINS = 'https://renderer.pagent.test';
});

import { app } from '../app.ts';

const rendererOrigin = 'https://renderer.pagent.test';
const privateInput = 'private-viewer-session'.padEnd(32, 'x');

function invalidDocumentRequest(headers: Readonly<Record<string, string>> = {}) {
  const body = new FormData();
  body.set('revision_id', 'invalid');
  body.set('session_token', privateInput);
  return app.request('/v1/viewer/document', {
    method: 'POST',
    headers: { origin: rendererOrigin, ...headers },
    body,
  });
}

describe('browser document failures', () => {
  it('serves a generic sandboxed error document when an allowed renderer asks for HTML', async () => {
    // Given / When
    const response = await invalidDocumentRequest({
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
    });
    // Then
    const document = await response.text();
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')?.toLowerCase()).toBe('text/html; charset=utf-8');
    expect(response.headers.get('x-frame-options')).toBeNull();
    expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts;');
    expect(response.headers.get('content-security-policy')).toContain(
      `frame-ancestors ${rendererOrigin}`,
    );
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(document).not.toContain(privateInput);
    const script = document.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    if (script === undefined) throw new TypeError('Error document has no message bridge');
    const postMessage = vi.fn();
    runInNewContext(script, { parent: { postMessage } });
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'pagent:error' }, rendererOrigin);
  });

  it('preserves JSON errors and framing denial when the client does not request HTML', async () => {
    // Given / When
    const response = await invalidDocumentRequest({ accept: 'application/json' });
    // Then
    expect(response.status).toBe(400);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toBeNull();
    expect(await response.json()).toEqual({ error: 'bad_request' });
  });

  it('keeps error responses unframeable when the requesting origin is not allowed', async () => {
    // Given / When
    const response = await invalidDocumentRequest({
      accept: 'text/html',
      origin: 'https://attacker.test',
    });
    // Then
    expect(response.status).toBe(403);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(await response.json()).toEqual({ error: 'forbidden' });
  });

  it('retains authentication failure status when an owner browser has no session', async () => {
    // Given / When
    const response = await app.request('/v1/owner/document', {
      method: 'POST',
      headers: { origin: rendererOrigin, accept: 'text/html' },
    });
    // Then
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')?.toLowerCase()).toBe('text/html; charset=utf-8');
    expect(response.headers.get('x-frame-options')).toBeNull();
  });
});
