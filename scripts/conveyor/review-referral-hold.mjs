/** xux0rs9 — completed reviews awaiting an already-attempted mandatory ruling owe no new panel.
 * Run evidence is local; the PR thread supplies wake-up events and a durable notice marker.
 * Persistence failures get three retries (15/30/60 minutes), then the same event-driven hold.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { referralCardReadable } from '../lib/referral-card-readable.mjs';
import { liveReferralState } from '../lib/referral-live-context.mjs';
import { resolveRunsDir, tryReadRun } from '../operations/run-store.mjs';
import { parseOperatorRulingComment, readReferralRecords, REFERRAL_RECORD_MARKER } from '../lib/jury-core.mjs';
import { isOperatorAuthored, isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { REARM_COMMENT_MARKER } from './rearm-review.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { rulingNeeded } from '../lib/ruling-ledger.mjs';

export const REFERRAL_HOLD_MARKER = 'review paused:';
export const GH_LIST_COMMENT_CAP = 100;
export const PENDING_REASON_TOKENS = Object.freeze(new Set(['author-stamp-missing']));
export const REFERRAL_RETRY_MS = [15, 30, 60].map(n => n * 60_000);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A run suspended at human confirmation has completed its panel, although the operation is pending. */
export function reviewRunEvidence(run) {
  if (run?.op !== 'review-pr') return null;
  const read = run.findings?.read;
  const head = read?.netBasis?.rev;
  const verdict = run.findings?.referralVerdict ?? run.verdict;
  const finish = run.stepTimings?.find(t => t.step === 'advise')?.finishedAt;
  const startedAt = Date.parse(run.stepTimings?.find(t => t.step === 'read')?.startedAt);
  const completedAt = Date.parse(finish);
  if (!sha(head) || !Number.isFinite(completedAt) || !Number.isFinite(startedAt)) return null;
  const state = run.findings?.mandatoryReferrals?.effects?.find(e => e.type === 'review.mandatory-referrals')?.result;
  const pending = verdict?.pendingReferrals ?? [];
  const findingKeys = pending.filter(key => !PENDING_REASON_TOKENS.has(key));
  const attempted = new Set((state?.records ?? [])
    .filter(r => r.repo === read.repo && r.pr === Number(read.pr) && r.head === head && r.attempted)
    .flatMap(r => r.referrals.map(f => f.key)));
  return { id: run.id, repo: read.repo, pr: Number(read.pr), head, startedAt, completedAt,
    parked: verdict?.verdict === 'needs-human' && pending.length > 0,
    // A list of only reason tokens names no referral, so it was never "attempted" (not vacuously true).
    pending, attempted: findingKeys.length > 0 && findingKeys.every(key => attempted.has(key)),
    persistenceFailed: pending.includes('referral-persistence-failed'),
    count: pending.includes('referral-persistence-failed') ? Math.max(1, verdict?.referrals?.length ?? 0) : findingKeys.length,
    rulings: (state?.records ?? []).flatMap(r => r.rulings ?? []).map(r => JSON.stringify(r)),
  };
}

