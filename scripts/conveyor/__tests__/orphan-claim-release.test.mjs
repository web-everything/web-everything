/**
 * @file scripts/conveyor/__tests__/orphan-claim-release.test.mjs
 * @description Unit proof of the orphaned-claim release pass's PURE core (WE #3913). Fixtures only — no fs, gh,
 *   git or clock. Pins Done-when 1: an `active` card with no lease, no open PR, no live session and a date over
 *   48 h is planned for release to `open`; the same card with any ONE of those signals present, or with a merged
 *   delivery PR, is left alone. Also pins the fail-closed rule (an unavailable source skips everything), the
 *   settle-vs-release writer choice, the age basis order, and the merged-window floor.
 */
import { describe, it, expect } from 'vitest';
import {
  parseCard, cardAgeBasis, cardAgeMs, classifyOrphan, planOrphanRelease, mergedWindowFloorOf,
  leaseNamesItem, sessionNamesItem, openPrNamesItem, cardTokens, renderPrBody, DEFAULT_MIN_AGE_MS, RUN_REF_PREFIX,
  acquireLane,
} from '../orphan-claim-release.mjs';
import { NPM_INSTALL_TIMEOUT_MS, NETWORK_GIT_TIMEOUT_MS, resolveChildTimeoutMs } from '../../lib/bounded-child.mjs';

const NOW = Date.parse('2026-09-22T12:00:00Z');

const claimed = (over = {}) => ({
  id: '3467', stem: '3467-some-card', status: 'active', kind: 'story', bornAs: 'xabc123',
  scaffoldedBy: null, dateStarted: '2026-09-10', dateScaffolded: null, dateOpened: '2026-09-01', ...over,
});

/** Positive session evidence, with nobody on this card. */
const quiet = (over = {}) => ({ nowMs: NOW, leases: [], openPrs: [], mergedPrs: [], sessions: [{ name: 'unrelated', state: 'working' }], ...over });

