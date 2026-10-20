/**
 * @file scripts/lib/latent-red-main.mjs
 * @description Latent red main: main's last push CI is green, but its code no longer passes (a time-dependent test,
 *   an expired fixture). Nothing marks main red, so the drain keeps feeding merge groups that all fail on the same
 *   test (live 2026-10-20: `ledger-readiness-drain-facts.test.mjs` failed every merge group from 04:39Z).
 *
 *   When the newest N completed merge-group CI runs ALL failed and share at least one failing test, this re-runs
 *   main tip's green CI run once (a probe, never a merge) and posts one needs-you event. If main really is red, the
 *   re-run fails and the existing red-main machinery (main-ci-red health watch → red-main-hold, main-fix priority,
 *   redMainSkipCatchUp) takes over. If one bad PR at the queue head was the cause, the re-run stays green and nothing
 *   else changes. The detector itself never holds, dequeues or labels anything.
 *
 *   Merge-group runs are listed through the REST runs endpoint filtered to the CI workflow PATH: they live under a
 *   different workflow id than `actions/workflows/ci.yml`, so `gh run list --workflow ci.yml --event merge_group`
 *   returns `[]` (verified live 2026-10-20).
 *
 *   Setting: `drain.latentRedMainRuns` (standard 3; 0 = off) through we:scripts/lib/drain-throughput.mjs.
 *   Ledger: `<coordination root>/latent-red-main.json` = `{ acted: {[tipSha]: {...}}, lastNoFire }`.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseVitestFailures } from '../conveyor/main-ci-red-core.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { isGhDeferred } from './gh-deferred.mjs';

export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';
/** Aggregate jobs that fail whenever a shard fails; their logs name no test. */
const SUMMARY_JOBS = new Set(['test', 'daemon-soak']);
const MAX_JOB_LOGS_PER_RUN = 3;

const ioOpts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, timeout: 60_000 };
const ghText = (exec, args) => {
  const out = exec('gh', args, ioOpts);
  if (isGhDeferred(out)) throw new Error('gh read deferred (low budget)');
  return String(out ?? '');
};
const ghJson = (exec, args) => JSON.parse(ghText(exec, args) || 'null');

/** REST run row → the `gh run list --json` field names the main-ci-red code already uses. PURE. */
export function normalizeRun(r) {
  return { databaseId: r.id, status: r.status, conclusion: r.conclusion ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
    headBranch: r.head_branch, headSha: r.head_sha, event: r.event, attempt: r.run_attempt, workflowName: r.name, path: r.path };
}

/** IO: CI runs for one event (newest first), filtered to the workflow path. Throws on an unreadable read. */
export function listCiRuns({ repo, exec, event, branch, limit = 30, workflowPath = CI_WORKFLOW_PATH }) {
  const qs = [`event=${encodeURIComponent(event)}`, `per_page=100`, ...(branch ? [`branch=${encodeURIComponent(branch)}`] : [])].join('&');
  const page = ghJson(exec, ['api', `repos/${repo}/actions/runs?${qs}`]);
  if (!Array.isArray(page?.workflow_runs)) throw new Error('actions runs read returned no list');
  return page.workflow_runs.filter((r) => r?.path === workflowPath).map(normalizeRun)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, limit);
}

/** IO: merge-group CI runs (newest first). The fix for the empty `gh run list --workflow --event merge_group`. */
export function listMergeGroupCiRuns({ repo, exec, limit = 30, workflowPath = CI_WORKFLOW_PATH }) {
  return listCiRuns({ repo, exec, event: 'merge_group', limit, workflowPath });
}

/** IO: failing Vitest tests of one run as `file > title` keys, or null when unreadable (fails closed). */
export function readRunFailingTests({ repo, exec, runId }) {
  try {
    const page = ghJson(exec, ['api', `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`]);
    const jobs = Array.isArray(page?.jobs) ? page.jobs : null;
    if (!jobs) return null;
    const failed = jobs.filter((j) => ['failure', 'timed_out'].includes(String(j.conclusion)) && !SUMMARY_JOBS.has(String(j.name)));
    if (!failed.length) return null;
    const keys = new Set();
    for (const j of failed.slice(0, MAX_JOB_LOGS_PER_RUN)) {
      const log = ghText(exec, ['api', `repos/${repo}/actions/jobs/${j.id}/logs`]);
      for (const f of parseVitestFailures(log)) keys.add(`${f.file} > ${f.title}`);
    }
    return keys.size ? [...keys] : null;
  } catch { return null; }
}

