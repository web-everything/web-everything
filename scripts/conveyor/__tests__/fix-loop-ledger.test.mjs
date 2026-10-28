import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { ledgerInfraRows, fixLoopConfig, fixLoopState, fixLoopBreaches, readFixLoopRows, appendFixLoopRow,
  fixLoopLedgerPath, fixDispatchKillFile, fixDispatchKilled, hasFixHoldLabel, FIX_HOLD_LABEL, FIX_RUN_INFRA_PATTERNS, classifyFixRunOutcome, infraFailureCount, fixLoopDisposition, fixLoopRedMainLapse, fixLoopSessionRows } from '../fix-loop-ledger.mjs';
const now = Date.parse('2026-10-05T12:00:00Z'), head = 'a'.repeat(40);
const row = (extra = {}) => ({ v: 1, at: new Date(now).toISOString(), repo: 'we', pr: 3990, head, kind: 'ci-heal', ...extra });
const hermeticConfig = env => fixLoopConfig(env, { readPlatform: () => ({}), readRepo: () => ({}), readMainRuns: () => [] });
const config = hermeticConfig({});
const state = (rows, extra = {}) => fixLoopState({ rows, repo: 'we', pr: 3990, head, now, config, ...extra });
const dirs = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'fix-loop-')); dirs.push(dir); return dir; };
it.each(['ordinary', 'rearm', 'park'])('disabling holds bypasses %s controls', kind => {
  const rows = [row(), row(), row()];
  if (kind !== 'ordinary') rows.push(row({ kind, reason: 'fixture' }));
  expect(fixLoopDisposition({ rows, repo: 'we', pr: 3990, head, now,
    config: { ...config, hold: false } })).toEqual({ action: 'dispatch' });
});
it('caps raw dispatches for a head even when every outcome is discounted and the window expired', () => {
  const rows = Array.from({ length: 5 }, () => row({ at: new Date(now - 7 * 3600000).toISOString() }));
  expect(fixLoopDisposition({ rows: rows.slice(0, 4), repo: 'we', pr: 3990, head, now, config,
    infraFailures: 4, infraRows: rows }).action).toBe('rearm');
  expect(fixLoopDisposition({ rows, repo: 'we', pr: 3990, head, now, config,
    infraFailures: 5, infraRows: rows }).action).toBe('park');
  expect(fixLoopDisposition({ rows, repo: 'we', pr: 3990, head, now,
    config: { ...config, hold: false } }).action).toBe('dispatch');
});
it('config defaults, overrides, and invalid values', () => {
  expect(config).toEqual({ maxSessions: 3, windowHours: 6, hold: true, rearmAfterMinutes: 120, rearmAfterMinutesSource: 'default', redMainDiscount: 'on', redMainDiscountSource: 'default', redMainWindows: [] });
  expect(hermeticConfig({ WE_FIX_LOOP_MAX_SESSIONS: '5', WE_FIX_LOOP_WINDOW_HOURS: '.5', WE_FIX_LOOP_HOLD: '0' }))
    .toEqual({ maxSessions: 5, windowHours: .5, hold: false, rearmAfterMinutes: 120, rearmAfterMinutesSource: 'default', redMainDiscount: 'on', redMainDiscountSource: 'default', redMainWindows: [] });
  for (const value of ['', '0', '-1', 'NaN', 'Infinity', 'bad']) {
    expect(hermeticConfig({ WE_FIX_LOOP_MAX_SESSIONS: value, WE_FIX_LOOP_WINDOW_HOURS: value, WE_FIX_LOOP_HOLD: value === '0' ? 'bad' : value })).toEqual(config);
  }
  expect(hermeticConfig({ WE_FIX_LOOP_MAX_SESSIONS: '1.5' }).maxSessions).toBe(3);
});
it('counts only the same repo, PR, head and window, retaining repeated sessions', () => {
  const at = new Date(now - 6 * 3600000).toISOString();
  const rows = [row({ at, session: 'same' }), row({ session: 'same', kind: 'fix' }), row(),
    row({ repo: 'frontierui' }), row({ pr: 399 }), row({ head: 'b'.repeat(40) }),
    row({ at: new Date(now - 6 * 3600000 - 1).toISOString() }), row({ at: new Date(now + 1).toISOString() }), null];
  expect(state(rows)).toEqual({ count: 3, rawCount: 3, redMainDiscounted: 0, infraFailures: 0, held: true, since: at, sessions: ['same', 'same'] });
  expect(state(rows, { config: { ...config, hold: false } }).held).toBe(false);
  expect(state(rows, { head: 'c'.repeat(40) })).toEqual({ count: 0, rawCount: 0, redMainDiscounted: 0, infraFailures: 0, held: false, since: null, sessions: [] });
});
it('breaches skip missing PRs and moved heads and aggregate repair kinds', () => {
  const rows = [row(), row(), row({ kind: 'fix' })];
  const check = prs => fixLoopBreaches({ rows, prs, now, config });
  expect(check([])).toEqual([]);
  expect(check([{ repo: 'we', number: 3990, headRefOid: 'b'.repeat(40) }])).toEqual([]);
  expect(check([{ repo: 'we', number: 3990, headRefOid: head }])).toEqual([
    { repo: 'we', pr: 3990, head, count: 3, kinds: { 'ci-heal': 2, fix: 1 }, firstAt: row().at, lastAt: row().at },
  ]);
});
it('roundtrips JSONL, creates directories, and tolerates missing and malformed rows', () => {
  const env = { WE_FIX_LOOP_LEDGER: join(temp(), 'nested', 'ledger.jsonl') };
  expect(readFixLoopRows({ env })).toEqual([]);
  appendFixLoopRow({ repo: 'we', pr: 3990, head, kind: 'fix', session: 's' }, { env, now });
  appendFileSync(env.WE_FIX_LOOP_LEDGER, 'broken\nnull\n{}\n');
  expect(readFixLoopRows({ env })).toEqual([row({ kind: 'fix', session: 's' })]);
  expect(fixLoopLedgerPath({})).toBe(join(homedir(), '.claude', 'conveyor', 'fix-loop-ledger.jsonl'));
});
it('bounds reads to 1 MiB and drops a truncated first line', () => {
  const env = { WE_FIX_LOOP_LEDGER: join(temp(), 'ledger') };
  writeFileSync(env.WE_FIX_LOOP_LEDGER, JSON.stringify(row({ session: 'x'.repeat(1024 * 1024) })) + '\n' + JSON.stringify(row()) + '\n');
  expect(readFixLoopRows({ env })).toEqual([row()]);
  writeFileSync(env.WE_FIX_LOOP_LEDGER, 'x'.repeat(1024 * 1024 + 1));
  expect(readFixLoopRows({ env })).toEqual([]);
});
it('kill file and label helpers honor overrides', () => {
  const env = { WE_FIX_DISPATCH_KILL_FILE: join(temp(), 'kill') };
  expect(fixDispatchKillFile(env)).toBe(env.WE_FIX_DISPATCH_KILL_FILE);
  expect(fixDispatchKillFile({})).toBe(join(homedir(), '.claude', 'conveyor', 'fix-dispatch.kill'));
  expect(fixDispatchKilled({ env })).toBe(false);
  writeFileSync(env.WE_FIX_DISPATCH_KILL_FILE, '');
  expect(fixDispatchKilled({ env })).toBe(true);
  expect(fixDispatchKilled({ env, exists: path => path === env.WE_FIX_DISPATCH_KILL_FILE })).toBe(true);
  expect(FIX_HOLD_LABEL).toBe('hold:fix');
  expect(hasFixHoldLabel([{ name: 'hold:fix' }], {})).toBe(true);
  expect(hasFixHoldLabel(['hold:fix'], {})).toBe(true);
  expect(hasFixHoldLabel(['custom'], { WE_FIX_HOLD_LABEL: 'custom' })).toBe(true);
  expect(hasFixHoldLabel(undefined, {})).toBe(false);
});
it('stub sessions from the daemon smoke never count as repair attempts (#4194 mixed-state: real heal still owed)', () => {
  const stubs = [row({ session: 'stub-ci-heal' }), row({ session: 'stub-ci-heal' }), row({ session: 'stub-fix' })];
  expect(state(stubs)).toEqual({ count: 0, rawCount: 0, redMainDiscounted: 0, infraFailures: 0, held: false, since: null, sessions: [] });
  expect(fixLoopBreaches({ rows: stubs, prs: [{ repo: 'we', number: 3990, headRefOid: head }], now, config })).toEqual([]);
  // real sessions on the same head still hold
  expect(state([...stubs, row({ session: 'ci-heal-3990' }), row({ session: 'ci-heal-3990' }), row({ session: 'fix-3990' })]).held).toBe(true);
});

