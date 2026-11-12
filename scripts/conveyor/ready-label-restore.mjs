/** Restore the drain's collection label after a send-back has been re-accepted. */
import { REVIEW_LABELS } from '../lib/review-labels.mjs';
import { isRequiredCheckGreen } from '../merge-ai-prs.mjs';
import { requiredCheckReadNeeded } from '../lib/rollup-collapse.mjs';
import { createGhProvider } from '../lib/review-label-provider.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { defaultReadLabelEvents } from './human-surface-repark.mjs';
import { execRead } from '../lib/proc-read.mjs';
import { createMqLiveReader } from '../lib/drain-queue-safety.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';

const READY = 'ready-to-merge';
const holds = new Set([
  REVIEW_LABELS.pending, REVIEW_LABELS.human, REVIEW_LABELS.changes, REVIEW_LABELS.heldMechanical,
].filter(Boolean));
const names = pr => (Array.isArray(pr?.labels) ? pr.labels : [])
  .map(label => typeof label === 'string' ? label : label?.name);
const candidate = pr => {
  const labels = names(pr);
  return labels.includes(REVIEW_LABELS.accepted) && labels.includes('red-team:clear') && !labels.includes(READY);
};

/** Pure: unknown or incomplete admission evidence leaves the label absent. */
export function planReadyRestore(pr, { requiredCheck = 'test' } = {}) {
  const refuse = reason => ({ restore: false, reason });
  if (!pr || pr.state !== 'OPEN') return refuse('PR is not open');
  if (pr.isDraft !== false) return refuse('PR is draft or draft state is unknown');
  if (!Array.isArray(pr.labels) || names(pr).some(label => typeof label !== 'string' || !label)) return refuse('labels are unreadable');
  if (!pr.headRefOid || typeof pr.headRefOid !== 'string') return refuse('head is unreadable');
  const labels = names(pr);
  if (labels.includes(READY)) return refuse('already ready-to-merge');
  if (!candidate(pr)) return refuse('acceptance and red-team clearance are required');
  const hold = labels.find(label => holds.has(label)
    || (label.startsWith('review:') && label !== REVIEW_LABELS.accepted)
    || label === 'red-team:pending' || label === 'red-team:blocked');
  if (hold) return refuse(`held by ${hold}`);
  // A capped (>=100) or errored rollup may hide the newest run: not proof of green, retry next sweep.
  if (requiredCheckReadNeeded(pr, requiredCheck)) return refuse(`required check ${requiredCheck} evidence is incomplete`);
  if (!isRequiredCheckGreen(pr, requiredCheck)) return refuse(`required check ${requiredCheck} is not green`);
  return { restore: true };
}

function defaultReadPr(repo, number, provider) {
  const pr = provider.readPrState(repo, number);
  const out = createMqLiveReader(execFileSyncThrottled)('gh', ['pr', 'view', String(number), '--repo', repo,
    '--json', 'headRefOid,statusCheckRollup'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
  });
  const checks = JSON.parse(String(out));
  if (!pr?.headRefOid || checks.headRefOid !== pr.headRefOid) throw new Error('head moved during check read; retry next sweep');
  return { ...pr, statusCheckRollup: checks.statusCheckRollup };
}

/** Pure: oldest-first label events. A `ready-to-merge` removal with no strictly later `review:accepted` add means the
 *  strip was deliberate (or the acceptance predates it): do not restore. No removal at all: the plain rule applies. */
export function reacceptedAfterReadyRemoval(events) {
  if (!Array.isArray(events)) return { ok: false, reason: 'label events unreadable' };
  const at = (e) => Date.parse(e?.createdAt);
  if (events.some(e => !e || !Number.isFinite(at(e)) || typeof e.label !== 'string')) return { ok: false, reason: 'label events incomplete' };
  const removals = events.filter(e => e.event === 'unlabeled' && e.label === READY).map(at);
  if (!removals.length) return { ok: true };
  const removedAt = Math.max(...removals);
  const accepted = events.filter(e => e.event === 'labeled' && e.label === REVIEW_LABELS.accepted).map(at);
  const acceptedAt = accepted.length ? Math.max(...accepted) : -Infinity;
  return acceptedAt > removedAt ? { ok: true }
    : { ok: false, reason: 'ready-to-merge was removed and re-acceptance is not provably later' };
}

const defaultReadEvents = (repo, number) => defaultReadLabelEvents(number, { repo, exec: createMqLiveReader(execRead) });

const clean = value => String(value).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');

/** One live plan per listed candidate, then a fresh head/hold guard at the write boundary.
 * Read/write errors retain the absent label; the next daemon sweep retries the PR.
 */
export function sweepReadyRestore({ repo, prs = [], readPr, readEvents = defaultReadEvents, provider = createGhProvider(), dryRun = false, log = () => {} } = {}) {
  const results = [];
  for (const pr of prs) {
    if (!candidate(pr)) continue;
    let row;
    let reaccept;
    try {
      const live = readPr ? readPr(repo, pr.number) : defaultReadPr(repo, pr.number, provider);
      const plan = planReadyRestore(live);
      if (!plan.restore) {
        row = { num: pr.number, readyRestore: 'skip', detail: plan.reason };
      } else if (!(reaccept = reacceptedAfterReadyRemoval(readEvents(repo, pr.number))).ok) {
        row = { num: pr.number, readyRestore: 'skip', detail: reaccept.reason };
      } else if (dryRun) {
        row = { num: pr.number, readyRestore: 'would-restore', detail: 'accepted, red-team clear, required check green' };
      } else {
        // Fresh live read (labels, state, draft AND the check rollup) at the write boundary: same-head reruns can change CI.
        const current = readPr ? readPr(repo, pr.number) : defaultReadPr(repo, pr.number, provider);
        if (!current?.headRefOid || current.headRefOid !== live.headRefOid) {
          row = { num: pr.number, readyRestore: 'skip', detail: 'head moved or unreadable; retry next sweep' };
        } else {
          const finalPlan = planReadyRestore(current);
          if (!finalPlan.restore) row = { num: pr.number, readyRestore: 'skip', detail: finalPlan.reason };
          else {
            provider.setLabels(repo, pr.number, { add: READY });
            row = { num: pr.number, readyRestore: 'restored', detail: 'accepted, red-team clear, required check green; head unchanged' };
          }
        }
      }
    } catch (error) {
      row = { num: pr.number, readyRestore: 'skip', detail: `${clean(error?.message ?? error)}; retry next sweep` };
    }
    results.push(row);
    log(`  PR #${pr.number}: ready restore ${row.readyRestore} — ${clean(row.detail)}`);
  }
  return results;
}
