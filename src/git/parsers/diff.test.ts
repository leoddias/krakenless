import { describe, expect, it } from 'vitest';
import {
  buildCommitDiffCommand,
  buildStagedDiffCommand,
  buildWorktreeDiffCommand,
} from '../commands/diff';
import { GitError } from '../errors';
import { parseDiff } from './diff';

/**
 * Every fixture below is a verbatim capture from git 2.39.2 run against a
 * throwaway repository — never hand-written. Tabs and CRs are spelled as `\t`
 * and `\r` so that no editor or formatter can silently eat them, which is the
 * whole point of several of these cases.
 */

// `git diff --cached` over a repository holding, in one shot: an added file, a
// binary change, a unicode path, a normal edit, a CRLF file, a deletion, a path
// with a space, a file that lost its missing trailing newline, a two-hunk file
// (second hunk carrying function context), and a rename.
// Captured with git's *default* `core.quotePath=true`, so the unicode path
// arrives quoted; the runner disables that (see UNQUOTED_UNICODE_PATH).
const MIXED = `diff --git a/added.txt b/added.txt
new file mode 100644
index 0000000..d5a09df
--- /dev/null
+++ b/added.txt
@@ -0,0 +1 @@
+brand new
diff --git a/blob.bin b/blob.bin
index 901372d..a2fcc53 100644
Binary files a/blob.bin and b/blob.bin differ
diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"
new file mode 100644
index 0000000..4f598e3
--- /dev/null
+++ "b/caf\\303\\251.txt"
@@ -0,0 +1 @@
+accented
diff --git a/code.c b/code.c
index dd891a0..216c0de 100644
--- a/code.c
+++ b/code.c
@@ -1,6 +1,6 @@
 int main(void) {
   int a = 1;
-  int b = 2;
+  int b = 22;
   int c = 3;
   int d = 4;
   int e = 5;
diff --git a/crlf.txt b/crlf.txt
index 415a78b..ce5d508 100644
--- a/crlf.txt
+++ b/crlf.txt
@@ -1,3 +1,3 @@
 x\r
-y\r
+Y\r
 z\r
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 4202011..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-to be deleted
diff --git a/my file.txt b/my file.txt
index 814f4a4..879de50 100644
--- a/my file.txt\t
+++ b/my file.txt\t
@@ -1,2 +1,2 @@
 one
-two
+TWO
diff --git a/nonl.txt b/nonl.txt
index 66a19ea..942ab56 100644
--- a/nonl.txt
+++ b/nonl.txt
@@ -1 +1 @@
-no trailing
\\ No newline at end of file
+no trailing
diff --git a/plain.txt b/plain.txt
index b03757e..390076c 100644
--- a/plain.txt
+++ b/plain.txt
@@ -1,5 +1,5 @@
 a
-b
+B
 c
 d
 e
@@ -11,6 +11,6 @@ j
 k
 l
 m
-n
+N
 o
 p
diff --git a/src.txt b/renamed.txt
similarity index 71%
rename from src.txt
rename to renamed.txt
index 7ffd324..c7b719e 100644
--- a/src.txt
+++ b/renamed.txt
@@ -1,4 +1,4 @@
 copy me
 line2
 line3
-line4
+CHANGED
`;

// A path whose name ends in a space, staged through the index. Git terminates
// the `+++` line with a tab so the name's own trailing space stays visible.
const TRAILING_SPACE_PATH = `diff --git a/trail .txt b/trail .txt
new file mode 100644
index 0000000..288d678
--- /dev/null
+++ b/trail .txt\t
@@ -0,0 +1 @@
+quoted content
`;

// A new binary file whose name contains a space: no `---`/`+++` lines at all,
// so the ambiguous `diff --git` line is the only source of the path.
const NEW_BINARY_WITH_SPACE = `diff --git a/my bin.bin b/my bin.bin
new file mode 100644
index 0000000..38ef1d7
Binary files /dev/null and b/my bin.bin differ
`;

