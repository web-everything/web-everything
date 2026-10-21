/**
 * @file scripts/conveyor/review-tick-promote.mjs — promote a green draft and dispatch its review in ONE review-daemon
 * pass (card xemxk3h).
 *
 * Before: the review daemon's plan carried `kind:'promote-draft'` for a green draft, but the review daemon only acted
 * on `kind:'review'`. Promotion happened in the fix daemon (its tick or its fast child), and the review went out on a
 * LATER review pass: two hops, median 6.4 + 5.3 min (coroner, 2026-10-07..09; live 2026-10-09 #4683: promoted
 * 20:26:43Z, review dispatched 20:43:27Z).
 *
 * Now: the review pass hands its `promote-draft` rows to {@link promoteDraftsThenReplan}. Each one is promoted
 * through the fast promoter's OWN guarded step (`draft-promotion-loop.mjs#runDraftPromotionStep`: fresh
 * required-check read for the exact head, fresh `gh pr view`, the tick's classifier, fork/withdrawn/conflict/
 * rollup-cap refusals). No rule is re-derived here, so no safety check is relaxed. If at least one PR was promoted,
 * the pass plans again over the same snapshot with those PRs marked ready, and the ordinary review path (every
 * review refusal unchanged) decides whether a review is owed this pass.
 *
 * Fail closed: a promote that fails or is refused leaves the PR a draft and the ORIGINAL plan in force (no review).
 * A re-plan that throws keeps the original plan (the PR is promoted; its review goes out next pass). The fix
 * daemon's promotion stays as the fallback; `gh pr ready` is idempotent and the guarded step re-reads `isDraft`,
 * so a PR promoted by one daemon is a skip for the other.
 */
import { defaultListDrafts, runDraftPromotionStep } from './draft-promotion-loop.mjs';
import { resolveDraftPromotionSettings } from './draft-promotion-rule.mjs';
// The guarded stale-accept provider ships with the planner (#5628); main may not export it yet.
import * as promoteDispatch from '../operations/promote-draft-pr-dispatch.mjs';

const oneLine = (e) => String(e?.message ?? e).split('\n')[0];

/** Use the existing guarded provider when installed; keep the PR held when it is unavailable. */
export function rearmStaleAcceptanceGuarded({
  repo, pr, headSha, rearm = promoteDispatch.defaultRearmStaleAcceptance,
} = {}) {
  if (typeof rearm !== 'function') {
    return { ok: false, reason: 'guarded stale-accept re-arm is unavailable in this checkout' };
  }
  return rearm({ repoSlug: repo, prNumber: pr, headSha });
}

/**
 * The real promote effect: the fast promoter's guarded step, scoped to one repo and to the given PR numbers.
 * Honors the same `draftPromotion.loop` kill switch as the fast promoter.
 * @returns {{rows:Array<{repo:string, pr:number|null, action:string, why:string}>}}
 */
export function promoteDraftsGuarded({
  repo, prNumbers, step = runDraftPromotionStep, listDrafts = defaultListDrafts,
  resolveSettings = () => resolveDraftPromotionSettings(), stepDeps = {},
} = {}) {
  const wanted = new Set((prNumbers ?? []).map(Number));
  if (!wanted.size) return { rows: [] };
  let settings;
  try { settings = resolveSettings(); } catch { settings = { loop: false }; }
  if (!settings?.loop) return { rows: [...wanted].map((pr) => ({ repo, pr, action: 'skip', why: 'draftPromotion.loop is off' })) };
  return step({
    ...stepDeps,
    repos: [repo],
    listDrafts: (o) => listDrafts(o).filter((p) => wanted.has(Number(p?.number))),
  });
}

/**
 * PURE apart from the injected effects. Promote this pass's `promote-draft` rows, then re-plan so a promoted PR's
 * review is dispatched in the same pass.
 * @param {{plan:object, rawPrs:Array|null, repo:string,
 *   promote:(o:{repo:string, prNumbers:number[]})=>{rows:Array<{pr:number|null, action:string, why:string}>},
 *   replan:(prs:Array|null)=>object}} o
 *   `replan(prs)`: plan again; `prs` is the shared snapshot with promoted PRs marked ready (null when the pass has
 *   no shared snapshot — the replan then reads fresh).
 * @returns {{plan:object, rawPrs:Array|null, promotions:Array<{pr:number|null, action:string, why:string}>, replanError:string|null}}
 */
export function promoteDraftsThenReplan({ plan, rawPrs = null, repo, promote, replan }) {
  const owed = [...new Set((plan?.dispatch ?? [])
    .filter((d) => d && d.kind === 'promote-draft' && Number.isInteger(Number(d.prNumber)))
    .map((d) => Number(d.prNumber)))];
  if (!owed.length || typeof promote !== 'function') return { plan, rawPrs, promotions: [], replanError: null };

  let rows;
  try { rows = promote({ repo, prNumbers: owed })?.rows ?? []; } catch (e) {
    rows = owed.map((pr) => ({ pr, action: 'error', why: `promote: ${oneLine(e)}` }));
  }
  const promotions = rows.filter((r) => r && owed.includes(Number(r.pr)));
  const promoted = new Set(promotions.filter((r) => r.action === 'promoted').map((r) => Number(r.pr)));
  if (!promoted.size || typeof replan !== 'function') return { plan, rawPrs, promotions, replanError: null };

  const nextPrs = Array.isArray(rawPrs)
    ? rawPrs.map((p) => (promoted.has(Number(p?.number)) ? { ...p, isDraft: false } : p))
    : null;
  try {
    const next = replan(nextPrs);
    if (!next || !Array.isArray(next.dispatch)) throw new Error('re-plan returned no dispatch list');
    return { plan: next, rawPrs: nextPrs ?? rawPrs, promotions, replanError: null };
  } catch (e) {
    return { plan, rawPrs: nextPrs ?? rawPrs, promotions, replanError: oneLine(e) };
  }
}