// PRs #4992/#4993/#4965, 2026-10-12: launcher refusals are not repair sessions.
it('classifies terminal outcomes without treating genuine runs as infrastructure', () => {
  for (const [line, pr, outcome, infra] of [
    ['fix-run: PR #4992 failed (no-finding: the PR has no changes-requested or advisory comment to apply); claim released', 4992, 'failed', true],
    ['fix-run: PR #4965 failed (no-finding: ...); claim not held / already released', 4965, 'failed', true],
    ['fix-run: PR #4965 no-change (agent committed nothing; ...); claim released', 4965, 'no-change', false],
    ['fix-run: PR #4965 no-change-unproven (missing 1001#2); claim released', 4965, 'no-change-unproven', false],
    ['fix-run: PR #4965 pushed (pushed abc123def); claim released', 4965, 'pushed', false],
  ]) expect(classifyFixRunOutcome(line)).toMatchObject({ pr, outcome, infra });
  expect(classifyFixRunOutcome('unrelated')).toBeNull();
  expect(classifyFixRunOutcome('prefix fix-run: PR #1 failed (EPERM); claim released')).toBeNull();
  expect(classifyFixRunOutcome('fix-run: PR #1 no-change (sandbox); claim released').infra).toBe(false);
});
it('discounts infra and only reads the last N terminals for the requested PR', () => {
  expect(state([row(), row(), row()], { infraFailures: 3 })).toMatchObject({ count: 0, rawCount: 3, redMainDiscounted: 0, infraFailures: 3, held: false });
  expect(state([row(), row(), row()], { infraFailures: 0 }).held).toBe(true);
  const logText = ['fix-run: PR #1 failed (EPERM); claim released', 'noise',
    'fix-run: PR #1 no-change (nothing); claim released', 'fix-run: PR #2 failed (EPERM); claim released',
    'fix-run: PR #1 failed (no-finding: none); claim released'].join('\n');
  expect(infraFailureCount({ logText, pr: 1, sessions: 2 })).toBe(1);
  expect(infraFailureCount({ logText, pr: 1, sessions: 3 })).toBe(2);
  expect(infraFailureCount({ logText, pr: 1, sessions: 0 })).toBe(0);
});
it('re-arms once by build or clock and parks visibly after the re-armed run', () => {
  const build = 'b'.repeat(40);
  const decide = (rows, extra = {}) => fixLoopDisposition({ rows, repo: 'we', pr: 3990, head, now,
    config: { ...config, rearmAfterMinutes: 120 }, build, ...extra });
  expect(decide([row(), row(), row()])).toMatchObject({ action: 'rearm', reason: expect.stringContaining('build') });
  const recent = [row({ build }), row({ build }), row({ build })];
  expect(decide(recent)).toEqual({ action: 'hold', until: new Date(now + 120 * 60000).toISOString() });
  const old = recent.map(r => ({ ...r, at: new Date(now - 121 * 60000).toISOString() }));
  expect(decide(old)).toMatchObject({ action: 'rearm', reason: expect.stringContaining('window') });
  const rearm = row({ kind: 'rearm', reason: 'window', at: new Date(now - 60000).toISOString() });
  expect(decide([...old, rearm])).toMatchObject({ action: 'hold' });
  expect(decide([...old, rearm, row({ build })])).toMatchObject({ action: 'park' });
  expect(decide([...old, rearm, row({ build })], { infraFailures: 1 })).toMatchObject({ action: 'hold' });
  expect(decide([row({ kind: 'park', reason: 'exhausted' })])).toEqual({ action: 'parked' });
  expect(state([...recent, rearm, row({ kind: 'park', reason: 'exhausted' })]).rawCount).toBe(3);
});
it('resolves the re-arm setting default → platform → repo → env with its source', () => {
  const prefs = n => ({ fix: { loopHold: { rearmAfterMinutes: n } } });
  const resolve = (env = {}, platform = {}, repo = {}) => fixLoopConfig(env, {
    readPlatform: () => platform, readRepo: () => repo, readMainRuns: () => [],
  });
  expect(resolve()).toMatchObject({ rearmAfterMinutes: 120, rearmAfterMinutesSource: 'default' });
  expect(resolve({}, prefs(90))).toMatchObject({ rearmAfterMinutes: 90, rearmAfterMinutesSource: 'platform' });
  expect(resolve({}, prefs(90), prefs(60))).toMatchObject({ rearmAfterMinutes: 60, rearmAfterMinutesSource: 'repo' });
  expect(resolve({ WE_FIX_LOOP_REARM_AFTER_MINUTES: '30' }, prefs(90), prefs(60)))
    .toMatchObject({ rearmAfterMinutes: 30, rearmAfterMinutesSource: 'env' });
  for (const value of ['0', '-1', 'Infinity', 'NaN', '']) {
    expect(resolve({ WE_FIX_LOOP_REARM_AFTER_MINUTES: value }, prefs(90), prefs(60)).rearmAfterMinutes).toBe(60);
  }
});