// Cache only small projections, never full diffs/seat transcripts. A changed file is parsed again.
const evidenceCache = new Map();
export function readReviewRunEvidence({ dir = resolveRunsDir() } = {}) {
  let names;
  try { names = readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return names.filter(n => n.startsWith('review-pr-') && n.endsWith('.json')).flatMap(name => {
    const path = join(dir, name);
    const stat = statSync(path);
    const key = `${stat.mtimeMs}:${stat.size}`;
    let cached = evidenceCache.get(path);
    if (cached?.key !== key) {
      cached = { key, evidence: reviewRunEvidence(tryReadRun(name.slice(0, -5), dir)) };
      evidenceCache.set(path, cached);
    }
    return cached.evidence ? [cached.evidence] : [];
  });
}

/** Bookkeeping, including our own notice and repeated referral snapshots, never wakes a panel. */
function wakeTime(pr, run) {
  const knownRulings = new Set(run.rulings);
  return Math.max(0, ...(pr.comments ?? []).flatMap(c => {
    if (!isTrustedMarkerAuthor(c)) return [];
    const at = Date.parse(c.updatedAt ?? c.createdAt);
    if (!Number.isFinite(at)) return [];
    const body = (c.body ?? '').trimStart();
    if (body.startsWith(REFERRAL_HOLD_MARKER)) return [];
    if (body.includes(`<!-- ${REFERRAL_RECORD_MARKER}:`)) {
      const { records } = readReferralRecords([c], { head: pr.headRefOid });
      return records.some(r => r.repo === run.repo && r.pr === run.pr && r.head === run.head
        && r.rulings.some(ruling => !knownRulings.has(JSON.stringify(ruling)))) ? [at] : [];
    }
    // #4979 — an operator's block/card/not-real ruling on this run's head is a ruling like a reviewer's: it wakes.
    const operatorRuling = parseOperatorRulingComment(c);
    if (operatorRuling) {
      const r = operatorRuling.record;
      return r && r.repo === run.repo && r.pr === run.pr && r.head === run.head ? [at] : [];
    }
    if (body.startsWith(REARM_COMMENT_MARKER) || body.startsWith('🔁 review — changes requested')) return [at];
    // An operator reply is a request to reconsider, never authority to clear the human gate.
    return isOperatorAuthored(c) ? [at] : [];
  }));
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The referral hold's decision, tagged: `released` names a DELIBERATE release (a ruling, wake event or retry), which
 * the same-head guard must not override; `released: null` with no hold just means no parked run to hold on.
 */
function evaluateReferralHold(pr, runs, { repo, now = Date.now(), env = process.env,
  // The SAME reader the review gate uses, so a `card` ruling naming a card that does not exist yet keeps the hold.
  cardReadable = ref => referralCardReadable(ref, REPO_ROOT) } = {}) {
  const history = runs.filter(r => r.repo === repo && r.pr === Number(pr.number))
    .sort((a, b) => b.completedAt - a.completedAt);
  const last = history[0];
  if (!last?.parked || last.head !== pr.headRefOid || (!last.attempted && !last.persistenceFailed)) return { hold: null, released: null };
  const wake = wakeTime(pr, last);
  if (wake > last.startedAt) return { hold: null, released: 'wake' };
  let streak = 0;
  for (const run of history) {
    if (run.head !== last.head || !run.parked || !run.persistenceFailed || run.startedAt < wake) break;
    streak++;
  }
  const retryAt = last.persistenceFailed && streak <= REFERRAL_RETRY_MS.length
    ? last.completedAt + REFERRAL_RETRY_MS[streak - 1] : null;
  if (retryAt !== null && now >= retryAt) return { hold: null, released: 'retry' };
  if (!last.persistenceFailed && env.WE_REFERRAL_HOLD_LIVE_RELEASE !== '0') {
    // Read exactly as the gate reads it (readable-card rule, author stamp, PR body/createdAt): a release the
    // gate would immediately re-park loops the review on every tick, which this hold exists to prevent.
    const live = liveReferralState(pr, { repo, pr: Number(pr.number), cardReadable });
    if (!live.pending.length && live.records.some(r => r.head === pr.headRefOid
      && r.repo === repo && r.pr === Number(pr.number))) return { hold: null, released: 'live-release' };
  }
  const why = `review paused: ${last.count} referrals need a ruling; it resumes on a new push, a ruling, or a send-back`;
  // Same episode across retries and daemon restarts. A new operator event gets a new notice only if it parks again.
  return { released: null, hold: { head: last.head, episode: hash([repo, pr.number, last.head, wake]), count: last.count,
    why, retryAt, persistenceFailed: last.persistenceFailed, exhausted: last.persistenceFailed && retryAt === null } };
}

export function decideReferralHold(pr, runs, opts) {
  return evaluateReferralHold(pr, runs, opts).hold;
}

/** One completed review per head/re-arm by default; persistence retries have their own budget. */
export function resolveSameHeadMaxReviews(env = process.env) {
  const value = env.WE_REVIEW_SAME_HEAD_MAX_REVIEWS;
  if (value === '0') return 0;
  const max = Number(value);
  return /^\d+$/.test(value ?? '') && Number.isSafeInteger(max) && max > 0 ? max : 1;
}

export function decideSameHeadHold(pr, runs, { repo, env = process.env } = {}) {
  const max = resolveSameHeadMaxReviews(env);
  if (max === 0) return null;
  const history = runs.filter(r => r.repo === repo && r.pr === Number(pr.number) && r.head === pr.headRefOid)
    .sort((a, b) => b.completedAt - a.completedAt);
  const last = history[0];
  if (!last || last.persistenceFailed) return null;
  const wake = wakeTime(pr, last);
  const count = history.filter(r => r.startedAt >= wake).length;
  if (count < max) return null;
  const head = pr.headRefOid;
  const why = `${REFERRAL_HOLD_MARKER} head ${head.slice(0, 9)} was already reviewed ${count} time(s); it resumes on a new push or an explicit re-arm`;
  return { kind: 'same-head', head, episode: hash([repo, pr.number, head, wake, 'same-head']), count,
    why, retryAt: null, persistenceFailed: false, exhausted: false };
}

function defaultReadComments({ repo, number }) {
  return JSON.parse(execFileSyncThrottled('gh', ['pr', 'view', String(number), ...(repo ? ['--repo', repo] : []), '--json', 'comments'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 32 * 1024 * 1024 })).comments;
}

export function enrichPrsWithReferralHolds(prs, { repo, now = Date.now(), readRuns = readReviewRunEvidence,
  readComments = defaultReadComments } = {}) {
  const runs = readRuns();
  return prs.map(pr => {
    // List reads cap comments at 100; later operator events must reach both hold decisions.
    if (Array.isArray(pr.comments) && pr.comments.length >= GH_LIST_COMMENT_CAP
      && runs.some(r => r.repo === repo && r.pr === Number(pr.number) && r.head === pr.headRefOid)) {
      try {
        const full = readComments({ repo, number: pr.number });
        if (Array.isArray(full)) pr = { ...pr, comments: full };
      }
      catch { /* Keep the list snapshot when the full thread is unavailable. */ }
    }
    // A deliberate release (ruling cleared, new event, retry due) owes a fresh review: the same-head guard stays out.
    const { hold, released } = evaluateReferralHold(pr, runs, { repo, now });
    return { ...pr, referralHold: hold ?? (released ? null : decideSameHeadHold(pr, runs, { repo })) };
  });
}

/** Reserve before sending: an ambiguous transport failure must not create duplicate comments on every tick.
 * Known pre-send rate-limit failures can retry with bounded backoff; all other failures remain visible locally.
 */
export function notifyReferralHold({ repo, prNumber, hold, comments = [],
  dir = join(dirname(resolveRunsDir()), 'review-referral-notices'), now = Date.now(),
  log = line => console.error(line),
  post = body => execFileSyncThrottled('gh', ['pr', 'comment', String(prNumber), '--repo', repo, '--body', body],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }),
}) {
  if (hold.kind === 'same-head') return;
  const marker = `<!-- review-referral-hold: ${hold.episode} -->`;
  const path = join(dir, `${hash([repo, prNumber, hold.episode])}.json`);
  mkdirSync(dir, { recursive: true });
  let receipt;
  try { receipt = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (receipt && (!receipt.retryAt || now < receipt.retryAt)) return;
  if (comments.some(c => isTrustedMarkerAuthor(c) && c.body?.includes(marker))) return;
  const attempt = (receipt?.attempt ?? 0) + 1;
  try { writeFileSync(path, JSON.stringify({ attempt }), { flag: receipt ? 'w' : 'wx' }); }
  catch (e) { if (e.code === 'EEXIST') return; throw e; }
  if (!receipt) log(`${repo}#${prNumber} ${hold.why}`);
  const detail = !hold.persistenceFailed ? '' : hold.retryAt
    ? `\n\nReferral persistence failed; the next bounded retry is at ${new Date(hold.retryAt).toISOString()}.`
    : '\n\nReferral persistence retries are exhausted; waiting for a new event.';
  // One line per waiting finding with its file, so the thread itself says what is owed (live 2026-10-04, PR #3794:
  // "N referrals need a ruling" named nothing). A read failure just leaves the old, shorter notice.
  let findings = '';
  try {
    const need = rulingNeeded({ headRefOid: hold.head, comments });
    if (need) findings = `\n\nWaiting on your ruling (block, card or not-real):\n${need.findings
      .map(f => `- \`${f.file ?? 'no file'}${f.line ? `:${f.line}` : ''}\` — ${f.summary}`).join('\n')}`;
  } catch { /* the short notice still posts */ }
  try { post(`${hold.why}${findings}${detail}\n\n${marker}`); }
  catch (e) {
    const error = String(e.message ?? e);
    const retryAt = error.includes('call not sent') && attempt <= REFERRAL_RETRY_MS.length
      ? now + REFERRAL_RETRY_MS[attempt - 1] : null;
    writeFileSync(path, JSON.stringify({ attempt, retryAt, error }));
    log(`${repo}#${prNumber} paused-review notice could not be posted: ${error.split('\n')[0]}`);
  }
}
