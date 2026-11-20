/** Drain re-stamps must prefer fresh DATA over a daemon's older CODE checkout.
 * Real Git histories and real toy children exercise the exported production function.
 * Only fetch (no transport) and the CODE fallback launch location use IO seams.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const TOY = `
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
console.log(JSON.stringify({ dirname: dirname(fileURLToPath(import.meta.url)),
  managed: process.env.WE_DAEMON_MANAGED_CLONE ?? null }));
if (process.argv.includes('--soak-stale')) {
  console.error('review-set-label: STALE code from this checkout');
  process.exitCode = 3;
}
`;
const PROBE = `
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const [moduleUrl, code, data, keyOnly] = process.argv.slice(1);
const { restampAcceptance } = await import(moduleUrl);
const { classifySkipReason } = await import(new URL('./lib/drain-skip-reasons.mjs', moduleUrl));
const fallback = new URL('./review-set-label.mjs', moduleUrl).pathname;
const violations = [];
let fetchFails = false;
let stale = false;
let calls = [];
const check = (ok, invariant, detail) => { if (!ok) violations.push({ invariant, detail }); };
const gitRun = (args, opts) => {
  // Both clones already have origin/main from the immutable local bare origin.
  // Do not perform fetch/push even in fixtures; only the fetch result is injected.
  if (args[0] === 'fetch') return { status: fetchFails ? 1 : 0, stdout: '', stderr: 'fixture transport' };
  return spawnSync('git', args, opts);
};
const invoke = (label, expected) => {
  calls = [];
  const result = restampAcceptance({ pr: 4880, repo: 'soak/we', newHead: 'new-head',
    cwd: code, freshRoot: data, gitRun,
    spawn(cmd, args, opts) {
      calls.push(args[0]);
      check(!Object.hasOwn(opts.env || {}, 'WE_DAEMON_MANAGED_CLONE'),
        label + '-no-managed-override', JSON.stringify(opts.env));
      // The imported drain lives in root, not our toy CODE clone. Map only its
      // exact fallback path; any other unexpected script is refused, never run.
      const script = args[0] === fallback ? join(code, 'scripts/review-set-label.mjs') : args[0];
      if (![join(code, 'scripts/review-set-label.mjs'), join(data, 'scripts/review-set-label.mjs')].includes(script)) {
        throw new Error('unexpected script path: ' + script);
      }
      const child = spawnSync(cmd, [script, ...args.slice(1), ...(stale ? ['--soak-stale'] : [])],
        { ...opts, timeout: 10000, maxBuffer: 1024 * 1024 });
      const output = JSON.parse(child.stdout.trim());
      check(output.dirname === join(expected === fallback ? code : data, 'scripts'),
        label + '-child-dirname', child.stdout);
      check(output.managed === null, label + '-child-not-managed', child.stdout);
      return child;
    } });
  check(calls.length === 1 && calls[0] === expected, label + '-script-path', JSON.stringify(calls));
  return result;
};
const fresh = invoke('fresh-data', join(data, 'scripts/review-set-label.mjs'));
check(fresh.ok === true, 'fresh-data-success', JSON.stringify(fresh));
if (keyOnly !== 'true') {
  const reset = spawnSync('git', ['reset', '--hard', 'HEAD~1'], { cwd: data, encoding: 'utf8', timeout: 10000 });
  if (reset.status !== 0) throw new Error('cannot make data stale: ' + reset.stderr);
  stale = true;
  for (const label of ['behind-data', 'fetch-failed']) {
    fetchFails = label === 'fetch-failed';
    if (fetchFails) {
      const restored = spawnSync('git', ['reset', '--hard', 'origin/main'], { cwd: data, encoding: 'utf8', timeout: 10000 });
      if (restored.status !== 0) throw new Error('cannot restore data: ' + restored.stderr);
    }
    const result = invoke(label, fallback);
    check(result.ok === false && result.retry === true && result.reason?.startsWith('restamp-stale-code:'),
      label + '-retryable-stale-refusal', JSON.stringify(result));
    check(classifySkipReason(result.reason) === 'restamp-stale-code',
      label + '-stale-kind', JSON.stringify(result));
  }
}
console.log(JSON.stringify({ violations }));
`;

function scenario(root, keyOnly = false) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'soak-restamp-data-')));
  try {
    const seed = join(dir, 'seed');
    const origin = join(dir, 'origin.git');
    const code = join(dir, 'code');
    const data = join(dir, 'data');
    const git = (cwd, ...args) => execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, maxBuffer: 1024 * 1024,
    });
    mkdirSync(seed);
    git(seed, 'init', '-q', '-b', 'main');
    git(seed, 'config', 'user.name', 'soak');
    git(seed, 'config', 'user.email', 'soak@example.invalid');
    git(seed, 'config', 'commit.gpgsign', 'false');
    mkdirSync(join(seed, 'scripts'));
    writeFileSync(join(seed, 'scripts/review-set-label.mjs'), TOY);
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'toy CLI');
    writeFileSync(join(seed, 'scripts/current.mjs'), '// main advances in executable code\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'advance main');
    git(dir, 'clone', '-q', '--bare', seed, origin);
    git(dir, 'clone', '-q', origin, code);
    git(dir, 'clone', '-q', origin, data);
    git(code, 'reset', '--hard', 'HEAD~1');
    const env = { ...process.env };
    delete env.WE_DAEMON_MANAGED_CLONE;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE,
      pathToFileURL(join(root, 'scripts/merge-ai-prs.mjs')).href, code, data, String(keyOnly)],
    { cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    if (child.error || child.status !== 0) throw new Error(`probe failed: ${child.error?.message || child.status}; ${child.stderr}`);
    const report = JSON.parse(child.stdout.trim().split('\n').pop());
    if (!Array.isArray(report.violations)) throw new Error('incomplete probe report');
    return report;
  } catch (error) {
    return { violations: [{ invariant: 'scenario-runs', detail: String(error.stack || error) }] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export default {
  id: 'drain-restamp-prefers-fresh-data-script',
  title: 'drain re-stamp prefers the fresh DATA script and retries stale CODE refusals',
  card: 'drain acceptance re-stamp selects fresh DATA instead of stale daemon CODE',
  fixedBy: { sha: 'pending', where: 'lane/drain-restamp-fresh', paths: ['scripts/merge-ai-prs.mjs'] },
  fixPresent(root) { return scenario(root, true).violations.length === 0; },
  async run({ log, sourceRoot = REPO_ROOT } = {}) {
    const report = scenario(sourceRoot);
    log?.(JSON.stringify(report));
    return report;
  },
  judge(report) { return report.violations.map(v => `[${v.invariant}] ${v.detail}`); },
};
