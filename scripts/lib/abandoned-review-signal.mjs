/** Bounded local proof that an abandoned review is awaiting dispatch, or its replacement has started. */
import { listRunIds, runPath, sharedRunsDir } from '../operations/run-store.mjs';
import { hasRejectingReviewVerdict, isRunAbandoned, readRunAbandonment } from './run-abandoned.mjs';
import { statSync } from 'node:fs';
import { boundedText } from './host-overload-settings.mjs';
import { resolveReviewRunReaperSettings, stuckReviewThreshold } from './review-run-reaper-settings.mjs';

const context = 'review-abandoned: replacement review never started; inspect review dispatch and start a fresh same-head review';
export function readAbandonedReviewSignal({ repo, pr, head, env = process.env, now = Date.now(), log = console.error,
  runsDir = env.OPERATION_RUNS_DIR?.trim() || sharedRunsDir(env), tool,
  list = listRunIds, read = id => JSON.parse(boundedText(runPath(id, runsDir), 4 * 1024 * 1024)),
  readTombstone = id => readRunAbandonment(id, runsDir, { fs: { statSync, readFileSync: path => boundedText(path) } }),
  abandoned = id => isRunAbandoned(id, runsDir) } = {}) {
  const signal = { awaitingFreshReview: true, why: 'review-abandoned', escalate: false };
  try {
    const settings = resolveReviewRunReaperSettings({ env, log, tool });
    const ids = list(runsDir).filter(id => id.startsWith('review-pr-') && !id.endsWith('.abandoned'));
    if (ids.length > 400) throw Error('run scan capped at 400; inspect stored evidence');
    const dead = [], started = [];
    for (const id of ids) {
      const run = read(id);
      if (!run || typeof run.op !== 'string') throw Error('unreadable run');
      if (run.op !== 'review-pr') continue;
      if (typeof run.input?.repo !== 'string' || !run.input.repo.trim() || !/^[1-9]\d*$/.test(String(run.input.pr))) throw Error('unreadable review identity');
      if (run.input.repo.toLowerCase() !== repo.toLowerCase() || Number(run.input.pr) !== Number(pr)) continue;
      const rev = run.findings?.read?.netBasis?.rev;
      if (typeof rev !== 'string' || !/^[a-f0-9]{40}$/i.test(rev)) throw Error('unreadable review head');
      if (rev.toLowerCase() !== head.toLowerCase()) continue;
      const readAt = Date.parse(run.stepTimings?.find(t => t?.step === 'read')?.startedAt);
      if (Number.isFinite(readAt) && readAt <= now) started.push(readAt);
      if (abandoned(id) && !hasRejectingReviewVerdict(run)) {
        const at = Date.parse(readTombstone(id)?.at);
        if (!Number.isFinite(at) || at > now) throw Error('unreadable abandonment time');
        dead.push({ at, threshold: stuckReviewThreshold(run, settings).ms });
      }
    }
    if (!dead.length) throw Error('abandonment evidence missing; inspect stored evidence');
    if (dead.some(d => now - d.at >= d.threshold && !started.some(at => at > d.at))) {
      return { ...signal, escalate: true, escalationContext: context };
    }
    return signal;
  } catch (error) {
    // Unknown/oversized local evidence keeps a visible hold and calls the existing operator escalation path.
    return { ...signal, escalate: true, escalationContext: `${context}; ${String(error.message).replace(/[\x00-\x1f\x7f]/g, ' ')}` };
  }
}