describe('classifyOrphan — Done-when 1', () => {
  it('releases an active card with no lease, no open PR, no live session, older than 48 h', () => {
    expect(classifyOrphan(claimed(), quiet())).toEqual({ act: true, verb: 'release', reason: 'orphaned', ageField: 'dateStarted' });
  });

  it('leaves it alone when a lane lease names it (session, purpose, workerSession or holder)', () => {
    for (const lease of [
      { session: 'conveyor-3467' },
      { session: 'Mac:1234', purpose: '3467-fix-thing' },
      { session: 'Mac:1', workerSession: 'prepare-3467' },
      { session: 'Mac:1', holder: 'x-3467-lane-4-deadbeef' },
      { session: 'Mac:1', purpose: 'xabc123-work' }, // bornAs hash
    ]) {
      expect(classifyOrphan(claimed(), quiet({ leases: [lease] })).reason, JSON.stringify(lease)).toBe('live-lease');
    }
  });

  it('leaves it alone when an OPEN PR names it (lane ref, #id in title, or manifest)', () => {
    for (const pr of [
      { headRefName: 'lane/3467-some-card', title: 'x', state: 'OPEN' },
      { headRefName: 'lane/batch-2026-09-20-3467', title: 'x', state: 'OPEN' },
      { headRefName: 'lane/other', title: 'prepare scope for #3467', state: 'OPEN' },
      { headRefName: 'lane/other', title: 'x', body: '"item": 3467', state: 'OPEN' },
    ]) {
      expect(classifyOrphan(claimed(), quiet({ openPrs: [pr] })).reason, pr.headRefName + pr.title).toBe('open-pr');
    }
  });

  it('leaves it alone when a LIVE session names it; a done/failed/stopped session does not count', () => {
    expect(classifyOrphan(claimed(), quiet({ sessions: [{ name: 'conveyor-3467', state: 'working', kind: 'background' }] })).reason).toBe('live-session');
    expect(classifyOrphan(claimed(), quiet({ sessions: [{ name: 'conveyor-3467', state: 'blocked', kind: 'interactive' }] })).reason).toBe('live-session');
    for (const state of ['done', 'failed', 'stopped']) {
      expect(classifyOrphan(claimed(), quiet({ sessions: [{ name: 'conveyor-3467', state }] })).act, state).toBe(true);
    }
  });

  it('a live session equal to the card\'s scaffoldedBy counts even when its name carries no id', () => {
    const card = claimed({ scaffoldedBy: 'investigate-stuck-prs', dateStarted: null, dateScaffolded: '2026-09-05' });
    expect(classifyOrphan(card, quiet({ sessions: [{ name: 'investigate-stuck-prs', state: 'working' }] })).reason).toBe('live-session');
  });

  it('leaves it alone at or under 48 h', () => {
    expect(classifyOrphan(claimed({ dateStarted: '2026-09-21' }), quiet()).reason).toBe('too-young');
    expect(classifyOrphan(claimed({ dateStarted: '2026-09-20' }), quiet()).reason).toBe('too-young'); // latest instant = 09-21T12Z → exactly 24 h
    expect(classifyOrphan(claimed({ dateStarted: '2026-09-19' }), quiet()).reason).toBe('too-young'); // exactly 48 h — not over
    expect(classifyOrphan(claimed({ dateStarted: '2026-09-18' }), quiet()).act).toBe(true);
  });

  it('leaves it alone when a MERGED PR delivered it (the #3914 stranded-resolve case, not a release)', () => {
    const merged = [{ number: 1, headRefName: 'lane/3467-some-card', title: 'x', body: '' }];
    expect(classifyOrphan(claimed(), quiet({ mergedPrs: merged })).reason).toBe('merged-delivery');
    const byHash = [{ number: 2, headRefName: 'lane/xabc123-thing', title: 'x', body: '' }];
    expect(classifyOrphan(claimed(), quiet({ mergedPrs: byHash })).reason).toBe('merged-delivery');
  });

  it('a merged ANNOTATION PR (prepare scope / filing) is not a delivery — still released', () => {
    const merged = [{ number: 3, headRefName: 'lane/scope-3467', title: 'author scope: for #3467', body: '' }];
    expect(classifyOrphan(claimed(), quiet({ mergedPrs: merged })).act).toBe(true);
  });

  it('an unrelated lease / PR / session does not block the release', () => {
    const sig = quiet({
      leases: [{ session: 'conveyor-1234', purpose: '1234-x' }],
      openPrs: [{ headRefName: 'lane/1234-x', title: 'unrelated', state: 'OPEN' }],
      sessions: [{ name: 'conveyor-1234', state: 'working' }],
      mergedPrs: [{ headRefName: 'lane/1234-x', title: '1234: thing', body: '' }],
    });
    expect(classifyOrphan(claimed(), sig).act).toBe(true);
  });
});

