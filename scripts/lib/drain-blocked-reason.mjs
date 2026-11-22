/** Required-check diagnostics and a strictly changes-only, head-deduplicated send-back. */
import { latestCheckNamed, isFailedCheckRow } from './rollup-collapse.mjs';
import { classifySkipReason } from './drain-skip-reasons.mjs';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const shaPattern = /^[0-9a-f]{40}$/i;
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const clean = value => value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').trim();
const firstLine = row => [row.summary, row.title, row.description]
  .filter(value => typeof value === 'string').flatMap(value => value.split(/\r?\n/).map(clean)).find(Boolean) || '';

/** Pure; unknown evidence retains the caller's original BLOCKED reason. Missing rows wait. */
export function describeBlockedChecks(pr, requiredChecks) {
  try {
    if (!record(pr) || pr.requiredCheckReadError || !Array.isArray(pr.statusCheckRollup)
      || pr.statusCheckRollup.some(row => !record(row) || typeof (row.name || row.context) !== 'string')
      || !Array.isArray(requiredChecks) || !requiredChecks.length
      || requiredChecks.some(name => typeof name !== 'string' || !name.trim())) return null;
    const failed = [], waiting = [];
    for (const name of new Set(requiredChecks)) {
      // Keep the shared run-ID/rollup ordering: queued replacements have no timestamps yet.
      const row = latestCheckNamed(pr.statusCheckRollup, name);
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
      || !validLedger(ledger) || ledger[headSha.toLowerCase()]
      || !Array.isArray(pr.labels) || !pr.labels.some(label => (typeof label === 'string' ? label : label?.name) === 'ready-to-merge')) return { send: false };
    const description = describeBlockedChecks(pr, requiredChecks);
    if (!description?.failed.length) return { send: false };
    return { send: true, body: description.failed.join('; ') };
  } catch { return { send: false }; }
}

/** CLI uses argv/body-file, never a shell. Persist only AFTER the sanctioned label writer succeeds.
 * An unreadable ledger refuses send-back; the drain still skips the red PR and logs the retry reason.
 */
export function sendBackBlockedGate({ pr, headSha, requiredChecks, ledgerPath, repo, cwd, exec = spawnSync } = {}) {
  let temp;
  try {
    if (typeof repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo)
      || !Number.isSafeInteger(pr?.number) || pr.number <= 0) return { sent: false, reason: 'send-back repo/PR unavailable' };
    let ledger;
    try { ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; ledger = {}; }
    if (!record(ledger) || !Object.values(ledger).every(validLedger)) throw Error('unreadable send-back ledger');
    const key = `${repo}#${pr.number}`;
    const decision = decideGateSendBack({ pr, headSha, requiredChecks, ledger: ledger[key] || {} });
    if (!decision.send) return { sent: false };
    mkdirSync(dirname(ledgerPath), { recursive: true });
    temp = mkdtempSync(join(tmpdir(), 'drain-gate-send-back-'));
    const bodyPath = join(temp, 'findings.md');
    writeFileSync(bodyPath, decision.body, { mode: 0o600 });
    const result = exec(process.execPath, [new URL('../review-set-label.mjs', import.meta.url).pathname,
      String(pr.number), `--repo=${repo}`, '--to=changes', `--body-file=${bodyPath}`],
    { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 });
    if (result?.status !== 0) return { sent: false, reason: 'review-set-label failed; head not recorded; retry next pass' };
    ledger[key] = { ...(ledger[key] || {}), [headSha.toLowerCase()]: true };
    const pending = `${ledgerPath}.${process.pid}.pending`;
    try {
      writeFileSync(pending, JSON.stringify(ledger) + '\n', { mode: 0o600 });
      renameSync(pending, ledgerPath);
    } catch {
      return { sent: true, recorded: false, reason: 'send-back succeeded but ledger write failed; operator must repair the ledger before retrying' };
    } finally { rmSync(pending, { force: true }); }
    return { sent: true, recorded: true };
  } catch {
    return { sent: false, reason: 'send-back evidence, ledger, or CLI unreadable; kept skipped; repair/retry next pass' };
  } finally { if (temp) rmSync(temp, { recursive: true, force: true }); }
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
