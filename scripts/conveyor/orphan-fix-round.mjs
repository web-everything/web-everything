import { assertCapability, repoProfile } from '../lib/repo-profile.mjs';
/**
 * @file scripts/conveyor/orphan-fix-round.mjs
 * @description The orphaned-fix-round guard: a `review:changes` PR whose last fix round ENDED with nobody owning it.
 *
 * LIVE INCIDENT 2026-10-10, web-everything/web-everything PR #4715 (`review:changes`, `review-round:1`):
 *   - 11:03Z `fix-4715` addressed the findings, the harness pushed the fix, the fixer posted its evidence comment and
 *     was killed (pid-dead 11:21:27Z) inside the one shell line that went on to run `rearm-review.mjs`. The claim was
 *     later released as "settled" — no re-arm, no fix-end comment.
 *   - 15:03Z the fix daemon dispatched "address review on PR #4715" again, but #4715 is stacked on #4708 and #4708's
 *     head had moved, so the prompt carried the RESTACK preamble ("the restack is the whole ask … never touch review
 *     labels … takes precedence over the original fix context"). The fixer only restacked; fix-end at 15:21Z said
 *     "nothing further is owed here".
 *   - From then on the fix daemon refused #4715 `stacked-above` (its bottom #4708 is cap-exhausted, so it will not
 *     move by automation), the review daemon had nothing to review (`review:changes`, not `review:pending`), and the
 *     PR sat with findings addressed but never handed back: `review:changes` with no owner.
 *
 * THE RULE THIS ENFORCES. Every fix round must end in exactly one owned state. Once per fix-daemon tick, for each open
 * `review:changes` PR with no live fix claim and no live dispatch claim, where no re-arm followed the latest changes
 * verdict and either an operator answered blocked referrals or a fix round began or ended AFTER that verdict:
 *   - an operator ruling clears every blocked referral on the unchanged head → RE-ARM even without a fix round,
 *     keeping any human hold: no fix is owed (live PR #5608);
 *   - the findings were addressed (a trusted fix-evidence comment after the verdict, and the head moved past the
 *     verdict's reviewed head) → RE-ARM it for review through `rearm-review.mjs` (the same sanctioned hand-back the
 *     fixer would have run);
 *   - otherwise → RE-DISPATCH one fixer through the ordinary fix dispatcher, for this PR only and without the stack
 *     restack preamble, so the fixer addresses the review (it is the same round: nothing here counts a round);
 *   - after {@link ORPHAN_REDISPATCH_CAP} guard re-dispatches since the verdict → ESCALATE: park it to a human
 *     (`review:human` added, `review:changes` kept), so a person owns it.
 * Every action posts one trusted marker comment ({@link ORPHAN_GUARD_MARKER}) and returns a log row.
 *
 * Kill switch `WE_ORPHAN_FIX_GUARD=0` (report only). PURE core: {@link planOrphanFixRound}. IO shell:
 * {@link runOrphanFixRoundPass}, run by the fix daemon inside its stuck-fixer reclaim step.
 */
import { execFileSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { openOperatorSendBacks } from '../lib/operator-send-backs.mjs';
import { parseOperatorRulingComment } from '../lib/jury-core.mjs';
import { headEverHumanCleared } from '../lib/review-escalation.mjs';
import { referralCardReadable } from '../lib/referral-card-readable.mjs';
import { openReferralFindings, isBlockedFinding, isAwaitingRuling } from '../operations/record-referral-ruling.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { FIX_BEGIN_MARKER, FIX_END_MARKER } from './fix-procedure.mjs';
import { FIX_END_INFRA_STALL_PREFIX } from '../lib/ruling-ledger.mjs';
import { REARM_COMMENT_MARKER } from './rearm-review.mjs';
import { CHANGES_VERDICT_PREFIX, latestChangesVerdict, rearmCoversVerdict } from '../review-set-label.mjs';
import { annotateLapsedStandDowns } from './stand-down.mjs';
import { countUnresolvedStandDowns } from './reconcile-core.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
export const ORPHAN_GUARD_MARKER = '🧭 conveyor orphan-guard';
/** The leading line of a review `changes` verdict (`we:scripts/review-set-label.mjs`). */
export { CHANGES_VERDICT_PREFIX };
/** The fixer's evidence comment has no fixed template; its heading always opens with this (live #4715). */
export const FIX_EVIDENCE_RE = /^#{0,6}\s*🔧 conveyor fix\b[^\n]*\bevidence\b/i;
/** How long a round must sit unowned after its last event before the guard acts, so the ordinary dispatcher and a
 *  fixer's own hand-back always get the first chance. */
export const DEFAULT_ORPHAN_GRACE_MS = 15 * 60_000;
export const ORPHAN_REDISPATCH_CAP = 2;
/** Consecutive evidence-less fix rounds on one open operator send-back before the guard stops re-dispatching. */
export const EVIDENCELESS_ROUND_CAP = 2;

export function orphanGuardEnabled(env = process.env) { return String(env?.WE_ORPHAN_FIX_GUARD ?? '').trim() !== '0'; }

const labelNames = (labels) => (Array.isArray(labels) ? labels : []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
const lead = (c) => String(typeof c === 'string' ? c : c?.body ?? '').trimStart();
const atMs = (c) => { const t = Date.parse(c?.createdAt ?? c?.created_at ?? ''); return Number.isFinite(t) ? t : null; };

/** The head sha a changes verdict reviewed (`Net basis: \`<base>..<head>\``), or null. */
export function verdictReviewedHead(body) {
  const m = String(body ?? '').match(/Net basis: `[0-9a-f]+\.\.([0-9a-f]{7,40})`/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Decide what one PR is owed. PURE.
 * @param {{pr:{number:number, labels?:Array, headRefOid?:string, isDraft?:boolean, comments?:Array}, owned?:boolean,
 *   nowMs:number, graceMs?:number, cap?:number, repo?:string, cardReadable?:Function}} o
 * Stable none decisions may suppress budget holds for the same head until expiry or a fix dispatch.
 * @returns {{decision:'none'|'rearm'|'redispatch'|'escalate', reason:string, stable?:boolean, verdictAt?:string, roundAt?:string, rulingAt?:string}}
 */
export function planOrphanFixRound({ pr, owned = false, nowMs, graceMs = DEFAULT_ORPHAN_GRACE_MS, cap = ORPHAN_REDISPATCH_CAP,
  repo = CONSTELLATION_REPOS.we.slug, cardReadable = () => false }) {
  const none = (reason, stable = false) => ({ decision: 'none', reason, ...(stable ? { stable: true } : {}) });
  const labels = labelNames(pr?.labels);
  if (!labels.includes('review:changes')) return none('not bounced (no review:changes)', true);
  if (headEverHumanCleared(pr?.comments, pr?.headRefOid)) return none('human-cleared head — final', true);
  if (pr?.isDraft) return none('draft — the draft-promotion path owns it');
  if (owned) return none('owned — a live fix or dispatch claim holds it');
  const trusted = (Array.isArray(pr?.comments) ? pr.comments : []).filter((c) => isTrustedMarkerAuthor(c) && atMs(c) != null);
  const verdict = latestChangesVerdict(trusted);
  if (!verdict) return none('no trusted changes verdict on the thread', true);
  const vAt = atMs(verdict);
  // GitHub timestamps have second precision; the thread also orders comments within that second.
  const vIndex = trusted.indexOf(verdict);
  const after = trusted.slice(vIndex + 1);
  if (after.some((c) => lead(c).startsWith(REARM_COMMENT_MARKER) && rearmCoversVerdict(c.body, verdict))) {
    return none('already re-armed after the latest verdict');
  }
  if (String(verdict.body).includes('### Blocked referral findings')) {
    const reviewed = String(verdict.body).match(/on head `([0-9a-f]{7,40})`/i)?.[1]?.toLowerCase() ?? verdictReviewedHead(verdict.body);
    const head = String(pr.headRefOid ?? '').toLowerCase();
    // The sanctioned writer posts the operator's assertion through automation credentials.
    // Use the referral gate's parser to validate both that provenance and the operator assertion.
    const ruling = after.filter((c) => lead(c).startsWith('## Operator ruling on mandatory referrals') && parseOperatorRulingComment(c)?.record)
      .at(-1);
    try {
      // Validate even without a valid ruling: malformed-only history must not reach fix-round recovery.
      const gate = openReferralFindings({ comments: pr.comments, repo, pr: pr.number, head: pr.headRefOid,
        body: pr.body ?? '', createdAt: pr.createdAt ?? '', cardReadable });
      if (gate.malformed || gate.protectionMalformed) return none('malformed referral history — it stays with a person');
      if (reviewed && head && (head.startsWith(reviewed) || reviewed.startsWith(head)) && ruling) {
        const { open, ruled } = gate;
        // A disputed referral history, or any gate-level pending/blocked hold, is not a settled ruling.
        const settled = !gate.pending?.length && !gate.blocked?.length && !gate.disputed?.length;
        const ctx = { verdictAt: new Date(vAt).toISOString(), rulingAt: new Date(atMs(ruling)).toISOString() };
        if (!open.length && ruled.length && settled && countUnresolvedStandDowns(annotateLapsedStandDowns(pr)?.comments) > 0) {
          return { ...none('stood down — the stand-down answer owns it'), ...ctx };
        }
        if (!open.length && ruled.length && settled) return { decision: 'rearm', ...ctx,
          reason: `operator ruling ${ctx.rulingAt} answered every referral finding the send-back blocked on head ${head.slice(0, 9)} (card/not-real) — no fix is owed, so the review is re-armed; review:human, if present, stays` };
        if (open.length || !settled) return { ...none(`operator ruling ${ctx.rulingAt} is partial: ${open.length} referral finding(s) still open on head ${head.slice(0, 9)} (${open.filter(isBlockedFinding).length} blocked, ${open.filter(isAwaitingRuling).length} awaiting a ruling or re-check) — it stays with a person`), ...ctx };
      }
    } catch {
      return none('malformed referral history — it stays with a person');
    }
  }
  const roundEvents = after.filter((c) => lead(c).startsWith(FIX_END_MARKER) || lead(c).startsWith(FIX_BEGIN_MARKER));
  if (!roundEvents.length) return none('no fix round since the latest verdict — the ordinary fix dispatch owns it', true);
  const lastRoundMs = Math.max(...roundEvents.map(atMs));
  const ctx = { verdictAt: new Date(vAt).toISOString(), roundAt: new Date(lastRoundMs).toISOString() };
  if (nowMs - lastRoundMs < graceMs) return { ...none(`last fix-round event ${ctx.roundAt} is inside the ${Math.round(graceMs / 60000)}-min grace`), ...ctx };
  if (countUnresolvedStandDowns(annotateLapsedStandDowns(pr)?.comments) > 0) return { ...none('stood down — the stand-down answer owns it'), ...ctx };
  if (labels.includes('review:human')) return { ...none('review:human — a person owns it'), ...ctx };
  const reviewed = verdictReviewedHead(verdict.body);
  const head = String(pr?.headRefOid ?? '').toLowerCase();
  const headMoved = Boolean(head) && (!reviewed || !(head.startsWith(reviewed) || reviewed.startsWith(head)));
  const evidence = after.find((c) => FIX_EVIDENCE_RE.test(lead(c)));
  // Backstop (#6732): two consecutive fix rounds ended without evidence on the same still-open operator send-back.
  // A third blind fixer repeats the loop; a person decides instead.
  const openSendBack = pr?.comments ? openOperatorSendBacks(pr)[0] : null;
  if (openSendBack) {
    const sentAt = Date.parse(openSendBack.at);
    // An infra-stalled exit (`blocked-on-infra` / `blocked-on-permission`) is not a fixer miss: it keeps the infra
    // retry path and never spends this cap (`fix-procedure.mjs#FIX_END_INFRA_STALL_MARK`, same read as the ladder).
    const infraEnded = (c) => String(c?.body ?? '').includes(FIX_END_INFRA_STALL_PREFIX);
    const endedSince = (Array.isArray(pr.comments) ? pr.comments : []).filter((c) => isTrustedMarkerAuthor(c) && lead(c).startsWith(FIX_END_MARKER) && !infraEnded(c) && atMs(c) > sentAt).length;
    if (endedSince >= EVIDENCELESS_ROUND_CAP) {
      return { decision: 'escalate', ...ctx,
        reason: `NEEDS-YOU: ${endedSince} fix rounds ended without fix evidence on operator send-back ${openSendBack.id} — a person must take it` };
    }
  }
  // Generic fix evidence never answers an open operator send-back: only `## Fix evidence` naming it does (the reader).
  if (evidence && headMoved && !openSendBack) {
    return { decision: 'rearm', ...ctx,
      reason: `fix round ended ${ctx.roundAt} with the findings addressed (evidence ${evidence.createdAt}, head moved past the reviewed head) but never re-armed` };
  }
  const guardRedispatches = after.filter((c) => lead(c).startsWith(ORPHAN_GUARD_MARKER) && /re-dispatched/.test(lead(c).split('\n')[0])).length;
  if (guardRedispatches >= cap) {
    return { decision: 'escalate', ...ctx,
      reason: `${guardRedispatches} guard re-dispatch(es) since the verdict still left the round unowned (cap ${cap}) — a person must take it` };
  }
  return { decision: 'redispatch', ...ctx,
    reason: `fix round ended ${ctx.roundAt} without addressing the review (${evidence ? 'evidence but the head never moved' : 'no fix evidence'}) and nobody owns it` };
}

export function buildOrphanGuardComment({ decision, reason, prNumber }) {
  const head = decision === 'redispatch' ? 're-dispatched a fixer' : decision === 'rearm' ? 're-armed for review' : 'escalated to a person';
  return [
    `${ORPHAN_GUARD_MARKER} — ${head}`,
    '',
    `PR #${prNumber}: ${reason}.`,
    '',
    'Every fix round must end owned: re-armed for review, re-dispatched, or with a person. This one ended with',
    '`review:changes` and no owner, so the fix daemon acted. It counts as the same review round.',
  ].join('\n');
}

// ── IO shell ────────────────────────────────────────────────────────────────────────────────────────────────────────

const ghOpts = () => ({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
export function defaultListBounced(slug, { exec = execFileSync, deadlineAt = Infinity } = {}) {
  // Filtered here, not with `--label` (search-backed, rate-limited on its own budget — #no-label-search).
  const perPage = 100, bounced = [];
  const opts = ghOpts();
  // Bound the whole listing by time, not repository size. A full page always needs another read,
  // including past 500 PRs. Callers without a tick deadline share one child-timeout budget.
  const listingDeadlineAt = Math.min(deadlineAt, Date.now() + opts.timeout);
  for (let page = 1; ; page++) {
    const remainingMs = listingDeadlineAt - Date.now();
    if (page > 1 && remainingMs <= 0) {
      const reason = 'orphan-guard: listing deadline reached; older PRs not scanned this pass';
      console.error(reason);
      throw new Error(`${reason}; fix dispatch held until a complete listing succeeds (retry with more listing time)`);
    }
    // Partial discovery cannot certify the repo: let the pass emit a repo-level error so the daemon holds fixes.
    const out = exec('gh', ['api', `repos/${slug}/pulls?state=open&sort=created&direction=desc&per_page=${perPage}&page=${page}`],
      { ...opts, timeout: Math.max(1, Math.ceil(remainingMs)) });
    const prs = JSON.parse(String(out));
    if (!Array.isArray(prs)) throw new Error('orphan-guard: invalid pulls listing (expected an array)');
    bounced.push(...prs.filter(p => labelNames(p.labels).includes('review:changes')).map(p => ({
      number: p.number, labels: p.labels, headRefOid: p.head.sha, isDraft: p.draft, body: p.body, createdAt: p.created_at,
    })));
    if (prs.length < perPage) return bounced;
  }
}

async function defaultReadComments(number, slug) {
  const { readCompletePrComments } = await import('./pr-comments-complete.mjs');
  return readCompletePrComments(number, { repo: slug });
}

async function defaultOwned(repoKey, number) {
  const { listLiveFixClaims } = await import('./fix-procedure.mjs');
  const { listFixDispatchClaims } = await import('./fix-claim-store.mjs');
  const live = listLiveFixClaims({ repo: repoKey }).some((c) => Number(c.meta?.pr) === Number(number));
  if (live) return true;
  return listFixDispatchClaims().some((c) => c.meta?.repo === repoKey && Number(c.meta?.pr) === Number(number));
}

export function defaultRearm({ slug, pr, head, exec = execFileSync }) {
  try {
    exec('node', [resolve(ROOT, 'scripts', 'conveyor', 'rearm-review.mjs'), String(pr), `--repo=${slug}`,
      '--actor=conveyor orphan-guard', ...(head ? [`--expect-head=${head}`] : [])], { ...ghOpts(), cwd: ROOT });
  } catch (error) {
    const sanitize = (value) => stripVTControlCharacters(String(value ?? '')).split(/\r?\n/)
      .map((line) => line.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()).filter(Boolean);
    const stderr = sanitize(error.stderr).join('; ').slice(0, 300);
    let stdout = String(error.stdout ?? '');
    try {
      const parsed = JSON.parse(stdout);
      if (typeof parsed?.reason === 'string') stdout = parsed.reason;
      else if (typeof parsed?.error === 'string') stdout = parsed.error;
    } catch { /* Non-JSON output uses its first non-empty line. */ }
    stdout = (sanitize(stdout)[0] ?? '').slice(0, 300);
    const detail = [stderr, stdout].filter(Boolean).join('; ');
    throw new Error(`orphan-guard re-arm failed: ${detail || 'child failed without stderr or stdout'}`, { cause: error });
  }
  return { ok: true };
}

/** One fixer for exactly this PR, through the ordinary dispatcher (its claims, caps and brief), without the stack
 *  restack preamble that consumed #4715's review round. */
export async function defaultRedispatch({ slug, pr, reconcile }) {
  const { runReconcileFixDispatch } = await import('./reconcile-fix-dispatch.mjs');
  const { runReconcilePass } = await import('./reconcile-pass.mjs');
  const { applyNetScopeToReconcile } = await import('./net-scope.mjs');
  const only = (rows) => (rows ?? []).filter((r) => Number(r.prNumber ?? r.pr) === Number(pr));
  const result = runReconcileFixDispatch({
    repo: slug,
    // This targeted redispatch must not answer stand-downs on other PRs read by the planner.
    allowStandDownAutoProceed: false,
    reconcile: (opts) => { const r = (reconcile ?? runReconcilePass)(opts); return { ...r, dispatch: only(r.dispatch).filter((d) => d.kind === 'fix'), refusals: only(r.refusals) }; },
    netScope: applyNetScopeToReconcile,
    prStack: null,
  });
  const dispatched = (result.dispatched ?? []).filter((d) => Number(d.pr ?? d.prNumber) === Number(pr));
  const why = [...(result.refusals ?? []), ...(result.reconcileRefusalDetails ?? [])].map((r) => `${r.kind}: ${r.why ?? ''}`).join('; ');
  return dispatched.length ? { ok: true } : { ok: false, why: why || 'the dispatcher planned no fix for it' };
}

export function defaultEscalate({ slug, pr, labels, exec = execFileSync }) {
  return import('../lib/review-escalation.mjs').then(({ decideParkToHuman }) => {
    const d = decideParkToHuman({ currentLabels: labels, keepHumanClearance: true });
    const args = ['pr', 'edit', String(pr), '--repo', slug, '--add-label', d.addLabel];
    for (const l of d.removeLabels) args.push('--remove-label', l);
    exec('gh', args, ghOpts());
    return { ok: true };
  });
}

export function defaultPostComment({ slug, pr, body, exec = execFileSync }) {
  exec('gh', ['pr', 'comment', String(pr), '--repo', slug, '--body-file', '-'], { ...ghOpts(), input: body, stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * ONE guard pass over every constellation repo. Never throws; one PR's failure never stops the rest.
 * Optional `settled` retains stable none verdicts between passes, keyed by `${slug}#${pr}` → {head, at}.
 * `cursor` is the per-repo map a previous pass returned as `repoCursors` (or a legacy single `{repo, pr}`).
 * @returns {Promise<{enabled:boolean, rows:Array<object>, handled:number, deferred:Array<object>, deferredSettled:Array<object>, newlySettled:Array<object>, nextCursor:object|null, repoCursors:object|null}>}
 */
export async function runOrphanFixRoundPass({
  env = process.env,
  nowMs = Date.now(),
  deadlineAt = Infinity,
  shouldYield,
  now = Date.now,
  cursor = null,
  settled,
  settledTtlMs = 6 * 60 * 60 * 1000,
  reconcile,
  repos = Object.entries(CONSTELLATION_REPOS).map(([key, r]) => ({ key, slug: r.slug })),
  listBounced = (slug) => defaultListBounced(slug, { deadlineAt }),
  readComments = defaultReadComments,
  isOwned = defaultOwned,
  rearm = defaultRearm,
  redispatch = defaultRedispatch,
  escalate = defaultEscalate,
  postComment = defaultPostComment,
  graceMs = DEFAULT_ORPHAN_GRACE_MS,
  resolveProfile = repoProfile,
  cardReadable = (ref) => referralCardReadable(ref, ROOT),
} = {}) {
  const enabled = orphanGuardEnabled(env);
  const rows = [], deferred = [], deferredSettled = [], newlySettled = [];
  let handled = 0, redispatched = false, deferring = false;
  // Each repo keeps its OWN resume point (PR #7330): a pass that reaches only some repos must not overwrite the
  // deferred progress of a repo it never listed. A legacy single `{repo, pr}` cursor migrates to one entry.
  const repoCursors = normalizeOrphanCursors(cursor);
  const resumeAt = (key, slug) => repoCursors[slug] ?? repoCursors[key];
  const listed = [], head = [], wrapped = [];
  for (const { key, slug } of repos) {
    let prs;
    try { prs = listBounced(slug); } catch (e) { rows.push({ repo: slug, decision: 'error', reason: `listing failed: ${String(e?.message ?? e).split('\n')[0]}` }); continue; }
    listed.push({ key, slug });
    // Repos run in the order the caller yields them (the daemon rotates that order fairly); each repo resumes at
    // its cursor, and the PRs before it run after every repo's resumed part so one large repo never starves the rest.
    const at = resumeAt(key, slug);
    const own = [...(prs ?? [])].sort((a, b) => a.number - b.number);
    for (const p of own) (at != null && p.number < at ? wrapped : head).push({ key, slug, p });
  }
  const uncached = [], cachedPrs = [];
  for (const entry of [...head, ...wrapped]) {
    const { slug, p } = entry;
    const cacheKey = `${slug}#${p.number}`;
    const cached = settled?.get(cacheKey);
    const age = nowMs - cached?.at;
    if (typeof p.headRefOid === 'string' && p.headRefOid.length > 0
      && cached?.head === p.headRefOid && age >= 0 && age < settledTtlMs) {
      cachedPrs.push({ ...entry, cachedAt: cached.at });
    } else {
      settled?.delete(cacheKey);
      uncached.push(entry);
    }
  }
  // Settlement changes scheduling and budget holds only: comments can change without a head move.
  // Refresh the oldest cached evidence first, after all uncached work (including wrapped PRs).
  const ordered = [...uncached, ...cachedPrs.sort((a, b) => a.cachedAt - b.cachedAt)];
  for (const { key, slug, p, cachedAt } of ordered) {
    const cacheKey = `${slug}#${p.number}`;
    if (deferring || (handled > 0 && (now() >= deadlineAt || shouldYield?.()))) {
      deferring = true;
      (cachedAt === undefined ? deferred : deferredSettled).push({ repo: slug, pr: p.number });
      continue;
    }
    settled?.delete(cacheKey);
    handled += 1;
    const row = { repo: slug, pr: p.number };
    try {
      const owned = await isOwned(key, p.number);
      const comments = owned ? [] : await readComments(p.number, slug);
      const plan = planOrphanFixRound({ pr: { ...p, comments }, owned, nowMs, graceMs, repo: slug, cardReadable });
      if (plan.decision === 'none') {
        if (settled && plan.stable && typeof p.headRefOid === 'string' && p.headRefOid.length > 0) {
          settled.set(cacheKey, { head: p.headRefOid, at: nowMs });
          newlySettled.push({ repo: slug, pr: p.number });
        }
        continue;
      }
      if (plan.decision === 'redispatch' && redispatched) {
        deferring = true;
        deferred.push({ repo: slug, pr: p.number });
        continue;
      }
      Object.assign(row, { decision: plan.decision, reason: plan.reason });
      rows.push(row);
      if (!enabled) { row.result = 'report-only (WE_ORPHAN_FIX_GUARD=0)'; continue; }
      if (plan.decision === 'redispatch') {
        const refusal = assertCapability(slug, 'fix', { resolveProfile });
        if (refusal) { row.result = `not-done: ${refusal.why}`; continue; }
        redispatched = true;
      }
      const labels = labelNames(p.labels);
      const r = plan.decision === 'rearm' ? await rearm({ slug, pr: p.number, head: p.headRefOid })
        : plan.decision === 'redispatch' ? await redispatch({ slug, pr: p.number, reconcile })
          : await escalate({ slug, pr: p.number, labels });
      if (!r?.ok) { row.result = `not-done: ${r?.why ?? '?'}`; continue; }
      row.result = plan.decision === 'rearm' ? 're-armed' : plan.decision === 'redispatch' ? 're-dispatched' : 'escalated';
      try { postComment({ slug, pr: p.number, body: buildOrphanGuardComment({ decision: plan.decision, reason: plan.reason, prNumber: p.number }) }); }
      catch (e) { row.result += ` (marker comment failed: ${String(e?.message ?? e).split('\n')[0]})`; }
    } catch (e) {
      if (!rows.includes(row)) rows.push(row);
      row.decision ??= 'error';
      row.result = `error: ${String(e?.message ?? e).split('\n')[0]}`;
    }
  }
  // A listed repo's cursor becomes its first deferred PR (or clears); an unlisted repo's cursor is kept untouched.
  const nextRepoCursors = { ...repoCursors };
  for (const { key, slug } of listed) { delete nextRepoCursors[key]; delete nextRepoCursors[slug]; }
  for (const d of deferred) nextRepoCursors[d.repo] ??= d.pr;
  return { enabled, rows, handled, deferred, deferredSettled, newlySettled, nextCursor: deferred[0] ?? null,
    repoCursors: Object.keys(nextRepoCursors).length ? nextRepoCursors : null };
}

/** Per-repo orphan cursors `{ <repo>: <pr> }`; accepts the legacy single `{ repo, pr }` cursor. Invalid → none. */
export function normalizeOrphanCursors(cursor) {
  if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return {};
  const valid = ([repo, pr]) => typeof repo === 'string' && repo.length > 0 && Number.isSafeInteger(pr) && pr > 0;
  const keys = Object.keys(cursor);
  if (keys.length === 2 && keys.includes('repo') && keys.includes('pr')) {
    return valid([cursor.repo, cursor.pr]) ? { [cursor.repo]: cursor.pr } : {};
  }
  return Object.fromEntries(Object.entries(cursor).filter(valid));
}

export function formatOrphanFixRoundLines(result) {
  return (result?.rows ?? []).map((r) => `orphan-fix-round: ${r.repo ?? '?'} PR #${r.pr ?? '?'} — ${r.decision}${r.result ? ` → ${r.result}` : ''} (${r.reason ?? ''})`);
}
