/**
 * @file scope-overlap-aging.test.mjs — #3881: a fix waiter sat 3h+ in the scope-overlap queue
 *   ("waiting 3rd behind #3896, #3889") while those PRs cycled through repeated live ci-heal sessions on the same
 *   file. "In flight" still means a live claim or a higher-ranked waiter; the new AGING OVERRIDE admits a waiter
 *   whose episode is older than the bound past them — never past a fix accepted earlier in the same pass.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  filterFixesByInFlightScope, resolveScopeOverlapMaxWaitMinutes, DEFAULT_SCOPE_OVERLAP_MAX_WAIT_MINUTES,
} from '../reconcile-fix-dispatch.mjs';

const FILE = 'we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs';
const NOW = Date.parse('2026-10-04T16:56:00Z');
const live3896 = { meta: { pr: 3896, scope: [FILE] } };
const live3889 = { meta: { pr: 3889, scope: [FILE] } };

describe('#3881 — scope-overlap aging override', () => {
  it('the live case: #3881 (waiting since 13:32Z) is admitted past the live ci-heal claims of #3896/#3889', () => {
    const planned = [{ pr: 3881, itemNum: null, scope: [FILE], waitingSince: '2026-10-04T13:32:58Z' }];
    const out = filterFixesByInFlightScope(planned, [], [live3896, live3889], { now: NOW, maxWaitMinutes: 60 });
    expect(out.refusals).toEqual([]);
    expect(out.planned.map((e) => e.pr)).toEqual([3881]);
    expect(out.planned[0].agedAdmit).toEqual({ waitedMinutes: 203, maxWaitMinutes: 60, bypassed: ['fix PR #3896', 'fix PR #3889'] });
    expect(out.ranks[0].agedAdmit.bypassed).toEqual(['fix PR #3896', 'fix PR #3889']);
  });

  it('under the bound it still waits, exactly as before', () => {
    const planned = [{ pr: 3881, itemNum: null, scope: [FILE], waitingSince: '2026-10-04T16:30:00Z' }];
    const out = filterFixesByInFlightScope(planned, [], [live3896], { now: NOW, maxWaitMinutes: 60 });
    expect(out.planned).toEqual([]);
    expect(out.refusals.map((r) => r.kind)).toEqual(['scope-overlap']);
  });

  it('off (null) keeps the old unbounded wait', () => {
    const planned = [{ pr: 3881, itemNum: null, scope: [FILE], waitingSince: '2026-10-04T10:00:00Z' }];
    const out = filterFixesByInFlightScope(planned, [], [live3896], { now: NOW, maxWaitMinutes: null });
    expect(out.planned).toEqual([]);
  });

  it('never admits two overlapping fixes in one pass: a fix accepted earlier this pass still blocks an aged waiter', () => {
    const planned = [
      { pr: 10, itemNum: null, scope: [FILE], waitingSince: '2026-10-04T09:00:00Z' },
      { pr: 11, itemNum: null, scope: [FILE], waitingSince: '2026-10-04T10:00:00Z' },
    ];
    const out = filterFixesByInFlightScope(planned, [], [], { now: NOW, maxWaitMinutes: 60 });
    expect(out.planned.map((e) => e.pr)).toEqual([10]);
    expect(out.refusals.map((r) => r.pr)).toEqual([11]);
  });

  it('an aged waiter is not held behind a higher-ranked waiter that was itself refused this pass', () => {
    const planned = [
      // #20 out-ranks #21 (it blocks three waiters) but is itself refused: a live claim holds `other.mjs`.
      { pr: 20, itemNum: null, scope: [FILE, 'we:other.mjs'], waitingSince: '2026-10-04T16:26:00Z' },
      { pr: 22, itemNum: null, scope: ['we:other.mjs'], waitingSince: '2026-10-04T16:26:00Z' },
      { pr: 23, itemNum: null, scope: ['we:other.mjs'], waitingSince: '2026-10-04T16:26:00Z' },
      { pr: 21, itemNum: null, scope: [FILE], waitingSince: '2026-10-04T15:46:00Z' }, // 70 min
    ];
    const blockerOnOther = { meta: { pr: 99, scope: ['we:other.mjs'] } };
    const out = filterFixesByInFlightScope(planned, [], [blockerOnOther], { now: NOW, maxWaitMinutes: 60 });
    expect(out.ranks[0].pr).toBe(20);
    expect(out.planned.map((e) => e.pr)).toEqual([21]);
    expect(out.planned[0].agedAdmit.bypassed).toEqual(['fix PR #20']);
  });

  it('resolves the bound from env: default, number, 0/off', () => {
    expect(resolveScopeOverlapMaxWaitMinutes({})).toBe(DEFAULT_SCOPE_OVERLAP_MAX_WAIT_MINUTES);
    expect(resolveScopeOverlapMaxWaitMinutes({ WE_SCOPE_OVERLAP_MAX_WAIT_MINUTES: '90' })).toBe(90);
    expect(resolveScopeOverlapMaxWaitMinutes({ WE_SCOPE_OVERLAP_MAX_WAIT_MINUTES: '0' })).toBeNull();
    expect(resolveScopeOverlapMaxWaitMinutes({ WE_SCOPE_OVERLAP_MAX_WAIT_MINUTES: 'off' })).toBeNull();
    expect(resolveScopeOverlapMaxWaitMinutes({ WE_SCOPE_OVERLAP_MAX_WAIT_MINUTES: 'junk' })).toBe(DEFAULT_SCOPE_OVERLAP_MAX_WAIT_MINUTES);
  });
});


// Landing holds use the production aging bound, and a separate per-pair observation clock.
import { createLiveRegionOverlap, resolveFixScopePolicy } from '../fix-scope-policy.mjs';
import * as dispatchApi from '../reconcile-fix-dispatch.mjs';
import { noteEpisodeKey, noteHeadline } from '../reconcile-note-comment.mjs';
const isoAgo = minutes => new Date(NOW - minutes * 60000).toISOString();
const holder = { pr: 90, scope: [FILE], headRefOid: 'holder-head' };
const oldWaiter = { pr: 80, scope: [FILE], waitingSince: isoAgo(120) };
const landingPolicy = resolveFixScopePolicy({ env: {}, platform: {}, readTool: () => ({ fixScope: { priorityBypass: false } }) });
function landingGate(options = {}, planned = [oldWaiter], claims = []) {
  return filterFixesByInFlightScope(planned, [], claims, {
    now: NOW, maxWaitMinutes: DEFAULT_SCOPE_OVERLAP_MAX_WAIT_MINUTES, rebaseExempt: null,
    policy: landingPolicy, regionOverlap: () => ({ overlap: true, conflict: true, why: 'trial merge conflicts' }),
    holderState: () => ({ labels: ['review:accepted'] }), landingHolders: [holder],
    landingBlockedSince: new Map([['80:90', isoAgo(61)]]), ...options,
  });
}
describe('landing holder aging protection', () => {
  describe.each(['live claim', 'landing holder'])('mixed-file conflict precedence (%s)', source => {
    it.each(['intersection', 'disjoint', 'null', 'throw', 'directory'])('a preceding %s observation cannot mask a later confirmed conflict', kind => {
      const scope = ['we:assets/icon.png', 'we:shared.mjs'];
      const heldScope = kind === 'directory' ? ['we:assets/', 'we:shared.mjs'] : scope;
      const regionOverlap = (_entry, _holder, file) => {
        if (file === 'we:shared.mjs') return { overlap: true, conflict: true, holderHead: 'observed-head' };
        if (kind === 'throw') throw new Error('unreadable region');
        if (kind === 'null') return null;
        return { overlap: kind !== 'disjoint', why: kind };
      };
      const out = landingGate({
        regionOverlap,
        landingHolders: source === 'landing holder' ? [{ pr: 90, scope: heldScope, headRefOid: 'observed-head' }] : [],
      }, [{ ...oldWaiter, scope }], source === 'live claim' ? [{ meta: { pr: 90, scope: heldScope } }] : []);
      expect(out.planned).toEqual([]);
      expect(out.landingHolds).toHaveLength(1);
      expect(out.landingEscalations).toEqual([expect.objectContaining({ holder: 90, holderHead: 'observed-head' })]);
    });
    it.each([
      ['binary first', ['we:asset.png', 'we:shared.mjs']],
      ['text first', ['we:shared.mjs', 'we:asset.png']],
    ])('%s retains and escalates the confirmed conflict regardless of holder state', (_order, scope) => {
      for (const state of [{ labels: ['review:accepted'] }, null]) {
        const regionOverlap = createLiveRegionOverlap({
          readPrHeads: () => new Map([[90, 'observed-head']]), policy: landingPolicy,
          regionReader: {
            hunksFor: () => new Map([['asset.png', null], ['shared.mjs', [[1, 2]]]]),
            mergeConflicts: () => true,
          },
        });
        const out = landingGate({
          regionOverlap, holderState: () => state,
          landingHolders: source === 'landing holder' ? [{ pr: 90, scope, headRefOid: 'observed-head' }] : [],
        }, [{ ...oldWaiter, scope, headRefOid: 'waiter-head' }],
        source === 'live claim' ? [{ meta: { pr: 90, scope } }] : []);
        expect(out.planned).toEqual([]);
        expect(out.refusals[0]?.kind).toBe('scope-overlap');
        expect(out.scopeDecisions).toContainEqual(expect.objectContaining({
          holder: 90, rule: 'waitForLandingHolder', decision: 'blocked',
          why: expect.stringContaining('escalated, not released'),
        }));
        expect(out.landingHolds).toHaveLength(1);
        expect(out.landingEscalations).toEqual([expect.objectContaining({
          holder: 90, holderHead: 'observed-head', waiters: [80], failedClosed: state === null,
        })]);
      }
    });
    it('keeps the ordinary aging behavior when no shared file confirms a conflict', () => {
      const scope = ['we:asset.png', 'we:shared.mjs'];
      const regionOverlap = createLiveRegionOverlap({
        readPrHeads: () => new Map([[90, 'observed-head']]), policy: landingPolicy,
        regionReader: {
          hunksFor: () => new Map([['asset.png', null], ['shared.mjs', [[1, 2]]]]),
          mergeConflicts: () => false,
        },
      });
      const out = landingGate({
        regionOverlap,
        landingHolders: source === 'landing holder' ? [{ pr: 90, scope, headRefOid: 'observed-head' }] : [],
      }, [{ ...oldWaiter, scope, headRefOid: 'waiter-head' }], source === 'live claim' ? [{ meta: { pr: 90, scope } }] : []);
      expect(out.planned.map(e => e.pr)).toEqual([80]);
      expect(out.landingHolds).toEqual([]);
      expect(out.landingEscalations).toEqual([]);
    });
  });
  it.each([{ labels: ['review:accepted'] }, { inMergeQueue: true }])('aging never releases a confirmed conflict with a landing holder (%j)', state => {
    const out = landingGate({ holderState: () => state });
    expect(out.planned).toEqual([]);
    expect(out.scopeDecisions[0]).toMatchObject({ decision: 'blocked', why: expect.stringContaining('escalated, not released') });
    expect(out.refusals[0].kind).toBe('scope-overlap');
  });
  it('unreadable holder state stays held at 500 minutes and escalates fail closed', () => {
    const out = landingGate({ holderState: () => null, landingBlockedSince: new Map([['80:90', isoAgo(500)]]) }, [{ ...oldWaiter, waitingSince: isoAgo(500) }]);
    expect(out.planned).toEqual([]);
    expect(out.landingEscalations[0]).toMatchObject({ holder: 90, failedClosed: true, waitedMinutes: 500 });
  });
  it('non-landing confirmed conflicts dispatch in parallel', () => {
    expect(landingGate({ holderState: () => ({ labels: [] }) }).planned.map(e => e.pr)).toEqual([80]);
  });
  it.each([null, 59, 61])('pair clock ignores a ten-day-old waiter; pair age %s', age => {
    const out = landingGate({ landingBlockedSince: new Map(age === null ? [] : [['80:90', isoAgo(age)]]) }, [{ ...oldWaiter, waitingSince: isoAgo(14400) }]);
    expect(out.landingHolds).toEqual([{ pr: 80, holder: 90, holderHead: 'holder-head', since: age === null ? new Date(NOW).toISOString() : isoAgo(age), failedClosed: false }]);
    expect(out.landingEscalations).toHaveLength(age === 61 ? 1 : 0);
  });
  it('a future-dated pair clock is clamped to now and never escalates', () => {
    const out = landingGate({ landingBlockedSince: new Map([['80:90', isoAgo(-100 * 365 * 24 * 60)]]) }, [{ ...oldWaiter, waitingSince: isoAgo(500) }]);
    expect(out.landingHolds[0].since).toBe(new Date(NOW).toISOString());
    expect(out.landingEscalations).toEqual([]);
  });
  it('off keeps holds visible with no escalation', () => {
    const out = landingGate({ maxWaitMinutes: null });
    expect(out.planned).toEqual([]); expect(out.landingHolds).toHaveLength(1); expect(out.landingEscalations).toEqual([]);
  });
  it('same pass accepts exactly the first of two old overlapping waiters', () => {
    const out = landingGate({ landingHolders: [], holderState: () => ({ labels: ['review:accepted'] }) }, [oldWaiter, { ...oldWaiter, pr: 81 }]);
    expect(out.planned.map(e => e.pr)).toEqual([80]);
  });
  it('mixed blockers release the live fixer and escalate only the landing holder', () => {
    const out = landingGate({ regionOverlap: (_e, c) => ({ overlap: true, conflict: c.pr === 90, why: 'shared region' }) }, [oldWaiter], [{ meta: { pr: 91, scope: [FILE] } }]);
    expect(out.planned).toEqual([]);
    expect(out.scopeDecisions.find(d => d.holder === 91).decision).toBe('admitted');
    expect(out.landingEscalations.map(e => e.holder)).toEqual([90]);
  });
  it('groups multiple waiters into one holder escalation using the earliest clock', () => {
    const out = landingGate({ landingBlockedSince: new Map([['80:90', isoAgo(70)], ['81:90', isoAgo(61)]]) }, [oldWaiter, { ...oldWaiter, pr: 81 }]);
    expect(out.landingEscalations).toEqual([{ holder: 90, holderHead: 'holder-head', waiters: [80, 81], since: isoAgo(70), waitedMinutes: 70, maxWaitMinutes: DEFAULT_SCOPE_OVERLAP_MAX_WAIT_MINUTES, failedClosed: false }]);
  });
  it('a cleared holder dispatches the waiter on the next pass', () => {
    expect(landingGate({ holderState: () => ({ labels: [] }) }).landingHolds).toEqual([]);
    expect(landingGate({ landingHolders: [] }).planned.map(e => e.pr)).toEqual([80]);
  });
});
describe('landing-holder-stuck reconcile notes', () => {
  const escalation = { holder: 90, holderHead: 'h1', waiters: [80, 81], since: isoAgo(61), waitedMinutes: 61, maxWaitMinutes: 60, failedClosed: false };
  it.each(['claim-head', null])('escalates a 720-minute live-claim hold with unreadable holder state (claim head %s)', headSha => {
    const claim = { meta: { pr: 90, scope: [FILE], ...(headSha ? { headSha } : {}) } };
    const waiter = { ...oldWaiter, headRefOid: 'waiter-head', waitingSince: isoAgo(720) };
    const regionOverlap = createLiveRegionOverlap({
      readPrHeads: () => new Map([[90, 'observed-head']]),
      regionReader: { hunksFor: () => new Map([[FILE.replace(/^we:/, ''), [[1, 2]]]]), mergeConflicts: () => true },
      policy: landingPolicy,
    });
    const out = landingGate({
      holderState: () => null, landingHolders: [], regionOverlap,
      landingBlockedSince: new Map([['80:90', isoAgo(720)]]),
    }, [waiter], [claim]);
    expect(out.planned).toEqual([]);
    expect(out.landingEscalations).toHaveLength(1);
    expect(out.landingEscalations[0]).toMatchObject({
      holder: 90, holderHead: headSha || 'observed-head', waitedMinutes: 720, failedClosed: true,
    });
    const comments = [], postComment = vi.fn(({ body }) => {
      comments.push({ body, viewerDidAuthor: true }); return { ok: true };
    }), notify = vi.fn();
    const record = () => dispatchApi.recordLandingHolderEscalation({
      escalation: out.landingEscalations[0], repo: 'owner/repo', readPrComments: () => comments, postComment, notify,
    });
    record(); record();
    expect(postComment).toHaveBeenCalledOnce();
    expect(postComment.mock.calls[0][0]).toMatchObject({ pr: 90, body: expect.stringContaining('720 minutes') });
    expect(notify).toHaveBeenCalledOnce();
    expect(regionOverlap(waiter, claim.meta, FILE).holderHead).toBe('observed-head');
  });
  it('keeps a 720-minute live-claim hold silent when every holder head source is unknown', () => {
    const out = landingGate({
      holderState: () => null, landingHolders: [],
      landingBlockedSince: new Map([['80:90', isoAgo(720)]]),
    }, [{ ...oldWaiter, waitingSince: isoAgo(720) }], [{ meta: { pr: 90, scope: [FILE] } }]);
    expect(out.planned).toEqual([]);
    expect(out.landingEscalations).toHaveLength(1);
    expect(out.landingEscalations[0].holderHead).toBeNull();
    const readPrComments = vi.fn(), postComment = vi.fn(), notify = vi.fn();
    expect(dispatchApi.recordLandingHolderEscalation({
      escalation: out.landingEscalations[0], readPrComments, postComment, notify,
    })).toEqual({ headUnknown: true });
    expect(readPrComments).not.toHaveBeenCalled();
    expect(postComment).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
  it('keys and headlines the holder head episode', () => {
    const note = { kind: 'landing-holder-stuck', prNumber: 90, holderHead: 'h1' };
    expect(noteEpisodeKey(note)).toBe('landing-holder-stuck:90:h1');
    expect(noteHeadline(note)).toBe('needs your decision: a landing PR has held conflicting fixes past the aging bound');
  });
  it('posts once on the holder, notifies once, and posts again for a new head', () => {
    const comments = [], postComment = vi.fn(({ body }) => { comments.push({ body, viewerDidAuthor: true }); return { ok: true }; }), notify = vi.fn();
    const run = e => dispatchApi.recordLandingHolderEscalation({ escalation: e, repo: 'owner/repo', readPrComments: () => comments, postComment, notify });
    run(escalation); run(escalation); run({ ...escalation, holderHead: 'h2' });
    expect(postComment).toHaveBeenCalledTimes(2); expect(notify).toHaveBeenCalledTimes(2);
    expect(postComment.mock.calls[0][0]).toMatchObject({ pr: 90, body: expect.stringContaining('#80, #81') });
    expect(postComment.mock.calls[0][0].body).toContain('61 minutes');
    expect(postComment.mock.calls[0][0].body).toContain('/finish');
  });
  it.each([() => null, () => { throw new Error('unreadable'); }])('unreadable history fails closed without posting or notifying', readPrComments => {
    const postComment = vi.fn(), notify = vi.fn();
    expect(() => dispatchApi.recordLandingHolderEscalation({ escalation, readPrComments, postComment, notify })).not.toThrow();
    expect(postComment).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
  });
  it('unknown holder head fails closed without reading or posting', () => {
    const readPrComments = vi.fn(), postComment = vi.fn(), notify = vi.fn();
    expect(dispatchApi.recordLandingHolderEscalation({ escalation: { ...escalation, holderHead: null }, readPrComments, postComment, notify })).toEqual({ headUnknown: true });
    expect(readPrComments).not.toHaveBeenCalled(); expect(postComment).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
  });
  it('an untrusted marker cannot suppress the holder escalation', () => {
    const postComment = vi.fn(() => ({ ok: true })), notify = vi.fn();
    dispatchApi.recordLandingHolderEscalation({ escalation, readPrComments: () => [{ body: '<!-- conveyor-note-key: landing-holder-stuck:90:h1 -->', author: { login: 'untrusted-outsider' } }], postComment, notify });
    expect(postComment).toHaveBeenCalledOnce(); expect(notify).toHaveBeenCalledOnce();
  });
  it('notesDryRun posts and notifies nothing', () => {
    const postComment = vi.fn(() => ({ ok: true })), notify = vi.fn(), readPrComments = vi.fn(() => []);
    const out = dispatchApi.recordLandingHolderEscalation({ escalation, notesDryRun: true, readPrComments, postComment, notify });
    expect(out).toEqual({ dryRun: true });
    expect(postComment).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
  });
  it('WE_CONVEYOR_POST_NOTE_COMMENTS=0 is the default for notesDryRun', () => {
    expect(dispatchApi.landingNotesDryRun({ WE_CONVEYOR_POST_NOTE_COMMENTS: '0' })).toBe(true);
    expect(dispatchApi.landingNotesDryRun({})).toBe(false);
  });
  it('failed posting never notifies and can be retried', () => {
    const notify = vi.fn();
    dispatchApi.recordLandingHolderEscalation({ escalation, readPrComments: () => [], postComment: () => ({ ok: false }), notify });
    expect(notify).not.toHaveBeenCalled();
  });
});
