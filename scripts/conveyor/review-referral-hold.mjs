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
import { resolveRunsDir, REVIEW_RUN_ID_PREFIX, tryReadRun } from '../operations/run-store.mjs';
import { sameRepo, parseOperatorRulingComment, readReferralRecords, REFERRAL_RECORD_MARKER } from '../lib/jury-core.mjs';
import { isOperatorAuthored, isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { rulingNeeded } from '../lib/ruling-ledger.mjs';
import { resolveReferralSafetySettings } from '../lib/review-settings.mjs';
import { parseLatestHumanClearedSha, parseReviewedSha } from '../lib/review-escalation.mjs';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { publishAttention } from '../operations/needs-you-feed.mjs';
import { isUnderTest } from '../lib/under-test.mjs';

// Match we:scripts/conveyor/rearm-review.mjs#REARM_COMMENT_MARKER locally: importing it closes a daemon boot cycle.
// The equality test keeps this first-line matcher tied to the canonical marker.
export const REFERRAL_REARM_COMMENT_MARKER = '🔧 conveyor fix — re-armed for re-review';
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
  if (!sha(head) || !Number.isFinite(completedAt) || !Number.isFinite(startedAt)) return null;
  const state = (resuming ? run.resumeOf.mandatoryReferrals : run.findings?.mandatoryReferrals)?.effects?.find(e => e.type === 'review.mandatory-referrals')?.result;
  const pending = verdict?.pendingReferrals ?? [];
  const findingKeys = pending.filter(key => !PENDING_REASON_TOKENS.has(key));
  const attempted = new Set((state?.records ?? [])
    .filter(r => r.repo === read.repo && r.pr === Number(read.pr) && r.head === head && r.attempted)
    .flatMap(r => r.referrals.map(f => f.key)));
  // PR #5520 — a run started under a chosen `--run-id` says so in its record (`run-record.mjs#chosenRunIdRecord`).
  // Inline, not a helper: the disk cache is keyed by this function's source.
  return { id: run.id, repo: read.repo, pr: Number(read.pr), head, startedAt, completedAt,
    ...(run.idChosen === true ? { custom: true } : {}),
    parked: verdict?.verdict === 'needs-human' && pending.length > 0,
    // A list of only reason tokens names no referral, so it was never "attempted" (not vacuously true).
    pending, attempted: findingKeys.length > 0 && findingKeys.every(key => attempted.has(key)),
    persistenceFailed: pending.includes('referral-persistence-failed'),
    count: pending.includes('referral-persistence-failed') ? Math.max(1, verdict?.referrals?.length ?? 0) : findingKeys.length,
    rulings: (state?.records ?? []).flatMap(r => r.rulings ?? []).map(r => JSON.stringify(r)),
  };
}

/** PR #5520 — the head a `review-pr` run reviewed, finished or not. {@link reviewRunEvidence} drops a run that never
 *  finished `advise` (a publication effect that failed, a crash), but that run still reviewed this head: a carry
 *  that may stand in only for a head nobody reviewed must see it. */
export function reviewRunHead(run) {
  if (run?.op !== 'review-pr') return null;
  const read = run.findings?.read;
  const head = read?.netBasis?.rev;
  return sha(head) ? { id: run.id, repo: read.repo, pr: Number(read.pr), head,
    ...(run.idChosen === true ? { custom: true } : {}) } : null;
}

// Cache only small projections, never full diffs/seat transcripts. A changed file is parsed again.
const evidenceCache = new Map();
const headCache = new Map();
/** The on-disk projection beside the records (not `.json`, so no run-store listing reads it as a record). Live
 *  2026-10-10: 3,303 review-pr records (0.8 GB) were re-parsed by EVERY reconcile-pass process — minutes under host
 *  load, enough to time out the drain rebuild's reconcile/dispatch smoke checks. Keyed by the projection's own source,
 *  so a change to {@link reviewRunEvidence} never serves a stale projection. */
export const REVIEW_EVIDENCE_CACHE_FILE = '.review-run-evidence.cache';
export const REVIEW_HEAD_CACHE_FILE = '.review-run-heads.cache';
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
export const REVIEW_RUN_STORE_MISSING = 'REVIEW_RUN_STORE_MISSING';
/** Every `review-pr` run's reviewed head ({@link reviewRunHead}), including runs that never finished. A missing store
 *  throws {@link REVIEW_RUN_STORE_MISSING}: it proves nothing about which heads were reviewed, so it is never `[]`. */
