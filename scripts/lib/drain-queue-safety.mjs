/** Queue admission and removal share this policy and head-bound red-team evidence. */
import { redTeamEnabled, redTeamOwedFor } from './review-red-team-policy.mjs';
import { execFileSync } from 'node:child_process';
import { cascadePolicy, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { readMergeQueueState } from './merge-queue-enqueue.mjs';
import { redTeamForHead, planRedTeamActions, readConfirmedBreaks, parseRedTeamComment, parseRedTeamGateMarker, RED_TEAM_COMMENT_MARKER, GATE_OUTCOMES } from './red-team-gate.mjs';
import { parseVerdictCarriedMarker } from './review-verdict-carried-marker.mjs';
import { parseLatestHumanClearedSha } from './review-escalation.mjs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';
import { readSavedRedTeamResult, savedRedTeamPosition, skipCardOnlyRedTeam } from './drain-saved-red-team.mjs';

export function readDrainQueueSafety({ env = process.env, tool, platform, log = () => {} } = {}) {
  const booleanEnv = key => env[key] === undefined ? undefined
    : /^(true|1|on)$/i.test(env[key]) ? true : /^(false|0|off)$/i.test(env[key]) ? false : env[key];
  const numberEnv = key => env[key] === undefined ? undefined : Number(env[key]);
  const positive = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const r = cascadePolicy('drain', tool ?? (env.VITEST || env.WE_UNDER_TEST ? {} : readSettings().drain), {
    env, platform, standard: { waitForRedTeamBeforeEnqueue: true, dequeueOnSendBack: true, redTeamPendingBackoffSec: 300, redTeamPendingMaxMin: 45, enqueueWhenRedTeamNeverScheduled: true },
    valid: { enqueueWhenRedTeamNeverScheduled: v => typeof v === 'boolean', waitForRedTeamBeforeEnqueue: v => typeof v === 'boolean', dequeueOnSendBack: v => typeof v === 'boolean', redTeamPendingBackoffSec: positive, redTeamPendingMaxMin: positive },
    envValues: { enqueueWhenRedTeamNeverScheduled: booleanEnv('WE_DRAIN_ENQUEUE_WHEN_RED_TEAM_NEVER_SCHEDULED'), waitForRedTeamBeforeEnqueue: booleanEnv('WE_DRAIN_WAIT_FOR_RED_TEAM_BEFORE_ENQUEUE'), dequeueOnSendBack: booleanEnv('WE_DRAIN_DEQUEUE_ON_SEND_BACK'), redTeamPendingBackoffSec: numberEnv('WE_DRAIN_RED_TEAM_PENDING_BACKOFF_SEC'), redTeamPendingMaxMin: numberEnv('WE_DRAIN_RED_TEAM_PENDING_MAX_MIN') },
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

/** The review scheduler's decision over its actual head-bound payload, never inferred from labels. */
export function postAcceptRedTeamOwed(loopPayload, env = process.env) {
  return redTeamEnabled(env) && redTeamOwedFor(loopPayload) && !skipCardOnlyRedTeam(loopPayload, env);
}

const CARRIED_LINE_RE = /^<!-- review-verdict-carried from=[0-9a-f]{40} to=[0-9a-f]{40} patch-id=[0-9a-f]{40} -->$/;
/** The heading only `review-set-label --to=clear-human` renders, at the very start of its comment (CLEARED_HUMAN_PROSE_RE). */
const CLEAR_HUMAN_RULING_RE = /^✅ review — `review:human` cleared via the sanctioned path\n\nCleared by .+? via `review-set-label\.mjs --to=clear-human`/;

/**
 * A verdict carry (review-job carryAcrossRebase) posts ONE comment: its gate markers, the carried marker, prose,
 * then the re-keyed red-team body, so the anchored readers see none of it. Split only that exact layout: gate lines
 * are taken only from before the carried line and must name the head carried to (a chain of carries splits at each
 * link). `at` keeps the thread position and `from` names the head the records were carried from. PURE.
 */
function threadRecords(comments) {
  // Every reader below counts trusted records only, so untrusted comments are dropped before any parse.
  return (Array.isArray(comments) ? comments : []).filter(isTrustedMarkerAuthor).flatMap((c, at) => {
    const body = typeof c === 'string' ? c : c?.body;
    const lines = typeof body === 'string' ? body.replace(/\r\n/g, '\n').trimStart().split('\n') : [];
    const k = lines.findIndex(line => CARRIED_LINE_RE.test(line));
    const carried = k < 0 ? null : parseVerdictCarriedMarker(lines[k]);
    const advisoryBody = lines.slice(k + 2).join('\n');
    const advisory = carried && lines[k + 1] === 'Review verdict carried across an identical contribution.'
      && lines[k + 2]?.startsWith(RED_TEAM_COMMENT_MARKER) ? parseRedTeamComment(advisoryBody) : null;
    if (!advisory || advisory.rev !== carried.toSha || !lines.slice(0, k).every(line => {
      const gate = parseRedTeamGateMarker(line);
      return gate?.rev === carried.toSha && gate.pr === advisory.pr;
    })) return [{ c, at }];
    const parts = [...lines.slice(0, k), advisoryBody];
    return [{ c, at }, ...parts.map(part => ({ c: { ...c, body: part }, at, from: carried.fromSha }))];
  });
}

/**
 * Did the operator rule on the head's confirmed breaks? The gate handed them over (`round-cap`), and a trusted
 * clear-human ceremony for that head came after both the round-cap record and the result. Only the ceremony's own
 * comment counts: a restamp repeats the cleared-human marker for a ruling made on another head. A carried result
 * defers to the ruling on the head it was carried from, read from the thread before the carry. PURE.
 */
function operatorRuled(records, pr, head, savedResult) {
  const trusted = records.filter(r => isTrustedMarkerAuthor(r.c));
  if (parseLatestHumanClearedSha(trusted.filter(r => !r.from).map(r => r.c)) !== head) return false;
  const lastAt = (rs, test) => rs.reduce((found, r) => (test(r) ? r : found), null);
  const body = r => (typeof r.c === 'string' ? r.c : r.c?.body);
  // Each carry removes its own comment and every later record, so even a cyclic head chain terminates.
  for (let sha = head, rs = trusted; sha && rs.length;) {
    const result = lastAt(rs, r => { const p = parseRedTeamComment(body(r)); return p?.pr === Number(pr) && p.rev === sha; }) ?? savedRedTeamPosition(savedResult, pr, sha, rs);
    const cap = lastAt(rs, r => { const g = parseRedTeamGateMarker(body(r)); return g?.pr === Number(pr) && g.rev === sha && g.outcome === GATE_OUTCOMES.ROUND_CAP; });
    const cleared = lastAt(rs, r => !r.from && CLEAR_HUMAN_RULING_RE.test(String(body(r) ?? '').replace(/\r\n/g, '\n').trimStart())
      && parseLatestHumanClearedSha([r.c]) === sha);
    if (!result) return false;
    if (cap && cleared && cleared.at > cap.at && cleared.at > result.at) return true;
    if (!result.from) return false;
    rs = rs.filter(r => r.at < result.at);
    sha = result.from;
  }
  return false;
}

export function redTeamEnqueueHold({ loopPayload, comments, repo, pr, head, env = process.env, confirmedBreaks } = {}) {
  // A recorded break still holds even if the scheduler is now disabled or the payload is unavailable.
  const live = String(head ?? '').toLowerCase();
  const records = threadRecords(comments);
  const result = redTeamForHead(records.map(r => r.c), pr, live) ?? readSavedRedTeamResult({ repo, pr, head: live, env });
  if (result && planRedTeamActions(result, confirmedBreaks ?? readConfirmedBreaks({ env }).value).sendBack.length
    && !operatorRuled(records, pr, live, result))
    return 'post-accept red team confirmed a break requiring send-back';
  if (!postAcceptRedTeamOwed(loopPayload, env) || result) return null;
  return 'post-accept red team has no recorded result on the live head';
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
