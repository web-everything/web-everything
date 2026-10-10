/**
 * PR #4624, 2026-10-09 19:18:51Z: main moved after adoption but before the next rebuild.
 * Real git and the real staleness guard must allow the clean, nine-minute-old adopted build to run a fix pass.
 * Despite the historical scenario name, deliver-item-wrapper IS on the fix code path: off-path tolerance
 * alone cannot fix this replay. Before freshAdoptMs, no held/building record meant a STALE refusal.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloneKeyOf, daemonStateDir } from '../../../lib/daemon-last-good.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const CHANGED_PATH = 'scripts/operations/deliver-item-wrapper.mjs';
const CHILD = `
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const fix = await import(pathToFileURL(join(process.env.SOAK_SOURCE_ROOT, 'scripts/conveyor/reconcile-fix-dispatch.mjs')).href);
const out = { reconciled: false, result: null, threw: null };
try {
  out.result = fix.runReconcileFixDispatch({
    root: process.env.SOAK_CLONE,
    reconcile: () => { out.reconciled = true; return { dispatch: [], refusals: [] }; },
    pickFreeLanes: () => [],
    listBuildClaims: () => [], listFixClaims: () => [], priorityShadow: null,
  });
} catch (e) { out.threw = String(e.message); }
process.stdout.write(JSON.stringify(out));
`;
const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, maxBuffer: 16 * 1024 * 1024,
});

export default {
  id: 'fix-dispatch-stalls-on-unrelated-clone-lag',
  title: 'the fix pass refuses every repo while a just-adopted daemon clone lags main (live 2026-10-09 19:18:51Z, PR #4624)',
  card: 'live incident 2026-10-09: PR #4624 block-ruled fix delayed a pass',
  fixedBy: {
    sha: '439e628a9', where: 'lane/fix-pass-stale-isolation-and-pass-latency',
    paths: [
      'scripts/conveyor/reconcile-fix-dispatch.mjs',
      'scripts/lib/daemon-last-good.mjs',
      'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs',
      'scripts/conveyor/pr-events-worker/core.mjs',
      'scripts/lib/pr-events.mjs',
    ],
  },
  fixPresent(root) {
    const contains = (path, marker) => existsSync(join(root, path)) && readFileSync(join(root, path), 'utf8').includes(marker);
    return contains('scripts/conveyor/reconcile-fix-dispatch.mjs', 'export function isFixCodePath')
      && contains('scripts/lib/daemon-last-good.mjs', 'freshAdoptMs');
  },
  async run({ log, sourceRoot = REPO_ROOT } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-fix-stale-'));
    const violations = [];
    try {
      const origin = join(dir, 'origin.git');
      const seed = join(dir, 'seed');
      const clone = join(dir, 'clone');
      git(dir, 'init', '--bare', '-q', '-b', 'main', origin);
      git(dir, 'clone', '-q', origin, seed);
      git(seed, 'config', 'user.email', 'soak@example.invalid');
      git(seed, 'config', 'user.name', 'soak');
      mkdirSync(join(seed, 'scripts/operations'), { recursive: true });
      writeFileSync(join(seed, CHANGED_PATH), '// adopted build\n');
      git(seed, 'add', CHANGED_PATH);
      git(seed, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed');
      git(seed, 'push', '-q', 'origin', 'HEAD:main');
      git(dir, 'clone', '-q', origin, clone);
      const adoptedHead = git(clone, 'rev-parse', 'HEAD').trim();
      const env = {
        ...process.env, SOAK_SOURCE_ROOT: sourceRoot, SOAK_CLONE: clone,
        WE_DAEMON_MANAGED_CLONE: '1', WE_DAEMON_STATE_DIR: join(dir, 'state'),
        CONVEYOR_STATE_ROOT: join(dir, 'conveyor-state'), WE_STALE_GUARD_REBUILD_GRACE_MS: '3600000',
      };
      mkdirSync(daemonStateDir(env), { recursive: true });
      writeFileSync(join(daemonStateDir(env), `${cloneKeyOf(clone)}.rebuild.json`), JSON.stringify({
        adopted: { head: adoptedHead, at: new Date(Date.now() - 9 * 60_000).toISOString() },
      }));
      writeFileSync(join(seed, CHANGED_PATH), '// main moved after adoption\n');
      git(seed, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-q', '-am', 'main moves deliver-item-wrapper');
      git(seed, 'push', '-q', 'origin', 'HEAD:main');
      // Fetch here to prove the fixture; the dispatcher still performs its own real fetch-first check.
      git(clone, 'fetch', '-q', 'origin', 'main');
      if (git(clone, 'rev-list', '--count', 'HEAD..origin/main').trim() !== '1'
        || git(clone, 'diff', '--name-only', 'HEAD', 'origin/main').trim() !== CHANGED_PATH
        || git(clone, 'status', '--porcelain').trim()) throw new Error('expected a clean clone exactly one code commit behind main');
      log?.(`clean managed clone adopted nine minutes ago; main moved ${CHANGED_PATH}`);
      const childFile = join(dir, 'child.mjs');
      writeFileSync(childFile, CHILD);
      const out = JSON.parse(execFileSync(process.execPath, [childFile], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
      }));
      log?.(`reconciled: ${out.reconciled}; threw: ${out.threw}`);
      if (out.threw?.includes('STALE code from this checkout')) {
        violations.push({ invariant: 'fix-pass-runs-on-just-adopted-build', detail: out.threw });
      } else if (out.threw || !out.reconciled || !out.result || out.result.dispatched.length || out.result.refusals.length) {
        violations.push({ invariant: 'scenario-runs', detail: `empty fix pass did not complete: ${JSON.stringify(out)}` });
      }
      if (git(clone, 'rev-parse', 'HEAD').trim() !== adoptedHead || git(clone, 'status', '--porcelain').trim()) {
        violations.push({ invariant: 'adopted-build-preserved', detail: 'the pass changed the managed clone instead of running its adopted build' });
      }
      return { violations };
    } catch (e) {
      violations.push({ invariant: 'scenario-runs', detail: String(e?.stderr || e?.message || e) });
      return { violations };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
