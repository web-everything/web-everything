import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { appendCodexUsage, codexUsageLedgerPath, codexRunTokens, readCodexQuota, withCodexUsage } from '../codex-usage-ledger.mjs';
import { aggregateCodexUsage, readCodexUsageReport, parseSince, formatCodexUsageReport } from '../../codex-usage-report.mjs';

const fixture = (fn) => { const root = mkdtempSync(join(tmpdir(), 'codex-ledger-')); return Promise.resolve().then(() => fn(root)).finally(() => rmSync(root, { recursive: true, force: true })); };
const stdout = `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 10 } })}\n`;

describe('Codex usage ledger', () => {
  it('reuses the central conveyor root and honors the explicit override', () => {
    expect(codexUsageLedgerPath({ WE_DAEMON_STATE_DIR: 'state' })).toBe(join('state', 'conveyor-state', 'codex-usage.jsonl'));
    expect(codexUsageLedgerPath({ CONVEYOR_STATE_ROOT: 'central' })).toContain(join('central', 'codex-usage.jsonl'));
    expect(codexUsageLedgerPath({ WE_CODEX_USAGE_LEDGER: 'custom.jsonl' })).toBe('custom.jsonl');
  });
  it('appends separate complete rows with quota delta and token fields', () => fixture(root => {
    const env = { WE_CODEX_USAGE_LEDGER: join(root, 'nested', 'ledger.jsonl') };
    const record = { model: 'gpt-6-astra', effort: 'high', taskKind: 'fix', caller: 'fix-run.mjs', repo: 'owner/repo', pr: 12, card: 'abc', stdout, quotaBefore: { used_percent: 20 }, quotaAfter: { used_percent: 22 }, durationMs: 350, changedFiles: true, exit: 0 };
    appendCodexUsage(record, { env }); appendCodexUsage(record, { env });
    const rows = readFileSync(env.WE_CODEX_USAGE_LEDGER, 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ model: record.model, effort: 'high', taskKind: 'fix', caller: 'fix-run.mjs', repo: 'owner/repo', pr: 12, card: 'abc', tokens: { input: 100, cached: 60, output: 20, reasoning: 10 }, quota: { before_used_percent: 20, after_used_percent: 22, delta: 2 }, durationMs: 350, outcome: { changedFiles: true, exit: 0 } });
    expect(new Date(rows[0].at).toISOString()).toBe(rows[0].at);
  }));
  it('never throws on real filesystem, serialization, or injected append failures', () => fixture(root => {
    const env = { WE_CODEX_USAGE_LEDGER: root };
    expect(appendCodexUsage({}, { env })).toBeNull();
    expect(appendCodexUsage({ model: 1n }, { env })).toBeNull();
    expect(appendCodexUsage({}, { env, mkdir: () => {}, append: () => { throw Error('full'); } })).toBeNull();
  }));
  it('preserves unknown values and excludes resets from deltas', () => {
    let text;
    const io = { env: { WE_CODEX_USAGE_LEDGER: 'unused' }, mkdir: () => {}, append: (_p, t) => { text = t; } };
    appendCodexUsage({}, io);
    expect(JSON.parse(text)).toMatchObject({ tokens: { reasoning: null }, quota: { delta: null }, outcome: { changedFiles: null, exit: null } });
    expect(appendCodexUsage({ quotaBefore: { used_percent: 10, resets_at: 1 }, quotaAfter: { used_percent: 20, resets_at: 2 } }, io).quota.delta).toBeNull();
    expect(appendCodexUsage({ quotaBefore: { used_percent: 90 }, quotaAfter: { used_percent: 2 } }, io).quota.delta).toBeNull();
  });
  it('sums multiple terminal turns, tolerates malformed lines and distinguishes missing reasoning', () => {
    expect(codexRunTokens(`bad\n${stdout}${stdout}`)).toEqual({ input: 200, cached: 120, output: 40, reasoning: 20 });
    expect(codexRunTokens('{"type":"turn.completed","usage":{"output_tokens":3}}')).toMatchObject({ output: 3, reasoning: null });
  });
  it('reads only the Codex bucket from persisted rollout observations', () => fixture(root => {
    const sessions = join(root, 'sessions', '2026'); mkdirSync(sessions, { recursive: true });
    const event = (id, used, reset) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: id, primary: { used_percent: used, resets_at: reset } } } });
    writeFileSync(join(sessions, 'run.jsonl'), `${event('codex', 10, 5)}\n${event('codex', 12, 5)}\n${event('other', 99, 6)}\n`);
    expect(readCodexQuota({ CODEX_HOME: root })).toEqual({ used_percent: 12, resets_at: 5 });
    expect(readCodexQuota({ CODEX_HOME: join(root, 'missing') })).toBeNull();
  }));
  it('records successes and failed launches exactly once without altering their result', async () => {
    const rows = []; let time = 100;
    const io = { snapshot: () => ({ hash: 'same', repo: 'repo' }), quota: () => ({ used_percent: 2 }), now: () => time += 10, append: r => rows.push(r) };
    const result = { stdout, code: 0 };
    expect(await withCodexUsage({ cwd: 'fixture' }, async () => result, io)).toBe(result);
    const error = Object.assign(Error('failed'), { status: 7, stdout });
    await expect(withCodexUsage({}, async () => { throw error; }, io)).rejects.toBe(error);
    expect(rows).toHaveLength(2); expect(rows[0]).toMatchObject({ changedFiles: false, durationMs: 10 }); expect(rows[1].exit).toBe(7);
    expect(await withCodexUsage({}, async () => result, { quota: () => { throw Error(); }, append: () => { throw Error(); } })).toBe(result);
  });
  it('observes actual repository changes including untracked files and commits', () => fixture(async root => {
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
    git('init'); writeFileSync(join(root, 'tracked'), 'before'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'initial');
    const env = { WE_CODEX_USAGE_LEDGER: join(root, '.git', 'ledger.jsonl'), CODEX_HOME: join(root, 'missing') };
    await withCodexUsage({ cwd: root, taskKind: 'build' }, async () => { writeFileSync(join(root, 'new'), 'content'); return { stdout, code: 0 }; }, { env });
    await withCodexUsage({ cwd: root }, async () => ({ code: 0 }), { env });
    expect(readCodexUsageReport({ env }).changedNothing).toHaveLength(1);
    expect(readFileSync(env.WE_CODEX_USAGE_LEDGER, 'utf8').trim().split('\n').map(JSON.parse)[0].outcome.changedFiles).toBe(true);
  }));
});

