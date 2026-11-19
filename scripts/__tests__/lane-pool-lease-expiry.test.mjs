import { it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';

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
  const gate = `node -e 'setTimeout(() => process.exit(1), 150)'`;
  const result = spawnSync(process.execPath, [`--import=data:text/javascript,${encodeURIComponent(preload)}`,
    resolve('scripts/verify-lane.mjs'), `--repo=${lane}`, `--gate=${gate}`, '--json'], {
    cwd: reference, encoding: 'utf8', timeout: 20000,
    env: { ...env, WE_HEAVY_ADMISSION_HELD: '1' },
  });
  expect(result.status, result.stderr).not.toBe(0);
  expect(Date.parse(readLease().renewedAt)).toBeGreaterThan(Date.now() - 20_000);
  expect(readLease().session).toBe('owner');
});
