/** Required-check diagnostics and a strictly changes-only, head-deduplicated send-back. */
import { latestCheckNamed, isFailedCheckRow } from './rollup-collapse.mjs';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';
import { classifySkipReason } from './drain-skip-reasons.mjs';
import { spawnSync } from 'node:child_process';
import { readMainCiRuns } from './main-ci-reader.mjs';
import { mainRedState } from '../conveyor/main-ci-red-core.mjs';
import { readSharedFreeze } from './red-main-freeze-shared.mjs';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, openSync, closeSync, statSync, accessSync, constants, fsyncSync, futimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const shaPattern = /^[0-9a-f]{40}$/i;
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const clean = value => value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').trim();
const firstLine = row => [row.summary, row.output?.summary, row.title, row.output?.title, row.description]
  .filter(value => typeof value === 'string').flatMap(value => value.split(/\r?\n/).map(clean)).find(Boolean) || '';
// Paged rows expose databaseId as checkRunId; the shared selector reads id.
const withRunIds = rows => rows.map(row => ({ ...row,
  ...(!(Number.isSafeInteger(Number(row.id)) && Number(row.id) > 0) && Number.isInteger(row.checkRunId)
    ? { id: row.checkRunId } : {}) }));

/** Pure; unknown evidence retains the caller's original BLOCKED reason. Missing rows wait. */
export function describeBlockedChecks(pr, requiredChecks) {
  try {
    if (!record(pr) || pr.requiredCheckReadError || !Array.isArray(pr.statusCheckRollup)
      || pr.statusCheckRollup.some(row => !record(row) || typeof (row.name || row.context) !== 'string')
      || !Array.isArray(requiredChecks) || !requiredChecks.length
      || requiredChecks.some(name => typeof name !== 'string' || !name.trim())) return null;
    const rollup = withRunIds(pr.statusCheckRollup);
    const failed = [], waiting = [];
    for (const name of new Set(requiredChecks)) {
      // Keep the shared run-ID/rollup ordering: queued replacements have no timestamps yet.
      const row = latestCheckNamed(rollup, name);
      const label = JSON.stringify(clean(name));
      if (!row) { waiting.push(`waiting on required check ${label} (absent)`); continue; }
      const conclusion = String(row.conclusion || row.state || '').toUpperCase();
      const status = String(row.status || row.state || '').toUpperCase();
      if (isFailedCheckRow(row)) {
        const detail = firstLine(row);
        failed.push(`required check ${label} ${conclusion}${detail ? `: ${detail}` : ''}`);
      } else if (['IN_PROGRESS', 'QUEUED', 'PENDING'].includes(status)) {
        waiting.push(`waiting on required check ${label} (${status})`);
      } else if (!['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion)) return null;
    }
    return { failed, waiting, text: [...failed, ...waiting].join('; ') };
  } catch { return null; }
}

const validLedger = ledger => record(ledger) && Object.entries(ledger).every(([head, sent]) => shaPattern.test(head) && sent === true);

/** ledger is the sent-head record for this repo/PR. Never mutates it. */
export function decideGateSendBack({ pr, headSha, requiredChecks, ledger } = {}) {
  try {
    if (typeof headSha !== 'string' || !shaPattern.test(headSha) || headSha !== pr?.headRefOid
      || pr.rowsComplete !== true || pr.rowsHead !== headSha
      || !validLedger(ledger)
      || !Array.isArray(pr.labels) || !pr.labels.some(label => (typeof label === 'string' ? label : label?.name) === 'ready-to-merge')) return { send: false };
    const description = describeBlockedChecks(pr, requiredChecks);
    if (!description?.failed.length) return { send: false };
    return { send: true, body: description.failed.join('; ') };
  } catch { return { send: false }; }
}

// Verdict headings review-set-label.mjs and the human ceremony write. Bounce is broad (any `🔁 … review`), clearing is exact.
const BOUNCE_HEADING = /^🔁\s+(?:human\s+)?review\b/u;
const CLEARING_HEADING = /^✅\s+(?:(?:human\s+)?review\s+[—-]\s+accepted|review\s+[—-]\s+`review:human` cleared)/u;
const time = value => typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
const hold = reason => ({ sent: false, reason: `merge-gate ${reason}; kept skipped` });
function liveHeadMatches(pr, repo, headSha, exec, cwd) {
  try {
    const live = exec('gh', ['pr', 'view', String(pr.number), `--repo=${repo}`, '--json=headRefOid'],
      { cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    return live?.status === 0 && JSON.parse(live.stdout).headRefOid === headSha;
  } catch { return false; }
}

/** Required-gate send-back: drain MUST NOT record a verdict from a required merge-gate red whose completion
 * predates the latest clearing verdict, main settle, or freeze lift, or while main/freeze is unreadable. */
function gateDisposition({ pr, requiredChecks, repo, headSha, ledgerPath, ledgered, readComments, readMain, readFreeze, defaultBranch, exec, cwd }) {
  const failed = describeBlockedChecks(pr, requiredChecks)?.failed ?? [];
  if (failed.length !== 1 || !failed[0].startsWith('required check "merge-gate"')) return null;
  let main, freeze;
  try { main = readMain({ repo, defaultBranch, cwd, exec: (cmd, args, options) => {
    const r = exec(cmd, args, { ...options, cwd });
    if (r?.status !== 0) throw Error('main CI unreadable');
    return r.stdout;
  } }); } catch { return hold('main unreadable'); }
  if (main?.error || mainRedState(main?.runs).status !== 'green' || main.runs.some(r => String(r?.status).toLowerCase() !== 'completed' && Number(r?.attempt) > 1)
    || !Number.isFinite(time(main?.settledAt))) return hold('main red, pending or unreadable settle time');
  try { freeze = readFreeze(); } catch { return hold('freeze unreadable'); }
  if (freeze?.error || freeze?.frozen !== false || !Number.isFinite(time(freeze?.publishedAt))) return hold('freeze frozen or unreadable lift time');
  const gate = latestCheckNamed(withRunIds(pr.statusCheckRollup), 'merge-gate');
  const runId = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/([1-9]\d*)(?:\/|$)/.exec(String(gate?.detailsUrl ?? gate?.details_url ?? ''));
  if (!runId || runId[1] !== repo || !Number.isSafeInteger(Number(runId[2]))) return hold('run binding unreadable URL');
  let run;
  try {
    const r = exec('gh', ['api', `repos/${repo}/actions/runs/${runId[2]}`], { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    if (r?.status !== 0) throw Error('run unreadable');
    run = JSON.parse(r.stdout);
  } catch { return hold('run binding unreadable'); }
  const A = run?.run_attempt;
  if (run?.id !== Number(runId[2]) || run?.repository?.full_name !== repo || run?.name !== 'Merge gate'
    || !/^\.github\/workflows\/merge-gate\.yml(?:@.+)?$/.test(run?.path ?? '') || run?.event !== 'pull_request_target'
    || !Array.isArray(run?.pull_requests) || !run.pull_requests.some(p => p?.number === pr.number)
    || String(run?.head_sha).toLowerCase() !== headSha.toLowerCase() || !Number.isSafeInteger(A) || A < 1) return hold('run binding mismatch');
  if (['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status)) return hold('re-run in progress');
  if (run.status !== 'completed') return hold('run status unreadable');
  if (run.conclusion === 'success') return hold('run succeeded');
  if (!['failure', 'timed_out', 'startup_failure', 'cancelled', 'action_required', 'stale'].includes(run.conclusion)) return hold('run conclusion unreadable');
  const workflowUpdatedAt = time(run.updated_at), rowAt = time(gate?.completedAt ?? gate?.completed_at);
  if (!Number.isFinite(workflowUpdatedAt) || !Number.isFinite(rowAt)) return hold('completion time unreadable');
  // A run URL survives re-runs. Bind the check's completion to this attempt before using its time.
  try {
    const r = exec('gh', ['api', `repos/${repo}/actions/runs/${runId[2]}/attempts/${A}/jobs?per_page=100`],
      { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    if (r?.status !== 0) throw Error('jobs unreadable');
    const page = JSON.parse(r.stdout), checkId = Number(gate.id);
    if (!Number.isSafeInteger(checkId) || checkId < 1 || !Array.isArray(page?.jobs)
      || !Number.isInteger(page.total_count) || page.total_count !== page.jobs.length || page.total_count > 100) throw Error('jobs incomplete');
    const matches = page.jobs.filter(j => j?.check_run_url === `https://api.github.com/repos/${repo}/check-runs/${checkId}`);
    if (matches.length !== 1) throw Error('check absent or ambiguous');
    const job = matches[0];
    if (job.run_id !== run.id || job.run_attempt !== A || job.status !== 'completed' || !isFailedCheckRow(job)
      || time(job.completed_at) !== rowAt) throw Error('attempt completion mismatch');
  } catch { return hold('completion binding unreadable or mismatched; retry after checks refresh or operator must inspect attempt jobs'); }
  let latestAt = -Infinity, latest;
  try {
    const comments = readComments(pr.number, { repo });
    if (!Array.isArray(comments)) throw Error('comments unreadable');
    for (const c of comments) {
      const body = String(c?.body ?? '').trimStart();
      if (!isTrustedMarkerAuthor(c) || !(BOUNCE_HEADING.test(body) || CLEARING_HEADING.test(body))) continue;
      const at = time(c.createdAt ?? c.created_at);
      if (!Number.isFinite(at)) throw Error('verdict time unreadable');
      if (at >= latestAt) { latestAt = at; latest = body; }
    }
    if (!latest) throw Error('verdict absent');
  } catch { return hold('verdict unreadable'); }
  const clearAt = Math.max(CLEARING_HEADING.test(latest) ? latestAt : -Infinity, time(main.settledAt), time(freeze.publishedAt));
  if (rowAt >= clearAt) return ledgered ? hold('head already ledgered; fresh red') : null;
  const path = `${ledgerPath}.${repo.replace('/', '~')}.${pr.number}.${headSha.toLowerCase()}.${runId[2]}.rerun.json`;
  let state;
  try { state = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') return hold('re-run state unreadable; operator must repair'); }
  if (state !== undefined && (!record(state) || !Number.isInteger(state.count) || state.count < 1 || state.count > 3
    || !Number.isSafeInteger(state.attempt) || state.attempt < 1 || state.attempt > A || typeof state.confirmed !== 'boolean'
    || !Number.isFinite(time(state.at)) || time(state.at) > Date.now())) return hold('re-run state invalid; operator must repair');
  if (state?.attempt === A) {
    const age = Date.now() - time(state.at);
    if (state.confirmed) return hold(age >= 30 * 60000 ? 'accepted, never started; operator must hand re-run or rule' : 're-run requested');
    if (age < 5 * 60000) return hold('re-run unconfirmed in flight; retry after five minutes');
  }
  if (state?.count >= 3) return hold('re-run budget exhausted; operator must hand re-run or make a ruling');
  const persist = value => {
    const pending = `${path}.pending`;
    const fd = openSync(pending, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(pending, path);
    let dirFd;
    try { dirFd = openSync(dirname(path), 'r'); fsyncSync(dirFd); }
    catch { /* Directory fsync is best effort on filesystems that do not support it. */ }
    finally { if (dirFd !== undefined) closeSync(dirFd); }
  };
  if (!liveHeadMatches(pr, repo, headSha, exec, cwd)) return hold('live head changed or unreadable');
  state = { count: (state?.count ?? 0) + 1, attempt: A, at: new Date(Date.now()).toISOString(), confirmed: false };
  persist(state); // Under the ledger lock: spend the budget BEFORE the external write, including crashes.
  if (!liveHeadMatches(pr, repo, headSha, exec, cwd)) return hold('live head changed or unreadable');
  const rerun = exec('gh', ['api', '-X', 'POST', `repos/${repo}/actions/runs/${runId[2]}/rerun`],
    { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024, env: { ...process.env, WE_GH_THROTTLE_RETRY_MAX_ATTEMPTS: '1' } });
  if (rerun?.status !== 0) return hold('re-run refused; operator must check actions: write or hand re-run');
  persist({ ...state, confirmed: true });
  return hold('re-run requested');
}

/** CLI uses argv/body-file, never a shell. Persist only AFTER the sanctioned label writer succeeds.
 * An unreadable ledger refuses send-back; the drain still skips the red PR and logs the retry reason.
 */
export function sendBackBlockedGate({ pr, headSha, requiredChecks, ledgerPath, repo, cwd, statLock = statSync, readComments = readCompletePrComments, readMain = readMainCiRuns, readFreeze = () => readSharedFreeze({ readsSource: 'api', slug: repo }), defaultBranch = 'main', exec = (command, args, options) => command === 'gh'
    ? spawnSync(process.execPath, [new URL('./gh-throttle.mjs', import.meta.url).pathname, ...args], options)
    : spawnSync(command, args, options) } = {}) {
  let temp, lockPath, lockFd, refusalPath;
  try {
    if (typeof repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo)
      || !Number.isSafeInteger(pr?.number) || pr.number <= 0) return { sent: false, reason: 'send-back repo/PR unavailable' };
    const directory = dirname(ledgerPath);
    mkdirSync(directory, { recursive: true });
    accessSync(directory, constants.R_OK | constants.W_OK | constants.X_OK);
    lockPath = `${ledgerPath}.lock`;
    // Acquisition and stale removal share a guard: a delayed reaper must never
    // remove a replacement writer's lock. A crashed guard requires operator repair.
    const guardPath = `${lockPath}.guard`;
    let guardFd;
    try { guardFd = openSync(guardPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return { sent: false, reason: 'send-back lock guard busy; kept skipped; retry next pass (operator must repair a persistent guard)' };
    }
    try {
      try { lockFd = openSync(lockPath, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Bounded calls refresh the active lock; abandoned locks expire after five minutes.
        if (Date.now() - statLock(lockPath).mtimeMs > 5 * 60_000) rmSync(lockPath);
        return { sent: false, reason: 'send-back ledger locked; kept skipped; retry next pass (repair a persistent lock)' };
      }
    } finally { closeSync(guardFd); rmSync(guardPath); }
    let ledger;
    try { ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; ledger = {}; }
    if (!record(ledger) || !Object.values(ledger).every(validLedger)) throw Error('unreadable send-back ledger');
    const runExec = exec;
    exec = (...args) => {
      const now = new Date(Date.now()); futimesSync(lockFd, now, now);
      return runExec(...args);
    };
    const key = `${repo}#${pr.number}`;
    const decision = decideGateSendBack({ pr, headSha, requiredChecks, ledger: ledger[key] || {} });
    if (!decision.send) return { sent: false };
    refusalPath = `${ledgerPath}.${headSha.toLowerCase()}.refused`;
    try {
      readFileSync(refusalPath, 'utf8');
      return { sent: false, reason: 'send-back refusal marker present; operator must repair the ledger before retrying' };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    temp = mkdtempSync(join(tmpdir(), 'drain-gate-send-back-'));
    const bodyPath = join(temp, 'findings.md');
    writeFileSync(bodyPath, decision.body, { mode: 0o600 });
    if (!liveHeadMatches(pr, repo, headSha, exec, cwd))
      return { sent: false, reason: 'live head changed or unreadable; kept skipped; retry next pass' };
    const disposition = gateDisposition({ pr, requiredChecks, repo, headSha, ledgerPath, ledgered: ledger[key]?.[headSha.toLowerCase()], readComments, readMain, readFreeze, defaultBranch, exec, cwd });
    if (disposition) return disposition;
    if (ledger[key]?.[headSha.toLowerCase()]) return { sent: false };
    // Reserve a durable refusal before the external write, including crash/ledger-failure recovery.
    const marker = openSync(refusalPath, 'wx', 0o600);
    try { writeFileSync(marker, 'send-back may have succeeded; operator must reconcile the ledger before retrying\n'); fsyncSync(marker); }
    finally { closeSync(marker); }
    if (!liveHeadMatches(pr, repo, headSha, exec, cwd)) {
      rmSync(refusalPath); // No writer ran; this reservation can be released.
      return hold('live head changed or unreadable');
    }
    const result = exec(process.execPath, [new URL('../review-set-label.mjs', import.meta.url).pathname,
      String(pr.number), `--repo=${repo}`, '--to=changes', `--body-file=${bodyPath}`],
    { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 });
    if (result?.status !== 0) {
      // A failed process may already have mutated the PR; keep the reservation.
      return { sent: false, reason: `review-set-label outcome uncertain; refusal marker retained; operator must reconcile the ledger before retrying` };
    }
    ledger[key] = { ...(ledger[key] || {}), [headSha.toLowerCase()]: true };
    const pending = `${ledgerPath}.${process.pid}.pending`;
    try {
      writeFileSync(pending, JSON.stringify(ledger) + '\n', { mode: 0o600 });
      renameSync(pending, ledgerPath);
    } catch {
      return { sent: true, recorded: false, reason: `send-back succeeded but ledger write failed; operator must repair the ledger before retrying` };
    } finally { try { rmSync(pending, { force: true }); } catch { /* Refusal marker survives cleanup failure. */ } }
    rmSync(refusalPath);
    return { sent: true, recorded: true };
  } catch {
    return { sent: false, reason: 'send-back evidence, ledger, or CLI unreadable; kept skipped; repair/retry next pass' };
  } finally {
    try { if (temp) rmSync(temp, { recursive: true, force: true }); } catch { /* Best effort cleanup. */ }
    if (lockFd !== undefined) {
      closeSync(lockFd);
      try { rmSync(lockPath, { force: true }); } catch { /* A stranded lock expires; refusal markers remain authoritative. */ }
    }
  }
}

/** Side effects live in the pass, never in classifyPr's pure BLOCKED arm. */
export function sendBackBlockedGates({ prsByRepo, verdicts, requiredChecksOf, localSlug, cwdOf, defaultBranchOf = () => 'main', readMain = readMainCiRuns, readFreeze = readSharedFreeze, ledgerPath, exec } = {}) {
  const outcomes = [], mains = new Map();
  let freeze, freezeRead = false;
  const cachedFreeze = () => {
    if (!freezeRead) { freezeRead = true; try { freeze = readFreeze({ readsSource: 'api', slug: localSlug }); } catch { freeze = { error: 'freeze unreadable' }; } }
    return freeze;
  };
  const cachedMain = options => {
    if (!mains.has(options.repo)) { try { mains.set(options.repo, readMain(options)); } catch { mains.set(options.repo, { error: 'main unreadable' }); } }
    return mains.get(options.repo);
  };
  for (const verdict of verdicts) {
    if (verdict.decision !== 'skip' || classifySkipReason(verdict.reason) !== 'checks-failed') continue;
    try {
      const pr = prsByRepo.get(verdict.repo)?.find(pr => pr.number === verdict.num);
      const outcome = sendBackBlockedGate({ pr, headSha: verdict.listedHeadSha, requiredChecks: requiredChecksOf(verdict.repo),
        repo: verdict.repo || localSlug, cwd: cwdOf(verdict.repo), defaultBranch: defaultBranchOf(verdict.repo), readMain: cachedMain, readFreeze: cachedFreeze, ledgerPath, exec });
      if (outcome.sent || outcome.reason) outcomes.push({ num: verdict.num, repo: verdict.repo, ...outcome });
    } catch { /* Best effort: the failed-check verdict still keeps this PR skipped. */ }
  }
  return outcomes;
}