const prOf = (headBranch) => { const m = /\/pr-(\d+)-/.exec(String(headBranch ?? '')); return m ? Number(m[1]) : null; };

/**
 * PURE. Fire when the newest `threshold` completed, non-cancelled merge-group runs all failed and every one of them
 * has a readable failing-test list sharing at least one test. In-progress, cancelled and skipped runs are not
 * evidence either way; a success ends the streak. Any unreadable list → no fire.
 * @returns {{fire:boolean, reason:string, tests?:string[], runIds?:number[], prs?:number[]}}
 */
export function detectLatentRedMain({ runs, failuresOf, threshold }) {
  if (!(threshold > 0)) return { fire: false, reason: 'off' };
  const streak = [];
  for (const r of runs || []) {
    if (r.status !== 'completed') continue;
    if (['cancelled', 'skipped', 'neutral', 'stale', null].includes(r.conclusion)) continue;
    if (!['failure', 'timed_out'].includes(r.conclusion)) break;
    streak.push(r);
    if (streak.length >= threshold) break;
  }
  if (streak.length < threshold) return { fire: false, reason: `${streak.length} consecutive failed merge-group run(s) < ${threshold}` };
  let common = null;
  for (const r of streak) {
    const tests = failuresOf(r);
    if (!Array.isArray(tests) || !tests.length) return { fire: false, reason: `run ${r.databaseId} has no readable failing test` };
    common = common ? common.filter((t) => tests.includes(t)) : [...new Set(tests)];
    if (!common.length) return { fire: false, reason: 'the failed merge-group runs share no failing test' };
  }
  return { fire: true, reason: `${threshold} consecutive merge-group CI runs failed on the same test(s)`, tests: common,
    runIds: streak.map((r) => r.databaseId), prs: [...new Set(streak.map((r) => prOf(r.headBranch)).filter(Number.isInteger))] };
}

export function latentRedMainPath(env = process.env) { return join(resolveCoordinationRoot({ env }), 'latent-red-main.json'); }
function readLedger(path) {
  try { const o = JSON.parse(readFileSync(path, 'utf8')); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; }
}

/**
 * IO shell. Never throws. Once per main tip sha: re-run main tip's GREEN CI push run (a completed red / running run
 * is already the red-main machinery's) and publish one needs-you event.
 * @returns {{fired:boolean, action:string, detail?:object}}
 */
