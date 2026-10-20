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
import { writeJsonAtomic, withFileLock } from './atomic-json-file.mjs';
import { isGhDeferred } from './gh-deferred.mjs';

export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';
/** Aggregate jobs that fail whenever a shard fails; their logs name no test. */
const SUMMARY_JOBS = new Set(['test', 'daemon-soak']);
const MAX_JOB_LOGS_PER_RUN = 3;

const ioOpts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, timeout: 60_000, killSignal: 'SIGKILL' };
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

const MAX_RUN_PAGES = 5;
/**
 * IO: CI runs for one event (newest first), filtered to the workflow path. The REST list spans every workflow, so it
 * pages (bounded) until `limit` CI rows are collected or the list ends. Throws on an unreadable read and when the
 * page budget runs out first (fail closed: an incomplete sample is never returned as complete).
 */
export function listCiRuns({ repo, exec, event, branch, limit = 30, workflowPath = CI_WORKFLOW_PATH }) {
  const rows = [];
  for (let pageNo = 1; ; pageNo += 1) {
    const qs = [`event=${encodeURIComponent(event)}`, `per_page=100`, ...(branch ? [`branch=${encodeURIComponent(branch)}`] : []), ...(pageNo > 1 ? [`page=${pageNo}`] : [])].join('&');
    const page = ghJson(exec, ['api', `repos/${repo}/actions/runs?${qs}`]);
    if (!Array.isArray(page?.workflow_runs)) throw new Error('actions runs read returned no list');
    rows.push(...page.workflow_runs.filter((r) => r?.path === workflowPath).map(normalizeRun));
    const more = page.workflow_runs.length === 100 && (!Number.isInteger(page.total_count) || pageNo * 100 < page.total_count);
    if (rows.length >= limit || !more) break;
    if (pageNo >= MAX_RUN_PAGES) throw new Error(`only ${rows.length} of ${limit} CI runs within ${MAX_RUN_PAGES} pages`);
  }
  return rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, limit);
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
    if (!Array.isArray(tests) || !tests.length) return { fire: false, unknown: true, reason: `run ${r.databaseId} has no readable failing test` };
    common = common ? common.filter((t) => tests.includes(t)) : [...new Set(tests)];
    if (!common.length) return { fire: false, reason: 'the failed merge-group runs share no failing test' };
  }
  return { fire: true, reason: `${threshold} consecutive merge-group CI runs failed on the same test(s)`, tests: common,
    runIds: streak.map((r) => r.databaseId), prs: [...new Set(streak.map((r) => prOf(r.headBranch)).filter(Number.isInteger))] };
}

export function latentRedMainPath(env = process.env) { return join(resolveCoordinationRoot({ env }), 'latent-red-main.json'); }
/** `{}` when absent; null when present but unreadable or malformed (callers fail closed: no re-run). */
function readLedger(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { return e?.code === 'ENOENT' ? {} : null; }
  try { const o = JSON.parse(text); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; }
}
const NO_FIRE_TTL_MS = 30 * 60_000;
const MAX_RERUN_ATTEMPTS = 3;
const MERGE_GROUP_SAMPLE = 15;

/**
 * IO shell. Never throws. Once per main tip sha (durable record under a file lock): re-run main tip's GREEN CI push
 * run and publish one needs-you event. An unreadable ledger never re-runs (needs-you only). A re-run is recorded as
 * done only after the request succeeds; a refused request is retried at most MAX_RERUN_ATTEMPTS times in all; a
 * reservation whose outcome is unknown (process died mid-request) is never re-issued.
 * @returns {{fired:boolean, action:string, detail?:object}}
 */
