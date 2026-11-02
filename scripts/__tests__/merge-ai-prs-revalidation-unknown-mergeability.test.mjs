/**
 * @file merge-ai-prs-revalidation-unknown-mergeability.test.mjs — live 2026-10-09: accepted, ready-to-merge PRs
 *   (#4602 for 46+ min, #4578, #4591, …) were skipped EVERY pass as `unknown-mergeability … source:
 *   revalidationAborted`, while a direct read minutes later said MERGEABLE/CLEAN. Each pass merged the first one
 *   or two candidates; that merge moved `main`, GitHub reset every other open PR's `mergeable` to UNKNOWN while it
 *   recomputed in the background, and the pre-merge fresh re-read (seconds later) saw UNKNOWN and refused the
 *   rest of the cascade. The fix re-reads a transient UNKNOWN a bounded number of times (a short wait between
 *   reads) before refusing; every other refusal, and an UNKNOWN that never resolves, stays exactly as before.
 *   The fixture is tonight's own skip records from the drain daemon log.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  revalidateForMerge, isTransientUnknownMergeability, resolveUnknownMergeabilityRetry, revalidateWithUnknownRetry,
  UNKNOWN_MERGEABILITY_RETRY, UNKNOWN_MERGEABILITY_RETRY_ENV,
} from '../merge-ai-prs.mjs';

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'drain-unknown-mergeability-skips-2026-10-09.json'), 'utf8'));

const HEAD = 'a'.repeat(40);
const pr = (over = {}) => ({
  number: 4602, title: 't', body: 'A real summary of the change.', headRefName: 'lane/xbx2igr-prevention-card', headRefOid: HEAD,
  baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  labels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }],
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  commits: [{ authors: [{ name: 'Claude', email: 'noreply@anthropic.com' }], messageBody: 'Co-Authored-By: Claude <noreply@anthropic.com>' }],
  ...over,
});
const opts = { requiredCheck: 'test', defaultBranch: 'main', expectedHeadSha: HEAD };

describe('tonight\'s skip records', () => {
  it('every revalidationAborted record is the transient UNKNOWN shape the retry targets', () => {
    expect(fixture.revalidationAborted.length).toBeGreaterThan(0);
    for (const r of fixture.revalidationAborted) {
      expect(r.kind).toBe('unknown-mergeability');
      expect(isTransientUnknownMergeability({ decision: 'skip', reason: r.reason }), `#${r.num}`).toBe(true);
    }
  });

  it('no other refusal is retried — a CodeQL hold, a head move, a red check or a conflict refuse at once', () => {
    for (const r of fixture.otherKinds) expect(isTransientUnknownMergeability({ decision: 'skip', reason: r.reason }), r.kind).toBe(false);
    for (const reason of [
      'head moved since the pass-start decision (aaaaaaaaa → bbbbbbbbb) — the new head is re-judged next pass, review gate included',
      'required check "test" is not green',
      'not mergeable (mergeable=CONFLICTING)',
      'could not re-read the PR fresh right before merging — refusing to merge on stale pass-start data',
    ]) expect(isTransientUnknownMergeability({ decision: 'skip', reason }), reason).toBe(false);
    expect(isTransientUnknownMergeability({ decision: 'merge', reason: 'x' })).toBe(false);
    expect(isTransientUnknownMergeability(null)).toBe(false);
  });

  it('the pass-start classifier produces exactly that reason for an UNKNOWN read', () => {
    const v = revalidateForMerge(pr({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }), opts);
    expect(v.decision).toBe('skip');
    expect(isTransientUnknownMergeability(v)).toBe(true);
  });
});

describe('setting', () => {
  it('defaults to a short bounded wait, and the env knob can only set sane bounded values', () => {
    expect(resolveUnknownMergeabilityRetry({})).toEqual(UNKNOWN_MERGEABILITY_RETRY);
    expect(UNKNOWN_MERGEABILITY_RETRY.retries * UNKNOWN_MERGEABILITY_RETRY.delayMs).toBeLessThanOrEqual(60_000);
    expect(resolveUnknownMergeabilityRetry({ [UNKNOWN_MERGEABILITY_RETRY_ENV]: '0' }).retries).toBe(0);
    expect(resolveUnknownMergeabilityRetry({ [UNKNOWN_MERGEABILITY_RETRY_ENV]: '2' }).retries).toBe(2);
    for (const bad of ['', 'x', '-1', '1.5', '99']) {
      expect(resolveUnknownMergeabilityRetry({ [UNKNOWN_MERGEABILITY_RETRY_ENV]: bad }), bad).toEqual(UNKNOWN_MERGEABILITY_RETRY);
    }
  });
});

describe('revalidateWithUnknownRetry', () => {
  it('persistent UNKNOWN remains refused when recovery hooks throw', async () => {
    const fresh = pr({ mergeable: 'UNKNOWN' });
    const calls = [];
    const verdict = await revalidateWithUnknownRetry({
      repo: 'example/web', num: fresh.number, opts,
      read: async () => fresh, setting: { retries: 0, delayMs: 0 },
      sleep: () => { throw new Error('zero retries must not sleep'); },
      onPersistentUnknown: async payload => {
        calls.push(['persist', payload]);
        throw new Error('marks file unavailable');
      },
      nudge: async payload => {
        calls.push(['nudge', payload]);
        throw new Error('mergeability read unavailable');
      },
    });
    expect(verdict).toEqual(revalidateForMerge(fresh, opts));
    expect(verdict.decision).toBe('skip');
    expect(isTransientUnknownMergeability(verdict)).toBe(true);
    const payload = { repo: 'example/web', num: fresh.number, verdict };
    expect(calls).toEqual([['persist', payload], ['nudge', payload]]);
  });

  it('nudge runs when persistence hook throws', async () => {
    const fresh = pr({ mergeable: 'UNKNOWN' });
    const calls = [];
    const verdict = await revalidateWithUnknownRetry({
      repo: 'example/web', num: fresh.number, opts,
      read: async () => fresh, setting: { retries: 0, delayMs: 0 },
      sleep: () => { throw new Error('zero retries must not sleep'); },
      onPersistentUnknown: payload => {
        calls.push(['persist', payload]);
        throw new Error('marks file unavailable');
      },
      nudge: async payload => {
        calls.push(['nudge', payload]);
        return { decision: 'merge', mergeable: 'MERGEABLE' };
      },
    });
    expect(verdict).toEqual(revalidateForMerge(fresh, opts));
    expect(verdict.decision).toBe('skip');
    expect(isTransientUnknownMergeability(verdict)).toBe(true);
    const payload = { repo: 'example/web', num: fresh.number, verdict };
    expect(calls).toEqual([['persist', payload], ['nudge', payload]]);
  });

  const run = (reads, setting = { retries: 4, delayMs: 3000 }) => {
    const slept = [];
    let i = 0;
    const p = revalidateWithUnknownRetry({
      read: async () => reads[Math.min(i++, reads.length - 1)], opts, setting, sleep: (ms) => slept.push(ms),
    });
    return p.then((v) => ({ v, reads: i, slept }));
  };

  it('#4602 live shape: UNKNOWN right after a cascade merge, MERGEABLE on a re-read → merges, pinned to the judged head', async () => {
    const { v, reads, slept } = await run([pr({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }), pr()]);
    expect(v.decision).toBe('merge');
    expect(v.headSha).toBe(HEAD);
    expect(reads).toBe(2);
    expect(slept).toEqual([3000]);
  });

  it('fails closed when UNKNOWN never resolves within the bound (same refusal as before, bounded reads)', async () => {
    const { v, reads, slept } = await run([pr({ mergeable: 'UNKNOWN' })]);
    expect(v.decision).toBe('skip');
    expect(isTransientUnknownMergeability(v)).toBe(true);
    expect(reads).toBe(5);
    expect(slept).toEqual([3000, 3000, 3000, 3000]);
  });

  it('a re-read that turns CONFLICTING, moves the head, or misses is refused at once — never retried past it', async () => {
    const conflict = await run([pr({ mergeable: 'UNKNOWN' }), pr({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), pr()]);
    expect(conflict.v.decision).toBe('skip');
    expect(conflict.reads).toBe(2);
    const moved = await run([pr({ mergeable: 'UNKNOWN' }), pr({ headRefOid: 'b'.repeat(40) }), pr()]);
    expect(moved.v.reason).toMatch(/^head moved/);
    expect(moved.reads).toBe(2);
    const missed = await run([pr({ mergeable: 'UNKNOWN' }), null, pr()]);
    expect(missed.v.decision).toBe('skip');
    expect(missed.reads).toBe(2);
  });

  it('a clean first read costs one read and no wait; retries=0 keeps the old single-read behaviour', async () => {
    const clean = await run([pr()]);
    expect(clean).toMatchObject({ reads: 1, slept: [] });
    expect(clean.v.decision).toBe('merge');
    const off = await run([pr({ mergeable: 'UNKNOWN' }), pr()], { retries: 0, delayMs: 3000 });
    expect(off).toMatchObject({ reads: 1, slept: [] });
    expect(off.v.decision).toBe('skip');
  });
});

it('re-polls UNKNOWN listings inside the pass, waiting for each delay and refreshing head facts', async () => {
  const { repollUnknownListings } = await import('../merge-ai-prs.mjs');
  const rows = new Map([['o/r', [pr({ mergeable: 'UNKNOWN' }), pr({ number: 9 })]]]);
  const calls = [];
  await repollUnknownListings({ prsByRepo: rows, setting: { retries: 3, delayMs: 20_000 },
    sleep: async ms => { await Promise.resolve(); calls.push(ms); },
    read: async (repo, num) => { calls.push([repo, num]); return pr({ headRefOid: 'b'.repeat(40) }); } });
  expect(calls).toEqual([20_000, ['o/r', 4602]]);
  expect(rows.get('o/r')[0].headRefOid).toBe('b'.repeat(40));
});
it('bounds unresolved listings to three re-polls', async () => {
  const { repollUnknownListings } = await import('../merge-ai-prs.mjs');
  let reads = 0;
  await repollUnknownListings({ prsByRepo: new Map([['o/r', [pr({ mergeable: 'UNKNOWN' })]]]),
    read: async () => { reads++; return pr({ mergeable: 'UNKNOWN' }); }, sleep: async () => {} });
  expect(reads).toBe(3);
});

describe('drain.mergeableUnknownRepollSec — each cascade layer moves the re-poll wait', () => {
  const none = { tool: {}, platform: {} };
  it('standard: exactly 20 s', () => {
    expect(resolveUnknownMergeabilityRetry({}, none).delayMs).toBe(20_000);
  });
  it('platform, then tool, then env (WE_DRAIN_MERGEABLE_UNKNOWN_REPOLL_SEC) each win over the layer below', () => {
    expect(resolveUnknownMergeabilityRetry({}, { tool: {}, platform: { mergeableUnknownRepollSec: 11 } }).delayMs).toBe(11_000);
    expect(resolveUnknownMergeabilityRetry({}, { tool: { mergeableUnknownRepollSec: 9 }, platform: { mergeableUnknownRepollSec: 11 } }).delayMs).toBe(9_000);
    expect(resolveUnknownMergeabilityRetry({ WE_DRAIN_MERGEABLE_UNKNOWN_REPOLL_SEC: '7' }, { tool: { mergeableUnknownRepollSec: 9 }, platform: {} }).delayMs).toBe(7_000);
  });
  it('an out-of-range value falls back to the layer below', () => {
    expect(resolveUnknownMergeabilityRetry({ WE_DRAIN_MERGEABLE_UNKNOWN_REPOLL_SEC: '99999' }, none).delayMs).toBe(20_000);
  });
});

describe('runCli wiring', () => {
  it('re-polls UNKNOWN listings before the head-bound open-PR context is collected', async () => {
    const { repollThenCollectContext } = await import('../merge-ai-prs.mjs');
    const order = [];
    const ctx = await repollThenCollectContext({
      repoll: async () => { await Promise.resolve(); order.push('repoll'); },
      collect: async () => { order.push('collect'); return { contextComplete: true }; },
    });
    expect(order).toEqual(['repoll', 'collect']);
    expect(ctx).toEqual({ contextComplete: true });
  });
  it('a ci-lifecycle ci:failed add wakes the fix daemon after its write; a failed write wakes nothing', async () => {
    const { applyCiLifecycleLabelPlan } = await import('../merge-ai-prs.mjs');
    const calls = [];
    const exec = (_cmd, args) => { calls.push(args.slice(-2)); if (args.includes('broken')) throw new Error('HTTP 422'); return ''; };
    const signal = e => calls.push(['signal', e.label, e.repo, e.pr]);
    expect(applyCiLifecycleLabelPlan({ plan: { toRemove: ['checking'], toAdd: ['ci:failed'] }, pr: 7, repo: null, slug: 'o/r', exec, signal })).toBe(true);
    expect(calls).toEqual([['--remove-label', 'checking'], ['--add-label', 'ci:failed'], ['signal', 'ci:failed', 'o/r', 7]]);
    calls.length = 0;
    expect(applyCiLifecycleLabelPlan({ plan: { toRemove: [], toAdd: ['broken'] }, pr: 7, repo: 'o/r', exec, signal })).toBe(false);
    expect(calls).toEqual([['--add-label', 'broken']]);
  });
  it('runCli routes its context read and its ci-lifecycle writes through those two seams', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs'), 'utf8');
    const run = src.slice(src.indexOf('async function runCli('));
    const seam = run.indexOf('await repollThenCollectContext({');
    expect(seam).toBeGreaterThan(0);
    expect(run.indexOf('collectContext(liveListingsByRepo)')).toBeGreaterThan(seam);
    expect(run.indexOf('collectContext(liveListingsByRepo)')).toBe(run.lastIndexOf('collectContext(liveListingsByRepo)'));
    expect(run).toContain('applyCiLifecycleLabelPlan({ plan, pr: p.number');
    expect(run).not.toMatch(/'--add-label', add\]/);
  });
});
