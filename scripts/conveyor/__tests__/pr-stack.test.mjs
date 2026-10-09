import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { planIdleRestacks, readRemembered, writeRemembered, PR_STACK_DEFAULTS, resolvePrStackSettings, detectStacks, bottomOf, abovePrs, applyStackOrder, restackKey, markRestackUsed, withRestackHint, nextRemembered, readStacksForPass, readOriginLaneTips, readOpenPrRefs } from '../pr-stack.mjs';
import { filterFixesByInFlightScope, runReconcileFixDispatch } from '../reconcile-fix-dispatch.mjs';
import { REFUSAL_KINDS } from '../reconcile-core.mjs';

const a = { pr: 4624, headRefName: 'lane/red-main-contain', headRefOid: '459ea6f4fe3c330df5b0640589635cee3f3d5561' };
const b = { pr: 4631, headRefName: 'lane/accept-carry-forward', headRefOid: 'c143be0ddfdf8b0d3501e436fb7632ad03e518f4' };
const ancestor = (x, y) => x === a.headRefOid && y === b.headRefOid;
const live = () => detectStacks([a, b], { isAncestor: ancestor });
const settings = PR_STACK_DEFAULTS;
const scope = ['we:scripts/merge-ai-prs.mjs', 'we:backlog/xx7ckd6-x.md'];
const entries = [a, b].map(p => ({ pr: p.pr, headRefOid: p.headRefOid, laneRef: p.headRefName, scope }));
const claim = pr => ({ meta: { repo: 'we', pr, scope } });

