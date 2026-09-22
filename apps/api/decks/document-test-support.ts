import { generateKeyPairSync } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll } from 'vitest';
import { app } from '../app.ts';
import { initKeys } from '../auth/jwt.ts';
import { SESSION_COOKIE_NAME } from '../auth/middleware.ts';
import { createSession } from '../auth/session.ts';
import * as db from '../db.ts';
import { publishDeckBodySchema } from './domain.ts';
import { publishDeck } from './repository-decks.ts';
import { createShareLink, grantViewerAccess } from './repository-sharing.ts';
import { initDeckSchema } from './schema.ts';
import { integrationDatabaseUrl } from './test-database.ts';

export const rendererOrigin = 'https://renderer.pagent.test';
export const documentHtml =
  '\n<!doctype html><html><head><style>main { color: red }</style></head><body><main>Exact Olá</main><script>window.deckReady = true</script></body></html>\n';
export const databaseUrl = integrationDatabaseUrl('pagent_html_frame_test');
export const setup = postgres(databaseUrl ?? '', { ssl: false, prepare: false });

export function documentDatabaseLifecycle() {
  beforeAll(async () => {
    await setup`drop schema public cascade`;
    await setup`create schema public`;
    await db.init(databaseUrl ?? '');
    await initDeckSchema(db.database());
    const keys = generateKeyPairSync('ed25519');
    await initKeys(
      keys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
      keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    );
  });
  afterAll(async () => {
    await db.shutdown();
    await setup.end({ timeout: 5 });
  });
}

export async function createDocumentFixture() {
  const owner = await db.upsertUser({
    email: 'frame-owner@pagent.test',
    handle: 'frame-owner',
    name: 'Frame Owner',
    avatarUrl: null,
  });
  const deck = await publishDeck(
    owner,
    publishDeckBodySchema.parse({ title: 'Document', html: documentHtml }),
  );
  const link = await createShareLink(owner.id, deck.deckId, {
    name: 'Review',
    access_mode: 'anyone',
    allowed_emails: [],
    allowed_domains: [],
  });
  const access = await grantViewerAccess({ token: link.token });
  if (access.kind !== 'granted') throw new TypeError('Test viewer access must be granted');
  return {
    ...deck,
    owner,
    linkId: link.id,
    sessionToken: access.sessionToken,
    cookie: `${SESSION_COOKIE_NAME}=${await createSession(owner.id)}`,
  };
}

type DocumentRequest = {
  readonly audience: 'owner' | 'viewer';
  readonly fields: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly origin?: string | null;
};

export function requestDocument(input: DocumentRequest) {
  const body = new FormData();
  for (const [key, value] of Object.entries(input.fields)) body.set(key, value);
  const origin = input.origin === undefined ? rendererOrigin : input.origin;
  return app.request(`/v1/${input.audience}/document`, {
    method: 'POST',
    headers: { ...(origin === null ? {} : { origin }), ...input.headers },
    body,
  });
}
