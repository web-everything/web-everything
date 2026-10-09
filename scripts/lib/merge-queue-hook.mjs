/**
 * @file scripts/lib/merge-queue-hook.mjs
 * @description The drain's merge-queue hook (card xs1hdl7): the IO around the PURE rules in
 *   `./merge-freshness.mjs` and `./merge-queue.mjs`, called by we:scripts/merge-ai-prs.mjs right before its one
 *   `mergePr(...)` write, after every existing gate has already passed.
 *
 * WHY: 2026-10-09 07:44 ET main went red because #4453 and #4547 were each green alone but broke together.
 *   #4547 merged at 11:23Z on a `test` pass from 09:15Z (128 min old, base 81 commits behind main). On
 *   2026-10-08 #4361 merged on a 103-min-old pass. A pass only proves the code that ran.
 *
 * WHAT IT DOES per landing candidate:
 *   1. read the freshness facts (required check on the head, merge-base vs the main tip, files on both sides);
 *   2. ask `planQueue` (one entry, batch size 1) for the action;
 *   3. `merge` → the drain merges unchanged. `refresh` → rebuild the PR onto main through the sanctioned
 *      `refreshOntoMain` path (we:scripts/conveyor/ci-red-recovery-watch.mjs), or re-run its required check when
 *      the branch is already on the main tip, record the head (once per head), and skip this pass. `wait` /
 *      `refuse` → skip this pass with a log line.
 *   It only ADDS a requirement: no existing merge-gate guard is touched, and the drain stays the single writer.
 *
 * SETTINGS: `scripts/settings/merge-queue.json` (`mergeQueue`, `mergeFreshness`), read through
 *   we:scripts/lib/settings-files.mjs. Built-in defaults are OFF = today. Env `WE_DRAIN_MERGE_QUEUE=off` forces
 *   both off (emergency switch). Inside a test run (VITEST / WE_UNDER_TEST) the live file is not read.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { planQueue, validateQueueSettings, MERGE_QUEUE_DEFAULTS } from './merge-queue.mjs';
import { MERGE_FRESHNESS_DEFAULTS } from './merge-freshness.mjs';
import { readDeclaredSettings } from './settings-files.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { writeJsonAtomic } from './atomic-json-file.mjs';

export const MERGE_QUEUE_OFF_ENV = 'WE_DRAIN_MERGE_QUEUE';
/** Env: a JSON settings file read INSTEAD of the declared files (always honoured — this is how a test arms the hook). */
export const MERGE_QUEUE_SETTINGS_FILE_ENV = 'WE_MERGE_QUEUE_SETTINGS_FILE';
/** GitHub caps: compare returns at most 300 files; the PR files endpoint at most 3000. */
export const COMPARE_FILES_CAP = 300;
export const PR_FILES_CAP = 3000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The merged settings. Never throws. An invalid `mergeQueue` block falls back to the queue defaults (off) and is
 * named in `errors`; the freshness block is independent.
 * @returns {{queue: object, freshness: object, errors: string[]}}
 */
export function loadMergeQueueSettings({ file, env = process.env } = {}) {
  let src = file;
  const errors = [];
  const override = String(env?.[MERGE_QUEUE_SETTINGS_FILE_ENV] ?? '').trim();
  if (src === undefined && override) {
    try { src = JSON.parse(readFileSync(override, 'utf8')); } catch (e) { src = {}; errors.push(`${MERGE_QUEUE_SETTINGS_FILE_ENV}: ${firstLine(e)}`); }
  }
  // Hermetic by default (the main-red-priority.mjs precedent): inside a test run the live files are not read, so a
  // test that spawns the real drain CLI keeps today's behaviour unless it arms the hook through the env file above.
  if (src === undefined && (env?.VITEST || env?.WE_UNDER_TEST)) src = {};
  if (src === undefined) {
    const read = readDeclaredSettings();
    src = read.settings;
    // A broken settings file is never silent: the drain logs `errors` every pass (the hook would read as off).
    errors.push(...read.errors.map((e) => `${e.source}: ${e.error}`));
  }
  const queue = { ...MERGE_QUEUE_DEFAULTS, ...(isObj(src?.mergeQueue) ? src.mergeQueue : {}) };
  const freshness = { ...MERGE_FRESHNESS_DEFAULTS, ...(isObj(src?.mergeFreshness) ? src.mergeFreshness : {}) };
  const valid = validateQueueSettings(queue);
  if (!valid.ok) { errors.push(...valid.errors.map((e) => `mergeQueue: ${e}`)); Object.assign(queue, MERGE_QUEUE_DEFAULTS); }
  if (!Number.isFinite(freshness.maxAgeMinutes) || freshness.maxAgeMinutes <= 0) {
    errors.push('mergeFreshness: maxAgeMinutes must be a positive number');
    freshness.maxAgeMinutes = MERGE_FRESHNESS_DEFAULTS.maxAgeMinutes;
  }
  if (String(env?.[MERGE_QUEUE_OFF_ENV] ?? '').trim().toLowerCase() === 'off') { queue.enabled = false; freshness.enabled = false; }
  return { queue, freshness, errors };
}

