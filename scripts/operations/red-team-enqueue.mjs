/** Registered, audited request for the review daemon's capacity-bound red-team queue. */
import { runReconcilePass } from '../conveyor/reconcile-pass.mjs';
import { planRedTeamNomination, readCompletePrReviews } from '../lib/review-red-team-on-skip.mjs';
import { op } from './registry.mjs';
import { compute, effect } from './step-kinds.mjs';
import { validateRedTeamRequest, redTeamRequestBody, redTeamRequestForHead } from '../lib/red-team-request.mjs';
import { redTeamForHead } from '../lib/red-team-gate.mjs';
import { isRealHead } from '../lib/red-team-skip-outcome.mjs';
import { runGhSync } from '../lib/gh-throttle.mjs';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';

export const RED_TEAM_ENQUEUE_OP = 'red-team-enqueue';
export const RED_TEAM_ENQUEUE_EFFECT = 'red-team.request';

function liveRedTeamRequest(input, live) {
  const request = validateRedTeamRequest(input);
  if (live?.state !== 'OPEN' || live.isDraft !== false) throw Error('red-team-enqueue: PR must be open and ready for review');
  if (!isRealHead(live.headRefOid) || !Array.isArray(live.comments)
    || live.comments.some(comment => typeof comment?.body !== 'string')) {
    throw Error('red-team-enqueue: live head/comments unreadable; inspect the PR and retry');
  }
  if (redTeamForHead(live.comments, request.pr, live.headRefOid)) throw Error('red-team-enqueue: head already has a red-team result');
  return { ...request, head: live.headRefOid };
}

export function planRedTeamEnqueue(input, live, planning) {
  const request = liveRedTeamRequest(input, live);
  const decision = planRedTeamNomination({ ...planning, repo: request.repo, pr: request.pr,
    rawPrs: [{ ...live, number: request.pr }] });
  if (!['dispatch', 'review'].includes(decision.action)) throw Error(`red-team-enqueue: ${decision.why}`);
  return { ...request, head: live.headRefOid };
}

export function redTeamEnqueueOperation() {
  return op(RED_TEAM_ENQUEUE_OP, {
    input: { pr: 'number', repo: { type: 'string', required: false, default: 'web-everything/web-everything' }, reason: 'string' },
    verdictFrom: 'plan',
    plan: compute({ reads: ['input.pr', 'input.repo', 'input.reason'], fn: ({ input }) => validateRedTeamRequest(input) }),
    request: effect({ reads: ['verdict'], effects: ({ verdict }) => [{
      type: RED_TEAM_ENQUEUE_EFFECT, payload: verdict, idempotent: true,
    }] }),
  });
}

/** A durable PR comment avoids a second local queue writer racing the daemon's in-memory queue.
 * The complete thread and state are read at the effect, including on resumed registered operations.
 */
export function createRedTeamEnqueueSinks({ env = process.env,
  gh = args => runGhSync(args, { env, throttle: { env: { ...env, WE_GH_READ_MEMO_DIR: '' } }, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 }),
  readComments = ({ repo, pr }) => readCompletePrComments(pr, { repo,
    exec: (_file, args, options) => runGhSync(args, { ...options, env, throttle: { env: { ...env, WE_GH_READ_MEMO_DIR: '' } } }) }),
  readPlan = ({ repo }) => runReconcilePass({ repo, readOnly: true }),
  readReviews = readCompletePrReviews, planning = {},
  readLive = ({ repo, pr }) => JSON.parse(gh(['pr', 'view', String(pr), '--repo', repo,
    '--json', 'state,isDraft,headRefOid,labels'])),
  post = ({ repo, pr, body }) => runGhSync(['pr', 'comment', String(pr), '--repo', repo, '--body-file', '-'],
    { env, throttle: { env: { ...env, WE_GH_READ_MEMO_DIR: '' } }, input: body, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 }),
} = {}) {
  return { [RED_TEAM_ENQUEUE_EFFECT]: async input => {
    validateRedTeamRequest(input);
    const live = await readLive(input);
    const comments = await readComments(input);
    liveRedTeamRequest(input, { ...live, comments });
    const request = planRedTeamEnqueue(input, { ...live, comments, reviews: await readReviews(input) },
      { env, ...planning, plan: await readPlan(input) });
    const existing = redTeamRequestForHead(comments, request);
    if (existing?.reason === request.reason) return { status: 'already-requested', head: request.head };
    // A move during the complete comment read must not bind a request to stale evidence.
    const fresh = await readLive(input);
    if (fresh?.headRefOid !== request.head || fresh.state !== 'OPEN' || fresh.isDraft !== false) {
      throw Error('red-team-enqueue: PR changed while reading; retry at the live head');
    }
    await post({ ...request, body: redTeamRequestBody(request) });
    return { status: 'requested', head: request.head, reason: request.reason };
  } };
}