const EMPTY_NEW_FILE = `diff --git a/empty.txt b/empty.txt
new file mode 100644
index 0000000..e69de29
`;

const MODE_ONLY = `diff --git a/modeme.sh b/modeme.sh
old mode 100644
new mode 100755
`;

const MODE_AND_CONTENT = `diff --git a/modeme.sh b/modeme.sh
old mode 100644
new mode 100755
index ce01362..c7c7da3
--- a/modeme.sh
+++ b/modeme.sh
@@ -1 +1 @@
-hello
+hello there
`;

const COPY = `diff --git a/src.txt b/copy.txt
similarity index 84%
copy from src.txt
copy to copy.txt
index 3cb899f..800ecc6 100644
--- a/src.txt
+++ b/copy.txt
@@ -3,4 +3,4 @@ line2
 line3
 line4
 line5
-line6
+SIX
`;

const PURE_RENAME = `diff --git a/seed.txt b/seed2.txt
similarity index 100%
rename from seed.txt
rename to seed2.txt
`;

const QUOTED_PATH = `diff --git "a/caf\\303\\251 two.txt" "b/caf\\303\\251 two.txt"
new file mode 100644
index 0000000..4f598e3
--- /dev/null
+++ "b/caf\\303\\251 two.txt"\t
@@ -0,0 +1 @@
+accented
`;

const UNQUOTED_UNICODE_PATH = `diff --git a/café two.txt b/café two.txt
new file mode 100644
index 0000000..4f598e3
--- /dev/null
+++ b/café two.txt\t
@@ -0,0 +1 @@
+accented
`;

// What plain `git show` prints for a merge commit: a *combined* diff, which is
// a different format and is not something `git apply` can consume.
const COMBINED_MERGE = `diff --cc f.txt
index af70335,f794161..8bcb16a
--- a/f.txt
+++ b/f.txt
@@@ -1,3 -1,3 +1,3 @@@
  a
- MAIN
 -SIDE
++RESOLVED
  c
`;

const MERGE_FIRST_PARENT = `diff --git a/f.txt b/f.txt
index af70335..8bcb16a 100644
--- a/f.txt
+++ b/f.txt
@@ -1,3 +1,3 @@
 a
-MAIN
+RESOLVED
 c
`;

const SHOW_WITH_COMMIT_HEADER = `commit 7aeccd354301fa76c283cc43e9457f9df53dc1a9
Author: T <t@e.x>
Date:   Tue Jan 2 03:04:05 2024 +0000

    extend readme

diff --git a/readme.txt b/readme.txt
index 9c59e24..66a52ee 100644
--- a/readme.txt
+++ b/readme.txt
@@ -1 +1,2 @@
 first
+second
`;

// A diff of a file that itself contains a patch: every content line carries a
// marker, so `diff --git` and `@@` inside the payload stay unambiguous.
const PATCH_INSIDE_PATCH = `diff --git a/sample.patch b/sample.patch
index c341072..7d89908 100644
--- a/sample.patch
+++ b/sample.patch
@@ -1,7 +1,7 @@
 diff --git a/x b/x
-index 1111111..2222222 100644
+index 1111111..3333333 100644
 --- a/x
 +++ b/x
 @@ -1,1 +1,1 @@
 -old
-+new
++newer
`;

