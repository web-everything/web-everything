/**
 * @file net-scope.test.mjs — card xd1tvd0. A PR's scope is its git net diff against current main, and a stale-base
 * rebase is never blocked by scope-overlap.
 *
 * Replay of live 2026-10-09 ~04:00Z (fixture `stuck-2026-10-09.json`, captured from the seven stuck PRs plus the
 * in-flight fix #4527 they waited on): GitHub's PR file lists (still diffed against each PR's old base, capped at 100)
 * made the review daemon refuse every review as scope-bloat and the fix daemon refuse every rebase as scope-overlap.
 * Each "before" case reproduces the live refusal with the settings off; each "after" case is RED on the code before
 * this card (no net-scope module, no exemption).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NET_SCOPE_OFF, resolveNetScopeSettings, scopeFilesFor, isRebaseOnlyFix, rebaseOverlapExemption, markRebaseExemptUsed,
  withNetFences, noBaseFetchGit, applyNetScopeToReconcile,
} from '../net-scope.mjs';
import { assessScopeBloat, enrichPrsWithScopeBloat } from '../scope-bloat.mjs';
import { filterFixesByInFlightScope } from '../reconcile-fix-dispatch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const LIVE = JSON.parse(readFileSync(join(here, 'fixtures', 'net-scope', 'stuck-2026-10-09.json'), 'utf8'));
const STUCK = LIVE.prs.filter((p) => p.number !== 4527);
const INFLIGHT = LIVE.prs.find((p) => p.number === 4527);
const ON = { scopeBloat: true, fixOverlap: true, rebaseExempt: true };
const we = (files) => files.map((f) => `we:${f}`);
const noFile = () => { throw new Error('ENOENT'); };

describe('settings — declared, off = the behaviour before the card', () => {
  it('a missing or malformed file is off for every rule', () => {
    expect(resolveNetScopeSettings({}, { read: noFile })).toEqual(NET_SCOPE_OFF);
    expect(resolveNetScopeSettings({}, { read: () => '{not json' })).toEqual(NET_SCOPE_OFF);
    expect(resolveNetScopeSettings({}, { read: () => '{"netScope":{"scopeBloat":"maybe"}}' })).toEqual(NET_SCOPE_OFF);
  });
  it('the file turns rules on, and env beats the file either way', () => {
    const file = () => '{"netScope":{"scopeBloat":"on","fixOverlap":true,"rebaseExempt":"off"}}';
    expect(resolveNetScopeSettings({}, { read: file })).toEqual({ scopeBloat: true, fixOverlap: true, rebaseExempt: false });
    expect(resolveNetScopeSettings({ WE_NET_SCOPE_SCOPE_BLOAT: 'off', WE_NET_SCOPE_REBASE_EXEMPT: '1' }, { read: file }))
      .toEqual({ scopeBloat: false, fixOverlap: true, rebaseExempt: true });
  });
  it('the shipped settings file declares all three rules on', () => {
    expect(resolveNetScopeSettings({})).toEqual(ON);
  });
});

describe('replay 2026-10-09 — review side: scope-bloat judged on the git net diff', () => {
  const before = (p) => assessScopeBloat({ prFiles: p.githubFiles, netFiles: p.twoDotFiles, env: {} });
  const after = (p) => assessScopeBloat({ prFiles: scopeFilesFor({ net: { ok: true, files: p.netFiles }, listed: p.githubFiles }).files, netFiles: p.twoDotFiles, env: {} });

  it('before: every stuck PR the review daemon refused reads as a stale base on GitHub\'s list', () => {
    for (const p of STUCK) {
      expect(p.beforeReview, `#${p.number}`).toMatch(/scope-bloat/);
      expect(before(p), `#${p.number}`).toMatchObject({ reason: 'scope-bloat', stale: true });
    }
    expect(before(STUCK.find((p) => p.number === 4439)).files).toBe(100); // the live "N of its 100 files"
  });
  it('after: on the git net diff no stuck PR is bloated, so each is owed a review', () => {
    for (const p of STUCK) {
      expect(p.netFiles.length, `#${p.number}`).toBeLessThan(p.githubFiles.length);
      expect(after(p), `#${p.number}`).toBeNull();
    }
  });
  it('a genuinely stale branch is still caught: net-diff files whose content already matches main', () => {
    const own = ['scripts/a.mjs', 'scripts/b.mjs'];
    const landed = ['scripts/x.mjs', 'scripts/y.mjs', 'scripts/z.mjs'];
    const bloat = assessScopeBloat({ prFiles: scopeFilesFor({ net: { ok: true, files: [...own, ...landed] } }).files, netFiles: own, env: {} });
    expect(bloat).toMatchObject({ stale: true, alreadyOnMain: landed });
  });
  it('enrichPrsWithScopeBloat judges the merge-base net when the setting is on, GitHub\'s list when off or unreadable', () => {
    const p = STUCK.find((x) => x.number === 4439);
    const pr = { number: p.number, headRefOid: p.headRefOid, headRefName: p.headRefName, title: p.title, files: p.githubFiles.map((path) => ({ path })) };
    const readers = { readNet: () => p.twoDotFiles, readScope: () => null, readBaseSha: () => 'base-a', env: {} };
    const net = () => ({ ok: true, files: p.netFiles });
    expect(enrichPrsWithScopeBloat([pr], { ...readers, readMergeBaseNet: net, netScope: ON })[0].scopeBloat).toBeUndefined();
    expect(enrichPrsWithScopeBloat([pr], { ...readers, readBaseSha: () => 'base-b', readMergeBaseNet: net, netScope: NET_SCOPE_OFF })[0].scopeBloat).toMatchObject({ stale: true });
    expect(enrichPrsWithScopeBloat([pr], { ...readers, readBaseSha: () => 'base-c', readMergeBaseNet: () => ({ ok: false, reason: 'no git' }), netScope: ON })[0].scopeBloat).toMatchObject({ stale: true });
  });
});

describe('replay 2026-10-09 — fix side: scope-overlap fences are the git net diff', () => {
  const claim = (files) => [{ meta: { pr: INFLIGHT.number, scope: we(files) } }];
  const planned = (key) => STUCK.map((p, i) => ({ pr: p.number, itemNum: null, scope: we(p[key]), overlapScope: we(p[key]), headRefOid: p.headRefOid,
    waitingSince: new Date(Date.parse(LIVE.capturedAt) - (i + 1) * 60_000).toISOString() }));
  const opts = { now: Date.parse(LIVE.capturedAt), maxWaitMinutes: null, rebaseExempt: null };

  it('before: on GitHub\'s lists every stuck PR waits behind the in-flight fix #4527, as the fix daemon logged', () => {
    const r = filterFixesByInFlightScope(planned('githubFiles'), [], claim(INFLIGHT.githubFiles), opts);
    expect(r.planned).toEqual([]);
    for (const p of STUCK) expect(p.beforeFix, `#${p.number}`).toMatch(/scope-overlap .* overlaps in-flight fix PR #\d+/);
  });
  it('after: on the net diffs only PRs that really share files wait', () => {
    const r = filterFixesByInFlightScope(planned('netFiles'), [], claim(INFLIGHT.netFiles), opts);
    // #4512 really shares build-dispatch-policy.mjs + build-dispatch-daemon.mjs with #4527; #4453 really shares three
    // test files with #4439 (which ranks ahead of it). The other five no longer wait on anyone.
    expect(r.refusals.map((x) => x.pr).sort()).toEqual([4453, 4512]);
    expect(r.planned.map((x) => x.pr).sort()).toEqual([4439, 4479, 4525, 4536, 4538]);
  });
  it('withNetFences swaps dispatch and open-PR fences to the net sets, keeping GitHub\'s list where git did not answer', () => {
    const reconciled = {
      dispatch: [{ kind: 'fix', prNumber: 4439, files: null }, { kind: 'fix', prNumber: 4525, files: ['x'] }],
      openPrFiles: [{ pr: 4527, files: INFLIGHT.githubFiles }, { pr: 9, files: ['kept'] }],
    };
    const nets = new Map([[4439, { ok: true, files: ['a'] }], [4527, { ok: true, files: INFLIGHT.netFiles }], [4525, { ok: false, reason: 'gone' }]]);
    const out = withNetFences(reconciled, nets);
    expect(out.dispatch[0]).toMatchObject({ files: ['a'], filesSource: 'git' });
    expect(out.dispatch[1]).toEqual(reconciled.dispatch[1]);
    expect(out.openPrFiles).toEqual([{ pr: 4527, files: INFLIGHT.netFiles, filesSource: 'git' }, { pr: 9, files: ['kept'] }]);
    expect(withNetFences(reconciled, new Map([[4439, { ok: true, files: Array.from({ length: 100 }, (_, i) => `f${i}`) }]])).dispatch[0].files).toBeNull();
  });
  it('applyNetScopeToReconcile is a no-op with the setting off, and fails open', () => {
    const reconciled = { dispatch: [{ kind: 'fix', prNumber: 1, headRefOid: 'a'.repeat(40), files: ['gh'] }], openPrFiles: [] };
    const readNets = () => new Map([[1, { ok: true, files: ['net'] }]]);
    expect(applyNetScopeToReconcile(reconciled, { settings: NET_SCOPE_OFF, readNets, readHeads: () => new Map() })).toBe(reconciled);
    expect(applyNetScopeToReconcile(reconciled, { settings: ON, readNets, readHeads: () => new Map() }).dispatch[0].files).toEqual(['net']);
    expect(applyNetScopeToReconcile(reconciled, { settings: ON, readNets: () => { throw new Error('x'); }, readHeads: () => new Map() })).toBe(reconciled);
  });
  it('the git reader never fetches main: the daemon\'s self-sync owns origin/main', () => {
    const calls = [];
    const git = noBaseFetchGit((dir, args) => { calls.push(args); return ''; });
    git('/d', ['fetch', '--quiet', '--end-of-options', 'origin', '+refs/heads/main:refs/remotes/origin/main', 'refs/pull/7/head']);
    git('/d', ['fetch', '--quiet', '--end-of-options', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
    expect(calls).toEqual([['fetch', '--quiet', '--end-of-options', 'origin', 'refs/pull/7/head']]);
  });
});

describe('a stale-base rebase is exempt from scope-overlap, once per head', () => {
  const stale = { stale: true, wide: false, why: 'stale' };
  const rebase = (pr, head = 'h'.repeat(40)) => ({ pr, itemNum: null, scope: ['we:a.mjs'], overlapScope: ['we:a.mjs'], headRefOid: head, scopeBloat: stale });
  const blocker = [{ meta: { pr: 99, scope: ['we:a.mjs'] } }];

  it('only a stale-base, not-wide scope-bloat fix is a rebase', () => {
    expect(isRebaseOnlyFix(rebase(1))).toBe(true);
    expect(isRebaseOnlyFix({ scopeBloat: { stale: true, wide: true } })).toBe(false);
    expect(isRebaseOnlyFix({ scopeBloat: { stale: false, wide: true } })).toBe(false);
    expect(isRebaseOnlyFix({})).toBe(false);
  });
  it('without the exemption the rebase waits (today); with it, it is admitted and blocks no later fix', () => {
    const later = { pr: 2, itemNum: null, scope: ['we:a.mjs'], overlapScope: ['we:a.mjs'], headRefOid: 'b'.repeat(40) };
    expect(filterFixesByInFlightScope([rebase(1)], [], blocker, { maxWaitMinutes: null, rebaseExempt: null }).refusals[0]).toMatchObject({ pr: 1, kind: 'scope-overlap' });
    const used = new Set();
    const exempt = (e) => rebaseOverlapExemption(e, { on: true, used });
    const r = filterFixesByInFlightScope([rebase(1), later], [], [], { maxWaitMinutes: null, rebaseExempt: exempt });
    expect(r.planned.map((x) => x.pr).sort()).toEqual([1, 2]);
    expect(r.planned.find((x) => x.pr === 1).overlapExempt).toMatch(/rebase/);
    expect(filterFixesByInFlightScope([rebase(1)], [], blocker, { maxWaitMinutes: null, rebaseExempt: exempt }).planned).toHaveLength(1);
  });
  it('one exempt dispatch per head: a second ask on the same head waits; a new head is exempt again', () => {
    const used = new Set();
    expect(rebaseOverlapExemption(rebase(1), { on: true, used }).exempt).toBe(true);
    markRebaseExemptUsed(rebase(1), used);
    expect(rebaseOverlapExemption(rebase(1), { on: true, used })).toMatchObject({ exempt: false, why: expect.stringMatching(/already/) });
    expect(rebaseOverlapExemption(rebase(1, 'c'.repeat(40)), { on: true, used }).exempt).toBe(true);
    expect(rebaseOverlapExemption(rebase(1), { on: false, used: new Set() }).exempt).toBe(false);
    expect(rebaseOverlapExemption({ ...rebase(1), headRefOid: null }, { on: true, used: new Set() }).exempt).toBe(false);
  });
});
