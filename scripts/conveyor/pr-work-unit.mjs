/**
 * @file scripts/conveyor/pr-work-unit.mjs
 * @description #xdx3ifb multi-repo slice 3 — RESOLVE ANY PR TO A WORK UNIT, across any constellation repo, per
 *   the ratified `#conveyor-multi-repo-model` (we:backlog/xx478x6-*.md, see we:reports/2026-09-23-conveyor-
 *   multi-repo-gap-map.md "Proposed design" B / root cause 1): ONE backlog (WE's) for every repo, with
 *   repo-prefixed scope (`we:`/`fui:`/`plateau:`); a PR that names no backlog item is attributed to the PR
 *   itself, with scope taken from its own diff under its OWN repo's prefix — never `we:` by default.
 *
 * THE TWO GAPS THIS CLOSES (both audited live, see the item's own backlog card):
 *   1. `we:scripts/operations/dispatch-lane-io.mjs#findItem` matches an item's `num` only. When a WE half
 *      lands, the drain JIT-renumbers its card (`xHASH → NNNN`, #2288) — the still-open impl-repo branch,
 *      cut before that rename and still named `lane/xHASH-…`, has no way to learn the new number. `findItem`
 *      now also matches `bornAs` (see its own docblock), so this resolver's item lookup recovers that
 *      population automatically, with no change here.
 *   2. `we:scripts/conveyor/reconcile-fix-dispatch.mjs#fetchPrDiffScope`'s fallback scope was hard-coded
 *      `we:` regardless of which repo the PR actually lives in — correct only for WE itself. This resolver's
 *      pr-attribution branch prefixes with `repoProfile(repo).canonicalPrefix`, the SAME per-repo prefix table
 *      slice 1 (`we:scripts/lib/repo-profile.mjs`) gives every other multi-repo consumer, so plateau/fui diffs
 *      are never mislabeled as WE's.
 *
 * PURE, given its three injected IO seams (`findItem`, `fetchDiffPaths`, `fetchCardScopeAtRef`) — this file
 * itself touches no `fs` / `gh` / `git`. `repoProfile`/`gateFor` are called directly (not injected) because
 * they are themselves already the single, injectable-at-their-own-level IO seam (`we:scripts/lib/repo-
 * profile.mjs`); adding a second layer of indirection here would just be a wrapper around a wrapper.
 *
 * #xcla4iv — A THIRD population, between "item found on main" and "genuine ghost": the STANDARD file-item-in-
 * PR workflow files a new item's card in the SAME PR that delivers it, so `findItem` (which reads only what is
 * committed to `main`) returns `null` for it until this PR actually lands — indistinguishable, by number
 * alone, from a truly unresolvable/deleted item. Live case: `web-everything/web-everything` PR #2553 (branch
 * `lane/xzi292i-stuck-pr-watch`) carries `backlog/xzi292i-....md` IN ITS OWN DIFF, with a real `scope:`
 * frontmatter, yet was refused `no-scope` on every reconcile tick because the old code treated any `findItem`
 * miss as a ghost. Fixed here, in the shared resolver (not a second hand-rolled path in `reconcile-fix-
 * dispatch.mjs`), so every consumer — that file's `planFixesFromReconcile` AND `we:scripts/operations/ci-heal-
 * pr-dispatch.mjs` — gets the correction for free: when the PR's own diff (`fetchDiffPaths`) carries
 * `backlog/<itemNum>-*.md`, the item is real, just not-yet-landed. Its own committed `scope:` is read straight
 * off the PR's HEAD (`fetchCardScopeAtRef`, keyed by the PR's `headRefOid`) — the SAME "trust the item's own
 * declared scope over the diff" preference the main `item` branch above already has — falling back to the PR's
 * raw diff paths (repo-prefixed, `scopeSource:'diff'`) only when the card itself declares none or the read
 * fails. `itemNum` is stamped honestly either way (the card IS in the PR); a genuine ghost (no matching card
 * anywhere in the diff) falls straight through to the ordinary `pr` attribution below, unchanged.
 */
import { repoProfile, gateFor } from '../lib/repo-profile.mjs';
import { laneRefItemNum } from './lease-reaper.mjs';

