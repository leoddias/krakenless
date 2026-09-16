import { describe, expect, it } from 'vitest';
import type { Operation, OperationKind } from '../../git/operation';
import { stashRefusalReason } from './stashDialog';
import type { WorkingTreeTally } from './workingTreeTally';

function operation(kind: OperationKind | null): Operation {
  return { kind, commit: null, step: null, steps: null, branch: null };
}

const DIRTY: WorkingTreeTally = { added: 0, modified: 1, deleted: 0 };
const CLEAN: WorkingTreeTally = { added: 0, modified: 0, deleted: 0 };

describe('when the working tree may be stashed', () => {
  it('allows it on an ordinary dirty tree', () => {
    expect(stashRefusalReason(operation(null), false, DIRTY)).toBeNull();
  });

  it('refuses while a git command is running', () => {
    expect(stashRefusalReason(operation(null), true, DIRTY)).toContain('already running');
  });

  it('refuses when nothing tracked has changed', () => {
    // An untracked-only tree reaches here as clean: `git stash push` would
    // print "No local changes to save", exit 0, and change nothing, while the
    // confirmation had promised files would move.
    expect(stashRefusalReason(operation(null), false, CLEAN)).toContain(
      'no tracked changes',
    );
  });

  it.each<OperationKind>(['merge', 'rebase', 'cherry-pick', 'revert'])(
    'refuses during a %s, because the stash would take the operation with it',
    (kind) => {
      // Verified against git 2.39: with the conflicts resolved and staged — the
      // state this app's own conflict resolver leaves behind — the stash
      // succeeds and takes MERGE_HEAD / CHERRY_PICK_HEAD / the rebase state with
      // it. `rebase --continue` then reports "Successfully rebased" while the
      // replayed commit is gone from the branch.
      const reason = stashRefusalReason(operation(kind), false, DIRTY);
      expect(reason).toContain(kind);
      expect(reason).toContain('lost');
    },
  );

  it('reports the running command before the operation, since it clears first', () => {
    expect(stashRefusalReason(operation('rebase'), true, DIRTY)).toContain(
      'already running',
    );
  });
});
