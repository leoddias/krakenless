import { describe, expect, it } from 'vitest';
import { formatLastOpened, repoErrorMessage, repoName } from './messages';

describe('repoErrorMessage', () => {
  it('names the missing binary and does not offer another folder', () => {
    const message = repoErrorMessage('git-missing');
    expect(message.title).toBe('Git is not installed, or it is not on your PATH.');
    expect(message.canPickAnother).toBe(false);
  });

  it('offers another folder for every recoverable kind', () => {
    for (const kind of ['not-a-repository', 'bad-repo-path', 'timeout', 'whatever']) {
      expect(repoErrorMessage(kind).canPickAnother).toBe(true);
    }
  });

  it('never falls back to a generic apology', () => {
    for (const kind of [undefined, 'command-failed', 'parse-failed']) {
      const { title, hint } = repoErrorMessage(kind);
      expect(title).toContain('repository');
      expect(hint.length).toBeGreaterThan(0);
    }
  });
});

describe('repoName', () => {
  it('takes the last segment of a posix path', () => {
    expect(repoName('/home/leo/code/krakenless')).toBe('krakenless');
  });

  it('takes the last segment of a windows path', () => {
    expect(repoName('C:\\code\\krakenless')).toBe('krakenless');
  });

  it('ignores a trailing separator', () => {
    expect(repoName('C:/code/krakenless/')).toBe('krakenless');
  });

  it('falls back to the whole path when there is no segment', () => {
    expect(repoName('/')).toBe('/');
  });
});

describe('formatLastOpened', () => {
  const now = new Date('2026-08-20T12:00:00.000Z');

  it('reads today, yesterday and days ago', () => {
    expect(formatLastOpened('2026-08-20T08:00:00.000Z', now)).toBe('Opened today');
    expect(formatLastOpened('2026-08-19T08:00:00.000Z', now)).toBe('Opened yesterday');
    expect(formatLastOpened('2026-08-15T12:00:00.000Z', now)).toBe('Opened 5 days ago');
  });

  it('falls back to a date beyond a month', () => {
    expect(formatLastOpened('2026-01-02T12:00:00.000Z', now)).toBe(
      'Opened on 2026-01-02',
    );
  });

  it('handles a clock that moved backwards', () => {
    expect(formatLastOpened('2026-09-01T12:00:00.000Z', now)).toBe('Opened just now');
  });

  it('admits when the stored timestamp is unusable', () => {
    expect(formatLastOpened('not-a-date', now)).toBe('Last opened: unknown');
  });
});