/**
 * LIVE 2026-10-21, PR #5771 (review:accepted, head moved past its accept): this daemon's plan carried a
 * `restore-review-label` row (variant `stale-accept`, #5628) every tick, and held the PR's red-team request behind it
 * ("the review plan holds this PR"), but only the FIX daemon executes that row — and its plan never produces it, so
 * nothing ever re-armed review of the new head and the red team never ran (5 h). The daemon that PLANS the row now
 * EXECUTES it: each owed row goes through the same guarded re-arm the fix daemon would use
 * (`promote-draft-pr-dispatch.mjs#defaultRearmStaleAcceptance`: fresh read, live coverage proof, then the invariant-guarded
 * `rearm-review.mjs` swap), and a re-armed PR is re-planned so its review is dispatched in the same pass. The guarded
 * re-arm re-reads everything, so a row the fix daemon (or a human) already handled is a refusal here, not a second write.
 *
 * Fail closed: a refused or failed re-arm leaves the ORIGINAL plan in force (the PR keeps being held); a re-plan that
 * throws keeps the original plan (the label swap is done, so the next pass dispatches the review). PURE apart from the
 * injected effects.
 * @param {{plan:object, rawPrs:Array|null, repo:string,
 *   rearm:(o:{repo:string, pr:number, headSha:string})=>{ok:boolean, reason?:string},
 *   replan:(prs:null)=>object}} o   `replan(null)` plans over a fresh read.
 * @returns {{plan:object, rawPrs:Array|null, rearms:Array<{pr:number, ok:boolean, why:string}>, replanError:string|null}}
 */
export function rearmStaleAcceptsThenReplan({ plan, rawPrs = null, repo, rearm, replan }) {
  const rows = new Map();
  for (const d of plan?.dispatch ?? []) {
    if (d && d.kind === 'restore-review-label' && d.variant === 'stale-accept' && Number.isInteger(Number(d.prNumber))) {
      rows.set(Number(d.prNumber), String(d.headRefOid ?? ''));
    }
  }
  if (!rows.size || typeof rearm !== 'function') return { plan, rawPrs, rearms: [], replanError: null };

  const rearms = [];
  for (const [pr, headSha] of rows) {
    let result;
    try { result = rearm({ repo, pr, headSha }); } catch (e) { result = { ok: false, reason: oneLine(e) }; }
    // #5771: ONE coverage check. A refusal that PROVED the accept still covers the live head (`covers: true`) is not a
    // reason to keep holding the PR: the plan's row only nominated it, the guarded re-arm checked it. Release the hold.
    const released = result?.ok !== true && result?.covers === true && String(result?.coveredHead ?? '').toLowerCase() === headSha.toLowerCase();
    rearms.push({ pr, ok: result?.ok === true, ...(released ? { released: true } : {}),
      why: result?.ok === true ? 're-armed review of the moved head'
        : released ? `acceptance verified to still cover the moved head — stale-accept hold released (${String(result?.reason ?? 'covers').slice(0, 120)})`
          : String(result?.reason ?? 're-arm not confirmed') });
  }
  // Bound to the PROVED head: a row for a newer head (the PR moved again before a re-plan) is a fresh obligation, never released.
  const releasedHeads = new Map(rearms.filter((r) => r.released).map((r) => [r.pr, rows.get(r.pr).toLowerCase()]));
  /** Drop the released PRs' stale-accept rows (never any other row) so nothing holds their red-team request. */
  const unhold = (p) => (!releasedHeads.size || !Array.isArray(p?.dispatch) ? p : { ...p, dispatch: p.dispatch.filter((d) =>
    !(d && d.kind === 'restore-review-label' && d.variant === 'stale-accept' && releasedHeads.get(Number(d.prNumber)) === String(d.headRefOid ?? '').toLowerCase())) });
  const rearmed = new Set(rearms.filter((r) => r.ok).map((r) => r.pr));
  if (!rearmed.size || typeof replan !== 'function') return { plan: unhold(plan), rawPrs, rearms, replanError: null };

  const name = (l) => (typeof l === 'string' ? l : l?.name);
  const swap = (labels) => {
    const kept = (Array.isArray(labels) ? labels : []).filter((l) => name(l) !== 'review:accepted');
    return kept.some((l) => name(l) === 'review:pending') ? kept : [...kept, { name: 'review:pending' }];
  };
  const nextPrs = Array.isArray(rawPrs)
    ? rawPrs.map((p) => (rearmed.has(Number(p?.number)) ? { ...p, labels: swap(p.labels) } : p))
    : null;
  try {
    // A FRESH read, never the old snapshot with a synthesized label swap: the real swap's exact label result is GitHub's.
    const next = replan(null);
    if (!next || !Array.isArray(next.dispatch)) throw new Error('re-plan returned no dispatch list');
    // A FRESH plan is never unheld from an earlier proof (audit): its rows are re-proved next pass.
    return { plan: next, rawPrs: nextPrs ?? rawPrs, rearms, replanError: null };
  } catch (e) {
    return { plan: unhold(plan), rawPrs: nextPrs ?? rawPrs, rearms, replanError: oneLine(e) };
  }
}
