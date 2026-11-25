/** Required-check diagnostics and a strictly changes-only, head-deduplicated send-back. */
import { latestCheckNamed, isFailedCheckRow } from './rollup-collapse.mjs';
import { classifySkipReason } from './drain-skip-reasons.mjs';
import { excuseMergeGateRows, readMergeGateVerdict, loadMergeGateHoldSetting } from './merge-gate-hold-class.mjs';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, openSync, closeSync, statSync, accessSync, constants, fsyncSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const shaPattern = /^[0-9a-f]{40}$/i;
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const clean = value => value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').trim();
const firstLine = row => [row.summary, row.output?.summary, row.title, row.output?.title, row.description]
  .filter(value => typeof value === 'string').flatMap(value => value.split(/\r?\n/).map(clean)).find(Boolean) || '';

// The local validation stamp: only markReviewOwnedGate sets it, for the exact head it validated.
const STAMP = 'sendBackValidatedHead';
const trustedReviewOwned = (row, name, headSha) => name === 'merge-gate' && typeof headSha === 'string'
  && Array.isArray(row.mergeGateReviewHold?.holds) && row.mergeGateReviewHold.holds.length > 0
  && row.mergeGateReviewHold[STAMP] === headSha.toLowerCase()
  && !row.mergeGateReviewHold.holds.some(id => id === 'test-gaming');

/**
 * D1 local proof (fail closed: any doubt returns pr unchanged, so the send-back works as today).
 * Only the check named exactly merge-gate; head-bound verdict at decision time; hold setting on;
 * hold table is review-only (excuseMergeGateRows `reviewHold`, never its SUCCESS rewrite); no test-gaming
 * hold (a code finding, excluded here without touching the shared classifier); and the job's only failed
 * step is the gate evaluator, so no other job failure hides behind the table.
 */
export function markReviewOwnedGate(pr, { headSha, repo, readVerdict, readFreeze, setting } = {}) {
  try {
    if (typeof headSha !== 'string' || !shaPattern.test(headSha) || headSha !== pr?.headRefOid
      || (typeof setting === 'string' ? setting : setting?.value) !== 'on' || !Array.isArray(pr.statusCheckRollup)) return pr;
    let verdict;
    const out = excuseMergeGateRows(pr.statusCheckRollup, { prNumber: pr.number, headSha, labels: pr.labels, setting,
      readVerdict: args => (verdict = readVerdict({ ...args, repo })), freeze: readFreeze });
    if (out.excused || !out.reviewHold || !verdict) return pr;
    const target = out.rows.find(r => r.mergeGateReviewHold);
    const holds = target?.mergeGateReviewHold?.holds;
    if (!target || (target.name ?? target.context) !== 'merge-gate' || !Array.isArray(holds)
      || verdict.head_sha?.toLowerCase() !== headSha.toLowerCase()
      || verdict.results?.some(r => r.id === 'test-gaming' && (r.status === 'hold' || r.status === 'fail-closed'))
      || holds.includes('test-gaming')) return pr;
    const failed = verdict.failedSteps;
    if (!Array.isArray(failed) || failed.some(s => s !== "Evaluate the drain's merge gates")) return pr;
    const stamped = { ...target, mergeGateReviewHold: { ...target.mergeGateReviewHold, [STAMP]: headSha.toLowerCase() } };
    return { ...pr, statusCheckRollup: out.rows.map(r => r === target ? stamped : r) };
  } catch { return pr; }
}

