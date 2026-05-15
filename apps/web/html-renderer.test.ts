// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { buildScaffoldedHtml, createSandboxedIframe } from './html-renderer.ts';

describe('buildScaffoldedHtml', () => {
  it('wraps the agent body in <!doctype html>', () => {
    const out = buildScaffoldedHtml('<p>x</p>');
    expect(out.startsWith('<!doctype html>')).toBe(true);
  });

  it('includes a charset meta tag', () => {
    const out = buildScaffoldedHtml('<p>x</p>');
    expect(out).toMatch(/<meta charset="utf-8">/);
  });

  it('includes the iframe CSP meta tag', () => {
    const out = buildScaffoldedHtml('<p>x</p>');
    expect(out).toMatch(/<meta http-equiv="Content-Security-Policy"/);
    expect(out).toMatch(/default-src 'none'/);
  });

  it('includes robots noindex,nofollow,noarchive', () => {
    const out = buildScaffoldedHtml('<p>x</p>');
    expect(out).toMatch(/<meta name="robots" content="noindex,nofollow,noarchive">/);
  });

  it('injects the agent body inside <body>', () => {
    const out = buildScaffoldedHtml('<p class="x">hello</p>');
    expect(out).toMatch(/<body>\s*<p class="x">hello<\/p>\s*<\/body>/);
  });

  it('does not interpret the agent body as a template (no double-encoding)', () => {
    const safe = '<div>Hello &amp; goodbye</div>';
    const out = buildScaffoldedHtml(safe);
    expect(out).toContain(safe);
  });
});

describe('createSandboxedIframe', () => {
  it('uses sandbox="" (empty string, no tokens)', () => {
    const iframe = createSandboxedIframe('<p>x</p>');
    expect(iframe.getAttribute('sandbox')).toBe('');
  });

  it('never includes allow-scripts or allow-same-origin', () => {
    const iframe = createSandboxedIframe('<p>x</p>');
    const sandbox = iframe.getAttribute('sandbox') ?? '';
    expect(sandbox).not.toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
  });

  it('sets referrerpolicy="no-referrer"', () => {
    const iframe = createSandboxedIframe('<p>x</p>');
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('sets allow="" (empty Permissions-Policy delegation)', () => {
    const iframe = createSandboxedIframe('<p>x</p>');
    expect(iframe.getAttribute('allow')).toBe('');
  });

  it('sets srcdoc to the scaffolded HTML', () => {
    const iframe = createSandboxedIframe('<p>x</p>');
    expect(iframe.srcdoc).toContain('<p>x</p>');
    expect(iframe.srcdoc).toContain('default-src');
  });

  it('sets a descriptive title', () => {
    const iframe = createSandboxedIframe('<p>x</p>');
    expect(iframe.title.length).toBeGreaterThan(0);
  });
});
