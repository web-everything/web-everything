// Imported source is a direct test input, so Vitest related selects this test without a repository scan.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import productionSource from '../host-credential-cutover.mjs?raw';
import * as production from '../host-credential-cutover.mjs';
import { VARIANTS } from './__fixtures__/inventory-unsafe.mjs';

const spawnControl = vi.hoisted(() => ({ adapter: false }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, spawn: vi.fn((executable, argv, options) => {
    if (!spawnControl.adapter || !['/usr/bin/env', '/bin/echo', '/bin/sleep'].includes(executable)) {
      throw new Error('Uninjected child process');
    }
    return actual.spawn(executable, argv, options);
  }) };
});
import { spawn } from 'node:child_process';

const lane = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const subject = process.env.INVENTORY_MODULE
  ? await import(/* @vite-ignore */ join(lane, process.env.INVENTORY_MODULE)) : production;
const ORGS = ['web-everything', 'plateauapp', 'frontier-ui', 'longshoreai'];
const O = ORGS[0];
const SHA = 'a'.repeat(40);
const NOW = new Date('2026-11-27T16:00:00.000Z');
const SECRET = 'ghp_abcdefgh1234';
const titles = [];
const test = (variant, title, body) => {
  const name = `[${variant}] ${title}`;
  titles.push(name);
  it(name, body);
};
const roots = ['user', 'memberships', ...ORGS.flatMap(o =>
  ['membership', 'org', 'installations', 'orgRulesets', 'repos'].map(kind => `${kind}:${o}`))];
let temp;
let home;
let lines;
let options;
let calls;
let ioCalls;