describe('Codex usage report', () => {
  it('runs the read-only CLI against a real fixture ledger with since and JSON output', () => fixture(root => {
    const path = join(root, 'ledger');
    writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), taskKind: 'prepare', model: 'sol', outcome: { changedFiles: false, exit: 0 } }) + '\n');
    const cli = resolve('scripts/codex-usage-report.mjs');
    const env = { ...process.env, WE_CODEX_USAGE_LEDGER: path };
    const before = readFileSync(path, 'utf8');
    const output = execFileSync(process.execPath, [cli, '--since=24h', '--json'], { env, encoding: 'utf8' });
    expect(JSON.parse(output).byTaskKind.prepare.runs).toBe(1);
    expect(execFileSync(process.execPath, [cli, '--since=24h'], { env, encoding: 'utf8' })).toContain('Changed nothing: 1 runs');
    expect(readFileSync(path, 'utf8')).toBe(before);
  }));

  it('aggregates kinds, models and callers, filters time and lists explicit unchanged runs', () => {
    const base = { at: '2026-10-13T12:00:00Z', model: 'astra', taskKind: 'fix', caller: 'fix-run', tokens: { input: 100, cached: 50, output: 20 }, quota: { delta: 2 }, outcome: { changedFiles: false, exit: 0 } };
    const report = aggregateCodexUsage([base, { ...base, model: 'sol', taskKind: 'review-security', caller: 'judge', quota: { delta: null }, outcome: { changedFiles: null } }, { ...base, at: '2026-10-10T00:00:00Z' }, null], { since: parseSince('24h', Date.parse('2026-10-13T13:00:00Z')) });
    expect(report).toMatchObject({ runs: 2, quotaPercent: 2, quotaMeasuredRuns: 1, tokens: { input: 200, cached: 100, output: 40, reasoning: 0 } });
    expect(report.byTaskKind.fix.runs).toBe(1); expect(report.byModel.sol.quotaMeasuredRuns).toBe(0);
    expect(report.topCallers[0].caller).toBe('fix-run'); expect(report.changedNothing).toEqual([base]);
    expect(formatCodexUsageReport(report)).toContain('Changed nothing: 1 runs');
    expect(() => parseSince('invalid')).toThrow();
  });
  it('reads JSONL with malformed/torn lines and handles an absent ledger', () => fixture(root => {
    const env = { WE_CODEX_USAGE_LEDGER: join(root, 'ledger') };
    expect(readCodexUsageReport({ env }).runs).toBe(0);
    writeFileSync(env.WE_CODEX_USAGE_LEDGER, 'bad\n'+JSON.stringify({ at: '2026-10-13T12:00:00Z', taskKind: '__proto__' })+'\n{"at":');
    const report = readCodexUsageReport({ env }); expect(report.runs).toBe(1); expect(report.byTaskKind.__proto__.runs).toBe(1);
  }));
});