export function readReviewRunHeads({ dir = resolveRunsDir(), readRun = tryReadRun, memo = headCache, persist = true } = {}) {
  return readRunProjections({ dir, readRun, memo, persist, project: reviewRunHead, cacheFile: REVIEW_HEAD_CACHE_FILE,
    missing: () => { throw Object.assign(new Error(`review run store missing: ${dir}`), { code: REVIEW_RUN_STORE_MISSING }); } });
}

/** PR #5520 operator send-back — the readers find review runs by name, so the name must be true: `writeRun` writes a
 *  `review-pr` record only under a `review-pr-` id, and no other operation's ({@link REVIEW_RUN_ID_PREFIX}). Inside
 *  that namespace a chosen `--run-id` is still possible: such a record carries `idChosen`, and an id not shaped as
 *  `newRunId('review-pr')` mints it (a record written before `idChosen`) is not trusted either. Both are tagged
 *  `custom`. A custom run still counts as a review of its head; it never counts as a clean one. */
const MINTED_REVIEW_RUN_ID_RE = /^review-pr-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isMintedReviewRunId = id => MINTED_REVIEW_RUN_ID_RE.test(String(id));

function readRunProjections({ dir, readRun, memo, persist, project, cacheFile, missing = () => [] }) {
  const code = projectionCode(project);
  let names;
  try { names = readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return missing(); throw e; }
  const file = join(dir, cacheFile);
  let disk = null;
  let dirty = false;
  const kept = {};
  const out = names.filter(n => n.startsWith(REVIEW_RUN_ID_PREFIX) && n.endsWith('.json')).flatMap(name => {
    const path = join(dir, name);
    const stat = statSync(path);
    const key = `${stat.mtimeMs}:${stat.size}`;
    let cached = memo.get(path);
    if (cached?.key !== key && persist) {
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
    if (!cached.evidence) return [];
    return [isMintedReviewRunId(name.slice(0, -5)) ? cached.evidence : { ...cached.evidence, custom: true }];
  });
  if (persist) {
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
      return r && sameRepo(r.repo, run.repo) && r.pr === run.pr && r.head === run.head ? [{ at, kind: 'ruling' }] : [];
    }
    if (body.includes('<!-- paused-review-auto-rearm:')) return [];
    if (body.startsWith(REFERRAL_REARM_COMMENT_MARKER) || body.startsWith('🔁 review — changes requested')) return [{ at, kind: 'fresh' }];
    // An operator reply is a request to reconsider, never authority to clear the human gate.
    return isOperatorAuthored(c) ? [{ at, kind: 'fresh' }] : [];
  });
}

