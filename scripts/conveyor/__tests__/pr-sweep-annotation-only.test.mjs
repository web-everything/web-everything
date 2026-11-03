import { it, expect } from 'vitest';
import { runPrSweep } from '../pr-sweep.mjs';
import { evaluateInvariant, stateFingerprint } from '../pr-sweep-core.mjs';
import { buildBlockedMap } from '../pr-blocked-by.mjs';
const minute = 60000, now = Date.parse('2026-11-02T16:00:00Z');
const pr = { repo: 'web-everything/web-everything', number: 12, title: 'probe', headRefOid: 'a'.repeat(40), updatedAt: new Date(now - 120 * minute).toISOString(), labels: ['review:pending'], changedFiles: 5 };
const key = `${pr.repo}#12`, blocker = { ...pr, number: 13 };
const settings = { repos: [pr.repo], idleMinutes: 45, stuckAfterMinutes: 90, stuckAlertMinutes: 90 };
const run = extra => runPrSweep({ now, dryRun: true, env: {}, settings: { value: settings, sources: {} }, readPrs: () => [pr], readPrevious: () => ({}), readQueue: () => ({ ready: [], rulingNeeded: [] }), readSignals: () => ({}), detector: async () => ({ enabled: false, items: [], errors: [], nextSeen: {} }), ...extra });

it.each(['Unblocks', 'blocked-by'])('overdue PR alerts exactly once on its normal schedule with an %s edge', async source => {
  const rows = source === 'Unblocks' ? [pr, { ...blocker, body: 'Unblocks: #12' }] : [{ ...pr, body: 'Blocked-by: #13' }, blocker];
  let previous = { episodes: { [key]: { head: pr.headRefOid, updatedAt: pr.updatedAt, fingerprint: stateFingerprint(pr), firstUnownedAt: now - 91 * minute, alerted: false } } };
  const alerts = [];
  for (const minutes of [0, 1, 60]) {
    const out = await run({ now: now + minutes * minute, readPrs: () => rows, readPrevious: () => previous });
    expect(out.errors).toEqual([]);
    const decision = out.decisions.find(p => p.number === 12);
    expect(decision.blockedBy).toEqual([13]);
    expect(out.decisions[0]).toMatchObject({ number: 13, unblocks: [12] });
    expect(out.nextState.episodes[key].firstUnownedAt).toBe(now - 91 * minute);
    previous = out.nextState;
    alerts.push(...out.alerts.filter(a => a.key === key));
    if (minutes === 0) expect(alerts).toHaveLength(1);
  }
  expect(alerts).toHaveLength(1);
  expect(alerts[0].body).toContain('blocked-by #13');
});
it('edges cannot change invariant action, deadline, owner or violation, including tooling', () => {
  for (const daemons of [[], [1, 2].map(() => ({ kind: 'refusal', name: 'fix-dispatch-daemon', head: pr.headRefOid, at: now, reason: 'tool failure' }))]) {
    const options = { now, since: now - 121 * minute, settings: { ...settings, blockedWaitMinutes: 9999 }, daemons };
    expect(evaluateInvariant(pr, {}, { ...options, blockedBy: [13] })).toEqual(evaluateInvariant(pr, {}, options));
  }
});
const refusal = extra => ({ kind: 'refusal', name: 'fix-dispatch-daemon', reason: 'waiting on #13', head: pr.headRefOid, at: now - minute, ...extra });
it.each([
  ['month-old other head', { head: 'old', at: now - 30 * 1440 * minute }],
  ['other head', { head: 'old' }], ['expired', { at: now - 361 * minute }],
  ['missing timestamp', { at: undefined }], ['future', { at: now + minute }],
  ['unheaded before push', { head: undefined, at: now - 121 * minute }],
])('refusal dependencies reject %s evidence', (_name, extra) => {
  const map = buildBlockedMap([{ ...pr, daemons: [refusal(extra)] }, blocker], { now, settings });
  expect(map.blockedBy.get(12)).toEqual([]);
  expect(map.unblocks.get(13)).toBeUndefined();
});
it('refusal dependencies share the tooling recency override and owner progress guards', () => {
  const prs = [{ ...pr, daemons: [refusal({})] }, blocker];
  expect(buildBlockedMap(prs, { now, settings }).blockedBy.get(12)).toEqual([13]);
  expect(buildBlockedMap(prs, { now, settings: { toolingRefusalWindowMinutes: 0.5 } }).blockedBy.get(12)).toEqual([]);
  expect(buildBlockedMap(prs, { now, settings, owners: { [key]: { state: 'active', ownerLastSeenAt: now } } }).blockedBy.get(12)).toEqual([]);
  expect(buildBlockedMap(prs, { now, settings, owners: { [key]: { state: 'active', ownerLastSeenAt: now - 2 * minute } } }).blockedBy.get(12)).toEqual([13]);
});
it('unstructured refusal strings without head/time evidence cannot create edges', () => {
  expect(buildBlockedMap([{ ...pr, refusalReason: 'waiting on #13', fixDaemonRefusalReason: 'blocked by #13' }, blocker], { now, settings }).blockedBy.get(12)).toEqual([]);
});
it.each([['sweep', false], ['detector', false], ['sweep', true], ['detector', true]])('deadline-passed merges into the %s finding with edge=%s without losing evidence or remediation', async (source, edge) => {
  const finding = { repo: pr.repo, pr: 12, head: pr.headRefOid, lane: 'operator', state: 'existing-state', reason: 'specific reason', evidence: ['specific evidence'], command: 'repair-command', action: 'repair action', remediation: { command: 'specific remediation' }, tags: ['existing'] };
  let items;
  const out = await run({ dryRun: false, readPrs: () => [{ ...pr, stateSince: now - 121 * minute, ...(edge ? { body: 'Blocked-by: #13' } : {}) }, ...(edge ? [blocker] : [])],
    persist: () => {}, append: () => {}, flush: () => {}, notify: () => ({ ok: true }),
    stallSweep: async () => ({ mode: 'shadow', dir: 'unused', items: source === 'sweep' ? [finding] : [] }),
    detector: async () => ({ enabled: true, items: source === 'detector' ? [finding] : [], errors: [], nextSeen: {} }),
    stallDigest: pass => { items = pass.items; return { lines: [], fresh: [], errors: [] }; } });
  expect(out.errors).toEqual([]);
  expect(items.filter(p => p.pr === 12)).toHaveLength(1);
  expect(items.find(p => p.pr === 12)).toMatchObject({ ...finding, owner: 'daemon:review-daemon', nextAction: 'await-review', deadline: new Date(now - 31 * minute).toISOString(), violation: 'deadline-passed' });
});
it('invariants stand alone when the existing finding names a different head', async () => {
  let items;
  const out = await run({ dryRun: false, readPrs: () => [{ ...pr, stateSince: now - 121 * minute }],
    persist: () => {}, append: () => {}, flush: () => {}, notify: () => ({ ok: true }),
    stallSweep: async () => ({ mode: 'shadow', dir: 'unused', items: [{ repo: pr.repo, pr: 12, head: 'old', reason: 'old finding', lane: 'operator' }] }),
    stallDigest: pass => { items = pass.items; return { lines: [], fresh: [], errors: [] }; } });
  expect(out.errors).toEqual([]);
  expect(items).toHaveLength(2);
  expect(items.find(p => p.head === 'old').reason).toBe('old finding');
  expect(items.find(p => p.head === pr.headRefOid)).toMatchObject({ violation: 'deadline-passed', nextAction: 'await-review' });
});

