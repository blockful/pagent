// @vitest-environment happy-dom
import { render } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHomeContent } from './home-content.ts';

describe('landing product story', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('presents one page model through exactly read and write', () => {
    const host = document.createElement('div');
    document.body.append(host);
    render(
      renderHomeContent(false, async () => {}),
      host,
    );

    const copy = host.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    expect(copy).toContain('Give your agent a page. Keep it when it matters.');
    expect(copy).toContain('two tools: write pages and read pages');
    expect(copy).toContain('interactive or view-only');
    expect(copy).toContain('Interactive and document pages are temporary and free with no signup.');
    expect(copy).toContain(
      'A presentation is a durable page with ordered slides, secure sharing, and engagement analytics. It lives in your signed-in workspace.',
    );

    const toolNames = Array.from(host.querySelectorAll('.step:first-of-type code')).map((tool) =>
      tool.textContent?.trim(),
    );
    expect(toolNames).toEqual(['write', 'read']);

    expect(copy).not.toMatch(/show_ui|show_html|check_result|publish_deck/);
  });

  it('limits no-signup claims to temporary pages and exposes workspace entry paths', () => {
    const host = document.createElement('div');
    document.body.append(host);
    render(
      renderHomeContent(false, async () => {}),
      host,
    );

    const copy = host.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    expect(copy).toContain('Interactive and document pages are temporary and free with no signup.');
    expect(copy).toContain('It lives in your signed-in workspace.');

    const workspaceLink = Array.from(host.querySelectorAll('a')).find((link) =>
      link.textContent?.trim().startsWith('Open workspace'),
    );
    const signInLink = Array.from(host.querySelectorAll('a')).find(
      (link) => link.textContent?.trim() === 'Sign in',
    );

    expect(workspaceLink?.getAttribute('href')).toBe('/pages');
    expect(signInLink?.getAttribute('href')).toContain('/oauth/authorize?');
    expect(signInLink?.getAttribute('href')).toContain('browser_session=1');
    expect(signInLink?.getAttribute('href')).toContain('return_to=');

    const signInUrl = new URL(signInLink?.href ?? '', location.origin);
    const returnTo = signInUrl.searchParams.get('return_to');
    expect(returnTo).not.toBeNull();
    expect(new URL(returnTo ?? location.origin).pathname).toBe('/pages');
  });
});
