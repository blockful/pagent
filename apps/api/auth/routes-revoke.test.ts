import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE, NOW, app, db } from './routes-test-support.ts';

const TOKEN_CLIENT_ID = 'b1c2d3e4-f5a6-7890-1234-bcdef0123456';
const TOKEN_USER_ID = '22222222-3333-4444-5555-666666666666';

function postRevoke(
  body: Record<string, string>,
  opts: { contentType?: 'form' | 'json'; xRealIp?: string } = {},
): Request {
  const headers: Record<string, string> = {};
  let serialized: string;
  if (opts.contentType === 'json') {
    headers['Content-Type'] = 'application/json';
    serialized = JSON.stringify(body);
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    serialized = new URLSearchParams(body).toString();
  }
  if (opts.xRealIp !== undefined) headers['x-real-ip'] = opts.xRealIp;
  return new Request(`${BASE}/oauth/revoke`, { method: 'POST', headers, body: serialized });
}

describe('POST /oauth/revoke', () => {
  beforeEach(() => {
    vi.mocked(db.getRefreshTokenByHash).mockReset();
    vi.mocked(db.revokeAllRefreshTokensForFamily).mockReset();
  });

  it('returns 200 with no body for a successful revocation', async () => {
    vi.mocked(db.getRefreshTokenByHash).mockResolvedValueOnce({
      id: 'rt-row',
      user_id: TOKEN_USER_ID,
      client_id: TOKEN_CLIENT_ID,
      family_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      token_hash: 'irrelevant',
      scope: null,
      created_at: NOW,
      expires_at: new Date(Date.now() + 86400_000),
      revoked_at: null,
    });
    const res = await app.fetch(
      postRevoke({ token: 'rt_abc', client_id: TOKEN_CLIENT_ID }, { xRealIp: '10.2.0.1' }),
    );
    expect(res.status).toBe(200);
    expect(db.revokeAllRefreshTokensForFamily).toHaveBeenCalledWith(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    );
  });

  it('returns 200 even when the token is unknown (RFC 7009 §2.2)', async () => {
    vi.mocked(db.getRefreshTokenByHash).mockResolvedValueOnce(null);
    const res = await app.fetch(postRevoke({ token: 'rt_unknown' }, { xRealIp: '10.2.0.2' }));
    expect(res.status).toBe(200);
    expect(db.revokeAllRefreshTokensForFamily).not.toHaveBeenCalled();
  });

  it('returns 200 when the body is empty (no token field)', async () => {
    const res = await app.fetch(postRevoke({}, { xRealIp: '10.2.0.3' }));
    expect(res.status).toBe(200);
    expect(db.getRefreshTokenByHash).not.toHaveBeenCalled();
  });

  it('returns 200 even for a malformed JSON body (degrades to no-op)', async () => {
    const res = await app.fetch(
      postRevoke({ token: 'rt_anything' }, { contentType: 'json', xRealIp: '10.2.0.4' }),
    );
    expect(res.status).toBe(200);
    expect(db.revokeAllRefreshTokensForFamily).not.toHaveBeenCalled();
  });
});