describe('stack detection and memory', () => {
  it('detects the live content stack and its helpers', () => {
    expect(live().pairs).toEqual([{ top: 4631, bottom: 4624, bottomRef: a.headRefName, bottomHead: a.headRefOid, topHead: b.headRefOid, bottomOpen: true, inSync: true, restackedFor: null, restackRounds: 0 }]);
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
    const moved = detectStacks([{ ...a, headRefOid: 'moved' }, b], { remembered, isAncestor: () => false });
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
});

describe('settings and fail-open IO', () => {
  it('cascades defaults, file and env with malformed fallbacks', () => {
    expect(resolvePrStackSettings({}, { read: () => ({}) })).toEqual(settings);
    expect(resolvePrStackSettings({}, { read: () => ({ prStack: { restack: 'off' } }) }).restack).toBe(false);
    expect(resolvePrStackSettings({ WE_PR_STACK_RESTACK: 'yes' }, { read: () => ({ prStack: { restack: 'off' } }) }).restack).toBe(true);
    expect(resolvePrStackSettings({ WE_PR_STACK_RESTACK: 'bad' }, { read: () => ({ prStack: { restack: 'no' } }) }).restack).toBe(false);
    expect(resolvePrStackSettings({ WE_PR_STACK_DETECT: '0' }, { read: () => { throw Error(); } })).toEqual({ detect: false, bottomFirst: false, restack: false, restackMaxRounds: 3 });
  });
  it('combines planned and open heads, remembers pairs and fails open', () => {
    const writeMem = vi.fn(); const readHeads = vi.fn(() => new Map([[b.pr, { headRefName: b.headRefName, headRefOid: b.headRefOid, isCrossRepository: false }]]));
    const options = { root: '/repo', repoKey: 'we', planned: [entries[0]], openPrFiles: [{ pr: b.pr }], settings, readRefs: readHeads, isAncestor: ancestor, onMain: () => false, readMem: () => [], writeMem,
      readLanes: () => new Map([[a.headRefName, a.headRefOid], [b.headRefName, b.headRefOid]]) };
    expect(readStacksForPass(options).pairs[0]).toMatchObject({ top: b.pr, bottom: a.pr });
    expect(readHeads).toHaveBeenCalledWith('/repo', [b.pr]);
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
    for (const patch of [{ restackedFor: 'idle-bottom-v2' }, { restackRounds: 3 }]) {
      const stacks = moved(); Object.assign(stacks.pairs[0], patch);
      expect(planIdleRestacks(stacks, opts)).toEqual([]);
    }
    for (const key of ['detect', 'restack']) expect(planIdleRestacks(moved(), { ...opts, settings: { ...settings, [key]: false } })).toEqual([]);
  });
  it('keys retries to the bottom head, caps owed tops and holds them as peers', () => {
    const stacks = moved(); const used = new Set();
    const first = applyStackOrder([entries[1]], stacks, { settings }).planned[0];
    expect(restackKey(first)).toBe('restack:4631:idle-bottom-v2');
    markRestackUsed(first, used);
    expect(planIdleRestacks(stacks, { ...opts, used })).toEqual([]);
    stacks.pairs[0].bottomHead = 'idle-bottom-v3';
    expect(planIdleRestacks(stacks, { ...opts, used })).toHaveLength(1);
    stacks.pairs[0].restackRounds = 3;
    const capped = applyStackOrder([entries[1]], stacks, { settings: { ...settings, bottomFirst: false }, used });
    expect(capped.planned).toEqual([]);
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
  it('dispatches both bottom and idle top once, recording history only on success', () => {
    const stacks = moved(); stacks.pairs[0].bottomHead = 'dispatch-idle-v2';
    const readPrForRestack = vi.fn(() => ({ ...b, prNumber: b.pr, kind: 'fix', labels: ['review:pending'], body: '', isCrossRepository: false }));
    const readLaneTips = () => new Map([[b.headRefName, b.headRefOid]]);
    const dispatch = vi.fn(p => p);
    const args = { root: '/repo', repo: 'we', checkStaleness: () => ({ stale: false }),
      reconcile: () => ({ dispatch: [{ ...a, prNumber: a.pr, kind: 'fix', files: ['scripts/merge-ai-prs.mjs'] }], refusals: opts.reconcileRefusals }),
      prStack: () => stacks, prStackSettings: settings, readPrForRestack, readLaneTips,
      findItemFn: () => null, loadItems: () => [], pickFreeLanes: () => [1, 2], dispatch,
      fetchItemlessDiffPaths: () => ['scripts/merge-ai-prs.mjs'], resolveFallbackScope: () => scope,
      resolveProfile: () => ({ capabilities: { fix: true, ciHeal: true }, canonicalPrefix: 'we' }),
      listBuildClaims: () => [], listFixClaims: () => [], priorityShadow: null };
    const out = runReconcileFixDispatch(args);
    expect(out.dispatched.map(p => p.pr)).toEqual([a.pr, b.pr]);
    const top = out.dispatched[1];
    expect(top.restack.onto).toBe(a.headRefName);
    expect(withRestackHint('original', top.restack)).toContain('no review findings to address');
    expect(stacks.pairs[0]).toMatchObject({ restackedFor: 'dispatch-idle-v2', restackRounds: 1 });
    expect(runReconcileFixDispatch(args).dispatched.map(p => p.pr)).toEqual([a.pr]);
    expect(readPrForRestack).toHaveBeenCalledTimes(1);
    stacks.pairs[0].bottomHead = 'dispatch-idle-v3';
    dispatch.mockImplementation(() => { throw Error('launch failed'); });
    runReconcileFixDispatch(args);
    expect(stacks.pairs[0]).toMatchObject({ restackedFor: 'dispatch-idle-v2', restackRounds: 1 });
    readPrForRestack.mockImplementation(() => { throw Error('read failed'); });
    expect(() => runReconcileFixDispatch(args)).not.toThrow();
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
      const stacks = detectStacks([mk(1, head), top], { remembered, isAncestor: () => false });
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
        expect(readRemembered(root)).toEqual([]);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('trust boundary and branch names for idle bottoms', () => {
  const lanes = [mk(4624, 'aaa', 'lane/red-main-contain'), mk(4631, 'bbb', 'lane/accept-carry-forward')];
  const base = (over = {}) => ({ root: '/repo', repoKey: 'we', planned: [entryOf(lanes[1])], openPrFiles: [{ pr: 4624 }, { pr: 4631 }], settings,
    readRefs: () => new Map([[4624, { headRefName: 'lane/red-main-contain', headRefOid: 'aaa', isCrossRepository: false }]]),
    isAncestor: (x, y) => x === 'aaa' && y === 'bbb', onMain: () => false,
    readMem: () => [], writeMem: vi.fn(), readLanes: () => new Map([['lane/red-main-contain', 'aaa'], ['lane/accept-carry-forward', 'bbb']]), ...over });
  it('resolves the branch name of an initially idle (unplanned) bottom from origin', () => {
    const options = base();
    expect(readStacksForPass(options).pairs[0]).toMatchObject({ top: 4631, bottom: 4624, bottomRef: 'lane/red-main-contain' });
    const stored = options.writeMem.mock.calls[0][1];
    const moved = detectStacks([mk(4624, 'aaa2', 'lane/red-main-contain'), lanes[1]], { remembered: stored, isAncestor: () => false });
    expect(applyStackOrder([entryOf(lanes[1])], moved, { settings }).planned[0].restack.onto).toBe('lane/red-main-contain');
  });
  it('takes the branch name from GitHub, never from a sha: a twin at the same tip cannot be picked', () => {
    const twinTips = new Map([['lane/red-main-contain', 'aaa'], ['lane/red-main-contain-alt', 'aaa'], ['lane/accept-carry-forward', 'bbb']]);
    expect(readStacksForPass(base({ readLanes: () => twinTips })).pairs[0].bottomRef).toBe('lane/red-main-contain');
    const altRefs = new Map([[4624, { headRefName: 'lane/red-main-contain-alt', headRefOid: 'aaa', isCrossRepository: false }]]);
    expect(readStacksForPass(base({ readLanes: () => twinTips, readRefs: () => altRefs })).pairs[0].bottomRef).toBe('lane/red-main-contain-alt');
  });
  it('ignores a PR whose head is not the tip of its origin lane branch, a fork PR, and an unreadable PR', () => {
    expect(readStacksForPass(base({ readLanes: () => new Map([['lane/accept-carry-forward', 'bbb']]) })).pairs).toEqual([]);
    expect(readStacksForPass(base({ readLanes: () => new Map([['lane/red-main-contain', 'zzz'], ['lane/accept-carry-forward', 'bbb']]),
      planned: [entryOf(lanes[1]), entryOf(lanes[0])] })).pairs).toEqual([]);
    // A fork PR carrying the same sha under the same lane name as a real origin branch.
    const fork = new Map([[4624, { headRefName: 'lane/red-main-contain', headRefOid: 'aaa', isCrossRepository: true }]]);
    expect(readStacksForPass(base({ readRefs: () => fork })).pairs).toEqual([]);
    expect(readStacksForPass(base({ readRefs: () => new Map() })).pairs).toEqual([]);
  });
  it('keeps a remembered pair through a pass where its bottom is transiently untrusted', () => {
    const remembered = [{ top: 4631, bottom: 4624, bottomRef: 'lane/red-main-contain', bottomHead: 'a'.repeat(40), restackedFor: null, restackRounds: 0 }];
    const out = readStacksForPass(base({ readMem: () => remembered, readRefs: () => new Map(), isAncestor: () => false }));
    expect(bottomOf(out, 4631)).toMatchObject({ bottom: 4624, bottomRef: 'lane/red-main-contain', bottomOpen: true });
  });
  it('reads open PR refs from gh and treats anything unreadable as unverified', () => {
    const run = vi.fn(() => JSON.stringify([{ number: 1, headRefName: 'lane/a', headRefOid: 'x', isCrossRepository: false }, { number: 2, headRefName: 'lane/b', headRefOid: 'y' }, { nope: 1 }]));
    const refs = readOpenPrRefs('/repo', { run });
    expect(refs.get(1)).toEqual({ headRefName: 'lane/a', headRefOid: 'x', isCrossRepository: false });
    expect(refs.get(2).isCrossRepository).toBe(true);
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
