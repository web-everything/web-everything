import { it, expect } from 'vitest';
import { AUTOMATION_LOGINS } from '../../lib/marker-authorship.mjs';
import { buildBlockedMap } from '../pr-blocked-by.mjs';
import { evaluateInvariant, stateFingerprint, resolveOwner, sessionActivity } from '../pr-sweep-core.mjs';
import { createOpenPrCommentReader } from '../pr-comments-complete.mjs';
import { runPrSweep, resolvePrSweepSettings } from '../pr-sweep.mjs';
const now = Date.parse('2026-11-02T16:00:00Z'), minute = 60000;
const pr = { repo: 'web-everything/web-everything', number: 12, title: 'audit', author: { login: 'contributor' }, headRefOid: 'a'.repeat(40), updatedAt: new Date(now - 120 * minute).toISOString(), labels: ['review:pending'], changedFiles: 5 };
const key = `${pr.repo}#12`;
const settings = { repos: [pr.repo], idleMinutes: 45, stuckAfterMinutes: 90, stuckAlertMinutes: 90, alertBackoffMinutes: [30,60,120,240] };
const run = extra => runPrSweep({ now, dryRun: true, env: {}, settings: { value: settings, sources: {} }, readPrs: () => [pr], readPrevious: () => ({}), readQueue: () => ({ ready: [], rulingNeeded: [] }), readSignals: () => ({}), detector: async () => ({ enabled: false, items: [], errors: [], nextSeen: {} }), ...extra });
it.each([undefined, 'stranger', ''])('ignores unauthorized or unknown comment author %j', login => {
  const map = buildBlockedMap([{ ...pr, comments: [{ body: 'depends on #13', author: { login } }, 'blocked by #13'] }, { number: 13 }]);
  expect(map.blockedBy.get(12)).toEqual([]);
});
it.each(['contributor', 'chalbert', AUTOMATION_LOGINS[0]])('accepts dependency comments from PR author or trusted principal %s', login => {
  expect(buildBlockedMap([{ ...pr, comments: [{ body: 'blocked by #13', author: { login } }] }, { number: 13 }]).blockedBy.get(12)).toEqual([13]);
});
it('drops all cycle edges while retaining external dependencies and reverse links', () => {
  const map = buildBlockedMap([{ number: 1, body: 'blocked by #2; blocked by #4' }, { number: 2, body: 'blocked by #3' }, { number: 3, body: 'blocked by #1' }, { number: 4 }]);
  expect([...map.blockedBy]).toEqual([[1, [4]], [2, []], [3, []], [4, []]]);
  expect([...map.unblocks]).toEqual([[4, [1]]]);
  const pair = buildBlockedMap([{ number: 1, body: 'blocked by #2' }, { number: 2, body: 'blocked by #1' }]);
  expect([...pair.blockedBy.values()]).toEqual([[], []]);
  expect([...pair.unblocks]).toEqual([]);
});
it('preserves the stall clock and normal repeat backoff while a blocker is annotated', async () => {
  const episode = { head: pr.headRefOid, updatedAt: pr.updatedAt, fingerprint: stateFingerprint(pr), firstUnownedAt: now - 200 * minute, alerted: true, lastAlertAt: now - 60 * minute, alertCount: 1 };
  const previous = { episodes: { [key]: episode }, invariantClocks: { [key]: { fingerprint: stateFingerprint(pr), since: now } } };
  const readPrs = () => [{ ...pr, body: 'blocked by #13' }, { ...pr, number: 13 }];
  const waiting = await run({ readPrs, readPrevious: () => previous });
  expect(waiting.nextState.episodes[key]).toEqual({ ...episode, lastAlertAt: now, alertCount: 2 });
  expect(waiting.alerts.filter(a => a.key === key)).toHaveLength(1);
  const expired = await run({ now: now + 481 * minute, readPrs, readPrevious: () => waiting.nextState });
  expect(expired.decisions.find(p => p.number === 12)).toMatchObject({ violation: 'deadline-passed', blockedBy: [13], nextAction: 'await-review' });
  expect(expired.nextState.episodes[key].firstUnownedAt).toBe(episode.firstUnownedAt);
  expect(expired.alerts).toContainEqual(expect.objectContaining({ key, kind: 'pr-stuck' }));
});
it('a blocker annotation does not create a false stall for an active owner', async () => {
  const out = await run({ readPrs: () => [{ ...pr, body: 'blocked by #13', stateSince: now - 481 * minute }, { ...pr, number: 13 }], readSignals: () => ({ [key]: { daemons: [{ name: 'review', kind: 'progress', at: now }] } }) });
  expect(out.alerts.filter(a => a.key === key)).toEqual([]);
  expect(out.nextState.episodes[key]).toBeUndefined();
});
it.each(['sweep', 'detector'])('unblocks-only annotations preserve the %s finding and remediation', async source => {
  const finding = { repo: pr.repo, pr: 12, head: pr.headRefOid, lane: 'operator', state: 'stalled-head', reason: 'existing operator finding', action: 'repair existing problem', nextAction: 'retain remediation', tags: ['existing'] };
  let published;
  const out = await run({ dryRun: false, readPrs: () => [{ ...pr, body: 'Unblocks: #13' }, { ...pr, number: 13 }],
    readSignals: () => ({ [key]: { daemons: [{ name: 'review', kind: 'progress', at: now }] } }),
    persist: () => {}, append: () => {}, flush: () => {}, notify: () => ({ ok: true }),
    stallSweep: async () => ({ mode: 'shadow', dir: 'unused', items: source === 'sweep' ? [finding] : [] }),
    detector: async () => ({ enabled: true, items: source === 'detector' ? [finding] : [], errors: [], nextSeen: {} }),
    stallDigest: pass => { published = pass.items; return { lines: [], fresh: [], errors: [] }; } });
  expect(out.errors).toEqual([]);
  expect(published.filter(p => p.pr === 12)).toEqual([expect.objectContaining({ ...finding, unblocks: [13], blockedBy: [] })]);
});
const refusal = extra => ({ name: 'fix-dispatch-daemon', kind: 'refusal', reason: 'dispatch tooling failure', at: now - minute, ...extra });
it.each([
  ['old head', { head: 'old' }], ['old window', { head: pr.headRefOid, at: now - 361 * minute }],
  ['unheaded before push', { at: now - 121 * minute }], ['missing timestamp', { at: undefined }], ['future timestamp', { at: now + minute }],
])('does not count tooling refusals with %s', (_name, extra) => {
  expect(evaluateInvariant(pr, {}, { now, daemons: [refusal(extra), refusal(extra)] }).owner).not.toBe('tooling');
});
it('accepts current-head recent refusals predating updatedAt and newer unheaded refusals', () => {
  for (const extra of [{ head: pr.headRefOid, at: now - 180 * minute }, { at: now - minute }]) {
    expect(evaluateInvariant(pr, {}, { now, daemons: [refusal(extra), refusal(extra)] }).owner).toBe('tooling');
  }
});
it('uses head push time ahead of updatedAt for unheaded refusals', () => {
  expect(evaluateInvariant({ ...pr, headPushedAt: now - minute }, {}, { now, daemons: [refusal({ at: now - 2 * minute }), refusal({ at: now - 2 * minute })] }).owner).not.toBe('tooling');
});
it('newer active owner progress supersedes repeated tooling refusals', () => {
  const daemons = [refusal({}), refusal({})];
  expect(evaluateInvariant(pr, { state: 'active', ownerLastSeenAt: now }, { now, daemons }).owner).not.toBe('tooling');
  expect(evaluateInvariant(pr, { state: 'active', ownerLastSeenAt: now - 2 * minute }, { now, daemons }).owner).toBe('tooling');
});
it('new bounds resolve defaults, overrides, invalid fallback and provenance', () => {
  const logs = [];
  const defaults = resolvePrSweepSettings({ env: {}, log: line => logs.push(line) });
  expect(defaults.value).toMatchObject({ toolingRefusalWindowMinutes: 360 });
  expect(defaults.value).not.toHaveProperty('blockedWaitMinutes');
  for (const [name, envName] of [['toolingRefusalWindowMinutes', 'TOOLING_REFUSAL_WINDOW_MINUTES']]) {
    const resolved = resolvePrSweepSettings({ env: { [`WE_PR_SWEEP_${envName}`]: '10' }, log: () => {} });
    expect(resolved.value[name]).toBe(10); expect(resolved.sources[name]).toBe('env');
    const invalid = resolvePrSweepSettings({ env: { [`WE_PR_SWEEP_${envName}`]: '0' }, log: () => {} });
    expect(invalid.errors.join(' ')).toContain(name);
    expect(logs.join(' ')).toContain(name);
  }
  expect(evaluateInvariant(pr, {}, { now, since: now - 11 * minute, blockedBy: [13], settings: { blockedWaitMinutes: 10 } }))
    .toEqual(evaluateInvariant(pr, {}, { now, since: now - 11 * minute }));
  expect(evaluateInvariant(pr, {}, { now, daemons: [refusal({ at: now - 11 * minute }), refusal({ at: now - 11 * minute })], settings: { toolingRefusalWindowMinutes: 10 } }).owner).not.toBe('tooling');
});

