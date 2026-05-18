/**
 * OAuth dynamic client registration store tests.
 *
 * Unit tests for the validation + mapping layer. The DB layer (db.ts) is
 * mocked so we can exercise registerClient/getClient without a live Postgres.
 * The route-level tests (POST /oauth/register, including rate limit) live in
 * routes.test.ts where the full Hono app is available.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.ts', () => ({
  insertOAuthClient: vi.fn(),
  getOAuthClientById: vi.fn(),
}));

import * as db from '../db.ts';
import { registerClient, getClient, InvalidClientMetadataError } from './clients-store.ts';

type Row = Awaited<ReturnType<typeof db.insertOAuthClient>>;

const NOW = new Date('2026-05-17T12:00:00Z');

/** Build a row shaped like what db.insertOAuthClient returns. */
function row(overrides: Partial<Row> = {}): Row {
  return {
    client_id: 'a1b2c3d4-e5f6-4321-9876-abcdef012345',
    client_secret: null,
    client_secret_expires_at: null,
    client_id_issued_at: NOW,
    client_name: null,
    client_uri: null,
    logo_uri: null,
    redirect_uris: ['http://localhost:9876/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: null,
    token_endpoint_auth_method: 'none',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// registerClient — happy path
// ---------------------------------------------------------------------------

describe('registerClient', () => {
  it('inserts the client and returns OAuthClientInformationFull', async () => {
    vi.mocked(db.insertOAuthClient).mockResolvedValueOnce(row({ client_name: 'Claude Code' }));

    const result = await registerClient({
      redirect_uris: ['http://localhost:9876/callback'],
      client_name: 'Claude Code',
    });

    expect(result.client_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.client_name).toBe('Claude Code');
    expect(result.redirect_uris).toEqual(['http://localhost:9876/callback']);
    expect(result.token_endpoint_auth_method).toBe('none');
    expect(result.client_id_issued_at).toBe(Math.floor(NOW.getTime() / 1000));
    // No client_secret for public clients.
    expect(result.client_secret).toBeUndefined();
    expect(result.client_secret_expires_at).toBeUndefined();
  });

  it('defaults grant_types and response_types when caller omits them', async () => {
    vi.mocked(db.insertOAuthClient).mockResolvedValueOnce(row());

    await registerClient({ redirect_uris: ['http://localhost:9876/callback'] });

    expect(db.insertOAuthClient).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(db.insertOAuthClient).mock.calls[0]![0];
    expect(arg.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(arg.response_types).toEqual(['code']);
    expect(arg.token_endpoint_auth_method).toBe('none');
  });

  it('passes through caller-provided grant_types/response_types', async () => {
    vi.mocked(db.insertOAuthClient).mockResolvedValueOnce(
      row({ grant_types: ['refresh_token'], response_types: ['code'] }),
    );

    await registerClient({
      redirect_uris: ['http://localhost:9876/callback'],
      grant_types: ['refresh_token'],
      response_types: ['code'],
    });

    const arg = vi.mocked(db.insertOAuthClient).mock.calls[0]![0];
    expect(arg.grant_types).toEqual(['refresh_token']);
    expect(arg.response_types).toEqual(['code']);
  });

  it('client_id is a fresh UUID per call', async () => {
    vi.mocked(db.insertOAuthClient).mockImplementation(async (input) =>
      row({ client_id: input.client_id }),
    );

    const a = await registerClient({ redirect_uris: ['http://localhost/cb'] });
    const b = await registerClient({ redirect_uris: ['http://localhost/cb'] });

    expect(a.client_id).not.toBe(b.client_id);
  });

  it('client_id_issued_at is Unix seconds, not milliseconds or ISO', async () => {
    vi.mocked(db.insertOAuthClient).mockResolvedValueOnce(row());
    const result = await registerClient({
      redirect_uris: ['http://localhost:9876/callback'],
    });
    expect(typeof result.client_id_issued_at).toBe('number');
    expect(result.client_id_issued_at).toBe(Math.floor(NOW.getTime() / 1000));
    // Sanity: Unix seconds for 2026-05-17 is ~1.78e9, not ms (~1.78e12).
    expect(result.client_id_issued_at).toBeLessThan(2_000_000_000);
  });
});

// ---------------------------------------------------------------------------
// registerClient — validation failures
// ---------------------------------------------------------------------------

describe('registerClient validation', () => {
  it('rejects request body that is not an object', async () => {
    await expect(registerClient(null)).rejects.toBeInstanceOf(InvalidClientMetadataError);
    await expect(registerClient('string')).rejects.toBeInstanceOf(InvalidClientMetadataError);
    await expect(registerClient(42)).rejects.toBeInstanceOf(InvalidClientMetadataError);
    expect(db.insertOAuthClient).not.toHaveBeenCalled();
  });

  it('rejects missing redirect_uris', async () => {
    await expect(registerClient({})).rejects.toThrow(/redirect_uris/);
    expect(db.insertOAuthClient).not.toHaveBeenCalled();
  });

  it('rejects redirect_uris that is not an array', async () => {
    await expect(registerClient({ redirect_uris: 'http://localhost/cb' })).rejects.toThrow(
      /redirect_uris/,
    );
  });

  it('rejects empty redirect_uris array', async () => {
    await expect(registerClient({ redirect_uris: [] })).rejects.toThrow(/non-empty/);
  });

  it('rejects redirect_uris with invalid URI', async () => {
    await expect(registerClient({ redirect_uris: ['not a uri'] })).rejects.toBeInstanceOf(
      InvalidClientMetadataError,
    );
    await expect(registerClient({ redirect_uris: ['http://ok/cb', ''] })).rejects.toBeInstanceOf(
      InvalidClientMetadataError,
    );
    await expect(
      registerClient({ redirect_uris: ['http://ok/cb', null as unknown as string] }),
    ).rejects.toBeInstanceOf(InvalidClientMetadataError);
  });

  it('accepts custom URI schemes (MCP clients commonly use myapp:// etc.)', async () => {
    vi.mocked(db.insertOAuthClient).mockResolvedValueOnce(
      row({ redirect_uris: ['myapp://callback'] }),
    );
    await expect(registerClient({ redirect_uris: ['myapp://callback'] })).resolves.toBeDefined();
  });

  it('rejects non-array grant_types', async () => {
    await expect(
      registerClient({
        redirect_uris: ['http://localhost/cb'],
        grant_types: 'authorization_code',
      }),
    ).rejects.toThrow(/grant_types/);
  });

  it('rejects non-string entries in grant_types', async () => {
    await expect(
      registerClient({
        redirect_uris: ['http://localhost/cb'],
        grant_types: [42],
      }),
    ).rejects.toThrow(/grant_types/);
  });

  it('rejects non-string client_name', async () => {
    await expect(
      registerClient({
        redirect_uris: ['http://localhost/cb'],
        client_name: 42,
      }),
    ).rejects.toThrow(/client_name/);
  });
});

// ---------------------------------------------------------------------------
// getClient
// ---------------------------------------------------------------------------

describe('getClient', () => {
  it('returns the registered client', async () => {
    vi.mocked(db.getOAuthClientById).mockResolvedValueOnce(row({ client_name: 'Claude Code' }));

    const result = await getClient('a1b2c3d4-e5f6-4321-9876-abcdef012345');

    expect(result).toBeDefined();
    expect(result!.client_id).toBe('a1b2c3d4-e5f6-4321-9876-abcdef012345');
    expect(result!.client_name).toBe('Claude Code');
    expect(result!.redirect_uris).toEqual(['http://localhost:9876/callback']);
  });

  it('returns undefined for unknown client_id', async () => {
    vi.mocked(db.getOAuthClientById).mockResolvedValueOnce(null);

    const result = await getClient('not-a-real-id');

    expect(result).toBeUndefined();
  });

  it('exposes client_secret + expiry when row has them (confidential clients)', async () => {
    vi.mocked(db.getOAuthClientById).mockResolvedValueOnce(
      row({
        client_secret: 'shhh',
        client_secret_expires_at: new Date('2027-01-01T00:00:00Z'),
      }),
    );

    const result = await getClient('a-confidential-client');

    expect(result!.client_secret).toBe('shhh');
    expect(result!.client_secret_expires_at).toBe(
      Math.floor(new Date('2027-01-01T00:00:00Z').getTime() / 1000),
    );
  });

  it('omits null scalar fields from the result (no scope, no client_name)', async () => {
    vi.mocked(db.getOAuthClientById).mockResolvedValueOnce(row());

    const result = await getClient('x');

    expect(result!.client_name).toBeUndefined();
    expect(result!.client_uri).toBeUndefined();
    expect(result!.logo_uri).toBeUndefined();
    expect(result!.scope).toBeUndefined();
  });
});
