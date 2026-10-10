import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ANCESTRY_BUDGET, clearUnheldHolds, resetHoldMemo, MAX_COMPARED_PRS, planIdleRestacks, recordRestackAttempt, gitOnMain, readRemembered, writeRemembered, PR_STACK_DEFAULTS, resolvePrStackSettings, detectStacks, bottomOf, abovePrs, applyStackOrder, restackKey, markRestackUsed, withRestackHint, nextRemembered, readStacksForPass, readOriginLaneTips, readOpenPrRefs } from '../pr-stack.mjs';
import { filterFixesByInFlightScope, runReconcileFixDispatch } from '../reconcile-fix-dispatch.mjs';
import { REFUSAL_KINDS } from '../reconcile-core.mjs';

const a = { pr: 4624, headRefName: 'lane/red-main-contain', headRefOid: '459ea6f4fe3c330df5b0640589635cee3f3d5561' };
const b = { pr: 4631, headRefName: 'lane/accept-carry-forward', headRefOid: 'c143be0ddfdf8b0d3501e436fb7632ad03e518f4' };
const ancestor = (x, y) => x === a.headRefOid && y === b.headRefOid;
const NOW = 1_800_000_000_000;
const live = () => detectStacks([a, b], { isAncestor: ancestor, now: () => NOW });
const settings = PR_STACK_DEFAULTS;
const scope = ['we:scripts/merge-ai-prs.mjs', 'we:backlog/xx7ckd6-x.md'];
const entries = [a, b].map(p => ({ pr: p.pr, headRefOid: p.headRefOid, laneRef: p.headRefName, scope }));
const claim = pr => ({ meta: { repo: 'we', pr, scope } });

describe('stack detection and memory', () => {
  it('detects the live content stack and its helpers', () => {
    expect(live().pairs).toEqual([{ top: 4631, bottom: 4624, bottomRef: a.headRefName, bottomHead: a.headRefOid, containedHead: a.headRefOid, topHead: b.headRefOid, bottomOpen: true, inSync: true, restackedFor: null, restackRounds: 0, restackTopHead: null, heldSince: null, heldFor: a.headRefOid }]);
    expect(bottomOf(live(), 4631).bottom).toBe(4624);
    expect(abovePrs(live(), 4624)).toEqual(new Set([4631]));
  });
  it('ignores unrelated, identical, landed and unknown heads', () => {
    for (const isAncestor of [() => false, () => null]) expect(detectStacks([a, b], { isAncestor }).pairs).toEqual([]);
    expect(detectStacks([a, { ...b, headRefOid: a.headRefOid }], { isAncestor: () => true }).pairs).toEqual([]);
    expect(detectStacks([a, b], { isAncestor: ancestor, onMain: () => true }).pairs).toEqual([]);
  });
  it('chooses the nearest bottom in a chain', () => {
    const prs = [1, 2, 3].map(pr => ({ pr, headRefOid: String(pr), headRefName: `lane/${pr}` }));
    const stacks = detectStacks(prs, { isAncestor: (x, y) => Number(x) < Number(y) });
    expect(bottomOf(stacks, 3).bottom).toBe(2);
    expect(abovePrs(stacks, 1)).toEqual(new Set([2, 3]));
  });
  it('remembers moved and closed bottoms, drops closed tops and lets fresh ancestry win', () => {
    const remembered = nextRemembered(live());
    const moved = detectStacks([{ ...a, headRefOid: 'moved' }, b], { remembered, isAncestor: ancestor });
    expect(bottomOf(moved, b.pr)).toMatchObject({ bottomHead: 'moved', inSync: false, bottomOpen: true });
    // A bottom that left the open list is "landed" only when its last head is on main; otherwise it is forgotten.
    expect(detectStacks([b], { remembered, isAncestor: () => false }).pairs).toEqual([]);
    const closed = detectStacks([b], { remembered, isAncestor: () => false, onMain: (sha) => sha === a.headRefOid });
    expect(bottomOf(closed, b.pr)).toMatchObject({ bottomOpen: false, bottomRef: 'main', inSync: false });
    expect(nextRemembered(closed, { dropTops: new Set([b.pr]) })).toEqual([]);
    expect(detectStacks([a], { remembered, isAncestor: () => false }).pairs).toEqual([]);
    expect(bottomOf(detectStacks([a, b], { remembered: [{ ...remembered[0], bottom: 9 }], isAncestor: ancestor }), b.pr).bottom).toBe(a.pr);
  });
});

describe('ordering and restack', () => {
  it('holds the in-sync top and admits the bottom', () => {
    const out = applyStackOrder(entries, live(), { settings });
    expect(out.planned).toEqual([entries[0]]);
    expect(out.refusals[0]).toMatchObject({ pr: b.pr, kind: 'stacked-above' });
    expect(out.stackAbove.get(a.pr)).toEqual(new Set([b.pr]));
  });
  it.each([true, false])('restacks moved/closed bottoms (open=%s), only once per head', bottomOpen => {
    const stacks = { pairs: live().pairs.map(p => ({ ...p, bottomOpen, inSync: false })) };
    const out = applyStackOrder(entries, stacks, { settings });
    const top = out.planned.find(p => p.pr === b.pr);
    expect(top.restack.onto).toBe(bottomOpen ? a.headRefName : 'main');
    expect(top.overlapExempt).toBeTruthy();
    const used = new Set(); markRestackUsed(top, used);
    expect(used.has(restackKey(top))).toBe(true);
    const retry = applyStackOrder(entries, stacks, { settings, used });
    if (bottomOpen) expect(retry.refusals[0].kind).toBe('stacked-above');
    else expect(retry.planned[1].restack).toBeUndefined();
  });
  it('respects each switch', () => {
    expect(applyStackOrder(entries, live(), { settings: { ...settings, detect: false } }).planned).toEqual(entries);
    expect(applyStackOrder(entries, live(), { settings: { ...settings, bottomFirst: false } }).planned).toEqual(entries);
    const moved = { pairs: live().pairs.map(p => ({ ...p, inSync: false })) };
    expect(applyStackOrder(entries, moved, { settings: { ...settings, restack: false } }).refusals[0].kind).toBe('stacked-above');
  });
  it('adds a bounded merge-only prompt with refs as data', () => {
    expect(withRestackHint('prompt', null)).toBe('prompt');
    const hint = withRestackHint('prompt', { bottomPr: a.pr, onto: a.headRefName });
    expect(hint).toContain(JSON.stringify(`origin/${a.headRefName}`));
    expect(hint).toContain('never `--force`');
    expect(withRestackHint('prompt', { bottomPr: a.pr, onto: 'main' })).toContain('already landed');
  });
});

describe('scope regression', () => {
  const opts = { rebaseExempt: null, stackAbove: new Map([[a.pr, new Set([b.pr])]]) };
  it('unblocks the bottom only from its own top', () => {
    expect(filterFixesByInFlightScope([entries[0]], [], [claim(b.pr)], { rebaseExempt: null }).refusals[0].why).toContain('waiting 2nd behind #4631');
    expect(filterFixesByInFlightScope([entries[0]], [], [claim(b.pr)], opts).planned).toEqual([entries[0]]);
    expect(filterFixesByInFlightScope([entries[0]], [], [claim(b.pr), claim(99)], opts).refusals[0].kind).toBe('scope-overlap');
  });
  it('ignores picked tops and exempts restacks without blocking others', () => {
    const top = { ...entries[1], reviewHuman: true };
    expect(filterFixesByInFlightScope([top, entries[0]], [], [], opts).planned).toHaveLength(2);
    const restack = { ...entries[1], overlapExempt: 'restack' };
    expect(filterFixesByInFlightScope([restack], [], [claim(a.pr)], opts).planned).toEqual([restack]);
    expect(filterFixesByInFlightScope([restack, entries[0]], [], [], { rebaseExempt: null }).planned).toHaveLength(2);
  });
  it('dispatches #4624 past the live #4631 claim and holds #4631', () => {
    const out = runReconcileFixDispatch({ root: '/repo', repo: 'we',
      checkStaleness: () => ({ stale: false }),
      reconcile: () => ({ dispatch: [a, b].map(p => ({ ...p, prNumber: p.pr, kind: 'fix', files: scope.map(s => s.slice(3)) })), refusals: [] }),
      prStack: () => live(), prStackSettings: settings,
      findItemFn: () => null, loadItems: () => [], pickFreeLanes: () => [1, 2],
      dispatch: p => ({ pr: p.pr }), tryResume: () => ({ resumed: false }),
      resolveProfile: () => ({ capabilities: { fix: true, ciHeal: true }, canonicalPrefix: 'we' }),
      listBuildClaims: () => [], listFixClaims: () => [claim(b.pr)],
      priorityShadow: null, unsupportedPath: '/tmp/pr-stack-unused.json',
    });
    expect(out.dispatched).toEqual([{ pr: a.pr }]);
    expect(out.refusals).toEqual([expect.objectContaining({ pr: b.pr, kind: 'stacked-above' })]);
  });
  it('starts and saves the hold clock on the pass that withholds the top, then releases it once the age is reached (card xbphfuf wiring)', () => {
    resetHoldMemo();
    const stacks = live();
    const writeStacks = vi.fn();
    const run = () => runReconcileFixDispatch({ root: '/repo', repo: 'we',
      checkStaleness: () => ({ stale: false }),
      reconcile: () => ({ dispatch: [a, b].map(p => ({ ...p, prNumber: p.pr, kind: 'fix', files: scope.map(s => s.slice(3)) })), refusals: [] }),
      prStack: () => stacks, prStackSettings: settings, writeStacks,
      findItemFn: () => null, loadItems: () => [], pickFreeLanes: () => [1, 2],
      dispatch: p => ({ pr: p.pr }), tryResume: () => ({ resumed: false }),
      resolveProfile: () => ({ capabilities: { fix: true, ciHeal: true }, canonicalPrefix: 'we' }),
      listBuildClaims: () => [], listFixClaims: () => [], priorityShadow: null, unsupportedPath: '/tmp/pr-stack-unused.json' });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      const first = run();
      expect(first.dispatched.map(p => p.pr)).toEqual([a.pr]);
      expect(writeStacks).toHaveBeenCalledTimes(1);
      expect(writeStacks.mock.calls[0][1]).toEqual([expect.objectContaining({ top: b.pr, heldSince: NOW, heldFor: a.headRefOid })]);
      vi.setSystemTime(NOW + settings.holdMaxAgeMs);
      const aged = run();
      // Released to ordinary dispatch: it is a peer again, so the scope-overlap fence (same files as #4624) queues it behind the bottom.
      expect(aged.refusals).toEqual(expect.arrayContaining([expect.objectContaining({ pr: b.pr, kind: 'stacked-above-aged' })]));
      expect(aged.refusals.map(r => r.kind)).not.toContain('stacked-above');
      expect(aged.refusals.find(r => r.kind !== 'stacked-above-aged')).toMatchObject({ pr: b.pr });
    } finally { vi.useRealTimers(); }
  });
});

