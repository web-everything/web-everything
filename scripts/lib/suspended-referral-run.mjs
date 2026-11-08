/** Read-only discovery of mandatory-referral effects awaiting an operator ruling. */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { listRunIds, readRun, resolveRunsDir } from '../operations/run-store.mjs';
import { referralFindingKey } from './jury-core.mjs';
import { cascadePolicy, platformPreference } from './policy-cascade.mjs';

export function resolveReferralJudgeWindow({ env = process.env, log, readFile = readFileSync } = {}) {
  let tool;
  try { tool = JSON.parse(readFile(new URL('../settings/referral-judge-window.json', import.meta.url), 'utf8')); } catch { /* lower layers */ }
  const raw = env.WE_REFERRAL_JUDGE_WINDOW_MIN;
  return cascadePolicy('referralJudgeWindow', tool, {
    env, log, platform: platformPreference('referralJudgeWindow', { env, readFile }), standard: { referralWindowMinutes: 60 },
    envValues: { referralWindowMinutes: typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw },
    valid: v => Number.isSafeInteger(v) && v >= 1,
  });
}

export function findSuspendedReferralRuns({ repo, pr, head, now, runsDir = resolveRunsDir(),
  list = dir => { statSync(dir); return listRunIds(dir); }, read = readRun, stat = statSync }) {
  const ids = list(runsDir).filter(id => id.startsWith('review-pr-'));
  if (ids.length > 10000) throw Error('suspended referral scan capped; inspect run store');
  if (!Number.isFinite(now)) throw Error('suspended referral clock unreadable; inspect run store');
  return ids.flatMap(id => {
    const run = read(id, runsDir);
    if (!run || typeof run.op !== 'string') throw Error('run identity unreadable; inspect run store');
    if (run.op !== 'review-pr') return [];
    if (!run.input?.repo || !Number.isSafeInteger(Number(run.input.pr))) throw Error('run subject unreadable; inspect run store');
    if (run.input.repo !== repo || Number(run.input.pr) !== Number(pr)
      || (run.findings?.read?.netBasis?.rev ?? run.input.head) !== head
      || run.pending?.kind !== 'effect' || run.pending.step !== 'mandatoryReferrals') return [];
    const started = Date.parse(run.stepTimings?.find(t => t.step === 'mandatoryReferrals')?.startedAt);
    const since = Number.isFinite(started) ? started : stat(join(runsDir, `${id}.json`)).mtimeMs;
    if (!Number.isFinite(since)) throw Error('run age unreadable; inspect run store');
    if (!Array.isArray(run.effects)) throw Error('run effects unreadable; inspect run store');
    const findings = run.effects.flatMap(e => (e.payload?.referrals ?? []).map(ref => {
      const f = ref.original ?? ref.finding;
      if (!f || typeof f.summary !== 'string') throw Error('referral finding unreadable; inspect run store');
      return { key: ref.key ?? referralFindingKey(ref.seat, f), seat: ref.seat,
        file: f.file ?? f.path, line: f.line, summary: f.summary };
    }));
    return [{ id, ageMs: now - since, pendingSince: new Date(since).toISOString(), findings }];
  });
}
