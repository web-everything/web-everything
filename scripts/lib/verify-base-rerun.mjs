/**
 * @file scripts/lib/verify-base-rerun.mjs
 * @description Perf item 42 — a failing test that ALSO fails on the current `origin/main` tip is main's problem, not
 * the lane's. Pure decision code plus a per-main-sha cache; the git worktree + vitest run is injected (`runBase`).
 *
 * The marker then records `redCause: 'pre-existing-on-main'` with `redCauseEvidence`. Never weakens an in-diff check:
 * only an `out-of-diff-still-red` verdict, a complete (non-truncated) failure list, vitest-only red phases, and
 * EVERY failing (file, name) reproduced on the base can produce it. Any base-run error means "not proven" (stay red).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PRE_EXISTING_ON_MAIN = 'pre-existing-on-main';
const key = (t) => `${t.file}\u0000${t.name ?? ''}`;

/** Can this red even be compared with main? Cheap precheck, before any base run. */
export function baseRerunCandidate({ exitCode, signal, phaseResults = [], failureDetails, changedFiles } = {}) {
  if (!exitCode || signal) return null;
  const red = phaseResults.filter(p => p.result?.exitCode !== 0 || p.result?.signal);
  if (!red.length || red.some(p => p.phase !== 'vitest' || p.result?.signal)) return null;
  if (!failureDetails || failureDetails.truncated !== false || !failureDetails.tests?.length) return null;
  if (!Array.isArray(changedFiles)) return null;
  const changed = new Set(changedFiles);
  if (failureDetails.tests.some(t => changed.has(t.file))) return null;
  return { tests: failureDetails.tests, files: [...new Set(failureDetails.tests.map(t => t.file))] };
}

/**
 * Failures of `files` on `baseSha`, measured once per (main sha, file set) and cached under `cacheDir`.
 * `runBase(files)` returns `{ ok, tests }` (ok=false for a worktree/runner error or a truncated list); an error is
 * never cached and yields `null` ("not proven").
 */
export async function measureBaseFailures({ baseSha, files, runBase, cacheDir, now = () => new Date().toISOString() }) {
  if (!baseSha || !files?.length || typeof runBase !== 'function') return null;
  const path = cacheDir ? join(cacheDir, `${baseSha}.json`) : null;
  let cache = { baseSha, files: {} };
  try { if (path) { const read = JSON.parse(readFileSync(path, 'utf8')); if (read?.baseSha === baseSha && read.files) cache = read; } } catch { /* cold */ }
  const missing = files.filter(f => !cache.files[f]);
  if (missing.length) {
    let result;
    try { result = await runBase(missing); } catch { return null; }
    if (!result?.ok) return null;
    for (const f of missing) cache.files[f] = { tests: result.tests.filter(t => t.file === f), measuredAt: now() };
    try { if (path) { mkdirSync(cacheDir, { recursive: true }); const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(cache)); renameSync(tmp, path); } } catch { /* cache is best-effort */ }
  }
  return { baseSha, tests: files.flatMap(f => cache.files[f].tests), cached: !missing.length };
}

/** `redCause` fields when EVERY failing test also fails on the base, else null (stay red). */
export function classifyPreExisting({ cause, candidate, base }) {
  if (!cause || cause.redCause !== 'out-of-diff-still-red' || cause.redCauseUncertain || !candidate || !base?.baseSha) return null;
  const onBase = new Set(base.tests.map(key));
  if (!candidate.tests.every(t => onBase.has(key(t)))) return null;
  return { redCause: PRE_EXISTING_ON_MAIN, redCauseFiles: cause.redCauseFiles,
    redCauseEvidence: { baseSha: base.baseSha, tests: candidate.tests.slice(0, 20), cached: base.cached === true } };
}

/**
 * Run `files` under vitest on a disposable detached worktree of `baseSha` (node_modules symlinked in). Returns
 * `{ ok, tests }`; `ok:false` for any setup/runner error, a signal, a timeout, or a truncated failure list.
 * Runs inside the caller's already-held heavy slot (no second admission).
 */
export async function runVitestOnBase({ git, repo, baseSha, files, tmp, timeoutMs = 10 * 60_000, spawnFn, collectorFactory, fs }) {
  const { mkdtempSync, rmSync, symlinkSync, existsSync } = fs;
  const dir = mkdtempSync(join(tmp, 'verify-base-'));
  const wt = join(dir, 'wt');
  let added = false;
  try {
    git(['worktree', 'add', '--detach', wt, baseSha]);
    added = true;
    if (existsSync(join(repo, 'node_modules'))) symlinkSync(join(repo, 'node_modules'), join(wt, 'node_modules'), 'dir');
    const collector = collectorFactory({ cwd: wt });
    const { code, signal } = await new Promise((resolve, reject) => {
      const child = spawnFn('npx', ['vitest', 'run', '--maxWorkers=1', '--minWorkers=1', '--no-file-parallelism', ...files.map(f => `./${f}`)],
        { cwd: wt, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
      for (const name of ['stdout', 'stderr']) { child[name].setEncoding('utf8'); child[name].on('data', c => collector.push(c, name)); }
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', (c, s) => { clearTimeout(timer); resolve({ code: c, signal: s }); });
    });
    const details = collector.finish();
    if (signal || details.truncated || (code !== 0 && code !== 1)) return { ok: false, tests: [] };
    return { ok: true, tests: details.tests };
  } catch { return { ok: false, tests: [] }; }
  finally {
    try { if (added) git(['worktree', 'remove', '--force', wt]); } catch { /* pruned below */ }
    try { rmSync(dir, { recursive: true, force: true }); git(['worktree', 'prune']); } catch { /* best effort */ }
  }
}
