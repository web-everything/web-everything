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
 * `review:changes` PR with no live fix claim and no live dispatch claim, where a fix round began or ended AFTER the
 * latest changes verdict and no re-arm followed that verdict:
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
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { FIX_BEGIN_MARKER, FIX_END_MARKER } from './fix-procedure.mjs';
import { REARM_COMMENT_MARKER } from './rearm-review.mjs';
import { countUnresolvedStandDowns } from './reconcile-core.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
export const ORPHAN_GUARD_MARKER = '🧭 conveyor orphan-guard';
/** The leading line of a review `changes` verdict (`we:scripts/review-set-label.mjs`). */
export const CHANGES_VERDICT_PREFIX = '🔁 review — changes requested';
/** The fixer's evidence comment has no fixed template; its heading always opens with this (live #4715). */
export const FIX_EVIDENCE_RE = /^#{0,6}\s*🔧 conveyor fix\b[^\n]*\bevidence\b/i;
/** How long a round must sit unowned after its last event before the guard acts, so the ordinary dispatcher and a
 *  fixer's own hand-back always get the first chance. */
export const DEFAULT_ORPHAN_GRACE_MS = 15 * 60_000;
export const ORPHAN_REDISPATCH_CAP = 2;

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
 *   nowMs:number, graceMs?:number, cap?:number}} o
 * @returns {{decision:'none'|'rearm'|'redispatch'|'escalate', reason:string, verdictAt?:string, roundAt?:string}}
 */
