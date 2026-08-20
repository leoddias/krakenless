import { beforeEach, describe, expect, it, vi } from 'vitest';
import { editorLaunch, launch, mergetoolLaunch, revealFolder, tokenize } from './launch';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

describe('tokenize', () => {
  it('splits on whitespace', () => {
    expect(tokenize('code -g')).toEqual(['code', '-g']);
  });

  it('keeps a quoted path with spaces together', () => {
    // Splitting on whitespace alone would turn this into three broken tokens.
    expect(tokenize('"C:/Program Files/Editor/ed.exe" --wait')).toEqual([
      'C:/Program Files/Editor/ed.exe',
      '--wait',
    ]);
  });

  it('collapses runs of whitespace', () => {
    expect(tokenize('  code    -g  ')).toEqual(['code', '-g']);
  });

  it('keeps a deliberately empty quoted argument', () => {
    expect(tokenize('ed ""')).toEqual(['ed', '']);
  });

  it('returns nothing for an empty command', () => {
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('editorLaunch', () => {
  it('appends the path as its own argument', () => {
    expect(editorLaunch('code -g', 'src/app.ts')).toEqual({
      program: 'code',
      args: ['-g', 'src/app.ts'],
    });
  });

  it('keeps a path with spaces as one argument', () => {
    expect(editorLaunch('code', 'my folder/a b.ts')?.args).toEqual(['my folder/a b.ts']);
  });

  it('does not let a path become an option', () => {
    // A repository file may legally be named `--wait`; passed bare, the editor
    // would read it as its own flag and open nothing.
    expect(editorLaunch('code', '--wait')?.args).toEqual(['./--wait']);
    expect(editorLaunch('code', '-w')?.args).toEqual(['./-w']);
  });

  it('leaves an ordinary path untouched', () => {
    expect(editorLaunch('code', 'src/-weird.ts')?.args).toEqual(['src/-weird.ts']);
  });

  it('returns null when no editor is configured', () => {
    // Guessing at an editor would launch something the user never chose.
    expect(editorLaunch('', 'a.ts')).toBeNull();
    expect(editorLaunch('   ', 'a.ts')).toBeNull();
  });
});

describe('mergetoolLaunch', () => {
  it('leaves the tool to git when none is configured', () => {
    expect(mergetoolLaunch('', 'a.ts')).toEqual({
      program: 'git',
      args: ['mergetool', '--no-prompt', '--', 'a.ts'],
    });
  });

  it('passes the configured tool', () => {
    expect(mergetoolLaunch('vscode', 'a.ts').args).toContain('--tool=vscode');
  });

  it('puts the path after the separator', () => {
    const args = mergetoolLaunch('meld', 'a.ts').args;
    expect(args.slice(-2)).toEqual(['--', 'a.ts']);
  });
});

describe('launch', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('sends the program and arguments through, with no shell', async () => {
    invoke.mockResolvedValue(undefined);
    await launch({ program: 'code', args: ['-g', 'a.ts'] }, 'C:/repo');

    expect(invoke).toHaveBeenCalledWith('open_external', {
      program: 'code',
      args: ['-g', 'a.ts'],
      cwd: 'C:/repo',
    });
  });

  it('turns a raw IPC rejection into a readable error', async () => {
    // The UI shows this string; the bare object would render as [object Object].
    invoke.mockImplementation(async () => {
      throw { kind: 'LaunchFailed', message: 'code: not found' };
    });
    await expect(launch({ program: 'code', args: [] })).rejects.toThrow(
      'code: not found',
    );
  });

  it('still says something useful when the rejection has no message', async () => {
    invoke.mockImplementation(async () => {
      throw 'nope';
    });
    await expect(launch({ program: 'code', args: [] })).rejects.toThrow(
      'Could not start code',
    );
  });
});

describe('revealFolder', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('asks the shell to open the folder', async () => {
    invoke.mockResolvedValue(undefined);
    await revealFolder('C:/Users/x/AppData/Roaming/krakenless');
    expect(invoke).toHaveBeenCalledWith('reveal_folder', {
      path: 'C:/Users/x/AppData/Roaming/krakenless',
    });
  });
});
