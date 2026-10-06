import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  AWAIT_VERIFY_FILE, DEFAULT_AWAIT_VERIFY_TTL_MS, AWAIT_VERIFY_FUTURE_SKEW_MS,
  resolveAwaitVerifyTtlMs, resolveAwaitVerifyPath, readAwaitVerifyRecord, classifyAwaitVerify,
  makeAwaitingVerifyResolver, writeAwaitVerifyRecord, clearAwaitVerifyRecord,
  AWAIT_VERIFY_STORE_ENV, listStoredAwaitVerify, readStoredAwaitVerify,
} from '../await-verify.mjs';
import { DEFAULT_ADMISSION_CEILING_MS } from '../../readiness/heavy-admission.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'await-verify.mjs');
const nowMs = Date.parse('2026-10-06T18:00:00Z');
const record = { v: 1, sessionId: 'S1', who: 'fix-4115', repo: 'web-everything/web-everything',
  pr: 4115, sha: 'a'.repeat(40), requestedAt: new Date(nowMs - 1000).toISOString(), attempt: 1 };
const session = { sessionId: 'S1', name: record.who };
const classify = (over = {}) => classifyAwaitVerify({ record, session, nowMs, ttlMs: DEFAULT_AWAIT_VERIFY_TTL_MS, ...over });
let cwd;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'await-verify-')); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

describe('classifyAwaitVerify', () => {
  it('awaiting-verify', () => { expect(classify()).toEqual({ awaiting: true, reason: 'awaiting-verify', ageMs: 1000 }); });
  it('no-record', () => { expect(classify({ record: null })).toEqual({ awaiting: false, reason: 'no-record', ageMs: null }); });
  it.each([[], { ...record, v: 2 }, { ...record, requestedAt: 'bad' }, { ...record, pr: 0 }, { ...record, pr: 1.5 }])('malformed: %j', (bad) => {
    expect(classify({ record: bad })).toEqual({ awaiting: false, reason: 'malformed', ageMs: null });
  });
  it('foreign-session by sessionId', () => { expect(classify({ session: { ...session, sessionId: 'other' } }).reason).toBe('foreign-session'); });
  it('foreign-session by who', () => { expect(classify({ record: { ...record, sessionId: null, who: 'other' } }).reason).toBe('foreign-session'); });
  it('unbound', () => { expect(classify({ record: { ...record, sessionId: null, who: null } }).reason).toBe('unbound'); });
  it('binds by who without an id', () => { expect(classify({ record: { ...record, sessionId: null } }).awaiting).toBe(true); });
  it('a record with an id falls back to who for an id-less row', () => {
    expect(classify({ session: { name: 'fix-4115' } }).awaiting).toBe(true);
    expect(classify({ session: { name: 'fix-9999' } }).reason).toBe('foreign-session');
    expect(classify({ session: {} }).reason).toBe('unbound');
  });
  it('other-pr', () => { expect(classify({ pr: 4116 }).reason).toBe('other-pr'); });
  it('future-skew', () => {
    expect(classify({ record: { ...record, requestedAt: new Date(nowMs + AWAIT_VERIFY_FUTURE_SKEW_MS + 1).toISOString() } }))
      .toEqual({ awaiting: false, reason: 'future-skew', ageMs: -AWAIT_VERIFY_FUTURE_SKEW_MS - 1 });
  });
  it('expired', () => { expect(classify({ ttlMs: 999 })).toEqual({ awaiting: false, reason: 'expired', ageMs: 1000 }); });
  it.each([{ nowMs: NaN }, { nowMs: Infinity }, { ttlMs: 0 }, { ttlMs: -1 }, { ttlMs: NaN }])('no-signal: %j', (over) => {
    expect(classify(over)).toEqual({ awaiting: false, reason: 'no-signal', ageMs: null });
  });
  it('includes both time boundaries', () => {
    expect(classify({ ttlMs: 1000 }).awaiting).toBe(true);
    expect(classify({ record: { ...record, requestedAt: new Date(nowMs + AWAIT_VERIFY_FUTURE_SKEW_MS).toISOString() } }).awaiting).toBe(true);
  });
});