it('requests PR authors so owner-authored dependency comments survive discovery', () => {
  const read = createOpenPrCommentReader({ exec: (_bin, args) => {
    expect(args[args.indexOf('--json') + 1].split(',')).toContain('author');
    return JSON.stringify([{ ...pr, comments: [{ body: 'blocked by #13', author: pr.author }] }, { ...pr, number: 13, comments: [] }]);
  } });
  expect(buildBlockedMap(read(pr.repo)).blockedBy.get(12)).toEqual([13]);
});
it('retries an unsent scheduled alert with a blocker annotation using the unchanged backoff', async () => {
  const row = { ...pr, body: 'blocked by #13', stateSince: now - 481 * minute };
  const episode = { head: pr.headRefOid, updatedAt: pr.updatedAt, fingerprint: stateFingerprint(pr), firstUnownedAt: now - 600 * minute, alerted: true, lastAlertAt: now - 241 * minute, alertCount: 4, blockedExpiryAlerted: true };
  const failed = await run({ dryRun: false, readPrs: () => [row, { ...pr, number: 13 }], readPrevious: () => ({ episodes: { [key]: episode } }),
    notify: () => ({ ok: false, error: 'injected failure' }), flush: () => {}, persist: () => {}, append: () => {}, stallSweep: () => ({ mode: 'off' }) });
  expect(failed.alerts).toContainEqual(expect.objectContaining({ key }));
  expect(failed.nextState.episodes[key].lastAlertAt).toBe(episode.lastAlertAt);
  expect((await run({ readPrs: () => [row, { ...pr, number: 13 }], readPrevious: () => failed.nextState })).alerts).toContainEqual(expect.objectContaining({ key }));
});

