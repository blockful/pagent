import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { documentCsp, documentOrigins, renderHtmlDocument } from './html-document.ts';

const origins = documentOrigins(['https://renderer.pagent.test']);
const origin = origins[0];
if (origin === undefined) throw new TypeError('Test renderer origin is invalid');
const revisionId = '36e8ac8b-bb84-4d24-aee7-bea01f3c7ca8';

function bridgeHarness(revision = revisionId) {
  const origin = origins[0];
  if (origin === undefined) throw new TypeError('Test renderer origin is invalid');
  const messages: { readonly message: unknown; readonly origin: string }[] = [];
  const handlers = new Map<string, (event: { readonly isTrusted: boolean }) => void>();
  const clock = { now: 0 };
  const html = '<!doctype html><html><body><main>Original</main></body></html>';
  const served = renderHtmlDocument(html, origin, revision);
  const script = served.slice(html.length).match(/^\s*<script>([\s\S]*)<\/script>\s*$/)?.[1];
  if (script === undefined) throw new TypeError('Served document has no appended bridge');
  runInNewContext(script, {
    parent: {
      postMessage: (message: unknown, target: string) => messages.push({ message, origin: target }),
    },
    addEventListener: (name: string, handler: (event: { readonly isTrusted: boolean }) => void) =>
      handlers.set(name, handler),
    performance: { now: () => clock.now },
  });
  return { messages, handlers, clock, served, html };
}

describe('HTML document bridge', () => {
  it('preserves the exact source prefix and announces readiness when initialized', () => {
    // Given / When
    const bridge = bridgeHarness();
    // Then
    expect(bridge.served.startsWith(bridge.html)).toBe(true);
    expect(bridge.messages).toEqual([{ message: { type: 'pagent:ready', revisionId }, origin }]);
  });

  it.each(['pointerdown', 'keydown', 'wheel', 'touchstart'])(
    'reports trusted activity when receiving %s',
    (eventName) => {
      // Given
      const bridge = bridgeHarness();
      // When
      bridge.handlers.get(eventName)?.({ isTrusted: true });
      // Then
      expect(bridge.messages.at(-1)).toEqual({ message: { type: 'pagent:activity' }, origin });
    },
  );

  it('ignores synthetic activity when an author script dispatches events', () => {
    // Given
    const bridge = bridgeHarness();
    // When
    for (const handler of bridge.handlers.values()) handler({ isTrusted: false });
    // Then
    expect(bridge.messages).toHaveLength(1);
  });

  it('throttles activity across event types when events are less than one second apart', () => {
    // Given
    const bridge = bridgeHarness();
    bridge.handlers.get('pointerdown')?.({ isTrusted: true });
    bridge.clock.now = 999;
    // When
    bridge.handlers.get('keydown')?.({ isTrusted: true });
    // Then
    expect(bridge.messages).toHaveLength(2);
  });

  it('accepts the next activity when exactly one second elapsed', () => {
    // Given
    const bridge = bridgeHarness();
    bridge.handlers.get('pointerdown')?.({ isTrusted: true });
    bridge.clock.now = 1000;
    // When
    bridge.handlers.get('keydown')?.({ isTrusted: true });
    // Then
    expect(bridge.messages).toHaveLength(3);
  });

  it('serializes data without executable closing tags when a string contains markup', () => {
    // Given
    const unsafe = '</script><script>throw 1</script>\u2028\u2029';
    // When
    const bridge = bridgeHarness(unsafe);
    // Then
    expect(bridge.served.slice(bridge.html.length).match(/<\/script>/g)).toHaveLength(1);
    expect(bridge.messages).toEqual([
      { message: { type: 'pagent:ready', revisionId: unsafe }, origin },
    ]);
  });
});

describe('document renderer origins', () => {
  it('fails closed when no renderer origin is configured', () => {
    // Given / When
    const origins = documentOrigins(undefined);
    // Then
    expect(origins).toEqual([]);
    expect(documentCsp(origins)).toContain("frame-ancestors 'none'");
  });

  it('accepts only exact HTTP origins when configuration contains unsafe values', () => {
    // Given
    const configured = [
      'https://renderer.pagent.test',
      'http://localhost:5173',
      '*',
      'null',
      'https://renderer.pagent.test/path',
      'https://renderer.pagent.test/',
      'https://user:pass@renderer.pagent.test',
      'https://renderer.pagent.test; script-src *',
      'data:text/html,a',
    ];
    // When
    const origins = documentOrigins(configured);
    // Then
    expect(origins).toEqual(['https://renderer.pagent.test', 'http://localhost:5173']);
  });
});
