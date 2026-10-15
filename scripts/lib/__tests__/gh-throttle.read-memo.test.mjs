import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
if (process.argv.some(arg => /If-None-Match:/i.test(arg))) {
  process.stdout.write(process.argv.some(arg => /If-None-Match: "current"/i.test(arg))
    ? 'HTTP/2.0 304 Not Modified\\n' : 'HTTP/2.0 200 OK\\n\\n{"version":"current"}');
  process.exit(0);
}
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

  it.each([
    ['-f', 'query=query { repository(owner:"example", name:"project") { name } }'],
    ['-F', 'query=  # read only\n{ viewer { login } }', '--paginate'],
    ['--field', 'query=query($name:String!){repository(name:$name){name}}', '--raw-field', 'name=project', '--jq', '.data', '--cache', '1h', '-H', 'Accept: application/json', '--include'],
    ['--raw-field=query={ viewer { login } }', '-q', '.data', '-i', '--header=Accept: application/json'],
  ])('memoises GraphQL queries without changing classification: %j', (...flags) => {
    const f = fixture();
    const args = ['api', 'graphql', ...flags];
    expect(gh.classifyGhRead(args)).toBe(false);
    expect(gh.isGhGraphqlReadQuery(args)).toBe(true);
    gh.runGhSync(args, f.opts);
    gh.runGhSync(args, f.opts);
    expect(f.count()).toBe(1);
  });

  it.each([
    ['-f', 'query=mutation { addComment(input:{body:"hi"}) { clientMutationId } }'],
    ['-f', 'query= # comment\nsubscription { viewer { login } }'],
    ['-f', 'query=query { viewer { login } } mutation { deleteIssue(input:{id:"1"}) { clientMutationId } }'],
    ['-f', 'query={ viewer { login } } subscription { viewer { login } }'],
    ['-f', 'query=query { viewer { login } }', '--method', 'POST'],
    ['-f', 'query=query { viewer { login } }', '--unknown'],
    ['-f', 'query=query { viewer { login } }', '--input', 'body.json'],
    ['-f', 'query=query { viewer { login } }', '-q'],
    ['-f', 'query=queryish { viewer { login } }'],
    ['-f', 'name=project'],
  ])('does not memoise ambiguous or non-read GraphQL calls: %j', (...flags) => {
    const f = fixture();
    const args = ['api', 'graphql', ...flags];
    expect(gh.classifyGhRead(args)).toBe(false);
    gh.runGhSync(args, f.opts);
    gh.runGhSync(args, f.opts);
    expect(f.count()).toBe(2);
    expect(f.entries()).toHaveLength(0);
    expect(gh.isGhGraphqlReadQuery(args)).toBe(false);
  });

  it('ignores operation words inside query fields, strings and comments', () => {
    expect(gh.isGhGraphqlReadQuery(['api', 'graphql', '-f',
      'query= # mutation\nquery { mutation subscription search(query:"mutation { }") { name } } # subscription',
    ])).toBe(true);
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

  it.each([
    ['-H', 'If-None-Match:'], ['--header', 'if-none-match:'],
    ['-HIf-None-Match:'], ['--header=If-None-Match:'],
  ])('keeps distinct conditional validators separate: %j', (...header) => {
    const f = fixture();
    const args = value => [...read, ...header.slice(0, -1), `${header.at(-1)} "${value}"`];
    for (let i = 0; i < 2; i++) {
      expect(gh.runGhSync(args('current'), f.opts)).toContain('304 Not Modified');
      expect(gh.runGhSync(args('old'), f.opts)).toContain('200 OK\n\n{"version":"current"}');
    }
    expect(f.count()).toBe(2);
  });

  it.each(['cwd', 'GH_REPO', 'GH_HOST', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
    'GH_CONFIG_DIR', 'GIT_DIR', 'WE_GITHUB_APP_ROLE', 'WE_GITHUB_APP_INSTALLATION_ID'])
  ('separates identical arguments by effective context: %s', key => {
    const f = fixture();
    const call = value => {
      const env = { ...f.opts.env, MEMO_TEST_OUTPUT: value };
      if (key !== 'cwd') env[key] = value;
      if (key === 'GITHUB_TOKEN') delete env.GH_TOKEN;
      const cwd = key === 'cwd' ? join(f.dir, value) : f.dir;
      mkdirSync(cwd, { recursive: true });
      return gh.runGhSync(['pr', 'list'], { ...f.opts, cwd, env });
    };
    expect(call('first')).toBe('first');
    expect(call('second')).toBe('second');
    expect(call('first')).toBe('first');
    expect(f.count()).toBe(2);
  });

  it('separates unknown App tokens even though they share a throttle bucket', () => {
    const f = fixture();
    for (const token of ['ghs_first', 'ghs_second']) {
      expect(gh.ghAuthIdentity({ GH_TOKEN: token })).toBe('app');
      expect(gh.runGhSync(read, { ...f.opts, env: { ...f.opts.env, GH_TOKEN: token, MEMO_TEST_OUTPUT: token } })).toBe(token);
    }
    expect(f.count()).toBe(2);
  });

  it('keys ambient child credentials and repo when only throttle.env is supplied', () => {
    const f = fixture();
    const { env: ignoredChildEnv, ...opts } = f.opts;
    vi.stubEnv('MEMO_TEST_COUNT', join(f.dir, 'count'));
    for (const value of ['first', 'second']) {
      vi.stubEnv('GH_TOKEN', value);
      vi.stubEnv('GH_REPO', `fixture/${value}`);
      vi.stubEnv('MEMO_TEST_OUTPUT', value);
      expect(gh.runGhSync(['pr', 'list'], opts)).toBe(value);
    }
    expect(f.count()).toBe(2);
  });

  it('keeps telemetry-only callers shareable with direct gh credentials', () => {
    const f = fixture();
    for (const GH_CALLER of ['rebuild-smoke:reconcile-dry-run', 'rebuild-smoke:dispatch-dry-run']) {
      gh.runGhSync(read, { ...f.opts, env: { ...f.opts.env, GH_CALLER } });
    }
    expect(f.count()).toBe(1);
  });

  it.each(['absolute', 'relative-bin', 'relative-path'])('separates caller-selected App shim identities: %s', mode => {
    const f = fixture();
    const bin = f.opts.throttle.bin;
    writeFileSync(bin, readFileSync(bin, 'utf8').replace('#!/usr/bin/env node',
      '#!/usr/bin/env node\n// AUTO-GENERATED by we:scripts/lib/gh-app-shim.mjs'));
    for (const GH_CALLER of ['reviewer', 'worker']) {
      const env = { ...f.opts.env, GH_CALLER, MEMO_TEST_OUTPUT: GH_CALLER };
      if (mode === 'relative-path') env.PATH = `.:${env.PATH}`;
      const opts = { ...f.opts, cwd: f.dir, env,
        throttle: { ...f.opts.throttle, bin: mode === 'relative-bin' ? './fake-gh' : mode === 'relative-path' ? 'fake-gh' : bin } };
      expect(gh.runGhSync(read, opts)).toBe(GH_CALLER);
    }
    expect(f.count()).toBe(2);
  });

  it('bypasses memo when personal routing can change the effective identity on fallback', () => {
    const f = fixture();
    const opts = { ...f.opts, env: { ...f.opts.env, GH_TOKEN: 'ghs_app' },
      throttle: { ...f.opts.throttle, personalRoute: true, personalToken: 'personal-token' } };
    gh.runGhSync(read, opts);
    gh.runGhSync(read, opts);
    expect(f.count()).toBe(2);
    expect(f.entries()).toHaveLength(0);
  });

  it.each([['-F', 'name=@value'], ['--field', 'name=@value'], ['--field=name=@value']])
  ('bypasses reads with file-backed inputs: %j', (...flags) => {
    const f = fixture();
    const path = join(f.dir, 'value');
    writeFileSync(path, 'first');
    const args = ['api', 'graphql', '-f', 'query=query($name:String!){repository(name:$name){name}}', ...flags];
    expect(gh.isGhGraphqlReadQuery(args)).toBe(true);
    gh.runGhSync(args, { ...f.opts, cwd: f.dir });
    writeFileSync(path, 'second');
    gh.runGhSync(args, { ...f.opts, cwd: f.dir });
    expect(f.count()).toBe(2);
    expect(f.entries()).toHaveLength(0);
  });

  it('does not recreate a memo directory after smoke cleanup', () => {
    const f = fixture();
    rmSync(f.memo, { recursive: true });
    expect(gh.runGhSync(read, f.opts)).toBe('héllo\n');
    expect(existsSync(f.memo)).toBe(false);
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