/**
 * we:scripts/conveyor/pr-work-unit.mjs#isSafeFallbackScopeEntry — may this PR-author-controlled string become a
 * scope-fence entry? PURE. MOVED HERE (from `reconcile-fix-dispatch.mjs`, which still re-exports it for
 * backward compatibility) by the web-everything/web-everything#2573 review findings (correctness + security): this
 * is the ONE shared choke point {@link resolvePrWorkUnit} itself can call it from, for every untrusted-scope
 * branch this resolver produces (PR-diff paths, and #xcla4iv's card-in-diff scope), so every consumer
 * (`reconcile-fix-dispatch.mjs#planFixesFromReconcile` AND `ci-heal-pr-dispatch.mjs`) is protected without
 * having to remember to filter untrusted-PR-content scope on its own. A PR author controls its filenames (and,
 * for #xcla4iv, its own unmerged card's `scope:` frontmatter), and `dispatchFix` joins `scope` with ',' into
 * the fix agent's `SCOPE:` token, so a name like `x,we:scripts` would read as TWO fence entries (the second a
 * whole directory the PR never touched) and free text in a name would land in the brief. Rejects: `,`, any
 * whitespace or control character, a `..` path segment, a leading `/`, and glob metacharacters
 * (`* ? [ ] { }`). A rejected entry is DROPPED from the fence (never a looser fence, only a narrower one); if
 * none survive the caller reports `no-scope`. Declared item `scope:` for an item already resolved on `main`
 * (trusted backlog frontmatter, committed history) is NOT filtered — only content whose provenance traces back
 * to an unmerged PR's own diff/head.
 * @param {string} entry - a `we:`-prefixed path.
 * @returns {boolean}
 */
export function isSafeFallbackScopeEntry(entry) {
  if (typeof entry !== 'string') return false;
  const path = entry.replace(/^[a-z][a-z0-9-]*:/i, '');
  if (!path || path.startsWith('/')) return false;
  if (/[,\s*?[\]{}]/.test(path) || /[\u0000-\u001f\u007f]/.test(path)) return false;
  return !path.split('/').includes('..');
}

/**
 * we:scripts/conveyor/pr-work-unit.mjs#resolvePrWorkUnit — resolve ONE pull request (in any constellation
 * repo) to the work unit it actually delivers: a declared backlog item when its branch names one findable by
 * {@link findItem} (which itself now also matches a renamed card's `bornAs`); failing that, the SAME item when
 * its card was merely filed IN this PR's own diff and not yet landed (#xcla4iv — see the file header); or the
 * PR itself — attributed by its own already-changed files, repo-prefixed — when it names no item at all, or
 * names one that resolves nowhere, on main OR in the diff.
 *
 * `attribution: 'item'` from the FIRST branch NEVER falls back to the diff: a declared `scope:` is the item's
 * own predicted fence, trusted over whatever files a PR happens to have touched so far (mirrors
 * `planFixesFromReconcile`'s own item-scope-wins-over-diff order). The `#xcla4iv` card-in-diff branch mirrors
 * that same preference one level down (the card's OWN declared scope over the PR's raw diff). `attribution:
 * 'pr'` is the diff-derived fallback the ratified model calls for — every changed path, prefixed with THIS
 * repo's canonical scope prefix (never a fixed `we:`).
 *
 * @param {object} o
 * @param {string} o.repo - any vocabulary {@link repoProfile} accepts (key / gh slug / slug tag / scope
 *   prefix, with or without a trailing `:`) — e.g. `'we'`, `'plateau-app'`, `'plateau'`, `'plateauapp/plateau-app'`.
 * @param {{number: number|string, headRefName?: string|null, headRefOid?: string|null}} o.pr - the PR's own
 *   number, head ref name, and (#xcla4iv) head ref sha — the three fields `reconcile-pass.mjs`'s dispatch
 *   entries already carry as `prNumber`/`headRefName`/`headRefOid`. `headRefOid` is only needed for the
 *   card-in-diff branch (to pin the read to this PR's own commit); its absence never blocks resolution, it
 *   just skips straight to the diff-paths fallback for that branch.
 * @param {(itemNum: string) => ({num:string, slug:string, specPath:string, scope:string[]}|null)} o.findItem -
 *   injected, arity-1 (the caller binds the real `we:scripts/operations/dispatch-lane-io.mjs#findItem`'s
 *   `loadItems` closure so this resolver never has to know how the ONE backlog is loaded).
 * @param {(pr: number) => string[]} o.fetchDiffPaths - injected: the PR's own changed-file paths, REPO-RELATIVE
 *   and un-prefixed (this resolver adds the prefix) — the real binding is `reconcile-fix-dispatch.mjs`'s
 *   `fetchPrDiffPaths`'s underlying `gh pr diff --name-only` read.
 * @param {(path: string, ref: string) => string[]} [o.fetchCardScopeAtRef] - #xcla4iv, injected: reads ONE
 *   backlog card's own committed `scope:` frontmatter at a specific ref — the real binding is `reconcile-fix-
 *   dispatch.mjs`'s `fetchCardScopeAtRef`'s `gh api .../contents` read. Defaults to `() => []` (degrades to the
 *   diff-paths fallback when a caller has nothing better to offer, e.g. an older consumer not yet updated).
 * @returns {{attribution:'item'|'pr', itemNum:string|null, scope:string[], gate:string|null, scopeSource?:('card'|'diff')}|null}
 *   `scopeSource` is present ONLY on an `#xcla4iv` card-in-diff resolution (`'card'` when the card's own
 *   frontmatter supplied the scope, `'diff'` when it fell back to the PR's raw diff paths) — absent (`undefined`)
 *   for both older branches, which a caller can keep treating exactly as before. `null` when `repo` is not a
 *   recognized constellation repo — nothing else here is resolvable without a profile.
 */