/** Is the freshness hook on? Off ⇒ the merge site does no freshness read and merges as today. (Main-fix ordering
 *  has its own switch, `mergeQueue.enabled`.) */
export function hookEnabled(settings) {
  return !!settings?.freshness?.enabled;
}

/**
 * PURE. Move the published main-fix PR (we:scripts/lib/main-red-priority.mjs) to the front of the cascade, by
 * the queue's ruled class order; every other PR keeps its order (stable). A couple half is never moved: its
 * carrier/impl ordering is the couple cascade's own invariant. Off ⇒ the list unchanged.
 */
export function prioritizeMainFix(ordered, { mainFix = null, queueSettings = MERGE_QUEUE_DEFAULTS, isCoupleHalf = () => false } = {}) {
  const q = { ...MERGE_QUEUE_DEFAULTS, ...queueSettings };
  if (!q.enabled || !mainFix || !Array.isArray(ordered)) return ordered;
  const classOf = (c) => (Number(c.num) === Number(mainFix.pr) && (c.repo ?? mainFix.repo ?? null) === (mainFix.repo ?? c.repo ?? null)
    && !isCoupleHalf(c) ? 'main-fix' : q.defaultClass);
  const fallback = q.classOrder.indexOf(q.defaultClass);
  const rank = (c) => { const i = q.classOrder.indexOf(classOf(c)); return i === -1 ? fallback : i; };
  return ordered.map((c, i) => ({ c, i })).sort((a, b) => (rank(a.c) - rank(b.c)) || (a.i - b.i)).map((x) => x.c);
}

const parseMs = (s) => { const t = Date.parse(s ?? ''); return Number.isFinite(t) ? t : null; };

/**
 * PURE. Reduce check-runs for one head to the rule's `requiredCheck` fact. Newest run wins (a re-run supersedes).
 * Only runs ON `headSha` count.
 */
export function requiredCheckFact(runs, headSha) {
  const onHead = (Array.isArray(runs) ? runs : []).filter((r) => r && r.head_sha === headSha);
  if (!onHead.length) return { state: 'missing', headSha: null, completedAtMs: null, runId: null };
  const key = (r) => parseMs(r.started_at) ?? parseMs(r.completed_at) ?? 0;
  const latest = onHead.reduce((a, b) => (key(b) > key(a) || (key(b) === key(a) && (b.id ?? 0) > (a.id ?? 0)) ? b : a));
  const m = /\/actions\/runs\/(\d+)/.exec(String(latest.details_url ?? latest.html_url ?? ''));
  const runId = m ? m[1] : null;
  if (latest.status !== 'completed') return { state: 'pending', headSha, completedAtMs: null, runId };
  const ok = String(latest.conclusion ?? '').toLowerCase() === 'success';
  return { state: ok ? 'passed' : 'failed', headSha, completedAtMs: parseMs(latest.completed_at), runId };
}

/**
 * Read the facts the rule needs, through `gh` (injected: `gh(args) → stdout`). Never throws: a failed read leaves
 * the fact null / incomplete, which the rule turns into `facts-incomplete` (fail closed, refuse).
 * @returns {{pr: object, main: object, errors: string[]}}
 */
export function readMergeFreshnessFacts({ repo = null, num, headSha, requiredCheck = 'test', defaultBranch = 'main', gh }) {
  const slug = repo || '{owner}/{repo}';
  const errors = [];
  const json = (args) => {
    const out = String(gh(args) ?? '').trim();
    if (!out) throw new Error('empty gh reply');
    return JSON.parse(out);
  };
  const pr = { headSha: headSha || null, baseSha: null, files: [], filesComplete: false, requiredCheck: null };
  const main = { tipSha: null, commitsSinceBase: null, filesChangedSinceBase: [], complete: false };
  try {
    const pages = json(['api', `repos/${slug}/commits/${encodeURIComponent(headSha)}/check-runs?check_name=${encodeURIComponent(requiredCheck)}&per_page=100`, '--paginate', '--slurp']);
    pr.requiredCheck = requiredCheckFact((Array.isArray(pages) ? pages : []).flatMap((p) => p?.check_runs ?? []), headSha);
  } catch (e) { errors.push(`check-runs: ${firstLine(e)}`); }
  try {
    const tip = json(['api', `repos/${slug}/branches/${encodeURIComponent(defaultBranch)}`, '--jq', '{sha: .commit.sha}']);
    main.tipSha = typeof tip?.sha === 'string' ? tip.sha : null;
    if (main.tipSha && headSha) {
      // Three-dot compare head...tip: merge_base_commit = the PR's base; ahead_by and files = main since that base.
      const cmp = json(['api', `repos/${slug}/compare/${headSha}...${main.tipSha}`, '--jq',
        '{base: .merge_base_commit.sha, ahead: .ahead_by, files: [.files[]? | .filename, (.previous_filename // empty)], n: (.files // [] | length)}']);
      pr.baseSha = typeof cmp?.base === 'string' ? cmp.base : null;
      main.commitsSinceBase = Number.isInteger(cmp?.ahead) ? cmp.ahead : null;
      main.filesChangedSinceBase = Array.isArray(cmp?.files) ? cmp.files : [];
      main.complete = main.commitsSinceBase !== null && (main.commitsSinceBase === 0 || cmp.n < COMPARE_FILES_CAP);
    }
  } catch (e) { errors.push(`compare: ${firstLine(e)}`); }
  try {
    const pages = json(['api', `repos/${slug}/pulls/${num}/files?per_page=100`, '--paginate', '--slurp']);
    const rows = (Array.isArray(pages) ? pages : []).flat();
    pr.files = rows.flatMap((f) => [f?.filename, f?.previous_filename]).filter((f) => typeof f === 'string');
    pr.filesComplete = rows.length < PR_FILES_CAP && rows.every((f) => typeof f?.filename === 'string');
  } catch (e) { errors.push(`pr-files: ${firstLine(e)}`); }
  return { pr, main, errors };
}

