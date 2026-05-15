import { describe, it, expect } from 'vitest';
import { buildCsp, buildIframeCsp } from './csp.js';

const ALL_DIRECTIVES = [
  'default-src',
  'script-src',
  'style-src',
  'font-src',
  'img-src',
  'connect-src',
  'object-src',
  'form-action',
] as const;

describe('buildCsp', () => {
  it("includes 'self' for connect-src when VITE_API_URL is unset", () => {
    const csp = buildCsp(undefined);
    expect(csp).toContain("connect-src 'self'");
    // Must not accidentally include extra origins.
    const connectDir = csp.split('; ').find((d) => d.startsWith('connect-src'));
    expect(connectDir).toBe("connect-src 'self'");
  });

  it('includes API origin for connect-src when VITE_API_URL is set', () => {
    const csp = buildCsp('https://pagent.up.railway.app');
    expect(csp).toContain("connect-src 'self' https://pagent.up.railway.app");
  });

  it('strips path and query from VITE_API_URL (uses origin only)', () => {
    const csp = buildCsp('https://api.example.com/path?x=1');
    expect(csp).toContain("connect-src 'self' https://api.example.com");
    expect(csp).not.toContain('/path');
    expect(csp).not.toContain('?x=1');
  });

  it("falls back to 'self' on malformed VITE_API_URL", () => {
    const csp = buildCsp('not a url');
    const connectDir = csp.split('; ').find((d) => d.startsWith('connect-src'));
    expect(connectDir).toBe("connect-src 'self'");
  });

  it('contains all required directives regardless of VITE_API_URL value', () => {
    for (const apiUrl of [undefined, 'https://pagent.up.railway.app', 'not a url']) {
      const csp = buildCsp(apiUrl);
      for (const directive of ALL_DIRECTIVES) {
        expect(csp, `missing ${directive} for apiUrl=${apiUrl}`).toContain(directive);
      }
    }
  });
});

describe('buildIframeCsp', () => {
  const csp = buildIframeCsp();

  it("sets default-src 'none'", () => {
    expect(csp).toMatch(/default-src 'none'/);
  });

  it("allows img-src 'self' data:", () => {
    expect(csp).toMatch(/img-src 'self' data:/);
  });

  it("allows style-src 'unsafe-inline' only (no external)", () => {
    expect(csp).toMatch(/style-src 'unsafe-inline'/);
    expect(csp).not.toMatch(/style-src[^;]*https:/);
  });

  it('allows font-src data: only', () => {
    expect(csp).toMatch(/font-src data:/);
    expect(csp).not.toMatch(/font-src[^;]*https:/);
  });

  it("blocks form submission via form-action 'none'", () => {
    expect(csp).toMatch(/form-action 'none'/);
  });

  it("blocks nested iframes via frame-src 'none'", () => {
    expect(csp).toMatch(/frame-src 'none'/);
  });

  it("blocks base-uri rewriting via base-uri 'none'", () => {
    expect(csp).toMatch(/base-uri 'none'/);
  });

  it('declares sandbox', () => {
    expect(csp).toMatch(/(^|; )sandbox(;|$)/);
  });

  it('does not enable scripts (no script-src directive)', () => {
    // default-src 'none' covers script-src by default; explicit script-src
    // would be a regression — assert absence.
    expect(csp).not.toMatch(/script-src/);
  });

  it('does not include frame-ancestors (handled upstream by shell X-Frame-Options)', () => {
    expect(csp).not.toMatch(/frame-ancestors/);
  });
});
