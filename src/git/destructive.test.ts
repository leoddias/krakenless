import { describe, expect, it } from 'vitest';
import { isDestructive } from './destructive';

describe('isDestructive', () => {
  it.each([
    [['reset', '--hard', 'HEAD~1']],
    [['reset', '--merge']],
    [['checkout', '--', 'src/app.ts']],
    [['restore', 'src/app.ts']],
    [['clean', '-fd']],
    [['branch', '-D', 'topic']],
    [['branch', '--delete', 'topic']],
    [['push', '--force', 'origin', 'main']],
    [['push', '--force-with-lease', 'origin', 'main']],
    [['push', 'origin', '+main:main']],
    [['push', '--delete', 'origin', 'topic']],
    [['stash', 'drop', 'stash@{0}']],
    [['stash', 'clear']],
    [['rebase', 'main']],
    [['merge', '--abort']],
    [['cherry-pick', '--abort']],
    [['update-ref', '-d', 'refs/heads/topic']],
    [['reflog', 'delete', 'HEAD@{0}']],
    [['gc', '--prune=now']],
    [['switch', '--force', 'main']],
    [['switch', '--discard-changes', 'main']],
    [['rm', '-f', '--', 'a.txt']],
    [['read-tree', '--reset', '-u', 'HEAD']],
    [['apply', '-R', 'patch.diff']],
    [['checkout-index', '-a', '-f']],
    [['sparse-checkout', 'set', 'src']],
    // Global options that take a value must not hide the subcommand.
    [['--git-dir', '/x/.git', 'reset', '--hard']],
    [['--work-tree', '/x', 'clean', '-fdx']],
    [['-C', '/x', 'checkout', '--', 'a.txt']],
    // Unknown subcommands fail closed.
    [['some-future-plumbing', '--yolo']],
  ])('flags %j as destructive', (args) => {
    expect(isDestructive(args)).toBe(true);
  });

  it.each([
    [['status', '--porcelain=v2']],
    [['log', '--format=%H']],
    [['diff', '--cached']],
    [['show', 'HEAD']],
    [['add', 'src/app.ts']],
    [['commit', '-m', 'reset --hard everything']],
    [['fetch', 'origin']],
    [['push', 'origin', 'main']],
    [['branch', '--list']],
    [['stash', 'list']],
    [['rev-parse', '--show-toplevel']],
    [['switch', 'main']],
    [['rm', '--cached', '--', 'a.txt']],
    [['apply', '--cached', '-R', 'patch.diff']],
    [['ls-files', '-z']],
    [['for-each-ref', '--format=%(refname)']],
    [['--git-dir', '/x/.git', 'status']],
  ])('does not flag %j', (args) => {
    expect(isDestructive(args)).toBe(false);
  });

  it('sees past leading global options', () => {
    expect(isDestructive(['-c', 'core.quotePath=false', 'reset', '--hard'])).toBe(true);
    expect(isDestructive(['-c', 'core.quotePath=false', 'status'])).toBe(false);
  });

  it('is not fooled by a branch named like a subcommand', () => {
    // The subcommand is `checkout`, which is destructive regardless of the
    // branch name — but `log` with a ref called "clean" must stay safe.
    expect(isDestructive(['log', 'clean'])).toBe(false);
  });

  it('handles arguments that are only flags', () => {
    expect(isDestructive(['--version'])).toBe(false);
    expect(isDestructive([])).toBe(false);
  });

  it('keeps staged-only variants unconfirmed-friendly', () => {
    // Unstaging is recoverable; discarding the worktree is not.
    expect(isDestructive(['restore', '--staged', 'a.txt'])).toBe(true);
    expect(isDestructive(['reset', 'HEAD', '--', 'a.txt'])).toBe(false);
  });
});
