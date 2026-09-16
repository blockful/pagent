import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { SignJWT, importPKCS8 } from 'jose';
import { z } from 'zod';

export const API_PUBLIC_URL = 'https://api.example.test';
export const RENDERER_URL = 'https://renderer.example.test';
export const mcpCreatedPageSchema = z.object({
  structuredContent: z.object({
    page_id: z.string().regex(/^[a-f0-9]{32}$/),
    url: z.string().url(),
  }),
});
export const mcpResultSchema = z.object({
  structuredContent: z.object({
    state: z.literal('open'),
    result: z.null(),
    format: z.literal('a2ui'),
    page_id: z.string(),
  }),
});

type AuthServer = {
  readonly localUrl: string;
  readonly privateKeyPem: string;
  readonly stop: () => Promise<void>;
};

type TokenClaims = {
  readonly userId: string;
  readonly email: string;
  readonly handle: string;
  readonly scope: string;
};

class AuthServerStartError extends Error {
  constructor(readonly output: string) {
    super(`Production auth API did not become healthy:\n${output}`);
    this.name = 'AuthServerStartError';
  }
}

function pemBodyAsBase64Url(pem: string): string {
  const body = pem
    .split('\n')
    .filter((line) => !line.startsWith('-----') && line.length > 0)
    .join('');
  return Buffer.from(body, 'base64').toString('base64url');
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new TypeError('Could not resolve an available localhost port');
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const drained = await Promise.race([exited.then(() => true), delay(12_000).then(() => false)]);
  if (drained) return;
  const forcedExit = once(child, 'exit');
  child.kill('SIGKILL');
  await forcedExit;
}

export async function startProductionAuthServer(databaseUrl: string): Promise<AuthServer> {
  const port = await availablePort();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  });
  const child = spawn('npm', ['-w', '@pagent/api', 'run', 'start'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PORT: String(port),
      NODE_ENV: 'production',
      REQUIRE_AUTH: 'true',
      PUBLIC_URL: `${RENDERER_URL}/`,
      API_PUBLIC_URL: `${API_PUBLIC_URL}/`,
      ALLOWED_ORIGINS: RENDERER_URL,
      AUTH_STATE_SECRET: randomBytes(32).toString('base64url'),
      JWT_SIGNING_KEY: pemBodyAsBase64Url(privateKey),
      JWT_PUBLIC_KEY: pemBodyAsBase64Url(publicKey),
      GOOGLE_CLIENT_ID: 'e2e-google-client.invalid',
      GOOGLE_CLIENT_SECRET: 'e2e-google-secret',
      GOOGLE_REDIRECT_URI: `${API_PUBLIC_URL}/oauth/callback/google`,
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1',
      SMTP_USER: 'e2e-smtp-user',
      SMTP_PASS: 'e2e-smtp-password',
      SMTP_FROM: 'e2e@example.test',
      TRUSTED_PROXY_MODE: 'railway',
      LOG_LEVEL: 'silent',
      OTEL_SDK_DISABLED: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const localUrl = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`${localUrl}/health`);
        const healthy = response.ok;
        await response.text();
        if (healthy) return { localUrl, privateKeyPem: privateKey, stop: () => stopProcess(child) };
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
      await delay(200);
    }
    throw new AuthServerStartError(output);
  } catch (error) {
    await stopProcess(child);
    throw error;
  }
}

export async function signAccessToken(privateKeyPem: string, claims: TokenClaims): Promise<string> {
  const key = await importPKCS8(privateKeyPem, 'EdDSA');
  return new SignJWT({
    email: claims.email,
    handle: claims.handle,
    client_id: 'production-auth-e2e',
    scope: claims.scope,
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid: 'production-auth-e2e' })
    .setIssuer(API_PUBLIC_URL)
    .setAudience(API_PUBLIC_URL)
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .setJti(randomUUID())
    .sign(key);
}

export async function connectStdioClient(localUrl: string, token: string): Promise<Client> {
  const client = new Client({ name: 'pagent-auth-e2e', version: '0.0.1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['apps/mcp/server.bundle.js'],
      cwd: process.cwd(),
      env: { ...getDefaultEnvironment(), PAGENT_URL: localUrl, PAGENT_TOKEN: token },
      stderr: 'pipe',
    }),
  );
  return client;
}