describe('settings and fail-open IO', () => {
  it('cascades defaults, file and env with malformed fallbacks', () => {
    expect(resolvePrStackSettings({}, { read: () => ({}) })).toEqual(settings);
    expect(resolvePrStackSettings({}, { read: () => ({ prStack: { restack: 'off' } }) }).restack).toBe(false);
    expect(resolvePrStackSettings({ WE_PR_STACK_RESTACK: 'yes' }, { read: () => ({ prStack: { restack: 'off' } }) }).restack).toBe(true);
    expect(resolvePrStackSettings({ WE_PR_STACK_RESTACK: 'bad' }, { read: () => ({ prStack: { restack: 'no' } }) }).restack).toBe(false);
    expect(resolvePrStackSettings({ WE_PR_STACK_DETECT: '0' }, { read: () => { throw Error(); } })).toEqual({ detect: false, bottomFirst: false, restack: false, restackMaxRounds: 3, holdMaxAgeMs: PR_STACK_DEFAULTS.holdMaxAgeMs });
  });
  it('combines planned and open heads, remembers pairs and fails open', () => {
    const writeMem = vi.fn(); const readHeads = vi.fn(() => new Map([a, b].map(p => [p.pr, { headRefName: p.headRefName, headRefOid: p.headRefOid, isCrossRepository: false, author: 'app/bot' }])));
    const options = { root: '/repo', repoKey: 'we', planned: [entries[0]], openPrFiles: [{ pr: b.pr }], settings, readRefs: readHeads, isAncestor: ancestor, onMain: () => false, readMem: () => [], writeMem,
      readLanes: () => new Map([[a.headRefName, a.headRefOid], [b.headRefName, b.headRefOid]]), now: () => NOW };
    expect(readStacksForPass(options).pairs[0]).toMatchObject({ top: b.pr, bottom: a.pr });
    expect(readHeads).toHaveBeenCalledWith('/repo', [a.pr, b.pr]);
    expect(writeMem).toHaveBeenCalledWith('/repo', nextRemembered(live()));
    expect(readStacksForPass({ ...options, readMem: () => { throw Error(); } })).toEqual({ pairs: [] });
    expect(readStacksForPass({ ...options, repoKey: 'fui' })).toEqual({ pairs: [] });
    // A deferred / failed open-PR read proves nothing: detect nothing and leave the memory untouched.
    writeMem.mockClear();
    for (const openPrFiles of [undefined, []]) expect(readStacksForPass({ ...options, openPrFiles })).toEqual({ pairs: [] });
    expect(writeMem).not.toHaveBeenCalled();
  });
});