// A broken thread must not turn a readable repository listing into a global outage.
it.each(['oversized', 'unreadable', 'missing', 'malformed'])('isolates %s comment evidence to its PR and keeps other repositories alerting', async mode => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: `IC_${i}`, body: 'blocked by #13', author: pr.author }));
  const otherRepo = 'frontierui/frontierui';
  const read = createOpenPrCommentReader({ maxPages: 1, exec: (_bin, args) => {
    if (args[0] === 'pr') return JSON.stringify(args.includes(otherRepo) ? [{ ...pr, number: 14, comments: [] }] : [
      { ...pr, body: 'blocked by #15', comments: mode === 'missing' ? undefined : mode === 'malformed' ? [{ body: null }] : rows },
      { ...pr, number: 13, comments: [] }, { ...pr, number: 15, comments: [] },
    ]);
    if (mode === 'unreadable') throw Error('injected thread failure');
    return JSON.stringify(rows);
  } });
  const discovered = read(pr.repo);
  expect(discovered.map(p => p.number)).toEqual([12, 13, 15]);
  expect(discovered[0]).toMatchObject({ commentsComplete: false, comments: [], commentsError: expect.stringMatching(/operator.*full thread/i) });
  expect(buildBlockedMap(discovered).blockedBy.get(12)).toEqual([15]);
  const previous = { episodes: Object.fromEntries([[pr.repo, 13], [otherRepo, 14]].map(([repo, number]) => [`${repo}#${number}`, {
    head: pr.headRefOid, updatedAt: pr.updatedAt, fingerprint: stateFingerprint(pr), firstUnownedAt: now - 300 * minute, alerted: false,
  }])) };
  const out = await run({ settings: { value: { ...settings, repos: [pr.repo, otherRepo] }, sources: {} }, readPrs: read, readPrevious: () => previous });
  expect(out.decisions).toHaveLength(4);
  expect(out.errors.join(' ')).toMatch(/PR #12.*comments incomplete.*operator/i);
  for (const key of [`${pr.repo}#13`, `${otherRepo}#14`]) expect(out.alerts).toContainEqual(expect.objectContaining({ key, kind: 'pr-stuck' }));
});

