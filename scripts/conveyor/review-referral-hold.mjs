/** xux0rs9 — completed reviews awaiting an already-attempted mandatory ruling owe no new panel.
 * Run evidence is local; the PR thread supplies wake-up events and a durable notice marker.
 * Persistence failures get three retries (15/30/60 minutes), each resuming the parked run at its referral step
 * (no new panel), then the same event-driven hold.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { referralCardReadable } from '../lib/referral-card-readable.mjs';
import { liveReferralState } from '../lib/referral-live-context.mjs';
import { resolveRunsDir, tryReadRun } from '../operations/run-store.mjs';
import { parseOperatorRulingComment, readReferralRecords, REFERRAL_RECORD_MARKER, activeReferrals,
  referralRecordState, AUTO_POLICY_ACTOR } from '../lib/jury-core.mjs';
import { isOperatorAuthored, isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { REARM_COMMENT_MARKER } from './rearm-review.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { rulingNeeded } from '../lib/ruling-ledger.mjs';
import { parseReviewedSha } from '../lib/review-escalation.mjs';
import { cascadePolicy, platformPreference } from '../lib/policy-cascade.mjs';
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
  // A rewind drops the referral result. Use the saved pass until this pass finishes referralVerdict; an unrelated
  // advisory failure must not hide a successful persist behind the saved persistence failure (PR #5771).
  const ownAdvise = run.stepTimings?.find(t => t.step === 'advise')?.finishedAt;
  const resuming = Boolean(run.resumeOf) && !ownAdvise;
  const ownReferral = resuming && run.findings?.referralVerdict
    ? run.stepTimings?.find(t => t.step === 'referralVerdict')?.finishedAt : undefined;
  const savedReferral = resuming && !ownReferral;
  const verdict = savedReferral ? run.resumeOf.verdict : run.findings?.referralVerdict ?? run.verdict;
  const finish = ownAdvise ?? ownReferral ?? run.resumeOf?.adviseFinishedAt;
  // A resumed run starts again at the resume: the rulings that woke it are answered. Only once the pass is finished,
  // though: an unfinished resume has answered nothing yet, and must stay wakeable by the ruling that started it.
  const startedAt = Math.max(Date.parse(run.stepTimings?.find(t => t.step === 'read')?.startedAt),
    resuming ? 0 : Date.parse(run.resumedAt ?? '') || 0);
  // An interrupted persist retry still spends a slot. Start its next backoff at the latest resume, rather than
  // the original parked pass: after an outage that old deadline could spend every remaining slot on adjacent ticks.
  const completedAt = Math.max(Date.parse(finish),
    resuming && verdict?.pendingReferrals?.includes('referral-persistence-failed') ? Date.parse(run.resumedAt ?? '') || 0 : 0);
  if (!sha(head) || !Number.isFinite(startedAt)) return null;
  if (!Number.isFinite(completedAt)) {
    // Crashes before/during advise still consumed a retry. Keep them in the cached projection, without
    // inventing a completed panel or clean referral evidence for acceptance/carry readers.
    return { id: run.id, repo: read.repo, pr: Number(read.pr), head, startedAt, completedAt: null,
      incomplete: true, parked: false, attempted: false, persistenceFailed: false, count: 0,
      pending: ['review-incomplete'], rulings: [] };
  }
  const state = (savedReferral ? run.resumeOf.mandatoryReferrals : run.findings?.mandatoryReferrals)?.effects?.find(e => e.type === 'review.mandatory-referrals')?.result;
  const pending = verdict?.pendingReferrals ?? [];
  const resumeAdvise = Boolean(resuming && ownReferral && !pending.includes('referral-persistence-failed'));
  const findingKeys = pending.filter(key => !PENDING_REASON_TOKENS.has(key));
  const attempted = new Set((state?.records ?? [])
    .filter(r => r.repo === read.repo && r.pr === Number(read.pr) && r.head === head && r.attempted)
    .flatMap(r => r.referrals.map(f => f.key)));
  return { id: run.id, repo: read.repo, pr: Number(read.pr), head, startedAt, completedAt,
    ...(resumeAdvise ? { resumeAdvise: true } : {}),
    parked: verdict?.verdict === 'needs-human' && pending.length > 0,
    // A list of only reason tokens names no referral, so it was never "attempted" (not vacuously true).
    pending, attempted: findingKeys.length > 0 && findingKeys.every(key => attempted.has(key)),
    persistenceFailed: pending.includes('referral-persistence-failed'),
    count: pending.includes('referral-persistence-failed') ? Math.max(1, verdict?.referrals?.length ?? 0) : findingKeys.length,
    rulings: (state?.records ?? []).flatMap(r => r.rulings ?? []).map(r => JSON.stringify(r)),
    // How many times this run was already resumed to retry a failed referral persist (card 5752 below). Each such
    // resume is one spent slot of the 15/30/60 retry budget, though it stays the same run.
    persistRetries: Math.max(0, Number(run.resumeOf?.persistRetries) || 0),
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
const EVIDENCE_CODE = createHash('sha256').update(String(reviewRunEvidence)).digest('hex').slice(0, 16);
function readEvidenceDiskCache(file) {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    return c?.v === 1 && c.code === EVIDENCE_CODE && c.entries && typeof c.entries === 'object' ? c.entries : {};
  } catch { return {}; }
}
function writeEvidenceDiskCache(file, entries) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ v: 1, code: EVIDENCE_CODE, entries }));
    renameSync(tmp, file);
  } catch { try { unlinkSync(tmp); } catch { /* best effort: the cache is only a speed-up */ } }
}
export function readReviewRunEvidence({ dir = resolveRunsDir(), readRun = tryReadRun, memo = evidenceCache, persist = true } = {}) {
  let names;
  try { names = readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const file = join(dir, REVIEW_EVIDENCE_CACHE_FILE);
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
      disk ??= readEvidenceDiskCache(file);
      const hit = disk[name];
      if (hit?.key === key) cached = { key, evidence: hit.evidence ?? null };
    }
    if (cached?.key !== key) {
      cached = { key, evidence: reviewRunEvidence(readRun(name.slice(0, -5), dir)) };
      dirty = true;
    }
    memo.set(path, cached);
    kept[name] = cached;
    return cached.evidence ? [cached.evidence] : [];
  });
  if (useDisk) {
    disk ??= readEvidenceDiskCache(file);
    if (dirty || Object.keys(disk).some(n => !kept[n])) writeEvidenceDiskCache(file, kept);
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
    // `operator` marks a person's own word: the only event that answers a spent persist-retry budget.
    const operator = isOperatorAuthored(c);
    if (body.startsWith(REARM_COMMENT_MARKER) || body.startsWith('🔁 review — changes requested')) return [{ at, kind: 'fresh', operator }];
    // An operator reply is a request to reconsider, never authority to clear the human gate.
    return operator ? [{ at, kind: 'fresh', operator }] : [];
  });
}

