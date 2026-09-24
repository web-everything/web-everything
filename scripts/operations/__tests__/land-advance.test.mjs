import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { planLandAdvance, capacityFor, followUpVerdict, OWED_ACTIONS, repoKeyFromSlug, sessionMatch, renderTable, decideMode } from '../land-advance.mjs';
// priorityQueue/reconcileHolds live in land-advance-items-io.mjs, which is #3865's scope (blockedBy THIS item,
// so it cannot land first). The two cases below that exercised them are deferred to #3865 rather than ported
// here dropped-silently — see this slice's PR notes and #3865's card for the restore.
import { dispatchPlan } from '../../readiness/dispatch-plan.mjs';
import { CONSTELLATION_REPOS } from '../../lib/constellation-repos.mjs';
const today = JSON.parse(readFileSync('scripts/operations/__fixtures__/land-advance/today.json'));
const now = Date.parse('2026-09-20T00:00:00Z');
const pr = (number, extra = {}) => ({ repo: 'we', slug: 'chalbert/web-everything', number, labels: ['review:pending'], createdAt: '2026-09-08T00:00:00Z', updatedAt: '2026-09-08T12:14:00Z', baseRefName: 'main', ...extra });
const plan = (extra = {}) => planLandAdvance({ now, prs: [], freeLanes: 8, ...extra });
const history = (n) => Array.from({ length: n }, (_, i) => ({ at: new Date(now - (n - i) * 80000).toISOString(), deferredDetail: [{ num: 2072, waitOn: ['couple-carrier:unknown'] }] }));
describe('what is owed', () => {
  it('reproduces the five sibling reviews and names the impl blocking the carrier', () => {
    const prs = [...today, ...[148,149,150,155].map((n) => pr(n, { repo: 'plateau-app' }))];
    const h = history(12960), parsed = h.map(JSON.stringify).join('\n').split('\n').map(JSON.parse);
    const p = plan({ prs, history: parsed, historyCapped: true, fixPlans: { 'we#2108': { planned: { pr: 2108 } } } });
    expect(p.rows.filter((r) => r.owedAction === 'dispatch-review')).toHaveLength(5);
    const stuck = p.rows.find((r) => r.pr === 2072);
    expect(stuck).toMatchObject({ owedAction: 'escalate', kind: 'stuck-in-drain', blockedBy: 'plateau-app#153' });
    expect(stuck.evidence.join(' ')).toContain('review:pending');
    expect(stuck.evidence.join(' ')).toContain('>=12960');
    expect(stuck.packet).toContain('would-write');
    expect(p.rows.find((r) => r.pr === 2220).owedAction).toBe('fold-into-prototype');
    expect(p.rows.find((r) => r.pr === 2108).owedAction).toBe('dispatch-fix');
    expect(p.rows.find((r) => r.pr === 153).ageMs).toBe(12 * 86400000);
    expect(p.rows.every((r) => OWED_ACTIONS.includes(r.owedAction))).toBe(true);
  });
  it('requires consecutive identical waits; skips count too', () => {
    expect(plan({ prs: today, history: history(5) }).rows.find((r) => r.pr === 2072).owedAction).toBe('wait-on-drain');
    const p = plan({ prs: [pr(1)], history: [{ at: '2026-09-01', skippedPrs: [{ num: 1, repo: 'we', reason: 'old' }] }, { at: '2026-09-19', skippedPrs: [{ num: 1, repo: 'we', reason: 'not mergeable (mergeable=UNKNOWN)' }] }] });
    expect(p.rows[0].evidence.join(' ')).toContain('1 consecutive');
    expect(p.rows[0].evidence.join(' ')).toContain('UNKNOWN');
  });
  it('retains fix refusals', () => {
    for (const kind of ['no-scope', 'unsupported-repo']) {
      const p = plan({ prs: [pr(2170, { labels: ['review:changes'] })], fixPlans: { 'we#2170': { refusal: { kind, why: kind } } } });
      expect(p.rows[0]).toMatchObject({ owedAction: 'dispatch-fix', dispatchable: false, refusal: { kind } });
      expect(p.deferred[0].reason).toBe(kind);
    }
  });
  it('collapses 44 dead records and counts no live workers', () => {
    const sessions = Array.from({ length: 44 }, (_, i) => ({ name: `review-${i}`, kind: 'background', state: i < 31 ? 'working' : 'blocked', liveness: 'dead-record' }));
    const p = plan({ sessions }); expect(p.capacity.live).toBe(0); expect(p.rows).toHaveLength(1); expect(p.rows[0].count).toBe(44);
  });
  it('graduation waits for neither open PR nor live worker', () => {
    const prototype = { ahead: 180, behind: 321 };
    expect(plan({ prototype }).rows[0].owedAction).toBe('graduation-owed');
    expect(plan({ prototype, prs: [pr(2344, { headRefName: 'lane/graduate-3443-fix-dispatch-pr-diff-scope' })] }).rows.some((r) => r.owedAction === 'graduation-owed')).toBe(false);
    expect(plan({ prototype, sessions: [{ name: 'conveyor-3443', liveness: 'live-idle' }] }).rows).toHaveLength(0);
  });
  it('capacity counts only sessions whose verdict holds a slot: a finished session with a live pid does not', () => {
    const s = (name, verdict, extra = {}) => ({ name, kind: 'background', liveness: 'live-idle', verdict, ...extra });
    const sessions = [s('review-1', 'progressing'), s('fix-2', 'stalled'), s('fix-3', 'waiting-permission'), // hold a slot
      s('fix-4', 'finished-unreaped'), s('fix-5', 'target-moved-on'), s('fix-6', 'finished-unreaped', { liveness: 'done' }), s('fix-7', 'dead-record', { liveness: 'dead-record' }), // do not
      { name: 'fix-8', kind: 'background', liveness: 'live-active' }]; // no verdict: legacy liveness-only rule
    expect(capacityFor({ sessions, freeLanes: 9, cap: 5 })).toMatchObject({ live: 4, budget: 1 });
    // tonight: two fixers and a reviewer working, one old finished fixer still alive, cap 4 -> a slot is free
    const tonight = [s('review-148', 'progressing'), s('fix-2347', 'stalled'), s('fix-2108', 'progressing'), s('fix-2347', 'finished-unreaped')];
    expect(capacityFor({ sessions: tonight, freeLanes: 12, cap: 4 })).toMatchObject({ live: 3, budget: 1 });
    expect(planLandAdvance({ now, prs: [pr(10)], freeLanes: 8, sessions: tonight, cap: 4 }).proposed).toHaveLength(1);
  });
  it.each([{ freeLanes: 0 }, { load: 1.6 }, { freeLanes: 'unknown' }, { sessions: [1,2,3].map((n) => ({ name: `review-${n}`, kind: 'background', liveness: 'live-active' })) }])('fails closed on capacity %j', (extra) => {
    const p = plan({ prs: [pr(10), pr(11)], ...extra }); expect(p.proposed).toHaveLength(0); expect(p.deferred.map((r) => r.reason)).toEqual(['capacity','capacity']);
    expect(renderTable(p)).toContain('freeLanes');
  });
  it('selects oldest first within budget', () => {
    const p = plan({ cap: 2, prs: [1,2,3,4,5].map((n) => pr(n, { createdAt: `2026-09-0${6 - n}` })) });
    expect(p.proposed.map((r) => r.pr)).toEqual([5,4]); expect(p.deferred).toHaveLength(3);
  });
  it('pins precedence and the operator label conjunction', () => {
    const all = ['review:accepted','review:human','advisory:accepted','review:changes','review:pending','checking'];
    expect(plan({ prs: [pr(1, { labels: all, baseRefName: 'lane/mechanical-dispatcher' })] }).rows[0].owedAction).toBe('fold-into-prototype');
    expect(plan({ prs: [pr(1, { labels: all })] }).rows[0].owedAction).toBe('needs-operator');
    for (const label of ['review:human','advisory:accepted']) expect(plan({ prs: [pr(1, { labels: [label] })] }).rows[0].owedAction).toBe('none');
    expect(plan({ prs: [pr(1, { labels: ['checking'], mergeStateStatus: 'CLEAN' })] }).rows[0].owedAction).toBe('stale-label');
    expect(plan({ prs: [pr(1, { labels: ['review:changes','review:pending'] })] }).rows[0].owedAction).toBe('dispatch-fix');
  });
  it('keeps same-number PRs distinct and refuses ambiguous workers', () => {
    const prs = [pr(49), pr(49, { repo: 'frontierui' })], s = { name: 'review-49', id: 'a', liveness: 'live-active' };
    expect(sessionMatch(s, prs[0], prs)).toBe('ambiguous');
    expect(sessionMatch(s, prs[0], prs, [{ session: 'a', target: 'we#49' }])).toBe('matched');
    const p = plan({ prs, sessions: [s] }); expect(p.rows.map((r) => r.subject)).toEqual(['we#49','frontierui#49']); expect(p.proposed).toHaveLength(0);
  });
  it('detects unlogged authorship and only absent records', () => {
    expect(plan({ results: [{ path: '/r', provider: 'Codex', mtime: '2026-09-01' }] }).rows[0].owedAction).toBe('delegation-trial-owed');
    expect(plan({ results: [{ path: '/r', provider: 'Codex' }], trials: [{ result: '/r', provider: 'codex' }] }).rows).toHaveLength(0);
  });
  it('maps every configured full slug and refuses unknowns', () => {
    const repos = JSON.parse(readFileSync('scripts/lib/swept-repos.json'));
    expect(repos).toEqual(['chalbert/web-everything','chalbert/frontierui','chalbert/plateau-app']);
    for (const slug of repos) expect(CONSTELLATION_REPOS[repoKeyFromSlug(slug)]).toBeDefined();
    expect(() => repoKeyFromSlug('evil/frontierui')).toThrow();
  });
});
describe('ground-truth follow-ups', () => {
  const entry = { deadline: '2026-09-19', launchedAt: '2026-09-18', target: 'we#1', session: 's' };
  it.each([
    ['progressing', { liveness: 'live-active', lastActivityAt: '2026-09-19T23:59:00Z' }],
    ['finished', { resultPresent: true }], ['stalled', { liveness: 'live-idle' }], ['dead', { liveness: 'dead-record' }],
    ['waiting-permission', { liveness: 'waiting', waitingFor: 'permission' }], ['target-moved-on', { targetState: 'MERGED' }], ['ambiguous', {}],
  ])('%s', (verdict, evidence) => expect(followUpVerdict(entry, evidence, now)).toBe(verdict));
  it('surfaces collect and escalation hints', () => {
    for (const [evidence, action] of [[{ resultPresent: true }, 'reap-owed'], [{}, 'escalate'], [{ liveness: 'live-idle' }, 'escalate']]) expect(plan({ followUps: [{ ...entry, evidence }] }).rows[0].owedAction).toBe(action);
  });
});
it('does not redispatch an unresolved prior launch', () => {
  const p = plan({ prs: [pr(1)], followUps: [{ session: null, target: 'we#1', evidence: { ambiguous: true } }] });
  expect(p.proposed).toHaveLength(0); expect(p.deferred[0].reason).toBe('ambiguous');
});
describe('session verdict rows (#3383 item 11)', () => {
  const s = (over) => ({ id: 'x1', name: 'fold-2220', kind: 'background', liveness: 'live-idle', startedAt: '2026-09-19T00:00:00Z', ...over });
  it('reap-owed for finished-unreaped and target-moved-on sessions; registry `done` without a verdict still counts', () => {
    const rows = plan({ sessions: [s({ verdict: 'finished-unreaped', why: 'fold-2220: blocked at its prompt, result file r.md' }), s({ id: 'x2', verdict: 'target-moved-on' }), s({ id: 'x3', liveness: 'done' }), s({ id: 'x4', verdict: 'progressing' })] }).rows;
    expect(rows.filter((r) => r.owedAction === 'reap-owed').map((r) => r.subject).sort()).toEqual(['session:x1', 'session:x2', 'session:x3']);
    expect(rows.find((r) => r.subject === 'session:x1').evidence[0]).toContain('result file');
  });
  it('a dead record with a stale verdict is never a per-session reap row (it collapses into the dead-records summary)', () => {
    expect(plan({ sessions: [s({ liveness: 'dead-record', verdict: 'finished-unreaped' })] }).rows.map((r) => r.subject)).toEqual(['sessions:dead-records']);
  });
  it('escalate only on the ladder\'s second rung, as a packet row that never names the operator', () => {
    const p = plan({ sessions: [s({ verdict: 'stalled', action: 'redispatch-once' }), s({ id: 'x2', verdict: 'waiting-permission', action: 'escalate', why: 'blocked on permission prompt' })] });
    expect(p.rows.map((r) => [r.subject, r.owedAction])).toEqual([['session:fold-2220', 'escalate']]);
    expect(p.rows[0]).toMatchObject({ kind: 'session-waiting-permission', packetId: 'session-waiting-permission-session-fold-2220' });
    expect(p.rows.some((r) => r.owedAction === 'needs-operator')).toBe(false);
  });
});
// #3720 remainder — the card's own Done-when 1 cases for the item-pull half, the budget, and the mode decision.
// Item plans come from the REAL `dispatchPlan` core, so scope refusal and overlap are its rules, never a copy.
describe('#3720 item-pull, budget and mode (the card\'s Done-when cases)', () => {
  const items = (queue, extra = {}) => ({ queue: queue.map(({ num }, i) => ({ num, rank: i + 1 })), skipped: [], itemPlan: dispatchPlan({ queue, leases: [], freeLanes: [31, 32, 33] }), ...extra });
  it('budget 0 when free lanes are 0 — nothing proposed, PR or item', () => {
    const p = plan({ freeLanes: 0, prs: [pr(1)], items: items([{ num: '10', scope: ['scripts/a.mjs'] }]) });
    expect(p.capacity.budget).toBe(0);
    expect(p.proposed).toEqual([]);
    expect(p.items.proposed).toEqual([]);
    expect(p.items.deferred).toMatchObject([{ num: '10', reason: 'capacity' }]);
  });
  it('budget 0 when live sessions are at the ceiling — nothing proposed', () => {
    const sessions = [1, 2, 3].map((n) => ({ name: `review-${n}`, kind: 'background', liveness: 'live-active' }));
    const p = plan({ cap: 3, sessions, prs: [pr(1)], items: items([{ num: '10', scope: ['scripts/a.mjs'] }]) });
    expect(p.capacity).toMatchObject({ budget: 0, live: 3 });
    expect(p.proposed).toEqual([]);
    expect(p.items.proposed).toEqual([]);
  });
  it('an item with no declared scope is refused (dispatch-plan holds it unshaped-no-scope)', () => {
    const p = plan({ items: items([{ num: '10' }, { num: '11', scope: [] }]), maxItemsPerCall: 3 });
    expect(p.items.proposed).toEqual([]);
    expect(p.items.deferred.map((d) => [d.num, d.reason])).toEqual([['10', 'unshaped-no-scope'], ['11', 'unshaped-no-scope']]);
  });
  it('two items whose scopes overlap never dispatch in one call', () => {
    const p = plan({ items: items([{ num: '10', scope: ['scripts/operations/'] }, { num: '11', scope: ['scripts/operations/land-advance.mjs'] }, { num: '12', scope: ['docs/x.md'] }]), maxItemsPerCall: 3 });
    expect(p.items.proposed.map((i) => i.num)).toEqual(['10', '12']);
    expect(p.items.deferred).toMatchObject([{ num: '11', reason: expect.stringMatching(/^overlaps lane-/) }]);
  });
  it('owed PR work takes the budget first; items get the rest, capped per call (default 1)', () => {
    const q = items([{ num: '10', scope: ['a/'] }, { num: '12', scope: ['b/'] }]);
    const p = plan({ freeLanes: 2, prs: [pr(1)], items: q });
    expect(p.proposed.map((r) => r.subject)).toEqual(['we#1']);
    expect(p.items.proposed.map((i) => i.num)).toEqual(['10']);
    expect(p.items.deferred).toMatchObject([{ num: '12', reason: 'capacity' }]);
    expect(plan({ freeLanes: 8, items: q }).items.deferred).toMatchObject([{ num: '12', reason: 'per-call-cap' }]);
  });
  // 'the queue source is the Priority order...' deferred to #3865 (needs priorityQueue from land-advance-items-io.mjs).
  it('mode: plan by default; dispatch only with an operator opt-in AND no pause marker', () => {
    const optIn = { prs: true, items: false };
    expect(decideMode({})).toMatchObject({ mode: 'plan', prs: false, items: false });
    expect(decideMode({ requested: 'dispatch', gate: { optIn: {} } })).toMatchObject({ mode: 'plan', why: expect.stringContaining('opt-in') });
    expect(decideMode({ requested: 'dispatch', gate: { optIn, paused: true } })).toMatchObject({ mode: 'plan', why: expect.stringContaining('pause') });
    expect(decideMode({ requested: 'dispatch', gate: { optIn, error: 'bad json' } })).toMatchObject({ mode: 'plan' });
    expect(decideMode({ requested: 'dispatch', gate: { optIn } })).toMatchObject({ mode: 'dispatch', prs: true, items: false });
  });
});
// 'describe #3720 owed PR work honours reconcile-pass refusals' deferred to #3865
// (needs reconcileHolds from land-advance-items-io.mjs).