function defaultReadTip(laneRef, root) {
  const out = execFileSync('git', ['ls-remote', 'origin', `refs/heads/${laneRef}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  return String(out).trim().split(/\s+/)[0] || null;
}

function firstLine(e) { return String(e?.stderr || e?.message || e).split('\n')[0].slice(0, 200); }

/**
 * PURE. The action for one landing candidate (batch size 1: the candidate is the queue head).
 * @returns {{action: 'merge'|'refresh'|'wait'|'refuse'|'queued', reasons: string[]}}
 */
export function decideMergeQueueAction({ key, num, facts, nowMs, refreshed = {}, settings }) {
  const [row] = planQueue({
    queue: [{ key, num, ...facts.pr }], main: () => facts.main, nowMs, refreshed,
    // The queue order is applied by the drain's own cascade (and `prioritizeMainFix`); here the candidate IS the head.
    queueSettings: { ...settings.queue, batchSize: 1 }, freshnessSettings: settings.freshness,
  });
  return { action: row.action, reasons: row.reasons };
}

/** Durable "already refreshed this head" record (the drain runs one process per pass). */
export function refreshedStatePath(env = process.env) { return join(resolveCoordinationRoot({ env }), 'merge-queue-refreshed.json'); }
export function readRefreshed(path) {
  try { const r = JSON.parse(readFileSync(path, 'utf8')); return isObj(r) ? r : {}; } catch { return {}; }
}
export function recordRefreshed(path, key, headSha, { max = 500 } = {}) {
  const cur = readRefreshed(path);
  delete cur[key];
  cur[key] = headSha;
  const keys = Object.keys(cur);
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) delete cur[k];
  try { mkdirSync(dirname(path), { recursive: true }); writeJsonAtomic(path, cur); } catch { /* best-effort: worst case one extra refresh */ }
  return cur;
}

/**
 * Refresh a stale PR. Rebuild onto main through `refreshOntoMain` (the sanctioned path the CI-red recovery uses).
 * When the branch is already on the main tip (`current`, nothing to rebuild — only the pass is too old), re-run
 * the required check's workflow run instead (`gh run rerun`, throttled), so a new pass is produced.
 * @returns {Promise<{ok: boolean, action: string, newCommit?: string|null, error?: string}>}
 */
export async function refreshStalePr({ laneRef, root, repo = null, runId = null, expectedHead = null, readTip, refresh, rerun }) {
  if (!laneRef) return { ok: false, action: 'error', error: 'no head ref' };
  // Pin to the judged head: the refresh works on the branch NAME, so a push since the judgment would otherwise be
  // rebuilt (and its acceptance re-stamped) unjudged. A moved or unreadable tip refuses; the next pass re-judges.
  // (The rebuild itself pushes a fast-forward of the fetched tip, so a push racing the rebuild is rejected by git.)
  if (expectedHead) {
    let tip = null;
    try { tip = (readTip ?? defaultReadTip)(laneRef, root); } catch { tip = null; }
    if (tip !== expectedHead) return { ok: false, action: 'head-moved', error: `branch tip ${tip ? tip.slice(0, 9) : 'unreadable'} is not the judged head ${expectedHead.slice(0, 9)}` };
  }
  const doRefresh = refresh ?? (await import('../conveyor/ci-red-recovery-watch.mjs')).refreshOntoMain;
  const r = doRefresh(laneRef, root ? { root } : {});
  if (!r?.ok) return { ok: false, action: r?.action ?? 'error', error: r?.error ?? 'refresh failed' };
  if (r.action !== 'current') return { ok: true, action: r.action, newCommit: r.newCommit ?? null };
  if (!runId) return { ok: false, action: 'current-no-run', error: 'branch already on main and the required run id is unknown' };
  try {
    if (rerun) rerun(runId);
    else {
      const { execFileSyncThrottled } = await import('./gh-throttle.mjs');
      execFileSyncThrottled('gh', ['run', 'rerun', String(runId), ...(repo ? ['--repo', repo] : [])],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    }
    return { ok: true, action: 'rerun', newCommit: null };
  } catch (e) { return { ok: false, action: 'rerun-failed', error: firstLine(e) }; }
}