/** Pure; unknown evidence retains the caller's original BLOCKED reason. Missing rows wait. */
export function describeBlockedChecks(pr, requiredChecks, headSha) {
  try {
    if (!record(pr) || pr.requiredCheckReadError || !Array.isArray(pr.statusCheckRollup)
      || pr.statusCheckRollup.some(row => !record(row) || typeof (row.name || row.context) !== 'string')
      || !Array.isArray(requiredChecks) || !requiredChecks.length
      || requiredChecks.some(name => typeof name !== 'string' || !name.trim())) return null;
    // Paged rows expose databaseId as checkRunId; the shared selector reads id.
    const rollup = pr.statusCheckRollup.map(row => ({ ...row,
      ...(!(Number.isSafeInteger(Number(row.id)) && Number(row.id) > 0) && Number.isInteger(row.checkRunId)
        ? { id: row.checkRunId } : {}) }));
    const failed = [], waiting = [], reviewOwned = [];
    for (const name of new Set(requiredChecks)) {
      // Keep the shared run-ID/rollup ordering: queued replacements have no timestamps yet.
      const row = latestCheckNamed(rollup, name);
      const label = JSON.stringify(clean(name));
      if (!row) { waiting.push(`waiting on required check ${label} (absent)`); continue; }
      const conclusion = String(row.conclusion || row.state || '').toUpperCase();
      const status = String(row.status || row.state || '').toUpperCase();
      if (isFailedCheckRow(row) && trustedReviewOwned(row, name, headSha)) {
        // Review-owned merge-gate red (proved locally from the head-bound job log): review work, not a code finding.
        reviewOwned.push(...row.mergeGateReviewHold.holds.map(String));
      } else if (isFailedCheckRow(row)) {
        const detail = firstLine(row);
        failed.push(`required check ${label} ${conclusion}${detail ? `: ${detail}` : ''}`);
      } else if (['IN_PROGRESS', 'QUEUED', 'PENDING'].includes(status)) {
        waiting.push(`waiting on required check ${label} (${status})`);
      } else if (!['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion)) return null;
    }
    return { failed, waiting, ...(reviewOwned.length ? { reviewOwned } : {}), text: [...failed, ...waiting].join('; ') };
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
    const description = describeBlockedChecks(pr, requiredChecks, headSha);
    if (!description?.failed.length) {
      return description?.reviewOwned?.length
        ? { send: false, reason: `merge-gate red is review-owned (${[...new Set(description.reviewOwned)].join(', ')}); no code finding to send back` }
        : { send: false };
    }
    return { send: true, body: description.failed.join('; ') };
  } catch { return { send: false }; }
}

/** CLI uses argv/body-file, never a shell. Persist only AFTER the sanctioned label writer succeeds.
 * An unreadable ledger refuses send-back; the drain still skips the red PR and logs the retry reason.
 */
export function sendBackBlockedGate({ pr, headSha, requiredChecks, ledgerPath, repo, cwd, statLock = statSync,
  readVerdict = readMergeGateVerdict, readFreeze = () => ({ error: 'freeze not read' }), mergeGateSetting = loadMergeGateHoldSetting(), exec = (command, args, options) => command === 'gh'
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
    // D1: a review-owned merge-gate red (proved from the head-bound job log) is review work, never a code finding.
    // Any unreadable/mismatched/off evidence leaves the rows unchanged, so the send-back behaves as before.
    const gatePr = markReviewOwnedGate(pr, { headSha, repo, readVerdict, readFreeze, setting: mergeGateSetting });
    const decision = decideGateSendBack({ pr: gatePr, headSha, requiredChecks, ledger: ledger[key] || {} });
    if (!decision.send) return decision.reason ? { sent: false, reason: decision.reason } : { sent: false };
    refusalPath = `${ledgerPath}.${headSha.toLowerCase()}.refused`;
    try {
      readFileSync(refusalPath, 'utf8');
      return { sent: false, reason: 'send-back refusal marker present; operator must repair the ledger before retrying' };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    temp = mkdtempSync(join(tmpdir(), 'drain-gate-send-back-'));
    const bodyPath = join(temp, 'findings.md');
    writeFileSync(bodyPath, decision.body, { mode: 0o600 });
    const live = exec('gh', ['pr', 'view', String(pr.number), `--repo=${repo}`, '--json=headRefOid'],
      { cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    if (live?.status !== 0 || JSON.parse(live.stdout).headRefOid !== headSha)
      return { sent: false, reason: 'live head changed or unreadable; kept skipped; retry next pass' };
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
