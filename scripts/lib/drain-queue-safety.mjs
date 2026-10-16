/** Queue admission and removal share this policy and head-bound red-team evidence. */
import { execFileSync } from 'node:child_process';
import { cascadePolicy, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { readMergeQueueState } from './merge-queue-enqueue.mjs';
import { redTeamForHead, planRedTeamActions, readConfirmedBreaks, parseRedTeamComment, parseRedTeamGateMarker, RED_TEAM_COMMENT_MARKER, GATE_OUTCOMES } from './red-team-gate.mjs';
import { parseVerdictCarriedMarker } from './review-verdict-carried-marker.mjs';
import { parseLatestHumanClearedSha } from './review-escalation.mjs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';

export function readDrainQueueSafety({ env = process.env, tool, platform, log = () => {} } = {}) {
  const booleanEnv = key => env[key] === undefined ? undefined
    : /^(true|1|on)$/i.test(env[key]) ? true : /^(false|0|off)$/i.test(env[key]) ? false : env[key];
  const numberEnv = key => env[key] === undefined ? undefined : Number(env[key]);
  const positive = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const r = cascadePolicy('drain', tool ?? (env.VITEST || env.WE_UNDER_TEST ? {} : readSettings().drain), {
    env, platform, standard: { waitForRedTeamBeforeEnqueue: true, dequeueOnSendBack: true, redTeamPendingBackoffSec: 300, redTeamPendingMaxMin: 45 },
    valid: { waitForRedTeamBeforeEnqueue: v => typeof v === 'boolean', dequeueOnSendBack: v => typeof v === 'boolean', redTeamPendingBackoffSec: positive, redTeamPendingMaxMin: positive },
    envValues: { waitForRedTeamBeforeEnqueue: booleanEnv('WE_DRAIN_WAIT_FOR_RED_TEAM_BEFORE_ENQUEUE'), dequeueOnSendBack: booleanEnv('WE_DRAIN_DEQUEUE_ON_SEND_BACK'), redTeamPendingBackoffSec: numberEnv('WE_DRAIN_RED_TEAM_PENDING_BACKOFF_SEC'), redTeamPendingMaxMin: numberEnv('WE_DRAIN_RED_TEAM_PENDING_MAX_MIN') },
  });
  log(formatCascadeSourcesLine('drain', r));
  return r;
}

export const queueLabels = labels => (labels ?? []).map(l => typeof l === 'string' ? l : l?.name);
export function sendBackReason(labels) {
  const names = queueLabels(labels);
  const hold = ['review:changes', 'review:human', 'review:pending'].find(l => names.includes(l));
  return hold ? `state is ${hold}` : !names.includes('ready-to-merge') ? 'ready-to-merge was removed' : null;
}

/** Same accepted-panel shapes as review-extra-seats' redTeamOwedFor, using the published verdict labels. */
export function postAcceptRedTeamOwed(labels, env = process.env) {
  const off = key => ['0', 'off', 'false', 'no'].includes(String(env[key] ?? '').trim().toLowerCase());
  if (off('WE_REVIEW_RED_TEAM') || off('WE_REVIEW_EXTRA_SEATS')) return false;
  const names = queueLabels(labels);
  return names.includes('review:accepted') || names.includes('advisory:accepted');
}

/**
 * A verdict carry (review-job carryAcrossRebase) posts its gate markers and the carried marker BEFORE the re-keyed
 * red-team body, so the anchored readers see none of them. Split each carried record into its own entry; `at` keeps
 * the thread position and `from` names the head the record was carried from. PURE.
 */
function threadRecords(comments) {
  return (Array.isArray(comments) ? comments : []).flatMap((c, at) => {
    const body = typeof c === 'string' ? c : c?.body;
    const carried = typeof body === 'string' ? parseVerdictCarriedMarker(body) : null;
    if (!carried) return [{ c, at }];
    const cut = body.indexOf(RED_TEAM_COMMENT_MARKER);
    const split = (cut < 0 ? body : body.slice(0, cut)).split('\n').filter(line => parseRedTeamGateMarker(line));
    if (cut >= 0) split.push(body.slice(cut));
    return [{ c, at }, ...split.map(part => ({ c: { ...c, body: part }, at, from: carried.fromSha }))];
  });
}

/**
 * Did the operator rule on the head's confirmed breaks? The gate handed them over (`round-cap`), and a trusted
 * clear-human for that head came after both the round-cap record and the result. A carried result defers to the
 * ruling on the head it was carried from, read from the thread before the carry. PURE.
 */
function operatorRuled(records, pr, head) {
  const trusted = records.filter(r => isTrustedMarkerAuthor(r.c));
  if (parseLatestHumanClearedSha(trusted.map(r => r.c)) !== head) return false;
  const lastAt = (rs, test) => rs.reduce((found, r) => (test(r) ? r : found), null);
  const body = r => (typeof r.c === 'string' ? r.c : r.c?.body);
  for (let sha = head, rs = trusted, depth = 0; sha && depth < 16; depth++) {
    const result = lastAt(rs, r => { const p = parseRedTeamComment(body(r)); return p?.pr === Number(pr) && p.rev === sha; });
    const cap = lastAt(rs, r => { const g = parseRedTeamGateMarker(body(r)); return g?.pr === Number(pr) && g.rev === sha && g.outcome === GATE_OUTCOMES.ROUND_CAP; });
    const cleared = lastAt(rs, r => parseLatestHumanClearedSha([r.c]) === sha);
    if (!result) return false;
    if (cap && cleared && cleared.at > cap.at && cleared.at > result.at) return true;
    if (!result.from) return false;
    rs = rs.filter(r => r.at < result.at);
    sha = result.from;
  }
  return false;
}

/** Accepted panels owe the post-accept pass even when speculation has not started. No clocks. */
export function redTeamEnqueueHold({ labels, comments, pr, head, env = process.env, confirmedBreaks } = {}) {
  if (!postAcceptRedTeamOwed(labels, env)) return null;
  const live = String(head ?? '').toLowerCase();
  const records = threadRecords(comments);
  const result = redTeamForHead(records.map(r => r.c), pr, live);
  if (!result) return 'post-accept red team has no recorded result on the live head';
  // The result comment precedes the gate. Do not enqueue in that second race window either.
  if (planRedTeamActions(result, confirmedBreaks ?? readConfirmedBreaks({ env }).value).sendBack.length
    && !operatorRuled(records, pr, live))
    return 'post-accept red team confirmed a break requiring send-back';
  return null;
}

/** Membership is authoritative both before and after the mutation. A retry after success posts no duplicate. */
export function dequeueSentBack({ repo, pr, reason, exec = execFileSync, log = () => {} } = {}) {
  const readJson = args => JSON.parse(exec('gh', args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }));
  const before = readMergeQueueState({ repo, pr, readJson });
  if (before.error) throw new Error(before.error);
  if (!before.inQueue) return { dequeued: false };
  const { id } = readJson(['pr', 'view', String(pr), '--repo', repo, '--json', 'id']);
  if (!id) throw new Error('dequeue: missing PR node id');
  const query = 'mutation($id:ID!){dequeuePullRequest(input:{pullRequestId:$id}){clientMutationId}}';
  const r = readJson(['api', 'graphql', '-f', `query=${query}`, '-f', `id=${id}`]);
  if (r.errors?.length || !r.data?.dequeuePullRequest) throw new Error(`dequeue refused: ${JSON.stringify(r.errors ?? r)}`);
  const after = readMergeQueueState({ repo, pr, readJson });
  if (after.error || after.inQueue !== false) throw new Error(`dequeue unconfirmed: ${after.error ?? 'isInMergeQueue is still true'}`);
  log(`merge-queue: dequeued ${repo}#${pr}: ${reason} (isInMergeQueue=false)`);
  exec('gh', ['pr', 'comment', String(pr), '--repo', repo, '--body', `Removed from the merge queue: ${reason}.`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { dequeued: true };
}
