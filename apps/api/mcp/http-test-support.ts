import { createServer, type RequestListener, type Server } from 'node:http';
import { z } from 'zod';

export const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'fetch', version: '0' },
  },
});

export const MCP_ACCEPT = 'application/json, text/event-stream';

export const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  request_id: z.string().optional(),
});

export const rateLimitResponseSchema = errorResponseSchema.extend({
  retry_after_seconds: z.number(),
});

export async function parseJson<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await res.json());
}

export type StartedServer = {
  readonly server: Server;
  readonly url: URL;
  readonly close: () => Promise<void>;
};

export async function startServer(handler: RequestListener): Promise<StartedServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Test HTTP server did not bind to a TCP port');
  }

  return {
    server,
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
