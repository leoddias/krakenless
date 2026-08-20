import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';

/** Installs a `navigator.clipboard` for one test and removes it afterwards. */
function withClipboard(writeText: () => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
}

function removeClipboard(): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: undefined,
    configurable: true,
  });
}

afterEach(() => {
  removeClipboard();
  vi.restoreAllMocks();
});

describe('copyText', () => {
  it('uses the clipboard API when it is available', async () => {
    const writeText = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    withClipboard(writeText);

    await expect(copyText('a1b2c3')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('a1b2c3');
  });

  it('falls back to the selection trick when the API is missing', async () => {
    removeClipboard();
    const exec = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });

    await expect(copyText('a1b2c3')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('falls back when the API refuses, rather than reporting success', async () => {
    withClipboard(vi.fn<() => Promise<void>>().mockRejectedValue(new Error('denied')));
    const exec = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });

    await expect(copyText('a1b2c3')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('reports failure when neither route works', async () => {
    withClipboard(vi.fn<() => Promise<void>>().mockRejectedValue(new Error('denied')));
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn().mockReturnValue(false),
      configurable: true,
    });

    await expect(copyText('a1b2c3')).resolves.toBe(false);
  });

  it('leaves nothing behind in the document', async () => {
    removeClipboard();
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn().mockReturnValue(true),
      configurable: true,
    });

    const before = document.body.childElementCount;
    await copyText('a1b2c3');
    expect(document.body.childElementCount).toBe(before);
  });
});