it('accepts control rows and legacy sessions but never counts controls as breaches', () => {
  const env = { WE_FIX_LOOP_LEDGER: join(temp(), 'ledger') };
  for (const kind of ['fix', 'rearm', 'park']) appendFixLoopRow({ repo: 'we', pr: 3990, head, kind, reason: 'fixture' }, { env, now });
  const rows = readFixLoopRows({ env });
  expect(rows.map(r => r.kind)).toEqual(['fix', 'rearm', 'park']);
  expect(state(rows).rawCount).toBe(1);
  expect(fixLoopBreaches({ rows, prs: [{ repo: 'we', number: 3990, headRefOid: head }], now, config })).toEqual([]);
});
it('classifies every infrastructure pattern and never discounts pushed or no-change', () => {
  expect(Object.isFrozen(FIX_RUN_INFRA_PATTERNS)).toBe(true);
  for (const reason of ['no-finding: missing', 'no-ci-failure: missing', 'fix-run: refusal', 'error: broken', 'missing required flag',
    'has no fix launcher', 'launch did not complete', 'lane-pool', 'Operation not permitted', 'EPERM',
    'EACCES', 'read-only file system', 'index.lock', '.git permission', 'sandbox', 'could not commit', 'could not push', 'could not stage']) {
    for (const outcome of ['failed', 'no-change', 'no-change-unproven', 'pushed']) {
      expect(classifyFixRunOutcome(`fix-run: PR #1 ${outcome} (${reason}); claim released`).infra).toBe(outcome === 'failed');
    }
  }
});
it('roundtrips no-change-unproven outcome rows and counts them like no-change toward escalation', () => {
  const env = { WE_FIX_LOOP_LEDGER: join(temp(), 'ledger.jsonl') };
  const rows = Array.from({ length: 3 }, (_, i) => [row({ kind: 'fix', session: `s${i}` }),
    row({ kind: 'outcome', session: `s${i}`, outcome: 'no-change-unproven', infra: false, reason: 'missing 1001#2' })]).flat();
  for (const entry of rows) appendFixLoopRow(entry, { env, now });
  expect(readFixLoopRows({ env })).toEqual(rows);
  const ordinary = rows.map(entry => entry.kind === 'outcome' ? { ...entry, outcome: 'no-change' } : entry);
  expect(state(rows)).toEqual(state(ordinary));
  expect(state(rows)).toMatchObject({ count: 3, infraFailures: 0, held: true });
  const decide = entries => fixLoopDisposition({ rows: entries, repo: 'we', pr: 3990, head, now, config, build: 'b'.repeat(40) });
  expect(decide(rows)).toEqual(decide(ordinary));
  expect(decide(rows).action).toBe('rearm');
});
it('uses exact infra positions for build triggers and parking, and retries an unlaunched re-arm after its clock', () => {
  const build = 'b'.repeat(40), oldAt = new Date(now - 121 * 60000).toISOString();
  const rearm = row({ kind: 'rearm', reason: 'window', at: oldAt });
  const before = Array.from({ length: 3 }, () => row({ build, at: new Date(now - 122 * 60000).toISOString() }));
  const args = { repo: 'we', pr: 3990, head, now, config, build };
  expect(fixLoopDisposition({ ...args, rows: [...before, rearm] })).toEqual({ action: 'dispatch' });
  const infra = row({ at: new Date(now - 1000).toISOString() });
  const recent = Array.from({ length: 3 }, () => row({ build }));
  expect(fixLoopDisposition({ ...args, rows: [infra, ...recent], infraFailures: 1, infraRows: [infra] }).action).toBe('hold');
  expect(fixLoopDisposition({ ...args, rows: [...before, rearm, infra, row({ build })],
    infraFailures: 1, infraRows: [infra] }).action).toBe('park');
});

