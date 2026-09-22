// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentFrame } from './document-frame.ts';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('document frame', () => {
  it('posts viewer credentials in the body and allows scripts without same-origin privileges', async () => {
    // Given
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
    const frame = new DocumentFrame();
    frame.sessionToken = 'private-viewer-session';
    frame.revisionId = '00000000-0000-4000-8000-000000000001';
    document.body.append(frame);

    // When
    await frame.updateComplete;
    frame.shadowRoot?.querySelector('iframe')?.dispatchEvent(new Event('load'));

    // Then
    const iframe = frame.shadowRoot?.querySelector('iframe');
    const form = frame.shadowRoot?.querySelector('form');
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe?.getAttribute('src')).toBeNull();
    expect(iframe?.getAttribute('srcdoc')).toBeNull();
    expect(form?.method).toBe('post');
    expect(form?.getAttribute('action')).toBe('/v1/viewer/document');
    expect(form?.target).toBe(iframe?.name);
    expect(
      form === null || form === undefined ? null : new FormData(form).get('session_token'),
    ).toBe('private-viewer-session');
    expect(submit).toHaveBeenCalledOnce();
  });

  it('keeps loading through the initial blank iframe before submitting the protected document', async () => {
    // Given
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
    const { frame, iframe } = await mountFrame();
    expect(submit).not.toHaveBeenCalled();
    // When
    iframe.dispatchEvent(new Event('load'));
    // Then
    expect(submit).toHaveBeenCalledOnce();
    expect(frame.state).toBe('loading');
  });

  it('reveals a loaded document when author policy or raw text prevents telemetry', async () => {
    // Given
    vi.useFakeTimers();
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
    const { frame, iframe } = await mountFrame();
    iframe.dispatchEvent(new Event('load'));
    // When
    iframe.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(15_001);
    await frame.updateComplete;
    // Then
    expect(frame.state).toBe('ready');
    expect(frame.shadowRoot?.querySelector('.frame-status')).toBeNull();
  });

  it('retains a protected-route error when the error document finishes loading', async () => {
    // Given
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
    const { frame, iframe } = await mountFrame();
    iframe.dispatchEvent(new Event('load'));
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'null',
        source: iframe.contentWindow,
        data: { type: 'pagent:error' },
      }),
    );
    // When
    iframe.dispatchEvent(new Event('load'));
    await frame.updateComplete;
    // Then
    expect(frame.state).toBe('error');
    expect(frame.shadowRoot?.querySelector('[role="alert"]')).not.toBeNull();
  });

  it.each(['origin', 'source', 'payload'] as const)(
    'ignores spoofed errors when the %s is invalid',
    async (invalid) => {
      // Given
      vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
      const { frame, iframe } = await mountFrame();
      iframe.dispatchEvent(new Event('load'));
      const message = new MessageEvent('message', {
        origin: invalid === 'origin' ? 'https://attacker.test' : 'null',
        source: invalid === 'source' ? window : iframe.contentWindow,
        data:
          invalid === 'payload'
            ? { type: 'pagent:error', html: '<script>attack()</script>' }
            : { type: 'pagent:error' },
      });
      // When
      window.dispatchEvent(message);
      // Then
      expect(frame.state).toBe('loading');
    },
  );

  it('does not treat an optional telemetry readiness message as a document load', async () => {
    // Given
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
    const { frame, iframe } = await mountFrame();
    iframe.dispatchEvent(new Event('load'));
    // When
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'null',
        source: iframe.contentWindow,
        data: { type: 'pagent:ready', revisionId: frame.revisionId },
      }),
    );
    // Then
    expect(frame.state).toBe('loading');
  });

  it('reports activity when the loaded document emits a valid bridge event', async () => {
    // Given
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
    const { frame, iframe } = await mountFrame();
    const activity = vi.fn();
    frame.addEventListener('document-activity', activity);
    iframe.dispatchEvent(new Event('load'));
    iframe.dispatchEvent(new Event('load'));
    // When
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'null',
        source: iframe.contentWindow,
        data: { type: 'pagent:activity' },
      }),
    );
    // Then
    expect(activity).toHaveBeenCalledOnce();
  });

  it('uses the owner preview endpoint without a viewer token', async () => {
    // Given
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
    const frame = new DocumentFrame();
    frame.deckId = '00000000-0000-4000-8000-000000000002';
    frame.revisionId = '00000000-0000-4000-8000-000000000003';
    document.body.append(frame);

    // When
    await frame.updateComplete;

    // Then
    const form = frame.shadowRoot?.querySelector('form');
    expect(form?.getAttribute('action')).toBe('/v1/owner/document');
    expect(form?.querySelector('[name="session_token"]')).toBeNull();
  });
});

async function mountFrame() {
  const frame = new DocumentFrame();
  frame.sessionToken = 'private-viewer-session';
  frame.revisionId = '00000000-0000-4000-8000-000000000001';
  document.body.append(frame);
  await frame.updateComplete;
  const iframe = frame.shadowRoot?.querySelector('iframe');
  if (iframe === undefined || iframe === null) throw new TypeError('Test iframe was not rendered');
  return { frame, iframe };
}
