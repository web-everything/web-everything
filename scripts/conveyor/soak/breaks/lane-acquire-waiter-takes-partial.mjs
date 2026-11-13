/**
 * @file breaks/lane-acquire-waiter-takes-partial.mjs — live 2026-11-13: review jobs ended `deferred-no-lane`
 * ("no lane … within 60000ms") while 72 of 90 lanes were free. `acquire` waiters sat out the shared whole-pool
 * acquirability scan until their own --wait-ms ran out, never using lanes the running scan had already proved
 * free. FIX: the scan holder publishes proven-free lanes into its lock dir (`partial.json`); a waiter takes one
 * as a candidate (still claimed + re-verified fresh).
 *
 * SCENARIO: a REAL 3-lane pool (real `lane-pool.mjs provision`), a live scan lock owned by this process that
 * never finishes, and the lock holder's published partial naming lane-2. RED = the acquire gives up with
 * "lock contention" / no lane; GREEN = it returns a lane well inside its wait.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const MARKER = 'scripts/lib/lane-pool-scan.mjs';
const WAIT_MS = 8000;

export async function replay(root = REPO_ROOT) {
  const script = join(root, 'scripts', 'lane-pool.mjs');
  const tmp = mkdtempSync(join(tmpdir(), 'soak-acquire-partial-'));
  try {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', LANE_POOL_ROOT: join(tmp, 'pool') };
    const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
    const id = ['-c', 'user.name=s', '-c', 'user.email=s@s', '-c', 'commit.gpgsign=false'];
    const origin = join(tmp, 'origin.git'); const ref = join(tmp, 'reference');
    git(tmp, ['init', '--bare', '-b', 'main', origin]);
    git(tmp, ['clone', origin, ref]);
    writeFileSync(join(ref, 'file.txt'), 'v1\n');
    git(ref, ['add', 'file.txt']); git(ref, [...id, 'commit', '-m', 'v1']); git(ref, ['push', 'origin', 'HEAD:main']);
    const repoArgs = [`--origin=${origin}`, `--reference=${ref}`, '--name=soakpartial', '--branch=main', '--no-install', '--no-reap'];
    const pool = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env, timeout: 60_000 });
    const prov = pool(['provision', '--count=3', ...repoArgs]);
    if (prov.status !== 0) return { harness: false, detail: String(prov.stderr).slice(0, 200) };
    const lock = join(tmp, 'pool', 'soakpartial', '.list-acquirable.lock');
    const poolDir = join(tmp, 'pool', 'soakpartial');
    mkdirSync(lock);
    const owner = { pid: process.pid, host: hostname(), startedAt: Date.now() };
    writeFileSync(join(lock, 'owner.json'), JSON.stringify(owner));
    // What the fixed scan holder publishes while still scanning; on the pre-fix tree nothing reads it.
    writeFileSync(join(lock, 'partial.json'), JSON.stringify({ v: 1, owner, lanes: [join(poolDir, 'lane-2')] }));
    const startedAt = Date.now();
    const r = pool(['acquire', ...repoArgs, '--session=soak-waiter', `--wait-ms=${WAIT_MS}`, '--scan-timeout-ms=30000', '--hard-max=3', '--no-free-list']);
    return { harness: true, code: r.status, ms: Date.now() - startedAt, err: String(r.stderr).slice(-300) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export default {
  id: 'lane-acquire-waiter-takes-partial',
  title: 'acquire waited out a running scan (deferred-no-lane) while the scan had already proved a lane free',
  card: 'review-daemon deferred-no-lane, 2026-11-13 (PR lane/lane-acquire-scan-contention)',
  fixedBy: { sha: '68a5530772,23768f7e45,73fb9887aa,42af73986b,3b49c284b7', where: 'lane/lane-acquire-scan-contention', paths: ['scripts/lane-pool.mjs', MARKER] },
  fixPresent(root) { try { return /readPartialFree/.test(execFileSync('cat', [join(root, MARKER)], { encoding: 'utf8' })); } catch { return false; } },
  async run({ log } = {}) {
    try {
      const report = await replay();
      log?.(JSON.stringify(report));
      const violations = [];
      if (!report.harness) violations.push({ invariant: 'harness', detail: report.detail || 'pool did not provision' });
      else if (report.code === 0 && report.ms >= WAIT_MS) violations.push({ invariant: 'waiter-waited-out-scan', detail: `acquire succeeded only after ${report.ms}ms, the whole --wait-ms (${WAIT_MS}ms): the waiter did not use the published lane` });
      else if (report.code !== 0) violations.push({ invariant: 'waiter-took-no-lane', detail: `acquire failed after ${report.ms}ms with a published free lane: ${report.err.replace(/\s+/g, ' ')}` });
      return { violations, report };
    } catch (e) {
      return { violations: [{ invariant: 'crash', detail: String(e?.stack || e).split('\n').slice(0, 3).join(' ') }] };
    }
  },
  judge(report) { return report.violations.map((v) => `[${v.invariant}] ${v.detail}`); },
};
