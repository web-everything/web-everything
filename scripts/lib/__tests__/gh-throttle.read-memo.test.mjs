import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as gh from '../gh-throttle.mjs';

const made = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-read-memo-'));
  made.push(dir);
  const memo = join(dir, 'memo');
  mkdirSync(memo);
  vi.stubEnv('WE_GH_READ_MEMO_DIR', enabled ? memo : undefined);
  if (!enabled) delete process.env.WE_GH_READ_MEMO_DIR;
  const bin = join(dir, 'fake-gh');
  writeFileSync(bin, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
appendFileSync(process.env.MEMO_TEST_COUNT, 'call\\n');
if (process.argv.includes('fail')) process.exit(1);
process.stdout.write(process.env.MEMO_TEST_OUTPUT || 'héllo\\n');
`);
  chmodSync(bin, 0o755);
  const countPath = join(dir, 'count');
  writeFileSync(countPath, '');
  const logPath = join(dir, 'calls.jsonl');
  const opts = {
    encoding: 'utf8',
    env: { ...process.env, MEMO_TEST_COUNT: countPath, GH_TOKEN: 'test', WE_GH_PERSONAL_READS: '0' },
    throttle: { bin, lockRoot: join(dir, 'locks'), logPath, op: 'memo-test', caller: 'memo-test',
      env: { ...process.env, GH_TOKEN: 'test', WE_GH_PERSONAL_READS: '0' }, maxAttempts: 1 },
  };
  return { dir, memo, opts, count: () => readFileSync(countPath, 'utf8').split('\n').length - 1,
    entries: () => readdirSync(memo).filter(name => name.endsWith('.json')),
    logs: () => readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}
const read = ['api', 'repos/example/project', '--method', 'GET'];

describe('smoke-scoped gh read memo', () => {
  it('exports the opt-in env name and shares identical reads', () => {
    const f = fixture();
    expect(gh.WE_GH_READ_MEMO_DIR).toBe('WE_GH_READ_MEMO_DIR');
    const first = gh.runGhSync(read, f.opts);
    expect(gh.runGhSync(read, f.opts)).toBe(first);
    expect(f.count()).toBe(1);
    expect(f.entries()).toHaveLength(1);
    expect(f.logs().filter(row => row.outcome === 'memo_hit')).toEqual([
      expect.objectContaining({ op: 'memo-test', caller: 'memo-test', points: 0 }),
    ]);
  });

  it.each([
    ['api', 'repos/example/project', '--method', 'POST'],
    ['pr', 'edit', '1', '--repo', 'example/project', '--title', 'title'],
    ['auth', 'token'],
  ])('does not memo writes or local calls: %j', (...args) => {
    const f = fixture();
    gh.runGhSync(args, f.opts);
    gh.runGhSync(args, f.opts);
    expect(f.count()).toBe(2);
    expect(f.entries()).toHaveLength(0);
  });

  it('leaves calls unchanged when unset', () => {
    const f = fixture(false);
    gh.runGhSync(read, f.opts);
    gh.runGhSync(read, f.opts);
    expect(f.count()).toBe(2);
    expect(f.entries()).toHaveLength(0);
  });

  it('never stores a failed read', () => {
    const f = fixture();
    for (let i = 0; i < 2; i++) expect(() => gh.runGhSync(['api', 'fail'], f.opts)).toThrow();
    expect(f.count()).toBe(2);
    expect(f.entries()).toHaveLength(0);
  });

  it('normalizes only If-None-Match header values', () => {
    const f = fixture();
    gh.runGhSync([...read, '-H', 'If-None-Match: "one"'], f.opts);
    gh.runGhSync([...read, '-H', 'If-None-Match: "two"'], f.opts);
    expect(f.count()).toBe(1);
    gh.runGhSync([...read, '-H', 'Accept: other'], f.opts);
    gh.runGhSync(['api', 'repos/example/other'], f.opts);
    expect(f.count()).toBe(3);
  });

  it.each(['utf8', 'buffer'])('round-trips %s and honors the next caller encoding', encoding => {
    const f = fixture();
    const first = gh.runGhSync(read, { ...f.opts, encoding });
    const second = gh.runGhSync(read, { ...f.opts, encoding });
    expect(second).toEqual(first);
    expect(Buffer.isBuffer(second)).toBe(encoding === 'buffer');
    expect(gh.runGhSync(read, { ...f.opts, encoding: encoding === 'utf8' ? undefined : 'utf8' }))
      .toEqual(encoding === 'utf8' ? Buffer.from(first) : first.toString('utf8'));
    expect(f.count()).toBe(1);
    const entry = JSON.parse(readFileSync(join(f.memo, f.entries()[0]), 'utf8'));
    expect(entry.encoding).toBe(encoding === 'buffer' ? 'base64' : 'utf8');
    expect(entry.args).toEqual(read);
  });

  it('treats corrupt entries as misses', () => {
    const f = fixture();
    gh.runGhSync(read, f.opts);
    const path = join(f.memo, f.entries()[0]);
    for (const bad of ['{', '{}', '{"stdout":42,"encoding":"utf8"}']) {
      writeFileSync(path, bad);
      expect(gh.runGhSync(read, f.opts)).toBe('héllo\n');
    }
    expect(f.count()).toBe(4);
  });

  it('bypasses the memo for injected exec and input', () => {
    const f = fixture();
    gh.runGhSync(read, f.opts);
    const exec = vi.fn(() => 'injected');
    expect(gh.runGhSync(read, { ...f.opts, throttle: { ...f.opts.throttle, exec } })).toBe('injected');
    gh.runGhSync(read, { ...f.opts, input: '' });
    gh.runGhSync(read, { ...f.opts, input: '' });
    expect(exec).toHaveBeenCalledOnce();
    expect(f.count()).toBe(3);
  });

  it('does not store nested deferred results', () => {
    const f = fixture();
    const opts = { ...f.opts, env: { ...f.opts.env, MEMO_TEST_OUTPUT: '{"outcome":"deferred-low-budget"}' } };
    expect(gh.isGhDeferred(gh.runGhSync(read, opts))).toBe(true);
    gh.runGhSync(read, opts);
    expect(f.count()).toBe(2);
    expect(f.entries()).toHaveLength(0);
  });

  it('does not store priority-admission deferrals', () => {
    const f = fixture();
    const now = Date.now();
    gh.recordGhHeadroom(f.opts.throttle.lockRoot, gh.ghAuthIdentity(f.opts.throttle.env), [
      { res: 'graphql', limit: 1000, rem: 5, reset: (now + 60000) / 1000 },
    ]);
    const opts = { ...f.opts, throttle: { ...f.opts.throttle, deferrable: true, now: () => now, warn: vi.fn() } };
    for (let i = 0; i < 2; i++) expect(gh.isGhDeferred(gh.runGhSync(['pr', 'list'], opts))).toBe(true);
    expect(f.count()).toBe(0);
    expect(f.entries()).toHaveLength(0);
  });
});
