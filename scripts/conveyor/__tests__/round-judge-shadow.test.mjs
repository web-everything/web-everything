import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { observeRoundCap, resolveRoundJudgeMode, roundJudgeDir, resetRoundJudgeSeenForTest } from '../round-judge-shadow.mjs';
import { redTeamGateMarker } from '../../lib/red-team-gate.mjs';

const HEAD = 'f'.repeat(40);
const OLD = 'e'.repeat(40);
const bot = (body, createdAt) => ({ author: { login: 'web-everything' }, body, createdAt });
const rt = (head, file, summary, createdAt) => bot(`<!-- we:red-team-advisory pr=77 rev=${head} -->\n1. [**confirmed**] (failing-input, broken) \`${file}:5\` — ${summary}\n`, createdAt);
const subject = () => ({ headRefOid: HEAD, comments: [
  rt(OLD, 'a.mjs', 'alpha parser fails on empty input', '2026-10-20T00:00:00Z'),
  rt(HEAD, 'b.mjs', 'beta cache keeps stale rows', '2026-10-20T01:00:00Z'),
  bot(redTeamGateMarker(77, HEAD, 'round-cap', 'abcdef0123456789'), '2026-10-20T01:01:00Z'),
] });
const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'rjs-')); dirs.push(d); return d; };
afterEach(() => { resetRoundJudgeSeenForTest(); while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
const settingsOf = (mode) => { const d = tmp(); const p = join(d, 's.json'); require_write(p, JSON.stringify({ rounds: { judge: { mode } } })); return p; };
import { writeFileSync } from 'node:fs';
const require_write = (p, s) => writeFileSync(p, s);

describe('resolveRoundJudgeMode', () => {
  it('standard default is off when nothing sets it', () => {
    expect(resolveRoundJudgeMode({ env: {}, path: '/nonexistent', platform: null })).toMatchObject({ mode: 'off', source: 'standard' });
  });
  it('the repo settings file turns it on, source tool', () => {
    expect(resolveRoundJudgeMode({ env: {}, path: settingsOf('shadow'), platform: null })).toMatchObject({ mode: 'shadow', source: 'tool' });
  });
  it('env beats the file', () => {
    expect(resolveRoundJudgeMode({ env: { WE_ROUNDS_JUDGE_MODE: 'off' }, path: settingsOf('shadow'), platform: null })).toMatchObject({ mode: 'off', source: 'env' });
  });
  it('an invalid value is ignored (falls to the lower layer)', () => {
    expect(resolveRoundJudgeMode({ env: {}, path: settingsOf('loud'), platform: null })).toMatchObject({ mode: 'off', source: 'standard' });
  });
  it('the committed repo file is shadow', () => {
    expect(resolveRoundJudgeMode({ env: {}, platform: null })).toMatchObject({ mode: 'shadow', source: 'tool' });
  });
});

describe('maxGrants setting', () => {
  it('standard 20; the file can lower it; junk is ignored', () => {
    expect(resolveRoundJudgeMode({ env: {}, path: '/nonexistent', platform: null }).maxGrants).toBe(20);
    const d = tmp(); const p = join(d, 's.json'); writeFileSync(p, JSON.stringify({ rounds: { judge: { mode: 'shadow', maxGrants: 6 } } }));
    expect(resolveRoundJudgeMode({ env: {}, path: p, platform: null }).maxGrants).toBe(6);
    writeFileSync(p, JSON.stringify({ rounds: { judge: { mode: 'shadow', maxGrants: 'lots' } } }));
    expect(resolveRoundJudgeMode({ env: {}, path: p, platform: null }).maxGrants).toBe(20);
  });
});

describe('observeRoundCap', () => {
  const env = (extra = {}) => ({ WE_ROUNDS_JUDGE_MODE: 'shadow', ...extra });
  it('off writes nothing', () => {
    const dir = tmp();
    expect(observeRoundCap({ pr: 77, subject: subject(), env: { WE_ROUNDS_JUDGE_MODE: 'off' }, dir })).toMatchObject({ skipped: 'off' });
    expect(existsSync(join(dir, '2026-10.jsonl'))).toBe(false);
  });
  it('shadow logs one JSONL record with the line, source and evidence; a second look is skipped', () => {
    const dir = tmp(); const lines = [];
    const rec = observeRoundCap({ pr: 77, repo: 'web-everything/web-everything', subject: subject(), env: env(), dir, now: Date.UTC(2026, 9, 21), log: (l) => lines.push(l) });
    expect(rec).toMatchObject({ pr: 77, trigger: 'red-team-cap', mode: 'shadow', modeSource: 'env', verdict: 'send-back' });
    const file = join(dir, '2026-10.jsonl');
    const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0].line).toBe('round-judge-shadow: #77 verdict=send-back reasons=findings-changing-not-shrinking');
    expect(rows[0].evidence).toMatchObject({ latestCount: 1, prevCount: 1, trend: 'changing' });
    expect(lines[0]).toMatch(/^round-judge-shadow: #77 verdict=send-back .*source=env/);
    expect(observeRoundCap({ pr: 77, subject: subject(), env: env(), dir, now: Date.UTC(2026, 9, 21) })).toMatchObject({ skipped: 'already-logged' });
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
  });
  it('no cap -> nothing logged', () => {
    const dir = tmp();
    expect(observeRoundCap({ pr: 77, subject: { headRefOid: HEAD, comments: [] }, state: 'awaiting-review', env: env(), dir })).toMatchObject({ skipped: 'no-cap' });
  });
  it('remembers the diff size and uses growth on the next cap episode', () => {
    const dir = tmp();
    const files = (n) => [{ path: 'x.mjs', additions: n, deletions: 0 }];
    observeRoundCap({ pr: 77, state: 'at-round-limit', subject: { headRefOid: OLD, comments: [], files: files(300) }, env: env(), dir, now: Date.UTC(2026, 9, 21) });
    const rec = observeRoundCap({ pr: 77, subject: { ...subject(), files: files(700) }, env: env(), dir, now: Date.UTC(2026, 9, 21) });
    expect(rec.verdict).toBe('suggest-split');
  });
  it('a restart does not re-log a known cap (dedup comes from the log itself)', () => {
    const dir = tmp();
    observeRoundCap({ pr: 77, subject: subject(), env: env(), dir, now: Date.UTC(2026, 9, 21) });
    resetRoundJudgeSeenForTest();
    expect(observeRoundCap({ pr: 77, subject: subject(), env: env(), dir, now: Date.UTC(2026, 9, 21) })).toMatchObject({ skipped: 'already-logged' });
    expect(readFileSync(join(dir, '2026-10.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  });
  it('an error after the cap is known fails closed: an escalate record is logged', () => {
    const dir = tmp();
    const rec = observeRoundCap({ pr: 77, subject: subject(), env: env(), dir, now: Date.UTC(2026, 9, 21), setting: new Proxy({}, { get() { throw new Error('boom'); } }) });
    expect(rec).toMatchObject({ verdict: 'escalate' });
    expect(rec.reasons[0]).toMatch(/fail-closed/);
  });
  it('logs a not-real-verified record with its evidence line (referral hold, claim refuted on the head)', () => {
    const dir = tmp();
    const hold = bot('review paused: head abc was already reviewed 1 time(s)\n\nWaiting on your ruling (block, card or not-real):\n- `src/x.mjs:5` — The retry backoff wiring in x has no test.\n\n<!-- review-referral-hold: deadbeefdeadbeef -->', '2026-10-20T02:00:00Z');
    const verifyRepo = { read: (p) => (p === 'src/x.test.mjs' ? "describe('x', () => {\n  it('retry backoff is exercised', () => {})\n})" : null), tests: () => ['src/x.test.mjs'] };
    const rec = observeRoundCap({ pr: 77, subject: { headRefOid: HEAD, comments: [hold] }, env: env(), dir, now: Date.UTC(2026, 9, 21), verifyRepo });
    expect(rec).toMatchObject({ trigger: 'referral-hold', verdict: 'not-real-verified' });
    expect(rec.line).toMatch(/^round-judge-shadow: #77 verdict=not-real-verified evidence=src\/x.mjs:5 -> src\/x.test.mjs:2 /);
  });
  it('an inconclusive check is send-back, never not-real', () => {
    const dir = tmp();
    const hold = bot('review paused: x\n\nWaiting on your ruling (block, card or not-real):\n- `src/x.mjs:5` — The retry backoff wiring in x has no test.\n\n<!-- review-referral-hold: deadbeefdeadbeef -->', '2026-10-20T02:00:00Z');
    const rec = observeRoundCap({ pr: 77, subject: { headRefOid: HEAD, comments: [hold] }, env: env(), dir, now: Date.UTC(2026, 9, 21), verifyRepo: { read: () => null, tests: () => [] } });
    expect(rec.verdict).toBe('send-back');
  });
  it('the dir override is honoured only for a directory named round-judge-shadow', () => {
    expect(roundJudgeDir({ WE_ROUND_JUDGE_SHADOW_DIR: '/var/elsewhere' })).toMatch(/\.operations\/round-judge-shadow$/);
    expect(roundJudgeDir({ WE_ROUND_JUDGE_SHADOW_DIR: '/var/x/round-judge-shadow' })).toBe('/var/x/round-judge-shadow');
  });
  it('never throws: a hostile subject is a skipped/fail-closed note, not an exception', () => {
    const dir = tmp();
    const bad = { get comments() { throw new Error('boom'); }, headRefOid: HEAD };
    expect(() => observeRoundCap({ pr: 77, subject: bad, env: env(), dir })).not.toThrow();
    expect(observeRoundCap({ pr: 77, subject: bad, env: env(), dir })).toMatchObject({ skipped: 'error' });
  });
  it('under test with no dir it does not touch the real log', () => {
    expect(observeRoundCap({ pr: 77, subject: subject(), env: { VITEST: 'true', WE_ROUNDS_JUDGE_MODE: 'shadow' } })).toMatchObject({ skipped: 'under-test' });
  });
  it('writes only inside its dir', () => {
    const dir = tmp();
    observeRoundCap({ pr: 77, subject: subject(), env: env(), dir, now: Date.UTC(2026, 9, 21) });
    expect(readdirSync(dir).sort()).toEqual(['2026-10.jsonl']);
  });
});
