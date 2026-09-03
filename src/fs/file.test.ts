import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  deleteWorktreeFile,
  FileError,
  openWorktreeFile,
  saveWorktreeFile,
  type OpenFile,
} from './file';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const REPO = 'C:/repos/app';
const BOM = '﻿';

beforeEach(() => {
  invokeMock.mockReset();
});

function contents(text: string, lossy = false) {
  return { text, stamp: `${String(text.length)}-abc`, lossy };
}

describe('openWorktreeFile', () => {
  it('asks Rust for the file and hands the box LF text', async () => {
    invokeMock.mockResolvedValue(contents('a\r\nb\r\n'));

    const file = await openWorktreeFile(REPO, 'src/a.ts');

    expect(invokeMock).toHaveBeenCalledWith('worktree_read', {
      repo: REPO,
      path: 'src/a.ts',
    });
    expect(file.text).toBe('a\nb\n');
    expect(file.shape).toEqual({ bom: false, eol: 'crlf', finalNewline: true });
    expect(file.stamp).toBe(contents('a\r\nb\r\n').stamp);
  });

  it('remembers a byte-order mark so saving does not drop it', async () => {
    invokeMock.mockResolvedValue(contents(`${BOM}a\n`));
    const file = await openWorktreeFile(REPO, 'a.txt');
    expect(file.shape.bom).toBe(true);
    expect(file.text).toBe('a\n');
  });

  it('refuses a file whose bytes did not decode', async () => {
    invokeMock.mockResolvedValue(contents('bad \ufffd bytes', true));

    await expect(openWorktreeFile(REPO, 'a.bin')).rejects.toMatchObject({
      kind: 'not-editable',
      message: expect.stringMatching(/not valid UTF-8/) as unknown as string,
    });
  });

  it('refuses a file that mixes line endings', async () => {
    invokeMock.mockResolvedValue(contents('a\r\nb\n'));
    await expect(openWorktreeFile(REPO, 'a.txt')).rejects.toMatchObject({
      kind: 'not-editable',
    });
  });

  it('carries the reason a refusal came back with', async () => {
    invokeMock.mockRejectedValue({ kind: 'TooLarge', message: 'a.log is 9000000 bytes' });

    const error = await openWorktreeFile(REPO, 'a.log').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FileError);
    expect(error).toMatchObject({ kind: 'too-large', message: 'a.log is 9000000 bytes' });
  });

  it('does not lose an unrecognized failure', async () => {
    invokeMock.mockRejectedValue('the window went away');
    await expect(openWorktreeFile(REPO, 'a.txt')).rejects.toMatchObject({
      kind: 'read-failed',
      message: 'the window went away',
    });
  });
});

describe('saveWorktreeFile', () => {
  const open: OpenFile = {
    path: 'src/a.ts',
    text: 'a\nb\n',
    shape: { bom: false, eol: 'crlf', finalNewline: true },
    stamp: '6-abc',
  };

  it('writes the exact bytes it was given, with the stamp it read', async () => {
    invokeMock.mockResolvedValue('8-def');

    const saved = await saveWorktreeFile(REPO, open, 'a\r\nc\r\n');

    expect(invokeMock).toHaveBeenCalledWith('worktree_write', {
      repo: REPO,
      path: 'src/a.ts',
      contents: 'a\r\nc\r\n',
      expectStamp: '6-abc',
    });
    expect(saved.stamp).toBe('8-def');
    // The editor keeps showing LF, whatever went to disk.
    expect(saved.text).toBe('a\nc\n');
  });

  it('keeps the shape, so a second save writes the same dialect', async () => {
    invokeMock.mockResolvedValue('8-def');
    const saved = await saveWorktreeFile(REPO, open, 'a\r\nc\r\n');
    expect(saved.shape).toEqual(open.shape);
  });

  it('surfaces a file that changed on disk as its own kind', async () => {
    // The caller has to tell the user their copy is stale; a generic failure
    // would read as "try again", and trying again would overwrite the change.
    invokeMock.mockRejectedValue({
      kind: 'ChangedOnDisk',
      message: 'src/a.ts changed on disk since it was opened',
    });

    await expect(saveWorktreeFile(REPO, open, 'x')).rejects.toMatchObject({
      kind: 'changed-on-disk',
    });
  });

  it('reports an unrecognized rejection as a failed write, never as success', async () => {
    invokeMock.mockRejectedValue(new Error('disk full'));
    await expect(saveWorktreeFile(REPO, open, 'x')).rejects.toMatchObject({
      kind: 'write-failed',
      message: 'disk full',
    });
  });
});

describe('deleteWorktreeFile', () => {
  it('asks Rust to remove exactly the path it was given', async () => {
    invokeMock.mockResolvedValue(undefined);

    await deleteWorktreeFile(REPO, 'src/a.ts');

    expect(invokeMock).toHaveBeenCalledWith('worktree_delete', {
      repo: REPO,
      path: 'src/a.ts',
    });
  });

  it('reports a refusal as a FileError of its own kind', async () => {
    // A delete that resolves outside the repository is refused in Rust; the UI
    // has to be able to tell that apart from a file that was simply not there.
    invokeMock.mockRejectedValue({
      kind: 'OutsideRepo',
      message: '../elsewhere.txt',
    });

    await expect(deleteWorktreeFile(REPO, '../elsewhere.txt')).rejects.toMatchObject({
      name: 'FileError',
      kind: 'outside-repo',
    });
  });

  it('never reports an unrecognised failure as success', async () => {
    invokeMock.mockRejectedValue('the window went away');

    await expect(deleteWorktreeFile(REPO, 'a.ts')).rejects.toBeInstanceOf(FileError);
  });
});
