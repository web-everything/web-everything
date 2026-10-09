/**
 * @file scripts/conveyor/draft-promotion-loop.mjs — the fast promotion step (draft-first PRs). Runs from the fix
 * daemon's await-verify child (`await-verify-loop.mjs#main`), on its own interval, so promoting a green draft never
 * waits on the fix daemon's tick (which can starve behind self-sync rebuilds — live 2026-10-09, #4567/#4563/#4535,
 * see `draft-promotion-rule.mjs`). The tick's own promote half (`promote-draft-pr-dispatch.mjs`) stays: `gh pr ready`
 * is idempotent, so whichever edge reaches a draft first wins.
 *
 * One step, per constellation repo: ONE `gh pr list --draft` read → {@link isPromotionCandidate} → for each candidate
 * a fresh required-check read for its EXACT head sha → {@link isDraftOwedPromotion} → ONE fresh `gh pr view` of the PR
 * (labels, comments, head, fork flag — it can all change between the list and the write) → the SAME classifier the
 * tick uses, `planReconcile`, run over just that PR (live fix claim and the live-session listing attached exactly as
 * the reconcile pass attaches them) → promote only when the tick would plan `promote-draft` → `gh pr ready` → clear
 * the stale `review-status:awaiting-*` label.
 * Why the classifier and not a second hand-written rule (review of PR #4575): the tick refuses a promotion for a live
 * fix claim, a stand-down, a close-superseded ruling, a concurrent-author pause, a load-flake hold and a live
 * session BEFORE it reaches its `promote-draft` branch; a rule that re-derives only "green and not withdrawn"
 * un-drafted PRs under repair. No full reconcile pass (no all-PR snapshot, no enrichment that needs git), no lane,
 * no session. Every effect is injectable.
 *
 * ONE deliberate difference, towards caution: a draft labelled `merge-status:conflicting` is left to the tick. The
 * tick's `already-landed` refusal needs git reads (blob identity against `main`'s history) that a fast step must not
 * pay; a conflicting green draft is rare and the tick still promotes it when it is not already landed.
 */
import { CONSTELLATION_REPOS, repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { runGhSync } from '../lib/gh-throttle.mjs';
import { createDraftPromoteProvider } from '../lib/draft-promote-provider.mjs';
import { getRequiredStatusChecks } from '../lib/required-status-checks.mjs';
import { applyReviewStatus } from './review-status-tag.mjs';
import { defaultReadHeadCheckState } from '../operations/promote-draft-pr-dispatch.mjs';
import { planReconcile } from './reconcile-core.mjs';
import { defaultReadAgents, enrichAgents } from './reconcile-pass.mjs';
import { readLiveFixClaim } from './fix-procedure.mjs';
import { CONFLICT_LABEL } from './conflict-label.mjs';
import { LIST_COMMENTS_PAGE_SIZE, readCompletePrComments } from './pr-comments-complete.mjs';
import {
  isDraftOwedPromotion, isPromotionCandidate, promotionStepDue, resolveDraftPromotionSettings,
} from './draft-promotion-rule.mjs';

export const DRAFT_LIST_FIELDS = 'number,state,isDraft,headRefName,headRefOid,labels,isCrossRepository';
/** The one fresh read per candidate: everything the tick's pre-`promote-draft` refusals and the rule decide on. */
export const PR_VIEW_FIELDS = 'number,state,isDraft,headRefName,headRefOid,baseRefName,labels,comments,body,statusCheckRollup,mergeStateStatus,isCrossRepository';

/** The one list read per repo: open drafts only. */
export function defaultListDrafts({ repoSlug, runGh = runGhSync } = {}) {
  const raw = runGh(['pr', 'list', '--repo', repoSlug, '--state', 'open', '--draft', '--limit', '100', '--json', DRAFT_LIST_FIELDS], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], throttle: { op: 'pr-list-drafts', repo: repoSlug },
  });
  const rows = JSON.parse(raw);
  if (!Array.isArray(rows)) throw new Error('draft list is not an array');
  return rows;
}

const oneLine = (e) => String(e?.message ?? e).split('\n')[0];
/** Rows carry text derived from comments and the claim store; the log line is one line of bounded length. */
const logText = (s) => String(s ?? '').replace(/\s+/g, ' ').slice(0, 300);
/** `gh pr view --json statusCheckRollup` returns at most this many contexts. */
const ROLLUP_CAP = 100;

