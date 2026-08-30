import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildShowStageCommand } from './commands/conflict';
import { hasConflictMarkers, readConflictSides } from './conflict';
import { GitError } from './errors';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

function raw(overrides: Record<string, unknown> = {}) {
  return {
    stdout: '',
    stderr: '',
    code: 0,
    timed_out: false,
    stdout_lossy: false,
    ...overrides,
  };
}

beforeEach(() => {
  invoke.mockReset();
});

describe('buildShowStageCommand', () => {
  it('reads a stage out of the index, not off disk', () => {
    // The working copy is the marked-up mess; the stages are exactly what each
    // side had, which is the only sound thing to build a resolution on.
    expect(buildShowStageCommand(2, 'src/app.ts').args).toEqual([
      'show',
      ':2:src/app.ts',
    ]);
    expect(buildShowStageCommand(1, 'a.ts').args[1]).toBe(':1:a.ts');
    expect(buildShowStageCommand(3, 'a.ts').args[1]).toBe(':3:a.ts');
  });

  it('refuses a path that would change what the argument means', () => {
    expect(() => buildShowStageCommand(2, '/etc/passwd')).toThrow(GitError);
    expect(() => buildShowStageCommand(2, '../outside.ts')).toThrow(GitError);
    expect(() => buildShowStageCommand(2, '')).toThrow(GitError);
  });
});

describe('readConflictSides', () => {
  it('reads all three stages', async () => {
    invoke
      .mockResolvedValueOnce(raw({ stdout: 'base\n' }))
      .mockResolvedValueOnce(raw({ stdout: 'ours\n' }))
      .mockResolvedValueOnce(raw({ stdout: 'theirs\n' }));

    const sides = await readConflictSides('C:/repo', 'a.ts');

    expect(sides.base).toEqual({ text: 'base\n', present: true });
    expect(sides.ours.text).toBe('ours\n');
    expect(sides.theirs.text).toBe('theirs\n');
  });

  it('reports a missing stage as absent, not as a failure', async () => {
    // A delete/modify conflict *is* one side having no version of the file, and
    // an error there would take the whole screen down with it.
    invoke
      .mockRejectedValueOnce(new Error('exists on disk, but not in the index'))
      .mockResolvedValueOnce(raw({ stdout: 'ours\n' }))
      .mockRejectedValueOnce(new Error('does not exist'));

    const sides = await readConflictSides('C:/repo', 'a.ts');

    expect(sides.base).toEqual({ text: '', present: false });
    expect(sides.ours.present).toBe(true);
    expect(sides.theirs).toEqual({ text: '', present: false });
  });
});

describe('hasConflictMarkers', () => {
  it('recognises every marker git writes', () => {
    expect(hasConflictMarkers('a\n<<<<<<< HEAD\nb\n')).toBe(true);
    expect(hasConflictMarkers('a\n=======\nb\n')).toBe(true);
    expect(hasConflictMarkers('a\n>>>>>>> theirs\nb\n')).toBe(true);
  });

  it('does not accuse a file that merely talks about them', () => {
    // Anchored to the start of a line and to git's exact seven characters:
    // prose about markers, and a line of six or eight, are not markers.
    expect(hasConflictMarkers('the marker is <<<<<<< in git\n')).toBe(false);
    expect(hasConflictMarkers('<<<<<< six\n')).toBe(false);
    expect(hasConflictMarkers('======== eight\n')).toBe(false);
  });

  it('is clean for an ordinary file', () => {
    expect(hasConflictMarkers('one\ntwo\n')).toBe(false);
    expect(hasConflictMarkers('')).toBe(false);
  });
});
