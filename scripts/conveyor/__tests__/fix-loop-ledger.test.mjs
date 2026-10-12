import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fixLoopConfig, fixLoopState, fixLoopBreaches, readFixLoopRows, appendFixLoopRow,
  fixLoopLedgerPath, fixDispatchKillFile, fixDispatchKilled, hasFixHoldLabel, FIX_HOLD_LABEL, FIX_RUN_INFRA_PATTERNS, classifyFixRunOutcome, infraFailureCount, fixLoopDisposition } from '../fix-loop-ledger.mjs';
const now = Date.parse('2026-10-05T12:00:00Z'), head = 'a'.repeat(40);
const row = (extra = {}) => ({ v: 1, at: new Date(now).toISOString(), repo: 'we', pr: 3990, head, kind: 'ci-heal', ...extra });
const hermeticConfig = env => fixLoopConfig(env, { readPlatform: () => ({}), readRepo: () => ({}) });
const config = hermeticConfig({});
const state = (rows, extra = {}) => fixLoopState({ rows, repo: 'we', pr: 3990, head, now, config, ...extra });
const dirs = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'fix-loop-')); dirs.push(dir); return dir; };
it('config defaults, overrides, and invalid values', () => {
  expect(config).toEqual({ maxSessions: 3, windowHours: 6, hold: true, rearmAfterMinutes: 120, rearmAfterMinutesSource: 'default' });
  expect(hermeticConfig({ WE_FIX_LOOP_MAX_SESSIONS: '5', WE_FIX_LOOP_WINDOW_HOURS: '.5', WE_FIX_LOOP_HOLD: '0' }))
    .toEqual({ maxSessions: 5, windowHours: .5, hold: false, rearmAfterMinutes: 120, rearmAfterMinutesSource: 'default' });
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
  expect(state(rows)).toEqual({ count: 3, rawCount: 3, infraFailures: 0, held: true, since: at, sessions: ['same', 'same'] });
  expect(state(rows, { config: { ...config, hold: false } }).held).toBe(false);
  expect(state(rows, { head: 'c'.repeat(40) })).toEqual({ count: 0, rawCount: 0, infraFailures: 0, held: false, since: null, sessions: [] });
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
  expect(state(stubs)).toEqual({ count: 0, rawCount: 0, infraFailures: 0, held: false, since: null, sessions: [] });
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
    ['fix-run: PR #4965 pushed (pushed abc123def); claim released', 4965, 'pushed', false],
  ]) expect(classifyFixRunOutcome(line)).toMatchObject({ pr, outcome, infra });
  expect(classifyFixRunOutcome('unrelated')).toBeNull();
  expect(classifyFixRunOutcome('prefix fix-run: PR #1 failed (EPERM); claim released')).toBeNull();
  expect(classifyFixRunOutcome('fix-run: PR #1 no-change (sandbox); claim released').infra).toBe(false);
});
it('discounts infra and only reads the last N terminals for the requested PR', () => {
  expect(state([row(), row(), row()], { infraFailures: 3 })).toMatchObject({ count: 0, rawCount: 3, infraFailures: 3, held: false });
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
    readPlatform: () => platform, readRepo: () => repo,
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
  for (const reason of ['no-finding: missing', 'fix-run: refusal', 'error: broken', 'missing required flag',
    'has no fix launcher', 'launch did not complete', 'lane-pool', 'Operation not permitted', 'EPERM',
    'EACCES', 'read-only file system', 'index.lock', '.git permission', 'sandbox', 'could not commit', 'could not push', 'could not stage']) {
    for (const outcome of ['failed', 'no-change', 'pushed']) {
      expect(classifyFixRunOutcome(`fix-run: PR #1 ${outcome} (${reason}); claim released`).infra).toBe(outcome === 'failed');
    }
  }
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
