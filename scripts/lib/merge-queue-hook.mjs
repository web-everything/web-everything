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
 *      the branch is already on the main tip, record the head and the pass it was requested against (once per pass), and skip this pass. `wait` /
 *      `refuse` → skip this pass with a log line.
 *   It only ADDS a requirement: no existing merge-gate guard is touched, and the drain stays the single writer.
 *
 * SETTINGS: `scripts/settings/merge-queue.json` (`mergeQueue`, `mergeFreshness`), read through
 *   we:scripts/lib/settings-files.mjs. Built-in defaults are OFF = today. Env `WE_DRAIN_MERGE_QUEUE=off` forces
 *   both off (emergency switch). Inside a test run (VITEST / WE_UNDER_TEST) the live file is not read.
 *
 * RE-TEST MODE (`mergeFreshness.retestMode`, operator go 2026-10-09 16:35 ET): `any-code` = the middle ground (any
 *   code main gained since the PR's base forces a refresh); `affected` (default) = only code that can reach the PR
 *   does (we:scripts/lib/merge-queue-affected.mjs: same files, imports followed transitively either way, an unchanged
 *   test that reaches both sides, the gate itself, CI and test infra). Layers: built-in default → the settings file → env `WE_MERGE_QUEUE_RETEST_MODE` (tool override).
 *   Each judged PR logs one `merge-queue · retest: {...}` line (stderr, so it reaches the daemon log under --json).
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { readGit } from './proc-read.mjs';
import { dirname, join } from 'node:path';
import { planQueue, validateQueueSettings, MERGE_QUEUE_DEFAULTS } from './merge-queue.mjs';
import { MERGE_FRESHNESS_DEFAULTS } from './merge-freshness.mjs';
import { readMainRedPriority } from './main-red-priority.mjs';
import { readDeclaredSettings } from './settings-files.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { RETEST_MODES, DEFAULT_RETEST_MODE, readAffectedFacts } from './merge-queue-affected.mjs';
import { isUnderTest } from './under-test.mjs';

export const MERGE_QUEUE_OFF_ENV = 'WE_DRAIN_MERGE_QUEUE';
/** Env: a JSON settings file read INSTEAD of the declared files (always honoured — this is how a test arms the hook). */
export const MERGE_QUEUE_SETTINGS_FILE_ENV = 'WE_MERGE_QUEUE_SETTINGS_FILE';
/** Env: a main-red-priority record file read INSTEAD of the coordination root's (always honoured, like the settings
 *  file above — inside a test run `readMainRedPriority` is otherwise hermetic and reads nothing). */
export const MERGE_QUEUE_MAIN_FIX_FILE_ENV = 'WE_MERGE_QUEUE_MAIN_FIX_FILE';
/** Env: the re-test mode, overriding the settings file (`any-code` | `affected`). */
export const MERGE_QUEUE_RETEST_MODE_ENV = 'WE_MERGE_QUEUE_RETEST_MODE';
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
  if (freshness.nonCodePaths !== undefined && !(Array.isArray(freshness.nonCodePaths) && freshness.nonCodePaths.every((p) => typeof p === 'string' && p))) {
    errors.push('mergeFreshness: nonCodePaths must be a list of non-empty path strings');
    freshness.nonCodePaths = [...DEFAULT_NON_CODE_PATHS];
  }
  const modeEnv = String(env?.[MERGE_QUEUE_RETEST_MODE_ENV] ?? '').trim();
  if (modeEnv) freshness.retestMode = modeEnv;
  freshness.retestMode ??= DEFAULT_RETEST_MODE;
  if (!RETEST_MODES.includes(freshness.retestMode)) {
    // Fail toward MORE re-testing: an unknown mode is today's middle ground, never the looser one.
    errors.push(`mergeFreshness: retestMode must be one of ${RETEST_MODES.join(', ')} (got ${JSON.stringify(freshness.retestMode)}); using any-code`);
    freshness.retestMode = 'any-code';
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
export function prioritizeMainFix(ordered, { mainFix = null, queueSettings = MERGE_QUEUE_DEFAULTS, isCoupleHalf = () => false, repoKeyOf = (c) => c.repo ?? 'we' } = {}) {
  const q = { ...MERGE_QUEUE_DEFAULTS, ...queueSettings };
  if (!q.enabled || !mainFix || !Array.isArray(ordered)) return ordered;
  // The published record is `{repo: 'we', pr, prs: [every fix PR of the red window]}` (main-ci-red-core.mjs#planPriority):
  // `repo` is the constellation KEY, not a slug, and every PR in `prs` is a fix. `repoKeyOf` maps a candidate to its key
  // (the drain passes its own mapper; a null-repo candidate is the local WE clone).
  const fixPrs = new Set([mainFix.pr, ...(Array.isArray(mainFix.prs) ? mainFix.prs : [])].map(Number));
  const fixRepo = mainFix.repo ?? 'we';
  const classOf = (c) => (fixPrs.has(Number(c.num)) && repoKeyOf(c) === fixRepo && !isCoupleHalf(c) ? 'main-fix' : q.defaultClass);
  const fallback = q.classOrder.indexOf(q.defaultClass);
  const rank = (c) => { const i = q.classOrder.indexOf(classOf(c)); return i === -1 ? fallback : i; };
  return ordered.map((c, i) => ({ c, i })).sort((a, b) => (rank(a.c) - rank(b.c)) || (a.i - b.i)).map((x) => x.c);
}

/** The published main-fix PR record (we:scripts/lib/main-red-priority.mjs), or null. `MERGE_QUEUE_MAIN_FIX_FILE_ENV`
 *  names a file to read instead — how a drain-level test publishes one. */
export function readMainFixPriority({ env = process.env, now } = {}) {
  const override = String(env?.[MERGE_QUEUE_MAIN_FIX_FILE_ENV] ?? '').trim();
  return readMainRedPriority(override ? { env, path: override, now } : { env, now });
}

const parseMs = (s) => { const t = Date.parse(s ?? ''); return Number.isFinite(t) ? t : null; };

/**
 * PURE. Reduce check-runs for one head to the rule's `requiredCheck` fact. Newest run wins (a re-run supersedes).
 * Only runs ON `headSha` count.
 */
export function requiredCheckFact(runs, headSha) {
  const onHead = (Array.isArray(runs) ? runs : []).filter((r) => r && r.head_sha === headSha);
  if (!onHead.length) return { state: 'missing', headSha: null, completedAtMs: null, runId: null, checkRunId: null };
  const key = (r) => parseMs(r.started_at) ?? parseMs(r.completed_at) ?? 0;
  const latest = onHead.reduce((a, b) => (key(b) > key(a) || (key(b) === key(a) && (b.id ?? 0) > (a.id ?? 0)) ? b : a));
  const m = /\/actions\/runs\/(\d+)/.exec(String(latest.details_url ?? latest.html_url ?? ''));
  const runId = m ? m[1] : null;
  // `runId` is the WORKFLOW run: `gh run rerun` keeps it and only adds an attempt. `checkRunId` is the check-run's
  // own id, new for every attempt — it is what tells one pass on a head from the next.
  const checkRunId = Number.isInteger(latest.id) ? latest.id : null;
  if (latest.status !== 'completed') return { state: 'pending', headSha, completedAtMs: null, runId, checkRunId };
  const ok = String(latest.conclusion ?? '').toLowerCase() === 'success';
  return { state: ok ? 'passed' : 'failed', headSha, completedAtMs: parseMs(latest.completed_at), runId, checkRunId };
}

/**
 * Read the facts the rule needs, through `gh` (injected: `gh(args) → stdout`). Never throws: a failed read leaves
 * the fact null / incomplete, which the rule turns into `facts-incomplete` (fail closed, refuse).
 * @returns {{pr: object, main: object, errors: string[]}}
 */
export function readMergeFreshnessFacts({ repo = null, num, headSha, requiredCheck = 'test', defaultBranch = 'main', gh, retest }) {
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
  const affected = readRetestFacts({ num, pr, main, retest });
  return affected ? { pr, main, errors, affected } : { pr, main, errors };
}

/**
 * The `affected` verdict for one judged PR, or null when the mode is not `affected` or the facts are incomplete
 * (then the `any-code` rule applies). `retest` = `{mode, nonCodePaths, root?, readAffected?, log?}`; omitted, it is
 * read from the declared settings — never inside a test run, which must arm it explicitly (no git fetch from a test).
 */
export function readRetestFacts({ num, pr, main, retest, env = process.env }) {
  let r = retest;
  if (r === undefined) {
    if (isUnderTest(env)) return null;
    const s = loadMergeQueueSettings({ env });
    if (!hookEnabled(s)) return null;
    r = { mode: s.freshness.retestMode, nonCodePaths: s.freshness.nonCodePaths ?? DEFAULT_NON_CODE_PATHS };
  }
  if (!r || r.mode !== 'affected') return null;
  if (main.complete !== true || pr.filesComplete !== true || !(main.commitsSinceBase > 0)) return null;
  const read = r.readAffected ?? readAffectedFacts;
  const verdict = read({ root: r.root, num, headSha: pr.headSha, tipSha: main.tipSha, prFiles: pr.files, mainFiles: main.filesChangedSinceBase,
    nonCodePaths: r.nonCodePaths ?? DEFAULT_NON_CODE_PATHS });
  const log = r.log ?? ((line) => process.stderr.write(`${line}\n`));
  try {
    log(`merge-queue · retest: ${JSON.stringify({ num: Number(num), mode: 'affected', affected: verdict.affected, reasons: verdict.reasons,
      mainCommits: main.commitsSinceBase, mainCodeFiles: verdict.mainCodeFiles, prFiles: pr.files.length, ms: verdict.ms ?? null,
      outcome: verdict.affected ? 're-test (refresh) unless otherwise fresh' : 'no re-test needed: main delta cannot reach this PR' })}`);
  } catch { /* logging is best-effort */ }
  return verdict;
}

function defaultReadTip(laneRef, root) {
  const out = readGit(['ls-remote', 'origin', `refs/heads/${laneRef}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  return String(out).trim().split(/\s+/)[0] || null;
}

function firstLine(e) { return String(e?.stderr || e?.message || e).split('\n')[0].slice(0, 200); }

/**
 * The MIDDLE-GROUND mode (operator decision 2026-10-09). "Main moved only on files the PR does not touch" counts as
 * fresh ONLY when everything main gained since the PR's base is non-code (docs / backlog cards). Any code change on
 * main since then ⇒ refresh, however young the pass. Why: #4453 and #4547 touched different files and still broke
 * main together — file-disjointness alone does not prove two code changes compose.
 * `nonCodePaths` (setting): `dir/` = a path prefix; anything else = an exact path. Default below.
 */
export const DEFAULT_NON_CODE_PATHS = Object.freeze(['backlog/', 'docs/']);

/** PURE. Is this changed path non-code under the configured patterns? */
export function isNonCodePath(file, patterns = DEFAULT_NON_CODE_PATHS) {
  const f = String(file ?? '');
  return !!f && patterns.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p));
}

/** PURE. Did main gain any code since the PR's base? (Unknown file lists are handled by the rule: fail closed.) */
export function mainGainedCode(main, patterns = DEFAULT_NON_CODE_PATHS) {
  return (main?.commitsSinceBase ?? 0) > 0 && (main?.filesChangedSinceBase ?? []).some((f) => !isNonCodePath(f, patterns));
}

/**
 * PURE. The action for one landing candidate (batch size 1: the candidate is the queue head).
 * @returns {{action: 'merge'|'refresh'|'wait'|'refuse'|'queued', reasons: string[]}}
 */
export function decideMergeQueueAction({ key, num, facts, nowMs, refreshed = {}, settings }) {
  const freshness = { ...settings.freshness };
  refreshed = liveRefreshed(refreshed, { key, check: facts.pr?.requiredCheck, nowMs, windowMs: (freshness.maxAgeMinutes ?? 0) * 60_000 });
  // `affected` mode, and the main delta provably cannot reach this PR: its passing run still proves its code. Main's
  // move is excused like a non-code move (file overlap still refreshes), and so is the pass's age — age only stood in
  // for "main may have changed under it", which the affected check now answers directly.
  const unaffected = freshness.retestMode === 'affected' && facts.affected?.affected === false;
  const codeMoved = !unaffected && freshness.allowDisjointMainMoves && mainGainedCode(facts.main, freshness.nonCodePaths ?? DEFAULT_NON_CODE_PATHS);
  if (codeMoved) freshness.allowDisjointMainMoves = false; // disjointness only excuses non-code moves
  if (unaffected) { freshness.allowDisjointMainMoves = true; freshness.maxAgeMinutes = Infinity; }
  const [row] = planQueue({
    queue: [{ key, num, ...facts.pr }], main: () => facts.main, nowMs, refreshed,
    // The queue order is applied by the drain's own cascade (and `prioritizeMainFix`); here the candidate IS the head.
    queueSettings: { ...settings.queue, batchSize: 1 }, freshnessSettings: freshness,
  });
  let reasons = codeMoved && row.reasons.includes('base-behind-main') ? ['main-gained-code', ...row.reasons] : row.reasons;
  const why = (facts.affected?.reasons ?? []).map((r) => `${facts.affected.affected ? 'affected' : 'unaffected'}:${r}`);
  if (freshness.retestMode === 'affected' && why.length && (unaffected ? row.action === 'merge' : codeMoved)) reasons = [...reasons, ...why];
  if (unaffected && row.action === 'merge') reasons = ['retest-skipped', ...reasons.filter((r) => r !== 'fresh')];
  return { action: row.action, reasons };
}

/**
 * PURE. The skip kind for a merge-queue skip reason (`merge-queue: <action> (<reasons>)…`), or null when the reason
 * is not the merge queue's. Ready for we:scripts/lib/drain-skip-reasons.mjs `classifySkipReason` (wiring is a
 * follow-up: that file is held by open PRs), so these skips stop reading `unrecognized-reason`.
 */
export function classifyMergeQueueSkip(reason) {
  const m = /^merge-queue: (refresh|wait|refuse|queued)\b(.*)$/s.exec(String(reason ?? ''));
  if (!m) return null;
  if (m[1] === 'refuse' && /facts-incomplete/.test(m[2])) return /gh-throttle|rate limit/i.test(m[2]) ? 'merge-queue-gh-throttled' : 'merge-queue-facts-incomplete';
  if (m[1] === 'refresh' && /\bfailed: /.test(m[2])) return 'merge-queue-refresh-failed';
  return `merge-queue-${m[1]}`;
}

/**
 * PURE. A WE carrier is judged merge-fresh at its impl half's turn (so a stale carrier holds the couple together,
 * before the impl lands) and judged AGAIN at its own turn, after the impl merged. Between the two, only the clock
 * moves for an untouched carrier: if its pass crossed the age window in that gap, the second judgment would refresh
 * the carrier and leave the impl landed alone — the very split the pre-check exists to prevent. So the pre-check's
 * verdict stands at the carrier's own turn when the carrier's head AND the main tip are exactly what the pre-check
 * judged and the ONLY thing that changed is the pass's age (`pass-too-old`). Anything else — a pushed head, a moved
 * main tip (a WE merge in between), a different reason — is judged afresh and never excused. The excuse is also
 * time-boxed to `windowMs` after the pre-check cleared the carrier, so a slow or contended impl merge cannot stretch
 * "the gap" without bound.
 * @param {{head: string, tip: string, atMs: number}|null|undefined} pin the head/tip the pre-check judged `merge`, and when
 */
export function couplePinExcuses(pin, { headSha, mainTip, action, reasons, nowMs, windowMs }) {
  const age = nowMs - (pin?.atMs ?? NaN);
  return !!pin && !!headSha && !!mainTip && pin.head === headSha && pin.tip === mainTip
    && Number.isFinite(age) && age >= 0 && age <= windowMs
    && action === 'refresh' && Array.isArray(reasons) && reasons.length > 0 && reasons.every((r) => r === 'pass-too-old');
}

/**
 * Durable "already refreshed this head" record (the drain runs one process per pass). Each entry names the PASS the
 * refresh was requested against — `{head, checkRunId, completedAtMs, atMs}` — not just the head: a re-run keeps the
 * head, so a head-only record would answer `wait` for that head forever, even after the re-run finished and its new
 * pass went stale or main moved on (review of #4619).
 */
export function refreshedStatePath(env = process.env) { return join(resolveCoordinationRoot({ env }), 'merge-queue-refreshed.json'); }
export function readRefreshed(path) {
  try { const r = JSON.parse(readFileSync(path, 'utf8')); return isObj(r) ? r : {}; } catch { return {}; }
}

/**
 * PURE. The `key → head` map `planQueue` consults, keeping only records still in force for the CURRENT pass:
 *   - same head, and the latest pass is the one the refresh was requested against (same check-run id and completion
 *     time): the re-run has not produced a new pass yet ⇒ keep (this is what stops a second re-run);
 *   - a newer pass exists (its re-run finished) ⇒ lapsed: a stale or main-behind head can be refreshed again;
 *   - older than the freshness window ⇒ lapsed: a request that never produced a pass cannot park the head forever;
 *   - a legacy `key → head` string carries no pass identity ⇒ lapsed (worst case one extra refresh).
 */
export function liveRefreshed(refreshed, { key, check, nowMs, windowMs }) {
  const rec = refreshed?.[key];
  if (!isObj(rec) || typeof rec.head !== 'string') return {};
  const samePass = rec.checkRunId === (check?.checkRunId ?? null) && rec.completedAtMs === (check?.completedAtMs ?? null);
  const age = nowMs - rec.atMs;
  const inWindow = Number.isFinite(age) && age >= 0 && age <= windowMs; // a future `atMs` is not "in force"
  return samePass && inWindow ? { [key]: rec.head } : {};
}

/** `pass` = the `requiredCheck` fact the refresh was requested against. */
export function recordRefreshed(path, key, headSha, { max = 500, pass = null, nowMs = Date.now() } = {}) {
  const cur = readRefreshed(path);
  delete cur[key];
  cur[key] = { head: headSha, checkRunId: pass?.checkRunId ?? null, completedAtMs: pass?.completedAtMs ?? null, atMs: nowMs };
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
