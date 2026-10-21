/** xux0rs9 — completed reviews awaiting an already-attempted mandatory ruling owe no new panel.
 * Run evidence is local; the PR thread supplies wake-up events and a durable notice marker.
 * Persistence failures get three retries (15/30/60 minutes), then the same event-driven hold.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
import { parseReviewedSha } from '../lib/review-escalation.mjs';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { publishAttention } from '../operations/needs-you-feed.mjs';
import { isUnderTest } from '../lib/under-test.mjs';
import { createActionStore } from '../operations/action-store.mjs';
import { actionResource } from '../operations/action-record.mjs';

export const REFERRAL_HOLD_MARKER = 'review paused:';
export const GH_LIST_COMMENT_CAP = 100;
export const PENDING_REASON_TOKENS = Object.freeze(new Set(['author-stamp-missing']));
export const REFERRAL_RETRY_MS = [15, 30, 60].map(n => n * 60_000);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Completed-panel evidence, or an incomplete attempt that can spend a no-verdict retry but prove no verdict.
 * A run suspended at human confirmation has completed its panel, although the operation is pending. */
export function reviewRunEvidence(run) {
  if (run?.op !== 'review-pr') return null;
  const read = run.findings?.read;
  const head = read?.netBasis?.rev;
  // A run rewound to resume (card xq1xbsl) has dropped its verdict and its referral step. Until the resumed pass has
  // run `advise` (the last step before it parks again), `resumeOf` (what the rewind set aside) stands in for them, so a
  // resume that dies or throws anywhere part-way still reads as the parked run it was and the next tick resumes it
  // again instead of starting a fresh panel that would raise the new referrals this card exists to stop.
  const ownAdvise = run.stepTimings?.find(t => t.step === 'advise')?.finishedAt;
  const resuming = Boolean(run.resumeOf) && !ownAdvise;
  const ownVerdict = resuming ? undefined : run.findings?.referralVerdict ?? run.verdict;
  const verdict = resuming ? run.resumeOf.verdict : ownVerdict;
  // `advise` runs AFTER the referral step, so the rewind drops its timing too; the parked pass's finish time stands in.
  const finish = ownAdvise ?? run.resumeOf?.adviseFinishedAt;
  // A resumed run starts again at the resume: the rulings that woke it are answered. Only once the pass is finished,
  // though: an unfinished resume has answered nothing yet, and must stay wakeable by the ruling that started it.
  const startedAt = Math.max(Date.parse(run.stepTimings?.find(t => t.step === 'read')?.startedAt),
    resuming ? 0 : Date.parse(run.resumedAt ?? '') || 0);
  const completedAt = Date.parse(finish);
  if (!sha(head) || !Number.isFinite(startedAt)) return null;
  if (!Number.isFinite(completedAt)) {
    // Crashes before/during advise still consumed a retry. Keep them in the cached projection, without
    // inventing a completed panel or clean referral evidence for acceptance/carry readers.
    return { id: run.id, repo: read.repo, pr: Number(read.pr), head, startedAt, completedAt: null,
      incomplete: true, parked: false, attempted: false, persistenceFailed: false, count: 0,
      pending: ['review-incomplete'], rulings: [] };
  }
  const state = (resuming ? run.resumeOf.mandatoryReferrals : run.findings?.mandatoryReferrals)?.effects?.find(e => e.type === 'review.mandatory-referrals')?.result;
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
/** The on-disk projection beside the records (not `.json`, so no run-store listing reads it as a record). Live
 *  2026-10-10: 3,303 review-pr records (0.8 GB) were re-parsed by EVERY reconcile-pass process — minutes under host
 *  load, enough to time out the drain rebuild's reconcile/dispatch smoke checks. Keyed by the projection's own source,
 *  so a change to {@link reviewRunEvidence} never serves a stale projection. */
export const REVIEW_EVIDENCE_CACHE_FILE = '.review-run-evidence.cache';
/** A warm process with at most this many changed records parses them directly instead of the whole on-disk file. */
export const EVIDENCE_DISK_MIN_MISSES = 32;
const projectionCode = project => createHash('sha256').update(String(project)).digest('hex').slice(0, 16);
function readEvidenceDiskCache(file, code) {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    return c?.v === 1 && c.code === code && c.entries && typeof c.entries === 'object' ? c.entries : {};
  } catch { return {}; }
}
function writeEvidenceDiskCache(file, code, entries) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ v: 1, code, entries }));
    renameSync(tmp, file);
  } catch { try { unlinkSync(tmp); } catch { /* best effort: the cache is only a speed-up */ } }
}
export function readReviewRunEvidence({ dir = resolveRunsDir(), readRun = tryReadRun, memo = evidenceCache, persist = true } = {}) {
  return readRunProjections({ dir, readRun, memo, persist, project: reviewRunEvidence, cacheFile: REVIEW_EVIDENCE_CACHE_FILE });
}

