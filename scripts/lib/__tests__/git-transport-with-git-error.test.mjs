/**
 * @file git-transport-with-git-error.test.mjs - the ledger OUTBOX + PLUMBING flush (live 2026-10-21: 3+ same-host writers
 *   raced 9-second worktree pushes to `ops/review-requests`, the losers exhausted 5 short retries and referral holds
 *   and rulings never persisted, #5502 #5530 #5773 #5742 #5768).
 *
 * The append writes its rows to a host-local outbox first, then ONE writer at a time (a host-wide flusher lock)
 * pushes everything queued as ONE plumbing commit. These tests pin the invariants: every row lands exactly once,
 * a crash between push and delete never duplicates, an off-host (CI) writer's push is retried on the new tip,
 * nothing is ever forced, and a failure still surfaces.
 */
import { describe, it, expect } from 'vitest';
import { withGitErrorForTest } from '../git-transport-branch.mjs';

describe('withGitError keeps the push rejection, not only the last error line', () => {
  it('a rejected push names [rejected] and the remote: lines in its message', () => {
    const run = () => {
      const e = new Error('Command failed');
      e.stderr = 'To github.com:x/y.git\n ! [rejected]        HEAD -> ops/review-requests (fetch first)\n'
        + 'remote: something the remote said\nerror: failed to push some refs to \'github.com:x/y.git\'\n';
      e.status = 1;
      throw e;
    };
    let err;
    try { withGitErrorForTest(run)(['push', 'origin', 'x'], {}); } catch (e) { err = e; }
    expect(err.message).toMatch(/\[rejected\].*fetch first/);
    expect(err.message).toMatch(/remote: something the remote said/);
    expect(err.message).toMatch(/failed to push some refs/);
  });
});