it('new episodes start and alert on the same ticks with or without an edge', async () => {
  let plain = {}, annotated = {};
  for (const minutes of [0, 45, 91, 92]) {
    const baseline = await run({ now: now + minutes * minute, readPrevious: () => plain });
    const linked = await run({ now: now + minutes * minute, readPrevious: () => annotated, readPrs: () => [pr, { ...blocker, body: 'Unblocks: #12' }] });
    expect(linked.errors).toEqual([]);
    expect(linked.nextState.episodes[key]).toEqual(baseline.nextState.episodes[key]);
    expect(linked.alerts.filter(a => a.key === key).length).toBe(baseline.alerts.length);
    if (minutes === 91) expect(linked.alerts.find(a => a.key === `${pr.repo}#13`).body).toContain('unblocks #12');
    plain = baseline.nextState; annotated = linked.nextState;
  }
});
it.each(['old-head', 'new-progress', 'current'])('shell applies shared refusal edge evidence checks for %s', async mode => {
  const out = await run({ readPrs: () => [pr, blocker], readSignals: () => ({ [key]: {
    daemons: [refusal(mode === 'old-head' ? { head: 'old' } : {}), ...(mode === 'new-progress' ? [{ kind: 'progress', name: 'review', at: now }] : [])],
  } }) });
  expect(out.errors).toEqual([]);
  expect(out.decisions.find(p => p.number === 12).blockedBy).toEqual(mode === 'current' ? [13] : []);
});
it('refusal dependencies accept recent unheaded evidence only after the head push time', () => {
  const rows = [{ ...pr, headPushedAt: now - 2 * minute, daemons: [refusal({ head: undefined })] }, blocker];
  expect(buildBlockedMap(rows, { now, settings }).blockedBy.get(12)).toEqual([13]);
  rows[0].headPushedAt = now;
  expect(buildBlockedMap(rows, { now, settings }).blockedBy.get(12)).toEqual([]);
});

it('annotation-only edges do not manufacture invariant stall findings for active PRs', async () => {
  let items;
  const out = await run({ dryRun: false, readPrs: () => [pr, { ...blocker, body: 'Unblocks: #12' }],
    readSignals: () => Object.fromEntries([12, 13].map(n => [`${pr.repo}#${n}`, { daemons: [{ kind: 'progress', name: 'review', at: now }] }])),
    persist: () => {}, append: () => {}, flush: () => {}, notify: () => ({ ok: true }),
    stallSweep: async () => ({ mode: 'shadow', dir: 'unused', items: [] }),
    stallDigest: pass => { items = pass.items; return { lines: [], fresh: [], errors: [] }; } });
  expect(out.errors).toEqual([]);
  expect(out.alerts).toEqual([]);
  expect(out.decisions[0]).toMatchObject({ number: 13, unblocks: [12] });
  expect(out.decisions[1]).toMatchObject({ number: 12, blockedBy: [13] });
  expect(items).toEqual([]);
});
