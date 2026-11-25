/** Required-check diagnostics and a strictly changes-only, head-deduplicated send-back. */
import { latestCheckNamed, isFailedCheckRow } from './rollup-collapse.mjs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';
import { classifySkipReason } from './drain-skip-reasons.mjs';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, openSync, closeSync, statSync, accessSync, constants, fsyncSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const shaPattern = /^[0-9a-f]{40}$/i;
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const clean = value => value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').trim();
const firstLine = row => [row.summary, row.output?.summary, row.title, row.output?.title, row.description]
  .filter(value => typeof value === 'string').flatMap(value => value.split(/\r?\n/).map(clean)).find(Boolean) || '';

/** Pure; unknown evidence retains the caller's original BLOCKED reason. Missing rows wait. */
export function describeBlockedChecks(pr, requiredChecks) {
  try {
    if (!record(pr) || pr.requiredCheckReadError || !Array.isArray(pr.statusCheckRollup)
      || pr.statusCheckRollup.some(row => !record(row) || typeof (row.name || row.context) !== 'string')
      || !Array.isArray(requiredChecks) || !requiredChecks.length
      || requiredChecks.some(name => typeof name !== 'string' || !name.trim())) return null;
    // Paged rows expose databaseId as checkRunId; the shared selector reads id.
    const rollup = pr.statusCheckRollup.map(row => ({ ...row,
      ...(!(Number.isSafeInteger(Number(row.id)) && Number(row.id) > 0) && Number.isInteger(row.checkRunId)
        ? { id: row.checkRunId } : {}) }));
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
      || !validLedger(ledger) || ledger[headSha.toLowerCase()]
      || !Array.isArray(pr.labels) || !pr.labels.some(label => (typeof label === 'string' ? label : label?.name) === 'ready-to-merge')) return { send: false };
    const description = describeBlockedChecks(pr, requiredChecks);
    if (!description?.failed.length) return { send: false };
    return { send: true, body: description.failed.join('; ') };
  } catch { return { send: false }; }
}

const VERDICT_PREFIXES = ['✅ review — accepted', '🔁 review — changes requested'];

/** Pure. Non-null only when merge-gate is the ONLY failed required check, its run completed BEFORE the latest trusted
 * review verdict, and both times and the run id are readable. Anything else returns null (today's send-back). */