describe('classifyOrphan — guards', () => {
  it.each(['empty', 'unknown', 'ok'])('requires a nonempty, ok aggregate before releasing: %s', kind => {
    const rows = kind === 'empty' ? [] : [{ name: 'unrelated', state: 'working', storeKey: '/profile/a' }];
    const aggregate = { status: kind === 'unknown' ? 'unknown' : 'ok', rows, problems: [] };
    const sessions = Object.defineProperty(rows, 'aggregate', { value: aggregate });
    const result = planOrphanRelease([claimed()], quiet({ sessions }));
    expect(result.release).toHaveLength(kind === 'ok' ? 1 : 0);
    if (kind !== 'ok') expect(result.skip).toHaveLength(1);
  });

  it('fails closed when ANY signal source is unavailable', () => {
    for (const k of ['leases', 'openPrs', 'mergedPrs', 'sessions']) {
      const v = classifyOrphan(claimed(), quiet({ [k]: null }));
      expect(v.act, k).toBe(false);
      expect(v.reason).toMatch(/^signal-unavailable:/);
    }
  });

  it('skips unknown age', () => {
    expect(classifyOrphan(claimed({ dateStarted: null, dateScaffolded: null, dateOpened: null }), quiet()).reason).toBe('age-unknown');
    expect(classifyOrphan(claimed({ dateStarted: 'soon', dateScaffolded: null, dateOpened: null }), quiet()).reason).toBe('age-unknown');
  });

  it('never touches an epic or a non-active card', () => {
    expect(classifyOrphan(claimed({ kind: 'epic' }), quiet()).reason).toBe('epic');
    expect(classifyOrphan(claimed({ status: 'open' }), quiet()).reason).toBe('not-active');
  });

  it('born-active scaffold (scaffoldedBy, no dateStarted) settles; a claimed card releases', () => {
    const born = claimed({ scaffoldedBy: 'prepare-9999', dateStarted: null, dateScaffolded: '2026-09-01' });
    expect(classifyOrphan(born, quiet())).toMatchObject({ act: true, verb: 'settle', ageField: 'dateScaffolded' });
    // settled-then-claimed (both stamps) goes through release — settle would refuse to own a claim
    expect(classifyOrphan(claimed({ scaffoldedBy: 'rule3118', dateScaffolded: '2026-08-26' }), quiet()).verb).toBe('release');
  });

  it('a card opened before the merged-PR window floor cannot be proven undelivered → skip', () => {
    expect(classifyOrphan(claimed({ dateOpened: '2026-08-01' }), quiet({ mergedWindowFloor: '2026-08-17' })).reason).toBe('merged-window-uncovered');
    expect(classifyOrphan(claimed({ dateOpened: '2026-09-01' }), quiet({ mergedWindowFloor: '2026-08-17' })).act).toBe(true);
  });

  it('the min age is configurable', () => {
    expect(classifyOrphan(claimed({ dateStarted: '2026-09-21' }), quiet({ minAgeMs: 0 })).act).toBe(false); // latest instant is in the future
    expect(classifyOrphan(claimed({ dateStarted: '2026-09-20' }), quiet({ minAgeMs: 0 })).act).toBe(true);
    expect(DEFAULT_MIN_AGE_MS).toBe(48 * 3600_000);
  });
});

describe('age basis', () => {
  it('prefers dateStarted, then dateScaffolded, then dateOpened', () => {
    expect(cardAgeBasis(claimed())).toEqual({ field: 'dateStarted', date: '2026-09-10' });
    expect(cardAgeBasis(claimed({ dateStarted: null, dateScaffolded: '2026-09-05' }))).toEqual({ field: 'dateScaffolded', date: '2026-09-05' });
    expect(cardAgeBasis(claimed({ dateStarted: null }))).toEqual({ field: 'dateOpened', date: '2026-09-01' });
  });

  it('measures from the latest instant the date could mean (UTC midnight + 36 h)', () => {
    expect(cardAgeMs(claimed({ dateStarted: '2026-09-20' }), NOW)).toBe(24 * 3600_000);
    expect(cardAgeMs(claimed(), undefined)).toBe(null);
  });
});

describe('matchers', () => {
  const tokens = cardTokens(claimed());
  it('cardTokens keeps only real id shapes', () => {
    expect(tokens).toEqual(['3467', 'xabc123']);
    expect(cardTokens({ id: 'README', bornAs: 'null' })).toEqual([]);
  });
  it('leaseNamesItem needs a whole segment, not a substring', () => {
    expect(leaseNamesItem({ session: 'conveyor-34670' }, tokens)).toBe(false);
    expect(leaseNamesItem({ session: 'Mac:13467' }, tokens)).toBe(false);
    expect(leaseNamesItem(null, tokens)).toBe(false);
  });
  it('sessionNamesItem ignores nameless rows', () => {
    expect(sessionNamesItem({ state: 'working' }, claimed(), tokens)).toBe(false);
  });
  it('openPrNamesItem matches a lane ref by number', () => {
    expect(openPrNamesItem({ headRefName: 'lane/3467b-retry', title: '' }, claimed(), tokens)).toBe(true);
  });
});