describe('diff command builders', () => {
  const shared = [
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--no-relative',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '-U3',
    '--find-renames',
    '--find-copies',
  ];

  it('builds the worktree diff', () => {
    expect(buildWorktreeDiffCommand().args).toEqual(['diff', ...shared]);
  });

  it('builds the staged diff', () => {
    expect(buildStagedDiffCommand().args).toEqual(['diff', '--cached', ...shared]);
  });

  it('builds a single-commit diff against the first parent', () => {
    expect(buildCommitDiffCommand('a1b2c3d').args).toEqual([
      'show',
      '--format=',
      '--diff-merges=first-parent',
      ...shared,
      'a1b2c3d',
    ]);
  });

  it('never marks a diff destructive', () => {
    expect(buildWorktreeDiffCommand().destructive).toBeUndefined();
    expect(buildStagedDiffCommand().destructive).toBeUndefined();
    expect(buildCommitDiffCommand('HEAD').destructive).toBeUndefined();
  });

  it('puts paths after --', () => {
    expect(buildWorktreeDiffCommand({ paths: ['src/a.ts', 'b c.txt'] }).args).toEqual([
      'diff',
      ...shared,
      '--',
      'src/a.ts',
      'b c.txt',
    ]);
    expect(buildCommitDiffCommand('HEAD', { paths: ['x.txt'] }).args).toEqual([
      'show',
      '--format=',
      '--diff-merges=first-parent',
      ...shared,
      'HEAD',
      '--',
      'x.txt',
    ]);
  });

  it('omits the separator when no path was given', () => {
    expect(buildStagedDiffCommand({ paths: [] }).args).not.toContain('--');
  });

  it('rejects a revision that would be read as an option', () => {
    expect(() => buildCommitDiffCommand('--all')).toThrow(GitError);
    expect(() => buildCommitDiffCommand('--all')).toThrow(/dash/);
  });

  it('rejects a path that escapes the repository', () => {
    expect(() => buildWorktreeDiffCommand({ paths: ['../../etc/passwd'] })).toThrow(
      GitError,
    );
    expect(() => buildStagedDiffCommand({ paths: ['C:/Windows/system.ini'] })).toThrow(
      GitError,
    );
  });
});

describe('parseDiff — empty input', () => {
  it('returns no files for an empty diff', () => {
    expect(parseDiff('')).toEqual([]);
  });
});

