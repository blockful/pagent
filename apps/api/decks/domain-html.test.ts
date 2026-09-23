import { describe, expect, it } from 'vitest';
import { HTML_MAX_BYTES } from '../limits.ts';
import { publishDeckBodySchema } from './domain.ts';

describe('HTML deck publishing boundary', () => {
  it('preserves a full document exactly when HTML is submitted', () => {
    // Given
    const html =
      '\n<!doctype html><html><head><style>body { color: red }</style></head><body><script>window.ready = true</script><main>Olá</main></body></html>\n';

    // When
    const result = publishDeckBodySchema.safeParse({ title: 'Document', html });

    // Then
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ title: 'Document', html });
  });

  it('rejects ambiguous content when HTML and slides are both submitted', () => {
    // Given
    const input = {
      title: 'Ambiguous',
      html: '<main>HTML</main>',
      slides: [{ id: 'one', html: '<h1>Slide</h1>' }],
    };

    // When
    const result = publishDeckBodySchema.safeParse(input);

    // Then
    expect(result.success).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['a NUL byte', '<main>Before\u0000after</main>'],
    ['ASCII bytes over the limit', 'a'.repeat(HTML_MAX_BYTES + 1)],
    ['multibyte bytes over the limit', 'é'.repeat(HTML_MAX_BYTES / 2 + 1)],
  ])('rejects HTML when it contains %s', (_description, html) => {
    // Given / When
    const result = publishDeckBodySchema.safeParse({ title: 'Boundary', html });

    // Then
    expect(result.success).toBe(false);
  });

  it('accepts HTML when its UTF-8 size is exactly the limit', () => {
    // Given
    const html = 'é'.repeat(HTML_MAX_BYTES / 2);

    // When
    const result = publishDeckBodySchema.safeParse({ title: 'Boundary', html });

    // Then
    expect(result.success).toBe(true);
  });
});
