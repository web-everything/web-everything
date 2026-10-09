import { describe, it, expect, vi } from 'vitest';
import { PR_STACK_DEFAULTS, resolvePrStackSettings, detectStacks, bottomOf, abovePrs, applyStackOrder, restackKey, markRestackUsed, withRestackHint, nextRemembered, readStacksForPass } from '../pr-stack.mjs';
import { filterFixesByInFlightScope, runReconcileFixDispatch } from '../reconcile-fix-dispatch.mjs';

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
    expect(live().pairs).toEqual([{ top: 4631, bottom: 4624, bottomRef: a.headRefName, bottomHead: a.headRefOid, topHead: b.headRefOid, bottomOpen: true, inSync: true }]);
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
    expect(resolvePrStackSettings({ WE_PR_STACK_DETECT: '0' }, { read: () => { throw Error(); } })).toEqual({ detect: false, bottomFirst: false, restack: false });
  });
  it('combines planned and open heads, remembers pairs and fails open', () => {
    const writeMem = vi.fn(); const readHeads = vi.fn(() => new Map([[b.pr, b.headRefOid]]));
    const options = { root: '/repo', repoKey: 'we', planned: [entries[0]], openPrFiles: [{ pr: b.pr }], settings, readHeads, isAncestor: ancestor, onMain: () => false, readMem: () => [], writeMem };
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