describe('parseDiff — a mixed multi-file diff', () => {
  const files = parseDiff(MIXED);

  it('finds every file, in git order', () => {
    expect(files.map((file) => file.newPath)).toEqual([
      'added.txt',
      'blob.bin',
      'café.txt',
      'code.c',
      'crlf.txt',
      'gone.txt',
      'my file.txt',
      'nonl.txt',
      'plain.txt',
      'renamed.txt',
    ]);
  });

  it('classifies each change', () => {
    expect(files.map((file) => file.kind)).toEqual([
      'added',
      'modified',
      'added',
      'modified',
      'modified',
      'deleted',
      'modified',
      'modified',
      'modified',
      'renamed',
    ]);
  });

  it('reads an added file, whose old side is /dev/null', () => {
    const added = files[0]!;
    expect(added.oldPath).toBe('added.txt');
    expect(added.newPath).toBe('added.txt');
    expect(added.binary).toBe(false);
    expect(added.hunks).toHaveLength(1);
    expect(added.hunks[0]).toEqual({
      header: '@@ -0,0 +1 @@',
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 1,
      lines: [{ kind: 'added', text: 'brand new', newLine: 1 }],
    });
  });

  it('reads a deleted file, whose new side is /dev/null', () => {
    const deleted = files[5]!;
    expect(deleted.oldPath).toBe('gone.txt');
    expect(deleted.newPath).toBe('gone.txt');
    expect(deleted.hunks[0]).toEqual({
      header: '@@ -1 +0,0 @@',
      oldStart: 1,
      oldLines: 1,
      newStart: 0,
      newLines: 0,
      lines: [{ kind: 'deleted', text: 'to be deleted', oldLine: 1 }],
    });
  });

  it('flags a binary file and gives it no hunks', () => {
    const binary = files[1]!;
    expect(binary.binary).toBe(true);
    expect(binary.hunks).toEqual([]);
    expect(binary.oldPath).toBe('blob.bin');
    expect(binary.newPath).toBe('blob.bin');
    expect(binary.headerLines).toContain('Binary files a/blob.bin and b/blob.bin differ');
  });

  it('unquotes a c-quoted unicode path back to its characters', () => {
    expect(files[2]!.newPath).toBe('café.txt');
  });

  it('numbers both sides of an ordinary edit', () => {
    expect(files[3]!.hunks[0]!.lines).toEqual([
      { kind: 'context', text: 'int main(void) {', oldLine: 1, newLine: 1 },
      { kind: 'context', text: '  int a = 1;', oldLine: 2, newLine: 2 },
      { kind: 'deleted', text: '  int b = 2;', oldLine: 3 },
      { kind: 'added', text: '  int b = 22;', newLine: 3 },
      { kind: 'context', text: '  int c = 3;', oldLine: 4, newLine: 4 },
      { kind: 'context', text: '  int d = 4;', oldLine: 5, newLine: 5 },
      { kind: 'context', text: '  int e = 5;', oldLine: 6, newLine: 6 },
    ]);
  });

  it('keeps the carriage returns of a CRLF file', () => {
    const crlf = files[4]!;
    expect(crlf.hunks[0]!.lines.map((line) => line.text)).toEqual([
      'x\r',
      'y\r',
      'Y\r',
      'z\r',
    ]);
  });

  it('keeps a path that contains a space, tab terminator and all', () => {
    expect(files[6]!.oldPath).toBe('my file.txt');
    expect(files[6]!.newPath).toBe('my file.txt');
  });

  it('records "\\ No newline at end of file" where git put it', () => {
    expect(files[7]!.hunks[0]!.lines).toEqual([
      { kind: 'deleted', text: 'no trailing', oldLine: 1 },
      { kind: 'no-newline', text: 'No newline at end of file' },
      { kind: 'added', text: 'no trailing', newLine: 1 },
    ]);
  });

  it('reads several hunks and keeps the function context in the header', () => {
    const plain = files[8]!;
    expect(plain.hunks).toHaveLength(2);
    expect(plain.hunks[0]!.header).toBe('@@ -1,5 +1,5 @@');
    const second = plain.hunks[1]!;
    expect(second.header).toBe('@@ -11,6 +11,6 @@ j');
    expect(second).toMatchObject({
      oldStart: 11,
      oldLines: 6,
      newStart: 11,
      newLines: 6,
    });
    expect(second.lines).toEqual([
      { kind: 'context', text: 'k', oldLine: 11, newLine: 11 },
      { kind: 'context', text: 'l', oldLine: 12, newLine: 12 },
      { kind: 'context', text: 'm', oldLine: 13, newLine: 13 },
      { kind: 'deleted', text: 'n', oldLine: 14 },
      { kind: 'added', text: 'N', newLine: 14 },
      { kind: 'context', text: 'o', oldLine: 15, newLine: 15 },
      { kind: 'context', text: 'p', oldLine: 16, newLine: 16 },
    ]);
  });

  it('reads a rename from the rename headers, not from the ambiguous first line', () => {
    const renamed = files[9]!;
    expect(renamed.oldPath).toBe('src.txt');
    expect(renamed.newPath).toBe('renamed.txt');
    expect(renamed.headerLines).toContain('similarity index 71%');
  });

  it('keeps every header line verbatim so a hunk can be reapplied', () => {
    expect(files[3]!.headerLines).toEqual([
      'diff --git a/code.c b/code.c',
      'index dd891a0..216c0de 100644',
      '--- a/code.c',
      '+++ b/code.c',
    ]);
  });
});

