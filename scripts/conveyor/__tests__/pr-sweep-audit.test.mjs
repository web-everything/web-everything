import { it, expect } from 'vitest';
import { AUTOMATION_LOGINS } from '../../lib/marker-authorship.mjs';
import { buildBlockedMap } from '../pr-blocked-by.mjs';
import { evaluateInvariant, stateFingerprint } from '../pr-sweep-core.mjs';
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
