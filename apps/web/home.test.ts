// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_PROMPT } from './home-content.ts';
import './home.ts';

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function setClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

function restoreClipboard(descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
  else Reflect.deleteProperty(navigator, 'clipboard');
}

async function renderHomePage(): Promise<HTMLElement & { updateComplete: Promise<boolean> }> {
  const page = document.createElement('home-page') as HTMLElement & {
    updateComplete: Promise<boolean>;
  };
  document.body.append(page);
  await page.updateComplete;
  return page;
}

afterEach(() => {
  document.body.replaceChildren();
  restoreClipboard(clipboardDescriptor);
});

describe('landing clipboard action', () => {
  it('announces success only after the clipboard write resolves', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    setClipboard(writeText);
    const page = await renderHomePage();
    const button = page.shadowRoot?.querySelector<HTMLButtonElement>('.copy-btn');

    button?.click();
    await vi.waitFor(() => expect(button?.classList.contains('is-copied')).toBe(true));

    expect(writeText).toHaveBeenCalledWith(AGENT_PROMPT);
    expect(button?.getAttribute('aria-live')).toBe('polite');
    expect(page.shadowRoot?.querySelector('[role="alert"]')).toBeNull();
  });

  it('keeps the copy action unannounced and exposes fallback guidance on failure', async () => {
    setClipboard(vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error('denied')));
    const page = await renderHomePage();
    const button = page.shadowRoot?.querySelector<HTMLButtonElement>('.copy-btn');

    button?.click();
    await vi.waitFor(() => expect(page.shadowRoot?.querySelector('[role="alert"]')).not.toBeNull());

    expect(button?.classList.contains('is-copied')).toBe(false);
    expect(button?.getAttribute('aria-live')).toBe('off');
  });
});