describe('parseDiff — entries git writes without --- / +++ lines', () => {
  it('reads a mode-only change as a modification with no hunks', () => {
    const [file] = parseDiff(MODE_ONLY);
    expect(file).toEqual({
      oldPath: 'modeme.sh',
      newPath: 'modeme.sh',
      kind: 'modified',
      binary: false,
      headerLines: [
        'diff --git a/modeme.sh b/modeme.sh',
        'old mode 100644',
        'new mode 100755',
      ],
      hunks: [],
    });
  });

  it('reads a mode change that also has content', () => {
    const [file] = parseDiff(MODE_AND_CONTENT);
    expect(file!.kind).toBe('modified');
    expect(file!.headerLines).toContain('old mode 100644');
    expect(file!.headerLines).toContain('new mode 100755');
    expect(file!.hunks[0]!.lines).toEqual([
      { kind: 'deleted', text: 'hello', oldLine: 1 },
      { kind: 'added', text: 'hello there', newLine: 1 },
    ]);
  });

  it('reads an empty new file', () => {
    const [file] = parseDiff(EMPTY_NEW_FILE);
    expect(file!.kind).toBe('added');
    expect(file!.newPath).toBe('empty.txt');
    expect(file!.hunks).toEqual([]);
  });

  it('reads a 100% rename, which has no hunks at all', () => {
    const [file] = parseDiff(PURE_RENAME);
    expect(file!.kind).toBe('renamed');
    expect(file!.oldPath).toBe('seed.txt');
    expect(file!.newPath).toBe('seed2.txt');
    expect(file!.hunks).toEqual([]);
  });

  it('splits a spaced path out of the ambiguous header of a new binary file', () => {
    const [file] = parseDiff(NEW_BINARY_WITH_SPACE);
    expect(file!.kind).toBe('added');
    expect(file!.binary).toBe(true);
    expect(file!.oldPath).toBe('my bin.bin');
    expect(file!.newPath).toBe('my bin.bin');
  });
});

describe('parseDiff — paths', () => {
  it('keeps a trailing space in a name, distinguishing it from git\u2019s tab', () => {
    const [file] = parseDiff(TRAILING_SPACE_PATH);
    expect(file!.newPath).toBe('trail .txt');
  });

  it('decodes octal escapes as UTF-8 bytes, not as single characters', () => {
    const [file] = parseDiff(QUOTED_PATH);
    expect(file!.newPath).toBe('café two.txt');
    expect(file!.oldPath).toBe('café two.txt');
  });

  it('takes an unquoted unicode path as-is (the runner sets quotePath=false)', () => {
    const [file] = parseDiff(UNQUOTED_UNICODE_PATH);
    expect(file!.newPath).toBe('café two.txt');
  });

  it('detects a copy from the copy headers', () => {
    const [file] = parseDiff(COPY);
    expect(file!.kind).toBe('copied');
    expect(file!.oldPath).toBe('src.txt');
    expect(file!.newPath).toBe('copy.txt');
    expect(file!.hunks[0]!.oldStart).toBe(3);
    expect(file!.hunks[0]!.lines[0]).toEqual({
      kind: 'context',
      text: 'line3',
      oldLine: 3,
      newLine: 3,
    });
  });
});

describe('parseDiff — git show', () => {
  it('skips the commit header git prints before the patch', () => {
    const files = parseDiff(SHOW_WITH_COMMIT_HEADER);
    expect(files).toHaveLength(1);
    expect(files[0]!.newPath).toBe('readme.txt');
    expect(files[0]!.hunks[0]!.lines).toEqual([
      { kind: 'context', text: 'first', oldLine: 1, newLine: 1 },
      { kind: 'added', text: 'second', newLine: 2 },
    ]);
  });

  it('reads a merge shown against its first parent', () => {
    const files = parseDiff(MERGE_FIRST_PARENT);
    expect(files[0]!.hunks[0]!.lines).toEqual([
      { kind: 'context', text: 'a', oldLine: 1, newLine: 1 },
      { kind: 'deleted', text: 'MAIN', oldLine: 2 },
      { kind: 'added', text: 'RESOLVED', newLine: 2 },
      { kind: 'context', text: 'c', oldLine: 3, newLine: 3 },
    ]);
  });

  it('refuses a combined merge diff instead of silently dropping it', () => {
    expect(() => parseDiff(COMBINED_MERGE)).toThrow(GitError);
    try {
      parseDiff(COMBINED_MERGE);
      expect.unreachable('parseDiff must reject a combined diff');
    } catch (error) {
      expect(error).toBeInstanceOf(GitError);
      expect((error as GitError).kind).toBe('parse-failed');
      expect((error as GitError).message).toMatch(/combined/i);
    }
  });
});