describe('durable idle restacks', () => {
  const moved = () => ({ pairs: [{ ...live().pairs[0], bottomHead: 'idle-bottom-v2', inSync: false }] });
  const opts = { planned: [], reconcileRefusals: [{ kind: 'nothing-owed', prNumber: b.pr }], fixClaims: [], settings, used: new Set() };
  it('plans the idle live shape and landed bottom', () => {
    const stacks = moved();
    expect(planIdleRestacks(stacks, opts)).toEqual([{ top: b.pr, pair: stacks.pairs[0] }]);
    expect(applyStackOrder([entries[1]], stacks, { settings }).planned[0].restack.onto).toBe(a.headRefName);
    stacks.pairs[0].bottomOpen = false;
    expect(planIdleRestacks(stacks, opts)).toHaveLength(1);
    expect(applyStackOrder([entries[1]], stacks, { settings }).planned[0].restack.onto).toBe('main');
  });
  it('holds claimed, planned, in-sync, remembered, capped and disabled tops', () => {
    expect(planIdleRestacks(moved(), { ...opts, fixClaims: [claim(b.pr)] })).toEqual([]);
    expect(planIdleRestacks(moved(), { ...opts, planned: [entries[1]] })).toEqual([]);
    expect(planIdleRestacks(live(), opts)).toEqual([]);
    // A launched restack that did not catch the top up is retried until the round cap, and held after it.
    const retried = moved(); Object.assign(retried.pairs[0], { restackedFor: 'idle-bottom-v2', restackRounds: 2 });
    expect(planIdleRestacks(retried, opts)).toHaveLength(1);
    const capped = moved(); Object.assign(capped.pairs[0], { restackedFor: 'idle-bottom-v2', restackRounds: 3 });
    expect(planIdleRestacks(capped, opts)).toEqual([]);
    for (const key of ['detect', 'restack']) expect(planIdleRestacks(moved(), { ...opts, settings: { ...settings, [key]: false } })).toEqual([]);
  });
  it('keys retries to the bottom head, caps owed tops and holds them as peers', () => {
    const stacks = moved(); const used = new Set();
    const first = applyStackOrder([entries[1]], stacks, { settings }).planned[0];
    expect(restackKey(first)).toBe('restack:4631:idle-bottom-v2:0');
    markRestackUsed(first, used);
    expect(planIdleRestacks(stacks, { ...opts, used })).toEqual([]);
    stacks.pairs[0].bottomHead = 'idle-bottom-v3';
    expect(planIdleRestacks(stacks, { ...opts, used })).toHaveLength(1);
    Object.assign(stacks.pairs[0], { restackedFor: 'idle-bottom-v3', restackRounds: 3 });
    const capped = applyStackOrder([entries[1]], stacks, { settings: { ...settings, bottomFirst: false }, used });
    // Exhausted attempts are reported and the top is released to its ordinary dispatch, never held for good.
    expect(capped.planned).toEqual([entries[1]]);
    expect(capped.refusals[0]).toMatchObject({ kind: 'restack-cap-exhausted', why: expect.stringContaining('3') });
  });
  it('round trips history through disk and fresh detection, resetting for a different bottom', () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-stack-'));
    try {
      const stacks = live(); Object.assign(stacks.pairs[0], { restackedFor: a.headRefOid, restackRounds: 2 });
      writeRemembered(root, nextRemembered(stacks));
      const remembered = readRemembered(root);
      expect(remembered[0]).toMatchObject({ restackedFor: a.headRefOid, restackRounds: 2 });
      expect(detectStacks([a, b], { remembered, isAncestor: ancestor }).pairs[0]).toMatchObject({ restackedFor: a.headRefOid, restackRounds: 2 });
      expect(detectStacks([a, b], { remembered: [{ ...remembered[0], bottom: 9 }], isAncestor: ancestor }).pairs[0]).toMatchObject({ restackedFor: null, restackRounds: 0 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('resolves round caps from defaults, file, env and malformed values', () => {
    const read = () => ({ prStack: { restackMaxRounds: 5 } });
    expect(resolvePrStackSettings({}, { read: () => ({}) }).restackMaxRounds).toBe(3);
    expect(resolvePrStackSettings({}, { read }).restackMaxRounds).toBe(5);
    expect(resolvePrStackSettings({ WE_PR_STACK_RESTACK_MAX_ROUNDS: '7' }, { read }).restackMaxRounds).toBe(7);
    for (const value of ['bad', '0', '-1', 'Infinity', '']) {
      expect(resolvePrStackSettings({ WE_PR_STACK_RESTACK_MAX_ROUNDS: value }, { read }).restackMaxRounds).toBe(3);
      expect(resolvePrStackSettings({}, { read: () => ({ prStack: { restackMaxRounds: value } }) }).restackMaxRounds).toBe(3);
    }
  });
  it('dispatches the idle top while it is owed, holds it while its agent lives, and stops once it caught up', () => {
    const stacks = moved(); stacks.pairs[0].bottomHead = 'dispatch-idle-v2';
    let claims = [];
    const readPrForRestack = vi.fn(() => ({ ...b, prNumber: b.pr, kind: 'fix', labels: ['review:pending'], body: '', isCrossRepository: false }));
    const readLaneTips = () => new Map([[b.headRefName, b.headRefOid]]);
    const dispatch = vi.fn(p => p);
    const args = { root: '/repo', repo: 'we', checkStaleness: () => ({ stale: false }),
      reconcile: () => ({ dispatch: [{ ...a, prNumber: a.pr, kind: 'fix', files: ['scripts/merge-ai-prs.mjs'] }], refusals: opts.reconcileRefusals }),
      prStack: () => stacks, prStackSettings: settings, readPrForRestack, readLaneTips,
      findItemFn: () => null, loadItems: () => [], pickFreeLanes: () => [1, 2], dispatch,
      fetchItemlessDiffPaths: () => ['scripts/merge-ai-prs.mjs'], resolveFallbackScope: () => scope,
      resolveProfile: () => ({ capabilities: { fix: true, ciHeal: true }, canonicalPrefix: 'we' }),
      listBuildClaims: () => [], listFixClaims: () => claims, priorityShadow: null };
    const out = runReconcileFixDispatch(args);
    expect(out.dispatched.map(p => p.pr)).toEqual([a.pr, b.pr]);
    const top = out.dispatched[1];
    expect(top.restack.onto).toBe(a.headRefName);
    expect(withRestackHint('original', top.restack)).toContain('no review findings to address');
    expect(stacks.pairs[0]).toMatchObject({ restackedFor: 'dispatch-idle-v2', restackRounds: 1 });
    // The agent is alive (its claim is held): nothing is dispatched at the top.
    claims = [claim(b.pr)];
    expect(runReconcileFixDispatch(args).dispatched.map(p => p.pr)).toEqual([a.pr]);
    expect(readPrForRestack).toHaveBeenCalledTimes(1);
    // The agent exited WITHOUT pushing (claim gone, top still not caught up): the restack is retried, as a second round.
    claims = [];
    expect(runReconcileFixDispatch(args).dispatched.map(p => p.pr)).toEqual([a.pr, b.pr]);
    expect(stacks.pairs[0]).toMatchObject({ restackedFor: 'dispatch-idle-v2', restackRounds: 2 });
    // The retry pushed: the top now contains the bottom's head, so nothing is owed any more.
    stacks.pairs[0].inSync = true;
    expect(runReconcileFixDispatch(args).dispatched.map(p => p.pr)).toEqual([a.pr]);
    expect(readPrForRestack).toHaveBeenCalledTimes(2);
    // A launch that throws records nothing.
    Object.assign(stacks.pairs[0], { bottomHead: 'dispatch-idle-v3', inSync: false });
    dispatch.mockImplementation(() => { throw Error('launch failed'); });
    runReconcileFixDispatch(args);
    expect(stacks.pairs[0]).toMatchObject({ restackedFor: 'dispatch-idle-v2', restackRounds: 2 });
    readPrForRestack.mockImplementation(() => { throw Error('read failed'); });
    expect(() => runReconcileFixDispatch(args)).not.toThrow();
  });
  it('bounds failed restacks per bottom head through repeated passes, then releases the top (no seeded counters)', () => {
    // Real chain of passes: every pass re-detects from the PERSISTED memory (round-tripped through disk) and the agent never pushes.
    const root = mkdtempSync(join(tmpdir(), 'pr-stack-cap-'));
    const bottom = mk(61, 'b'.repeat(40), 'lane/cap-bottom'); const top = mk(62, 'c'.repeat(40), 'lane/cap-top');
    const dispatched = [];
    const pass = (bottomOid, extraRefusals = []) => {
      const prs = [{ ...bottom, headRefOid: bottomOid }, top];
      const stacks = detectStacks(prs, { remembered: readRemembered(root), isAncestor: (x, y) => x === 'b'.repeat(40) && y === top.headRefOid });
      writeRemembered(root, nextRemembered(stacks));
      const out = runReconcileFixDispatch({ root, repo: 'we', checkStaleness: () => ({ stale: false }),
        reconcile: () => ({ dispatch: [], refusals: [{ kind: 'nothing-owed', prNumber: top.pr }, ...extraRefusals] }),
        prStack: () => stacks, prStackSettings: settings, readLaneTips: () => new Map([[top.headRefName, top.headRefOid]]),
        readPrForRestack: () => ({ ...top, prNumber: top.pr, kind: 'fix', labels: [], body: '', isCrossRepository: false }),
        findItemFn: () => null, loadItems: () => [], pickFreeLanes: () => [1, 2], dispatch: p => { dispatched.push(p); return p; },
        fetchItemlessDiffPaths: () => ['scripts/x.mjs'], resolveFallbackScope: () => scope,
        resolveProfile: () => ({ capabilities: { fix: true, ciHeal: true }, canonicalPrefix: 'we' }),
        listBuildClaims: () => [], listFixClaims: () => [], priorityShadow: null });
      // the dispatcher persists the attempt it just recorded
      writeRemembered(root, nextRemembered(stacks));
      return out;
    };
    try {
      const moved = 'd'.repeat(40);
      // Pass 0: the top contains the bottom's head, so the pair is detected and remembered with nothing owed.
      pass('b'.repeat(40));
      expect(dispatched).toEqual([]);
      expect(readRemembered(root)[0]).toMatchObject({ top: 62, bottom: 61, containedHead: 'b'.repeat(40) });
      // Attempts 1..3 against the moved bottom head all launch a restack; the agent never pushes.
      for (const round of [1, 2, 3]) {
        const before = dispatched.length;
        const out = pass(moved);
        expect(out.dispatched.length, `round ${round}`).toBe(dispatched.length - before);
        expect(dispatched.slice(before).map(p => p.restack?.onto)).toEqual(['lane/cap-bottom']);
        expect(readRemembered(root)[0]).toMatchObject({ restackedFor: moved, restackRounds: round });
      }
      // Attempt 4 is not launched: the cap is reached by those real attempts, and it is reported rather than silent.
      const before = dispatched.length;
      const out = pass(moved);
      expect(dispatched.length).toBe(before);
      expect(out.refusals.map(r => r.kind)).not.toContain('stacked-above');
      // A different bottom head is a fresh count.
      pass('e'.repeat(40));
      expect(dispatched.at(-1).restack).toMatchObject({ onto: 'lane/cap-bottom', bottomHead: 'e'.repeat(40) });
      expect(readRemembered(root)[0]).toMatchObject({ restackedFor: 'e'.repeat(40), restackRounds: 1 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('releases a non-idle top to ordinary dispatch once its restacks are exhausted', () => {
    const stacks = { pairs: [{ ...moved().pairs[0], bottomHead: 'cap-release-v1', restackedFor: 'cap-release-v1', restackRounds: 3 }] };
    const out = applyStackOrder([entries[1]], stacks, { settings });
    expect(out.planned).toEqual([entries[1]]);
    expect(out.refusals).toEqual([expect.objectContaining({ pr: b.pr, kind: 'restack-cap-exhausted' })]);
  });
});

// Review round 1 on PR #4655.
const mk = (pr, oid, ref = `lane/p${pr}`) => ({ pr, headRefOid: oid, headRefName: ref });
const entryOf = p => ({ pr: p.pr, headRefOid: p.headRefOid, laneRef: p.headRefName, scope: ['we:x'] });
const ancestry = table => (x, y) => table[y]?.includes(x) ?? false;

describe('idle restack is an allowlist (nothing-owed only)', () => {
  const owedPair = { top: 7, bottom: 6, bottomRef: 'lane/p6', bottomHead: 'b2', topHead: 't', bottomOpen: true, inSync: false, restackedFor: null, restackRounds: 0 };
  const plan = rows => planIdleRestacks({ pairs: [{ ...owedPair }] }, { reconcileRefusals: rows, settings });
  it('plans only when the reconcile itself says nothing-owed', () => {
    expect(plan([{ prNumber: 7, kind: 'nothing-owed' }])).toHaveLength(1);
  });
  it.each(REFUSAL_KINDS.filter(kind => kind !== 'nothing-owed'))('holds an idle top whose reconcile row is %s', kind => {
    expect(plan([{ prNumber: 7, kind }])).toEqual([]);
  });
  it('holds a top with no reconcile row and a top with a mixed set of rows', () => {
    expect(plan([])).toEqual([]);
    expect(plan([{ prNumber: 99, kind: 'nothing-owed' }])).toEqual([]);
    expect(plan([{ prNumber: 7, kind: 'nothing-owed' }, { prNumber: 7, kind: 'draft' }])).toEqual([]);
  });
});

describe('restack cap is per bottom head, never permanent', () => {
  it('keeps restacking across 5 distinct bottom heads', () => {
    const top = mk(2, 't1');
    let remembered = [{ top: 2, bottom: 1, bottomRef: 'lane/p1', bottomHead: 'h0', restackedFor: 'h0', restackRounds: 3 }];
    for (const head of ['h1', 'h2', 'h3', 'h4', 'h5']) {
      const stacks = detectStacks([mk(1, head), top], { remembered, isAncestor: (x, y) => x === 'h0' && y === 't1' });
      const out = applyStackOrder([entryOf(top)], stacks, { settings });
      expect(out.refusals).toEqual([]);
      expect(out.planned[0].restack).toMatchObject({ onto: 'lane/p1', bottomHead: head });
      const pair = bottomOf(stacks, 2);
      pair.restackedFor = head; pair.restackRounds += 1;
      remembered = nextRemembered(stacks);
    }
  });
  it('restacks onto main after the bottom landed even when the rounds are used up', () => {
    const top = mk(2, 't1');
    const remembered = [{ top: 2, bottom: 1, bottomRef: 'lane/p1', bottomHead: 'h3', restackedFor: 'h3', restackRounds: 3 }];
    const stacks = detectStacks([top], { remembered, isAncestor: () => false, onMain: sha => sha === 'h3' });
    expect(bottomOf(stacks, 2)).toMatchObject({ bottomOpen: false });
    expect(applyStackOrder([entryOf(top)], stacks, { settings }).planned[0].restack.onto).toBe('main');
    expect(planIdleRestacks(stacks, { reconcileRefusals: [{ prNumber: 2, kind: 'nothing-owed' }], settings })).toHaveLength(1);
  });
});

describe('a remembered immediate bottom survives an older ancestor', () => {
  it('keeps C on B when B advances and C still contains A', () => {
    const [pa, pb, pc] = [mk(1, 'a'), mk(2, 'b'), mk(3, 'c')];
    const first = detectStacks([pa, pb, pc], { isAncestor: ancestry({ b: ['a'], c: ['a', 'b'] }) });
    expect(bottomOf(first, 3).bottom).toBe(2);
    const advanced = detectStacks([pa, { ...pb, headRefOid: 'b2' }, pc], { remembered: nextRemembered(first), isAncestor: ancestry({ b2: ['a'], c: ['a', 'b'] }) });
    expect(bottomOf(advanced, 3)).toMatchObject({ bottom: 2, bottomHead: 'b2', inSync: false, bottomOpen: true });
    expect(applyStackOrder([entryOf(pc)], advanced, { settings }).planned[0].restack).toMatchObject({ bottomPr: 2, onto: 'lane/p2' });
  });
  it('lets fresh ancestry win once the top was rebased off the remembered bottom', () => {
    const [pa, pb, pc] = [mk(1, 'a'), mk(2, 'b'), mk(3, 'c')];
    const first = detectStacks([pa, pb, pc], { isAncestor: ancestry({ b: ['a'], c: ['a', 'b'] }) });
    // C was rebased onto A and no longer contains B's last head 'b'; B (now b2) still sits on A.
    const rebased = detectStacks([pa, { ...pb, headRefOid: 'b2' }, { ...pc, headRefOid: 'c2' }],
      { remembered: nextRemembered(first), isAncestor: ancestry({ b2: ['a'], c2: ['a'] }) });
    expect(bottomOf(rebased, 3)).toMatchObject({ bottom: 1, inSync: true });
  });
  it('still lets a genuinely nearer bottom win over the remembered one', () => {
    const [pa, pb, pc] = [mk(1, 'a'), mk(2, 'b'), mk(3, 'c')];
    const remembered = [{ top: 3, bottom: 1, bottomRef: 'lane/p1', bottomHead: 'a', restackedFor: null, restackRounds: 0 }];
    expect(bottomOf(detectStacks([pa, pb, pc], { remembered, isAncestor: ancestry({ b: ['a'], c: ['a', 'b'] }) }), 3).bottom).toBe(2);
  });
});

describe('unknown reads owe nothing, and the memory file is shape-checked', () => {
  it.each([
    ['a bottom head that could not be read', { ...mk(1, null) }, () => true],
    ['an ancestry read that failed', mk(1, 'a'), () => null],
  ])('does not owe a restack for %s', (_name, bottom, isAncestor) => {
    const remembered = [{ top: 2, bottom: 1, bottomRef: 'lane/p1', bottomHead: 'a'.repeat(40), restackedFor: null, restackRounds: 0 }];
    const stacks = detectStacks([bottom, mk(2, 'c')], { remembered, isAncestor });
    expect(bottomOf(stacks, 2)).toMatchObject({ bottomOpen: true, inSync: null });
    expect(planIdleRestacks(stacks, { reconcileRefusals: [{ prNumber: 2, kind: 'nothing-owed' }], settings })).toEqual([]);
    expect(applyStackOrder([entryOf(mk(2, 'c'))], stacks, { settings }).refusals[0].kind).toBe('stacked-above');
  });
  it('rejects remembered entries with option-shaped, malformed or out-of-range fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-stack-mem-'));
    const good = { top: 2, bottom: 1, bottomRef: 'lane/p1', bottomHead: 'a'.repeat(40), restackedFor: 'main', restackRounds: 1 };
    try {
      writeRemembered(root, [good]);
      expect(readRemembered(root)).toEqual([good]);
      for (const bad of [{ bottomHead: '--upload-pack=x' }, { bottomHead: 'abc' }, { bottomRef: '--force' }, { bottomRef: 'lane/../main' },
        { bottomRef: 'refs/heads/other' }, { restackedFor: 'zzz' }, { restackRounds: -1 }, { restackRounds: 1.5 }, { restackRounds: '2' }]) {
        writeRemembered(root, [good, { ...good, ...bad }]);
        expect(readRemembered(root)).toEqual([good]);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('trust boundary and branch names for idle bottoms', () => {
  const lanes = [mk(4624, 'aaa', 'lane/red-main-contain'), mk(4631, 'bbb', 'lane/accept-carry-forward')];
  // What gh reports for both PRs: the same actor by default; `patch` overrides per PR number.
  const refsOf = patch => new Map([[4624, { headRefName: 'lane/red-main-contain', headRefOid: 'aaa', isCrossRepository: false, author: 'app/bot', ...patch[4624] }],
    [4631, { headRefName: 'lane/accept-carry-forward', headRefOid: 'bbb', isCrossRepository: false, author: 'app/bot', ...patch[4631] }]]);
  const base = (over = {}) => ({ root: '/repo', repoKey: 'we', planned: [entryOf(lanes[1])], openPrFiles: [{ pr: 4624 }, { pr: 4631 }], settings,
    readRefs: () => refsOf({}),
    isAncestor: (x, y) => x === 'aaa' && y === 'bbb', onMain: () => false,
    readMem: () => [], writeMem: vi.fn(), readLanes: () => new Map([['lane/red-main-contain', 'aaa'], ['lane/accept-carry-forward', 'bbb']]), ...over });
  it('resolves the branch name of an initially idle (unplanned) bottom from origin', () => {
    const options = base();
    expect(readStacksForPass(options).pairs[0]).toMatchObject({ top: 4631, bottom: 4624, bottomRef: 'lane/red-main-contain' });
    const stored = options.writeMem.mock.calls[0][1];
    const moved = detectStacks([mk(4624, 'aaa2', 'lane/red-main-contain'), lanes[1]], { remembered: stored, isAncestor: (x, y) => x === 'aaa' && y === 'bbb' });
    expect(applyStackOrder([entryOf(lanes[1])], moved, { settings }).planned[0].restack.onto).toBe('lane/red-main-contain');
  });
  it('takes the branch name from GitHub, never from a sha: a twin at the same tip cannot be picked', () => {
    const twinTips = new Map([['lane/red-main-contain', 'aaa'], ['lane/red-main-contain-alt', 'aaa'], ['lane/accept-carry-forward', 'bbb']]);
    expect(readStacksForPass(base({ readLanes: () => twinTips })).pairs[0].bottomRef).toBe('lane/red-main-contain');
    const altRefs = refsOf({ 4624: { headRefName: 'lane/red-main-contain-alt' } });
    expect(readStacksForPass(base({ readLanes: () => twinTips, readRefs: () => altRefs })).pairs[0].bottomRef).toBe('lane/red-main-contain-alt');
  });
  it('ignores a PR whose head is not the tip of its origin lane branch, a fork PR, and an unreadable PR', () => {
    expect(readStacksForPass(base({ readLanes: () => new Map([['lane/accept-carry-forward', 'bbb']]) })).pairs).toEqual([]);
    expect(readStacksForPass(base({ readLanes: () => new Map([['lane/red-main-contain', 'zzz'], ['lane/accept-carry-forward', 'bbb']]),
      planned: [entryOf(lanes[1]), entryOf(lanes[0])] })).pairs).toEqual([]);
    // A fork PR carrying the same sha under the same lane name as a real origin branch.
    expect(readStacksForPass(base({ readRefs: () => refsOf({ 4624: { isCrossRepository: true } }) })).pairs).toEqual([]);
    expect(readStacksForPass(base({ readRefs: () => new Map() })).pairs).toEqual([]);
  });
  it('keeps a remembered pair through a pass where its bottom is transiently untrusted', () => {
    const remembered = [{ top: 4631, bottom: 4624, bottomRef: 'lane/red-main-contain', bottomHead: 'a'.repeat(40), restackedFor: null, restackRounds: 0 }];
    const out = readStacksForPass(base({ readMem: () => remembered, readRefs: () => new Map(), isAncestor: (x, y) => x === 'a'.repeat(40) && y === 'bbb' }));
    expect(bottomOf(out, 4631)).toMatchObject({ bottom: 4624, bottomRef: 'lane/red-main-contain', bottomOpen: true });
  });
  it('reads open PR refs from gh and treats anything unreadable as unverified', () => {
    const run = vi.fn(() => JSON.stringify([{ number: 1, headRefName: 'lane/a', headRefOid: 'x', isCrossRepository: false }, { number: 2, headRefName: 'lane/b', headRefOid: 'y', author: { login: 'App/Bot' } }, { nope: 1 }]));
    const refs = readOpenPrRefs('/repo', { run, repo: 'o/r' });
    expect(run.mock.calls[0][0].slice(0, 4)).toEqual(['pr', 'list', '--repo', 'o/r']);
    expect(run.mock.calls[0][0].join(' ')).toContain('author');
    expect(refs.get(1)).toEqual({ headRefName: 'lane/a', headRefOid: 'x', isCrossRepository: false, author: null });
    expect(refs.get(2)).toMatchObject({ isCrossRepository: true, author: 'app/bot' });
    expect(readOpenPrRefs('/repo', { run: () => { throw Error('gh down'); } }).size).toBe(0);
    expect(readOpenPrRefs('/repo', { run: () => 'not json' }).size).toBe(0);
  });
  it('detects nothing and leaves the memory untouched when origin cannot be listed', () => {
    const options = base({ readLanes: () => null });
    expect(readStacksForPass(options)).toEqual({ pairs: [] });
    expect(options.writeMem).not.toHaveBeenCalled();
  });
  it('refuses to dispatch an idle restack at a fork, non-lane or tip-mismatched PR', () => {
    const stacks = { pairs: [{ ...live().pairs[0], bottomHead: 'trust-v2', inSync: false }] };
    const run = (over, tips = new Map([[b.headRefName, b.headRefOid]])) => {
      const dispatch = vi.fn(p => p);
      const out = runReconcileFixDispatch({ root: '/repo', repo: 'we', checkStaleness: () => ({ stale: false }),
        reconcile: () => ({ dispatch: [], refusals: [{ kind: 'nothing-owed', prNumber: b.pr }] }),
        prStack: () => stacks, prStackSettings: settings, readLaneTips: () => tips,
        readPrForRestack: () => ({ ...b, prNumber: b.pr, kind: 'fix', labels: [], body: '', isCrossRepository: false, ...over }),
        findItemFn: () => null, loadItems: () => [], pickFreeLanes: () => [1], dispatch, fetchItemlessDiffPaths: () => ['scripts/x.mjs'],
        resolveFallbackScope: () => scope, resolveProfile: () => ({ capabilities: { fix: true, ciHeal: true }, canonicalPrefix: 'we' }),
        listBuildClaims: () => [], listFixClaims: () => [], priorityShadow: null });
      return out.dispatched.length;
    };
    expect(run({})).toBe(1);
    expect(run({ isCrossRepository: true })).toBe(0);
    expect(run({ isCrossRepository: undefined })).toBe(0);
    expect(run({ headRefName: 'main' }, new Map([['main', b.headRefOid]]))).toBe(0);
    expect(run({}, new Map([[b.headRefName, 'moved']]))).toBe(0);
    expect(run({}, null)).toBe(0);
  });
  it('lists lane tips through a bounded ls-remote and fails to null', () => {
    const run = vi.fn(() => `${'a'.repeat(40)}\trefs/heads/lane/one\nnoise\n${'b'.repeat(40)}\trefs/heads/lane/two\n`);
    expect(readOriginLaneTips('/repo', { run })).toEqual(new Map([['lane/one', 'a'.repeat(40)], ['lane/two', 'b'.repeat(40)]]));
    expect(run.mock.calls[0][0]).toEqual(['ls-remote', '--end-of-options', 'origin', 'refs/heads/lane/*']);
    expect(readOriginLaneTips('/repo', { run: () => { throw Error('offline'); } })).toBeNull();
  });
});

// Review round 2 on PR #4655.
const sha = ch => ch.repeat(40);
describe('the immediate bottom survives repeated passes before the restack (persisted memory)', () => {
  const [A, B, C] = [sha('a'), sha('b'), sha('c')];
  const B2 = sha('d');
  const prs = bHead => [mk(1, A), mk(2, bHead), mk(3, C)];
  // C was built on B (and so on A); B then advanced to B2, which C does not contain.
  const contains = bHead => ancestry({ [B]: [A], [B2]: [A], [C]: [A, B], [bHead]: [A] });
  it('keeps C on B for every pass until C contains B2, then follows B2', () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-stack-chain-'));
    try {
      const first = detectStacks(prs(B), { isAncestor: contains(B) });
      expect(bottomOf(first, 3)).toMatchObject({ bottom: 2, inSync: true, containedHead: B });
      writeRemembered(root, nextRemembered(first));
      for (const pass of [1, 2, 3]) {
        const stacks = detectStacks(prs(B2), { remembered: readRemembered(root), isAncestor: contains(B2) });
        expect(bottomOf(stacks, 3), `pass ${pass}`).toMatchObject({ bottom: 2, bottomHead: B2, containedHead: B, inSync: false });
        expect(applyStackOrder([entryOf(mk(3, C))], stacks, { settings }).planned[0].restack).toMatchObject({ bottomPr: 2, onto: 'lane/p2' });
        writeRemembered(root, nextRemembered(stacks));
      }
      // The restack lands: C now contains B2.
      const caughtUp = detectStacks([mk(1, A), mk(2, B2), mk(3, sha('e'))], { remembered: readRemembered(root),
        isAncestor: ancestry({ [B2]: [A], [sha('e')]: [A, B, B2] }) });
      expect(bottomOf(caughtUp, 3)).toMatchObject({ bottom: 2, inSync: true, containedHead: B2 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('accepts a memory file with or without containedHead, and rejects a malformed one', () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-stack-mem2-'));
    const old = { top: 3, bottom: 2, bottomRef: 'lane/p2', bottomHead: B, restackedFor: null, restackRounds: 0 };
    try {
      writeRemembered(root, [old, { ...old, top: 4, containedHead: A }]);
      expect(readRemembered(root)).toHaveLength(2);
      writeRemembered(root, [{ ...old, containedHead: '--upload-pack=x' }]);
      expect(readRemembered(root)).toEqual([]);
      // an old file (no containedHead) falls back to its bottomHead
      const stacks = detectStacks(prs(B), { remembered: [old], isAncestor: contains(B) });
      expect(bottomOf(stacks, 3)).toMatchObject({ bottom: 2, containedHead: B });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('a landed bottom: the restack onto main is done when the top head moved after the launch', () => {
  const bottomHead = sha('a');
  const base = { top: 2, bottom: 1, bottomRef: 'lane/p1', bottomHead, containedHead: bottomHead, restackedFor: null, restackRounds: 0 };
  const onMain = s => s === bottomHead;
  it('stays owed even if the top contains the bottom\'s last SEEN head (the bottom may have advanced and merged unseen)', () => {
    // top contains b1, but main holds b2 that this daemon never saw: containing the old head proves nothing.
    const stacks = detectStacks([mk(2, sha('c'))], { remembered: [base], isAncestor: (x, y) => x === bottomHead && y === sha('c'), onMain });
    expect(bottomOf(stacks, 2)).toMatchObject({ bottomOpen: false, inSync: false });
    expect(applyStackOrder([entryOf(mk(2, sha('c')))], stacks, { settings }).planned[0].restack.onto).toBe('main');
  });
  it('retries a launched restack whose top did not move, and forgets the pair once the top moved', () => {
    const launched = { ...base, restackedFor: 'main', restackRounds: 1, restackTopHead: sha('c') };
    const same = detectStacks([mk(2, sha('c'))], { remembered: [launched], isAncestor: () => false, onMain });
    expect(bottomOf(same, 2)).toMatchObject({ inSync: false });
    expect(nextRemembered(same)).toHaveLength(1);
    const moved = detectStacks([mk(2, sha('d'))], { remembered: [launched], isAncestor: () => false, onMain });
    expect(bottomOf(moved, 2)).toMatchObject({ inSync: true });
    expect(applyStackOrder([entryOf(mk(2, sha('d')))], moved, { settings }).planned[0].restack).toBeUndefined();
    expect(nextRemembered(moved)).toEqual([]);
  });
  it('records the top head at launch and keeps it through the memory file', () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-stack-landed-'));
    try {
      const stacks = detectStacks([mk(2, sha('c'))], { remembered: [base], isAncestor: () => false, onMain });
      const entry = applyStackOrder([entryOf(mk(2, sha('c')))], stacks, { settings }).planned[0];
      recordRestackAttempt(stacks.pairs[0], entry.restack);
      writeRemembered(root, nextRemembered(stacks));
      expect(readRemembered(root)[0]).toMatchObject({ restackedFor: 'main', restackRounds: 1, restackTopHead: sha('c') });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('ownership and bounded git work', () => {
  const lanePr = (n, oid, author = 'app/bot') => ({ ...mk(n, oid, `lane/own-${n}`), author });
  const sameActor = (top, bottom) => Boolean(top.author) && top.author === bottom.author;
  it('forms no new stack across actors or with an unreadable author, but keeps a remembered pair', () => {
    const prs = (topAuthor, bottomAuthor) => [lanePr(1, sha('a'), bottomAuthor), lanePr(2, sha('b'), topAuthor)];
    const isAncestor = ancestry({ [sha('b')]: [sha('a')] });
    expect(detectStacks(prs('app/bot', 'app/bot'), { isAncestor, allowPair: sameActor }).pairs).toHaveLength(1);
    expect(detectStacks(prs('mallory', 'app/bot'), { isAncestor, allowPair: sameActor }).pairs).toEqual([]);
    expect(detectStacks(prs(null, null), { isAncestor, allowPair: sameActor }).pairs).toEqual([]);
    const remembered = nextRemembered(detectStacks(prs('app/bot', 'app/bot'), { isAncestor }));
    expect(detectStacks(prs('mallory', 'app/bot'), { remembered, isAncestor, allowPair: sameActor }).pairs).toHaveLength(1);
  });
  it('readStacksForPass applies the same-actor rule from what gh reports', () => {
    const lanes = [mk(4624, 'aaa', 'lane/red-main-contain'), mk(4631, 'bbb', 'lane/accept-carry-forward')];
    const refs = author => new Map([[4624, { headRefName: lanes[0].headRefName, headRefOid: 'aaa', isCrossRepository: false, author: 'app/bot' }],
      [4631, { headRefName: lanes[1].headRefName, headRefOid: 'bbb', isCrossRepository: false, author }]]);
    const opts = readRefs => ({ root: '/repo', repoKey: 'we', planned: lanes.map(entryOf), openPrFiles: [{ pr: 4624 }, { pr: 4631 }], settings, readRefs,
      isAncestor: (x, y) => x === 'aaa' && y === 'bbb', onMain: () => false, readMem: () => [], writeMem: vi.fn(),
      readLanes: () => new Map(lanes.map(p => [p.headRefName, p.headRefOid])) });
    expect(readStacksForPass(opts(() => refs('app/bot'))).pairs).toHaveLength(1);
    expect(readStacksForPass(opts(() => refs('someone-else'))).pairs).toEqual([]);
    expect(readStacksForPass(opts(() => refs(null))).pairs).toEqual([]);
    expect(readStacksForPass(opts(() => new Map())).pairs).toEqual([]);
  });
  it('asks git at most once per question and never more than the budget, however many PRs are open', () => {
    const n = 50;
    const many = Array.from({ length: n }, (_, i) => lanePr(i + 1, String(i + 1).padStart(40, '0')));
    const isAncestor = vi.fn((x, y) => Number(x) < Number(y));
    const onMain = vi.fn(() => false);
    const stacks = detectStacks(many, { isAncestor, onMain, allowPair: sameActor });
    expect(stacks.pairs.length).toBeGreaterThan(0);
    expect(onMain.mock.calls.length).toBeLessThanOrEqual(n);
    expect(new Set(isAncestor.mock.calls.map(c => c.join())).size).toBe(isAncestor.mock.calls.length);
    expect(isAncestor.mock.calls.length + onMain.mock.calls.length).toBeLessThanOrEqual(ANCESTRY_BUDGET);
    // A smaller budget stops the questions early: what is not asked reads as unknown, so fewer stacks, never wrong ones.
    const tight = vi.fn(isAncestor);
    detectStacks(many, { isAncestor: tight, onMain, allowPair: sameActor, bounds: { budget: 40 } });
    expect(tight.mock.calls.length).toBeLessThanOrEqual(40);
    let t = 0;
    const slow = vi.fn(isAncestor);
    detectStacks(many, { isAncestor: slow, onMain, allowPair: sameActor, bounds: { deadlineMs: 10, now: () => (t += 4) } });
    expect(slow.mock.calls.length).toBeLessThan(10);
  });
  it('forms no new stack above the comparison cap but keeps remembered pairs', () => {
    const many = Array.from({ length: MAX_COMPARED_PRS + 1 }, (_, i) => lanePr(i + 1, String(i + 1).padStart(40, '0')));
    const isAncestor = (x, y) => Number(x) < Number(y);
    expect(detectStacks(many, { isAncestor, allowPair: sameActor }).pairs).toEqual([]);
    const remembered = [{ top: 2, bottom: 1, bottomRef: 'lane/own-1', bottomHead: many[0].headRefOid, containedHead: many[0].headRefOid, restackedFor: null, restackRounds: 0 }];
    expect(detectStacks(many, { remembered, isAncestor, allowPair: sameActor }).pairs.map(p => p.top)).toEqual([2]);
  });
  it('keeps a remembered pair, owing nothing, when onMain cannot be answered; forgets it when the head is known NOT to be on main', () => {
    const remembered = [{ top: 2, bottom: 1, bottomRef: 'lane/own-1', bottomHead: sha('a'), containedHead: sha('a'), restackedFor: null, restackRounds: 0 }];
    for (const onMain of [() => null, () => { throw Error('git down'); }]) {
      const kept = detectStacks([lanePr(2, sha('b'))], { remembered, isAncestor: () => false, onMain });
      expect(kept.pairs).toHaveLength(1);
      expect(kept.pairs[0]).toMatchObject({ bottomOpen: false, inSync: null });
      expect(planIdleRestacks(kept, { reconcileRefusals: [{ prNumber: 2, kind: 'nothing-owed' }], settings })).toEqual([]);
    }
    expect(detectStacks([lanePr(2, sha('b'))], { remembered, isAncestor: () => false, onMain: () => false }).pairs).toEqual([]);
    expect(detectStacks([lanePr(2, sha('b'))], { remembered, isAncestor: () => false, onMain: () => true, bounds: { budget: 0 } }).pairs[0].inSync).toBeNull();
  });
  it('gitOnMain keeps an unanswered git read unknown instead of "not on main"', () => {
    expect(gitOnMain('/nonexistent-dir-for-pr-stack')(sha('a'))).toBeNull();
  });
});

describe('an exhausted git budget never produces a wrong or lost stack', () => {
  const chain = n => Array.from({ length: n }, (_, i) => ({ ...mk(i + 1, String(i + 1).padStart(40, '0'), `lane/ch-${i + 1}`) }));
  const lt = (x, y) => Number(x) < Number(y);
  const budgets = Array.from({ length: 40 }, (_, i) => i);
  it('every budget gives either the full answer or fewer pairs, never a skipped-over bottom', () => {
    const prs = chain(4).reverse(); // top-first order, the worst case for a partial scan
    const full = detectStacks(prs, { isAncestor: lt, onMain: () => false });
    expect(full.pairs.map(p => [p.top, p.bottom]).sort()).toEqual([[2, 1], [3, 2], [4, 3]]);
    for (const budget of budgets) {
      const out = detectStacks(prs, { isAncestor: lt, onMain: () => false, bounds: { budget } });
      for (const p of out.pairs) expect(p.bottom, `budget ${budget}`).toBe(p.top - 1);
    }
  });
  it('keeps the remembered immediate bottom whatever the budget, across persisted passes', () => {
    const [A, B, C, B2] = [sha('a'), sha('b'), sha('c'), sha('d')];
    const prs = [mk(1, A), mk(2, B2), mk(3, C)];
    const remembered = [{ top: 3, bottom: 2, bottomRef: 'lane/p2', bottomHead: B2, containedHead: B, restackedFor: null, restackRounds: 0 },
      { top: 2, bottom: 1, bottomRef: 'lane/p1', bottomHead: A, containedHead: A, restackedFor: null, restackRounds: 0 }];
    for (const budget of budgets) {
      const out = detectStacks(prs, { remembered, isAncestor: ancestry({ [B2]: [A], [C]: [A, B] }), bounds: { budget } });
      expect(bottomOf(out, 3)?.bottom, `budget ${budget}`).toBe(2);
    }
  });
  it('says so when it was cut short, and forms no stack above the comparison cap', () => {
    const many = chain(MAX_COMPARED_PRS + 1);
    expect(detectStacks(many, { isAncestor: lt, onMain: () => false })).toMatchObject({ pairs: [], truncated: true });
    expect(detectStacks(chain(4), { isAncestor: lt, onMain: () => false, bounds: { budget: 3 } }).truncated).toBe(true);
    expect(detectStacks(chain(4), { isAncestor: lt, onMain: () => false }).truncated).toBeUndefined();
  });
  it('a full scan of the maximum number of PRs fits inside the budget', () => {
    const many = chain(MAX_COMPARED_PRS);
    const isAncestor = vi.fn(lt); const onMain = vi.fn(() => false);
    const out = detectStacks(many, { isAncestor, onMain });
    expect(out.truncated).toBeUndefined();
    expect(isAncestor.mock.calls.length + onMain.mock.calls.length).toBeLessThanOrEqual(ANCESTRY_BUDGET);
    expect(out.pairs).toHaveLength(MAX_COMPARED_PRS - 1);
  });
  it('writes the memory through a temp file and rename', () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-stack-atomic-'));
    try {
      writeRemembered(root, [{ top: 2, bottom: 1, bottomRef: 'lane/p1', bottomHead: sha('a'), containedHead: sha('a'), restackedFor: null, restackRounds: 0, restackTopHead: null }]);
      expect(existsSync(join(root, '.conveyor', `pr-stacks.json.${process.pid}.tmp`))).toBe(false);
      expect(readRemembered(root)).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// Review round 3 on PR #4655 (reproduced red before the fix).
describe('a top rebased completely off its remembered bottom', () => {
  const [A, B, C] = [sha('a'), sha('b'), sha('c')];
  const first = () => detectStacks([mk(1, A), mk(2, B), mk(3, C)], { isAncestor: ancestry({ [B]: [A], [C]: [A, B] }) });
  it('forgets the remembered bottom when the top rebases onto main, and owes no restack', () => {
    const C2 = sha('e');
    // C was rebased onto main: it contains no open PR head. B advanced meanwhile.
    for (const bHead of [B, sha('d')]) {
      const rebased = detectStacks([mk(1, A), mk(2, bHead), mk(3, C2)], { remembered: nextRemembered(first()), isAncestor: ancestry({ [bHead]: [A] }) });
      expect(bottomOf(rebased, 3), `bottom head ${bHead}`).toBeUndefined();
      expect(bottomOf(rebased, 2)).toMatchObject({ bottom: 1 });
      expect(applyStackOrder([entryOf(mk(3, C2))], rebased, { settings }).planned.map(p => p.restack)).toEqual([undefined]);
    }
  });
  it('keeps the remembered bottom while the top still contains it, and when the read cannot answer', () => {
    const still = detectStacks([mk(1, A), mk(2, sha('d')), mk(3, C)], { remembered: nextRemembered(first()), isAncestor: ancestry({ [sha('d')]: [A], [C]: [A, B] }) });
    expect(bottomOf(still, 3)).toMatchObject({ bottom: 2, inSync: false });
    const unknown = detectStacks([mk(1, A), mk(2, B), mk(3, sha('e'))], { remembered: nextRemembered(first()),
      isAncestor: (x, y) => (y === sha('e') ? null : ancestry({ [B]: [A] })(x, y)) });
    expect(bottomOf(unknown, 3)).toMatchObject({ bottom: 2 });
  });
  it('keeps the pair when the top was rebased ONTO the bottom\'s moved head, even on paths that never re-scan', () => {
    const [D, E] = [sha('d'), sha('e')];
    // B moved to D; C was rebased onto D (E contains D but no longer B, the head it was last proven to contain).
    const contains = ancestry({ [D]: [A], [E]: [A, D] });
    const untrustedTop = { ...mk(3, E), untrusted: true };
    const filler = Array.from({ length: MAX_COMPARED_PRS + 1 }, (_, i) => mk(100 + i, String(i + 1).padStart(40, '0')));
    for (const prs of [[mk(1, A), mk(2, D), untrustedTop], [mk(1, A), mk(2, D), mk(3, E), ...filler]]) {
      const out = detectStacks(prs, { remembered: nextRemembered(first()), isAncestor: contains });
      expect(bottomOf(out, 3), `${prs.length} PRs`).toMatchObject({ bottom: 2 });
    }
    // Contained NEITHER head: rebased off, forgotten on the same paths.
    const off = detectStacks([mk(1, A), mk(2, D), untrustedTop], { remembered: nextRemembered(first()), isAncestor: ancestry({ [D]: [A] }) });
    expect(bottomOf(off, 3)).toBeUndefined();
  });
});

describe('an unknown on-main answer never produces a stack past the immediate bottom', () => {
  const chain = [1, 2, 3].map(n => mk(n, String(n).padStart(40, '0')));
  const lt = (x, y) => Number(x) < Number(y);
  it.each([[1, 'null'], [2, 'null'], [3, 'null'], [2, 'throw']])('PR %s answering %s keeps every emitted pair on its immediate bottom', (unknownPr, mode) => {
    const unknownSha = chain[unknownPr - 1].headRefOid;
    const onMain = sha => sha === unknownSha ? (mode === 'null' ? null : (() => { throw Error('git down'); })()) : false;
    const out = detectStacks(chain, { isAncestor: lt, onMain });
    for (const p of out.pairs) expect(p.bottom, `unknown ${unknownPr}`).toBe(p.top - 1);
    if (unknownPr === 2) expect(bottomOf(out, 3)).toBeUndefined();
  });
  it('still pairs everything when every answer is known', () => {
    expect(detectStacks(chain, { isAncestor: lt, onMain: () => false }).pairs.map(p => [p.top, p.bottom]).sort()).toEqual([[2, 1], [3, 2]]);
  });
});

describe('one lane-ref shape for trust and for memory', () => {
  const tipsOf = names => names.map(n => `${sha('a')}\trefs/heads/${n}`).join('\n');
  const names = ['lane/plain', 'lane/with.dot', 'lane/a_b-c/d', 'lane/fix-#12', 'lane/a+b', 'lane/a@b', 'lane/a=b', 'lane/a,b', 'lane/sp ace', 'lane/a..b', 'lane/-x'];
  it('trusts only the names the memory file can hold, so a trusted branch never poisons the file', () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-stack-ref-'));
    try {
      const tips = readOriginLaneTips('/repo', { run: () => tipsOf(names) });
      for (const name of tips.keys()) {
        writeRemembered(root, [{ top: 2, bottom: 1, bottomRef: name, bottomHead: sha('a'), containedHead: sha('a'), restackedFor: null, restackRounds: 0 }]);
        expect(readRemembered(root), name).toHaveLength(1);
      }
      expect([...tips.keys()]).toEqual(expect.arrayContaining(['lane/plain', 'lane/with.dot', 'lane/a_b-c/d']));
      expect(tips.has('lane/a..b')).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('drops only the malformed entry, never the whole memory file', () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-stack-each-'));
    const good = { top: 2, bottom: 1, bottomRef: 'lane/p1', bottomHead: sha('a'), restackedFor: null, restackRounds: 0 };
    try {
      writeRemembered(root, [good, { ...good, top: 5, bottomRef: 'lane/fix-#12;rm' }, { ...good, top: 6, bottomHead: '--upload-pack=x' }, { ...good, top: 7 }]);
      expect(readRemembered(root).map(p => p.top)).toEqual([2, 7]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('a stacked-above hold ages out (card xbphfuf)', () => {
  const [A, B] = [sha('a'), sha('b')];
  const T0 = 1_800_000_000_000;
  const HOUR = 3600e3;
  const prs = [mk(1, A), mk(2, B)];
  const onion = ancestry({ [B]: [A] });
  const pass = (remembered, now, bHead = A) => detectStacks([mk(1, bHead), mk(2, B)], { remembered, isAncestor: ancestry({ [B]: [A], [bHead]: [] }), now: () => now });
  beforeEach(() => resetHoldMemo());
  // One reconcile pass: detect against the persisted memory, apply the order, then clear unheld clocks and save (as the daemon does).
  const daemonPass = (root, owed, now) => {
    const stacks = pass(readRemembered(root), now);
    const out = applyStackOrder(owed.map(entryOf), stacks, { settings, now: () => now });
    clearUnheldHolds(stacks, out.heldTops);
    writeRemembered(root, nextRemembered(stacks));
    return out;
  };
  it('starts the clock the first pass the top is WITHHELD, keeps it across persisted passes, and releases the top once the age is reached', () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-stack-age-'));
    const maxAge = settings.holdMaxAgeMs;
    expect(maxAge).toBeGreaterThan(0);
    try {
      for (const [offset, expected] of [[0, 'stacked-above'], [1, 'stacked-above'], [maxAge - 1, 'stacked-above'], [maxAge, 'stacked-above-aged'], [maxAge * 3, 'stacked-above-aged']]) {
        const out = daemonPass(root, [prs[1]], T0 + offset);
        expect(out.refusals.map(r => r.kind), `+${offset}`).toEqual([expected]);
        expect(out.planned.map(p => p.pr), `+${offset}`).toEqual(expected === 'stacked-above' ? [] : [2]);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('a pair that sat in sync for longer than the age with nothing owed is still withheld the first time its top is owed', () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-stack-quiet-'));
    try {
      for (let day = 0; day < 10; day++) expect(daemonPass(root, [], T0 + day * 24 * HOUR).refusals).toEqual([]);
      const first = daemonPass(root, [prs[1]], T0 + 10 * 24 * HOUR);
      expect(first.refusals.map(r => r.kind)).toEqual(['stacked-above']);
      expect(first.planned).toEqual([]);
      expect(readRemembered(root)[0]).toMatchObject({ heldSince: T0 + 10 * 24 * HOUR });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('the clock restarts after a pass that withheld nothing, and does not run while bottomFirst or detect is off', () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-stack-gap-'));
    const maxAge = settings.holdMaxAgeMs;
    try {
      daemonPass(root, [prs[1]], T0);
      daemonPass(root, [], T0 + maxAge / 2); // top not owed anything: the continuous hold ended
      expect(daemonPass(root, [prs[1]], T0 + maxAge).refusals.map(r => r.kind)).toEqual(['stacked-above']);
      for (const off of [{ bottomFirst: false }, { detect: false }]) {
        const stacks = pass(readRemembered(root), T0 + maxAge);
        const out = applyStackOrder([entryOf(prs[1])], stacks, { settings: { ...settings, ...off }, now: () => T0 + maxAge });
        clearUnheldHolds(stacks, out.heldTops);
        writeRemembered(root, nextRemembered(stacks));
        expect(readRemembered(root)[0].heldSince, JSON.stringify(off)).toBeNull();
      }
      expect(daemonPass(root, [prs[1]], T0 + 5 * maxAge).refusals.map(r => r.kind)).toEqual(['stacked-above']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('a memory file that cannot be read or written does not make the hold unbounded (per-process mirror)', () => {
    const maxAge = settings.holdMaxAgeMs;
    const run = now => {
      const stacks = pass([], now); // the memory read returned nothing, and nothing is saved
      return applyStackOrder([entryOf(prs[1])], stacks, { settings, now: () => now }).refusals.map(r => r.kind);
    };
    expect(run(T0)).toEqual(['stacked-above']);
    expect(run(T0 + maxAge - 1)).toEqual(['stacked-above']);
    expect(run(T0 + maxAge)).toEqual(['stacked-above-aged']);
  });
  it('restarts the clock when the bottom moves and the top catches up', () => {
    const stacks = detectStacks(prs, { isAncestor: onion, now: () => T0 });
    applyStackOrder([entryOf(prs[1])], stacks, { settings, now: () => T0 }); // withheld: the clock starts
    expect(bottomOf(stacks, 2)).toMatchObject({ heldSince: T0, heldFor: A });
    const A2 = sha('c');
    const moved = detectStacks([mk(1, A2), mk(2, B)], { remembered: nextRemembered(stacks), isAncestor: ancestry({ [B]: [A] }), now: () => T0 + 5 * HOUR });
    expect(bottomOf(moved, 2)).toMatchObject({ inSync: false, heldSince: T0 });
    const caught = detectStacks([mk(1, A2), mk(2, sha('d'))], { remembered: nextRemembered(moved), isAncestor: ancestry({ [sha('d')]: [A, A2] }), now: () => T0 + 6 * HOUR });
    expect(bottomOf(caught, 2)).toMatchObject({ inSync: true, heldSince: null, heldFor: A2 });
    expect(applyStackOrder([entryOf(mk(2, sha('d')))], caught, { settings, now: () => T0 + 7 * HOUR }).refusals.map(r => r.kind)).toEqual(['stacked-above']);
    expect(bottomOf(caught, 2).heldSince).toBe(T0 + 7 * HOUR);
  });
  it('starts the clock for an old memory file that has none, and rejects a malformed clock', () => {
    const old = { top: 2, bottom: 1, bottomRef: 'lane/p1', bottomHead: A, containedHead: A, restackedFor: null, restackRounds: 0 };
    const fresh = detectStacks(prs, { remembered: [old], isAncestor: onion, now: () => T0 });
    expect(bottomOf(fresh, 2)).toMatchObject({ heldSince: null, heldFor: A });
    applyStackOrder([entryOf(prs[1])], fresh, { settings, now: () => T0 });
    expect(bottomOf(fresh, 2)).toMatchObject({ heldSince: T0, heldFor: A });
    const root = mkdtempSync(join(tmpdir(), 'pr-stack-clock-'));
    try {
      writeRemembered(root, [{ ...old, heldSince: T0, heldFor: A }]);
      expect(readRemembered(root)).toHaveLength(1);
      for (const bad of [{ heldSince: -1 }, { heldSince: 1.5 }, { heldSince: '5' }, { heldFor: 'zzz' }]) {
        writeRemembered(root, [{ ...old, heldSince: T0, heldFor: A, ...bad }]);
        expect(readRemembered(root)).toEqual([]);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('resolves the age from defaults, file, env and malformed values; an unreadable clock never releases', () => {
    expect(resolvePrStackSettings({}, { read: () => ({ prStack: { holdMaxAgeMs: 5000 } }) }).holdMaxAgeMs).toBe(5000);
    expect(resolvePrStackSettings({ WE_PR_STACK_HOLD_MAX_AGE_MS: '7000' }, { read: () => ({ prStack: { holdMaxAgeMs: 5000 } }) }).holdMaxAgeMs).toBe(7000);
    for (const bad of ['x', '-1', '0', null]) expect(resolvePrStackSettings({ WE_PR_STACK_HOLD_MAX_AGE_MS: bad }, { read: () => ({}) }).holdMaxAgeMs).toBe(PR_STACK_DEFAULTS.holdMaxAgeMs);
    const noClock = { pairs: [{ ...detectStacks(prs, { isAncestor: onion, now: () => T0 }).pairs[0], heldSince: null }] };
    expect(applyStackOrder([entryOf(prs[1])], noClock, { settings, now: () => T0 + 1e12 }).refusals.map(r => r.kind)).toEqual(['stacked-above']);
  });
});

// Self-review of round 3 (adversarial pass on the repair).
describe('round-3 repair hardening', () => {
  const [A, B, C] = [sha('a'), sha('b'), sha('c')];
  const remembered = [{ top: 3, bottom: 2, bottomRef: 'lane/p2', bottomHead: B, containedHead: B, restackedFor: null, restackRounds: 0 }];
  it('forgets a rebased-off top on every path: over the comparison cap, untrusted, and budget-cut', () => {
    const rebasedTop = { ...mk(3, sha('e')), untrusted: true };
    const filler = Array.from({ length: MAX_COMPARED_PRS + 1 }, (_, i) => mk(100 + i, String(i + 1).padStart(40, '0')));
    const isAncestor = () => false; // the rebased top contains nothing
    for (const prs of [[mk(2, B), mk(3, sha('e')), ...filler], [mk(2, B), rebasedTop]]) {
      const out = detectStacks(prs, { remembered, isAncestor });
      expect(bottomOf(out, 3), `${prs.length} PRs`).toBeUndefined();
    }
    // An unanswered read keeps it, whatever the budget.
    expect(bottomOf(detectStacks([mk(2, B), rebasedTop], { remembered, isAncestor: () => null }), 3)).toMatchObject({ bottom: 2 });
    expect(bottomOf(detectStacks([mk(2, B), mk(3, C)], { remembered, isAncestor, bounds: { budget: 0 } }), 3)).toMatchObject({ bottom: 2 });
  });
  it('a released top is a peer again: the bottom no longer ignores its claims', () => {
    const T0 = 1_800_000_000_000;
    const stacks = detectStacks([mk(2, B), mk(3, C)], { remembered, isAncestor: ancestry({ [C]: [B] }), now: () => T0 });
    const held = applyStackOrder([entryOf(mk(3, C))], stacks, { settings, now: () => T0 + 1 });
    expect(held.stackAbove.get(2)).toEqual(new Set([3]));
    const released = applyStackOrder([entryOf(mk(3, C))], stacks, { settings, now: () => T0 + 1 + settings.holdMaxAgeMs });
    expect(released.planned.map(p => p.pr)).toEqual([3]);
    expect(released.stackAbove.get(2)).toEqual(new Set());
  });
  it('clamps a clock from the future so the hold still ages out', () => {
    const stacks = detectStacks([mk(2, B), mk(3, C)], { remembered: [{ ...remembered[0], heldSince: 9e15, heldFor: B }], isAncestor: ancestry({ [C]: [B] }), now: () => 1000 });
    expect(bottomOf(stacks, 3).heldSince).toBe(1000);
  });
  it('a malformed env value falls through to the file value instead of shadowing it', () => {
    const read = () => ({ prStack: { holdMaxAgeMs: 5000, restackMaxRounds: 7 } });
    for (const bad of ['6h', '', '0', '-3']) {
      const resolved = resolvePrStackSettings({ WE_PR_STACK_HOLD_MAX_AGE_MS: bad }, { read });
      expect(resolved, bad).toMatchObject({ holdMaxAgeMs: 5000 });
    }
  });
  it('never writes a bottom name that would not read back, never restacks onto one, and keeps one entry per top', () => {
    const pair = { top: 3, bottom: 2, bottomRef: 'lane/ok', bottomHead: B, containedHead: B, topHead: C, bottomOpen: true, inSync: false, restackedFor: null, restackRounds: 0, restackTopHead: null };
    expect(nextRemembered({ pairs: [pair, { ...pair, top: 4, bottomRef: 'feature/not-a-lane' }, { ...pair, top: 5, bottomRef: '--force' }] }).map(p => p.top)).toEqual([3]);
    const bad = { pairs: [{ ...pair, bottomRef: 'refs/heads/other' }] };
    expect(applyStackOrder([entryOf(mk(3, C))], bad, { settings }).planned.find(p => p.restack)).toBeUndefined();
    const root = mkdtempSync(join(tmpdir(), 'pr-stack-dup-'));
    try {
      writeRemembered(root, [{ ...remembered[0], restackRounds: 1 }, { ...remembered[0], restackRounds: 2 }]);
      expect(readRemembered(root).map(p => p.restackRounds)).toEqual([2]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