export function resolvePrWorkUnit({ repo, pr, findItem, fetchDiffPaths, fetchCardScopeAtRef = () => [] }) {
  const profile = repoProfile(repo);
  if (!profile) return null;

  const prNumber = pr && typeof pr === 'object' ? Number(pr.number) : Number(pr);
  const headRefName = pr && typeof pr === 'object' ? (pr.headRefName ?? null) : null;
  const headRefOid = pr && typeof pr === 'object' ? (pr.headRefOid ?? null) : null;
  const gate = gateFor(profile.key);

  const itemNum = laneRefItemNum(headRefName);
  const item = itemNum ? findItem(itemNum) : null;
  if (item) {
    return {
      attribution: 'item',
      itemNum: String(item.num),
      scope: Array.isArray(item.scope) ? item.scope.map(String) : [],
      gate,
    };
  }

  let diffPaths = [];
  try { diffPaths = fetchDiffPaths(prNumber) || []; } catch { diffPaths = []; }
  const paths = (Array.isArray(diffPaths) ? diffPaths : []).map((p) => String(p).trim()).filter(Boolean);

  // #xcla4iv — `itemNum` names a number `findItem` cannot resolve on `main`, but this PR's OWN diff may carry
  // that item's card (the file-item-in-PR workflow — see the file header). Only THIS specific filename shape
  // (`backlog/<itemNum>-*.md`) counts; anything else stays the genuine-ghost `pr` attribution below.
  if (itemNum) {
    const cardPrefix = `backlog/${itemNum}-`;
    const cardPath = paths.find((p) => p.startsWith(cardPrefix) && p.endsWith('.md'));
    if (cardPath) {
      let cardScope = [];
      if (headRefOid) {
        try { cardScope = fetchCardScopeAtRef(cardPath, headRefOid) || []; } catch { cardScope = []; }
      }
      cardScope = Array.isArray(cardScope) ? cardScope.map(String).filter(Boolean) : [];
      const diffScope = paths.map((p) => `${profile.canonicalPrefix}:${p}`);
      // Review findings (correctness + security, web-everything/web-everything#2573) — a card filed IN this PR's own
      // UNMERGED diff is exactly as PR-author-controlled/unreviewed as the diff paths themselves (neither has
      // landed on `main` yet), unlike a resolved item's declared `scope:` (trusted above, at the `attribution:
      // 'item'` return a few lines up, precisely because THAT card already sits on `main`). So this card's
      // scope gets the SAME two guards the diff-paths fallback below already gets, applied HERE, at the one
      // shared choke point every consumer of this resolver goes through (`reconcile-fix-dispatch.mjs`'s
      // `planFixesFromReconcile` AND `ci-heal-pr-dispatch.mjs`), rather than leaving each call site to
      // remember to filter untrusted-PR-content scope on its own:
      //   1. character safety (`isSafeFallbackScopeEntry`) — no comma/`..`/control-char smuggling into the
      //      `dispatchFix` brief's `SCOPE:` fence (see that function's own docblock).
      //   2. containment — a card cannot declare scope for a file the PR itself never touched. A card's raw
      //      `scope:` has no bound at all on its own (it could name any file in the whole monorepo, safe-
      //      shaped or not — e.g. `we:.github/workflows/deploy.yml`), so it is intersected with the PR's own
      //      already-changed diff paths: never a looser fence than the PR's own footprint, the SAME invariant
      //      this file's `pr` attribution and every other untrusted-scope fallback already honors. Verified
      //      safe for the live case this feature exists for (PR #2553): every one of its card's 7 declared
      //      scope entries is also in that PR's own diff.
      const diffScopeSet = new Set(diffScope);
      const safeCardScope = cardScope.filter(isSafeFallbackScopeEntry).filter((entry) => diffScopeSet.has(entry));
      if (safeCardScope.length) {
        return { attribution: 'item', itemNum, scope: safeCardScope, gate, scopeSource: 'card' };
      }
      return {
        attribution: 'item',
        itemNum,
        scope: diffScope.filter(isSafeFallbackScopeEntry),
        gate,
        scopeSource: 'diff',
      };
    }
  }

  const scope = paths.map((p) => `${profile.canonicalPrefix}:${p}`);
  return { attribution: 'pr', itemNum: null, scope, gate };
}