describe('planOrphanRelease', () => {
  it('plans only orphans, lists the rest with a reason, ignores non-active cards', () => {
    const cards = [
      claimed(),
      claimed({ id: '3783', stem: '3783-x', bornAs: null, scaffoldedBy: 'prepare-3690', dateStarted: null, dateScaffolded: '2026-09-02' }),
      claimed({ id: '4000', stem: '4000-x', bornAs: null }),
      claimed({ id: '4001', stem: '4001-x', bornAs: null, status: 'open' }),
    ];
    const plan = planOrphanRelease(cards, quiet({ leases: [{ session: 'conveyor-4000' }] }));
    expect(plan.release).toEqual([
      { id: '3467', stem: '3467-some-card', verb: 'release', ageField: 'dateStarted' },
      { id: '3783', stem: '3783-x', verb: 'settle', ageField: 'dateScaffolded' },
    ]);
    expect(plan.skip).toEqual([{ id: '4000', reason: 'live-lease' }]);
  });
});

describe('parseCard / mergedWindowFloorOf / renderPrBody', () => {
  it('parseCard reads frontmatter only', () => {
    const body = '---\nstatus: active\nkind: story\nscaffoldedBy: "s1"\ndateScaffolded: "2026-09-02"\ndateOpened: "2026-09-02"\n---\n\nstatus: open\n';
    expect(parseCard('3783-x', body)).toMatchObject({ id: '3783', status: 'active', kind: 'story', scaffoldedBy: 's1', dateScaffolded: '2026-09-02', dateStarted: null });
  });
  it('mergedWindowFloorOf is null for a complete list, the oldest date for a full one', () => {
    expect(mergedWindowFloorOf([{ createdAt: '2026-09-01T00:00:00Z' }], 5)).toBe(null);
    expect(mergedWindowFloorOf([{ createdAt: '2026-09-03T00:00:00Z' }, { createdAt: '2026-08-17T10:00:00Z' }], 2)).toBe('2026-08-17');
    expect(mergedWindowFloorOf([{}, {}], 2)).toBe('9999-12-31'); // full but undated → cover nothing
  });
  it('renderPrBody lists each card and ends with the attribution line', () => {
    const body = renderPrBody([{ id: '3467', verb: 'release', ageField: 'dateStarted' }]);
    expect(body).toContain('#3467');
    expect(body.trim().endsWith('🤖 Generated with [Claude Code](https://claude.com/claude-code)')).toBe(true);
    expect(RUN_REF_PREFIX).toMatch(/^lane\//);
  });
});

// #x5n4zn3 review — `lane-pool.mjs acquire` (no `--no-install`) runs `ensureDeps`' `npm ci` under its OWN
// `NPM_INSTALL_TIMEOUT_MS` budget. The outer wrapper around that acquire must never be tighter than the work it
// wraps, or a slow-but-healthy install gets SIGKILLed mid-way, leaking the lease and aborting the pass.
describe('acquireLane — the outer acquire budget covers lane-pool\'s own npm install budget', () => {
  it('passes a timeout covering the network fetch + npm install + the generic child budget', () => {
    const calls = [];
    const fakeRun = (cmd, args, cwd, opts) => { calls.push({ cmd, args, cwd, opts }); return JSON.stringify({ lane: 3, path: '/x/lane-3', holder: 'h' }); };
    const acq = acquireLane(fakeRun);
    expect(acq).toEqual({ lane: 3, path: '/x/lane-3', holder: 'h' });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain('acquire');
    expect(calls[0].args).not.toContain('--no-install'); // deps ARE installed — which is why the budget matters
    expect(calls[0].opts?.timeoutMs).toBeGreaterThan(NETWORK_GIT_TIMEOUT_MS + NPM_INSTALL_TIMEOUT_MS + resolveChildTimeoutMs());
  });

  it('stays larger than fetch + install even when WE_CHILD_TIMEOUT_MS is tuned very small', () => {
    const prev = process.env.WE_CHILD_TIMEOUT_MS;
    process.env.WE_CHILD_TIMEOUT_MS = '1000';
    try {
      const calls = [];
      acquireLane((cmd, args, cwd, opts) => { calls.push(opts); return '{"lane":1,"path":"/x","holder":"h"}'; });
      expect(calls[0].timeoutMs).toBeGreaterThan(NETWORK_GIT_TIMEOUT_MS + NPM_INSTALL_TIMEOUT_MS);
    } finally {
      if (prev === undefined) delete process.env.WE_CHILD_TIMEOUT_MS; else process.env.WE_CHILD_TIMEOUT_MS = prev;
    }
  });
});