export function staleMergeGate({ pr, requiredChecks, comments } = {}) {
  try {
    const failed = describeBlockedChecks(pr, requiredChecks)?.failed ?? [];
    if (failed.length !== 1 || !failed[0].startsWith('required check "merge-gate"') || !Array.isArray(comments)) return null;
    const gate = latestCheckNamed(pr.statusCheckRollup, 'merge-gate');
    const doneAt = Date.parse(gate?.completedAt ?? gate?.completed_at ?? '');
    const runId = /\/actions\/runs\/(\d+)/.exec(String(gate?.detailsUrl ?? gate?.details_url ?? ''))?.[1];
    let latest = null, latestAt = -Infinity;
    for (const c of comments) {
      const at = Date.parse(c?.createdAt ?? c?.created_at ?? '');
      if (isTrustedMarkerAuthor(c) && VERDICT_PREFIXES.some(p => String(c?.body ?? '').trimStart().startsWith(p))
        && Number.isFinite(at) && at >= latestAt) { latest = c; latestAt = at; }
    }
    const id = String(latest?.id ?? latest?.node_id ?? '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!latest || !id || !runId || !Number.isFinite(doneAt) || doneAt >= latestAt) return null;
    return { runId, verdictKey: id };
  } catch { return null; }
}

/** CLI uses argv/body-file, never a shell. Persist only AFTER the sanctioned label writer succeeds.
 * An unreadable ledger refuses send-back; the drain still skips the red PR and logs the retry reason.
 */
export function sendBackBlockedGate({ pr, headSha, requiredChecks, ledgerPath, repo, cwd, statLock = statSync, exec = (command, args, options) => command === 'gh'
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
        // The writer is bounded to two minutes; abandoned locks expire after five.
        if (Date.now() - statLock(lockPath).mtimeMs > 5 * 60_000) rmSync(lockPath);
        return { sent: false, reason: 'send-back ledger locked; kept skipped; retry next pass (repair a persistent lock)' };
      }
    } finally { closeSync(guardFd); rmSync(guardPath); }
    let ledger;
    try { ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; ledger = {}; }
    if (!record(ledger) || !Object.values(ledger).every(validLedger)) throw Error('unreadable send-back ledger');
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
    const live = exec('gh', ['pr', 'view', String(pr.number), `--repo=${repo}`, '--json=headRefOid,comments'],
      { cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    const liveView = live?.status === 0 ? JSON.parse(live.stdout) : null;
    if (liveView?.headRefOid !== headSha)
      return { sent: false, reason: 'live head changed or unreadable; kept skipped; retry next pass' };
    const stale = staleMergeGate({ pr, requiredChecks, comments: liveView.comments });
    if (stale) {
      // A merge-gate run that finished before the latest review verdict only reflects the lifted hold: ask for a fresh run, once.
      const rerunMarker = `${ledgerPath}.${headSha.toLowerCase()}.${stale.verdictKey}.rerun`;
      try { closeSync(openSync(rerunMarker, 'wx', 0o600)); }
      catch (error) {
        if (error.code === 'EEXIST') return { sent: false, reason: 'merge-gate run predates the latest review verdict; re-run already requested' };
        throw error;
      }
      const rerun = exec('gh', ['run', 'rerun', stale.runId, `--repo=${repo}`],
        { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
      if (rerun?.status !== 0) return { sent: false, reason: 'merge-gate run predates the latest review verdict; re-run request failed; kept skipped' };
      return { sent: false, reason: 'merge-gate run predates the latest review verdict; re-run requested' };
    }
    // Reserve a durable refusal before the external write, including crash/ledger-failure recovery.
    const marker = openSync(refusalPath, 'wx', 0o600);
    try { writeFileSync(marker, 'send-back may have succeeded; operator must reconcile the ledger before retrying\n'); fsyncSync(marker); }
    finally { closeSync(marker); }
    const result = exec(process.execPath, [new URL('../review-set-label.mjs', import.meta.url).pathname,
      String(pr.number), `--repo=${repo}`, '--to=changes', `--body-file=${bodyPath}`],
    { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 });
    if (result?.status !== 0) {
      // A failed process may already have mutated the PR; keep the reservation.
      return { sent: false, reason: 'review-set-label outcome uncertain; refusal marker retained; operator must reconcile the ledger before retrying' };
    }
    ledger[key] = { ...(ledger[key] || {}), [headSha.toLowerCase()]: true };
    const pending = `${ledgerPath}.${process.pid}.pending`;
    try {
      writeFileSync(pending, JSON.stringify(ledger) + '\n', { mode: 0o600 });
      renameSync(pending, ledgerPath);
    } catch {
      return { sent: true, recorded: false, reason: 'send-back succeeded but ledger write failed; operator must repair the ledger before retrying' };
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
export function sendBackBlockedGates({ prsByRepo, verdicts, requiredChecksOf, localSlug, cwdOf, ledgerPath, exec } = {}) {
  const outcomes = [];
  for (const verdict of verdicts) {
    if (verdict.decision !== 'skip' || classifySkipReason(verdict.reason) !== 'checks-failed') continue;
    try {
      const pr = prsByRepo.get(verdict.repo)?.find(pr => pr.number === verdict.num);
      const outcome = sendBackBlockedGate({ pr, headSha: verdict.listedHeadSha, requiredChecks: requiredChecksOf(verdict.repo),
        repo: verdict.repo || localSlug, cwd: cwdOf(verdict.repo), ledgerPath, exec });
      if (outcome.sent || outcome.reason) outcomes.push({ num: verdict.num, repo: verdict.repo, ...outcome });
    } catch { /* Best effort: the failed-check verdict still keeps this PR skipped. */ }
  }
  return outcomes;
}