export function planOrphanFixRound({ pr, owned = false, nowMs, graceMs = DEFAULT_ORPHAN_GRACE_MS, cap = ORPHAN_REDISPATCH_CAP }) {
  const none = (reason) => ({ decision: 'none', reason });
  const labels = labelNames(pr?.labels);
  if (!labels.includes('review:changes')) return none('not bounced (no review:changes)');
  if (pr?.isDraft) return none('draft — the draft-promotion path owns it');
  if (owned) return none('owned — a live fix or dispatch claim holds it');
  const trusted = (Array.isArray(pr?.comments) ? pr.comments : []).filter((c) => isTrustedMarkerAuthor(c) && atMs(c) != null);
  let verdict = null;
  for (const c of trusted) if (lead(c).startsWith(CHANGES_VERDICT_PREFIX) && (!verdict || atMs(c) >= atMs(verdict))) verdict = c;
  if (!verdict) return none('no trusted changes verdict on the thread');
  const vAt = atMs(verdict);
  const after = trusted.filter((c) => atMs(c) > vAt);
  if (after.some((c) => lead(c).startsWith(REARM_COMMENT_MARKER))) return none('already re-armed after the latest verdict');
  const roundEvents = after.filter((c) => lead(c).startsWith(FIX_END_MARKER) || lead(c).startsWith(FIX_BEGIN_MARKER));
  if (!roundEvents.length) return none('no fix round since the latest verdict — the ordinary fix dispatch owns it');
  const lastRoundMs = Math.max(...roundEvents.map(atMs));
  const ctx = { verdictAt: new Date(vAt).toISOString(), roundAt: new Date(lastRoundMs).toISOString() };
  if (nowMs - lastRoundMs < graceMs) return { ...none(`last fix-round event ${ctx.roundAt} is inside the ${Math.round(graceMs / 60000)}-min grace`), ...ctx };
  if (countUnresolvedStandDowns(pr?.comments) > 0) return { ...none('stood down — the stand-down answer owns it'), ...ctx };
  if (labels.includes('review:human')) return { ...none('review:human — a person owns it'), ...ctx };
  const reviewed = verdictReviewedHead(verdict.body);
  const head = String(pr?.headRefOid ?? '').toLowerCase();
  const headMoved = Boolean(head) && (!reviewed || !(head.startsWith(reviewed) || reviewed.startsWith(head)));
  const evidence = after.find((c) => FIX_EVIDENCE_RE.test(lead(c)));
  if (evidence && headMoved) {
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

export function defaultListBounced(slug, { exec = execFileSync } = {}) {
  // Filtered here, not with `--label` (search-backed, rate-limited on its own budget — #no-label-search).
  const out = exec('gh', ['pr', 'list', '--repo', slug, '--state', 'open', '--limit', '200',
    '--json', 'number,labels,headRefOid,isDraft'], ghOpts());
  return JSON.parse(String(out || '[]')).filter((p) => labelNames(p.labels).includes('review:changes'));
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
  exec('node', [resolve(ROOT, 'scripts', 'conveyor', 'rearm-review.mjs'), String(pr), `--repo=${slug}`,
    '--actor=conveyor orphan-guard', ...(head ? [`--expect-head=${head}`] : [])], { ...ghOpts(), cwd: ROOT });
  return { ok: true };
}

/** One fixer for exactly this PR, through the ordinary dispatcher (its claims, caps and brief), without the stack
 *  restack preamble that consumed #4715's review round. */
export async function defaultRedispatch({ slug, pr }) {
  const { runReconcileFixDispatch } = await import('./reconcile-fix-dispatch.mjs');
  const { runReconcilePass } = await import('./reconcile-pass.mjs');
  const { applyNetScopeToReconcile } = await import('./net-scope.mjs');
  const only = (rows) => (rows ?? []).filter((r) => Number(r.prNumber ?? r.pr) === Number(pr));
  const result = runReconcileFixDispatch({
    repo: slug,
    reconcile: (opts) => { const r = runReconcilePass(opts); return { ...r, dispatch: only(r.dispatch).filter((d) => d.kind === 'fix'), refusals: only(r.refusals) }; },
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
 * @returns {Promise<{enabled:boolean, rows:Array<object>}>}
 */
export async function runOrphanFixRoundPass({
  env = process.env,
  nowMs = Date.now(),
  repos = Object.entries(CONSTELLATION_REPOS).map(([key, r]) => ({ key, slug: r.slug })),
  listBounced = (slug) => defaultListBounced(slug),
  readComments = defaultReadComments,
  isOwned = defaultOwned,
  rearm = defaultRearm,
  redispatch = defaultRedispatch,
  escalate = defaultEscalate,
  postComment = defaultPostComment,
  graceMs = DEFAULT_ORPHAN_GRACE_MS,
} = {}) {
  const enabled = orphanGuardEnabled(env);
  const rows = [];
  for (const { key, slug } of repos) {
    let prs;
    try { prs = listBounced(slug); } catch (e) { rows.push({ repo: slug, decision: 'error', reason: `listing failed: ${String(e?.message ?? e).split('\n')[0]}` }); continue; }
    for (const p of prs ?? []) {
      const row = { repo: slug, pr: p.number };
      try {
        const owned = await isOwned(key, p.number);
        const comments = owned ? [] : await readComments(p.number, slug);
        const plan = planOrphanFixRound({ pr: { ...p, comments }, owned, nowMs, graceMs });
        if (plan.decision === 'none') continue;
        Object.assign(row, { decision: plan.decision, reason: plan.reason });
        rows.push(row);
        if (!enabled) { row.result = 'report-only (WE_ORPHAN_FIX_GUARD=0)'; continue; }
        const labels = labelNames(p.labels);
        const r = plan.decision === 'rearm' ? await rearm({ slug, pr: p.number, head: p.headRefOid })
          : plan.decision === 'redispatch' ? await redispatch({ slug, pr: p.number })
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
  }
  return { enabled, rows };
}

export function formatOrphanFixRoundLines(result) {
  return (result?.rows ?? []).map((r) => `orphan-fix-round: ${r.repo ?? '?'} PR #${r.pr ?? '?'} — ${r.decision}${r.result ? ` → ${r.result}` : ''} (${r.reason ?? ''})`);
}
