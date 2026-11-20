import { it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnKeepAlive } from '../lib/test-keepalive.mjs';

const cli = resolve('scripts/lane-pool.mjs');
let root, lane, pool, reference, env;
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
const marker = () => join(lane, '.git', '.lane-lease');
const readLease = () => JSON.parse(readFileSync(marker(), 'utf8'));
const run = (args, cwd = reference) => spawnSync(process.execPath, [cli, ...args], {
  cwd, env, encoding: 'utf8', timeout: 20_000,
});
const seed = (extra = {}) => writeFileSync(marker(), JSON.stringify({ session: 'owner',
  acquiredAt: '2020-01-01T00:00:00.000Z', ttlMinutes: 240, ...extra }));
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lease-expiry-'));
  pool = join(root, 'pool'); reference = join(root, 'reference'); lane = join(pool, 'fixture', 'lane-1');
  mkdirSync(reference); mkdirSync(join(pool, 'fixture'), { recursive: true });
  git(['init', '--quiet', '--initial-branch=main'], reference);
  writeFileSync(join(reference, 'file'), 'base'); git(['add', '.'], reference);
  git(['-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '--quiet', '-m', 'base'], reference);
  git(['clone', '--quiet', reference, lane], root);
  env = { ...process.env, LANE_POOL_ROOT: pool, LANE_POOL_CANONICAL_ORIGIN: '',
    CLAUDE_CODE_SESSION_ID: '', LANE_SESSION: '', LANE_POOL_NO_RECOVER: '1' };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it.each(['live', 'dirty'])('stale %s lane refuses takeover and reclaim, even with force/override', kind => {
  seed(kind === 'live' ? { pid: process.pid, host: hostname() } : {});
  if (kind === 'dirty') writeFileSync(join(lane, 'work'), 'precious work');
  const before = readFileSync(marker(), 'utf8');
  for (const args of [
    ['acquire', '--no-reset', '--no-reap', '--force', '--session=other'],
    ['reclaim', '--override'],
  ]) {
    const result = run([...args, '--lane=1', '--pool=fixture', `--origin=${reference}`, `--reference=${reference}`, '--no-install']);
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain(`stale-but-${kind}`);
    expect(readFileSync(marker(), 'utf8')).toBe(before);
  }
  if (kind === 'dirty') expect(readFileSync(join(lane, 'work'), 'utf8')).toBe('precious work');
});
it('re-adopts an owned lane from its cwd without a canonical origin and preserves dirty work', () => {
  seed({ holder: 'existing-holder', workflowLane: true });
  writeFileSync(join(lane, 'work'), 'precious work');
  const result = run(['acquire', '--lane=1', '--adopt', '--session=owner', '--json'], lane);
  expect(result.status, result.stderr).toBe(0);
  expect(readLease().workflowLane).toBe(true);
  expect(readLease().holder).toBe('existing-holder');
  expect(readLease().pid).toBe(process.pid);
  expect(readFileSync(join(lane, 'work'), 'utf8')).toBe('precious work');
});
it('foreign re-adoption still requires a canonical origin', () => {
  seed();
  const result = run(['acquire', '--lane=1', '--adopt', '--session=other'], lane);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/canonical origin/);
  expect(readLease().session).toBe('owner');
});

it.each(['live', 'dirty'])('forced refresh preserves a stale %s lease before fetch or reset', kind => {
  seed(kind === 'live' ? { pid: process.pid, host: hostname() } : {});
  if (kind === 'dirty') writeFileSync(join(lane, 'work'), 'precious work');
  const before = readFileSync(marker(), 'utf8');
  const result = run(['refresh', '--lane=1', '--pool=fixture', `--origin=${reference}`,
    `--reference=${reference}`, '--force', '--no-install']);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain(`stale-but-${kind}`);
  expect(readFileSync(marker(), 'utf8')).toBe(before);
  if (kind === 'dirty') expect(readFileSync(join(lane, 'work'), 'utf8')).toBe('precious work');
});

it('re-adoption recovers a dead writer guard', () => {
  seed();
  writeFileSync(`${marker()}.lock`, '2147483646\n');
  const result = run(['acquire', '--lane=1', '--adopt', '--session=owner', '--json'], lane);
  expect(result.status, result.stderr).toBe(0);
  expect(readLease().session).toBe('owner');
  expect(existsSync(`${marker()}.lock`)).toBe(false);
});

it('re-adoption waits for a concurrent heartbeat writer to release its guard', async () => {
  seed();
  const attempted = join(root, 'guard-attempted');
  const writer = spawn(process.execPath, ['-e', `const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(`${marker()}.lock`)}, String(process.pid), { flag: 'wx' });
    process.stdout.write('ready');
    const ceiling = setTimeout(() => process.exit(2), 5000);
    const timer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(attempted)})) return;
      clearInterval(timer); clearTimeout(ceiling);
      setTimeout(() => fs.unlinkSync(${JSON.stringify(`${marker()}.lock`)}), 50);
    }, 10);`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => writer.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => { writer.stdout.once('data', resolve); writer.once('error', reject); });
    const preload = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      const write = fs.writeFileSync, link = fs.linkSync;
      const signal = path => { if (path === ${JSON.stringify(`${marker()}.lock`)} || path === ${JSON.stringify(join(realpathSync(join(lane, '.git')), '.lane-lease.lock'))}) write(${JSON.stringify(attempted)}, 'attempted'); };
      fs.writeFileSync = (path, ...args) => { signal(path); return write(path, ...args); };
      fs.linkSync = (source, path, ...args) => { signal(path); return link(source, path, ...args); };
      syncBuiltinESMExports();`;
    const result = spawnSync(process.execPath, [`--import=data:text/javascript,${encodeURIComponent(preload)}`,
      cli, 'acquire', '--lane=1', '--adopt', '--session=owner', '--json'], {
      cwd: lane, env, encoding: 'utf8', timeout: 20000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(attempted)).toBe(true);
    expect(readLease().session).toBe('owner');
  } finally {
    if (writer.exitCode === null) writer.kill();
    await exited;
  }
});

it.each(['0', '-1', 'bad', '1.5'])('rejects an invalid declared holder PID %s before rewriting a lease', pid => {
  seed();
  const before = readFileSync(marker(), 'utf8');
  env.LANE_HOLDER_PID = pid;
  const result = run(['acquire', '--lane=1', '--adopt', '--session=owner', '--json'], lane);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('LANE_HOLDER_PID');
  expect(readFileSync(marker(), 'utf8')).toBe(before);
});

it('a fresh live lease produces no stale refusal during an acquirable reap pass', () => {
  seed({ acquiredAt: new Date().toISOString(), pid: process.pid, host: hostname() });
  const result = run(['list', '--acquirable', '--pool=fixture', `--origin=${reference}`, `--reference=${reference}`]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).not.toContain('stale-but-');
  const journal = join(pool, 'fixture', '.lane-journal.jsonl');
  expect(existsSync(journal) ? readFileSync(journal, 'utf8') : '').not.toContain('reclaim-refused');
});

it('an exiting acquire wrapper can name its surviving sibling as the lease holder', async () => {
  const sibling = spawnKeepAlive();
  try {
    seed();
    const wrapper = `require('node:child_process').execFileSync(process.execPath, ${JSON.stringify([
      cli, 'acquire', '--lane=1', '--adopt', '--session=owner', '--json',
    ])}, { stdio: 'pipe' });`;
    const acquired = spawnSync(process.execPath, ['-e', wrapper], { cwd: lane,
      env: { ...env, LANE_HOLDER_PID: String(sibling.pid) }, encoding: 'utf8', timeout: 20000 });
    expect(acquired.status, acquired.stderr).toBe(0);
    expect(readLease().pid).toBe(sibling.pid);
    seed({ ...readLease(), acquiredAt: '2020-01-01T00:00:00.000Z' });
    const result = run(['reclaim', '--override', '--lane=1', '--pool=fixture', `--origin=${reference}`, `--reference=${reference}`]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('stale-but-live');
  } finally {
    await new Promise(resolve => { sibling.once('exit', resolve); sibling.kill(); });
  }
});

it('owned re-adoption refuses missing ancestor history without repair or reset', () => {
  seed();
  const parent = git(['rev-parse', 'HEAD'], lane).trim();
  git(['-c', 'user.name=test', '-c', 'user.email=test@example.test',
    'commit', '--quiet', '--allow-empty', '-m', 'local tip'], lane);
  const object = join(lane, '.git', 'objects', parent.slice(0, 2), parent.slice(2));
  rmSync(object);
  writeFileSync(join(lane, 'work'), 'precious work');

  const result = run(['acquire', '--lane=1', '--adopt', '--session=owner', '--json'], lane);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('QUARANTINED');
  expect(existsSync(object)).toBe(false);
  expect(existsSync(join(pool, 'fixture', '.quarantine-state', 'lane-1.json'))).toBe(true);
  expect(readFileSync(join(lane, 'work'), 'utf8')).toBe('precious work');
});

it('verify-lane renews its selected cwd lease throughout a failing gate', () => {
  seed();
  const loader = `export async function load(url, context, next) {
    const result = await next(url, context);
    if (url.endsWith('/lane-lease-heartbeat.mjs')) return { ...result,
      source: String(result.source).replace('intervalMs = 60_000', 'intervalMs = 10') };
    return result;
  }`;
  const preload = `import { register } from 'node:module'; register(${JSON.stringify('data:text/javascript,')} + encodeURIComponent(${JSON.stringify(loader)}));`;
  const observed = join(root, 'gate-renewals.json');
  const gateScript = join(root, 'observe-renewals.cjs');
  writeFileSync(gateScript, `const fs = require('node:fs');
    const read = () => JSON.parse(fs.readFileSync(${JSON.stringify(marker())}, 'utf8')).renewedAt;
    const initial = read();
    setTimeout(() => { fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ initial, later: read() })); process.exit(1); }, 150);`);
  const gate = `node ${JSON.stringify(gateScript)}`;
  const result = spawnSync(process.execPath, [`--import=data:text/javascript,${encodeURIComponent(preload)}`,
    resolve('scripts/verify-lane.mjs'), `--repo=${lane}`, `--gate=${gate}`, '--json'], {
    cwd: reference, encoding: 'utf8', timeout: 20000,
    env: { ...env, WE_HEAVY_ADMISSION_HELD: '1' },
  });
  expect(result.status, result.stderr).not.toBe(0);
  expect(Date.parse(readLease().renewedAt)).toBeGreaterThan(Date.now() - 20_000);
  expect(readLease().session).toBe('owner');
  const { initial, later } = JSON.parse(readFileSync(observed, 'utf8'));
  expect(Date.parse(later)).toBeGreaterThan(Date.parse(initial));
});

it.each([['reset'], ['check'], ['--dry-run']])('non-running verify-lane mode %s leaves lease bytes unchanged', mode => {
  seed();
  const before = readFileSync(marker(), 'utf8');
  const result = spawnSync(process.execPath, [resolve('scripts/verify-lane.mjs'), mode,
    `--repo=${lane}`, '--gate=node --version', '--json'], {
    cwd: reference, env: { ...env, WE_HEAVY_ADMISSION_HELD: '1' }, encoding: 'utf8', timeout: 20000,
  });
  expect(result.error).toBeUndefined();
  expect(readFileSync(marker(), 'utf8')).toBe(before);
});