/** The fresh per-candidate read. A thread that reaches the list page size is re-read complete (a truncated thread can hide the marker that matters); that read throwing refuses the candidate. */
export function defaultReadPrView({ repoSlug, prNumber, runGh = runGhSync, readComments = readCompletePrComments } = {}) {
  const raw = runGh(['pr', 'view', String(prNumber), '--repo', repoSlug, '--json', PR_VIEW_FIELDS], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], throttle: { op: 'pr-view-promote', repo: repoSlug },
  });
  const view = JSON.parse(raw);
  if (!view || typeof view !== 'object' || Array.isArray(view)) throw new Error('pr view is not an object');
  if (!Array.isArray(view.labels)) throw new Error('pr view has no label list');
  if (!Array.isArray(view.comments)) throw new Error('pr view has no comment list');
  if (typeof view.isCrossRepository !== 'boolean') throw new Error('pr view has no isCrossRepository flag');
  if (view.comments.length >= LIST_COMMENTS_PAGE_SIZE) {
    const complete = readComments(prNumber, { repo: repoSlug });
    if (!Array.isArray(complete)) throw new Error('complete comments read returned no array');
    return { ...view, comments: complete };
  }
  return view;
}

/**
 * One promotion step over every repo. Never throws: a failed read or write is a row, and the next step retries.
 * @returns {{rows:Array<{repo:string, pr:number|null, action:'promoted'|'skip'|'error', why:string}>}}
 */
export function runDraftPromotionStep({
  repos = Object.values(CONSTELLATION_REPOS).map((r) => r.slug),
  listDrafts = defaultListDrafts,
  readHeadCheckState = defaultReadHeadCheckState,
  readPrView = defaultReadPrView,
  readAgents = () => enrichAgents(defaultReadAgents({})),
  readClaim = readLiveFixClaim,
  readRequiredChecks = ({ repoSlug }) => getRequiredStatusChecks({ repo: repoSlug }),
  ready = (repoSlug, pr) => createDraftPromoteProvider({ repo: repoSlug }).ready(pr),
  clearAwaiting = (repoSlug, pr) => applyReviewStatus({ pr, repo: repoSlug, state: null }),
  now = Date.now,
} = {}) {
  const rows = [];
  // Read at most once per step, and only when a candidate got that far. A failed read is remembered, so every later
  // candidate fails closed at once instead of re-running a slow failing command per PR.
  const once = (read) => { let memo; return () => { if (!memo) { try { memo = { value: read() }; } catch (error) { memo = { error }; } } if (memo.error) throw memo.error; return memo.value; }; };
  const agentsOnce = once(readAgents);
  for (const repo of repos) {
    let drafts;
    try { drafts = listDrafts({ repoSlug: repo }); } catch (e) { rows.push({ repo, pr: null, action: 'error', why: `draft list: ${oneLine(e)}` }); continue; }
    const requiredOnce = once(() => readRequiredChecks({ repoSlug: repo })?.checks ?? []);
    for (const pr of drafts.filter(isPromotionCandidate)) {
      const n = Number(pr.number);
      const row = (action, why) => rows.push({ repo, pr: n, action, why });
      let checks;
      try {
        const fresh = readHeadCheckState({ repoSlug: repo, sha: pr.headRefOid });
        checks = { state: fresh?.state, sha: pr.headRefOid };
      } catch (e) { row('error', `check read: ${oneLine(e)}`); continue; }
      const decision = isDraftOwedPromotion({ pr, checks });
      if (!decision.owed) { row('skip', decision.why); continue; }

      // The PR as it is NOW. A push, a label or a comment between the list read and the write changes the answer.
      let view;
      try { view = readPrView({ repoSlug: repo, prNumber: n }); } catch (e) { row('error', `pr view: ${oneLine(e)}`); continue; }
      if (!view || typeof view !== 'object') { row('error', 'pr view: no record returned'); continue; }
      if (view.headRefOid !== pr.headRefOid) { row('skip', `head moved since the check read (${String(pr.headRefOid).slice(0, 9)} → ${String(view.headRefOid).slice(0, 9)}) — the next step re-reads it`); continue; }
      const fresh = isDraftOwedPromotion({
        pr: { ...pr, state: view.state, isDraft: view.isDraft, headRefName: view.headRefName, labels: view.labels, isCrossRepository: view.isCrossRepository },
        checks,
      });
      if (!fresh.owed) { row('skip', `${fresh.why} (re-read just before the write)`); continue; }
      if ((view.labels ?? []).some((l) => (typeof l === 'string' ? l : l?.name) === CONFLICT_LABEL)) {
        row('skip', `${CONFLICT_LABEL}: the tick's already-landed check decides this one (it needs git reads this step does not pay)`);
        continue;
      }

      // Ask the tick's own classifier. A fix claim is attached the way the reconcile pass attaches it, but a failed
      // read refuses here: the pass treats an unreadable claim store as "no claim", this step must not.
      // `gh pr view` caps the rollup at 100 contexts; the tick re-reads REST past that. A capped rollup reads
      // `unchecked`, so say so instead of logging a misleading "no promote-draft planned" every minute.
      if ((view.statusCheckRollup?.length ?? 0) >= ROLLUP_CAP) { row('skip', `status rollup has ${view.statusCheckRollup.length} contexts and may be truncated — the tick owns this draft`); continue; }
      const repoKey = repoKeyForSlug(repo);
      if (!repoKey) { row('error', `${repo} is not a constellation repo`); continue; }
      let agents; let requiredChecks;
      try { agents = agentsOnce(); } catch (e) { row('error', `agents listing: ${oneLine(e)}`); continue; }
      try { requiredChecks = requiredOnce(); } catch (e) { row('error', `required checks: ${oneLine(e)}`); continue; }
      // Read last, right before the decision: the agents read can take seconds and a claim taken meanwhile must count.
      let planPr;
      try {
        const entry = readClaim({ repo, pr: n });
        planPr = entry?.meta?.who
          ? { ...view, fixClaim: { who: entry.meta.who, why: entry.meta.why ?? '', claimedAt: entry.meta.claimedAt ?? null } }
          : view;
      } catch (e) { row('error', `fix claim read: ${oneLine(e)}`); continue; }
      let plan;
      try {
        plan = planReconcile({ repo: repoKey, prs: [planPr], agents, requiredChecks, now: now() });
      } catch (e) { row('error', `classifier: ${oneLine(e)}`); continue; }
      if (!plan.dispatch.some((d) => d.prNumber === n && d.kind === 'promote-draft')) {
        const other = plan.refusals.find((r) => r.prNumber === n) ?? plan.dispatch.find((d) => d.prNumber === n);
        row('skip', `the tick would not promote this draft: ${other ? `${other.kind}${other.why ? ` — ${other.why}` : ''}` : 'no promote-draft planned'}`);
        continue;
      }

      try { ready(repo, n); } catch (e) { row('error', `ready write failed: ${oneLine(e)}`); continue; }
      try { clearAwaiting(repo, n); } catch { /* best effort; the review-status sweep corrects it */ }
      row('promoted', decision.why);
    }
  }
  return { rows };
}

