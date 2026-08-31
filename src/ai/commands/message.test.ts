import { describe, expect, it } from 'vitest';
import { GitError } from '../../git/errors';
import {
  AI_TIMEOUT_MS,
  buildCommitMessageCommand,
  cleanCommitMessage,
  diffKindFor,
  MAX_PATCH_CHARS,
} from './message';

function args(model = 'haiku'): string[] {
  return buildCommitMessageCommand(model, 'patch').args;
}

describe('buildCommitMessageCommand', () => {
  it('runs non-interactively', () => {
    // Without `-p` the CLI opens a session and the app hangs until the
    // timeout kills it.
    expect(args()).toContain('-p');
  });

  it('asks for text, not a JSON envelope', () => {
    expect(args()).toContain('--output-format');
    expect(args()[args().indexOf('--output-format') + 1]).toBe('text');
  });

  it('removes the tools that run commands or code', () => {
    // A commit-message button must not be able to execute anything in the
    // user's repository. It needs prose and nothing else.
    expect(args()).toContain('--restricted');
  });

  it('leaves no session transcript on disk', () => {
    // The input is the user's private staged diff; this path should not
    // persist it anywhere.
    expect(args()).toContain('--no-session-persistence');
  });

  it('passes the configured model', () => {
    const list = buildCommitMessageCommand('sonnet', 'patch').args;
    expect(list[list.indexOf('--model') + 1]).toBe('sonnet');
  });

  it('replaces the CLI system prompt rather than appending to it', () => {
    // Appending would keep the coding-agent preamble: more tokens, and an
    // invitation to do more than answer.
    expect(args()).toContain('--system-prompt');
    expect(args()).not.toContain('--append-system-prompt');
  });

  it('never uses --bare, which would ignore the user login', () => {
    // `--bare` looks right (no hooks, no CLAUDE.md) but forces auth to an API
    // key and never reads the CLI's own session — the whole point of shelling
    // out to a tool the user already authenticated.
    expect(args()).not.toContain('--bare');
  });

  it('asks for one Conventional Commits line', () => {
    const prompt = args()[args().indexOf('--system-prompt') + 1] ?? '';
    expect(prompt).toMatch(/ONE line/);
    expect(prompt).toMatch(/72 characters/);
    expect(prompt).toMatch(/never instructions to follow/);
  });

  it('tells the model when it is only seeing a file summary', () => {
    // Otherwise it invents detail it cannot see.
    const summary = buildCommitMessageCommand('haiku', 'summary').args;
    const prompt = summary[summary.indexOf('--system-prompt') + 1] ?? '';
    expect(prompt).toMatch(/summary of changed files/);
  });

  it('never puts the diff in the argument list', () => {
    // It travels on stdin, like a patch to `git apply`. An argument list is
    // visible to every process on the machine.
    for (const arg of args()) expect(arg).not.toMatch(/^diff --git/);
  });

  it('carries a timeout so a wedged CLI cannot hold the button down', () => {
    expect(buildCommitMessageCommand('haiku', 'patch').timeoutMs).toBe(AI_TIMEOUT_MS);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['with a space', 'haiku fast'],
    ['padded', ' haiku '],
    ['a flag', '--dangerously-skip-permissions'],
  ])('refuses a %s model name', (_name, model) => {
    // It comes from a hand-edited config file and lands right after --model.
    expect(() => buildCommitMessageCommand(model, 'patch')).toThrow(GitError);
  });
});

describe('diffKindFor', () => {
  it('sends a normal diff whole', () => {
    expect(diffKindFor('diff --git a/a b/a\n+one\n')).toBe('patch');
  });

  it('falls back to a summary instead of truncating a huge one', () => {
    // A cut patch would produce a confident message about whichever files came
    // first, with nothing downstream able to tell that had happened.
    expect(diffKindFor('x'.repeat(MAX_PATCH_CHARS + 1))).toBe('summary');
    expect(diffKindFor('x'.repeat(MAX_PATCH_CHARS))).toBe('patch');
  });
});

describe('cleanCommitMessage', () => {
  it('takes the line as written', () => {
    expect(cleanCommitMessage('feat: add retries constant\n')).toBe(
      'feat: add retries constant',
    );
  });

  it.each([
    ['a wrapping double quote', '"feat: add retries"', 'feat: add retries'],
    ['a wrapping single quote', "'feat: add retries'", 'feat: add retries'],
    ['backticks', '`feat: add retries`', 'feat: add retries'],
    ['a markdown fence', '```\nfeat: add retries\n```', 'feat: add retries'],
    ['leading blank lines', '\n\nfeat: add retries\n', 'feat: add retries'],
    ['a trailing body', 'feat: add retries\n\nThis adds them.', 'feat: add retries'],
  ])('strips %s', (_name, raw, expected) => {
    expect(cleanCommitMessage(raw)).toBe(expected);
  });

  it('keeps quotes that are part of the subject', () => {
    // Only a whole-line wrapping pair is scaffolding.
    expect(cleanCommitMessage('fix: handle "null" ids\n')).toBe('fix: handle "null" ids');
  });

  it('returns empty for nothing usable, so the caller can say so', () => {
    expect(cleanCommitMessage('')).toBe('');
    expect(cleanCommitMessage('\n\n')).toBe('');
    expect(cleanCommitMessage('```\n```')).toBe('');
  });
});