// card 5947 (live #5045, 2026-10-13): outcomes pair by identity and attempt, never shared-log position.
it('validates outcome rows without counting them as sessions', () => {
  const env = { WE_FIX_LOOP_LEDGER: join(temp(), 'ledger') };
  const outcome = { repo: 'we', pr: 3990, head, kind: 'outcome', session: 's', outcome: 'failed', infra: true };
  appendFixLoopRow(outcome, { env, now });
  expect(readFixLoopRows({ env })).toEqual([row(outcome)]);
  expect(state(readFixLoopRows({ env })).rawCount).toBe(0);
  for (const extra of [{ session: '' }, { session: null }, { outcome: 'bad' }, { infra: 'true' }, { infra: undefined }])
    expect(() => appendFixLoopRow({ ...outcome, ...extra }, { env, now })).toThrow(/Invalid/);
});
it('pairs the first outcome per attempt across heads and a reused session name', () => {
  const at = n => new Date(now - 10000 + n * 1000).toISOString();
  const s1 = row({ session: 's', at: at(1) }), s2 = row({ session: 's', at: at(4) });
  const other = row({ session: 's', head: 'b'.repeat(40), at: at(2) });
  const outcome = (n, extra = {}) => row({ kind: 'outcome', session: 's', outcome: 'failed', infra: true, at: at(n), ...extra });
  const rows = [outcome(6), s2, other, outcome(3, { head: other.head }), outcome(2, { infra: false }), s1, outcome(3)];
  expect(ledgerInfraRows({ rows, repo: 'we', pr: 3990, head })).toEqual([s2]);
  expect(ledgerInfraRows({ rows, repo: 'we', pr: 3990, head: other.head })).toEqual([other]);
  expect(state(rows)).toMatchObject({ rawCount: 2, infraFailures: 1, count: 1 });
});
it.each([true, false])('discounts only infrastructure outcomes (infra=%s)', infra => {
  const rows = Array.from({ length: 3 }, (_, i) => [
    row({ session: 's', at: new Date(now - (6 - i * 2) * 1000).toISOString() }),
    row({ kind: 'outcome', session: 's', outcome: infra ? 'failed' : 'no-change', infra,
      at: new Date(now - (5 - i * 2) * 1000).toISOString() }),
  ]).flat();
  expect(fixLoopDisposition({ rows, repo: 'we', pr: 3990, head, now, config }).action).toBe(infra ? 'dispatch' : 'hold');
  expect(state(rows).count).toBe(infra ? 0 : 3);
});

