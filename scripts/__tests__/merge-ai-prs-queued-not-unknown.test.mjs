/**
 * @file merge-ai-prs-queued-not-unknown.test.mjs — live 2026-10-21: web-everything#5798 (accepted, ready-to-merge)
 *   read `drain-skip:unknown-mergeability` for 76+ min while it sat in GitHub's merge queue (10:42–11:37 ET), then
 *   once more after GitHub merged it; the pass also reported "merged 2 (#5798, #5798)". GitHub never computes
 *   `mergeable` for a queued, merged or closed PR (#5801 in the queue read UNKNOWN/UNKNOWN while #5771 read
 *   MERGEABLE/CLEAN). 34 PRs / 41 skip lines in 48 h. Queued / merged / closed are now statuses, not skips; only an
 *   OPEN, not-queued UNKNOWN keeps the bounded re-read, then gets a local merge-tree check — never merged on UNKNOWN alone.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyPr, revalidateForMerge, revalidateWithUnknownRetry, repollUnknownListings, isTransientUnknownMergeability,
} from '../merge-ai-prs.mjs';
import { localMergeTreeCheck, prLifecycleStatus, needsLocalMergeCheck } from '../lib/drain-unknown-mergeability.mjs';
import { buildSkipReasons } from '../lib/drain-skip-reasons.mjs';

const HEAD = '94551e25e9e3d63e26509aa7dd395441ef02e677'; // #5798's real head
const pr = (over = {}) => ({
  number: 5798, title: 'prepare — drain confirm a pr is merged before recording it as landed', body: 'A real summary.',
  headRefName: 'lane/5919-prepare-drain-confirm-a-pr-is-merged-before-recording-it-as-landed', headRefOid: HEAD,
  baseRefName: 'main', state: 'OPEN', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN',
  labels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }, { name: 'red-team:clear' }],
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  commits: [{ authors: [{ name: 'Claude', email: 'noreply@anthropic.com' }], messageBody: 'Co-Authored-By: Claude <noreply@anthropic.com>' }],
  ...over,
});
const opts = { requiredCheck: 'test', defaultBranch: 'main', expectedHeadSha: HEAD };
const SETTING = { retries: 3, delayMs: 1 };
const noSleep = async () => {};

describe('queued / merged / closed is a status, not an unknown-mergeability skip', () => {
  it('a merge-queued PR (the live #5798/#5801 read: UNKNOWN/UNKNOWN, isInMergeQueue) is `in-merge-queue`', () => {
    const v = revalidateForMerge(pr({ isInMergeQueue: true }), opts);
    expect(v.decision).not.toBe('merge');
    expect(v.status).toBe('in-merge-queue');
    expect(isTransientUnknownMergeability(v)).toBe(false);
    expect(v.reason).not.toMatch(/mergeable=UNKNOWN/);
  });

  it('a MERGED PR is `landed` and a CLOSED one `closed` — neither is a skip row', () => {
    const merged = classifyPr(pr({ state: 'MERGED', mergeable: null }), { requiredCheck: 'test', defaultBranch: 'main' });
    const closed = classifyPr(pr({ state: 'CLOSED' }), { requiredCheck: 'test', defaultBranch: 'main' });
    const queued = classifyPr(pr({ isInMergeQueue: true }), { requiredCheck: 'test', defaultBranch: 'main' });
    expect([merged.status, closed.status, queued.status]).toEqual(['landed', 'closed', 'in-merge-queue']);
    for (const v of [merged, closed, queued]) expect(v.decision).not.toBe('merge'); // fail closed: never a merge
    const rows = buildSkipReasons({ verdicts: [merged, closed, queued].map((v) => ({ ...v, repo: 'web-everything/web-everything' })) });
    expect(rows).toEqual([]);
  });

  it('a queued PR is answered by ONE fresh read — no retry bound burnt, no local check run', async () => {
    let reads = 0; let checks = 0;
    const v = await revalidateWithUnknownRetry({ read: async () => { reads += 1; return pr({ isInMergeQueue: true }); }, opts, setting: SETTING, sleep: noSleep, localCheck: () => { checks += 1; return { clean: true }; } });
    expect(v.status).toBe('in-merge-queue');
    expect([reads, checks]).toEqual([1, 0]);
  });

  it('the pass-start re-poll drops a queued PR after its first fresh read', async () => {
    const listed = pr({ state: undefined, mergeable: 'UNKNOWN' });
    let reads = 0;
    await repollUnknownListings({ prsByRepo: new Map([[null, [listed]]]), read: async () => { reads += 1; return pr({ isInMergeQueue: true }); }, sleep: noSleep, setting: SETTING, localCheck: () => { throw new Error('must not run'); } });
    expect(reads).toBe(1);
    expect(prLifecycleStatus(listed)?.status).toBe('in-merge-queue');
  });
});

describe('a real UNKNOWN (open, not queued) — bounded re-read, then the local merge-tree check decides', () => {
  const stillUnknown = () => pr({ isInMergeQueue: false });

  it('clean local check → mergeable, with the basis named in the reason', async () => {
    let reads = 0;
    const v = await revalidateWithUnknownRetry({ read: async () => { reads += 1; return stillUnknown(); }, opts: { ...opts, queueRequiredChecks: ['test'] }, setting: SETTING, sleep: noSleep, localCheck: (fresh) => { expect(fresh.headRefOid).toBe(HEAD); return { clean: true }; } });
    expect(reads).toBe(4); // the existing bound still runs first
    expect(v.decision).toBe('merge');
    expect(v.headSha).toBe(HEAD);
    expect(v.reason).toMatch(/local merge-tree check of the pinned head against the base is clean/);
  });

  it('conflicting local check → CONFLICTING skip naming the files', async () => {
    const v = await revalidateWithUnknownRetry({ read: async () => stillUnknown(), opts, setting: SETTING, sleep: noSleep, localCheck: () => ({ conflict: true, files: ['backlog/5919.md'] }) });
    expect(v.decision).toBe('skip');
    expect(v.reason).toMatch(/mergeable=CONFLICTING.*local merge-tree found conflicts: backlog\/5919\.md/);
  });

  it('never merges on UNKNOWN alone: an unreadable check, a throwing check, or no check keeps the UNKNOWN refusal', async () => {
    for (const localCheck of [() => ({ error: 'fetch failed' }), () => { throw new Error('boom'); }, null]) {
      const v = await revalidateWithUnknownRetry({ read: async () => stillUnknown(), opts, setting: SETTING, sleep: noSleep, localCheck });
      expect(v.decision).toBe('skip');
      expect(isTransientUnknownMergeability(v)).toBe(true);
    }
  });

  it('a clean local check never overrides a red check, a review hold or a moved head', async () => {
    const red = await revalidateWithUnknownRetry({ read: async () => pr({ isInMergeQueue: false, statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] }), opts, setting: SETTING, sleep: noSleep, localCheck: () => ({ clean: true }) });
    expect(red.decision).toBe('skip');
    const held = await revalidateWithUnknownRetry({ read: async () => pr({ isInMergeQueue: false, labels: [{ name: 'ready-to-merge' }, { name: 'review:changes' }] }), opts, setting: SETTING, sleep: noSleep, localCheck: () => ({ clean: true }) });
    expect(held.decision).toBe('skip');
    const moved = await revalidateWithUnknownRetry({ read: async () => pr({ isInMergeQueue: false, headRefOid: 'f'.repeat(40) }), opts, setting: SETTING, sleep: noSleep, localCheck: () => ({ clean: true }) });
    expect(moved.decision).toBe('skip');
    expect(moved.reason).toMatch(/^head moved/);
  });

  it('a clean local check proves conflict freedom only — branch protection must still pass (Codex audit finding 1)', async () => {
    const run = (over, o = { ...opts, queueRequiredChecks: ['test'] }) => revalidateWithUnknownRetry({ read: async () => pr({ isInMergeQueue: false, ...over }), opts: o, setting: SETTING, sleep: noSleep, localCheck: () => ({ clean: true }) });
    for (const reviewDecision of ['REVIEW_REQUIRED', 'CHANGES_REQUESTED']) {
      const v = await run({ reviewDecision });
      expect(v.decision, reviewDecision).toBe('skip');
      expect(v.reason).toMatch(new RegExp(`reviewDecision=${reviewDecision}`));
    }
    // unknown / empty live requirements fail closed (Codex re-audit): a red unnamed check must not slip through
    const redUnnamed = { statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'security-policy', status: 'COMPLETED', conclusion: 'FAILURE' }] };
    for (const queueRequiredChecks of [null, []]) {
      const v = await run(redUnnamed, { ...opts, queueRequiredChecks });
      expect(v.decision, JSON.stringify(queueRequiredChecks)).toBe('skip');
    }
    const missing = await run({}, { ...opts, queueRequiredChecks: ['test', 'merge-gate'] });
    expect(missing.decision).toBe('skip');
    expect(missing.reason).toMatch(/merge-gate \(missing\)/);
    const allGreen = await run({ statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'merge-gate', status: 'COMPLETED', conclusion: 'SUCCESS' }] }, { ...opts, queueRequiredChecks: ['test', 'merge-gate'] });
    expect(allGreen.decision).toBe('merge');
    expect(allGreen.state).toBe('UNKNOWN'); // never synthesized CLEAN
  });

  it('a known merge state (CLEAN/UNSTABLE) with mergeable UNKNOWN gets no local check, and a local MERGEABLE never skips protection (Codex re-audit 3)', async () => {
    let checks = 0;
    for (const mergeStateStatus of ['CLEAN', 'UNSTABLE']) {
      const v = await revalidateWithUnknownRetry({ read: async () => pr({ isInMergeQueue: false, mergeStateStatus, reviewDecision: 'REVIEW_REQUIRED' }), opts: { ...opts, queueRequiredChecks: ['test'] }, setting: SETTING, sleep: noSleep, localCheck: () => { checks += 1; return { clean: true }; } });
      expect(v.decision, mergeStateStatus).toBe('skip');
    }
    expect(checks).toBe(0);
    for (const mergeStateStatus of ['CLEAN', 'UNSTABLE', 'UNKNOWN']) {
      const v = classifyPr(pr({ mergeable: 'MERGEABLE', mergeabilityFrom: 'local-merge-tree', mergeStateStatus, reviewDecision: 'REVIEW_REQUIRED' }), { requiredCheck: 'test', defaultBranch: 'main', queueRequiredChecks: ['test'] });
      expect(v.decision, mergeStateStatus).toBe('skip');
      expect(v.reason).toMatch(/branch protection is not proven; reviewDecision=REVIEW_REQUIRED/);
    }
  });

  it('the pass-start re-poll applies the local check only to the still-UNKNOWN open, not-queued rows', async () => {
    const a = pr({ number: 1, state: undefined });
    const b = pr({ number: 2, state: undefined });
    const checked = [];
    await repollUnknownListings({ prsByRepo: new Map([[null, [a, b]]]), sleep: noSleep, setting: SETTING,
      read: async (_r, n) => pr({ number: n, isInMergeQueue: n === 2 }),
      localCheck: (_repo, p) => { checked.push(p.number); return { clean: true }; } });
    expect(checked).toEqual([1]);
    expect([a.mergeable, a.mergeStateStatus, a.mergeabilityFrom]).toEqual(['MERGEABLE', 'UNKNOWN', 'local-merge-tree']);
    expect(b.mergeable).toBe('UNKNOWN');
    expect(needsLocalMergeCheck(b)).toBe(false);
  });
});

describe('localMergeTreeCheck (injected git)', () => {
  const runner = ({ fetch = 0, tip = HEAD, mt = 0, mtOut = '' } = {}) => {
    const calls = [];
    const run = (cmd, args) => {
      calls.push(args[0]);
      if (args[0] === 'fetch') return { status: fetch, stdout: '', stderr: fetch ? 'fatal: couldn\'t find remote ref' : '' };
      if (args[0] === 'rev-parse') return { status: 0, stdout: `${tip}\n` };
      if (args[0] === 'merge-tree') return { status: mt, stdout: mtOut, stderr: mt > 1 ? 'fatal: bad object' : '' };
      throw new Error(`unexpected git ${args.join(' ')}`);
    };
    return { run, calls };
  };
  const base = { cwd: '/clone', num: 5798, base: 'main', headSha: HEAD };

  it('clean / conflict / error', () => {
    expect(localMergeTreeCheck({ ...base, run: runner().run })).toEqual({ clean: true });
    expect(localMergeTreeCheck({ ...base, run: runner({ mt: 1, mtOut: `${'a'.repeat(40)}\nbacklog/x.md\nscripts/y.mjs\n` }).run })).toEqual({ conflict: true, files: ['backlog/x.md', 'scripts/y.mjs'] });
    expect(localMergeTreeCheck({ ...base, run: runner({ mt: 128 }).run }).error).toMatch(/merge-tree failed/);
    expect(localMergeTreeCheck({ ...base, run: runner({ fetch: 1 }).run }).error).toMatch(/fetch failed/);
  });

  it('refuses a fetched tip that is not the pinned head (never checks a different commit)', () => {
    const r = runner({ tip: 'e'.repeat(40) });
    expect(localMergeTreeCheck({ ...base, run: r.run }).error).toMatch(/not the pinned head/);
    expect(r.calls).not.toContain('merge-tree');
  });

  it('refuses without a clone or a 40-hex head', () => {
    expect(localMergeTreeCheck({ ...base, cwd: null, run: runner().run }).error).toBeTruthy();
    expect(localMergeTreeCheck({ ...base, headSha: 'abc', run: runner().run }).error).toBeTruthy();
  });
});