/** The cached reader every run-store projection shares: one disk cache per `cacheFile`, keyed by `project`'s own
 *  source, so a changed projection never serves stale entries. Exported for tests. */
export function readRunProjections({ dir, readRun, memo, persist, project, cacheFile, missing = () => [] }) {
  const code = projectionCode(project);
  let names;
  try { names = readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return missing(); throw e; }
  const file = join(dir, cacheFile);
  let disk = null;
  let dirty = false;
  const kept = {};
  // xwu9oxh S6 — the on-disk projection (~45 MB of JSON at ~6.6k records) is for a COLD process. Live 2026-10-20 the
  // long-lived fix daemon parsed it on every reconcile pass (always once at the end, and again whenever the review
  // daemon had written even one new record) — ~140 MB of transient heap per pass, several passes per tick. A warm
  // process now parses its few missed records directly and leaves the file alone; the file is read (and rewritten)
  // only when this call misses every record or more than EVIDENCE_DISK_MIN_MISSES of them. Same evidence either way.
  const rows = names.filter(n => n.startsWith('review-pr-') && n.endsWith('.json')).map(name => {
    const path = join(dir, name);
    const stat = statSync(path);
    return { name, path, key: `${stat.mtimeMs}:${stat.size}` };
  });
  const misses = rows.filter(r => memo.get(r.path)?.key !== r.key).length;
  const useDisk = persist && misses > 0 && (misses === rows.length || misses > EVIDENCE_DISK_MIN_MISSES);
  const out = rows.flatMap(({ name, path }) => {
    // Re-stat right before use (the count above is only a hint), so each record's key is read at the same moment
    // relative to its parse as before this change.
    const stat = statSync(path);
    const key = `${stat.mtimeMs}:${stat.size}`;
    let cached = memo.get(path);
    if (cached?.key !== key && useDisk) {
      disk ??= readEvidenceDiskCache(file, code);
      const hit = disk[name];
      if (hit?.key === key) cached = { key, evidence: hit.evidence ?? null };
    }
    if (cached?.key !== key) {
      cached = { key, evidence: project(readRun(name.slice(0, -5), dir)) };
      dirty = true;
    }
    memo.set(path, cached);
    kept[name] = cached;
    return cached.evidence ? [cached.evidence] : [];
  });
  if (useDisk) {
    disk ??= readEvidenceDiskCache(file, code);
    if (dirty || Object.keys(disk).some(n => !kept[n])) writeEvidenceDiskCache(file, code, kept);
  }
  return out;
}

/** The events on the PR thread that wake a parked review, each tagged with what woke it. `ruling` (a reviewer's or
 * the operator's finding ruling on this run's head) is the only kind a RESUME answers; a re-arm, a send-back or a
 * plain operator reply asks for a fresh look, so it is `fresh`. Bookkeeping, including our own notice and repeated
 * referral snapshots, never wakes a panel.
 */