/** Log lines: every promotion and error; a skip only when it is new (the caller dedups by key). */
export function formatDraftPromotionLines(result) {
  return (result?.rows ?? []).map((r) => (r.action === 'promoted'
    ? `draft-promotion: promoted ${r.repo} PR #${r.pr} to ready for review — ${logText(r.why)}`
    : `draft-promotion: ${r.action} ${r.repo}${r.pr == null ? '' : ` PR #${r.pr}`} — ${logText(r.why)}`));
}

/**
 * The await-verify child's hook: run {@link runDraftPromotionStep} when the setting is on and the interval has passed.
 * Isolated: it never throws into the push loop. Returns the state the caller threads into the next call.
 */
export function runDraftPromotionIfDue({
  lastRunAtMs = null, lastSkipKey = '', write, now = Date.now,
  resolveSettings = () => resolveDraftPromotionSettings(), step = runDraftPromotionStep,
} = {}) {
  let settings;
  try { settings = resolveSettings(); } catch { return { lastRunAtMs, lastSkipKey, ran: false }; }
  const nowMs = now();
  if (!promotionStepDue({ settings, lastRunAtMs, nowMs })) return { lastRunAtMs, lastSkipKey, ran: false };
  let result;
  try { result = step(); } catch (e) { result = { rows: [{ repo: '?', pr: null, action: 'error', why: oneLine(e) }] }; }
  const lines = formatDraftPromotionLines(result);
  const skipLines = lines.filter((l) => l.startsWith('draft-promotion: skip '));
  const key = skipLines.join('\n');
  for (const l of lines) if (!skipLines.includes(l) || key !== lastSkipKey) write(l);
  return { lastRunAtMs: nowMs, lastSkipKey: key, ran: true, result };
}