it('never trusts partial comments explicitly marked incomplete, while retaining body dependencies', () => {
  const map = buildBlockedMap([{ ...pr, commentsComplete: false, body: 'blocked by #15',
    comments: [{ body: 'blocked by #13', author: pr.author }] }, { number: 13 }, { number: 15 }]);
  expect(map.blockedBy.get(12)).toEqual([15]);
  expect(map.unblocks.get(13)).toBeUndefined();
});


it.each(['system', 'policy', 'operator'])('publishes no-labels invariant despite a same-head %s finding', async lane => {
  const finding = { repo: pr.repo, pr: pr.number, head: pr.headRefOid.toUpperCase(), lane,
    state: 'existing', action: 'existing remediation', reason: 'existing evidence' };
  let published;
  const out = await run({ dryRun: false, readPrs: () => [{ ...pr, labels: [] }],
    persist: () => {}, append: () => {}, flush: () => {}, notify: () => ({ ok: true }),
    stallSweep: () => ({ mode: 'shadow', dir: 'unused', items: [finding] }),
    stallDigest: pass => { published = pass.items; return {}; } });
  expect(out.errors).toEqual([]);
  expect(published.filter(p => p.lane === 'operator')).toEqual([
    expect.objectContaining({ repo: pr.repo, pr: pr.number, violation: 'no-labels' }),
  ]);
  if (lane === 'operator') expect(published).toEqual([expect.objectContaining({ ...finding, violation: 'no-labels' })]);
  else expect(published.find(p => p.lane === lane)).toMatchObject(finding);
});

