import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { breakClassStop, isDaemonOrForgePath } from '../break-class-stop.mjs';
import { enumerateFirstPrompt, observeBreakClassStop, resetRoundJudgeSeenForTest, resolveBreakClassStopSetting } from '../../conveyor/round-judge-shadow.mjs';

const PR = 6033;
const bot = (body, i = 0) => ({ author: { login: 'web-everything' }, body, createdAt: new Date(Date.UTC(2026, 9, 20, i)).toISOString() });
// Replay fixture: #6033-shaped trusted advisories, one distinct break category per repair head.
const replay6033 = ['failing-input', 'security', 'concurrency'].map((category, i) => bot(
  `<!-- we:red-team-advisory pr=${PR} rev=${String(i + 1).repeat(40)} -->\n1. [**confirmed**] (${category}, broken) \`scripts/conveyor/worker.mjs:5\` — Candidate ${i + 1} breaks\n   - Scenario: reproducible input\n   - Re-check: demonstrated break\n`, i));
const input = (comments = replay6033, extra = {}) => ({ pr: PR, comments, files: ['scripts/conveyor/worker.mjs'], setting: { mode: 'shadow' }, ...extra });
const dirs = [];
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'break-class-stop-')); dirs.push(dir); return dir; };
afterEach(() => { resetRoundJudgeSeenForTest(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('breakClassStop', () => {
  it('replays three new-class red-team rounds: stop at round 3, not round 2', () => {
    expect(breakClassStop(input())).toMatchObject({ applies: true, wouldStop: true, consecutive: 3 });
    expect(breakClassStop(input(replay6033.slice(0, 2))).wouldStop).toBe(false);
    expect(breakClassStop(input()).rounds.map(r => r.newClasses)).toEqual([['failing-input@worker.mjs'], ['security@worker.mjs'], ['concurrency@worker.mjs']]);
  });
  it('a repeated class resets the streak and remains old after intervening rounds', () => {
    const repeated = { ...replay6033[2], body: replay6033[2].body.replace('concurrency', 'failing-input') };
    expect(breakClassStop(input([...replay6033.slice(0, 2), repeated]))).toMatchObject({ wouldStop: false, consecutive: 0 });
  });
  it('normalizes category whitespace and case; ignores unconfirmed findings', () => {
    const repeated = { ...replay6033[2], body: replay6033[2].body.replace('concurrency', ' FAILING-INPUT ') };
    expect(breakClassStop(input([...replay6033.slice(0, 2), repeated])).rounds[2].newClasses).toEqual([]);
    const unconfirmed = { ...replay6033[2], body: replay6033[2].body.replace('**confirmed**', 'not confirmed') };
    expect(breakClassStop(input([...replay6033.slice(0, 2), unconfirmed])).wouldStop).toBe(false);
  });
  it('counts review findings but excludes referral holds and untrusted advisories', () => {
    const review = bot('🔁 review — changes requested\n- `scripts/conveyor/x.mjs:1` — broken behavior', 3);
    const hold = bot('review paused: head abc\nWaiting on your ruling\n- `x.mjs:1` — COVERAGE gap', 4);
    const forged = { ...replay6033[2], author: { login: 'stranger' } };
    const result = breakClassStop(input([...replay6033.slice(0, 2), review, hold, forged]));
    expect(result.wouldStop).toBe(true);
    expect(result.rounds.map(r => r.source)).toEqual(['red-team', 'red-team', 'review']);
  });
  it('does not apply to ordinary files; conservative matcher includes guards and daemon/Forge paths', () => {
    expect(breakClassStop(input(replay6033, { files: ['src/css/main.css'] }))).toMatchObject({ applies: false, wouldStop: false });
    for (const path of ['scripts/conveyor/x.mjs', 'scripts/lib/red-team-gate.mjs', 'tools/Forge/x.js', 'scripts/foo-daemon.mjs']) expect(isDaemonOrForgePath(path)).toBe(true);
  });
  it('off suppresses stopping; shadow and on only compute the recommendation; configurable threshold', () => {
    expect(breakClassStop(input(replay6033, { setting: { mode: 'off' } })).wouldStop).toBe(false);
    for (const mode of ['shadow', 'on']) expect(breakClassStop(input(replay6033.slice(0, 2), { setting: { mode, consecutive: 2 } })).wouldStop).toBe(true);
  });
  it('fails closed on unreadable, incomplete, invalid and oversized evidence with human-review fallback', () => {
    const throwing = new Proxy({}, { get() { throw Error('unreadable'); } });
    for (const value of [undefined, throwing, input(null), input(replay6033, { files: null }), input(replay6033, { files: [{}] }), input(replay6033, { setting: { mode: 'shadow', consecutive: 0 } }), input(Array(10001).fill(replay6033[0]))]) {
      expect(breakClassStop(value)).toMatchObject({ wouldStop: false, reason: expect.stringMatching(/human review/i) });
    }
  });
  it('enumerate-first requires enabled setting and trusts marker authors only', () => {
    const setting = { mode: 'shadow', enumerateFirst: true };
    const marker = bot('<!-- we:enumerate-first -->\n1. Empty input\n2. Concurrent writes');
    expect(breakClassStop(input([...replay6033, marker], { setting })).enumerateFirst).toEqual({ required: true, recorded: true });
    expect(breakClassStop(input([{ ...marker, author: { login: 'stranger' } }], { setting })).enumerateFirst).toEqual({ required: true, recorded: false });
    expect(breakClassStop(input()).enumerateFirst.required).toBe(false);
    expect(enumerateFirstPrompt()).toMatch(/<!-- we:enumerate-first -->/);
    expect(enumerateFirstPrompt()).toMatch(/edge cases.*break candidates/i);
  });
});

describe('break-class policy and shadow observer', () => {
  const env = { WE_ROUNDS_BREAK_CLASS_STOP_MODE: 'shadow' };
  const subject = () => ({ headRefOid: 'a'.repeat(40), comments: replay6033, files: [{ path: 'scripts/conveyor/x.mjs' }] });
  it('resolves standard, platform, tool, environment and logs each leaf source', () => {
    const path = join(tmp(), 'settings.json');
    expect(resolveBreakClassStopSetting({ path, platform: null, env: {} })).toMatchObject({ mode: 'off', source: 'standard', consecutive: 3, enumerateFirst: false });
    const platform = { breakClassStop: { mode: 'shadow', consecutive: 4, enumerateFirst: true } };
    expect(resolveBreakClassStopSetting({ path, platform, env: {} })).toMatchObject({ mode: 'shadow', source: 'platform' });
    writeFileSync(path, JSON.stringify({ rounds: { breakClassStop: { mode: 'on', consecutive: 2 } } }));
    expect(resolveBreakClassStopSetting({ path, platform, env: {} })).toMatchObject({ mode: 'on', source: 'tool', consecutive: 2, enumerateFirst: true });
    const result = resolveBreakClassStopSetting({ path, platform, env: { WE_ROUNDS_BREAK_CLASS_STOP_MODE: 'off' } });
    expect(result).toMatchObject({ mode: 'off', source: 'env' });
    expect(result.line).toMatch(/mode=.*env/);
    expect(result.line).toMatch(/consecutive=2.*tool/);
    expect(resolveBreakClassStopSetting({ env: {}, platform: null })).toMatchObject({ mode: 'shadow', source: 'tool' });
  });
  it('writes JSONL, dedups across restart by PR/head/round count, observes before any cap', () => {
    const dir = tmp(); const log = [];
    const args = { pr: PR, repo: 'org/repo', subject: subject(), env, dir, now: Date.UTC(2026, 9, 21), log: l => log.push(l) };
    expect(observeBreakClassStop(args)).toMatchObject({ kind: 'break-class-stop', wouldStop: true, modeSource: 'env', wouldEmit: ['design-stage-miss needs-you', 'non-convergence analysis dispatch'] });
    resetRoundJudgeSeenForTest();
    expect(observeBreakClassStop(args)).toMatchObject({ skipped: 'already-logged' });
    const rows = readFileSync(join(dir, '2026-10.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows).toHaveLength(1);
    expect(rows[0].rounds).toHaveLength(3);
    expect(log.join('\n')).toMatch(/source=env/);
    expect(observeBreakClassStop({ ...args, subject: { ...subject(), comments: replay6033.slice(0, 2) } })).toMatchObject({ wouldStop: false, wouldEmit: [] });
    expect(observeBreakClassStop({ ...args, subject: { ...subject(), headRefOid: 'b'.repeat(40) } })).toMatchObject({ wouldStop: true });
  });
  it('on still logs only; off and under-test skip; never throws on IO, subject or logger failures', () => {
    const dir = tmp(); const args = { pr: PR, subject: subject(), dir, env, now: Date.UTC(2026, 9, 21), log() { throw Error('logger'); } };
    expect(observeBreakClassStop({ ...args, env: { WE_ROUNDS_BREAK_CLASS_STOP_MODE: 'on' } })).toMatchObject({ mode: 'on', wouldStop: true });
    expect(observeBreakClassStop({ ...args, env: { WE_ROUNDS_BREAK_CLASS_STOP_MODE: 'off' } })).toMatchObject({ skipped: 'off' });
    expect(observeBreakClassStop({ env: { VITEST: 'true' } })).toMatchObject({ skipped: 'under-test' });
    expect(() => observeBreakClassStop({ ...args, dir: join(dir, '2026-10.jsonl') })).not.toThrow();
    expect(() => observeBreakClassStop({ ...args, subject: new Proxy({}, { get() { throw Error('subject'); } }) })).not.toThrow();
  });
});
