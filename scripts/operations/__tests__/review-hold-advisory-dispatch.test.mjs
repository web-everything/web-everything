import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dispatchReviewByMode } from '../review-job.mjs';
import { readReviewCiGate } from '../../lib/review-ci-gate-io.mjs';

const REPO = 'frontier-ui/frontierui'; // No default fast-check list: use this repo's required checks.
const HEAD = 'a'.repeat(40);

describe.each(['session', 'job'])('%s advisory waiver with required-check timing', mode => {
  it.each(['ci-green', 'fast-checks'])('starts review-only red with %s', startAfter => {
    const result = probe({ mode, startAfter });
    expect(result.ci).toMatchObject({ allowed: false, reason: 'required-review-gate-conflict' });
    expect(result.out.skipped).toBeUndefined();
    expect(result.spawns).toBe(1);
  });

  it.each(['no-waiver', 'mismatched', 'no-head', 'head-changed', 'unreadable', 'untrusted', 'unknown-required', 'missing', 'malformed', 'wrong-head'])(
    'fast-check fallback still refuses %s', state => {
      const result = probe({ mode, startAfter: 'fast-checks', state });
      expect(result.out.skipped).toMatch(/^review-ci:/);
      expect(result.spawns).toBe(0);
    },
  );

  it.each(['key', 'slug', 'array'])('does not waive an explicitly configured fast-check prerequisite (%s)', shape => {
    const result = probe({ mode, startAfter: 'fast-checks', state: `explicit-fast-${shape}` });
    expect(result.out.skipped).toMatch(/^review-ci:/);
    expect(result.spawns).toBe(0);
  });
});

function probe({ mode, startAfter, state = 'matching' }) {
  const dir = mkdtempSync(join(tmpdir(), 'review-hold-advisory-'));
  let ci;
  let spawns = 0;
  let headReads = 0;
  try {
    const out = dispatchReviewByMode({ mode, pr: 5911, repo: REPO, root: '/daemon', dir,
      env: { WE_REVIEW_START_AFTER: startAfter,
        ...(state.startsWith('explicit-fast-') ? { WE_REVIEW_FAST_CHECKS: JSON.stringify(state.endsWith('array') ? ['review-gate']
          : { [state.endsWith('slug') ? REPO : 'frontierui']: ['review-gate'] }) } : {}) },
      advisoryCiWaiver: state === 'no-waiver' ? null : { head: (state === 'mismatched' ? 'b' : 'A').repeat(40), reason: 'review-hold' },
      ciGate: args => (ci = readReviewCiGate({ ...args,
        readHead: () => state === 'no-head' ? null : state === 'head-changed' && headReads++ ? 'b'.repeat(40) : HEAD,
        readRequired: () => ({ source: state === 'untrusted' ? 'fallback' : 'live',
          checks: state === 'unknown-required' ? [] : ['test', 'review-gate'] }),
        readChecks: () => {
          if (state === 'unreadable') throw new Error('offline');
          return [
            ...(state === 'missing' ? [] : [{ name: 'test', status: state === 'malformed' ? null : 'completed', conclusion: 'success',
              ...(state === 'wrong-head' ? { head_sha: 'b'.repeat(40) } : {}) }]),
            { name: 'review-gate', status: 'completed', conclusion: 'failure' },
          ];
        },
      })),
      checkoutExists: () => true, checkStaleness: () => ({ fresh: true, behind: 0 }), stackCheck: () => ({ base: null }),
      readCompletion: () => null, resolveSettingsEnv: () => ({}),
      readBrief: () => 'review {{PR}}', mintSessionId: () => 'advisory-waiver-test',
      wrapReview: false, sessionCwdFor: () => dir,
      ensureSessionCwd: path => path, isolateSession: () => ({ worktreeSettings: {} }),
      spawnAgent: () => { spawns++; return ''; }, spawnJob: () => { spawns++; return 4242; },
    });
    return { out, ci, spawns };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