it('exhausted global comment budget retains all PRs and later repository movement alerts', async () => {
  const otherRepo = 'plateauapp/plateau-app';
  const comments = Array.from({ length: 100 }, (_, i) => ({ id: `IC_${i}`, body: 'blocked by #99', author: pr.author }));
  let listingCalls = 0, commentCalls = 0;
  const read = createOpenPrCommentReader({ exec: (_bin, args) => {
    if (args[0] === 'pr') {
      listingCalls++;
      return JSON.stringify(args.includes(otherRepo) ? [{ ...pr, number: 99, comments: [] }] : [
        ...Array.from({ length: 13 }, (_, i) => ({ ...pr, number: i + 1, comments })),
        { ...pr, number: 99, comments: [] },
      ]);
    }
    commentCalls++;
    return JSON.stringify(comments);
  } });
  const previous = { episodes: Object.fromEntries([pr.repo, otherRepo].map(repo => [`${repo}#99`, {
    head: pr.headRefOid, updatedAt: pr.updatedAt, fingerprint: stateFingerprint(pr), firstUnownedAt: now - 300 * minute, alerted: false,
  }])) };
  const out = await run({ settings: { value: { ...settings, repos: [pr.repo, otherRepo] }, sources: {} },
    readPrs: read, readPrevious: () => previous });
  expect(listingCalls).toBe(2);
  expect(commentCalls).toBe(128);
  expect(out.decisions).toHaveLength(15);
  expect(out.errors.join(' ')).toMatch(/PR #13.*budget.*operator.*full thread/i);
  expect(out.decisions.filter(p => p.number !== 99).every(p => p.blockedBy.length === 0)).toBe(true);
  for (const repo of [pr.repo, otherRepo]) expect(out.alerts).toContainEqual(expect.objectContaining({ key: `${repo}#99`, kind: 'pr-stuck' }));
});


it.each([{}, { owner: 'session:fix-12', state: 'active' }, { owner: 'operator', state: 'waiting-operator' }])
('unlabelled PR restoration belongs to the fix daemon until the label deadline: %j', owner => {
  const row = { ...pr, labels: [] };
  const deadline = now + 45 * minute;
  for (const tick of [now, deadline]) expect(evaluateInvariant(row, owner, { now: tick, since: now }))
    .toMatchObject({ owner: 'daemon:fix-daemon', nextAction: 'restore-review-label', violation: 'no-labels', deadline: new Date(deadline).toISOString() });
  expect(evaluateInvariant(row, owner, { now: deadline + 1, since: now }))
    .toMatchObject({ owner: 'operator', nextAction: 'restore-review-label', violation: 'no-labels' });
});
it('review-label restoration preserves configured label budgets and escalates overdue persisted state', async () => {
  const row = { ...pr, labels: [] };
  const previous = { invariantClocks: { [key]: { fingerprint: stateFingerprint(row), since: now - 46 * minute } } };
  const out = await run({ readPrs: () => [row], readPrevious: () => previous });
  expect(out.decisions[0]).toMatchObject({ owner: 'operator', nextAction: 'restore-review-label', violation: 'no-labels' });
  expect(evaluateInvariant(row, {}, { now, since: now, settings: { deadlineMinutes: { label: 75 } } }))
    .toMatchObject({ owner: 'daemon:fix-daemon', nextAction: 'restore-review-label', deadline: new Date(now + 75 * minute).toISOString() });
});


it.each([minute + 1, 4 * minute, 24 * 60 * minute])('ignores daemon progress beyond one-minute skew: %s ms', offset => {
  const future = { name: 'review', kind: 'progress', at: now + offset };
  expect(resolveOwner(pr, { now, daemons: [future] })).toMatchObject({ state: 'none', owner: null, ownerLastSeenAt: null });
  const past = { name: 'fix-dispatch-daemon', kind: 'progress', at: now - 100 * minute };
  expect(resolveOwner(pr, { now, daemons: [past, future] }))
    .toMatchObject({ state: 'stuck', owner: 'daemon:fix-dispatch-daemon', ownerLastSeenAt: new Date(past.at).toISOString() });
  expect(evaluateInvariant(pr, { state: 'active', owner: 'daemon:review', ownerLastSeenAt: new Date(future.at).toISOString() }, { now, since: now }))
    .toMatchObject({ violation: 'owner-stale' });
});
it.each([-minute, 0, minute])('retains ordinary progress and tolerated clock skew: %s ms', offset => {
  const at = now + offset;
  const owner = resolveOwner(pr, { now, daemons: [{ name: 'review', at }] });
  expect(owner).toMatchObject({ state: 'active', owner: 'daemon:review' });
  expect(evaluateInvariant(pr, owner, { now, since: now }).violation).toBeNull();
  expect(sessionActivity({ state: 'working', pidAlive: true, lastActivityAt: at }, now)).toBe('yes');
});
it('future session activity/start cannot grant ownership but valid past evidence still can', () => {
  const session = { name: 'fix-12', state: 'working', pidAlive: true, lastActivityAt: now + 24 * 60 * minute, startedAt: now + 24 * 60 * minute };
  expect(sessionActivity(session, now)).toBe('no');
  expect(sessionActivity({ ...session, activityUnknown: true }, now)).toBe('no');
  expect(resolveOwner(pr, { now, sessions: [session] })).toMatchObject({ state: 'none', owner: null });
  expect(sessionActivity({ ...session, startedAt: now - minute }, now)).toBe('yes');
  expect(sessionActivity({ ...session, lastActivityAt: now - minute }, now)).toBe('yes');
  expect(sessionActivity({ ...session, startedAt: now - 60 * minute, activityUnknown: true }, now)).toBe('unknown');
});
it.each(['daemon', 'session'])('tomorrow-dated %s evidence cannot suppress invariant or movement alerts', async kind => {
  let previous = {};
  const future = now + 24 * 60 * minute;
  const signals = kind === 'daemon' ? { daemons: [{ name: 'review', at: future }] }
    : { sessions: [{ name: 'fix-12', state: 'working', pidAlive: true, startedAt: future, lastActivityAt: future }] };
  const tick = async minutes => {
    const out = await run({ now: now + minutes * minute, readPrevious: () => previous, readSignals: () => ({ [key]: signals }) });
    previous = out.nextState;
    expect(out.errors).toEqual([]);
    expect(out.idle[0]).toMatchObject({ state: 'none', owner: null });
    return out;
  };
  await tick(0);
  expect((await tick(46)).decisions[0].violation).toBe('owner-stale');
  const overdue = await tick(91);
  expect(overdue.decisions[0].violation).toBe('deadline-passed');
  expect(overdue.alerts).toContainEqual(expect.objectContaining({ key, kind: 'pr-stuck' }));
});


it.each(['active', 'waiting-operator'])('invariant rejects a future last-seen timestamp even for a supplied %s owner', state => {
  expect(evaluateInvariant(pr, { state, owner: 'daemon:review', ownerLastSeenAt: now + 24 * 60 * minute }, { now, since: now }))
    .toMatchObject({ violation: 'owner-stale' });
});
