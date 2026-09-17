// @vitest-environment happy-dom
import { render } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHomeContent } from './home-content.ts';

describe('landing product story', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('renders exactly the two tool names in the connection step', () => {
    const host = document.createElement('div');
    document.body.append(host);
    render(
      renderHomeContent(false, async () => {}),
      host,
    );

    const toolNames = Array.from(host.querySelectorAll('.step:first-of-type code')).map((tool) =>
      tool.textContent?.trim(),
    );
    expect(toolNames).toEqual(['write', 'read']);
  });

  it('exposes authenticated workspace entry paths', () => {
    const host = document.createElement('div');
    document.body.append(host);
    render(
      renderHomeContent(false, async () => {}),
      host,
    );

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

  it('exposes one main landmark and a complete heading hierarchy', () => {
    const host = document.createElement('div');
    document.body.append(host);
    render(
      renderHomeContent(false, async () => {}),
      host,
    );

    expect(host.querySelectorAll('main')).toHaveLength(1);
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelectorAll('h2')).toHaveLength(1);
    expect(host.querySelectorAll('h3')).toHaveLength(3);
  });

  it('announces copy success only in the successful state', () => {
    const host = document.createElement('div');
    document.body.append(host);

    render(
      renderHomeContent(false, async () => {}),
      host,
    );
    expect(host.querySelector('.copy-btn')?.getAttribute('aria-live')).toBe('off');

    render(
      renderHomeContent(true, async () => {}),
      host,
    );
    expect(host.querySelector('.copy-btn')?.getAttribute('aria-live')).toBe('polite');
    expect(host.querySelector('.copy-btn')?.classList.contains('is-copied')).toBe(true);
  });

  it('surfaces clipboard failure guidance as an alert', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const failure = 'clipboard-failure-sentinel';
    render(
      renderHomeContent(false, async () => {}, failure),
      host,
    );

    expect(host.querySelector('[role="alert"]')?.textContent).toBe(failure);
  });
});