function response(body, status = 200, headers = {}) {
  return { code: status === 200 ? 0 : 1, timedOut: false, stderr: '',
    stdout: `HTTP/2.0 ${status} Status\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n${typeof body === 'string' ? body : JSON.stringify(body)}` };
}
function runner(overrides = () => undefined) {
  const counts = new Map();
  return async (executable, argv, opts) => {
    calls.push({ executable, argv, opts });
    const url = new URL(argv.at(-1), 'https://api.github.com');
    const key = url.pathname;
    const count = (counts.get(key) || 0) + 1;
    counts.set(key, count);
    const changed = overrides({ url, count, executable, argv, opts });
    if (changed !== undefined) return changed;
    if (key === '/user') return response({ login: 'chalbert' }, 200, { 'x-oauth-scopes': 'repo, read:org, workflow' });
    if (key === '/user/memberships/orgs') return response(ORGS.map(login => ({ state: 'active', role: 'admin', organization: { login } })));
    if (/^\/user\/memberships\/orgs\//.test(key)) return response({ state: 'active', role: 'admin' });
    if (/^\/orgs\/[^/]+$/.test(key)) return response({ public_repos: 1, total_private_repos: 0 });
    if (key.endsWith('/installations')) return response({ total_count: 1, installations: [
      { id: 1, app_id: 2, app_slug: 'observer', repository_selection: 'all', permissions: { administration: 'read', contents: 'read' } },
    ] });
    if (key.endsWith('/repos')) return response([{ name: 'repo', archived: true, fork: true }]);
    if (key.endsWith('/rulesets')) return response([{ id: 7 }]);
    if (key.endsWith('/rulesets/7')) return response({ source_type: 'Repository', bypass_actors: [] });
    throw new Error('Unexpected fake endpoint');
  };
}
beforeEach(async () => {
  temp = await fs.realpath(await fs.mkdtemp(join(process.env.TMPDIR, 'hca-')));
  home = join(temp, 'home');
  await fs.mkdir(home);
  lines = { stdout: [], stderr: [] };
  calls = []; ioCalls = [];
  const io = new Proxy(fs, { get(target, key) {
    if (typeof target[key] !== 'function') return target[key];
    return (...args) => {
      if (typeof args[0] === 'string') {
        ioCalls.push([key, args[0]]);
        expect(args[0] === temp || args[0].startsWith(temp + '/'), `fixture IO ${String(key)}`).toBe(true);
      }
      return target[key](...args);
    };
  } });
  options = { root: temp, home, fs: io, now: () => new Date(NOW), randomBytes: () => Buffer.from('12345678', 'hex'),
    commit: SHA, run: runner(), stdout: s => lines.stdout.push(s), stderr: s => lines.stderr.push(s) };
  spawnControl.adapter = false;
  vi.mocked(spawn).mockClear();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  spawnControl.adapter = false;
  await fs.rm(temp, { recursive: true, force: true });
});
const source = (record, id) => record.sources.find(s => s.id === id);
async function collect(overrides) {
  if (overrides) options.run = runner(overrides);
  return subject.inventory(options);
}
async function decide(record, extra = {}) {
  const runId = extra.runId ?? record.runId;
  await fs.writeFile(join(temp, 'state/credential-cutover/runs', runId, 'inventory.json'), JSON.stringify(record));
  return subject.aggregate({ ...options, runId, ...extra });
}
async function checkDecision(overrides, exitCode, reason) {
  const run = await collect(overrides);
  const out = await subject.aggregate({ ...options, runId: run.record.runId });
  expect(out.exitCode).toBe(exitCode);
  if (reason) expect(JSON.stringify(out)).toContain(reason);
  return { run, out };
}
const actorResponse = (actor_type, actor_id, bypass_mode = 'always', source_type = 'Repository') =>
  response({ source_type, bypass_actors: [{ actor_type, actor_id, bypass_mode }] });
const detail = `/repos/${O}/repo/rulesets/7`;

describe('pinned transport and bounded adapter', () => {
  test('shell-true', 'spawn uses argv literally and shell false', async () => {
    spawnControl.adapter = true;
    const pwned = join(temp, 'pwned');
    const literal = `$(touch ${pwned})`;
    const out = await subject.spawnBounded('/bin/echo', [literal], { env: subject.childEnvironment(home), timeoutMs: 200 });
    expect(out.stdout.trim()).toBe(literal);
    expect(spawn).toHaveBeenCalledWith('/bin/echo', [literal], expect.objectContaining({ shell: false, stdio: ['ignore', 'pipe', 'pipe'] }));
    await expect(fs.lstat(pwned)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(subject.defaultRunner).toBe(subject.spawnBounded);
  });
  test('inherit-env', 'adapter receives only the explicit environment', async () => {
    spawnControl.adapter = true;
    vi.stubEnv('GH_TOKEN', 'x'); vi.stubEnv('WE_OPERATOR_LOGINS', 'evil');
    const env = subject.childEnvironment(home);
    const out = await subject.spawnBounded('/usr/bin/env', [], { env, timeoutMs: 1000 });
    expect(out.code).toBe(0);
    expect(out.stdout.trim().split('\n').sort()).toEqual(Object.entries(env).map(([k, v]) => `${k}=${v}`).sort());
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH', 'LANG', 'NO_COLOR', 'GH_NO_UPDATE_NOTIFIER', 'GH_PROMPT_DISABLED', 'GH_PAGER'].sort());
  });
  test('no-timeout', 'sleep is killed and reaped before returning', async () => {
    spawnControl.adapter = true;
    const start = performance.now();
    const out = await subject.spawnBounded('/bin/sleep', ['60'], { env: subject.childEnvironment(home), timeoutMs: 200 });
    expect(out.timedOut).toBe(true);
    expect(performance.now() - start).toBeLessThan(2000);
    const child = vi.mocked(spawn).mock.results.at(-1).value;
    expect(child.signalCode).toBe('SIGKILL');
    expect(child.killed).toBe(true);
  });
  test('trust-env-operators', 'operator override cannot widen the reader pin', async () => {
    vi.stubEnv('WE_OPERATOR_LOGINS', 'evil');
    const out = await collect(({ url }) => url.pathname === '/user' ? response({ login: 'evil' }, 200, { 'x-oauth-scopes': 'repo, admin:org' }) : undefined);
    expect(out.record.fatal).toBe('READER-NOT-OPERATOR');
    expect(out.record.readerLogin).toBeNull();
  });
  test('trust-any-login', 'a different reader is fatal and persisted as ERROR', async () => {
    const out = await collect(({ url }) => url.pathname === '/user' ? response({ login: 'outsider' }, 200, { 'x-oauth-scopes': 'repo, admin:org' }) : undefined);
    expect(out.record.fatal).toBe('READER-NOT-OPERATOR');
    expect((await subject.aggregate({ ...options, runId: out.record.runId })).exitCode).toBe(1);
    expect(calls).toHaveLength(1);
  });
  for (const variant of ['read-gh-config', 'token-read']) test(variant, 'credential files remain opaque to inventory', async () => {
    await fs.mkdir(join(home, '.config/gh'), { recursive: true });
    await fs.mkdir(join(home, '.claude'));
    await fs.writeFile(join(home, '.config/gh/hosts.yml'), `oauth_token: ${SECRET}`);
    await fs.writeFile(join(home, '.claude/github-app-token'), SECRET);
    vi.stubEnv('GH_TOKEN', SECRET);
    const out = await collect();
    expect(out.exitCode).toBe(0);
    expect(ioCalls.filter(([, path]) => path.startsWith(home))).toEqual([]);
    expect(calls.every(c => !('GH_TOKEN' in c.opts.env))).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });
  for (const variant of ['post', 'paginate-flag']) test(variant, 'every child is the exact GET-only gh transport', async () => {
    await collect();
    expect(calls.length).toBeGreaterThan(44);
    for (const call of calls) {
      expect(call.executable).toBe('/opt/homebrew/bin/gh');
      expect(call.argv.slice(0, -1)).toEqual(['api', '--include', '--method', 'GET']);
      expect(call.opts).toEqual({ env: subject.childEnvironment(home), timeoutMs: 30000 });
      expect(call.argv.at(-1)).toMatch(/^\/(user|orgs|repos)(\/|$)/);
    }
    expect(spawn).not.toHaveBeenCalled();
  });
  it('scans only imported subject source copied into an injected fixture root', async () => {
    const scanRoot = join(temp, 'scan'); await fs.mkdir(scanRoot);
    const file = join(scanRoot, 'subject.mjs'); await fs.writeFile(file, productionSource);
    const text = await fs.readFile(file, 'utf8');
    const imports = [...text.matchAll(/(?:from\s*|import\s*\()(['"])([^'"]+)\1/g)].map(m => m[2]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every(s => s.startsWith('node:'))).toBe(true);
    expect(text).not.toMatch(/marker-authorship\.mjs|operator-identity\.mjs/);
  });
});

describe('evidence and cohort', () => {
  it('writes one exclusive inventory and aggregate with complete typed metadata', async () => {
    const out = await collect();
    expect(out.exitCode).toBe(0); expect(out.record.sources.length).toBe(34);
    expect(subject.validateRecord(out.record)).toBe(true);
    expect(lines.stdout[0]).toBe(`runId=${out.record.runId}\n`);
    expect(out.record.startedAt).toBe('2026-11-27T11:00:00-05:00');
    const decision = await subject.aggregate({ ...options, runId: out.record.runId });
    expect(decision.exitCode).toBe(0); expect(decision.result).toBe('COMPLETE');
    const runDir = join(temp, 'state/credential-cutover/runs', out.record.runId);
    expect((await fs.readdir(runDir)).sort()).toEqual(['inventory.json', 'result.txt']);
    const result = await fs.readFile(join(runDir, 'result.txt'), 'utf8');
    expect(result).toMatch(/^COMPLETE runId=\d{8}T\d{6}-[a-f0-9]{8} freshUntil=2026-11-28T11:00:00-05:00\n$/);
  });
  test('drop-root', 'all required roots and descendants are required', async () => {
    const out = await collect();
    const original = out.record;
    for (const id of [...roots, 'ALL', 'TREE']) {
      const record = structuredClone(original);
      record.sources = id === 'ALL' ? [] : record.sources.filter(s => s.id !== (id === 'TREE' ? `repos:${O}` : id)
        && !(id === 'TREE' && s.id.startsWith(`repoRuleset`) && s.id.includes(`${O}/`)));
      expect((await decide(record)).exitCode, id).toBe(20);
      await fs.unlink(join(temp, 'state/credential-cutover/runs', record.runId, 'result.txt'));
    }
  });
  test('trust-persisted-findings', 'schema rejects findings and recomputes bypass from data', async () => {
    const { record } = await collect();
    expect((await decide({ ...record, findings: [] })).exitCode).toBe(20);
    await fs.unlink(join(temp, 'state/credential-cutover/runs', record.runId, 'result.txt'));
    source(record, `repoRuleset:${O}/repo:7`).data.bypass_actors = [{ actor_type: 'Integration', actor_id: 12, bypass_mode: 'always' }];
    const out = await decide(record);
    expect(out.exitCode).toBe(10); expect(out.findings).toContainEqual(expect.objectContaining({ code: 'APP-BYPASS' }));
  });
  test('loose-metadata', 'metadata, commit and source grammar fail closed', async () => {
    const { record } = await collect();
    const cases = [r => { r.startedAt = '2026-11-27T16:00:00Z'; }, r => { r.readerLogin = 'evil'; },
      r => { r.weCommit = 'a'.repeat(7); }, r => { r.sources[0].id = 'bogus'; }];
    for (const change of cases) {
      const r = structuredClone(record); change(r);
      expect((await decide(r)).exitCode).toBe(20);
      await fs.unlink(join(temp, 'state/credential-cutover/runs', r.runId, 'result.txt'));
    }
    for (const commit of [undefined, 'a'.repeat(7)]) {
      const out = await subject.inventory({ ...options, commit }); expect(out.exitCode).toBe(1);
    }
  });
  const invalids = {
    'extra top-level': r => { r.extra = true; }, 'extra source key': r => { r.sources[0].extra = true; },
    'null read data': r => { r.sources[0].data = null; }, 'duplicate source': r => { r.sources.push(r.sources[0]); },
    'missing child': r => { r.sources = r.sources.filter(s => s.id !== `repoRuleset:${O}/repo:7`); },
    orphan: r => { r.sources.push({ id: `repoRuleset:${O}/ghost:7`, parent: `repoRulesets:${O}/ghost`, state: 'read', reason: null, status: 200, data: { source_type: 'Repository', bypass_actors: [] } }); },
    'wrong parent': r => { source(r, `repoRulesets:${O}/repo`).parent = 'user'; },
    'read status 304': r => { r.sources[0].status = 304; }, 'non-admin membership': r => { source(r, `membership:${O}`).data.role = 'member'; },
    'user disagreement': r => { r.sources[0].data.login = 'evil'; },
    'missing installation count': r => { delete source(r, `installations:${O}`).data.total_count; },
    'missing inherited type': r => { delete source(r, `repoRuleset:${O}/repo:7`).data.source_type; },
    'inverted time': r => { r.finishedAt = '2026-11-27T10:59:59-05:00'; },
    'future time': r => { r.finishedAt = '2026-11-27T11:00:01-05:00'; },
    '3 hour run': r => { r.startedAt = '2026-11-27T08:00:00-05:00'; },
  };
  for (const [name, change] of Object.entries(invalids)) it(`COHORT: ${name}`, async () => {
    const { record } = await collect(); change(record);
    const out = await decide(record); expect(out.exitCode).toBe(20); expect(out.reasons).toContain('COHORT');
  });
  test('mix-runs', 'a directory cannot borrow another run identity', async () => {
    const { record } = await collect();
    const runId = record.runId; record.runId = '20261127T110000-87654321';
    const out = await decide(record, { runId }); expect(out.exitCode).toBe(20);
  });
  test('accept-stale', 'freshUntil is based on earliest observation and is checked at the boundary', async () => {
    const { record } = await collect();
    const path = join(temp, 'state/credential-cutover/runs', record.runId, 'result.txt');
    const at = delta => () => new Date(NOW.getTime() + delta);
    expect((await decide(record, { now: at(86400000 - 1000) })).exitCode).toBe(0);
    await fs.unlink(path);
    expect((await decide(record, { now: at(86400000 + 1000) })).exitCode).toBe(20);
  });
  test('follow-symlink', 'both modes refuse every symlink ancestor and create nothing outside', async () => {
    for (const ancestor of ['state', 'state/credential-cutover', 'state/credential-cutover/runs']) {
      const root = join(temp, ancestor.replaceAll('/', '-')); await fs.mkdir(root);
      const outside = join(temp, `outside-${ancestor.replaceAll('/', '-')}`); await fs.mkdir(outside);
      await fs.mkdir(dirname(join(root, ancestor)), { recursive: true });
      await fs.symlink(outside, join(root, ancestor));
      const before = await fs.readdir(outside);
      expect((await subject.inventory({ ...options, root })).exitCode).toBe(1);
      expect((await subject.aggregate({ ...options, root, runId: '20261127T110000-12345678' })).exitCode).toBe(1);
      expect(await fs.readdir(outside)).toEqual(before);
    }
  });
  it('refuses symlinked run, symlinked evidence, repeat writes and path escapes', async () => {
    const { record } = await collect();
    const runDir = join(temp, 'state/credential-cutover/runs', record.runId);
    expect((await subject.inventory(options)).exitCode).toBe(1);
    expect((await subject.aggregate({ ...options, runId: '../x' })).exitCode).toBe(1);
    await fs.rename(join(runDir, 'inventory.json'), join(temp, 'evidence'));
    expect((await subject.aggregate({ ...options, runId: record.runId })).exitCode).toBe(20);
    await fs.unlink(join(runDir, 'result.txt'));
    await fs.symlink(join(temp, 'evidence'), join(runDir, 'inventory.json'));
    expect((await subject.aggregate({ ...options, runId: record.runId })).exitCode).toBe(1);
    await fs.unlink(join(runDir, 'inventory.json'));
    await fs.rmdir(runDir); await fs.symlink(home, runDir);
    expect((await subject.aggregate({ ...options, runId: record.runId })).exitCode).toBe(1);
  });
  it('second aggregate refuses without overwriting its original evidence', async () => {
    const { record } = await collect();
    expect((await subject.aggregate({ ...options, runId: record.runId })).exitCode).toBe(0);
    expect((await subject.aggregate({ ...options, runId: record.runId })).exitCode).toBe(1);
  });
  it('aggregation reads only the named run even with a clean sibling beside it', async () => {
    const a = await collect(({ url }) => url.pathname === detail ? actorResponse('Integration', 12) : undefined);
    options.randomBytes = () => Buffer.from('87654321', 'hex');
    options.run = runner(); const b = await collect();
    expect(a.record.runId).not.toBe(b.record.runId);
    expect((await subject.aggregate({ ...options, runId: a.record.runId })).exitCode).toBe(10);
    await expect(fs.lstat(join(temp, 'state/credential-cutover/runs', b.record.runId, 'result.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('inventory refuses a competing evidence symlink at its exclusive open', async () => {
    const target = join(home, 'untouched'); await fs.writeFile(target, 'original');
    const io = { ...options.fs, mkdir: async (path, ...args) => {
      await options.fs.mkdir(path, ...args);
      if (/\d{8}T\d{6}-[a-f0-9]{8}$/.test(path)) await fs.symlink(target, join(path, 'inventory.json'));
    } };
    const out = await subject.inventory({ ...options, fs: io });
    expect(out.exitCode).toBe(1); expect(await fs.readFile(target, 'utf8')).toBe('original');
  });
  it('concurrent aggregates produce exactly one exclusive decision', async () => {
    const { record } = await collect();
    const results = await Promise.all([subject.aggregate({ ...options, runId: record.runId }), subject.aggregate({ ...options, runId: record.runId })]);
    expect(results.map(r => r.exitCode).sort()).toEqual([0, 1]);
  });
  it('unreadable and non-JSON evidence are incomplete cohorts', async () => {
    const { record } = await collect();
    const directory = join(temp, 'state/credential-cutover/runs', record.runId);
    // Preserve the real open flags for the result sink; only evidence reads fail.
    const inaccessible = { ...options.fs, open: async (path, ...args) => {
      if (path.endsWith('inventory.json')) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' });
      return options.fs.open(path, ...args);
    } };
    expect((await subject.aggregate({ ...options, fs: inaccessible, runId: record.runId })).exitCode).toBe(20);
    await fs.unlink(join(directory, 'result.txt'));
    await fs.writeFile(join(directory, 'inventory.json'), '{');
    expect((await subject.aggregate({ ...options, runId: record.runId })).exitCode).toBe(20);
  });
});

describe('read completeness, pagination and authority', () => {
  it('rate limits are not retried inside the snapshot run', async () => {
    const { out } = await checkDecision(({ url }) => url.pathname === detail ? response({}, 429, { 'retry-after': '1' }) : undefined, 20, 'RATE-LIMITED');
    expect(calls.filter(c => new URL(c.argv.at(-1), 'https://api.github.com').pathname === detail)).toHaveLength(1);
    expect(out.result).toBe('INCOMPLETE');
  });
  test('treat-error-as-empty', 'all bad statuses and unreadable bodies hold with named reasons', async () => {
    const cases = [
      [response({}, 401), 1, 'AUTH-FAILED'], [response({}, 403, { 'x-ratelimit-remaining': '0' }), 20, 'RATE-LIMITED'],
      [response({}, 429, { 'retry-after': '60' }), 20, 'RATE-LIMITED'], ...[403, 404, 302, 418, 502].map(s => [response({}, s), 20, 'UNREAD']),
      [{ timedOut: true }, 20, 'UNREAD'], [{ code: 1, stdout: '', stderr: SECRET }, 20, 'UNREAD'],
      [response('not json'), 20, 'MALFORMED'], [response({ source_type: 'Repository' }), 20, 'UNKNOWN'],
      [actorResponse('Robot', 1), 20, 'UNKNOWN'],
    ];
    for (let i = 0; i < cases.length; i++) {
      options.randomBytes = () => Buffer.from(i.toString(16).padStart(8, '0'), 'hex');
      const [res, exit, reason] = cases[i];
      await checkDecision(({ url }) => url.pathname === detail ? res : undefined, exit, reason);
    }
  });
  test('trust-short-page', 'short and full final pages need no next link', async () => {
    for (const n of [1, 100]) {
      options.randomBytes = () => Buffer.from(n.toString(16).padStart(8, '0'), 'hex');
      await checkDecision(({ url }) => {
        if (url.pathname === `/orgs/${O}`) return response({ public_repos: n, total_private_repos: 0 });
        if (url.pathname === `/orgs/${O}/repos`) return response(Array.from({ length: n }, (_, i) => ({ name: `r${i}` })));
      }, 0);
    }
  });
  test('follow-cycle', 'malformed, hostile, cyclic and oversized pagination stops with MALFORMED', async () => {
    const cases = [() => 'garbage', () => '<https://evil.test/orgs/x>; rel="next"',
      () => `<https://api.github.com/orgs/${O}/rulesets?per_page=100&page=2>; rel="next"`,
      () => `<https://api.github.com/orgs/${O}/repos?type=all&per_page=1&page=2>; rel="next"`,
      () => `<https://api.github.com/orgs/${O}/repos?type=all&per_page=100&page=1>; rel="next"`,
      page => `<https://api.github.com/orgs/${O}/repos?type=all&per_page=100&page=${page + 1}>; rel="next"`];
    for (let i = 0; i < cases.length; i++) {
      options.randomBytes = () => Buffer.from(i.toString(16).padStart(8, '0'), 'hex');
      await checkDecision(({ url }) => url.pathname === `/orgs/${O}/repos`
        ? response([], 200, { link: cases[i](Number(url.searchParams.get('page') || 1)) }) : undefined, 20, 'MALFORMED');
    }
    expect(calls.length).toBeLessThan(600);
  });
  for (const variant of ['sample-repos', 'skip-detail']) test(variant, 'page-two repo bypass cannot be omitted', async () => {
    const { out } = await checkDecision(({ url }) => {
      if (url.pathname === `/orgs/${O}`) return response({ public_repos: 2, total_private_repos: 0 });
      if (url.pathname === `/orgs/${O}/repos`) return url.searchParams.get('page') === '2'
        ? response([{ name: 'hidden' }]) : response([{ name: 'repo' }], 200, { link: `<https://api.github.com/orgs/${O}/repos?type=all&per_page=100&page=2>; rel="next"` });
      if (url.pathname === `/repos/${O}/hidden/rulesets/7`) return actorResponse('Integration', 22);
    }, 10, 'APP-BYPASS');
    expect(out.findings.some(f => f.source === `repoRuleset:${O}/hidden:7`)).toBe(true);
  });
  test('numeric-actor-only', 'actor nullability, numeric IDs and modes follow their type contract', async () => {
    const cases = [['OrganizationAdmin', null, 'exempt', 0, 'HUMAN-BYPASS'], ['DeployKey', null, 'always', 10, 'KEY-BYPASS'],
      ['Integration', null, 'always', 20, 'UNKNOWN'], ['Integration', '123', 'always', 20, 'UNKNOWN'],
      ['Team', 12, 'sometimes', 20, 'UNKNOWN'], ['Team', 'bad', 'always', 20, 'REDACTED-FIELD']];
    for (let i = 0; i < cases.length; i++) {
      options.randomBytes = () => Buffer.from(i.toString(16).padStart(8, '0'), 'hex');
      const [type, id, mode, exit, reason] = cases[i];
      await checkDecision(({ url }) => url.pathname === `/orgs/${O}/rulesets/7` ? actorResponse(type, id, mode) : undefined, exit, reason);
    }
  });
  for (const variant of ['ignore-org-admin', 'ignore-admin-level']) test(variant, 'all forms of App administration block', async () => {
    const cases = [{ organization_administration: 'write' }, { administration: 'admin' }, { contents: 'admin' },
      { custom_administration: 'write' }, { administration: 'read' }];
    for (let i = 0; i < cases.length; i++) {
      options.randomBytes = () => Buffer.from(i.toString(16).padStart(8, '0'), 'hex');
      await checkDecision(({ url }) => url.pathname === `/orgs/${O}/installations` ? response({ total_count: 1,
        installations: [{ id: 1, app_id: 2, app_slug: 'worker', repository_selection: 'selected', permissions: cases[i] }] }) : undefined,
      i === 4 ? 0 : 10, i === 4 ? undefined : 'APP-ADMIN');
    }
  });
  test('skip-counts', 'scope visibility and both counts are mandatory', async () => {
    const cases = [
      [({ url }) => url.pathname === '/user' ? response({ login: 'chalbert' }, 200, { 'x-oauth-scopes': 'read:org' }) : undefined, 1, 'READER-SCOPE'],
      [({ url }) => url.pathname === detail ? response({}, 200, { 'x-github-sso': 'required' }) : undefined, 20, 'UNREAD'],
      [({ url }) => url.pathname === `/orgs/${O}` ? response({ public_repos: 2, total_private_repos: 0 }) : undefined, 20, 'COHORT'],
      [({ url }) => url.pathname === `/orgs/${O}/installations` ? response({ total_count: 1, installations: [] }) : undefined, 20, 'COHORT'],
    ];
    for (let i = 0; i < cases.length; i++) { options.randomBytes = () => Buffer.from(i.toString(16).padStart(8, '0'), 'hex'); await checkDecision(...cases[i]); }
  });
  test('skip-second-pass', 'second pass compares complete data including unchanged IDs', async () => {
    const cases = [
      ({ url, count }) => count > 1 && url.pathname === `/orgs/${O}/repos` ? response([{ name: 'changed' }]) : undefined,
      ({ url, count }) => count > 1 && url.pathname === `/orgs/${O}/installations` ? response({ total_count: 1,
        installations: [{ id: 1, app_id: 2, app_slug: 'observer', repository_selection: 'all', permissions: { administration: 'write' } }] }) : undefined,
      ({ url, count }) => count > 1 && url.pathname === detail ? actorResponse('Integration', 42) : undefined,
    ];
    for (let i = 0; i < cases.length; i++) { options.randomBytes = () => Buffer.from(i.toString(16).padStart(8, '0'), 'hex'); await checkDecision(cases[i], 20, 'UNSTABLE'); }
  });
  test('repo-only-rulesets', 'organization and inherited enterprise bypasses are included', async () => {
    for (const [i, path, type, id, code] of [[0, `/orgs/${O}/rulesets/7`, 'Integration', 12, 'APP-BYPASS'],
      [1, `/orgs/${O}/rulesets/7`, 'DeployKey', null, 'KEY-BYPASS'], [2, detail, 'Integration', 12, 'APP-BYPASS']]) {
      options.randomBytes = () => Buffer.from(i.toString(16).padStart(8, '0'), 'hex');
      await checkDecision(({ url }) => url.pathname === path ? actorResponse(type, id, 'pull_request', 'Enterprise') : undefined, 10, code);
    }
    expect(calls.filter(c => c.argv.at(-1).startsWith('/repos/')).every(c => c.argv.at(-1).includes('includes_parents=true'))).toBe(true);
  });
  test('page-two-unread', 'second-page errors drop partial data and preserve their classification', async () => {
    const cases = [[response({}, 401), 1, 'AUTH-FAILED'], [response({}, 429, { 'retry-after': '1' }), 20, 'RATE-LIMITED'],
      [response('bad json'), 20, 'MALFORMED']];
    for (let i = 0; i < cases.length; i++) {
      options.randomBytes = () => Buffer.from(i.toString(16).padStart(8, '0'), 'hex');
      const [bad, exit, reason] = cases[i];
      const { run } = await checkDecision(({ url }) => url.pathname === `/orgs/${O}/repos` ? url.searchParams.has('page') ? bad
        : response([{ name: 'repo' }], 200, { link: `<https://api.github.com/orgs/${O}/repos?type=all&per_page=100&page=2>; rel="next"` }) : undefined, exit, reason);
      if (exit === 1) expect(run.record.sources).toEqual([]);
      else expect(source(run.record, `repos:${O}`).data).toBeNull();
    }
  });
  it('non-admin memberships hold and unlisted org names never leave memory', async () => {
    await checkDecision(({ url }) => url.pathname === `/user/memberships/orgs/${O}` ? response({ state: 'active', role: 'member' }) : undefined, 20, 'UNREAD');
    options.randomBytes = () => Buffer.from('87654321', 'hex');
    const { run } = await checkDecision(({ url }) => url.pathname === '/user/memberships/orgs' ? response([
      ...ORGS.map(login => ({ state: 'active', role: 'admin', organization: { login } })),
      { state: 'active', role: 'admin', organization: { login: SECRET } },
    ]) : undefined, 20, 'ORG-UNLISTED');
    expect(source(run.record, 'memberships').data.unlistedAdminOrgs).toBe(1);
    expect(JSON.stringify(run.record)).not.toContain(SECRET); expect(JSON.stringify(lines)).not.toContain(SECRET);
  });
  it('absent permission maps, unknown levels and unreadable inherited bypass all hold', async () => {
    const changes = [
      ({ url }) => url.pathname === `/orgs/${O}/installations` ? response({ total_count: 1,
        installations: [{ id: 1, app_id: 2, app_slug: 'app', repository_selection: 'all' }] }) : undefined,
      ({ url }) => url.pathname === `/orgs/${O}/installations` ? response({ total_count: 1,
        installations: [{ id: 1, app_id: 2, app_slug: 'app', repository_selection: 'all', permissions: { contents: 'owner' } }] }) : undefined,
      ({ url }) => url.pathname === detail ? response({ source_type: 'Enterprise' }) : undefined,
    ];
    for (let i = 0; i < changes.length; i++) {
      options.randomBytes = () => Buffer.from(i.toString(16).padStart(8, '0'), 'hex');
      await checkDecision(changes[i], 20, 'UNKNOWN');
    }
  });
  it('oversized child output is bounded and held with an operator-visible reason', async () => {
    const { run, out } = await checkDecision(({ url }) => url.pathname === detail ? { code: 0, stdout: 'x'.repeat(4 * 1024 * 1024 + 1) } : undefined, 20, 'UNREAD');
    expect(source(run.record, `repoRuleset:${O}/repo:7`).data).toBeNull();
    expect(out.result).toBe('INCOMPLETE');
    expect(lines.stdout.join('')).toContain('reason=UNREAD action=RERUN');
  });
});

describe('secrets, result precedence and live admission', () => {
  test('fatal-needs-login', 'first user secret produces the minimal schema-valid fatal', async () => {
    const { run } = await checkDecision(({ url }) => url.pathname === '/user' ? response({ login: SECRET }) : undefined, 1, 'SECRET-DETECTED');
    expect(run.record.readerLogin).toBeNull(); expect(run.record.sources).toEqual([]);
    expect(subject.validateRecord(run.record)).toBe(true);
  });
  for (const variant of ['leak-stderr', 'leak-field', 'redact-and-pass']) test(variant, 'all sinks reject secrets and redacted authority cannot pass', async () => {
    const cases = [
      [({ url }) => url.pathname === detail ? { code: 1, stdout: '', stderr: `${SECRET} Authorization: token abc` } : undefined, 20],
      [({ url }) => url.pathname === `/orgs/${O}/repos` ? response([{ name: SECRET }]) : undefined, 20],
      [({ url }) => url.pathname === `/orgs/${O}/installations` ? response({ total_count: 1,
        installations: [{ id: 1, app_id: 2, app_slug: 'app', repository_selection: 'all', permissions: { ghu_abcdefgh: 'read' } }] }) : undefined, 20],
      [({ url }) => url.pathname === detail ? actorResponse('Team', 'not-a-number') : undefined, 20],
      [({ url }) => url.pathname === detail ? response({ source_type: 'Repository', name: SECRET, bypass_actors: [] }) : undefined, 0],
    ];
    for (let i = 0; i < cases.length; i++) {
      options.randomBytes = () => Buffer.from(i.toString(16).padStart(8, '0'), 'hex');
      const { run } = await checkDecision(cases[i][0], cases[i][1]);
      const dir = join(temp, 'state/credential-cutover/runs', run.record.runId);
      for (const file of await fs.readdir(dir)) expect(await fs.readFile(join(dir, file), 'utf8')).not.toMatch(production.SECRET_RE);
      expect(JSON.stringify(lines)).not.toMatch(production.SECRET_RE);
    }
  });
  it('fixed emitted vocabulary never collides with SECRET_RE', () => {
    expect(production.FIXED_STRINGS.length).toBeGreaterThan(30);
    for (const value of production.FIXED_STRINGS) expect(value).not.toMatch(production.SECRET_RE);
  });
  test('redact-and-pass', 'last serialized-content check replaces an injected secret with a minimal fatal', async () => {
    const { record } = await collect();
    const path = join(temp, 'state/credential-cutover/runs', record.runId, 'inventory.json');
    await fs.unlink(path);
    const poisoned = Object.assign(Object.create({ toJSON: () => ({ leak: SECRET }) }), record);
    expect(production.validateRecord(poisoned)).toBe(true);
    const emitted = await subject.emit(options, 'inventory', poisoned, path);
    expect(emitted.fatal).toBe('SECRET-DETECTED');
    expect(emitted.readerLogin).toBeNull(); expect(emitted.sources).toEqual([]);
    expect(await fs.readFile(path, 'utf8')).not.toMatch(production.SECRET_RE);
    expect((await subject.aggregate({ ...options, runId: record.runId })).exitCode).toBe(1);
  });
  it('self-schema failure uses the same minimal fatal variant', async () => {
    const { record } = await collect();
    const path = join(temp, 'state/credential-cutover/runs', record.runId, 'inventory.json'); await fs.unlink(path);
    const emitted = await production.emit(options, 'inventory', { ...record, sources: [] }, path);
    expect(emitted.fatal).toBe('SELF-SCHEMA'); expect(production.validateRecord(emitted)).toBe(true);
    delete emitted.startedAt; expect(production.validateRecord(emitted)).toBe(false);
  });
  it('oversized serialized evidence still writes a minimal fatal audit record', async () => {
    const { record } = await collect();
    const path = join(temp, 'state/credential-cutover/runs', record.runId, 'inventory.json'); await fs.unlink(path);
    const oversized = Object.assign(Object.create({ toJSON: () => ({ data: 'x'.repeat(32 * 1024 * 1024) }) }), record);
    await expect(production.emit(options, 'inventory', oversized, path)).resolves.toMatchObject({ fatal: 'SELF-SCHEMA', readerLogin: null, sources: [] });
    expect((await fs.stat(path)).size).toBeLessThan(1024);
    expect((await subject.aggregate({ ...options, runId: record.runId })).exitCode).toBe(1);
  });
  it('oversized persisted evidence is an incomplete cohort with a named fallback', async () => {
    const { record } = await collect();
    const path = join(temp, 'state/credential-cutover/runs', record.runId, 'inventory.json'); await fs.truncate(path, 32 * 1024 * 1024 + 1);
    expect((await subject.aggregate({ ...options, runId: record.runId })).exitCode).toBe(20);
    expect(lines.stdout.join('')).toContain('reason=COHORT action=RERUN');
  });
  test('complete-with-findings-as-complete', 'findings never become COMPLETE and incomplete has higher precedence', async () => {
    await checkDecision(({ url }) => url.pathname === detail ? actorResponse('Integration', 12) : undefined, 10, 'APP-BYPASS');
    options.randomBytes = () => Buffer.from('87654321', 'hex');
    const { out } = await checkDecision(({ url }) => url.pathname === detail ? actorResponse('Integration', 12)
      : url.pathname === `/orgs/${ORGS[1]}/rulesets/7` ? response({}, 403) : undefined, 20, 'APP-BYPASS');
    expect(out.reasons).toContain('UNREAD');
  });
  test('trust-persisted-result', 'admission ignores forged audit files and re-reads live authority', async () => {
    const { record } = await collect();
    await fs.writeFile(join(temp, 'state/credential-cutover/runs', record.runId, 'result.txt'), 'COMPLETE\n');
    ioCalls.length = 0; options.randomBytes = () => Buffer.from('87654321', 'hex');
    options.run = runner(({ url }) => url.pathname === detail ? actorResponse('Integration', 12) : undefined);
    const out = await subject.admissionCheck(options);
    expect(out.exitCode).toBe(10); expect(out.allowed).toBe(false);
    expect(ioCalls.some(([op, path]) => ['readFile', 'open'].includes(op) && path.includes(record.runId))).toBe(false);
  });
  it('admission rejects missing or invalid commit before any IO', async () => {
    for (const commit of [undefined, 'aaaaaaa']) {
      const out = await subject.admissionCheck({ ...options, commit }); expect(out.exitCode).toBe(1); expect(out.allowed).toBe(false);
      expect(ioCalls).toEqual([]); expect(calls).toEqual([]);
    }
  });
  it('admission returns COMPLETE only for a fresh live clean run', async () => {
    const out = await subject.admissionCheck(options);
    expect(out.exitCode).toBe(0); expect(out.allowed).toBe(true);
    expect(out.result).toBe('COMPLETE'); expect(calls.length).toBe(68);
  });
  test('trust-persisted-result', 'live reader, scope, auth and incomplete reads all refuse admission', async () => {
    const cases = [
      ({ url }) => url.pathname === '/user' ? response({ login: 'outsider' }) : undefined,
      ({ url }) => url.pathname === '/user' ? response({ login: 'chalbert' }) : undefined,
      ({ url }) => url.pathname === detail ? response({}, 401) : undefined,
      ({ url }) => url.pathname === detail ? response({}, 403) : undefined,
    ];
    for (let i = 0; i < cases.length; i++) {
      const out = await subject.admissionCheck({ ...options, randomBytes: () => Buffer.from(i.toString(16).padStart(8, '0'), 'hex'), run: runner(cases[i]) });
      expect(out.allowed).toBe(false); expect(out.exitCode).not.toBe(0);
    }
  });
  it('CLI rejects unknown modes and invalid commit before creating state', async () => {
    for (const args of [['--apply'], ['--inventory'], ['--inventory', '--commit=bad'], ['--aggregate', '--run=../x']]) {
      expect((await subject.runCli(args, options)).exitCode).toBe(1);
    }
    expect(ioCalls).toEqual([]); expect(calls).toEqual([]);
  });
  it('bounds child output and fails closed on runner and filesystem errors', async () => {
    const res = await collect(() => { throw new Error(SECRET); });
    expect(res.exitCode).toBe(0); expect(source(res.record, 'user').reason).toBe('UNREAD');
    expect((await subject.aggregate({ ...options, runId: res.record.runId })).exitCode).toBe(20);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
    const failedIO = { ...fs, lstat: async () => { throw Object.assign(new Error(SECRET), { code: 'EACCES' }); } };
    expect((await subject.inventory({ ...options, fs: failedIO })).exitCode).toBe(1);
  });
  it('variant titles and fixture exports map in both directions', () => {
    const bracketed = titles.map(t => t.match(/^\[([^\]]+)\]/)[1]);
    expect([...new Set(bracketed)].sort()).toEqual([...VARIANTS].sort());
  });
});
