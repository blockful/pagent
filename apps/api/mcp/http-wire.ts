import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ALLOWED_ORIGINS } from '../app.ts';

// Mirrors apps/api/request-id.ts — caller-supplied IDs accepted within bounds,
// otherwise generated.
const REQUEST_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
// Headers a browser-side MCP client might preflight. `Mcp-Session-Id` is
// reserved by the SDK transport even in stateless mode — clients may still
// echo it on resumed sessions.
const CORS_ALLOWED_HEADERS = 'Authorization, Content-Type, Mcp-Session-Id, X-Request-Id';
// Methods the SDK's streamable HTTP transport actually serves.
const CORS_ALLOWED_METHODS = 'GET, POST, DELETE, OPTIONS';

export function getOrCreateRequestId(req: IncomingMessage): string {
  const incoming = req.headers['x-request-id'];
  if (typeof incoming === 'string' && REQUEST_ID_REGEX.test(incoming)) return incoming;
  return randomBytes(16).toString('hex');
}

/**
 * Headers applied to every /mcp response: request-id echo, nosniff, and
 * a CORS Allow-Origin that mirrors the REST CORS policy (allow-list in
 * production, `*` when ALLOWED_ORIGINS is unset for local dev).
 */
export function applyBaseHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
): void {
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    // Always set Vary: Origin when the response varies by Origin — caches
    // in front of the API need this even when the value is `*`.
    res.setHeader('Vary', 'Origin');
    if (!ALLOWED_ORIGINS) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
  }
}

export function applyCorsPreflightHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Methods', CORS_ALLOWED_METHODS);
  res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS);
}

export function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  // Reject early if the caller sent a body without claiming JSON. The SDK
  // would still try to parse it, but failing fast with a clear message
  // beats an opaque downstream error.
  const ct = req.headers['content-type']?.toLowerCase() ?? '';
  if (!ct.startsWith('application/json')) {
    throw new Error(`Content-Type must be application/json (got ${ct ? `"${ct}"` : 'none'})`);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      // Don't destroy the socket — that would tear down the response we're
      // about to send. Just stop accumulating; Node will drain the stream.
      reject(err);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        fail(new Error(`request body exceeds the ${maxBytes}-byte limit`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', (err) => fail(err));
    req.on('aborted', () => fail(new Error('request aborted')));
  });
}