function wakeEvents(pr, run) {
  const knownRulings = new Set(run.rulings);
  return (pr.comments ?? []).flatMap(c => {
    if (!isTrustedMarkerAuthor(c)) return [];
    const at = Date.parse(c.updatedAt ?? c.createdAt);
    if (!Number.isFinite(at)) return [];
    const body = (c.body ?? '').trimStart();
    if (body.startsWith(REFERRAL_HOLD_MARKER)) return [];
    if (body.includes(`<!-- ${REFERRAL_RECORD_MARKER}:`)) {
      const { records } = readReferralRecords([c], { head: pr.headRefOid });
      return records.some(r => r.repo === run.repo && r.pr === run.pr && r.head === run.head
        && r.rulings.some(ruling => !knownRulings.has(JSON.stringify(ruling)))) ? [{ at, kind: 'ruling' }] : [];
    }
    // #4979 — an operator's block/card/not-real ruling on this run's head is a ruling like a reviewer's: it wakes.
    const operatorRuling = parseOperatorRulingComment(c);
    if (operatorRuling) {
      const r = operatorRuling.record;
      return r && r.repo === run.repo && r.pr === run.pr && r.head === run.head ? [{ at, kind: 'ruling' }] : [];
    }
    if (body.startsWith(REARM_COMMENT_MARKER) || body.startsWith('🔁 review — changes requested')) return [{ at, kind: 'fresh' }];
    // An operator reply is a request to reconsider, never authority to clear the human gate.
    return isOperatorAuthored(c) ? [{ at, kind: 'fresh' }] : [];
  });
}

function wakeTime(pr, run) {
  return Math.max(0, ...wakeEvents(pr, run).map(e => e.at));
}

/** A later attempt consumes a parked run's release even if it dies before advise. Keep completed
 * panel ordering, but never let an older park hide a newer incomplete attempt on that history. */
function latestReviewAttempt(history) {
  const completed = history.filter(r => Number.isFinite(r.completedAt))
    .sort((a, b) => b.completedAt - a.completedAt)[0];
  return history.filter(r => r.incomplete && Number.isFinite(r.startedAt)
    && (!completed || r.startedAt >= completed.startedAt))
    .sort((a, b) => b.startedAt - a.startedAt)[0] ?? completed;
}

/**
 * The parked run an operator's ruling should RESUME instead of starting a fresh panel (card xq1xbsl; live 2026-10-08,
 * #4361 and #4388: a ruling on an unchanged head was followed by a full new review that raised NEW referrals, so the PR
 * flipped back to `advisory:ruling-needed` and never reached the operator). The rule: the newest run on this PR is
 * parked on mandatory referrals at the PR's CURRENT head, it persisted them, and everything that woke it since it began
 * is a ruling. Any re-arm, send-back or operator reply since asks for a fresh look, so it answers `null`, as does a
 * head that moved (a new push owes a new review) or a persistence failure (the retry budget owns that case). Pure.
 * @returns {{id: string, head: string}|null}
 */
