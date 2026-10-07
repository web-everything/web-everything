import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fixLoopConfig, fixLoopState, fixLoopBreaches, readFixLoopRows, appendFixLoopRow,
  fixLoopLedgerPath, fixDispatchKillFile, fixDispatchKilled, hasFixHoldLabel, FIX_HOLD_LABEL } from '../fix-loop-ledger.mjs';
const now = Date.parse('2026-10-05T12:00:00Z'), head = 'a'.repeat(40);
const row = (extra = {}) => ({ v: 1, at: new Date(now).toISOString(), repo: 'we', pr: 3990, head, kind: 'ci-heal', ...extra });
const config = fixLoopConfig({});
const state = (rows, extra = {}) => fixLoopState({ rows, repo: 'we', pr: 3990, head, now, config, ...extra });
const dirs = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'fix-loop-')); dirs.push(dir); return dir; };
it('config defaults, overrides, and invalid values', () => {
  expect(config).toEqual({ maxSessions: 3, windowHours: 6, hold: true });
  expect(fixLoopConfig({ WE_FIX_LOOP_MAX_SESSIONS: '5', WE_FIX_LOOP_WINDOW_HOURS: '.5', WE_FIX_LOOP_HOLD: '0' }))
    .toEqual({ maxSessions: 5, windowHours: .5, hold: false });
  for (const value of ['', '0', '-1', 'NaN', 'Infinity', 'bad']) {
    expect(fixLoopConfig({ WE_FIX_LOOP_MAX_SESSIONS: value, WE_FIX_LOOP_WINDOW_HOURS: value, WE_FIX_LOOP_HOLD: value === '0' ? 'bad' : value })).toEqual(config);
  }
  expect(fixLoopConfig({ WE_FIX_LOOP_MAX_SESSIONS: '1.5' }).maxSessions).toBe(3);
});
it('counts only the same repo, PR, head and window, retaining repeated sessions', () => {
  const at = new Date(now - 6 * 3600000).toISOString();
  const rows = [row({ at, session: 'same' }), row({ session: 'same', kind: 'fix' }), row(),
    row({ repo: 'frontierui' }), row({ pr: 399 }), row({ head: 'b'.repeat(40) }),
    row({ at: new Date(now - 6 * 3600000 - 1).toISOString() }), row({ at: new Date(now + 1).toISOString() }), null];
  expect(state(rows)).toEqual({ count: 3, held: true, since: at, sessions: ['same', 'same'] });
  expect(state(rows, { config: { ...config, hold: false } }).held).toBe(false);
  expect(state(rows, { head: 'c'.repeat(40) })).toEqual({ count: 0, held: false, since: null, sessions: [] });
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
  expect(state(stubs)).toEqual({ count: 0, held: false, since: null, sessions: [] });
  expect(fixLoopBreaches({ rows: stubs, prs: [{ repo: 'we', number: 3990, headRefOid: head }], now, config })).toEqual([]);
  // real sessions on the same head still hold
  expect(state([...stubs, row({ session: 'ci-heal-3990' }), row({ session: 'ci-heal-3990' }), row({ session: 'fix-3990' })]).held).toBe(true);
});