function wakeTime(pr, run) {
  return Math.max(0, ...wakeEvents(pr, run).map(e => e.at));
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
  const history = runs.filter(r => r.repo === repo && r.pr === Number(pr.number)).sort((a, b) => b.completedAt - a.completedAt);
  const last = history[0];
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
    if (!live.pending.length
      && live.records.some(r => r.head === pr.headRefOid
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
 * True when `last` (a completed review run on the PR's current head) left NO visible verdict: the PR still holds
 * only `review:pending`, and no `reviewed-sha` accept marker names this head. Pure.
 */
export function verdictNeverLanded(pr, last, now = Date.now()) {
  if (!last || !Number.isFinite(last.completedAt) || now - last.completedAt < VERDICT_GRACE_MS) return false;
  const names = (pr?.labels ?? []).map(l => (typeof l === 'string' ? l : l?.name));
  if (!names.includes('review:pending') || names.some(n => VERDICT_LABELS.includes(n))) return false;
  const head = typeof pr?.headRefOid === 'string' ? pr.headRefOid.trim().toLowerCase() : '';
  return !(head && parseReviewedSha(pr?.comments) === head);
}

export function decideSameHeadHold(pr, runs, { repo, env = process.env, now = Date.now(), retry = resolveNoVerdictRetry(env) } = {}) {
  const max = resolveSameHeadMaxReviews(env);
  if (max === 0) return null;
  const history = runs.filter(r => r.repo === repo && r.pr === Number(pr.number) && r.head === pr.headRefOid)
    .sort((a, b) => b.completedAt - a.completedAt);
  const last = history[0];
  if (!last || last.persistenceFailed) return null;
  const wake = wakeTime(pr, last);
  const count = history.filter(r => r.startedAt >= wake).length;
  if (count < max) return null;
  // A completed run whose verdict NEVER LANDED on the PR (GitHub refused the comment/label write; live 2026-10-07,
  // #4288: GraphQL error as the review finished, so the PR stayed `review:pending` with no verdict and this hold
  // then silenced it forever, unlogged) did not review the head in any way the PR can see. Re-arm it ourselves,
  // bounded to VERDICT_RETRY_EXTRA extra runs, then bounded cool-down releases with exponential backoff.
  const noVerdict = verdictNeverLanded(pr, last, now);
  if (noVerdict && count < max + VERDICT_RETRY_EXTRA) return null;
  let retryAt = null;
  // Cool-down releases already spent on this head/wake (each release produced one more completed run).
  const spent = count - (max + VERDICT_RETRY_EXTRA);
  const releases = validCooldownReleases(retry?.cooldownReleases) ? Math.min(retry.cooldownReleases, VERDICT_COOLDOWN_MAX_RELEASES) : 0;
  if (noVerdict && spent < releases) {
    const cooldown = Math.min(VERDICT_COOLDOWN_BASE_MS * 2 ** spent, VERDICT_COOLDOWN_CAP_MS);
    retryAt = last.completedAt + cooldown;
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

/** Historical auto-rearm receipt, retained for readers; it no longer creates a wake. */
export const pausedReviewRearmMarker = head => `<!-- paused-review-auto-rearm: ${head} -->`;

/** Pure classification of a paused PR using the gate's live state, including unattempted records and reason holds.
 * Same-head pauses need a person even if all finding rulings are already recorded.
 */
export function classifyPausedReview(pr, live) {
  if (!sha(pr?.headRefOid)) return { action: 'none', findings: [] };
  const records = live.records.filter(r => r.head === pr.headRefOid);
  const all = [...new Map(records.flatMap(r => r.referrals.map(f => [f.key, {
    key: f.key, file: f.finding?.file ?? null, line: f.finding?.line ?? null,
    summary: f.finding?.summary ?? '',
  }]))).values()];
  const pending = [...new Map(live.pendingFindings.map(f => [f.key, {
    key: f.key, file: f.file, line: f.line, summary: f.summary,
  }])).values()];
  if (live.pending.length) return { action: 'raise', findings: pending.length ? pending : all, reasons: live.pendingReasons };
  if (!records.length || !all.length) return { action: 'none', findings: [] };
  // Ruled findings need an explicit operator re-arm; never spend a new same-head window.
  return { action: 'raise', findings: all };
}

/** Shared paused-referral report source. The ordinary ledger deliberately filters unattempted records and
 * operator-verdict send-backs; a later same-head pause still owes visibility of what the live gate holds.
 */
export function pausedReviewRulingNeeded(pr, { repo, readRuns = readReviewRunEvidence,
  cardReadable = ref => referralCardReadable(ref, REPO_ROOT) } = {}) {
  const live = liveReferralState(pr, { repo, pr: Number(pr.number), cardReadable });
  if (!live.records.some(r => r.head === pr.headRefOid)) return null;
  const decision = classifyPausedReview(pr, live);
  if (decision.action !== 'raise') return null;
  const runs = readRuns();
  if (!(pr.referralHold?.head === pr.headRefOid || decideReferralHold(pr, runs, { repo })
    || decideSameHeadHold(pr, runs, { repo }))) return null;
  return { head: pr.headRefOid, since: null,
    findings: decision.findings.map(f => ({ ...f, reason: 'paused-referral' })) };
}

/** Block-ruled referrals on the PR's CURRENT head, once EVERY referral on it is ruled (none pending): the PR is owed a
 * FIX, not a review. The same-head pause stops only a re-review of an unchanged head; the fix is what changes it
 * (live 2026-10-06, #4017: three `block` rulings, the pause refused every fix tick, so no push ever came).
 * Read exactly as the gate reads it. Any pending referral, or no block, answers `[]`. Never throws.
 */
export function blockRuledReferralsFor(pr, { repo, cardReadable = ref => referralCardReadable(ref, REPO_ROOT), ...options } = {}) {
  try {
    if (!sha(pr?.headRefOid)) return [];
    const live = liveReferralState(pr, { repo, pr: Number(pr.number), cardReadable });
    if (live.pending.length || !live.blockedFindings?.length) return [];
    return filterFixerReferrals(pr, live.blockedFindings.map(b => ({ key: b.key, findingId: b.findingId ?? null, finding: b.finding })),
      { repo, cardReadable, ...options });
  } catch { return []; }
}

/** Dispatch only: never mutate the gate or infer identity from similar finding prose.
 * Every current record holding a key must qualify; unknown/malformed evidence retains the dispatch.
 * Operator identity spans heads, but suppression requires human clearance of the current head.
 */
export function filterFixerReferrals(pr, findings, { repo,
  cardReadable = ref => referralCardReadable(ref, REPO_ROOT),
  safety = resolveReferralSafetySettings(), log = line => console.error(line),
} = {}) {
  if (safety.value.noFixerOnClearedRuled !== true || !findings?.length) return findings;
  try {
    const read = readReferralRecords(pr.comments, { head: pr.headRefOid });
    if (read.malformed || !repo || !sha(pr.headRefOid)) return findings;
    const operators = [];
    for (const comment of pr.comments ?? []) {
      const parsed = parseOperatorRulingComment(comment);
      if (parsed?.malformed) return findings;
      const r = parsed?.record;
      if (!r || r.actor.toLowerCase() === 'auto-policy') continue;
      for (const x of r.rulings) operators.push({ ...x, repo: r.repo, pr: r.pr, at: r.at });
    }
    const cleared = parseLatestHumanClearedSha(pr.comments) === pr.headRefOid;
    const kept = findings.filter(f => {
      const records = read.records.filter(r => r.repo === repo && r.pr === Number(pr.number)
        && r.head === pr.headRefOid && (!f.runId || f.runId === r.runId)
        && r.referrals.some(x => x.key === f.key));
      if (!records.length) return true;
      return !records.every(r => {
        const latest = operators.filter(o => sameRepo(o.repo, repo) && o.pr === Number(pr.number)
          && o.runId === r.runId && o.key === f.key)
          .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
        if (latest) return cleared && (latest.result === 'not-real' || (latest.result === 'card' && cardReadable(latest.card)));
        // Open reviewer/policy blocks and unruled findings still need a fixer, even on a cleared head.
        return false;
      });
    });
    if (kept.length < findings.length) log(`review.noFixerOnClearedRuled=true (source: ${safety.sources.noFixerOnClearedRuled}) — ${repo}#${pr.number}: suppressed ${findings.length - kept.length} fixer referral(s)`);
    return kept;
  } catch { return findings; }
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
    const blockRuledReferrals = blockRuledReferralsFor(pr, { repo });
    return { ...pr, blockRuledReferrals,
      referralHold: hold ?? (released ? null : decideSameHeadHold(pr, runs, { repo })) };
  });
}

/** Reserve before sending: an ambiguous transport failure must not create duplicate comments on every tick.
 * Known pre-send rate-limit failures can retry with bounded backoff; all other failures remain visible locally.
 */
/**
 * A no-verdict same-head hold past its last cool-down release is permanent (as on main) and must never be silent:
 * raise ONE needs-you event per repo+PR+head. A `pending` receipt is reserved (`wx`) before publishing and marked
 * `published` after, so repeated ticks and concurrent daemons do not emit twice; a failed publish drops the receipt so
 * the next tick retries, and a stale `pending` (crash, failed cleanup) or corrupt receipt is reclaimed. Never throws.
 */
/** A `pending` needs-you reservation older than this is treated as abandoned (crash or failed cleanup) and retried. */
export const NO_VERDICT_NEEDS_YOU_PENDING_STALE_MS = 10 * 60_000;
export function raiseNoVerdictNeedsYou({ repo, prNumber, hold, dir, now = Date.now(), log = line => console.error(line),
  publish }) {
  try {
    if (!sha(hold?.head)) return false;
    // The real operator feed is never written from a test run unless the test injects its own publisher.
    if (!publish) {
      if (isUnderTest(process.env)) return false;
      publish = item => publishAttention(item, { now });
    }
    const path = join(dir, `${hash([repo, Number(prNumber), hold.head, 'no-verdict-needs-you'])}.json`);
    mkdirSync(dir, { recursive: true });
    const receipt = state => JSON.stringify({ state, at: new Date(now).toISOString(), repo, pr: Number(prNumber), head: hold.head });
    let prior;
    try { prior = JSON.parse(readFileSync(path, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') prior = { state: 'corrupt' }; }
    if (prior?.state === 'published') return false;
    // A fresh `pending` reservation belongs to a publish in flight elsewhere. A stale or corrupt one (a crash between
    // reserve and publish, or a failed publish whose receipt could not be removed) is reclaimed: never silent forever.
    if (prior?.state === 'pending' && Number.isFinite(Date.parse(prior.at)) && now - Date.parse(prior.at) < NO_VERDICT_NEEDS_YOU_PENDING_STALE_MS) return false;
    try { writeFileSync(path, receipt('pending'), { flag: prior ? 'w' : 'wx' }); }
    catch (e) { if (e.code === 'EEXIST') return false; throw e; }
    try {
      publish({ repo, pr: Number(prNumber), head: hold.head, kind: 'review-no-verdict',
        reason: `review verdict never landed after ${hold.count} runs and ${hold.noVerdict?.releasesSpent ?? 0} cool-down retries; held until a push or re-arm`,
        pick: `https://github.com/${repo}/pull/${prNumber}` });
    } catch (e) {
      // Drop the reservation so the next tick retries; if that fails too, the pending receipt goes stale and is reclaimed.
      try { unlinkSync(path); } catch { /* reclaimed after NO_VERDICT_NEEDS_YOU_PENDING_STALE_MS */ }
      log(`${repo}#${prNumber} no-verdict needs-you could not be published: ${String(e?.message ?? e).split('\n')[0]}`);
      return false;
    }
    // If this write fails the receipt stays pending and the event may be raised again after the stale window: a rare
    // duplicate is preferred to silence (the feed's own open-key state also dedupes it).
    try { writeFileSync(path, receipt('published')); } catch { /* see above */ }
    log(`${repo}#${prNumber} NEEDS-YOU review-no-verdict head ${hold.head.slice(0, 9)}: ${hold.count} runs, `
      + `${hold.noVerdict?.releasesSpent ?? 0}/${hold.noVerdict?.releases ?? 0} cool-down retries spent `
      + `(reviewNoVerdictRetry.cooldownReleases source=${hold.noVerdict?.source ?? 'standard'}); permanent hold`);
    return true;
  } catch (e) {
    try { log(`${repo}#${prNumber} no-verdict needs-you failed: ${String(e?.message ?? e).split('\n')[0]}`); } catch { /* never throws */ }
    return false;
  }
}

export function notifyReferralHold({ repo, prNumber, hold, comments = [], pr,
  dir = join(dirname(resolveRunsDir()), 'review-referral-notices'), now = Date.now(),
  log = line => console.error(line), publishNeedsYou,
  post = body => execFileSyncThrottled('gh', ['pr', 'comment', String(prNumber), '--repo', repo, '--body', body],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }),
}) {
  if (hold.kind === 'same-head' && hold.noVerdict?.exhausted) {
    raiseNoVerdictNeedsYou({ repo, prNumber, hold, dir, now, log, publish: publishNeedsYou });
  }
  let paused;
  if (pr?.headRefOid === hold.head) {
    paused = classifyPausedReview(pr, liveReferralState(pr, { repo, pr: Number(prNumber),
      cardReadable: ref => referralCardReadable(ref, REPO_ROOT) }));
  }
  if (hold.kind === 'same-head' && (!paused || paused.action === 'none')) return;
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
    const need = paused?.action === 'raise' ? paused : rulingNeeded({ headRefOid: hold.head, comments }, { cardReadable: ref => referralCardReadable(ref, REPO_ROOT) });
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
