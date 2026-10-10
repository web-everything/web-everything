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

const oneLine = (e) => String(e?.message ?? e).split('\n')[0];

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