it('unions caller and ledger infra positions without double counting', () => {
  const sessions = Array.from({ length: 3 }, (_, i) => row({ session: `s${i}`, at: new Date(now - 10000 + i * 1000).toISOString() }));
  const outcome = row({ kind: 'outcome', session: 's0', outcome: 'failed', infra: true, at: new Date(now - 5000).toISOString() });
  const args = { rows: [...sessions, outcome], repo: 'we', pr: 3990, head, now, config, infraFailures: 2 };
  expect(fixLoopDisposition({ ...args, infraRows: [sessions[0], sessions[1]] }).action).toBe('dispatch');
  expect(state(args.rows, { infraFailures: 2 })).toMatchObject({ infraFailures: 2, count: 1 });
});

it.each(['expired', 'future'])('%s infrastructure outcomes do not discount current sessions', position => {
  const at = new Date(now + (position === 'expired' ? -7 : 1) * 3600000).toISOString();
  const infra = row({ session: 'infra', at });
  const rows = [infra, row({ kind: 'outcome', session: 'infra', at, outcome: 'failed', infra: true }),
    ...Array.from({ length: 3 }, (_, i) => [row({ session: `s${i}` }),
      row({ kind: 'outcome', session: `s${i}`, outcome: 'no-change', infra: false })]).flat()];
  expect(state(rows)).toMatchObject({ rawCount: 3, infraFailures: 0, count: 3, held: true });
  expect(fixLoopDisposition({ rows, repo: 'we', pr: 3990, head, now, config }).action).toBe('hold');
});

