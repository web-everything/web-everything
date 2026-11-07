/**
 * Live incident 2026-10-11, drain log, PR #4880: after the drain's freshness refresh
 * rebased an accepted PR, the acceptance re-stamp failed: "review-set-label: this
 * checkout is 14 commit(s) behind origin/main in code it runs (STALE code from this checkout)".
 * The drain runs merge-ai-prs from its daemon-managed CODE clone, held behind main
 * by a smoke-rejected gated rebuild, with cwd in its always-fresh DATA clone.
 * restampAcceptance spawns the CODE clone's review-set-label.
 *
 * Real git and copied production modules prove that the operator CLI re-executes
 * from fresh DATA or a leased lane when CODE == DATA, and honors knob-off.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const TOY_CLI = `
import { realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertOperatorCliFresh } from './lib/main-staleness.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Only the pool subprocess is a seam: freshness and CLI execution use real git/Node.
const laneSpawn = (_cmd, args) => {
  if (args[1] === 'acquire') return { status: 0, stdout: JSON.stringify({
    lane: 8, path: process.env.WE_SOAK_FRESH_LANE, holder: 'soak-restamp-holder',
  }) };
  if (args[1] === 'release' && args.includes('--session=soak-restamp-holder')) {
    writeFileSync(process.env.WE_SOAK_RELEASE_MARKER, 'released');
    return { status: 0 };
  }
  throw new Error('unexpected lane operation');
};
try { assertOperatorCliFresh(root, { label: 'toy-cli',
  ...(process.env.WE_SOAK_FRESH_LANE ? { laneSpawn } : {}),
}); }
catch (e) { process.stdout.write(e.message + '\\n'); process.exit(3); }
process.stdout.write('ran-from=' + realpathSync(root) + '\\n');
process.exit(0);
`;
const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 1024 * 1024,
});

export default {
  id: 'drain-restamp-stale-code-clone',
  title: 'drain acceptance re-stamp runs current code from fresh DATA or a leased lane when CODE == DATA',
  card: 'live incident 2026-10-11: drain acceptance re-stamp failed on PR #4880',
  fixedBy: {
    sha: '43c45e58d',
    where: 'lane/drain-restamp-fresh',
    paths: ['scripts/lib/main-staleness.mjs'],
  },
  fixPresent(root) {
    const path = join(root, 'scripts/lib/main-staleness.mjs');
    return existsSync(path) && readFileSync(path, 'utf8').includes('--purpose=operator-cli-fresh');
  },
  async run({ log, sourceRoot = REPO_ROOT } = {}) {
    // Node canonicalizes import.meta.url; keep argv paths on that same macOS /private path.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'soak-drain-restamp-')));
    const violations = [];
    try {
      const origin = join(dir, 'origin.git');
      const seed = join(dir, 'seed');
      const code = join(dir, 'code');
      const data = join(dir, 'data');
      mkdirSync(origin);
      git(origin, 'init', '--bare', '-q', '-b', 'main');
      git(dir, 'clone', '-q', origin, seed);
      git(seed, 'config', 'user.email', 'soak@example.invalid');
      git(seed, 'config', 'user.name', 'soak');
      git(seed, 'config', 'commit.gpgsign', 'false');
      mkdirSync(join(seed, 'scripts/lib'), { recursive: true });
      for (const file of ['main-staleness.mjs', 'daemon-last-good.mjs', 'daemon-clone-layout.mjs', 'settings-files.mjs']) {
        copyFileSync(join(sourceRoot, 'scripts/lib', file), join(seed, 'scripts/lib', file));
      }
      copyFileSync(join(sourceRoot, 'scripts/run-fresh.mjs'), join(seed, 'scripts/run-fresh.mjs'));
      writeFileSync(join(seed, 'scripts/toy-cli.mjs'), TOY_CLI);
      const push = (message) => {
        git(seed, 'add', '.');
        git(seed, 'commit', '-q', '-m', message);
        git(seed, 'push', '-q', 'origin', 'HEAD:main');
      };
      push('seed');
      git(dir, 'clone', '-q', origin, code);
      git(dir, 'clone', '-q', origin, data);
      writeFileSync(join(seed, 'scripts/lib/other.mjs'), '// code change one\n');
      push('first code change');
      git(data, 'pull', '--ff-only');

      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key === 'VITEST' || key === 'WE_DAEMON_MANAGED_CLONE' || key.startsWith('WE_OPERATOR_CLI_FRESH_')) delete env[key];
      }
      const run = (overrides = {}, cwd = data) => {
        const result = spawnSync(process.execPath, [join(code, 'scripts/toy-cli.mjs')], {
          cwd, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 30_000,
        });
        if (result.error || result.signal || ![0, 3].includes(result.status)) {
          throw new Error(`toy CLI crashed: ${result.error?.message || result.signal || result.status}; ${result.stderr}`);
        }
        log?.(`exit=${result.status}; stdout=${result.stdout.trim()}; stderr=${result.stderr.trim()}`);
        return result;
      };
      const a = run();
      if (a.status !== 0 || a.stdout.trim() !== `ran-from=${realpathSync(data)}`
        || !a.stderr.includes('re-running from the fresh checkout')) {
        violations.push({ invariant: 'restamp-runs-current-code', detail: `exit=${a.status}; stdout=${a.stdout}; stderr=${a.stderr}` });
      }

      writeFileSync(join(seed, 'scripts/lib/other.mjs'), '// code change two\n');
      push('second code change');
      const b = run();
      if (b.status !== 3 || !b.stdout.includes('STALE code from this checkout')) {
        violations.push({ invariant: 'guard-still-refuses-stale', detail: `exit=${b.status}; stdout=${b.stdout}; stderr=${b.stderr}` });
      }

      const fresh = join(dir, 'fresh-lane');
      const released = join(dir, 'released');
      git(dir, 'clone', '-q', origin, fresh);
      const d = run({ WE_SOAK_FRESH_LANE: fresh, WE_SOAK_RELEASE_MARKER: released }, code);
      if (d.status !== 0 || d.stdout.trim() !== `ran-from=${realpathSync(fresh)}` || !existsSync(released)) {
        violations.push({ invariant: 'same-checkout-restamp-leases-and-releases',
          detail: `exit=${d.status}; stdout=${d.stdout}; stderr=${d.stderr}; released=${existsSync(released)}` });
      }
      const e = run({ WE_OPERATOR_CLI_FRESH_FALLBACK: 'off',
        WE_SOAK_FRESH_LANE: fresh, WE_SOAK_RELEASE_MARKER: released }, code);
      if (e.status !== 3 || !e.stdout.includes('STALE code from this checkout')) {
        violations.push({ invariant: 'same-checkout-knob-off-refuses', detail: `exit=${e.status}; stdout=${e.stdout}` });
      }

      git(data, 'pull', '--ff-only');
      const c = run({ WE_OPERATOR_CLI_FRESH_FALLBACK: 'off' });
      if (c.status !== 3 || !c.stdout.includes('STALE code from this checkout')) {
        violations.push({ invariant: 'knob-off-refuses', detail: `exit=${c.status}; stdout=${c.stdout}; stderr=${c.stderr}` });
      }
    } catch (e) {
      violations.push({ invariant: 'scenario-runs', detail: String(e?.stack || e) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return { violations };
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
