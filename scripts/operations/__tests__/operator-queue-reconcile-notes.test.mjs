/**
 * @file scripts/operations/__tests__/operator-queue-reconcile-notes.test.mjs
 * @description Proof of #4191 (epic #4075/#3383)'s ESCALATIONS feed on `operator-queue.mjs`: `reconcileNotesFor`
 *   shells `node scripts/conveyor/reconcile-pass.mjs --repo=<slug> --json` (the SAME `planReconcile` plan a
 *   reconcile tick runs, reused rather than re-derived, and never a NEW static import — see the function's own
 *   docblock for why), degrading ONE repo's read failure to a single synthetic row rather than failing the
 *   whole report — mirrors `prLimitCounts`'s own degrade-on-failure shape (see that sibling test's own header).
 */
import { describe, it, expect } from 'vitest';
import { reconcileNotesFor } from '../operator-queue.mjs';

describe('reconcileNotesFor', () => {
  it('shells `node .../reconcile-pass.mjs --repo=<slug> --json` and repo-tags every note it returns', () => {
    const fakeResult = {
      notes: [
        { kind: 'ci-heal-exhausted', prNumber: 2636, attempts: 2, cap: 3, lastFailureReason: 'test check failing', text: 'PR #2636: ci-heal attempts exhausted (2/3)' },
      ],
    };
    const exec = (file, args) => {
      expect(file).toBe('node');
      expect(args[0]).toMatch(/reconcile-pass\.mjs$/);
      expect(args[1]).toBe('--repo=web-everything/web-everything');
      expect(args[2]).toBe('--json');
      return JSON.stringify(fakeResult);
    };
    expect(reconcileNotesFor(['web-everything/web-everything'], { exec })).toEqual([
      {
        kind: 'ci-heal-exhausted', prNumber: 2636, attempts: 2, cap: 3, lastFailureReason: 'test check failing',
        text: 'PR #2636: ci-heal attempts exhausted (2/3)', repo: 'web-everything/web-everything',
      },
    ]);
  });

  it('fans out over every requested repo, isolating one repo from another', () => {
    const exec = (file, args) => JSON.stringify({ notes: args[1] === '--repo=a' ? [{ kind: 'awaiting-permission', prNumber: 1, text: 'blocked' }] : [] });
    expect(reconcileNotesFor(['a', 'b'], { exec })).toEqual([
      { kind: 'awaiting-permission', prNumber: 1, text: 'blocked', repo: 'a' },
    ]);
  });

  it('degrades one repo read failure to a single notes-read-failed row — never fails the whole report', () => {
    const exec = (file, args) => {
      if (args[1] === '--repo=broken') throw new Error('spawn node ENOENT');
      return JSON.stringify({ notes: [] });
    };
    expect(reconcileNotesFor(['broken', 'ok'], { exec })).toEqual([
      { repo: 'broken', kind: 'notes-read-failed', prNumber: null, text: 'spawn node ENOENT' },
    ]);
  });

  it('degrades to a notes-read-failed row on unparsable output', () => {
    expect(reconcileNotesFor(['x'], { exec: () => 'not json' })[0]).toMatchObject({ repo: 'x', kind: 'notes-read-failed' });
  });

  it('tolerates an empty repo list', () => {
    expect(reconcileNotesFor([], { exec: () => '{}' })).toEqual([]);
  });
});