describe('parseDiff — content that looks like a diff', () => {
  it('does not treat a patch inside a patch as a new file', () => {
    const files = parseDiff(PATCH_INSIDE_PATCH);
    expect(files).toHaveLength(1);
    expect(files[0]!.newPath).toBe('sample.patch');
    const hunk = files[0]!.hunks[0]!;
    expect(hunk.lines).toHaveLength(9);
    expect(hunk.lines[0]).toEqual({
      kind: 'context',
      text: 'diff --git a/x b/x',
      oldLine: 1,
      newLine: 1,
    });
    expect(hunk.lines[5]).toEqual({
      kind: 'context',
      text: '@@ -1,1 +1,1 @@',
      oldLine: 5,
      newLine: 5,
    });
    expect(hunk.lines[8]).toEqual({ kind: 'added', text: '+newer', newLine: 7 });
  });
});

/** Rebuilds the patch text from the parsed structure, marker by marker. */
function reassemble(text: string): string {
  return parseDiff(text)
    .flatMap((file) => [
      ...file.headerLines,
      ...file.hunks.flatMap((hunk) => [
        hunk.header,
        ...hunk.lines.map((line) => {
          switch (line.kind) {
            case 'context':
              return ` ${line.text}`;
            case 'added':
              return `+${line.text}`;
            case 'deleted':
              return `-${line.text}`;
            case 'no-newline':
              return `\\ ${line.text}`;
          }
        }),
      ]),
    ])
    .join('\n')
    .concat('\n');
}

describe('parseDiff — round-tripping', () => {
  // The M2 hunk-staging path feeds this text back to `git apply --cached`; a
  // single lost byte there is a wrong stage, so nothing may be normalised.
  it.each([
    ['a mixed multi-file diff (CRLF, no-newline, rename, binary)', MIXED],
    ['a mode-only change', MODE_ONLY],
    ['a pure rename', PURE_RENAME],
    ['an empty new file', EMPTY_NEW_FILE],
    ['a copy', COPY],
    ['a path with a trailing space', TRAILING_SPACE_PATH],
    ['a quoted unicode path', QUOTED_PATH],
    ['a patch inside a patch', PATCH_INSIDE_PATCH],
    ['a first-parent merge diff', MERGE_FIRST_PARENT],
  ])('reproduces %s byte for byte', (_name, fixture) => {
    expect(reassemble(fixture)).toBe(fixture);
  });
});

describe('parseDiff — malformed input', () => {
  function expectParseFailure(text: string): void {
    try {
      parseDiff(text);
      expect.unreachable('parseDiff must reject this input');
    } catch (error) {
      expect(error).toBeInstanceOf(GitError);
      expect((error as GitError).kind).toBe('parse-failed');
    }
  }

  it('rejects a hunk that ends before its declared line count', () => {
    expectParseFailure(`diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,5 +1,5 @@
 one
`);
  });

  it('rejects a hunk body line with no marker', () => {
    expectParseFailure(`diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 one
two
`);
  });

  it('rejects trailing junk after a complete hunk', () => {
    expectParseFailure(`diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-one
+two
this is not a diff
`);
  });

  it('rejects a malformed hunk header', () => {
    expectParseFailure(`diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -x,1 +1,1 @@
-one
+two
`);
  });

  it('rejects a path whose a/ prefix git did not write', () => {
    expectParseFailure(`diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- z/a.txt
+++ b/a.txt
@@ -1 +1 @@
-one
+two
`);
  });

  it('rejects an unterminated quoted path', () => {
    expectParseFailure(`diff --git "a/caf\\303\\251.txt b/x
new file mode 100644
index 0000000..4f598e3
`);
  });

  it('rejects a bad octal escape in a quoted path', () => {
    expectParseFailure(`diff --git "a/caf\\39.txt" "b/caf\\39.txt"
new file mode 100644
index 0000000..4f598e3
`);
  });

  it('rejects a diff --git line whose two paths cannot be told apart', () => {
    expectParseFailure(`diff --git a/one b/two b/three
old mode 100644
new mode 100755
`);
  });
});