export function findResumableParkedRun(pr, runs, { repo } = {}) {
  const history = runs.filter(r => r.repo === repo && r.pr === Number(pr.number));
  const last = latestReviewAttempt(history);
  if (!last?.parked || last.head !== pr.headRefOid || !last.attempted || last.persistenceFailed) return null;
  const events = wakeEvents(pr, last).filter(e => e.at > last.startedAt);
  if (events.some(e => e.kind === 'fresh')) return null;
  return events.length ? { id: last.id, head: last.head } : null;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The referral hold's decision, tagged: `released` names a DELIBERATE release (a ruling, wake event or retry), which
 * the same-head guard must not override; `released: null` with no hold just means no parked run to hold on.
 */
function evaluateReferralHold(pr, runs, { repo, now = Date.now(), env = process.env,
  // The SAME reader the review gate uses, so a `card` ruling naming a card that does not exist yet keeps the hold.
  cardReadable = ref => referralCardReadable(ref, REPO_ROOT) } = {}) {
  const attempts = runs.filter(r => r.repo === repo && r.pr === Number(pr.number));
  const last = latestReviewAttempt(attempts);
  const history = attempts.filter(r => Number.isFinite(r.completedAt))
    .sort((a, b) => b.completedAt - a.completedAt);
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

/** Extra automatic review runs allowed on one head when none of the prior runs left a verdict on the PR. */
export const VERDICT_RETRY_EXTRA = 2;
/** Missing verdicts get bounded cool-down releases after the immediate retry budget is spent: 1h, 2h, 4h, 8h, 8h, ... */
export const VERDICT_COOLDOWN_BASE_MS = 60 * 60_000;
export const VERDICT_COOLDOWN_CAP_MS = 8 * 60 * 60_000;
/** Hard upper bound on cool-down releases per head, whatever any layer says. */
export const VERDICT_COOLDOWN_MAX_RELEASES = 6;
/**
 * `reviewNoVerdictRetry.cooldownReleases` — how many bounded cool-down releases a head whose verdict never landed gets
 * after the immediate re-runs are spent. Standard 0 (main's permanent hold); the tool layer
 * scripts/settings/review-no-verdict-retry.json sets 6 (operator 2026-10-20); env
 * WE_REVIEW_NO_VERDICT_COOLDOWN_RELEASES beats both. Integer 0..VERDICT_COOLDOWN_MAX_RELEASES; anything else is
 * ignored (the lower layer / standard applies). Resolves standard → platform → tool → env with policy-cascade source logging.
 */
export const NO_VERDICT_RETRY_STANDARD = Object.freeze({ cooldownReleases: 0 });
export const NO_VERDICT_RETRY_TOOL_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../settings/review-no-verdict-retry.json');
const validCooldownReleases = v => Number.isInteger(v) && v >= 0 && v <= VERDICT_COOLDOWN_MAX_RELEASES;
function readNoVerdictRetryTool(path = NO_VERDICT_RETRY_TOOL_FILE) {
  try { return JSON.parse(readFileSync(path, 'utf8'))?.reviewNoVerdictRetry; } catch { return undefined; }
}
export function resolveNoVerdictRetry(env = process.env, { tool } = {}) {
  if (!env || typeof env !== 'object') return { cooldownReleases: NO_VERDICT_RETRY_STANDARD.cooldownReleases, source: 'standard' };
  try {
    const raw = env.WE_REVIEW_NO_VERDICT_COOLDOWN_RELEASES;
    const block = tool !== undefined ? tool : readNoVerdictRetryTool();
    const r = cascadePolicy('reviewNoVerdictRetry', block && typeof block === 'object' && !Array.isArray(block)
      ? { cooldownReleases: block.cooldownReleases } : undefined, {
      env, standard: NO_VERDICT_RETRY_STANDARD,
      envValues: { cooldownReleases: raw == null || String(raw).trim() === '' ? undefined : /^\d+$/.test(String(raw).trim()) ? Number(raw) : raw },
      valid: { cooldownReleases: validCooldownReleases },
    });
    const value = r.value?.cooldownReleases;
    return validCooldownReleases(value)
      ? { cooldownReleases: value, source: r.sources?.cooldownReleases ?? 'standard' }
      : { cooldownReleases: NO_VERDICT_RETRY_STANDARD.cooldownReleases, source: 'standard' };
  } catch { return { cooldownReleases: NO_VERDICT_RETRY_STANDARD.cooldownReleases, source: 'standard' }; }
}
/** A just-finished run gets this long for its verdict write-back to show up in the (cached) PR listing. */
export const VERDICT_GRACE_MS = 10 * 60_000;
const VERDICT_LABELS = ['review:accepted', 'review:changes', 'review:human'];

/**
 * True when `last` (a review attempt on the PR's current head) left NO visible verdict: the PR still holds
 * only `review:pending`, and no `reviewed-sha` accept marker names this head. Pure.
 */
export function verdictNeverLanded(pr, last, now = Date.now()) {
  if (!last) return false;
  if (Number.isFinite(last.completedAt)) {
    if (now - last.completedAt < VERDICT_GRACE_MS) return false;
  } else if (!last.incomplete || !Number.isFinite(last.startedAt)) return false;
  // An incomplete attempt spends its budget as soon as read pins the head. There is no finished
  // verdict write-back to wait for; renewing grace on each crash would allow unlimited retries.
  const names = (pr?.labels ?? []).map(l => (typeof l === 'string' ? l : l?.name));
  if (!names.includes('review:pending') || names.some(n => VERDICT_LABELS.includes(n))) return false;
  const head = typeof pr?.headRefOid === 'string' ? pr.headRefOid.trim().toLowerCase() : '';
  return !(head && parseReviewedSha(pr?.comments) === head);
}

export function decideSameHeadHold(pr, runs, { repo, env = process.env, now = Date.now(), retry = resolveNoVerdictRetry(env) } = {}) {
  const max = resolveSameHeadMaxReviews(env);
  if (max === 0) return null;
  const history = runs.filter(r => r.repo === repo && r.pr === Number(pr.number) && r.head === pr.headRefOid);
  // Newer incomplete attempts own retry accounting, including after an older parked review was released.
  // A fresh head can also crash on EVERY attempt and must still reach the exhausted needs-you hold.
  const last = latestReviewAttempt(history);
  if (!last || last.persistenceFailed) return null;
  const wake = wakeTime(pr, last);
  // A completed run whose verdict NEVER LANDED on the PR (GitHub refused the comment/label write; live 2026-10-07,
  // #4288: GraphQL error as the review finished, so the PR stayed `review:pending` with no verdict and this hold
  // then silenced it forever, unlogged) did not review the head in any way the PR can see. Re-arm it ourselves,
  // bounded to VERDICT_RETRY_EXTRA extra runs, then bounded cool-down releases with exponential backoff.
  const noVerdict = verdictNeverLanded(pr, last, now);
  // Normal same-head and referral holds still require completed panels. A no-verdict retry spends its
  // budget as soon as read identifies the head, even if the process dies before advise can finish.
  const attempts = history.filter(r => r.startedAt >= wake && (noVerdict || Number.isFinite(r.completedAt)));
  const count = attempts.length;
  if (count < max) return null;
  if (noVerdict && count < max + VERDICT_RETRY_EXTRA) return null;
  let retryAt = null;
  // Cool-down releases already spent on this head/wake, including unfinished retries.
  const spent = count - (max + VERDICT_RETRY_EXTRA);
  const releases = validCooldownReleases(retry?.cooldownReleases) ? Math.min(retry.cooldownReleases, VERDICT_COOLDOWN_MAX_RELEASES) : 0;
  if (noVerdict && spent < releases) {
    const cooldown = Math.min(VERDICT_COOLDOWN_BASE_MS * 2 ** spent, VERDICT_COOLDOWN_CAP_MS);
    // A pre-wake panel may finish after the newer crashes; its write-back still sets the cooldown floor.
    const latestCompletedAt = history.reduce((latest, r) => Math.max(latest,
      Number.isFinite(r.completedAt) ? r.completedAt : 0), 0);
    const latestAttemptAt = attempts.reduce((latest, r) => Math.max(latest,
      Number.isFinite(r.completedAt) ? r.completedAt : r.startedAt), latestCompletedAt);
    retryAt = latestAttemptAt + cooldown;
    if (now >= retryAt) return null;
  }
  const head = pr.headRefOid;
  // Past the last release: the permanent hold main has always had, now also raised to the operator (needs-you).
  const noVerdictExhausted = noVerdict && retryAt === null;
  const why = `${REFERRAL_HOLD_MARKER} head ${head.slice(0, 9)} was already reviewed ${count} time(s); it resumes on a new push or an explicit re-arm`
    + (noVerdict ? ` (no verdict ever landed on the PR for those runs, and the ${VERDICT_RETRY_EXTRA} automatic re-runs are spent: a person must look at why the review's write-back fails)` : '')
    + (retryAt !== null ? `; the next automatic re-run is due at ${new Date(retryAt).toISOString()}` : '');
  return { kind: 'same-head', head, episode: hash([repo, pr.number, head, wake, 'same-head']), count,
    why, retryAt, persistenceFailed: false, exhausted: false,
    ...(noVerdict ? { noVerdict: { exhausted: noVerdictExhausted, releasesSpent: Math.max(0, Math.min(spent, releases)),
      releases, source: retry?.source ?? 'standard' } } : {}) };
}

/** Block-ruled referrals on the PR's CURRENT head, once EVERY referral on it is ruled (none pending): the PR is owed a
 * FIX, not a review. The same-head pause stops only a re-review of an unchanged head; the fix is what changes it
 * (live 2026-10-06, #4017: three `block` rulings, the pause refused every fix tick, so no push ever came).
 * Read exactly as the gate reads it. Any pending referral, or no block, answers `[]`. Never throws.
 */
export function blockRuledReferralsFor(pr, { repo, cardReadable = ref => referralCardReadable(ref, REPO_ROOT) } = {}) {
  try {
    if (!sha(pr?.headRefOid)) return [];
    const live = liveReferralState(pr, { repo, pr: Number(pr.number), cardReadable });
    if (live.pending.length || !live.blockedFindings?.length) return [];
    return live.blockedFindings.map(b => ({ key: b.key, findingId: b.findingId ?? null, finding: b.finding }));
  } catch { return []; }
}

function defaultReadComments({ repo, number }) {
  return JSON.parse(execFileSyncThrottled('gh', ['pr', 'view', String(number), ...(repo ? ['--repo', repo] : []), '--json', 'comments'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 32 * 1024 * 1024 })).comments;
}

export function enrichPrsWithReferralHolds(prs, { repo, now = Date.now(), env = process.env, readRuns = readReviewRunEvidence,
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
    const { hold, released } = evaluateReferralHold(pr, runs, { repo, now, env });
    const blockRuledReferrals = blockRuledReferralsFor(pr, { repo });
    return { ...pr, blockRuledReferrals,
      referralHold: hold ?? (released ? null : decideSameHeadHold(pr, runs, { repo, now, env })) };
  });
}

/**
 * A no-verdict same-head hold past its last cool-down release is permanent (as on main) and must never be silent: raise
 * a needs-you event per repo+PR+head.
 *
 * DELIVERY IS AT-LEAST-ONCE, BY OPERATOR RULING (2026-10-20), NOT A DEFECT: never-silent wins over exactly-once.
 *
 * NO HAND-ROLLED LOCKS: the claim is the repo's audited durable per-resource claim ledger
 * (we:scripts/operations/action-store.mjs — exclusive `wx` attempt allocation, lock-fenced CAS transitions, expiry +
 * reconciliation), kept in its OWN coordination root (`<notices dir>/needs-you-claims`) so these claims never hold the
 * review/fix dispatch claims of the same PR. Resource `<repo>#pr:<n>`, kind {@link NO_VERDICT_NEEDS_YOU_KIND}, the head
 * in `evidence.head`.
 * - Done (deduped) = a `terminal`/`settled` attempt of this kind for this head.
 * - Otherwise claim → CAS intent→dispatching (the fenced "I still hold the claim" check, immediately before publishing;
 *   lost → no publish) → publish → dispatching→observed→terminal(settled).
 * - Publish failure → terminal(not-started): the next tick claims again.
 * - A crashed owner's claim expires (store LEASE_MS) and is reconciled by the store at the next claim: never-dispatched
 *   → abandoned, observed → settled (no re-raise), dispatching → abandoned after the store's absence grace → raised
 *   again: the accepted at-least-once duplicate. Attempt numbers are unbounded (no counter that can exhaust).
 * - If the claim ledger itself is unusable (unknown repo, unreadable/corrupt store), the event is published directly —
 *   never silent; the feed's own open-key state dedupes repeats.
 * Never throws.
 */
export const NO_VERDICT_NEEDS_YOU_KIND = 'needs-you-stalled-review';
export const needsYouClaimRoot = dir => join(dir, 'needs-you-claims');
export function raiseNoVerdictNeedsYou({ repo, prNumber, hold, dir, now = Date.now(), log = line => console.error(line),
  publish, store, owner = `review-daemon:${process.pid}`, beforePublish = null }) {
  try {
    if (!sha(hold?.head)) return false;
    // The real operator feed is never written from a test run unless the test injects its own publisher.
    if (!publish) {
      if (isUnderTest(process.env)) return false;
      publish = item => publishAttention(item, { now });
    }
    const item = { repo, pr: Number(prNumber), head: hold.head, kind: 'review-no-verdict',
      reason: `review verdict never landed after ${hold.count} runs and ${hold.noVerdict?.releasesSpent ?? 0} cool-down retries; held until a push or re-arm`,
      pick: `https://github.com/${repo}/pull/${prNumber}` };
    const announce = () => log(`${repo}#${prNumber} NEEDS-YOU review-no-verdict head ${hold.head.slice(0, 9)}: ${hold.count} runs, `
      + `${hold.noVerdict?.releasesSpent ?? 0}/${hold.noVerdict?.releases ?? 0} cool-down retries spent `
      + `(reviewNoVerdictRetry.cooldownReleases source=${hold.noVerdict?.source ?? 'standard'}); permanent hold`);
    let actions, resource, claimed;
    try {
      actions = store ?? createActionStore({ root: needsYouClaimRoot(dir), now: () => now });
      resource = actionResource(repo, { type: 'pr', id: String(prNumber) });
      const done = actions.attempts(resource).some(r => r.kind === NO_VERDICT_NEEDS_YOU_KIND && r.evidence?.head === hold.head
        && r.state === 'terminal' && r.outcome === 'settled');
      if (done) return false;
      claimed = actions.claim({ resource, kind: NO_VERDICT_NEEDS_YOU_KIND, owner, evidence: { head: hold.head },
        reconcile: record => actions.reconcile(record, { listAgents: () => [], findEffect: () => ({ found: false }),
          postconditionHolds: () => true, owner }) });
    } catch (e) {
      // The claim ledger is unusable: never silent — publish directly (the feed dedupes repeats).
      log(`${repo}#${prNumber} no-verdict needs-you claim ledger unusable (${String(e?.message ?? e).split('\n')[0]}) — publishing unclaimed`);
      publish(item);
      announce();
      return true;
    }
    if (!claimed?.ok) return false; // held by a live (or not yet reconcilable) claim: its owner publishes, or it expires
    let rec = claimed.record;
    // Claiming may have reconciled an expired attempt for this head into `settled` (it had published): then it is done.
    try {
      if (actions.attempts(resource).some(r => r.attempt !== rec.attempt && r.kind === NO_VERDICT_NEEDS_YOU_KIND
        && r.evidence?.head === hold.head && r.state === 'terminal' && r.outcome === 'settled')) {
        actions.release(resource, rec.attempt, { token: rec.ownerToken, rev: rec.rev });
        return false;
      }
    } catch { /* fall through: publishing again is the at-least-once side */ }
    if (typeof beforePublish === 'function') beforePublish(); // TEST-ONLY seam: pause the owner here
    const go = actions.transition(resource, rec.attempt, { token: rec.ownerToken, rev: rec.rev, from: 'intent', to: 'dispatching',
      patch: { dispatchingSince: now } });
    if (!go.ok) { log(`${repo}#${prNumber} no-verdict needs-you: claim lost before publishing (${go.reason}) — not publishing`); return false; }
    rec = go.record;
    try { publish(item); }
    catch (e) {
      actions.transition(resource, rec.attempt, { token: rec.ownerToken, rev: rec.rev, from: 'dispatching', to: 'terminal', patch: { outcome: 'not-started' } });
      log(`${repo}#${prNumber} no-verdict needs-you could not be published (retried next tick): ${String(e?.message ?? e).split('\n')[0]}`);
      return false;
    }
    // At-least-once: if these writes fail or the process dies first, the store's expiry/reconcile re-raises it.
    try {
      const seen = actions.transition(resource, rec.attempt, { token: rec.ownerToken, rev: rec.rev, from: 'dispatching', to: 'observed', patch: { handle: 'needs-you-feed' } });
      if (seen.ok) actions.transition(resource, rec.attempt, { token: seen.record.ownerToken, rev: seen.record.rev, from: 'observed', to: 'terminal', patch: { outcome: 'settled' } });
    } catch (e) { log(`${repo}#${prNumber} no-verdict needs-you claim not settled (may re-raise): ${String(e?.message ?? e).split('\n')[0]}`); }
    announce();
    return true;
  } catch (e) {
    try { log(`${repo}#${prNumber} no-verdict needs-you not raised this tick (retried next tick): ${String(e?.message ?? e).split('\n')[0]}`); } catch { /* never throws */ }
    return false;
  }
}

/** Reserve before sending: an ambiguous transport failure must not create duplicate comments on every tick.
 * Known pre-send rate-limit failures can retry with bounded backoff; all other failures remain visible locally.
 */
export function notifyReferralHold({ repo, prNumber, hold, comments = [],
  dir = join(dirname(resolveRunsDir()), 'review-referral-notices'), now = Date.now(),
  log = line => console.error(line), publishNeedsYou,
  post = body => execFileSyncThrottled('gh', ['pr', 'comment', String(prNumber), '--repo', repo, '--body', body],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }),
}) {
  if (hold.kind === 'same-head' && hold.noVerdict?.exhausted) {
    raiseNoVerdictNeedsYou({ repo, prNumber, hold, dir, now, log, publish: publishNeedsYou });
  }
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
    const need = rulingNeeded({ headRefOid: hold.head, comments }, { cardReadable: ref => referralCardReadable(ref, REPO_ROOT) });
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