it('future infrastructure outcomes do not discount a current session', () => {
  const rows = [...Array.from({ length: 3 }, (_, i) => row({ session: `s${i}` })),
    row({ kind: 'outcome', session: 's0', outcome: 'failed', infra: true,
      at: new Date(now + 1000).toISOString() })];
  expect(state(rows)).toMatchObject({ rawCount: 3, infraFailures: 0, count: 3, held: true });
  expect(fixLoopDisposition({ rows, repo: 'we', pr: 3990, head, now, config }).action).toBe('hold');
});

const incidentWindows = [{ start: '2026-10-13T21:33:48Z', end: '2026-10-13T23:32:06Z' }];
it('retains red-main attempts as outcome pairing boundaries for reused session names', () => {
  const incidentNow = Date.parse('2026-10-14T00:00:00Z');
  const sessions = ['21:00:00', '21:10:00', '21:20:00'].map((time, i) =>
    row({ session: `s${i}`, at: `2026-10-13T${time}Z` }));
  const discounted = row({ session: 's2', at: '2026-10-13T22:00:00Z' });
  const outcome = row({ kind: 'outcome', session: 's2', outcome: 'failed', infra: true,
    at: '2026-10-13T22:01:00Z' });
  const args = { rows: [...sessions, discounted, outcome], repo: 'we', pr: 3990, head,
    now: incidentNow, config: { ...config, redMainDiscount: 'on', redMainWindows: incidentWindows } };
  expect(fixLoopState(args)).toMatchObject({ count: 3, infraFailures: 0, redMainDiscounted: 1 });
  expect(fixLoopDisposition(args).action).toBe('rearm');
});
const incidentRows = ['22:04:33', '22:13:35', '22:28:12', '22:40:50', '22:40:55', '22:52:26'].map((time, i) =>
  row({ pr: 5195, at: `2026-10-13T${time}Z`, kind: i === 3 ? 'rearm' : i === 5 ? 'park' : 'ci-heal', reason: 'budget' }));
const incident = (extra = {}) => ({ rows: incidentRows, repo: 'we', pr: 5195, head,
  now: Date.parse('2026-10-13T23:50:00Z'), config: { ...config, redMainDiscount: 'on', redMainWindows: incidentWindows }, ...extra });