export function runLatentRedMainCheck({ repo, exec, threshold, source = 'standard', dryRun = false, now = Date.now(),
  ledgerPath = latentRedMainPath(), publish = null, log = (l) => process.stderr.write(`${l}\n`), lock = withFileLock }) {
  const say = (line) => { try { log(line); } catch { /* logging never breaks a drain pass */ } };
  const setting = `drain.latentRedMainRuns=${threshold} (${source})`;
  const publishOnce = (item) => {
    try { (publish ?? defaultPublish)(item); return true; }
    catch (e) { say(`latent-red-main: needs-you publish failed (${String(e?.message || e).split('\n')[0]})`); return false; }
  };
  try {
    if (!(threshold > 0)) return { fired: false, action: 'off' };
    if (!dryRun) mkdirSync(dirname(ledgerPath), { recursive: true });
    const runs = listMergeGroupCiRuns({ repo, exec, limit: Math.max(MERGE_GROUP_SAMPLE, threshold * 3) });
    const head = runs.filter((r) => r.status === 'completed').slice(0, threshold * 3)
      .map((r) => `${r.databaseId}:${r.attempt}:${r.status}:${r.conclusion}`).join(',');
    const peek = readLedger(ledgerPath);
    if (!dryRun && peek?.lastNoFire?.head === head && now - peek.lastNoFire.at < NO_FIRE_TTL_MS) return { fired: false, action: 'unchanged' };
    const det = detectLatentRedMain({ runs, threshold, failuresOf: (r) => readRunFailingTests({ repo, exec, runId: r.databaseId }) });
    if (!det.fire) {
      // Only a definitive answer is cached; unreadable evidence is re-read next pass.
      if (!dryRun && !det.unknown && peek) {
        lock(`${ledgerPath}.lock`, () => {
          const cur = readLedger(ledgerPath);
          if (cur) { mkdirSync(dirname(ledgerPath), { recursive: true }); writeJsonAtomic(ledgerPath, { ...cur, lastNoFire: { head, at: now, reason: det.reason } }); }
        });
      }
      return { fired: false, action: 'no-signal', detail: det };
    }
    const tipSha = ghText(exec, ['api', `repos/${repo}/commits/main`, '--jq', '.sha']).trim();
    if (!/^[0-9a-f]{40}$/.test(tipSha)) throw new Error('main tip unreadable');
    const what = `${det.reason} (runs ${det.runIds.join(', ')}; groups ${det.prs.map((n) => `#${n}`).join(' ')}): ${det.tests.slice(0, 3).join(' | ')}`;
    const tipRun = listCiRuns({ repo, exec, event: 'push', branch: 'main', limit: 10 }).find((r) => r.headSha === tipSha) ?? null;
    let action;
    if (!tipRun) action = 'no-main-run';
    else if (tipRun.status !== 'completed') action = 'main-run-in-progress';
    else if (tipRun.conclusion !== 'success') action = 'main-already-red';
    else action = 'rerun-main';
    const item = (rerun) => ({ repo, pr: 0, head: `latent-red-main:${tipSha}`, kind: 'latent-red-main',
      reason: `main ${tipSha.slice(0, 9)} looks latently red: ${what}; main CI re-run ${rerun}` });
    if (dryRun) {
      say(`latent-red-main: ${what} — main tip ${tipSha.slice(0, 9)} CI run ${tipRun?.databaseId ?? 'none'} is ${tipRun ? `${tipRun.status}/${tipRun.conclusion}` : 'missing'} → DRY RUN, would ${action} — ${setting}`);
      return { fired: true, action, detail: { ...det, tipSha, tipRun: tipRun?.databaseId ?? null } };
    }
    // Nothing to probe yet (no run / still running): decide again next pass, record nothing.
    if (action === 'no-main-run' || action === 'main-run-in-progress') {
      say(`latent-red-main: ${what} — main tip ${tipSha.slice(0, 9)} CI ${action}; re-checked next pass — ${setting}`);
      return { fired: true, action, detail: { ...det, tipSha } };
    }
    // Reserve the attempt durably under the lock BEFORE any re-run request.
    const reserved = lock(`${ledgerPath}.lock`, () => {
      const cur = readLedger(ledgerPath);
      if (!cur) return { go: false, why: 'ledger-unreadable' };
      const prev = cur.acted?.[tipSha];
      if (prev && !(prev.status === 'failed' && (prev.attempts ?? 1) < MAX_RERUN_ATTEMPTS)) return { go: false, why: 'already-acted', prev };
      if (action !== 'rerun-main') {
        mkdirSync(dirname(ledgerPath), { recursive: true });
        writeJsonAtomic(ledgerPath, { ...cur, acted: { ...(cur.acted || {}), [tipSha]: { at: now, status: action, runIds: det.runIds, tests: det.tests.slice(0, 5), mainRun: tipRun.databaseId, published: false } } });
        return { go: false, why: action, record: true };
      }
      const attempts = (prev?.attempts ?? 0) + 1;
      mkdirSync(dirname(ledgerPath), { recursive: true });
      writeJsonAtomic(ledgerPath, { ...cur, acted: { ...(cur.acted || {}), [tipSha]: { at: now, status: 'reserved', attempts, runIds: det.runIds, tests: det.tests.slice(0, 5), mainRun: tipRun.databaseId, published: prev?.published === true } } });
      return { go: true, attempts };
    });
    const update = (patch) => lock(`${ledgerPath}.lock`, () => {
      const cur = readLedger(ledgerPath);
      if (!cur?.acted?.[tipSha]) return;
      writeJsonAtomic(ledgerPath, { ...cur, acted: { ...cur.acted, [tipSha]: { ...cur.acted[tipSha], ...patch } } });
    });
    if (!reserved.go) {
      if (reserved.why === 'ledger-unreadable') {
        say(`latent-red-main: ${what} — ledger ${ledgerPath} unreadable: NO re-run, needs-you only — ${setting}`);
        publishOnce(item('not issued (latent-red-main ledger unreadable)'));
        return { fired: true, action: 'ledger-unreadable', detail: { ...det, tipSha } };
      }
      if (reserved.why === 'already-acted') {
        if (reserved.prev?.published !== true && publishOnce(item(`${reserved.prev?.status ?? 'recorded'} earlier`))) update({ published: true });
        return { fired: true, action: 'already-acted', detail: { ...det, tipSha } };
      }
      say(`latent-red-main: ${what} — main tip ${tipSha.slice(0, 9)} CI run ${tipRun.databaseId} is ${tipRun.status}/${tipRun.conclusion} → ${action} (left to the red-main machinery) — ${setting}`);
      if (publishOnce(item(`not issued (${action})`))) update({ published: true });
      return { fired: true, action, detail: { ...det, tipSha } };
    }
    say(`latent-red-main: ${what} — main tip ${tipSha.slice(0, 9)} CI run ${tipRun.databaseId} is completed/success → re-running it (attempt ${reserved.attempts}/${MAX_RERUN_ATTEMPTS}; source: merge-group failure streak) — ${setting}`);
    let rerun;
    // Only a request proven never sent (a gh-throttle deferral) is retryable; any other error may have been applied
    // by GitHub (lost response, timeout), so it stays an unknown-outcome reservation and is never re-issued.
    let status;
    try {
      const out = exec('gh', ['run', 'rerun', String(tipRun.databaseId), '--repo', repo], ioOpts);
      if (isGhDeferred(out)) { rerun = 'failed: deferred before sending (low gh budget)'; status = 'failed'; }
      else { rerun = 'requested'; status = 'requested'; }
    } catch (e) { rerun = `outcome unknown: ${String(e?.message || e).split('\n')[0].slice(0, 200)}`; status = 'unknown'; }
    update({ status, rerun, at: now });
    say(`latent-red-main: re-run of main CI run ${tipRun.databaseId} ${rerun} — ${setting}`);
    if (publishOnce(item(rerun))) update({ published: true });
    return { fired: true, action, detail: { ...det, tipSha, rerun } };
  } catch (e) {
    say(`latent-red-main: check skipped (${String(e?.message || e).split('\n')[0].slice(0, 200)}) — ${setting}`);
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