export function runLatentRedMainCheck({ repo, exec, threshold, source = 'standard', dryRun = false, now = Date.now(),
  ledgerPath = latentRedMainPath(), publish = null, log = (l) => process.stderr.write(`${l}\n`) }) {
  const setting = `drain.latentRedMainRuns=${threshold} (${source})`;
  try {
    if (!(threshold > 0)) return { fired: false, action: 'off' };
    const runs = listMergeGroupCiRuns({ repo, exec });
    const ledger = readLedger(ledgerPath);
    const head = runs.filter((r) => r.status === 'completed').slice(0, threshold * 3).map((r) => r.databaseId).join(',');
    if (!dryRun && ledger.lastNoFire?.head === head) return { fired: false, action: 'unchanged' };
    const det = detectLatentRedMain({ runs, threshold, failuresOf: (r) => readRunFailingTests({ repo, exec, runId: r.databaseId }) });
    if (!det.fire) {
      if (!dryRun) { mkdirSync(dirname(ledgerPath), { recursive: true }); writeJsonAtomic(ledgerPath, { ...ledger, lastNoFire: { head, at: now, reason: det.reason } }); }
      return { fired: false, action: 'no-signal', detail: det };
    }
    const tipSha = ghText(exec, ['api', `repos/${repo}/commits/main`, '--jq', '.sha']).trim();
    if (!/^[0-9a-f]{40}$/.test(tipSha)) throw new Error('main tip unreadable');
    const what = `${det.reason} (runs ${det.runIds.join(', ')}; groups ${det.prs.map((n) => `#${n}`).join(' ')}): ${det.tests.slice(0, 3).join(' | ')}`;
    if (ledger.acted?.[tipSha]) return { fired: true, action: 'already-acted', detail: { ...det, tipSha } };
    const tipRun = listCiRuns({ repo, exec, event: 'push', branch: 'main', limit: 10 }).find((r) => r.headSha === tipSha) ?? null;
    let action;
    if (!tipRun) action = 'no-main-run';
    else if (tipRun.status !== 'completed') action = 'main-run-in-progress';
    else if (tipRun.conclusion !== 'success') action = 'main-already-red';
    else action = 'rerun-main';
    log(`latent-red-main: ${what} — main tip ${tipSha.slice(0, 9)} CI run ${tipRun?.databaseId ?? 'none'} is ${tipRun ? `${tipRun.status}/${tipRun.conclusion}` : 'missing'} → ${dryRun ? 'DRY RUN, would ' : ''}${action} — ${setting}`);
    if (dryRun) return { fired: true, action, detail: { ...det, tipSha, tipRun: tipRun?.databaseId ?? null } };
    let rerun = null;
    if (action === 'rerun-main') {
      try { ghText(exec, ['run', 'rerun', String(tipRun.databaseId), '--repo', repo]); rerun = 'requested'; }
      catch (e) { rerun = `failed: ${String(e?.message || e).split('\n')[0].slice(0, 200)}`; }
      log(`latent-red-main: re-run of main CI run ${tipRun.databaseId} ${rerun} (source: merge-group failure streak; ${setting})`);
    }
    try {
      (publish ?? defaultPublish)({ repo, pr: 0, head: `latent-red-main:${tipSha}`, kind: 'latent-red-main',
        reason: `main ${tipSha.slice(0, 9)} looks latently red: ${what}; main CI re-run ${rerun ?? `not issued (${action})`}` });
    } catch (e) { log(`latent-red-main: needs-you publish failed (${String(e?.message || e).split('\n')[0]})`); }
    // A failed re-run request is retried on the next pass (the needs-you feed dedups the event by its key).
    if (rerun?.startsWith('failed')) return { fired: true, action, detail: { ...det, tipSha, rerun } };
    mkdirSync(dirname(ledgerPath), { recursive: true });
    writeJsonAtomic(ledgerPath, { ...ledger, acted: { ...(ledger.acted || {}), [tipSha]: { at: now, action, rerun, runIds: det.runIds, tests: det.tests.slice(0, 5), mainRun: tipRun?.databaseId ?? null } } });
    return { fired: true, action, detail: { ...det, tipSha, rerun } };
  } catch (e) {
    log(`latent-red-main: check skipped (${String(e?.message || e).split('\n')[0].slice(0, 200)}) — ${setting}`);
    return { fired: false, action: 'error' };
  }
}

let publishAttentionImpl = null;
function defaultPublish(item) {
  if (!publishAttentionImpl) throw new Error('needs-you feed not loaded');
  return publishAttentionImpl(item);
}
/** Load the needs-you publisher lazily (its import graph is heavier than the drain needs on every pass). */
export async function loadNeedsYouPublisher() {
  try { publishAttentionImpl = (await import('../operations/needs-you-feed.mjs')).publishAttention; } catch { publishAttentionImpl = null; }
}

// CLI: node scripts/lib/latent-red-main.mjs --repo=owner/name [--threshold=3] [--dry-run]
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const { execFileSync } = await import('node:child_process');
  await loadNeedsYouPublisher();
  const r = runLatentRedMainCheck({ repo: arg('repo') || 'web-everything/web-everything', exec: execFileSync,
    threshold: Number(arg('threshold') ?? 3), source: 'cli', dryRun: process.argv.includes('--dry-run') });
  process.stdout.write(`${JSON.stringify(r)}\n`);
}
