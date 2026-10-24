/** @file Regression contract for same-head stalls, settings provenance, and sweep publication. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DETECTOR_DEFAULTS, REMEDIES, detectStalls, normalizeReason, resolveDetectorSettings, runDetector,
} from '../pr-stall-detector.mjs';
import { collectOwnerSignals, runPrSweep } from '../pr-sweep.mjs';
import { publishStalledDigest } from '../pr-stall-digest.mjs';
import { replay } from '../../operations/needs-you-feed.mjs';

// runDetector has no settings-reader argument. Keep its real settings resolver while
// replacing only its file inputs; integration passes inject every sweep write seam.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, readFileSync: (path, ...args) => {
    if (String(path).endsWith('scripts/settings/pr-stall-sweep.json')
      || String(path) === 'fixture/platform-preferences.json') return '{}';
    return actual.readFileSync(path, ...args);
  } };
});
afterEach(() => vi.restoreAllMocks());

const REPO = 'web-everything/web-everything';
const HEAD = 'abcdef0123'.repeat(4);
const NOW = Date.parse('2026-10-23T19:00:00Z');
const MINUTE = 60_000;
const LABEL = 'red-team:pending';
const REASON = 'review:human, no review dispatched — already-reviewed-head: referral hold auto-resolved';
const PR_KEY = `${REPO}#5759`;
const key = (label = LABEL, head = HEAD) => `${PR_KEY}@${head}|${label}`;
const pr = (patch = {}) => ({ repo: REPO, number: 5759, title: 'Referral hold', headRefOid: HEAD,
  labels: [{ name: LABEL }], ...patch });
const settings = (patch = {}) => ({ ...DETECTOR_DEFAULTS, ...patch });
const env = (patch = {}) => ({ WE_PLATFORM_PREFERENCES_FILE: 'fixture/platform-preferences.json',
  WE_PR_STALL_DETECTOR_ENABLED: 'true', WE_PR_STALL_DETECTOR_SAME_LABEL_MINUTES: '60',
  WE_PR_STALL_DETECTOR_REPEATED_REASON_COUNT: '5', ...patch });
const skips = (count, { reason = REASON, start = NOW - 18 * MINUTE } = {}) => Array.from({ length: count }, (_, i) => ({
  name: 'review-daemon', at: new Date(start + i * 3 * MINUTE).toISOString(), kind: 'refusal', reason,
}));
const detect = (patch = {}) => detectStalls({ prs: [pr()], daemons: {}, seen: {}, now: NOW, settings: settings(), ...patch });
const settingsRead = (tool = {}, platform = {}) => path => JSON.stringify({
  prStallDetector: String(path).endsWith('pr-stall-sweep.json') ? tool : platform,
});

describe('detector settings', () => {
  it('defines the specified enabled defaults and blocking labels', () => {
    expect(DETECTOR_DEFAULTS).toEqual({ enabled: true, sameLabelMinutes: 60, repeatedReasonCount: 5,
      blockingLabels: ['red-team:pending', 'review:pending', 'status:fixing'] });
    const out = resolveDetectorSettings({ env: {}, read: settingsRead(), log: () => {} });
    expect(out.value).toEqual(DETECTOR_DEFAULTS);
    for (const leaf of Object.keys(DETECTOR_DEFAULTS)) expect(out.sources[leaf]).toBe('standard');
  });

  it('cascades standard -> platform -> tool -> env and logs each value and source in one line', () => {
    const read = settingsRead({ sameLabelMinutes: 90 }, { sameLabelMinutes: 120, repeatedReasonCount: 8 });
    const log = vi.fn();
    const out = resolveDetectorSettings({ env: env({ WE_PR_STALL_DETECTOR_SAME_LABEL_MINUTES: '30' }), read, log });
    expect(out).toMatchObject({ value: { sameLabelMinutes: 30, repeatedReasonCount: 5 },
      sources: { sameLabelMinutes: 'env', repeatedReasonCount: 'env' }, errors: [] });
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0].join(' ');
    expect(line).toMatch(/prStallDetector/);
    expect(line).toMatch(/sameLabelMinutes[^\n]*30[^\n]*env/);
    for (const leaf of Object.keys(DETECTOR_DEFAULTS)) expect(line).toContain(leaf);
    const tool = resolveDetectorSettings({ env: {}, read, log: () => {} });
    expect(tool).toMatchObject({ value: { sameLabelMinutes: 90, repeatedReasonCount: 8 },
      sources: { sameLabelMinutes: 'tool', repeatedReasonCount: 'platform', enabled: 'standard' } });
    expect(resolveDetectorSettings({ env: {}, read: settingsRead({}, { sameLabelMinutes: 120 }), log: () => {} }))
      .toMatchObject({ value: { sameLabelMinutes: 120 }, sources: { sameLabelMinutes: 'platform' } });
    // The resolved override changes behavior, not just the reported configuration.
    expect(detect({ seen: { [key()]: NOW - 31 * MINUTE }, settings: out.value }).items).toHaveLength(1);
    expect(detect({ seen: { [key()]: NOW - 31 * MINUTE } }).items).toEqual([]);
  });

  it.each([
    ['SAME_LABEL_MINUTES', 'sameLabelMinutes'], ['REPEATED_REASON_COUNT', 'repeatedReasonCount'],
  ])('invalid %s falls back to standard with a named error', (suffix, leaf) => {
    for (const invalid of ['0', '-1', '1.5', 'NaN', 'Infinity', 'bogus']) {
      const out = resolveDetectorSettings({ env: env({ [`WE_PR_STALL_DETECTOR_${suffix}`]: invalid }),
        read: settingsRead({ [leaf]: 99 }, { [leaf]: 88 }), log: () => {} });
      expect(out.value[leaf], invalid).toBe(DETECTOR_DEFAULTS[leaf]);
      expect(out.errors.join(' '), invalid).toMatch(new RegExp(`${leaf}|${suffix}`));
    }
  });

  it.each(['sameLabelMinutes', 'repeatedReasonCount'])('rejects invalid file values for %s without throwing', leaf => {
    for (const invalid of [0, -1, 1.5, null, {}, [], 'bad']) {
      const out = resolveDetectorSettings({ env: {}, read: settingsRead({ [leaf]: invalid }), log: () => {} });
      expect(out.value[leaf]).toBe(DETECTOR_DEFAULTS[leaf]);
      expect(out.errors.join(' ')).toContain(leaf);
    }
  });

  it('reports unreadable settings without throwing', () => {
    const out = resolveDetectorSettings({ env: {}, read: () => { throw new Error('settings unreadable'); }, log: () => {} });
    expect(out.errors.join(' ')).toMatch(/unreadable/);
  });
});

describe('reason normalization and remedies', () => {
  it('strips bracketed or bare ISO timestamps and collapses digit runs, case, and whitespace', () => {
    const a = normalizeReason('[2026-10-23T10:00:00Z] REVIEW-daemon: PR 5759   already-reviewed-head attempt 123');
    const b = normalizeReason('2026-10-23T19:00:00Z review-daemon: pr 42 already-reviewed-head attempt 9');
    expect(a).toBe(b);
    expect(a).toMatch(/^review-daemon: pr /);
    expect(a).toBe(a.toLowerCase());
    expect(a).not.toMatch(/\s{2,}/);
    expect(normalizeReason('A'.repeat(300))).toBe('a'.repeat(160));
  });

  it('puts the already-reviewed-head red-team remedy first', () => {
    expect(REMEDIES[0].match).toBeInstanceOf(RegExp);
    expect(REMEDIES[0].match.test(REASON)).toBe(true);
    expect(REMEDIES[0]).toMatchObject({ label: LABEL,
      remedy: 'red-team-on-skip not live on review daemon (load scripts/lib/review-red-team-on-skip.mjs via prototype-load)' });
  });

  it.each([
    ['review:pending', 'review daemon not dispatching: check review-daemon log / lane availability'],
    ['status:fixing', 'fix claim has no live job: check fix-dispatch-daemon'],
    [LABEL, 'red team never ran: check red-team gate'],
    ['custom:pending', 'inspect daemon log for the repeating reason'],
  ])('selects the generic remedy for %s', (label, remedy) => {
    const out = detect({ prs: [pr({ labels: [label] })], settings: settings({ blockingLabels: [label] }),
      seen: { [key(label)]: NOW - 61 * MINUTE }, daemons: { [PR_KEY]: skips(2, { reason: 'waiting for a worker' }) } });
    expect(out.items[0].remedy).toBe(remedy);
  });
});

describe('detectStalls', () => {
  it('same-head same-label over threshold yields one operator item with PR, head, label, minutes, repeating reason, and remedy', () => {
    const out = detect({ prs: [pr({ headRefOid: HEAD.toUpperCase() })],
      seen: { [key()]: NOW - 90 * MINUTE }, daemons: { [PR_KEY]: skips(2) } });
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ lane: 'operator', repo: REPO, pr: 5759, head: HEAD,
      state: 'stalled-same-head', title: 'Referral hold', label: LABEL, stalledMinutes: 90,
      reason: `${LABEL} on same head 90 min; repeating: ${REASON}`, repeatingReason: REASON,
      repeatCount: 2, action: 'stalled-detector', command: `gh pr view 5759 --repo ${REPO} --comments` });
    expect(out.items[0].remedy).toContain('red-team-on-skip not live on review daemon');
    expect(out.items[0].evidence.length).toBeGreaterThan(0);
    expect(out.items[0].evidence.length).toBeLessThanOrEqual(3);
    expect(out.items[0].evidence.every(line => typeof line === 'string')).toBe(true);
    expect(out.nextSeen).toEqual({ [key()]: NOW - 90 * MINUTE });
  });

  it.each([59, 60])('under or exactly at the age threshold (%i min) yields none', minutes => {
    expect(detect({ seen: { [key()]: NOW - minutes * MINUTE } }).items).toEqual([]);
  });

  it('moved head resets age and drops the previous seen key', () => {
    const moved = 'b'.repeat(40);
    const out = detect({ prs: [pr({ headRefOid: moved })], seen: { [key()]: NOW - 540 * MINUTE } });
    expect(out.items).toEqual([]);
    expect(out.nextSeen).toEqual({ [key(LABEL, moved)]: NOW });
  });

  it('drops closed PRs and removed labels while preserving current first-seen values', () => {
    const since = NOW - 20 * MINUTE;
    const out = detect({ seen: { [key()]: since, [key('review:pending')]: since,
      [`${REPO}#42@${HEAD}|${LABEL}`]: since } });
    expect(out.nextSeen).toEqual({ [key()]: since });
    expect(detect({ prs: [], seen: out.nextSeen }).nextSeen).toEqual({});
  });

  it.each([[6, 1], [5, 0]])('%i identical skip lines under threshold age yields %i stalled item (strict K rule)', (count, expected) => {
    const out = detect({ seen: { [key()]: NOW - 20 * MINUTE }, daemons: { [PR_KEY]: skips(count) } });
    expect(out.items).toHaveLength(expected);
    if (expected) expect(out.items[0]).toMatchObject({ repeatCount: count, repeatingReason: REASON });
  });

  it('groups normalized non-progress reasons and selects the highest count', () => {
    const lines = skips(6).map((entry, i) => ({ ...entry, kind: i % 2 ? 'diagnostic' : 'refusal',
      reason: `[${entry.at}] ${REASON} attempt ${i + 100}` }));
    const out = detect({ daemons: { [PR_KEY]: [...skips(3, { reason: 'another reason' }), ...lines] } });
    expect(out.items[0]).toMatchObject({ repeatCount: 6, repeatingReason: lines[0].reason });
  });

  it.each(['refusal', 'diagnostic'])('accepts numeric epoch timestamps for %s signals without dropping a stalled PR', kind => {
    const out = detect({ seen: { [key()]: NOW - 90 * MINUTE }, daemons: { [PR_KEY]: [
      { name: 'fix-dispatch-daemon', at: NOW - MINUTE, kind, reason: REASON },
    ] } });
    expect(out.errors).toEqual([]);
    expect(out.items).toHaveLength(1);
    expect(out.nextSeen[key()]).toBe(NOW - 90 * MINUTE);
  });

  it('seeds age from the earliest repeating daemon ISO timestamp on a first pass', () => {
    const out = detect({ daemons: { [PR_KEY]: skips(2, { start: NOW - 120 * MINUTE }) } });
    expect(out.items[0].stalledMinutes).toBe(120);
    expect(out.nextSeen[key()]).toBe(NOW - 120 * MINUTE);
  });

  it('an unrelated old singleton reason does not seed repeating-reason age', () => {
    const out = detect({ daemons: { [PR_KEY]: [
      ...skips(1, { start: NOW - 540 * MINUTE, reason: 'one unrelated diagnostic' }), ...skips(2),
    ] } });
    expect(out.items).toEqual([]);
    expect(out.nextSeen[key()]).toBe(NOW - 18 * MINUTE);
  });

  it.each(['ISO', 'epoch'])('newer %s progress clears the K rule even if daemon entries are out of order', format => {
    const progress = { name: 'review-daemon', at: format === 'epoch' ? NOW : new Date(NOW).toISOString(), kind: 'progress' };
    expect(detect({ daemons: { [PR_KEY]: [progress, ...skips(6)] } }).items).toEqual([]);
  });

  it('older progress does not clear the K rule', () => {
    const progress = { name: 'review-daemon', at: new Date(NOW - 30 * MINUTE).toISOString(), kind: 'progress' };
    expect(detect({ daemons: { [PR_KEY]: [...skips(6), progress] } }).items).toHaveLength(1);
  });

  it('progress does not clear the independent same-label age rule', () => {
    expect(detect({ seen: { [key()]: NOW - 120 * MINUTE }, daemons: { [PR_KEY]: [
      ...skips(6), { name: 'review-daemon', at: new Date(NOW).toISOString(), kind: 'progress' },
    ] } }).items).toHaveLength(1);
  });

  it('dedupes per PR+head, choosing the longest-stalled blocking label', () => {
    const out = detect({ prs: [pr({ labels: ['review:pending', { name: LABEL }] })],
      seen: { [key('review:pending')]: NOW - 70 * MINUTE, [key()]: NOW - 90 * MINUTE } });
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ label: LABEL, stalledMinutes: 90 });
    expect(Object.keys(out.nextSeen)).toHaveLength(2);
  });

  it('bounds an oversized raw repeating reason at 200 characters and evidence at three strings', () => {
    const reason = `${REASON} ${'x'.repeat(2_000)}`;
    const out = detect({ daemons: { [PR_KEY]: skips(20, { reason, start: NOW - 60 * MINUTE }) } });
    expect(out.items[0].repeatingReason).toBe(reason.slice(0, 200));
    expect(out.items[0].evidence.length).toBeLessThanOrEqual(3);
    expect(out.items[0].remedy).toContain('red-team-on-skip not live on review daemon');
  });

  it('sanitizes daemon reasons before every report and notification field', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz012345';
    const reason = `${REASON}\x1b[31m\r\n\x00\u2028\u202e ${secret} --token="private value"`;
    const out = detect({ daemons: { [PR_KEY]: skips(6, { reason }) } });
    const item = out.items[0];
    for (const value of [item.reason, item.repeatingReason, ...item.evidence]) {
      expect(value).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
      expect(value).not.toContain(secret);
      expect(value).not.toContain('private value');
      expect(value).not.toContain('[31m');
    }
    expect(item.remedy).toContain('red-team-on-skip not live on review daemon');
  });

  it.each([null, undefined, {}, true, 'invalid', Infinity, NaN])('rejects unreadable daemon timestamp %j', at => {
    const out = detect({ daemons: { [PR_KEY]: [{ at, kind: 'refusal', reason: REASON }] } });
    expect(out.items).toEqual([]);
    expect(out.errors.join(' ')).toContain('unreadable daemon timestamp');
  });

  it.each([undefined, null, '', 'not-a-head', 'a'.repeat(39), 'g'.repeat(40)])('malformed head %j is skipped with an error', headRefOid => {
    const out = detect({ prs: [pr({ headRefOid })] });
    expect(out.items).toEqual([]);
    expect(out.nextSeen).toEqual({});
    expect(out.errors.join(' ')).toMatch(/5759/);
    expect(out.errors.join(' ')).toMatch(/head/i);
  });

  it.each([undefined, null, {}, 'red-team:pending'])('non-array labels %j are skipped with an error', labels => {
    const out = detect({ prs: [pr({ labels })] });
    expect(out.items).toEqual([]);
    expect(out.nextSeen).toEqual({});
    expect(out.errors.join(' ')).toMatch(/5759/);
    expect(out.errors.join(' ')).toMatch(/label/i);
  });

  it('an unreadable PR is skipped with an error while a valid PR is still evaluated', () => {
    const unreadable = pr({ number: 42 });
    Object.defineProperty(unreadable, 'labels', { get: () => { throw new Error('labels unreadable'); } });
    const out = detect({ prs: [unreadable, pr()], seen: { [key()]: NOW - 90 * MINUTE } });
    expect(out.items).toHaveLength(1);
    expect(out.items[0].pr).toBe(5759);
    expect(out.errors.join(' ')).toMatch(/42/);
    expect(out.errors.join(' ')).toMatch(/unreadable/);
  });

  it('does not mutate PRs, daemon entries, seen state, or settings', () => {
    const input = { prs: [pr()], daemons: { [PR_KEY]: skips(6) }, seen: { [key()]: NOW - 20 * MINUTE },
      now: NOW, settings: settings() };
    const before = structuredClone(input);
    detectStalls(input);
    expect(input).toEqual(before);
  });
});

describe('runDetector', () => {
  it.each(['health', 'log-T', 'log-space'])('accepts the collectOwnerSignals %s producer timestamp contract', async source => {
    const errors = [];
    const readSignals = args => collectOwnerSignals({ ...args, env: {}, errors,
      readAgents: () => [], cloneRoots: () => ['fixture-clone'], listLogs: () => ['review-daemon.log'],
      readHealth: () => source === 'health' ? { daemons: { 'fix-dispatch-daemon': {
        prRefusals: { 'we#5759': { at: NOW - MINUTE, reason: REASON } },
      } } } : {},
      readTail: () => source === 'health' ? '' : `[${new Date(NOW - MINUTE).toISOString().replace('T', source === 'log-space' ? ' ' : 'T')}] review-daemon: we#5759 not dispatched — ${REASON}` });
    const out = await runDetector({ prs: [pr(), pr({ number: 42 })], readSignals,
      seen: { [key()]: NOW - 90 * MINUTE }, now: NOW, env: env(), log: () => {} });
    expect(errors).toEqual([]);
    expect(out.errors).toEqual([]);
    expect(out.items).toMatchObject([{ pr: 5759, stalledMinutes: 90 }]);
    expect(out.nextSeen[`${REPO}#42@${HEAD}|${LABEL}`]).toBe(NOW);
  });

  it('preserves all saved clocks when the signals reader rejects', async () => {
    const seen = { [key()]: NOW - 90 * MINUTE };
    const out = await runDetector({ prs: [pr()], readSignals: async () => { throw new Error('logs unreadable'); },
      seen, now: NOW, env: env(), log: () => {} });
    expect(out.nextSeen).toEqual(seen);
    expect(out.errors.join(' ')).toContain('logs unreadable');
  });
  it('disabled settings read no signals and preserve seen state', async () => {
    const readSignals = vi.fn();
    const seen = { [key()]: NOW - 90 * MINUTE };
    const out = await runDetector({ prs: [pr()], readSignals, seen, now: NOW,
      env: env({ WE_PR_STALL_DETECTOR_ENABLED: 'false' }), log: () => {} });
    expect(out).toMatchObject({ items: [], nextSeen: seen });
    expect(readSignals).not.toHaveBeenCalled();
  });

  it('reads blocking PRs once and adapts collectOwnerSignals per-PR daemon objects', async () => {
    const wanted = [pr(), pr({ number: 5760, labels: ['review:pending'] })];
    const readSignals = vi.fn(async () => ({ [PR_KEY]: { sessions: [], daemons: skips(6) },
      [`${REPO}#5760`]: { daemons: [] } }));
    const out = await runDetector({ prs: [...wanted, pr({ number: 42, labels: ['review:human'] })],
      readSignals, seen: {}, now: NOW, env: env(), log: () => {} });
    expect(readSignals).toHaveBeenCalledTimes(1);
    expect(readSignals.mock.calls[0][0].prs).toEqual(wanted);
    expect(out.items).toMatchObject([{ pr: 5759, repeatCount: 6 }]);
  });

  it('replays nine hours of recorded review-daemon refusals into a roughly 540 minute stalled event', async () => {
    const recorded = [
      '[2026-10-23T10:00:00Z] review-daemon: we#5759 review:human, no review dispatched — already-reviewed-head: referral hold auto-resolved',
      '[2026-10-23T10:03:00Z] review-daemon: we#5759 review:human, no review dispatched — already-reviewed-head: referral hold auto-resolved',
      '[2026-10-23T10:06:00Z] review-daemon: we#5759 review:human, no review dispatched — already-reviewed-head: referral hold auto-resolved',
      '[2026-10-23T10:09:00Z] review-daemon: we#5759 review:human, no review dispatched — already-reviewed-head: referral hold auto-resolved',
    ];
    const start = Date.parse('2026-10-23T10:00:00Z');
    const logText = Array.from({ length: 181 }, (_, i) => recorded[i % recorded.length]
      .replace(/^\[[^\]]+\]/, `[${new Date(start + i * 3 * MINUTE).toISOString()}]`)).join('\n');
    const errors = [];
    const readSignals = args => collectOwnerSignals({ ...args, env: {}, errors,
      readAgents: () => [], readHealth: () => ({}), cloneRoots: () => ['fixture-clone'],
      listLogs: () => ['review-daemon.log'], readTail: () => logText });
    const out = await runDetector({ prs: [pr()], readSignals, seen: {}, now: NOW, env: env(), log: () => {} });
    expect(errors).toEqual([]);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ pr: 5759, head: HEAD, label: LABEL, repeatCount: 181 });
    expect(out.items[0].stalledMinutes).toBeCloseTo(540, 0);
    expect(out.items[0].remedy).toContain('red-team-on-skip not live on review daemon');
    expect(out.nextSeen[key()]).toBe(start);
  });
});

describe('runPrSweep detector integration', () => {
  function sweepOptions(patch = {}) {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    return { now: NOW, env: env(), dir: 'fixture/health', config: {},
      settings: { value: { enabled: true, idleMinutes: 45, stuckAfterMinutes: 90, stuckAlertMinutes: 90,
        dispatchDiagnosis: false, repos: [REPO] }, sources: {} },
      readPrs: () => [pr({ updatedAt: new Date(NOW - 120 * MINUTE).toISOString() })],
      readPrevious: () => ({ stallDetector: { [key()]: NOW - 90 * MINUTE } }),
      readQueue: () => ({ ready: [], rulingNeeded: [] }),
      readSignals: vi.fn(async () => ({ [PR_KEY]: { sessions: [], daemons: skips(6) } })),
      notify: vi.fn(() => ({ ok: true })), diagnose: vi.fn(), flush: vi.fn(() => ({})),
      persist: vi.fn(report => structuredClone(report)), append: vi.fn(),
      stallSweep: vi.fn(async () => ({ mode: 'off', digest: false, state: {}, items: [], act: [],
        dir: 'fixture/pr-stall-sweep', errors: [] })),
      stallDigest: vi.fn(() => ({ lines: [], fresh: [], notified: false, errors: [] })), ...patch };
  }

  it('passes the detector item to publishStalledDigest via stallDigest and persists nextState.stallDetector', async () => {
    const other = { lane: 'operator', repo: REPO, pr: 42, head: 'b'.repeat(40), state: 'needs-decision:note' };
    const options = sweepOptions({ stallSweep: async () => ({ mode: 'shadow', digest: true, state: {},
      dir: 'fixture/pr-stall-sweep', items: [other], act: [] }) });
    const report = await runPrSweep(options);
    expect(options.stallDigest).toHaveBeenCalledTimes(1);
    const [pass, digestOptions] = options.stallDigest.mock.calls[0];
    expect(pass.items).toEqual(expect.arrayContaining([other, expect.objectContaining({ pr: 5759,
      head: HEAD, lane: 'operator', state: 'stalled-same-head', action: 'stalled-detector' })]));
    expect(digestOptions.enabled).toBe(true);
    expect(report.stallDetector).toMatchObject({ enabled: true, stalled: 1 });
    expect(report.nextState.stallDetector).toEqual({ [key()]: NOW - 90 * MINUTE });
    const persisted = options.persist.mock.results.at(-1).value;
    expect(persisted.nextState.stallDetector).toEqual(report.nextState.stallDetector);
  });

  it('persists a brand-new detector clock in the second save and recovers its age', async () => {
    const options = sweepOptions({ readPrevious: () => ({}),
      readSignals: async () => ({ [PR_KEY]: { sessions: [], daemons: [] } }) });
    const report = await runPrSweep(options);
    expect(options.persist).toHaveBeenCalledTimes(2);
    const saved = options.persist.mock.results.at(-1).value.nextState;
    expect(saved.stallDetector).toEqual({ [key()]: NOW });
    expect(report.nextState.stallDetector).toEqual(saved.stallDetector);
    const recovery = sweepOptions({ now: NOW + 61 * MINUTE, readPrevious: () => saved, readSignals: options.readSignals });
    expect((await runPrSweep(recovery)).stallDetector.stalled).toBe(1);
  });

  it('includes saved detector clocks in the first persistence call', async () => {
    const options = sweepOptions({ readSignals: async () => ({ [PR_KEY]: { sessions: [], daemons: [] } }) });
    await runPrSweep(options);
    expect(options.persist.mock.results[0].value.nextState.stallDetector).toEqual({ [key()]: NOW - 90 * MINUTE });
  });

  it('preserves an unreadable PR clock through persistence and recovery without retaining another repo clock', async () => {
    const otherKey = `another/repo#5759@${HEAD}|${LABEL}`;
    const saved = { [key()]: NOW - 90 * MINUTE, [otherKey]: NOW - 120 * MINUTE };
    const options = sweepOptions({ readPrevious: () => ({ stallDetector: saved }),
      readPrs: () => [pr({ headRefOid: 'invalid', updatedAt: new Date(NOW).toISOString() })] });
    const report = await runPrSweep(options);
    expect(report.nextState.stallDetector).toEqual({ [key()]: saved[key()] });
    expect(options.persist.mock.results.at(-1).value.nextState.stallDetector).toEqual({ [key()]: saved[key()] });
    expect(options.stallDigest.mock.calls[0][0].incomplete).toBe(true);
    const recovery = sweepOptions({ readPrevious: () => report.nextState });
    expect((await runPrSweep(recovery)).stallDetector.stalled).toBe(1);
  });

  it.each(['reject', 'invalid'])('preserves previous detector state and marks the digest incomplete on a %s PR read', async failure => {
    const saved = { [key()]: NOW - 90 * MINUTE };
    const options = sweepOptions({ readPrevious: () => ({ stallDetector: saved }),
      readPrs: () => { if (failure === 'reject') throw new Error('PR read failed'); return null; } });
    const report = await runPrSweep(options);
    expect(report.nextState.stallDetector).toEqual(saved);
    for (const result of options.persist.mock.results) expect(result.value.nextState.stallDetector).toEqual(saved);
    expect(options.stallDigest.mock.calls[0][0].incomplete).toBe(true);
  });

  it.each(['reject', 'partial'])('preserves clocks and marks the digest incomplete on a %s signal read', async failure => {
    const saved = { [key()]: NOW - 90 * MINUTE };
    const options = sweepOptions({ readSignals: async ({ errors }) => {
      if (failure === 'reject') throw new Error('logs unreadable');
      errors.push('log unreadable'); return { [PR_KEY]: { daemons: [] } };
    } });
    const report = await runPrSweep(options);
    expect(report.nextState.stallDetector).toEqual(saved);
    expect(options.persist.mock.results.at(-1).value.nextState.stallDetector).toEqual(saved);
    expect(options.stallDigest.mock.calls[0][0].incomplete).toBe(true);
    expect(options.stallDigest.mock.calls[0][0].items).toEqual([]);
  });

  it('preserves only the errored PR clock when daemon data is malformed', async () => {
    const otherKey = `${REPO}#42@${HEAD}|${LABEL}`;
    const options = sweepOptions({ readPrevious: () => ({ stallDetector: {
      [key()]: NOW - 90 * MINUTE, [otherKey]: NOW - 120 * MINUTE,
    } }), readSignals: async () => ({ [PR_KEY]: { daemons: [{ at: null, kind: 'refusal', reason: REASON }] } }) });
    const report = await runPrSweep(options);
    expect(report.nextState.stallDetector).toEqual({ [key()]: NOW - 90 * MINUTE });
    expect(options.stallDigest.mock.calls[0][0].incomplete).toBe(true);
  });

  it('publishes one stalled event across repeated passes for the same PR and head', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detector-digest-'));
    try {
      const feedPath = join(root, 'events.jsonl'), stateDir = join(root, 'digest');
      const options = sweepOptions({ stallDigest: (pass, opts) => publishStalledDigest(pass, { ...opts, feedPath, stateDir }) });
      let previous = {};
      for (const tick of [NOW, NOW + MINUTE]) {
        const report = await runPrSweep({ ...options, now: tick, readPrevious: () => previous });
        expect(report.errors).toEqual([]);
        previous = report.nextState;
      }
      expect(replay({ path: feedPath })).toMatchObject([{ kind: 'stalled', pr: 5759, head: HEAD }]);
      expect(replay({ path: feedPath })).toHaveLength(1);
      expect(options.notify).toHaveBeenCalledTimes(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['shadow', 'on'])('publishes a single operator item when the %s sweep and detector share a PR and uppercase head', async mode => {
    const item = { lane: 'operator', repo: REPO, pr: 5759, head: HEAD.toUpperCase(), state: 'needs-decision:note' };
    const options = sweepOptions({ stallSweep: async () => ({ mode, digest: true,
      state: {}, dir: 'fixture/pr-stall-sweep', items: [item], act: [] }) });
    await runPrSweep(options);
    expect(options.stallDigest.mock.calls[0][0].items).toEqual([item]);
  });

  it('publishes detector items even when the automatic stall sweep and its digest are off', async () => {
    const options = sweepOptions();
    await runPrSweep(options);
    expect(options.stallDigest).toHaveBeenCalledTimes(1);
    expect(options.stallDigest.mock.calls[0][0].items).toEqual([expect.objectContaining({ pr: 5759 })]);
    expect(options.stallDigest.mock.calls[0][1].enabled).toBe(true);
  });

  it.each(['shadow', 'on', 'off'])('digest:false excludes %s sweep items while the enabled detector still publishes', async mode => {
    const sweepItem = { lane: 'operator', repo: REPO, pr: 5759, head: HEAD.toUpperCase(), state: 'needs-decision:note' };
    const options = sweepOptions({ stallSweep: async () => ({ mode, digest: false, state: {},
      dir: 'fixture/pr-stall-sweep', items: [sweepItem], act: [] }) });
    const report = await runPrSweep(options);
    expect(report.stallDetector).toMatchObject({ enabled: true, stalled: 1 });
    expect(options.stallDigest).toHaveBeenCalledTimes(1);
    const [pass, digestOptions] = options.stallDigest.mock.calls[0];
    expect(pass.items).toEqual([expect.objectContaining({ pr: 5759, action: 'stalled-detector' })]);
    expect(pass.items).not.toContainEqual(sweepItem);
    expect(digestOptions.enabled).toBe(true);
  });

  it('an enabled empty detector pass still calls the digest so resolved stalls can clear', async () => {
    const options = sweepOptions({ readPrs: () => [], readSignals: async () => ({}) });
    const report = await runPrSweep(options);
    expect(report.stallDetector).toMatchObject({ enabled: true, stalled: 0 });
    expect(options.stallDigest).toHaveBeenCalledTimes(1);
    expect(options.stallDigest.mock.calls[0][0].items).toEqual([]);
    expect(options.stallDigest.mock.calls[0][1].enabled).toBe(true);
    expect(report.nextState.stallDetector).toEqual({});
  });

  it('prefixes detector errors in the sweep report', async () => {
    const options = sweepOptions({ readPrs: () => [pr({ headRefOid: 'invalid', updatedAt: new Date(NOW).toISOString() })] });
    const report = await runPrSweep(options);
    expect(report.errors.some(error => /^stall detector:.*head/i.test(error))).toBe(true);
    expect(report.stallDetector).toMatchObject({ stalled: 0 });
  });

  it('dry-run computes detector items for display without persisting, publishing, or notifying', async () => {
    const options = sweepOptions({ dryRun: true });
    const report = await runPrSweep(options);
    expect(report.stallDetector).toMatchObject({ enabled: true, stalled: 1,
      items: [expect.objectContaining({ pr: 5759, head: HEAD, label: LABEL })] });
    for (const seam of ['persist', 'append', 'stallSweep', 'stallDigest', 'notify', 'flush', 'diagnose']) {
      expect(options[seam], seam).not.toHaveBeenCalled();
    }
  });
});
