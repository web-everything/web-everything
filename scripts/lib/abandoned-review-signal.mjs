/** Bounded local proof that an abandoned review is awaiting dispatch or a progressing replacement. */
import { listRunIds, runPath, sharedRunsDir } from '../operations/run-store.mjs';
import { hasRejectingReviewVerdict, isRunAbandoned, readRunAbandonment } from './run-abandoned.mjs';
import { statSync } from 'node:fs';
import { boundedText } from './host-overload-settings.mjs';
import { resolveReviewRunReaperSettings, stuckReviewThreshold } from './review-run-reaper-settings.mjs';

const stalledContext = 'review-abandoned: replacement review is unfinished and quiet past its stuck deadline; inspect the unfinished review';
const unfinished = run => !run.verdict || run.pending != null || run.outcome === 'refused'
  || run.effects?.some(effect => ['declared', 'pending', 'in-flight', 'refused'].includes(effect?.status));
const context = 'review-abandoned: replacement review never started; inspect review dispatch and start a fresh same-head review';
export function readAbandonedReviewSignal({ repo, pr, head, env = process.env, now = Date.now(), log = console.error,
  runsDir = env.OPERATION_RUNS_DIR?.trim() || sharedRunsDir(env), tool,
  list = listRunIds, read = id => JSON.parse(boundedText(runPath(id, runsDir), 4 * 1024 * 1024)),
  readTombstone = id => readRunAbandonment(id, runsDir, { fs: { statSync, readFileSync: path => boundedText(path) } }),
  abandoned = id => isRunAbandoned(id, runsDir), stat = statSync } = {}) {
  const signal = { awaitingFreshReview: true, why: 'review-abandoned', escalate: false };
  try {
    const settings = resolveReviewRunReaperSettings({ env, log, tool });
    const ids = list(runsDir).filter(id => id.startsWith('review-pr-') && !id.endsWith('.abandoned'));
    if (ids.length > 400) throw Error('run scan capped at 400; inspect stored evidence');
    const dead = [];
    let latest = null;
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
      const isAbandoned = abandoned(id) && !hasRejectingReviewVerdict(run);
      if (Number.isFinite(readAt) && readAt <= now && (!latest || readAt > latest.readAt)) {
        latest = { id, readAt, isAbandoned, unfinished: unfinished(run), threshold: stuckReviewThreshold(run, settings).ms };
      }
      if (isAbandoned) {
        const at = Date.parse(readTombstone(id)?.at);
        if (!Number.isFinite(at) || at > now) throw Error('unreadable abandonment time');
        dead.push({ at, threshold: stuckReviewThreshold(run, settings).ms });
      }
    }
    if (!dead.length) throw Error('abandonment evidence missing; inspect stored evidence');
    for (const d of dead) {
      const replacement = latest?.readAt > d.at ? latest : null;
      if (!replacement) {
        if (now - d.at >= d.threshold) return { ...signal, escalate: true, escalationContext: context };
        continue;
      }
      // A later tombstone owns its own replacement deadline. A finished replacement discharges
      // the old abandonment, but a mere read start cannot hide a stalled unfinished review forever.
      if (replacement.isAbandoned || !replacement.unfinished) continue;
      const activeAt = stat(runPath(replacement.id, runsDir)).mtimeMs;
      if (!Number.isFinite(activeAt) || activeAt > now) throw Error('unreadable replacement activity time');
      if (now - Math.max(replacement.readAt, activeAt) >= replacement.threshold) {
        return { ...signal, escalate: true, escalationContext: stalledContext };
      }
    }
    return signal;
  } catch (error) {
    // Unknown/oversized local evidence keeps a visible hold and calls the existing operator escalation path.
    return { ...signal, escalate: true, escalationContext: `${context}; ${String(error.message).replace(/[\x00-\x1f\x7f]/g, ' ')}` };
  }
}
