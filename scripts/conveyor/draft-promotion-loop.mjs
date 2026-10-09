/**
 * @file scripts/conveyor/draft-promotion-loop.mjs — the fast promotion step (draft-first PRs). Runs from the fix
 * daemon's await-verify child (`await-verify-loop.mjs#main`), on its own interval, so promoting a green draft never
 * waits on the fix daemon's tick (which can starve behind self-sync rebuilds — live 2026-10-09, #4567/#4563/#4535,
 * see `draft-promotion-rule.mjs`). The tick's own promote half (`promote-draft-pr-dispatch.mjs`) stays: `gh pr ready`
 * is idempotent, so whichever edge reaches a draft first wins.
 *
 * One step, per constellation repo: ONE `gh pr list --draft` read → {@link isPromotionCandidate} → for each candidate
 * a fresh required-check read for its EXACT head sha → {@link isDraftOwedPromotion} → a fresh label read (withdrawal
 * can land between the list and the write) → `gh pr ready` → clear the stale `review-status:awaiting-*` label.
 * No reconcile pass (that is what makes it cheap), no lane, no session. Every effect is injectable.
 */
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { runGhSync } from '../lib/gh-throttle.mjs';
import { createDraftPromoteProvider } from '../lib/draft-promote-provider.mjs';
import { applyReviewStatus } from './review-status-tag.mjs';
import { defaultReadHeadCheckState, defaultReadPrLabels } from '../operations/promote-draft-pr-dispatch.mjs';
import {
  isDraftOwedPromotion, isPromotionCandidate, promotionStepDue, resolveDraftPromotionSettings, WITHDRAWN_LABEL,
} from './draft-promotion-rule.mjs';

export const DRAFT_LIST_FIELDS = 'number,state,isDraft,headRefName,headRefOid,labels';

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

/**
 * One promotion step over every repo. Never throws: a failed read or write is a row, and the next step retries.
 * @returns {{rows:Array<{repo:string, pr:number|null, action:'promoted'|'skip'|'error', why:string}>}}
 */
export function runDraftPromotionStep({
  repos = Object.values(CONSTELLATION_REPOS).map((r) => r.slug),
  listDrafts = defaultListDrafts,
  readHeadCheckState = defaultReadHeadCheckState,
  readPrLabels = defaultReadPrLabels,
  ready = (repoSlug, pr) => createDraftPromoteProvider({ repo: repoSlug }).ready(pr),
  clearAwaiting = (repoSlug, pr) => applyReviewStatus({ pr, repo: repoSlug, state: null }),
} = {}) {
  const rows = [];
  for (const repo of repos) {
    let drafts;
    try { drafts = listDrafts({ repoSlug: repo }); } catch (e) { rows.push({ repo, pr: null, action: 'error', why: `draft list: ${oneLine(e)}` }); continue; }
    for (const pr of drafts.filter(isPromotionCandidate)) {
      const n = Number(pr.number);
      let checks;
      try {
        const fresh = readHeadCheckState({ repoSlug: repo, sha: pr.headRefOid });
        checks = { state: fresh?.state, sha: pr.headRefOid };
      } catch (e) { rows.push({ repo, pr: n, action: 'error', why: `check read: ${oneLine(e)}` }); continue; }
      const decision = isDraftOwedPromotion({ pr, checks });
      if (!decision.owed) { rows.push({ repo, pr: n, action: 'skip', why: decision.why }); continue; }
      let labels;
      try { labels = readPrLabels({ repoSlug: repo, prNumber: n }); } catch (e) { rows.push({ repo, pr: n, action: 'error', why: `label read: ${oneLine(e)}` }); continue; }
      if ((labels ?? []).some((l) => (typeof l === 'string' ? l : l?.name) === WITHDRAWN_LABEL)) {
        rows.push({ repo, pr: n, action: 'skip', why: 'draft was withdrawn since the list read' });
        continue;
      }
      try { ready(repo, n); } catch (e) { rows.push({ repo, pr: n, action: 'error', why: `gh pr ready: ${oneLine(e)}` }); continue; }
      try { clearAwaiting(repo, n); } catch { /* best effort; the review-status sweep corrects it */ }
      rows.push({ repo, pr: n, action: 'promoted', why: decision.why });
    }
  }
  return { rows };
}

/** Log lines: every promotion and error; a skip only when it is new (the caller dedups by key). */
export function formatDraftPromotionLines(result) {
  return (result?.rows ?? []).map((r) => (r.action === 'promoted'
    ? `draft-promotion: promoted ${r.repo} PR #${r.pr} to ready for review — ${r.why}`
    : `draft-promotion: ${r.action} ${r.repo}${r.pr == null ? '' : ` PR #${r.pr}`} — ${r.why}`));
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
