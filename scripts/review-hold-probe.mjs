#!/usr/bin/env node
/**
 * @file scripts/review-hold-probe.mjs
 * @description READ-ONLY probe (review-hold-model S1): prints `deriveReviewHold` next to today's
 *   `readReviewCiGate` verdict for one PR. Writes nothing: only `gh` GET reads, no labels, no comments, no reruns.
 *   Usage: node scripts/review-hold-probe.mjs --repo=owner/name --pr=123
 */
import { readGh } from './lib/proc-read.mjs';
import { readReviewCiGate } from './lib/review-ci-gate-io.mjs';
import { readSharedFreeze } from './lib/red-main-freeze-shared.mjs';
import { deriveReviewHold } from './lib/review-hold-model.mjs';

const OPTS = { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
const gh = (args) => readGh(args, OPTS);
const ghJson = (args) => JSON.parse(gh(args));
const ids = (run) => {
  const m = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(run?.details_url ?? '');
  return m ? { runId: Number(m[1]), jobId: Number(m[2]) } : { runId: null, jobId: null };
};

function gateState(run) {
  if (!run) return 'absent';
  if (run.status !== 'completed') return 'pending';
  return run.conclusion === 'success' ? 'success' : run.conclusion === 'failure' ? 'failure' : run.conclusion ?? 'unreadable';
}

/** Latest run by id for one check name on the head (GitHub ids order creations). */
const latest = (runs, name) => runs.filter((r) => r.name === name).sort((a, b) => b.id - a.id)[0] ?? null;

export function probe({ repo, pr, read = { gh, ghJson, freeze: readSharedFreeze } } = {}) {
  const view = read.ghJson(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid,labels']);
  const headSha = view.headRefOid;
  const pages = read.ghJson(['api', '--paginate', '--slurp', `repos/${repo}/commits/${headSha}/check-runs?per_page=100&filter=all`]);
  const runs = pages.flatMap((p) => {
    if (!Array.isArray(p?.check_runs)) throw new Error('unreadable check runs');
    return p.check_runs;
  });
  const mgRun = latest(runs, 'merge-gate');
  const rgRun = latest(runs, 'review-gate');
  const jobOf = (run) => (run ? read.ghJson(['api', `repos/${repo}/actions/jobs/${run.id}`]) : null);
  const logOf = (run) => (run ? String(read.gh(['api', `repos/${repo}/actions/jobs/${run.id}/logs`])) : '');
  const mergeGate = mgRun ? { state: mgRun.status === 'completed' ? 'completed' : 'pending', conclusion: mgRun.conclusion,
    ...ids(mgRun), jobHeadSha: mgRun.head_sha, latest: true, completedAt: mgRun.completed_at,
    logText: gateState(mgRun) === 'failure' ? logOf(mgRun) : '' } : null;
  let reviewGate = null;
  if (rgRun) {
    const failed = gateState(rgRun) === 'failure';
    const job = failed ? jobOf(rgRun) : null;
    reviewGate = { state: gateState(rgRun), ...ids(rgRun), jobHeadSha: rgRun.head_sha,
      steps: (job?.steps ?? []).map(({ name, status, conclusion }) => ({ name, status, conclusion })),
      logText: failed ? logOf(rgRun) : '' };
  }
  let freeze;
  try { freeze = read.freeze(); } catch (error) { freeze = { error: String(error?.message ?? error) }; }
  const derived = deriveReviewHold({ headSha, prNumber: Number(pr), labels: view.labels, mergeGate, reviewGate, freeze });
  let old;
  try {
    const ci = readReviewCiGate({ repo, pr });
    old = { allowed: ci.allowed, reason: ci.reason, affected: (ci.affected ?? []).map((r) => ({ name: r.name, reason: r.reason })) };
  } catch (error) { old = { error: String(error?.message ?? error) }; }
  return { repo, pr: Number(pr), headSha, labels: view.labels.map((l) => l.name ?? l),
    new: { publishable: derived.publishable, candidacy: derived.candidacy, reason: derived.reason,
      holds: derived.holds, key: derived.key, reviewGate: reviewGate?.state ?? 'absent' },
    old };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
  if (!flags.repo || !flags.pr) { process.stderr.write('usage: review-hold-probe --repo=owner/name --pr=N\n'); process.exit(3); }
  process.stdout.write(`${JSON.stringify(probe({ repo: flags.repo, pr: flags.pr }), null, 2)}\n`);
}