it('releases #5195 after main recovers without counting its red-main repair sessions', () => {
  expect(fixLoopDisposition(incident())).toEqual({ action: 'dispatch' });
  expect(fixLoopRedMainLapse(incident())).toBe(true);
  expect(fixLoopState(incident())).toMatchObject({ count: 0, rawCount: 0, redMainDiscounted: 4 });
  expect(fixLoopSessionRows(incident())).toEqual([]);
});
it('keeps parks when disabled, unreadable, still red, or independently exhausted', () => {
  for (const changed of [{ redMainDiscount: 'off' }, { redMainWindows: null },
    { redMainWindows: [{ ...incidentWindows[0], end: null }] }]) {
    const args = incident({ config: { ...incident().config, ...changed } });
    expect(fixLoopDisposition(args).action).toBe('parked');
    expect(fixLoopRedMainLapse(args)).toBe(false);
  }
  const outside = Array.from({ length: 5 }, () => row({ pr: 5195, kind: 'fix', at: '2026-10-13T23:40:00Z' }));
  const args = incident({ rows: [...incidentRows, ...outside] });
  expect(fixLoopDisposition(args).action).toBe('park');
  expect(fixLoopRedMainLapse(args)).toBe(false);
  expect(fixLoopRedMainLapse(incident({ rows: [] }))).toBe(false);
});
it('keeps the per-head ceilings while main is still red (open window)', () => {
  const open = { ...incident().config, redMainWindows: [{ ...incidentWindows[0], end: null }] };
  const sessions = n => Array.from({ length: n }, (_, i) => row({ pr: 5195, session: `s${i}`,
    at: new Date(Date.parse('2026-10-13T22:00:00Z') + i * 60000).toISOString() }));
  const decide = n => fixLoopDisposition(incident({ rows: sessions(n), config: open })).action;
  expect(decide(2)).toBe('dispatch');
  expect(decide(3)).toBe('hold');
  expect(decide(5)).toBe('park');
  expect(fixLoopState(incident({ rows: sessions(3), config: open }))).toMatchObject({ count: 3, redMainDiscounted: 0 });
  // An end that does not parse is open-ended to isWithinRedWindow, so it must not discount either.
  const unparsed = { ...open, redMainWindows: [{ ...incidentWindows[0], end: 'not-a-date' }] };
  expect(fixLoopDisposition(incident({ rows: sessions(5), config: unparsed })).action).toBe('park');
});
it('bounds discounted red-main sessions per head with a separate hard cap', () => {
  const windows = Array.from({ length: 4 }, (_, i) => ({ start: `2026-10-13T1${i}:00:00Z`, end: `2026-10-13T1${i}:30:00Z` }));
  const sessions = n => Array.from({ length: n }, (_, i) => row({ pr: 5195, session: `s${i}`,
    at: `2026-10-13T1${Math.floor(i / 4)}:${String(10 + (i % 4) * 2).padStart(2, '0')}:00Z` }));
  const args = n => incident({ rows: sessions(n), config: { ...incident().config, redMainWindows: windows } });
  expect(fixLoopDisposition(args(5)).action).toBe('dispatch');
  expect(fixLoopDisposition(args(10)).action).toBe('park');
  const parked = args(10);
  parked.rows = [...parked.rows, row({ pr: 5195, kind: 'park', reason: 'budget', at: '2026-10-13T13:20:00Z' })];
  expect(fixLoopRedMainLapse(parked)).toBe(false);
});
it('never lets disabled holds lapse a park that main being red did not cause', () => {
  const own = row({ pr: 5195, kind: 'park', reason: 'own failure', at: '2026-10-13T23:40:00Z' });
  const off = { ...incident().config, hold: false };
  expect(fixLoopRedMainLapse(incident({ rows: [...incidentRows, own], config: off }))).toBe(false);
  expect(fixLoopRedMainLapse(incident({ config: off }))).toBe(true);
});
it('discounts the raw per-head ceiling beyond the rolling window, but retains outside controls', () => {
  expect(fixLoopDisposition(incident({ rows: [...incidentRows, incidentRows[0]],
    now: Date.parse('2026-10-14T12:00:00Z') })).action).toBe('dispatch');
  expect(fixLoopDisposition(incident({ rows: [...incidentRows,
    row({ pr: 5195, kind: 'park', reason: 'own failure', at: '2026-10-13T23:40:00Z' })] })).action).toBe('parked');
});
it('resolves red-main discount through the cascade and fails closed on read failure', () => {
  const prefs = value => ({ fix: { loopHold: { redMainDiscount: value } } });
  const resolve = (env = {}, platform = {}, repo = {}, readMainRuns = () => []) => fixLoopConfig(env, {
    readPlatform: () => platform, readRepo: () => repo, readMainRuns,
  });
  expect(resolve()).toMatchObject({ redMainDiscount: 'on', redMainDiscountSource: 'default', redMainWindows: [] });
  expect(resolve({}, prefs('off'))).toMatchObject({ redMainDiscount: 'off', redMainDiscountSource: 'platform' });
  expect(resolve({}, prefs('off'), prefs('on'))).toMatchObject({ redMainDiscount: 'on', redMainDiscountSource: 'repo' });
  const env = { WE_FIX_LOOP_RED_MAIN_DISCOUNT: 'off' };
  expect(resolve(env, {}, prefs('on'), () => { throw new Error('must not read'); }))
    .toMatchObject({ redMainDiscount: 'off', redMainDiscountSource: 'env' });
  expect(resolve({ WE_FIX_LOOP_RED_MAIN_DISCOUNT: 'invalid' }, {}, prefs('off')).redMainDiscount).toBe('off');
  expect(resolve({}, {}, {}, () => { throw new Error('unreadable'); }).redMainWindows).toBeNull();
  expect(resolve({}, {}, {}, () => null).redMainWindows).toBeNull();
  expect(resolve({}, {}, {}, () => [
    { status: 'completed', conclusion: 'failure', updatedAt: incidentWindows[0].start },
    { status: 'completed', conclusion: 'success', updatedAt: incidentWindows[0].end },
  ]).redMainWindows).toEqual(incidentWindows);
});