function wakeTime(pr, run) {
  return Math.max(0, ...wakeEvents(pr, run).map(e => e.at));
}

/** The latest event by the operator in person: for a failed referral persist, the only wake (card 5752 below). */
function operatorWakeTime(pr, run) {
  return Math.max(0, ...wakeEvents(pr, run).filter(e => e.operator).map(e => e.at));
}

/** Has this run, on its own, spent the persist-retry budget? Its failed pass plus each resume that retried it. Pure. */
export function persistRetryBudgetSpent(run) {
  return Boolean(run?.persistenceFailed) && 1 + (Number(run.persistRetries) || 0) > REFERRAL_RETRY_MS.length;
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
 * head that moved (a new push owes a new review). A parked run whose referral persist FAILED is always resumable
 * (unless the operator in person asked for a fresh look): the retry budget picks the time, and the retry re-runs the persist step only. Pure.
 * @returns {{id: string, head: string}|null}
 */
export function findResumableParkedRun(pr, runs, { repo } = {}) {
  const history = runs.filter(r => r.repo === repo && r.pr === Number(pr.number));
  const last = latestReviewAttempt(history);
  if ((!last?.parked && !last?.resumeAdvise) || last.head !== pr.headRefOid) return null;
  // A run whose referral persist failed already holds its panel's verdict; what it owes is the persist step again,
  // not a new panel (live 2026-10-20, #5752: two ledger-push misses on one head each cost a full panel, and the
  // operator's Accept was refused until a person noticed). The hold decides WHEN (its 15/30/60 retry budget); once a
  // review is dispatched at all, it resumes this run at the referral step. Only the operator in person asks for a
  // fresh look here: an automated re-arm or a ruling cannot turn a persist retry into a new panel.
  // An automated wake that was ignored during persistence must not start a panel when only its advisory is left.
  if (last.persistenceFailed || last.resumeAdvise) return operatorWakeTime(pr, last) > last.startedAt ? null : { id: last.id, head: last.head };
  const events = wakeEvents(pr, last).filter(e => e.at > last.startedAt);
  if (events.some(e => e.kind === 'fresh')) return null;
  if (!last.attempted) return null;
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
  // The referral step succeeded but publication is still owed. This release also keeps the same-head hold from
  // replacing the obsolete persistence hold while the existing run retries its advisory step.
  if (last?.resumeAdvise && last.head === pr.headRefOid) return { hold: null, released: 'advisory-retry' };
  if (!last?.parked || last.head !== pr.headRefOid || (!last.attempted && !last.persistenceFailed)) return { hold: null, released: null };
  // A failed persist checks its retry budget BEFORE any wake (card 5752): a ruling or an automated re-arm cannot fix a
  // persist, so it neither skips the backoff nor revives a spent budget. Only the operator in person (the needs-you
  // answer) or a new push releases it then. Any other parked run wakes on any event, as before.
  const wake = last.persistenceFailed ? operatorWakeTime(pr, last) : wakeTime(pr, last);
  if (wake > last.startedAt) return { hold: null, released: 'wake' };
  let streak = 0;
  for (const run of history) {
    if (run.head !== last.head || !run.parked || !run.persistenceFailed || run.startedAt < wake) break;
    // A resumed persist retry stays the same run, so its earlier failed passes count from the run itself.
    streak += 1 + (run.persistRetries ?? 0);
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
  const exhausted = last.persistenceFailed && retryAt === null;
  const why = exhausted
    ? `review paused: ${last.count} referrals could not be persisted and the automatic retries are spent; it resumes on a new push or an operator reply`
    : `review paused: ${last.count} referrals need a ruling; it resumes on a new push, a ruling, or a send-back`;
  // Same episode across retries and daemon restarts. A new operator event gets a new notice only if it parks again.
  return { released: null, hold: { head: last.head, episode: hash([repo, pr.number, last.head, wake]), count: last.count,
    why, retryAt, persistenceFailed: last.persistenceFailed, exhausted } };
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
  // stale-hold-resume — every attempt since the wake, finished or not: the resume-once bound must count a review that
  // died before `advise` too, or a failing review would be resumed every tick.
  const attemptsSinceWake = history.filter(r => Number.isFinite(r.startedAt) && r.startedAt >= wake).length;
  return { kind: 'same-head', head, episode: hash([repo, pr.number, head, wake, 'same-head']), count, attemptsSinceWake,
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

/** The daemon's log prefix for a pause it resolved on its own (stale-hold-resume). */
export const REFERRAL_HOLD_AUTO_RESOLVED = 'referral-hold auto-resolved';

/**
 * `referralHoldAutoResolve` — the stale-hold-resume policy, resolved standard → platform → tool → env with
 * policy-cascade source logging (operator rule 2026-10-21: every policy is a setting, logged with value and source).
 * - `enabled` (standard true): false is the kill switch back to today's pause, byte-identical (no answer at all).
 *   Env `WE_REFERRAL_HOLD_AUTO_RESOLVE=0|1`.
 * - `onBlock` (standard `send-back`): a live-head block sends the PR back to the fixer; `pause` keeps the pause.
 *   Env `WE_REFERRAL_HOLD_AUTO_RESOLVE_ON_BLOCK`.
 * - `onClean` (standard `resume`): all card / not-real resumes the PR to its next step; `pause` keeps the pause.
 *   Env `WE_REFERRAL_HOLD_AUTO_RESOLVE_ON_CLEAN`.
 * Anything invalid in a layer is ignored (the layer below applies).
 */
export const REFERRAL_HOLD_AUTO_RESOLVE_STANDARD = Object.freeze({ enabled: true, onBlock: 'send-back', onClean: 'resume' });
export const REFERRAL_HOLD_AUTO_RESOLVE_TOOL_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../settings/referral-hold-auto-resolve.json');
const AUTO_RESOLVE_VALID = Object.freeze({
  enabled: v => typeof v === 'boolean',
  onBlock: v => v === 'send-back' || v === 'pause',
  onClean: v => v === 'resume' || v === 'pause',
});
export function resolveReferralHoldAutoResolve(env = process.env, { tool, log } = {}) {
  const standard = { value: { ...REFERRAL_HOLD_AUTO_RESOLVE_STANDARD },
    sources: { enabled: 'standard', onBlock: 'standard', onClean: 'standard' } };
  try {
    let block = tool;
    if (block === undefined) {
      try { block = JSON.parse(readFileSync(REFERRAL_HOLD_AUTO_RESOLVE_TOOL_FILE, 'utf8'))?.referralHoldAutoResolve; } catch { block = undefined; }
    }
    const raw = name => { const v = env?.[name]; return v == null || String(v).trim() === '' ? undefined : String(v).trim(); };
    const enabledRaw = raw('WE_REFERRAL_HOLD_AUTO_RESOLVE');
    // Only valid scalar leaves enter the cascade: a malformed value (an object, a typo) in one layer is dropped there,
    // so the layer below still decides — and the cascade log names exactly what decided.
    const clean = layer => {
      if (!layer || typeof layer !== 'object' || Array.isArray(layer)) return undefined;
      const out = {};
      for (const k of Object.keys(AUTO_RESOLVE_VALID)) if (AUTO_RESOLVE_VALID[k](layer[k])) out[k] = layer[k];
      return Object.keys(out).length ? out : undefined;
    };
    let platform;
    try { platform = platformPreference('referralHoldAutoResolve', { env: env ?? {} }); } catch { platform = undefined; }
    const r = cascadePolicy('referralHoldAutoResolve', clean(block), { platform: clean(platform) ?? {},
      env: env ?? {}, standard: REFERRAL_HOLD_AUTO_RESOLVE_STANDARD, valid: AUTO_RESOLVE_VALID, ...(log ? { log } : {}),
      envValues: { enabled: enabledRaw === '0' ? false : enabledRaw === '1' ? true : enabledRaw,
        onBlock: raw('WE_REFERRAL_HOLD_AUTO_RESOLVE_ON_BLOCK'), onClean: raw('WE_REFERRAL_HOLD_AUTO_RESOLVE_ON_CLEAN') },
    });
    const value = {};
    const sources = {};
    for (const k of Object.keys(AUTO_RESOLVE_VALID)) {
      const ok = AUTO_RESOLVE_VALID[k](r.value?.[k]);
      value[k] = ok ? r.value[k] : REFERRAL_HOLD_AUTO_RESOLVE_STANDARD[k];
      sources[k] = ok ? r.sources?.[k] ?? 'standard' : 'standard';
    }
    return { value, sources };
  } catch { return standard; }
}
const findingLoc = f => `${f?.file ?? 'no file'}${Number.isInteger(f?.line) ? `:${f.line}` : ''}`;

/**
 * stale-hold-resume (live 2026-10-21, #5773/#5775/#5800) — a PR paused on its live head whose every referral finding
 * already carries a ruling owes no ruling, yet nothing woke it: the review ran AFTER the rulings, so no ruling or push
 * was coming, and the same-head pause asked for "an explicit re-arm" forever. This decides, from the thread alone,
 * what the pause should become. PURE.
 *
 * A finding counts as ruled only when the gate itself reads a ruling for it on the LIVE head's own record
 * (`referralRecordState`: the record's counted ruling, the operator's ruling pinned to this head, or a carry the gate
 * backs). A ruling that exists only in the verdict ledger (a ledger-write-miss leaves exactly that) or only on an
 * older head is not readable here, so it never counts. Like the hold's own live release, the read omits the gate's
 * `seatDisabled` (importing the seat policy closes a cycle): an unruled finding of a since-disabled seat keeps the
 * pause, the conservative side. Outcomes:
 * - `send-back`: some live-head finding is ruled `block` (operator or policy or reviewer) and none is pending.
 * - `resume`: every live-head finding is ruled `card` or `not-real`.
 * - `stay` (fail closed, with `why`): anything unreadable, pending, missing, malformed, or not on the live head.
 * Never accepts and never touches `review:human`: the caller acts on the outcome.
 * @returns {null | {outcome:'send-back'|'resume'|'stay', head:string|null, why:string,
 *   findings?:Array<object>, blocked?:Array<object>, counts?:Record<string, number>}}
 */
export function decideReferralHoldAutoResolve(pr, hold, { repo,
  cardReadable = ref => referralCardReadable(ref, REPO_ROOT), env = process.env,
  settings = resolveReferralHoldAutoResolve(env) } = {}) {
  if (!hold || settings?.value?.enabled === false) return null;
  const policy = settings?.value ?? REFERRAL_HOLD_AUTO_RESOLVE_STANDARD;
  const source = k => settings?.sources?.[k] ?? 'standard';
  const head = sha(pr?.headRefOid) ? pr.headRefOid : null;
  const stay = why => ({ outcome: 'stay', head, why });
  if (!head || hold.head !== head) return stay('the pause is not on the live head');
  if (hold.persistenceFailed) return stay('the referral save failed on this head; its own retry budget owns the pause');
  if (hold.noVerdict) return stay('no verdict ever landed on this head; the no-verdict retries own the pause');
  if (hold.cause) return stay(`the verdict ledger cannot answer for this PR (${hold.cause})`);
  let live;
  try { live = liveReferralState(pr, { repo, pr: Number(pr.number), cardReadable }); }
  catch (e) { return stay(`the referral state is unreadable (${String(e?.message ?? e).split('\n')[0]})`); }
  if (live.malformed) return stay('a referral record or operator ruling on the thread is malformed');
  if (live.pending.length) {
    const named = live.pendingFindings.map(findingLoc);
    return stay(`${named.length || live.pending.length} finding(s) still have no readable ruling`
      + (named.length ? ` (${named.join(', ')})` : ` (${live.pendingReasons.join(', ')})`));
  }
  const records = live.records.filter(r => r.head === head && r.repo === repo && r.pr === Number(pr.number));
  if (!records.length) return stay('no referral record names the live head');
  const findings = [];
  for (const record of records) {
    const state = referralRecordState(record, { repo, pr: Number(pr.number), head, body: typeof pr.body === 'string' ? pr.body : '',
      createdAt: pr.createdAt, cardReadable, records: live.records, operatorRulings: live.operatorRulings });
    if (state.pending.length) return stay(`the live-head record ${record.runId} still holds ${state.pending.length} finding(s) pending`);
    // THE GATE DECIDES. `referralRecordState` (the acceptance gate's own reader) has already settled every active
    // referral of this live-head record: pending (returned above), blocked, or cleared by a ruling it counted (the
    // record's own, the operator's pinned to this head, a carry it backed, or a backed supersession). Its flattened
    // `rulings` list cannot be mapped back to findings (a carry backing is keyed by its SOURCE finding, which can
    // collide with a live finding), so it is read only to NAME the kind and who ruled; it never decides.
    const blockedKeys = new Set(state.blocked);
    for (const f of activeReferrals(record)) {
      const where = { file: f.finding?.file ?? null, line: Number.isInteger(f.finding?.line) ? f.finding.line : null };
      const own = state.rulings.filter(r => r.key === f.key);
      const carry = (record.carried ?? []).find(c => c.key === f.key);
      const named = blockedKeys.has(f.key)
        ? own.filter(r => r.result === 'block').at(-1) ?? { result: 'block' }
        : own.filter(r => r.result === 'card' || r.result === 'not-real').at(-1)
          ?? (carry && (carry.result === 'card' || carry.result === 'not-real') ? { result: carry.result, carried: true } : null)
          ?? ((record.superseded ?? []).some(x => x.key === f.key) ? { result: 'not-real', superseded: true } : null)
          ?? { result: 'cleared' };
      findings.push({ runId: record.runId, key: f.key, seat: f.seat ?? null, ...where,
        summary: String(f.finding?.summary ?? '').replace(/\s+/g, ' ').trim(), result: blockedKeys.has(f.key) ? 'block' : named.result,
        actor: named.operator ? named.actor : 'reviewer', rationale: named.rationale ?? named.reason ?? '' });
    }
  }
  if (!findings.length) return stay('the live-head records name no active referral');
  const counts = {};
  for (const f of findings) counts[f.result] = (counts[f.result] ?? 0) + 1;
  const blocked = findings.filter(f => f.result === 'block');
  const tally = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ');
  if (blocked.length) {
    if (policy.onBlock !== 'send-back') return { ...stay(`every finding is ruled (${tally}), but referralHoldAutoResolve.onBlock=${policy.onBlock} (source: ${source('onBlock')}) keeps the pause`), counts };
    return { outcome: 'send-back', head, findings, blocked, counts, policy: `onBlock=send-back (source: ${source('onBlock')})`,
      why: `every referral finding on head ${head.slice(0, 9)} is ruled (${tally}); ${blocked.length} block ruling(s) owe a fix` };
  }
  if (policy.onClean !== 'resume') return { ...stay(`every finding is ruled (${tally}), but referralHoldAutoResolve.onClean=${policy.onClean} (source: ${source('onClean')}) keeps the pause`), counts };
  return { outcome: 'resume', head, findings, counts, policy: `onClean=resume (source: ${source('onClean')})`,
    why: `every referral finding on head ${head.slice(0, 9)} is ruled (${tally}); no ruling is owed` };
}

/** The send-back body for {@link decideReferralHoldAutoResolve}'s `send-back`: the same words a block ruling's own
 *  follow-up posts (`record-referral-ruling.mjs#planRulingFollowUp`), naming every blocked finding. PURE. */
export function referralHoldSendBackBody({ head, blocked }) {
  // Escape HTML text rather than recognizing individual comment delimiters (including alternate endings).
  const prose = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\s+/g, ' ').trim();
  const actor = b => String(b.actor).toLowerCase();
  const byPolicy = blocked.every(b => actor(b) === AUTO_POLICY_ACTOR);
  const byOperator = blocked.every(b => actor(b) !== AUTO_POLICY_ACTOR && actor(b) !== 'reviewer');
  return `### Blocked referral findings (${byPolicy ? 'automatic policy ruling' : byOperator ? 'operator ruling' : 'standing block ruling'})\n\n`
    + `${byPolicy ? 'Policy (review.referralDefault=auto-block) ruled' : byOperator ? 'The operator ruled' : 'The standing rulings on this head rule'} these mandatory-referral findings \`block\` on head \`${head}\`. Fix each one, then push.\n\n`
    + blocked.map((o, i) => `${i + 1}. \`${findingLoc(o)}\` (${o.seat ?? 'reviewer'}) — ${prose(o.summary)}`
      + (prose(o.rationale) ? `\n   Rationale: ${prose(o.rationale)}` : '')).join('\n');
}

/** Attach {@link decideReferralHoldAutoResolve}'s answer to every PR still paused after every hold enrichment (the
 *  ledger step can replace the pause, so this runs last). Never throws: a failure is a `stay`. */
export function enrichPrsWithReferralHoldAutoResolve(prs, { repo, env = process.env, decide = decideReferralHoldAutoResolve,
  settings } = {}) {
  if (!Array.isArray(prs)) return prs;
  // Resolved once per pass (the cascade logs its value and source once per process).
  if (!settings && prs.some(pr => pr?.referralHold)) settings = resolveReferralHoldAutoResolve(env);
  return prs.map(pr => {
    if (!pr?.referralHold) return pr;
    let auto;
    try { auto = decide(pr, pr.referralHold, { repo, env, ...(settings ? { settings } : {}) }); }
    catch (e) { auto = { outcome: 'stay', head: pr.headRefOid ?? null, why: `auto-resolve failed (${String(e?.message ?? e).split('\n')[0]})` }; }
    return auto ? { ...pr, referralHoldAutoResolve: auto } : pr;
  });
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
