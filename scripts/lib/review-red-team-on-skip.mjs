/** Recover an owed red-team result on an already-reviewed head through the existing review job. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDrainRedTeamEvidence, readRedTeamStatus } from './drain-red-team-evidence.mjs';
import { redTeamForHead } from './red-team-gate.mjs';
import { redTeamOwedFor } from './review-red-team-policy.mjs';
import { cascadePolicy } from './policy-cascade.mjs';

/** Normalize both persisted production result shapes at the recovery boundary. */
export function normalizeRedTeamResult(result) {
  return {
    priorResult: typeof result === 'string' ? result : result?.status,
    priorComment: typeof result === 'object' ? (result?.comment?.status ?? result?.comment) : undefined,
  };
}

export function resolveReviewRedTeamOnSkip({ env = process.env, log, readFile = readFileSync,
  toolPath = join(dirname(fileURLToPath(import.meta.url)), '../settings/review-red-team-on-skip.json') } = {}) {
  let tool;
  try { const data = JSON.parse(readFile(toolPath, 'utf8')); tool = { enabled: data.enabled, retryCooldownMin: data.retryCooldownMin }; } catch { /* lower layers */ }
  const raw = env.WE_REVIEW_RED_TEAM_ON_SKIP;
  const cooldown = env.WE_REVIEW_RED_TEAM_ON_SKIP_RETRY_COOLDOWN_MIN;
  return cascadePolicy('reviewRedTeamOnSkip', tool, {
    env, log, standard: { enabled: true, retryCooldownMin: 30 },
    envValues: { enabled: raw === '0' ? false : raw === '1' ? true : raw || undefined,
      retryCooldownMin: typeof cooldown === 'string' && /^\d+$/.test(cooldown) ? Number(cooldown) : cooldown || undefined },
    valid: { enabled: v => typeof v === 'boolean', retryCooldownMin: v => Number.isSafeInteger(v) && v >= 0 },
  });
}

/** PURE: readers are injected; each refusal produces one decision, including unreadable evidence. */
export function planRedTeamOnSkip({ repo, refusals = [], rawPrs, readEvidence, readStatus, now,
  setting, lastDispatch }) {
  return refusals.filter(r => r?.kind === 'already-reviewed-head').map(refusal => {
    const pr = Number(refusal.prNumber);
    const rawPr = (rawPrs ?? []).find(p => Number(p?.number) === pr);
    const head = rawPr?.headRefOid ?? null;
    const row = { prNumber: pr, head, action: 'skip' };
    const skip = why => ({ ...row, why });
    try {
      if (!setting.enabled) return skip('reviewRedTeamOnSkip.enabled=false');
      if (!/^[a-f0-9]{40}$/i.test(head ?? '') || (refusal.headSha != null && refusal.headSha !== head)) return skip('live head missing or changed');
      // Unknown comments cannot establish that no result was published.
      if (!Array.isArray(rawPr.comments)) return skip('PR comments unreadable');
      if (redTeamForHead(rawPr.comments, pr, head)) return skip('red-team result already on head');
      const evidence = readEvidence({ repo, pr, head });
      if (!redTeamOwedFor(evidence?.loopPayload)) return skip('stored review does not owe a red team');
      if (evidence.loopPayload?.findings?.read?.netBasis?.rev !== head) return skip('stored review does not match live head');
      if (evidence.inFlight || evidence.queued) return skip('red-team pass in flight');
      const status = readStatus({ repo, pr, head });
      const { priorResult: prior, priorComment: comment } = normalizeRedTeamResult(status?.result);
      let mode;
      if (comment === 'posted') return skip('result posted; comment not visible yet');
      // Any seat row (including an error) counts as recorded. Only a finished, clean
      // pass can resume effects without risking another model call.
      if (status?.status === 'finished' && ['ran', 'resumed'].includes(prior) && evidence.recorded === true) {
        mode = 'resume';
      } else if (status == null && evidence.recorded === false) mode = 'fresh';
      else return skip(`prior result ${typeof prior === 'string' ? prior : 'unknown'} (status ${status?.status ?? 'missing'}); not re-run`);
      const last = lastDispatch.get(`${repo}#${pr}@${head}`);
      if (last != null && now - last < setting.retryCooldownMin * 60_000) return skip('retry cooldown active');
      return { ...row, action: 'dispatch', mode, why: mode === 'resume' ? 'recorded pass needs its result comment/effects' : 'head never had a red-team pass' };
    } catch { return skip('red-team evidence unreadable; inspect stored evidence before retrying'); }
  });
}

const lastDispatch = new Map();
const safeLine = value => String(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').slice(0, 600);

/** Bounded recovery, sharing review capacity. Errors never abort the daemon tick. */
export function runRedTeamOnSkip({ repo, plan, rawPrs, capacity, dispatch, log = () => {}, dryRun = false,
  env = process.env, setting, readEvidence = readDrainRedTeamEvidence, readStatus = readRedTeamStatus,
  now = Date.now, lastDispatch: history = lastDispatch, preferLane } = {}) {
  const rows = [], dispatched = [], notStarted = [];
  const note = line => { try { log(safeLine(line)); } catch { /* diagnostic only */ } };
  try {
    const at = now();
    const resolved = setting ?? resolveReviewRedTeamOnSkip({ env, log: note }).value;
    rows.push(...planRedTeamOnSkip({ repo, refusals: plan?.refusals, rawPrs, readEvidence, readStatus,
      now: at, setting: resolved, lastDispatch: history }));
    for (const row of rows) {
      let started = false;
      if (row.action === 'dispatch') {
        const budget = capacity?.budget;
        if (!(capacity?.lanes > 0) || (budget && !(budget.left > 0))) row.why = 'no review capacity left';
        else if (dryRun) row.why = `dry run (${row.mode})`;
        else {
          const reserved = budget && Number.isFinite(budget.left);
          if (reserved) budget.left--;
          try {
            const result = dispatch({ pr: row.prNumber, repo, redTeamOnly: true, redTeamMode: row.mode,
              ...(preferLane != null ? { preferLane } : {}) });
            if (result?.skipped || !Number.isInteger(result?.jobPid)) {
              const refundable = result?.skipped !== 'live-job'
                || (budget?.countedJobPids instanceof Set && budget.countedJobPids.has(result.jobPid));
              if (reserved && refundable) budget.left++;
              row.why = result?.skipped ?? 'job did not start';
            } else {
              capacity.lanes--;
              history.set(`${repo}#${row.prNumber}@${row.head}`, at);
              dispatched.push({ prNumber: row.prNumber, jobPid: result.jobPid, mode: row.mode });
              started = true;
            }
          } catch {
            // A throw may follow a spawn: retain its reservation until the next live process read.
            capacity.lanes--;
            row.why = 'dispatch failed; start unknown';
          }
        }
        if (!started) { row.action = 'skip'; notStarted.push({ prNumber: row.prNumber, reason: row.why }); }
      }
      note(`review-daemon: ${repo}#${row.prNumber} already-reviewed-head — red team ${started ? `dispatched (${row.mode})` : 'not dispatched'} for head ${String(row.head ?? 'unknown').slice(0, 12)}: ${row.why}`);
    }
  } catch {
    rows.push({ prNumber: null, head: null, action: 'skip', why: 'red-team recovery inputs unreadable' });
    note(`review-daemon: ${repo}#? already-reviewed-head — red team not dispatched for head unknown: red-team recovery inputs unreadable`);
  }
  return { rows, dispatched, notStarted };
}