it('TTL equals admission ceiling plus thirty minutes; env override and floor', () => {
  expect(DEFAULT_AWAIT_VERIFY_TTL_MS).toBe(DEFAULT_ADMISSION_CEILING_MS + 30 * 60_000);
  expect(resolveAwaitVerifyTtlMs({ WE_AWAIT_VERIFY_TTL_MINUTES: '12' })).toBe(12 * 60_000);
  expect(resolveAwaitVerifyTtlMs({ WE_AWAIT_VERIFY_TTL_MINUTES: '.5' })).toBe(60_000);
  for (const raw of [undefined, '', 'bad', '0', '-1', 'Infinity']) {
    expect(resolveAwaitVerifyTtlMs({ WE_AWAIT_VERIFY_TTL_MINUTES: raw })).toBe(DEFAULT_AWAIT_VERIFY_TTL_MS);
  }
});
it('resolves .git directories and relative gitdir files', () => {
  mkdirSync(join(cwd, '.git'));
  expect(resolveAwaitVerifyPath(cwd)).toBe(join(cwd, '.git', AWAIT_VERIFY_FILE));
  const worktree = join(cwd, 'worktree');
  mkdirSync(worktree);
  writeFileSync(join(worktree, '.git'), 'gitdir: ../.git\n');
  expect(resolveAwaitVerifyPath(worktree)).toBe(join(cwd, '.git', AWAIT_VERIFY_FILE));
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(cwd, '.git')}\n`);
  expect(resolveAwaitVerifyPath(worktree)).toBe(join(cwd, '.git', AWAIT_VERIFY_FILE));
});
it('unreadable and invalid paths or JSON never throw', () => {
  expect(resolveAwaitVerifyPath(cwd)).toBeNull();
  expect(resolveAwaitVerifyPath(cwd, { statFn: () => { throw Error('denied'); } })).toBeNull();
  writeFileSync(join(cwd, '.git'), 'not a gitdir');
  expect(resolveAwaitVerifyPath(cwd)).toBeNull();
  rmSync(join(cwd, '.git'));
  mkdirSync(join(cwd, '.git'));
  for (const value of ['bad', 'null', '[]', '42']) {
    writeFileSync(join(cwd, '.git', AWAIT_VERIFY_FILE), value);
    expect(readAwaitVerifyRecord(cwd)).toBeNull();
  }
  expect(readAwaitVerifyRecord(cwd, { readFileSyncFn: () => { throw Error('denied'); } })).toBeNull();
});
it('write → read → clear round trip', () => {
  mkdirSync(join(cwd, '.git'));
  expect(writeAwaitVerifyRecord({ cwd, record })).toEqual({ ok: true, path: join(cwd, '.git', AWAIT_VERIFY_FILE) });
  expect(readAwaitVerifyRecord(cwd)).toEqual(record);
  expect(clearAwaitVerifyRecord(cwd)).toEqual({ cleared: true });
  expect(readAwaitVerifyRecord(cwd)).toBeNull();
  expect(clearAwaitVerifyRecord(cwd)).toEqual({ cleared: false });
});
it.each([{ ...record, v: 0 }, { ...record, sessionId: null, who: null }])('write refuses malformed record without a file: %j', (bad) => {
  mkdirSync(join(cwd, '.git'));
  expect(writeAwaitVerifyRecord({ cwd, record: bad })).toEqual({ ok: false, reason: 'malformed' });
  expect(existsSync(join(cwd, '.git', AWAIT_VERIFY_FILE))).toBe(false);
});
it('resolver catches a throwing reader and ignores missing cwd', () => {
  const resolver = makeAwaitingVerifyResolver({ now: () => nowMs, read: () => { throw Error('denied'); } });
  expect(resolver({ ...session, cwd })).toBeNull();
  expect(resolver(session)).toBeNull();
  expect(makeAwaitingVerifyResolver({ now: () => nowMs, read: () => record })({ ...session, cwd }, { pr: 4116 }).reason).toBe('other-pr');
});
it('CLI mark/show/clear in a temporary git repo binds the environment sessionId', () => {
  execFileSync('git', ['init', cwd], { stdio: 'pipe' });
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture'], { stdio: 'pipe' });
  const script = SCRIPT;
  const cli = (...args) => JSON.parse(execFileSync(process.execPath, [script, ...args, `--cwd=${cwd}`], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'cli-session', [AWAIT_VERIFY_STORE_ENV]: join(cwd, '.store') },
  }));
  const marked = cli('mark', '--repo=web-everything/web-everything', '--pr=4115', '--who=fix-4115');
  expect(marked).toMatchObject({ v: 1, sessionId: 'cli-session', who: 'fix-4115', pr: 4115, attempt: 1 });
  expect(marked.sha).toBe(execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  expect(cli('show')).toEqual(marked);
  expect(cli('clear')).toEqual({ cleared: true });
  expect(cli('show')).toBeNull();
  expect(cli('clear')).toEqual({ cleared: false });
});

it('failed atomic rename preserves the prior record and cleans its temporary file', () => {
  mkdirSync(join(cwd, '.git'));
  expect(writeAwaitVerifyRecord({ cwd, record }).ok).toBe(true);
  const result = writeAwaitVerifyRecord({ cwd, record: { ...record, attempt: 2 }, uniqueId: () => 'test',
    renameSyncFn: () => { throw Error('denied'); } });
  expect(result).toEqual({ ok: false, reason: 'write-failed' });
  expect(readAwaitVerifyRecord(cwd)).toEqual(record);
  expect(existsSync(join(cwd, '.git', `${AWAIT_VERIFY_FILE}.test.tmp`))).toBe(false);
});
it('CLI malformed mark refuses with exit 2 and writes no record', () => {
  mkdirSync(join(cwd, '.git'));
  const script = SCRIPT;
  let failure;
  try {
    execFileSync(process.execPath, [script, 'mark', `--cwd=${cwd}`, '--repo=owner/repo', '--who=fix-4115', '--pr=0', `--sha=${record.sha}`], { stdio: 'pipe' });
  } catch (error) { failure = error; }
  expect(failure?.status).toBe(2);
  expect(String(failure?.stderr)).toContain('malformed');
  expect(readAwaitVerifyRecord(cwd)).toBeNull();
});

describe('#5137 slices 2+3 — the shared store a dispatched session is found by', () => {
  const gitRepo = () => {
    execFileSync('git', ['init', cwd], { stdio: 'pipe' });
    execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture'], { stdio: 'pipe' });
  };
  const run = (args, store) => execFileSync(process.execPath, [SCRIPT, ...args, `--cwd=${cwd}`], {
    encoding: 'utf8', stdio: 'pipe', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'S-live', [AWAIT_VERIFY_STORE_ENV]: store },
  });
  const MARK = ['mark', '--repo=web-everything/web-everything', '--pr=4115', '--who=fix-4115', '--ref=lane/item-68b', '--kind=fix'];

  it('a real dispatched row (cwd = per-dispatch scratch dir, no .git) is seen as awaiting once its lane marks', () => {
    // Before this slice the resolver only read `<row.cwd>/.git/.fix-await-verify`, but a dispatched fixer's row
    // cwd is `.operations/dispatch/<uuid>` — never its lane — so the reaper exemption could never fire live.
    gitRepo();
    const store = join(cwd, '.store');
    const scratch = mkdtempSync(join(tmpdir(), 'dispatch-scratch-'));
    try {
      const marked = JSON.parse(run(MARK, store));
      expect(marked).toMatchObject({ sessionId: 'S-live', lane: execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(), ref: 'lane/item-68b', kind: 'fix' });
      const row = { sessionId: 'S-live', name: 'fix-4115', cwd: scratch, state: 'done' };
      const prior = process.env[AWAIT_VERIFY_STORE_ENV];
      process.env[AWAIT_VERIFY_STORE_ENV] = store; // the DEFAULT reader (what the reaper and claim sweep use)
      try {
        const resolver = makeAwaitingVerifyResolver({ now: () => Date.parse(marked.requestedAt) + 1000 });
        expect(resolver(row, { pr: 4115 })).toMatchObject({ awaiting: true, reason: 'awaiting-verify' });
        expect(resolver({ ...row, sessionId: 'someone-else', name: 'fix-9' }, { pr: 4115 })).toMatchObject({ awaiting: false });
      } finally { if (prior === undefined) delete process.env[AWAIT_VERIFY_STORE_ENV]; else process.env[AWAIT_VERIFY_STORE_ENV] = prior; }
      expect(readStoredAwaitVerify('S-live', { dir: store })).toMatchObject({ pr: 4115 });
      expect(listStoredAwaitVerify({ dir: store }).map((e) => e.key)).toEqual(['S-live']);
      expect(JSON.parse(run(['clear'], store))).toEqual({ cleared: true });
      expect(listStoredAwaitVerify({ dir: store })).toEqual([]);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });

  it('mark --ref refuses a dirty tree, a non-HEAD sha, a non-lane ref and an unknown kind (exit 2, nothing stored)', () => {
    gitRepo();
    const store = join(cwd, '.store');
    const fails = (args) => { try { run(args, store); return null; } catch (e) { return e; } };
    writeFileSync(join(cwd, 'untracked.txt'), 'x');
    expect(String(fails(MARK)?.stderr)).toMatch(/dirty working tree/);
    rmSync(join(cwd, 'untracked.txt'));
    expect(String(fails([...MARK, `--sha=${'b'.repeat(40)}`])?.stderr)).toMatch(/is not HEAD/);
    for (const ref of ['main', 'refs/heads/main', 'lane/../main']) expect(fails([...MARK.filter((a) => !a.startsWith('--ref')), `--ref=${ref}`])?.status).toBe(2);
    expect(String(fails([...MARK.filter((a) => !a.startsWith('--kind')), '--kind=build'])?.stderr)).toMatch(/--kind/);
    expect(listStoredAwaitVerify({ dir: store })).toEqual([]);
  });
});
