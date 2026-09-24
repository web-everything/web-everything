/**
 * @file scripts/conveyor/reconcile-fix-dispatch.mjs
 * @description #3438 — DISPATCH THE FIX AGENT `we:scripts/conveyor/reconcile-pass.mjs` DECIDES IS OWED.
 *
 * THE GAP THIS CLOSES. `reconcile-pass.mjs` (#3296) already decides, correctly, that a bounced (`review:changes`)
 * PR with a real finding, an unspent attempt cap, and nothing live working it OWES a fix (`kind: 'fix'`) — but it
 * "DISPATCHES NOTHING ITSELF" (its own docblock), and nothing has ever called that decision for the `fix` kind.
 * `we:scripts/conveyor/tick-core.mjs#planFixSpawns` looks like the same job but is NOT: it only ever considers a
 * PR in `state.prs` whose `num` is in `launchedNums` — i.e. a PR THIS conveyor session's own bookkeeping launched
 * and still remembers. `reconcile-pass.mjs` is keyed by PR number alone and reads live `gh`/`claude agents` state
 * fresh every pass, so it also covers a bounced PR this specific conveyor process never launched (a restart lost
 * the memory of, one a sibling process launched, one opened by hand) — the two are genuinely different
 * populations, not a duplicate mechanism (see the item's own "Scope, narrowed in light of #3332" section for the
 * question this file answers: YES, genuinely different, so (b) applies — wire it).
 *
 * WHY THIS IS ITS OWN FILE, NOT A DETOUR THROUGH `we:scripts/operations/dispatch-lane.mjs`'s OWN `--num=` CLI.
 * That CLI resolves ONE launch by finding `num` inside `planTick`'s five lists (`decisions.spawnFixes` among
 * them) — a `reconcile-pass.mjs` fix entry will NEVER appear there, for the exact reason above, so `--num=`
 * would find nothing to dispatch no matter what `num` is passed. This file does not re-derive `dispatch-lane`'s
 * policy, though — it REUSES its actual fill/dispatch primitives verbatim (`we:scripts/operations/
 * dispatch-lane.mjs#fillBrief` + `#BRIEF_REQUIRED_BY_KIND.fix` + `#sessionSlugFor`, `we:scripts/operations/
 * dispatch-lane-io.mjs#buildAgentArgv` + `#defaultSpawnAgent` + `#findItem`/`#defaultLoadItems`) — the same
 * "the corrected fillBrief token set... however it resolves the scope-refusal question" this item's own text
 * asks for, not a bespoke fill/dispatch path. The shape this file itself follows — plan → fill the brief → mint a
 * session id → spawn, with no lane pre-acquired by the dispatcher (the agent's own brief step 1 acquires its
 * own) — mirrors `we:scripts/operations/review-dispatch.mjs#dispatchReview` (#3279) closely, because that is the
 * existing, already-landed precedent for "dispatch directly against a PR number, outside `planTick`'s own
 * launch lists".
 *
 * THE ONE THING `dispatchReview` DOES NOT NEED THAT THIS FILE DOES: A LANE NUMBER. `{{LANE}}` is baked into
 * `we:skills-src/conveyor/fix-agent-brief.md`'s own acquire line (`--lane={{LANE}}`) — unlike
 * `we:skills-src/review/review-agent-brief.md`'s lane-less `acquire` (no `--lane=` at all, so the pool auto-picks
 * one) — because that brief is SHARED with `dispatch-lane.mjs`'s own tick-core-driven fix dispatch, which DOES
 * pre-assign a specific lane from `decisions.spawnFixes[].lane`. Rather than fork the brief (twin templates for
 * the same job is exactly the drift risk `we:scripts/conveyor/review-session-slug.mjs`'s own header warns about
 * for a slug function), this file reads a currently-free lane NUMBER at dispatch time — the SAME
 * `lane-pool.mjs list --acquirable --json` read `we:scripts/conveyor/tick-core.mjs`'s own IO shell uses to build
 * `freeLanes` for `planFixSpawns` — and fills `{{LANE}}` with it. This is a READ, not a lock: the dispatched
 * agent still does the real `acquire` itself in its own brief step 1, and can lose the race to a sibling exactly
 * as any other dispatch already can (`we:skills-src/conveyor/delivery-agent-brief.md`'s own step 1: "If that lane
 * lost its race to a sibling, `acquire` fails loud — report it and exit").
 *
 * DOUBLE-DISPATCH GUARD: NAME-BASED LIVENESS, NOT A SEPARATE LEDGER. This file keeps no bookkeeping of its own
 * between passes (deliberately — see `reconcile-pass.mjs`'s own "session-ephemeral" argument against folding into
 * the tick). The guard against re-dispatching a fix that is already running is `reconcile-core.mjs#bindAgents`'s
 * OWN liveness read: it now recognizes a live `fix-<pr>` session by name (#3438, mirroring the `review-<pr>`
 * name-bind #3437 already added) and refuses (`live-process`) before `planReconcile` ever returns a `kind:'fix'`
 * dispatch entry for that PR again. This is exactly `review-dispatch.mjs`'s own safety net — it carries no
 * separate in-flight ledger either.
 *
 * A ONE-SHOT PASS, LIKE ITS SIBLINGS. Read `reconcile-pass.mjs`'s plan, dispatch every `kind:'fix'` entry it
 * offers, report, exit. Wired into `we:skills-src/conveyor/runner.mjs`'s mechanical passes (#3438) alongside
 * infra-blocked recovery / the lease-reaper / the session-reaper / the hiccup sink — best-effort, never gating
 * the tick.
 */
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { repoProfile, briefTokensForRepo } from '../lib/repo-profile.mjs';
import { resolvePrWorkUnit, isSafeFallbackScopeEntry } from './pr-work-unit.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

import {
  agentArgsFromEnv, assertNotALaneCheckout, buildAgentArgv, defaultLoadItems, defaultListAgents,
  defaultSpawnAgent, DISPATCHED_AGENT_SYSTEM_PROMPT_FILE, findItem, normalizeHandle, parseBackgroundedId,
  resolveGhShimSettingsEnv, resumeSucceeded, REPO_ROOT,
} from '../operations/dispatch-lane-io.mjs';
import { stopSession } from '../operations/dispatch-abort.mjs';
import { assertMainNotStale } from '../operations/review-dispatch.mjs';
import { BRIEF_REQUIRED_BY_KIND, OPTIONAL_BRIEF_PLACEHOLDERS, REPO_AWARE_VALUE_PATTERNS, fillBrief, sessionSlugFor } from '../operations/dispatch-lane.mjs';
import { parseAuthorActorId } from '../lib/review-independence.mjs';
import { laneRefItemNum } from './lease-reaper.mjs';
import { runReconcilePass, resolveLaneHead } from './reconcile-pass.mjs';
import { readUnsupported, recordUnsupported } from './unsupported-repo.mjs';
import { readPrsFromFile } from './open-pr-fetch.mjs';
import { CONFLICT_LABEL } from './parked-pr-conflict-watch.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';

/** The template `we:skills-src/conveyor/fix-agent-brief.md` — the SAME brief `dispatch-lane.mjs`'s own
 *  tick-core-driven fix dispatch fills, read fresh per dispatch so an edit takes effect with no restart. */
export function fixBriefPath(root = REPO_ROOT) {
  return join(root, 'skills-src', 'conveyor', 'fix-agent-brief.md');
}

/** we:scripts/conveyor/reconcile-fix-dispatch.mjs#RESUME_CONFIRM_MAX_ATTEMPTS — hardening (2) from the
 *  independent review of PR #1966 (`#xu2krte`): how many times `tryResumeFix` re-reads `claude agents --json
 *  --all` after a resume attempt before concluding it did not resume. `#3331`'s own research documents the
 *  listing can lag the CLI's real state; one immediate read is not enough to tell "the listing is stale" apart
 *  from "the resume genuinely forked". 3 total reads (1 immediate + 2 retries) at a short interval is enough to
 *  absorb an ordinary propagation delay without turning a real fork into a long stall. */
export const RESUME_CONFIRM_MAX_ATTEMPTS = 3;
/** The wait between {@link RESUME_CONFIRM_MAX_ATTEMPTS} retries, in ms. Short — this is absorbing a listing
 *  propagation delay, not waiting out real agent work. */
export const RESUME_CONFIRM_WAIT_MS = 300;
/** The default `wait`, real time. Injected so a test never actually sleeps. */
export function defaultConfirmWait(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * we:scripts/conveyor/reconcile-fix-dispatch.mjs#planFixesFromReconcile — PURE (the one impurity is calling the
 * INJECTED `resolveFallbackScope`, exactly the same idiom `findItemFn` already uses — a real caller hands in a
 * function that does IO, a test hands in a stub, and this function itself still touches no `fs`/`gh`/`git`
 * directly). Narrow `reconcile-pass.mjs`'s `kind:'fix'` dispatch entries down to the ones this file can actually
 * act on, and NAME why each one it drops cannot be (mirroring `reconcile-core.mjs`'s own REFUSAL_KINDS
 * discipline: a refusal a reader cannot audit is exactly the defect this whole chain exists to remove).
 *
 * THINGS CAN MAKE AN OTHERWISE-OWED FIX UNDISPATCHABLE, BOTH NAMED (the `no-item-num` refusal `#3634` documented
 * here previously is GONE as of #xmtbdgs multi-repo slice 6 — an item-less PR is attributed to the PR itself
 * instead, per the ratified `#conveyor-multi-repo-model` clause 3; see the loop body below):
 *   `no-scope`     — EITHER the item number resolves but the backlog loader has no scope for it (an item
 *     scaffolded with no `scope:` frontmatter; an UNRESOLVABLE number — deleted/ghost card — is refused outright
 *     and never reaches the fallback — measured live #3634: EVERY currently-open `kind:'fix'` entry
 *     whose item number resolves hits this, epics included, e.g. `#2220` on `lane/3383-host-process-granularity`
 *     resolving epic `#3383`, which — correctly — carries no file-level `scope:` of its own) OR the PR names no
 *     item at all AND its own diff is empty too (slice 6, rare — an item-less PR that changed nothing), OR the
 *     item names a number `findItem` cannot resolve on `main` AND its card is nowhere in the PR's own diff
 *     either (a genuine ghost/deleted number — #xcla4iv did NOT touch this case, see below). All three have the
 *     SAME safe fallback: {@link resolveFallbackScope} (item-carrying, empty declared scope) /
 *     {@link resolvePrWorkUnit}'s own diff read (item-less, or #xcla4iv's card-in-diff-but-card-itself-scopeless)
 *     may return the PR's OWN already-changed files (repo-prefixed) as the fence instead. This is never a
 *     LOOSER fence than a declared `scope:` would have been — a fix agent can only touch what this PR already
 *     touches — so it is safe exactly where a declared scope is unknown. Only when the fallback ALSO comes back
 *     empty does this remain `no-scope`, mirroring `dispatch-lane.mjs`'s OWN scope-refusal (`itemScope.length`
 *     check) for exactly the same reason: a fix agent with no fence at all is undispatchable.
 *
 *   #xcla4iv — A FOURTH population that is NO LONGER `no-scope` at all: the item's number resolves to nothing
 *   on `main` (`findItemFn` misses), but its own card (`backlog/<itemNum>-*.md`) is sitting right there in the
 *   PR's own diff — the standard file-item-in-PR workflow, where the card and the code that delivers it land in
 *   the SAME PR. {@link resolvePrWorkUnit} now recognizes this (see its own file header) and returns
 *   `attribution:'item'` with the card's own committed `scope:` (read at the PR's head), or the PR's raw diff
 *   paths if the card itself declares none. THIS is the one sub-case where the diff-derived fence IS filtered
 *   here (`scopeSource:'diff'` — untrusted, PR-author-controlled filenames), unlike a genuinely resolved item's
 *   own frontmatter scope (`scopeSource` absent/`'card'` — trusted, never filtered). A number with NO matching
 *   card anywhere in the diff is unaffected — still the ghost case just above, still `no-scope`.
 * @param {Array<{kind:string, prNumber:number, headRefName?:string|null, headRefOid?:string|null, labels?:string[], body?:string|null}>} dispatchEntries -
 *   `reconcile-pass.mjs`'s own `dispatch` array (see `we:scripts/conveyor/reconcile-core.mjs#planReconcile`).
 * @param {(key:string, loadItems:Function)=>({num:string,slug:string,specPath:string,scope:string[]}|null)} findItemFn
 * @param {Function} loadItems
 * @param {(pr:number, itemNum:string)=>string[]} [resolveFallbackScope] - injected, defaults to `() => []` (a
 *   caller with nothing better to offer degrades to the pre-#3634 behaviour byte-for-byte); the real binding is
 *   {@link fetchPrDiffScope} via {@link runReconcileFixDispatch}'s own default. Used ONLY for the item-carrying
 *   `no-scope` fallback (an item resolved but declared no `scope:` of its own).
 * @param {string} [repo] - any vocabulary {@link repoProfile} accepts; defaults to `'we'`. Threaded through to
 *   {@link resolvePrWorkUnit} so both the item lookup and the item-less diff-attribution below are repo-aware.
 * @param {(pr:number)=>string[]} [fetchItemlessDiffPaths] - #xmtbdgs multi-repo slice 6 (and, since #xcla4iv,
 *   ALSO the named-item branch — see that block's own comment for why reusing this single binding is now safe):
 *   injected, UN-prefixed (matches {@link resolvePrWorkUnit}'s own `fetchDiffPaths` contract — it adds the repo
 *   prefix itself). Defaults to `() => []`; the real binding is {@link fetchPrDiffPaths} via
 *   {@link runReconcileFixDispatch}'s own default.
 * @param {(path:string, ref:string)=>string[]} [fetchCardScopeAtRef] - #xcla4iv, injected: reads one backlog
 *   card's own committed `scope:` at a specific ref. Defaults to `() => []`; the real binding is
 *   {@link fetchCardScopeAtRef} via {@link runReconcileFixDispatch}'s own default. Passed straight through to
 *   {@link resolvePrWorkUnit} — see its own docblock for the full contract.
 * @returns {{planned:Array<{itemNum:string|null,pr:number,laneRef:string,scope:string[],scopeSource:('item'|'pr-diff'),isConflict:boolean,body:string|null,headRefOid:string|null}>, refusals:Array<{pr:number,kind:string,why:string}>}}
 */
export function planFixesFromReconcile(dispatchEntries, findItemFn, loadItems, resolveFallbackScope = () => [], repo = 'we', fetchItemlessDiffPaths = () => [], resolveCardScopeAtRef = () => []) {
  const planned = [];
  const refusals = [];
  for (const entry of Array.isArray(dispatchEntries) ? dispatchEntries : []) {
    if (!entry || entry.kind !== 'fix') continue;
    const pr = Number(entry.prNumber);
    const headRefName = entry.headRefName ?? null;
    const itemNum = laneRefItemNum(headRefName);
    if (!itemNum) {
      // #xmtbdgs multi-repo slice 6 — a PR whose head ref names no conveyor item is NO LONGER refused outright
      // (ratified `#conveyor-multi-repo-model` clause 3: "a PR with no backlog item is fixed with the PR as the
      // attribution and scope from its own diff under its repo's prefix"). `resolvePrWorkUnit` re-derives
      // `laneRefItemNum(headRefName)` itself, finds the same `null`, skips `findItem` entirely, and returns its
      // `attribution:'pr'` branch: the PR's own already-changed files, repo-prefixed. Safe for the exact reason
      // the item-carrying `no-scope` fallback above is safe — a fix agent can only touch what the PR already
      // touches, never a looser fence than nothing.
      const unit = resolvePrWorkUnit({
        repo,
        pr: { number: pr, headRefName },
        findItem: (key) => findItemFn(key, loadItems),
        fetchDiffPaths: fetchItemlessDiffPaths,
      });
      const itemlessScope = (Array.isArray(unit?.scope) ? unit.scope : []).filter(isSafeFallbackScopeEntry);
      if (!itemlessScope.length) {
        refusals.push({ pr, kind: 'no-scope', why: `PR #${pr} names no backlog item, and its own changed-file diff found nothing to fence with either — refusing to dispatch a fix agent with no fence` });
        continue;
      }
      const isConflictItemless = Array.isArray(entry.labels) && entry.labels.includes(CONFLICT_LABEL);
      planned.push({
        itemNum: null, pr, laneRef: headRefName, scope: itemlessScope, scopeSource: 'pr-diff',
        isConflict: isConflictItemless, body: entry.body ?? null, headRefOid: entry.headRefOid ?? null,
      });
      continue;
    }
    // #xdx3ifb multi-repo slice 3 — resolve the item through the SAME cross-repo resolver every other
    // PR-to-work-unit consumer uses ({@link resolvePrWorkUnit}), rather than a second, hand-rolled
    // `findItemFn` call that could drift from it. This also means a WE-half land that JIT-renumbers this
    // branch's own card (`xHASH → NNNN`, #2288) is now found automatically — `findItemFn` itself matches
    // the rename's `bornAs` record — with zero extra code here.
    //
    // ONLY the resolver's `attribution:'item'` result is trusted for scope. Its `attribution:'pr'` branch
    // (item not found anywhere — not on `main`, not as a card in this PR's own diff either) is DELIBERATELY
    // not used to fall back to the PR's own diff here: a genuine ghost/deleted item number must still refuse
    // `no-scope` outright — using the PR's diff as fence AND stamping `WE #<n>:` with a number naming no item
    // would be precisely the "honest-looking but WRONG attribution" this file's own history already ruled
    // unsafe (see this function's own top-of-file docblock).
    //
    // #xcla4iv — `fetchDiffPaths` is now the REAL `fetchItemlessDiffPaths` binding (it used to be a hard
    // `() => []` stub here, deliberately, to keep the resolver from ever offering a diff-based fallback for
    // this branch at all). That is now SAFE to lift: `resolvePrWorkUnit` itself only ever uses the diff to
    // look for `backlog/<itemNum>-*.md` — the standard file-item-in-PR shape, where the card and the code
    // that delivers it land in the SAME PR, so the card is real but not yet on `main` — and falls straight
    // through to the SAME `attribution:'pr'` (ghost) outcome for every other diff shape, changing nothing
    // for a true ghost. `fetchCardScopeAtRef` lets it read that card's own OWN committed `scope:` at the
    // PR's head instead of trusting raw diff paths, mirroring the "declared scope wins over diff" preference
    // this file already applies everywhere else.
    const unit = resolvePrWorkUnit({
      repo,
      pr: { number: pr, headRefName, headRefOid: entry.headRefOid ?? null },
      findItem: (key) => findItemFn(key, loadItems),
      fetchDiffPaths: fetchItemlessDiffPaths,
      fetchCardScopeAtRef: resolveCardScopeAtRef,
    });
    const item = unit && unit.attribution === 'item' ? { scope: unit.scope, scopeSource: unit.scopeSource ?? null } : null;
    // #xcla4iv — the resolver's own `scopeSource` distinguishes the ordinary on-`main` item branch (`undefined`
    // — a resolved item's declared `scope:` is trusted committed history, not filtered, exactly like the
    // pre-existing "declared item scope: is not filtered" rule) from EITHER of its two UNTRUSTED,
    // PR-author-controlled fallbacks for a card filed IN this PR's own unmerged diff: `'card'` (the card's own
    // frontmatter, read off the PR's own head — an unmerged PR is exactly as author-controlled/unreviewed as
    // its diff, so it gets the same filter) and `'diff'` (the PR's raw diff paths). Review findings
    // (correctness + security, chalbert/web-everything#2573) — `resolvePrWorkUnit` itself now ALSO applies
    // `isSafeFallbackScopeEntry` (plus containment to the PR's own diff, for `'card'`) at its own shared choke
    // point before returning either of these two `scopeSource`s, so this re-filter here is defense in depth,
    // never a behavior change for a caller: filtering an already-filtered array is idempotent.
    let scope = item ? (item.scopeSource ? item.scope.filter(isSafeFallbackScopeEntry) : item.scope) : [];
    let scopeSource = item?.scopeSource === 'diff' ? 'pr-diff' : 'item';
    if (item && !scope.length) {
      // `#3634` — a RESOLVED item with no scope of its own (an epic, typically). Try the PR's own
      // already-changed files before refusing outright; see this function's own docblock for why that fallback is
      // safe (never a looser fence than a declared scope would have been). Gated on `item` being non-null: an
      // UNRESOLVABLE item number (a ghost/deleted card, a PR number in the branch name, or a transient
      // `loadItems` failure that `findItem` swallows into null) stays the `no-scope` refusal it was before — the
      // fallback must not widen what gets dispatched, and must not stamp `WE #<n>:` with a number naming no item.
      let fallback = [];
      try { fallback = resolveFallbackScope(pr, itemNum) || []; } catch { fallback = []; }
      // The filenames are PR-author-controlled and `dispatchFix` joins `scope` with ',' into the agent's brief,
      // so keep only entries that cannot smuggle extra fence entries or brief text (see isSafeFallbackScopeEntry).
      fallback = Array.isArray(fallback) ? fallback.filter(isSafeFallbackScopeEntry) : [];
      if (fallback.length) {
        scope = fallback;
        scopeSource = 'pr-diff';
      }
    }
    if (!scope.length) {
      refusals.push({ pr, kind: 'no-scope', why: `item #${itemNum} (PR #${pr}) has no declared scope, and the PR's own changed-file fallback found nothing to fence with either — refusing to dispatch a fix agent with no fence` });
      continue;
    }
    // #xu2krte Fork 1 — a `fix` dispatch caused by the parked-PR conflict watch still carries the
    // `merge-status:conflicting` label at this point (it self-clears only once the conflict resolves, which a
    // just-detected fresh bounce has not done yet). ONLY this population is offered resume-preference in
    // `tryResumeFix` below; an ordinary reviewer-finding bounce never carries this label and dispatches exactly
    // as it always has.
    const isConflict = Array.isArray(entry.labels) && entry.labels.includes(CONFLICT_LABEL);
    planned.push({
      itemNum, pr, laneRef: headRefName, scope, scopeSource, isConflict, body: entry.body ?? null,
      // #xu2krte security review finding — needed by `tryResumeFix` to confirm a resume CANDIDATE actually
      // belongs to THIS pr before trusting it (see that function's own docblock).
      headRefOid: entry.headRefOid ?? null,
    });
  }
  return { planned, refusals };
}

// `isSafeFallbackScopeEntry` MOVED to `pr-work-unit.mjs` (chalbert/web-everything#2573 review findings —
// `resolvePrWorkUnit` itself now needs to call it, at the one shared choke point every consumer of that
// resolver goes through; see its own docblock there for the full rationale). Re-exported here so existing
// importers of this file (this module's own three call sites above, and this file's own tests) see no change.
export { isSafeFallbackScopeEntry };

/**
 * we:scripts/conveyor/reconcile-fix-dispatch.mjs#fetchPrDiffScope — `#3634`'s real fallback-scope reader: ONE
 * `gh pr diff <pr> --name-only` call, reduced to the `we:`-prefixed path list {@link planFixesFromReconcile}'s
 * `resolveFallbackScope` wants (the SAME repo-qualified form the canonical loader already produces for a
 * declared `scope:` — see `dispatch-lane-io.mjs#findItem`'s own comment). Best-effort: any `gh` failure (no
 * `gh` on PATH, the PR vanished, a network hiccup) degrades to `[]` — the caller then reports `no-scope` exactly
 * as it did before this fallback existed, never throws the whole pass over one bad read.
 * @param {number} pr
 * @param {{exec?:Function, root?:string, repo?:string|null}} [o] - `repo` (an `owner/name` slug, or any other
 *   vocabulary {@link repoProfile} accepts) pins the `gh` call to that repo, the same
 *   `if (repo) argv.push('--repo', repo)` idiom the sibling conveyor readers use, AND selects the prefix this
 *   function tags each path with — #xdx3ifb multi-repo slice 3: this used to hard-code `we:` regardless of
 *   `repo`, which was silently wrong the moment a caller ever passed a non-WE repo (dead code today, since
 *   {@link runReconcileFixDispatch} only reaches this for `repo === 'we'` — see its own `unsupported-repo`
 *   early return — but a latent bug slices 5-6 would otherwise have inherited unnoticed). `repo == null`
 *   (today's only reachable case) still resolves to `'we'`, so existing callers see byte-identical output.
 * @returns {string[]}
 */
export function fetchPrDiffScope(pr, { exec = execFileSyncThrottled, root = REPO_ROOT, repo = null } = {}) {
  const profile = repoProfile(repo ?? 'we');
  const prefix = profile ? profile.canonicalPrefix : 'we';
  return fetchPrDiffPaths(pr, { exec, root, repo }).map((p) => `${prefix}:${p}`);
}

/**
 * we:scripts/conveyor/reconcile-fix-dispatch.mjs#fetchPrDiffPaths — #xmtbdgs multi-repo slice 6: the SAME
 * `gh pr diff <pr> --name-only` read {@link fetchPrDiffScope} always did, factored out UN-prefixed — this is
 * exactly the `fetchDiffPaths` shape `we:scripts/conveyor/pr-work-unit.mjs#resolvePrWorkUnit` itself declares
 * ("REPO-RELATIVE and un-prefixed — this resolver adds the prefix"). {@link fetchPrDiffScope} is now a one-line
 * wrapper over this that adds its own prefix back on top, so the two can never drift. Best-effort, exactly like
 * its wrapper: any `gh` failure degrades to `[]`, never throws.
 * @param {number} pr
 * @param {{exec?:Function, root?:string, repo?:string|null}} [o] - see {@link fetchPrDiffScope}'s own docblock;
 *   `repo` here only pins the `gh --repo` flag, since there is no prefix left for this function to add.
 * @returns {string[]}
 */
export function fetchPrDiffPaths(pr, { exec = execFileSyncThrottled, root = REPO_ROOT, repo = null } = {}) {
  try {
    const argv = ['pr', 'diff', String(pr), '--name-only'];
    if (repo) argv.push('--repo', repo);
    // #x5n4zn3 — was bare (no timeout).
    const out = exec('gh', argv, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, cwd: root,
      timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
    });
    return String(out || '').split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * we:scripts/conveyor/reconcile-fix-dispatch.mjs#fetchCardScopeAtRef — #xcla4iv's real card-scope reader: ONE
 * `gh api repos/<owner>/<repo>/contents/<path>?ref=<ref>` read (base64-decoded), parsed with the SAME
 * `gray-matter` reader `we:src/_data/backlog.js`'s own canonical loader uses — never a hand-rolled YAML scan,
 * so a card's `scope:` frontmatter is read identically here and there. This exists for exactly one population:
 * a backlog card filed IN the same PR that delivers it, so it is not yet committed to `main` and `findItem`
 * cannot see it — {@link resolvePrWorkUnit}'s own docblock has the full story. Best-effort, mirroring every
 * other `gh`-backed reader in this file: ANY failure (no `gh`, the path/ref not found, malformed frontmatter,
 * a missing/non-array `scope:`) degrades to `[]`, never throws — the caller ({@link resolvePrWorkUnit}) then
 * falls back to the PR's raw diff paths exactly as it does when the card simply declares no scope.
 *
 * `{owner}`/`{repo}` PLACEHOLDERS, not a literal slug: `gh api` (unlike `gh pr diff`) has no `--repo` flag —
 * these placeholders resolve from the given `repo` (when it names one — `GH_REPO`-style, via the endpoint
 * template itself) or, when `repo` is `null`, from the checkout's own git remote at `cwd: root` (today's only
 * reachable case is WE itself, whose checkout IS `chalbert/web-everything`).
 * @param {string} path - repo-relative, e.g. `backlog/xzi292i-....md`.
 * @param {string} ref - a commit sha (the PR's own `headRefOid`).
 * @param {{exec?:Function, root?:string, repo?:string|null}} [o]
 * @returns {string[]}
 */
export function fetchCardScopeAtRef(path, ref, { exec = execFileSyncThrottled, root = REPO_ROOT, repo = null } = {}) {
  try {
    const endpoint = `repos/${repo || '{owner}/{repo}'}/contents/${path}?ref=${ref}`;
    const out = exec('gh', ['api', '--method', 'GET', endpoint, '--jq', '.content'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 * 1024 * 1024, cwd: root,
      timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
    });
    const decoded = Buffer.from(String(out || '').trim(), 'base64').toString('utf8');
    const { data } = matter(decoded);
    return Array.isArray(data?.scope) ? data.scope.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * we:scripts/conveyor/reconcile-fix-dispatch.mjs#findResumeCandidate — `#xu2krte` Fork 1: is there a session to
 * PREFER resuming for this conflict-caused fix dispatch? PURE over its two inputs.
 *
 * Extracts the PR's own `authored-by-actor` stamp (`we:scripts/lib/review-independence.mjs#parseAuthorActorId`
 * — agreement-or-nothing: a missing or ambiguous stamp answers `''`, never a guess) and confirms it is still
 * LISTED in `claude agents --json --all` before ever recommending a resume attempt. A session that has fully
 * exited (and been reaped, e.g. by `we:scripts/conveyor/session-reaper.mjs`) is not a resume candidate at all —
 * the caller goes straight to a fresh dispatch, per the ratified default, rather than attempting a resume
 * against a listing that cannot even confirm the session ever existed.
 * @param {{body:string|null, agentsAll:Array<object>}} o
 * @returns {string|null} the full `sessionId` to attempt resuming, or `null`.
 */
export function findResumeCandidate({ body, agentsAll }) {
  const id = parseAuthorActorId(String(body || ''));
  if (!id) return null;
  const norm = normalizeHandle(id);
  const listed = (Array.isArray(agentsAll) ? agentsAll : []).some((a) => normalizeHandle(a?.sessionId) === norm);
  return listed ? id : null;
}

/**
 * we:scripts/conveyor/reconcile-fix-dispatch.mjs#buildResumePrompt — `#xu2krte` Fork 1: the SHORT prompt a
 * resume attempt injects, as opposed to the full `fix-agent-brief.md` a fresh dispatch fills. PURE.
 *
 * DELIBERATELY NOT THE FULL BRIEF. The brief's own step 1 is "acquire a lane" — correct for a session that does
 * not have one yet, wrong for a session this call is trying to hand back its OWN existing context and (when
 * known) its own checkout. This names the one new fact (a fresh conflict on a specific PR) and points at the
 * SAME brief's own conflict-handling + escalation rules by reference, rather than duplicating them here — a
 * second, drifting copy of "how to resolve a conflict" is exactly the twin-template risk this whole item's Fork
 * 4 argues against one file over.
 * @param {{pr:number, itemNum:string|null, cwd?:string|null}} o - #xmtbdgs multi-repo slice 6: `itemNum` is
 *   `null` for an item-less PR (no backlog item names this repair) — the prompt then says so in plain words
 *   rather than printing a literal `item #null`.
 * @returns {string}
 */
export function buildResumePrompt({ pr, itemNum, cwd = null }) {
  const itemRef = itemNum ? `item #${itemNum}` : 'no backlog item';
  return [
    `New work on PR #${pr} (${itemRef}), which you previously worked: it has drifted into a real merge `
      + 'conflict against `main` since your last commit here — GitHub reports `mergeable: CONFLICTING`.',
    '',
    cwd
      ? `Your existing checkout (\`${cwd}\`) should still be the lane this PR's branch lives in — continue there.`
      : 'Continue in the lane this PR\'s branch already lives in.',
    '',
    'Resolve the conflict: rebase or merge `main`, resolve every conflicted hunk by reading BOTH sides\' intent ' +
      '(your own and whatever landed on `main` since), run the gate green, and push. If you cannot safely ' +
      "resolve it, follow `skills-src/conveyor/fix-agent-brief.md`'s own conflict-escalation step: run " +
      `\`node scripts/conveyor/stand-down.mjs ${pr} --reason=conflict\`, then report and stop — do not guess.`,
  ].join('\n');
}

/** we:scripts/conveyor/reconcile-fix-dispatch.mjs#freeLaneNumbers — the SAME `lane-pool.mjs list --acquirable
 *  --json` read `we:scripts/conveyor/tick-core.mjs`'s own IO shell uses to build `freeLanes`, reused rather than
 *  re-derived. A READ, not a lock — see the file header for why that is the correct trade here.
 * @param {{exec?:Function, root?:string, lanePoolRepo?:string|null}} [o] - `lanePoolRepo` is what
 *   `lane-pool.mjs --repo=` itself expects (`we:scripts/lib/repo-profile.mjs#repoProfile`'s own `lanePoolRepo`
 *   field — `.` for WE, an absolute checkout path for a sibling repo). Omitted/`null` falls back to whatever
 *   `lane-pool.mjs` itself defaults to with no `--repo=` (the cwd's own git toplevel — WE, in every real caller
 *   before multi-repo slice 5), so a pre-slice-5 caller sees byte-identical behaviour.
 * @returns {number[]} ascending lane ids currently acquirable, or `[]` on any read failure (fail-soft — the
 *   caller reports `no-lane` for every planned fix rather than throwing the whole pass over a `gh`/pool hiccup).
 */
export function freeLaneNumbers({ exec = execFileSync, root = REPO_ROOT, lanePoolRepo = null } = {}) {
  try {
    const argv = [join(root, 'scripts', 'lane-pool.mjs'), 'list', '--acquirable', '--json'];
    if (lanePoolRepo) argv.push(`--repo=${lanePoolRepo}`);
    // #x5n4zn3 — was bare (no timeout): this is literally the 2026-09-23 incident's own call shape
    // (`lane-pool.mjs list --acquirable`), the exact hang that filed this whole rollout.
    const out = exec('node', argv, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
      timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
    });
    const paths = JSON.parse(String(out || '[]'));
    return (Array.isArray(paths) ? paths : [])
      .map((p) => { const m = /lane-(\d+)\/?$/.exec(String(p)); return m ? Number(m[1]) : null; })
      .filter((n) => n != null)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * we:scripts/conveyor/reconcile-fix-dispatch.mjs#tryResumeFix — `#xu2krte` Fork 1: RESUME-OR-NOTHING, gated to
 * `planned.isConflict` ONLY, and — `#xazl9u3` — DELIBERATELY LANE-FREE. This is the resume-candidate check
 * itself, not a peek at one: it is the whole reason {@link runReconcileFixDispatch} can afford to check "will
 * this entry actually need a lane" BEFORE ever popping one from the free-lane pool. A conflict-caused bounce
 * that successfully resumes its original session uses NO lane at all — the original bug (#xazl9u3, filed
 * against PR #1966's own independent review) was that `runReconcileFixDispatch` popped a lane for EVERY planned
 * fix regardless, including this one, wasting it for nothing whenever a resume succeeded. Calling this function
 * first, and only falling through to a real `dispatchFix` (which DOES need a lane) when it reports `resumed:
 * false`, is the fix: a successful resume never removes a lane number from the pool in the first place.
 *
 * When the planned entry is a conflict-caused bounce (Fork 2/4's `merge-status:conflicting` label still present
 * at plan time) AND {@link findResumeCandidate} finds a still-listed original-builder session, this attempts
 * `buildAgentArgv({resumeSessionId})` — a bare `claude --bg --resume <id>` with no other flag, per that
 * function's own docblock and the live build-time probe backing it
 * (`docs/agent/platform-decisions.md#parked-pr-conflict-dispatched-not-scripted`). The outcome is checked
 * against a FRESH `claude agents --json --all` read ({@link resumeSucceeded}): a genuine resume returns
 * immediately (the resumed session already has the new work); anything else (the CLI forked a copy — observed
 * both when the original session was still "already running" per its own bookkeeping, and whenever the request
 * carried any flag besides `--resume`, though this call passes none) gets its accidental copy `claude stop`-ped
 * ({@link stopSession} — never a bare `kill`, per `#3383`'s own hard-won lesson), and the caller falls through
 * to a fresh dispatch (which DOES pop a lane) exactly as every other (non-conflict, or non-resumable) entry
 * already does.
 *
 * TWO HARDENINGS ADDED BY THE INDEPENDENT REVIEW OF PR #1966 (both real, both fixed here rather than merely
 * filed, because both sit on this exact security/correctness-critical dispatch surface):
 *
 * (1) OWNERSHIP CHECK BEFORE TRUSTING A CANDIDATE — TWO INDEPENDENT signals, both required (hardened again by
 * a SECOND review pass on PR #1966, which found the first cut's single HEAD-sha check alone was not enough:
 * two DIFFERENT lanes/PRs can share an identical HEAD commit, e.g. a lane freshly branched from another lane's
 * tip before either advances). `findResumeCandidate` alone only proves a session with the stamped id is STILL
 * LISTED — not that it actually belongs to THIS pr. A PR body's `authored-by-actor` stamp is plain, editable
 * text, visible in every other open PR's body too, so a forged/copied stamp could redirect a genuine conflict
 * fix into an unrelated LIVE session, injecting a false task into it. This mirrors exactly the binding problem
 * `reconcile-core.mjs#bindAgents` already solves for liveness with its OWN two-path union ("a union of weak
 * proxies raises confidence; either one ALONE does not") — reused here, not re-invented:
 *   (a) HEAD-SHA — {@link resolveLaneHead} (`reconcile-pass.mjs`) reads the candidate's own `cwd`'s real git
 *       `HEAD`, and it must equal `planned.headRefOid` (the PR's own head sha, threaded through by
 *       {@link planFixesFromReconcile}).
 *   (b) NAME — the candidate's own session `name` (assigned by whichever dispatcher started it, never
 *       attacker-controlled via a PR-body edit) must be one THIS pr's real original builder could legitimately
 *       carry: `conveyor-<itemNum>` (an ordinary build) or `fix-<pr>` (a prior fix-dispatch being resumed
 *       again) — `sessionSlugFor`'s own two relevant conventions, not a new naming scheme.
 * BOTH must hold. A mismatch on either (or an unresolvable `cwd`) is treated exactly like "no candidate" — no
 * resume attempt, no `stop`, straight to a fresh dispatch — because nothing was touched, there is nothing to
 * undo.
 *
 * (2) BOUNDED RETRY ON THE POST-RESUME LISTING READ. `#3331`'s own research already documents that
 * `claude agents --json` can lag the CLI's real state. A single, immediate post-spawn read could therefore miss
 * a listing update for a resume that genuinely succeeded, misreading it as a fork and `stop`-ping the very
 * session that was just handed new work. `resumeSucceeded` is re-checked up to
 * {@link RESUME_CONFIRM_MAX_ATTEMPTS} times with a short `wait` between attempts before this function concludes
 * "not resumed" — the same shape `#3331`'s own probe methodology already used (repeat rather than trust one
 * sample), just applied at dispatch time instead of at probe time.
 *
 * (3) `resumeSucceeded` HAS NO POSITIVE FALLBACK FOR A MISSING `id` (`#3541`, follow-up from PR #1966's
 * independent review — see that function's own docblock for the full story). Two candidate fallbacks were
 * built and both were found unsafe by independent review, the second time backed by a live measurement: a
 * fresh session's row can take far longer to appear in `claude agents --json --all` than any retry budget this
 * synchronous call site can afford (26+ seconds observed, against a ~600ms total retry window here). An `id`
 * match failing therefore still resolves `resumed:false` here, exactly as before `#3541` — the safe direction,
 * argued in `resumeSucceeded`'s own docblock: a false stop costs a wasted attempt and a redundant fresh
 * dispatch (recoverable), a false resume would silently drop the real work and leave a forked session
 * unmanaged (not recoverable without a person noticing). What DID change: `resumeSucceeded` now surfaces an
 * `anomaly` diagnostic when this never-yet-observed shape is actually hit, so it is visible on the record
 * (threaded onto the returned `resumeAttempt` below) rather than indistinguishable from an ordinary fork.
 * @param {{itemNum:string, pr:number, laneRef:string, scope:string[], isConflict?:boolean, body?:string|null, headRefOid?:string|null}} planned -
 *   NOTE: deliberately no `lane` field — this runs before one is ever assigned.
 * @param {object} [o]
 * @returns {{resumed:boolean, result?:{sessionId:string, sessionSlug:null, pr:number, itemNum:string, lane:null, unknownTokens:string[], resumed:true}, resumeAttempt?:object|null}}
 */
export function tryResumeFix(planned, {
  repo = 'we',
  root = REPO_ROOT,
  spawnAgent = defaultSpawnAgent,
  listAgentsAll = () => defaultListAgents({ all: true }),
  stop = stopSession,
  resolveHead = resolveLaneHead,
  wait = defaultConfirmWait,
} = {}) {
  // #x33jgwt multi-repo slice 5 — no repo gate HERE any more: `runReconcileFixDispatch` is the ONE place that
  // decides whether this repo's `fix` capability is on (`docs/agent/platform-decisions.md#conveyor-multi-repo-
  // model` clause 1, "capability, not repo identity"), before this function is ever called. This primitive is
  // repo-generic; `repo` only threads through to keep the resume-candidate's session-name check (below) and any
  // fresh dispatch fallback correctly repo-tagged.
  assertNotALaneCheckout(root);
  if (!planned.isConflict) return { resumed: false, resumeAttempt: null };

  const agentsBefore = listAgentsAll();
  const candidate = findResumeCandidate({ body: planned.body, agentsAll: agentsBefore });
  if (!candidate) return { resumed: false, resumeAttempt: null };

  const candidateRow = agentsBefore.find((a) => normalizeHandle(a?.sessionId) === normalizeHandle(candidate));
  // Hardening (1) — see the docblock above. TWO INDEPENDENT signals, both required, mirroring
  // `reconcile-core.mjs#bindAgents`'s own "union of weak proxies raises confidence; either one ALONE does
  // not" discipline for the identical binding question ("is this session really working THIS pr"):
  //   (a) HEAD-SHA — the candidate's real checkout HEAD must equal the PR's own `headRefOid`.
  //   (b) NAME — the candidate's OWN session name (assigned by whichever dispatcher started it — never
  //       attacker-controlled via a PR-body edit) must be one of the names THIS pr's own original builder
  //       could legitimately carry: `conveyor-<itemNum>` (an ordinary build dispatch) or `fix-<pr>` (a prior
  //       fix-dispatch being resumed again).
  // (a) alone is not enough: PR #1966's own review found two DIFFERENT lanes/PRs can share an identical HEAD
  // commit (e.g. a lane freshly branched from another lane's tip, before either advances) — the SAME sha
  // does not imply the SAME pr. (b) alone is not enough either (a name is a weaker proxy than a sha, per
  // `bindAgents`'s own docblock). Requiring BOTH closes the gap either check leaves open alone, without a
  // heavier mechanism (branch tracking, a lane-registry read) this file does not otherwise need.
  const candidateCwd = candidateRow?.cwd || null;
  const candidateHead = candidateCwd ? resolveHead(candidateCwd) : null;
  // #xmtbdgs multi-repo slice 6 — an item-less PR (`planned.itemNum === null`) never had an ordinary `build`
  // dispatch to begin with (there was no backlog item to build), so `conveyor-<itemNum>` is not a legitimate
  // name for ITS original builder to carry. Only compute that candidate name when an item actually exists;
  // `sessionSlugFor(null, 'build')` would otherwise throw (`mintSessionSlug` rejects a non-numeric, non-hash id).
  const expectedNames = new Set([
    ...(planned.itemNum ? [sessionSlugFor(planned.itemNum, 'build')] : []),
    sessionSlugFor(planned.pr, 'fix', null, '', repo),
  ]);
  const nameConfirmed = Boolean(candidateRow?.name && expectedNames.has(candidateRow.name));
  const headConfirmed = Boolean(planned.headRefOid && candidateHead && candidateHead === planned.headRefOid);
  const ownershipConfirmed = headConfirmed && nameConfirmed;
  if (!ownershipConfirmed) {
    return {
      resumed: false,
      resumeAttempt: {
        attempted: false, candidate, forked: false,
        refused: 'ownership-unconfirmed',
        why: `candidate session ownership not confirmed for PR #${planned.pr} — head match: ${headConfirmed} `
          + `(candidate ${candidateHead ?? 'unresolved'} vs pr ${planned.headRefOid ?? 'unknown'}), name match: `
          + `${nameConfirmed} (candidate ${JSON.stringify(candidateRow?.name ?? null)} not in `
          + `${JSON.stringify([...expectedNames])}) — refusing to trust an editable PR-body stamp alone`,
      },
    };
  }

  const resumeArgv = buildAgentArgv({
    payload: { prompt: buildResumePrompt({ pr: planned.pr, itemNum: planned.itemNum, cwd: candidateCwd }) },
    resumeSessionId: candidate,
  });
  let stdout = '';
  try { stdout = String(spawnAgent(resumeArgv, { cwd: root }) ?? ''); } catch { stdout = ''; }
  const printedId = parseBackgroundedId(stdout);

  // Hardening (2) — see the docblock above. A bounded retry, not an unbounded poll: each attempt is a
  // fresh `claude agents --json --all` read, so a listing that lags the CLI's real state by one tick still
  // resolves correctly on the next attempt, without ever risking stopping a genuinely resumed session on
  // the strength of a single early read.
  let outcome = { resumed: false, actualSessionId: null, actualShortId: null };
  for (let attempt = 1; attempt <= RESUME_CONFIRM_MAX_ATTEMPTS; attempt += 1) {
    outcome = resumeSucceeded({ printedId, requestedSessionId: candidate, agentsAfter: listAgentsAll() });
    if (outcome.resumed || attempt === RESUME_CONFIRM_MAX_ATTEMPTS) break;
    wait(RESUME_CONFIRM_WAIT_MS);
  }
  if (outcome.resumed) {
    return {
      resumed: true,
      result: {
        sessionId: candidate, sessionSlug: null, pr: planned.pr, itemNum: planned.itemNum, lane: null,
        unknownTokens: [], resumed: true,
      },
    };
  }
  // NOT a genuine resume: `resumeSucceeded` only answers true when a fresh listing confirms the requested
  // session is what actually resumed. Whatever process the CLI just started under `printedId` is therefore
  // either an accidental copy or unidentifiable — stop it (never the resumed target, which this branch by
  // construction did not reach) and fall through to a fresh dispatch, which the caller performs (and which
  // is the first point a lane is ever popped for this entry). `outcome.anomaly` (#3541) rides onto the record
  // here rather than being read for a verdict — see `resumeSucceeded`'s own docblock for why no fallback acts
  // on it.
  if (printedId) { try { stop({ handle: printedId }); } catch { /* best-effort cleanup only */ } }
  return {
    resumed: false,
    resumeAttempt: {
      attempted: true, candidate, forked: Boolean(printedId),
      ...(outcome.anomaly ? { anomaly: outcome.anomaly } : {}),
    },
  };
}

/**
 * we:scripts/conveyor/reconcile-fix-dispatch.mjs#dispatchFix — DISPATCH ONE FRESH FIX AGENT for one planned
 * entry that either isn't a conflict-caused resume candidate, or whose {@link tryResumeFix} attempt did not
 * resume. Mirrors `we:scripts/operations/review-dispatch.mjs#dispatchReview`'s own composition (plan → fill →
 * mint a fresh session id → spawn), reusing `dispatch-lane.mjs`'s real fill/dispatch primitives rather than this
 * file's own copies. Requires `planned.lane` — the caller ({@link runReconcileFixDispatch}) only calls this
 * AFTER popping one from the free-lane pool, which by construction only happens once {@link tryResumeFix} (when
 * relevant) has already reported `resumed: false` — see that function's own `#xazl9u3` docblock for why.
 *
 * IT PASSES THE DISPATCHED-AGENT SYSTEM PROMPT (#3606/#xqyyoje/#xy8di3v), AND UNTIL 2026-09-11 IT DID NOT —
 * the one dispatch path in the repo that was missing it. `createDispatchSinks` has always passed
 * `DISPATCHED_AGENT_SYSTEM_PROMPT_FILE` (so the tick-core-driven fix dispatch was covered) and
 * `review-dispatch.mjs` passes its own review-side twin (#xy8di3v). THIS function passed none, so a fix agent
 * dispatched by the reconcile pass met `fix-agent-brief.md` with nothing telling it the brief was real.
 *
 * The brief opens with *"**This is a TEMPLATE, not a runnable skill.**"* and keeps `{{PLACEHOLDERS}}` /
 * `{{LIKE_THIS}}` in its own explanatory prose (both legitimately unsubstituted — `fillBrief` reports them as
 * non-fatal unknown tokens by design), so a genuinely, correctly filled brief still READS as an unfilled
 * template. LIVE-CONFIRMED 3/3 on 2026-09-11: `fix-2127`, `fix-2130` and `fix-2003` each received a fully
 * substituted 16.5 KB brief naming their real PR — and each self-aborted with *"I don't see an actual task or
 * question in your message — just the fix-agent brief template (#2630) itself"*, doing no work at all. That is
 * exactly the #3606 failure `review-1998/2024/2027` hit on the review side, recurring on the one path the
 * remedy had never been wired into. The delivery-side file is the right one here (not the review twin): a fix
 * agent IS a `dispatch-lane`-shaped delivery agent — it acquires a lane, works an item, pushes to a PR.
 *
 * @param {{itemNum:string, pr:number, laneRef:string, scope:string[], lane:number}} planned
 * @param {object} [o]
 * @param {object|null} [o.resumeAttempt] - carried forward from a prior {@link tryResumeFix} call for this same
 *   entry, purely for reporting on the returned result (this function never attempts a resume itself).
 * @returns {{sessionId:string, sessionSlug:string, pr:number, itemNum:string, lane:number, unknownTokens:string[], resumed:false, resumeAttempt?:object}}
 */
export function dispatchFix(planned, {
  repo = 'we',
  root = REPO_ROOT,
  readBrief = (r) => readFileSync(fixBriefPath(r), 'utf8'),
  mintSessionId = () => randomUUID(),
  spawnAgent = defaultSpawnAgent,
  extraArgs = [],
  resumeAttempt = null,
  // #x8mpubm — same never-throwing, opt-in-gated resolver `we:scripts/operations/dispatch-lane-io.mjs`'s own
  // `createDispatchSinks` uses for a fresh build dispatch; a fix dispatch is a SEPARATE fresh-dispatch call
  // site (see the `buildAgentArgv` call below) so it needs its own seam, but reuses the SAME wrapper rather
  // than re-deriving the gh-app-shim.mjs composition here.
  resolveSettingsEnv = resolveGhShimSettingsEnv,
  // #x33jgwt multi-repo slice 5 — threaded straight through to `briefTokensForRepo`/`repoProfile`/`gateFor`
  // (all three already accept them), never re-derived here. Before this slice only `we` ever reached this
  // function, and WE's own checkout + real `homedir()` are always correct/present wherever this process runs,
  // so nothing injected these. A sibling repo's checkout is NOT guaranteed present (or, in a test, must not be
  // touched at all — see `constellation-repos-profile.test.mjs`'s own "hermetic" header), so a real dispatch for
  // a sibling repo — and every test of one — needs these seams open.
  home,
  checkoutExists,
  readPackageJson,
} = {}) {
  // #x33jgwt multi-repo slice 5 — no repo gate HERE any more (see {@link tryResumeFix}'s own docblock for why):
  // `runReconcileFixDispatch` already refused a repo whose profile lacks the `fix` capability before this ever
  // runs. `briefTokensForRepo` still fails closed (`null`) for a genuinely unknown/unresolvable profile below.
  assertNotALaneCheckout(root);

  const sessionSlug = sessionSlugFor(planned.itemNum, 'fix', planned.pr, '', repo);
  // #3960 — the repo-aware quintet, computed once from `repo`'s own profile (never re-derived here). The
  // token computation itself is repo-generic, so slice 5's capability gate (moved up to
  // `runReconcileFixDispatch`) needed no change here at all.
  const tokens = briefTokensForRepo(repo, { itemNum: planned.itemNum, prNum: planned.pr, home, checkoutExists, readPackageJson });
  if (!tokens) throw new Error(`dispatch-lane: no repo profile/gate resolved for "${repo}" — refusing to fill the fix brief`);
  // #xmtbdgs multi-repo slice 6 — an item-less PR (`planned.itemNum === null`) has no real number to fill
  // `{{ITEM_NUM}}` with; `''` is the honest value (never a fabricated number), and `ITEM_NUM` is allowed to
  // resolve blank ONLY for this population (`tokens.ATTRIBUTION` is already `PR #<n>` in this case —
  // `briefTokensForRepo` computed that from the same `itemNum: null` above, with zero extra logic needed here).
  const optionalNames = planned.itemNum ? undefined : [...OPTIONAL_BRIEF_PLACEHOLDERS, 'ITEM_NUM'];
  const { prompt, unknownTokens } = fillBrief(readBrief(root), {
    ITEM_NUM: planned.itemNum ?? '',
    PR_NUM: planned.pr,
    LANE_REF: planned.laneRef,
    LANE: planned.lane,
    SESSION_SLUG: sessionSlug,
    SCOPE: planned.scope.join(','),
    ...tokens,
  }, BRIEF_REQUIRED_BY_KIND.fix, optionalNames, REPO_AWARE_VALUE_PATTERNS);
  const sessionId = String(mintSessionId());
  const argv = buildAgentArgv({
    sessionId,
    payload: { prompt, sessionSlug },
    // #3606 — see this function's own docblock: without this the fix agent reads a correctly-filled brief as an
    // unfilled template and self-aborts (3/3 live).
    systemPromptFile: DISPATCHED_AGENT_SYSTEM_PROMPT_FILE,
    extraArgs,
    // #x8mpubm — see `resolveSettingsEnv`'s own param comment above; resolved once, here, for this FRESH
    // dispatch only (never for `tryResumeFix`'s own `buildAgentArgv` call, which must stay a bare
    // `--bg --resume` with no other flag — see that function's docblock). #x8mpubm follow-up (live-caught
    // 2026-09-24) — `root` is now threaded through so the durable `.claude/settings.local.json` delivery
    // (`gh-app-shim.mjs#ensureSettingsFileEnv`) writes into the SAME checkout this dispatch starts in,
    // matching `review-dispatch.mjs#dispatchReview`'s own fix for the identical gap.
    settingsEnv: resolveSettingsEnv(root),
  });
  // #3331 — READ THE REAL ID BACK OFF STDOUT, exactly as the resume branch above already does. `claude --bg`
  // discards `--session-id` and assigns its own, so the minted uuid addresses nothing; `agentId` is what
  // `claude agents`/`logs`/`stop` take. `sessionId` stays on the result for callers that already read it.
  const stdout = String(spawnAgent(argv, { cwd: root }) ?? '');
  return {
    sessionId, agentId: parseBackgroundedId(stdout),
    sessionSlug, pr: planned.pr, itemNum: planned.itemNum, lane: planned.lane, unknownTokens,
    resumed: false, ...(resumeAttempt ? { resumeAttempt } : {}),
  };
}

/**
 * we:scripts/conveyor/reconcile-fix-dispatch.mjs#runReconcileFixDispatch — the WHOLE pass: read
 * `reconcile-pass.mjs`'s plan (reused, not re-run by hand), narrow it to dispatchable fixes
 * ({@link planFixesFromReconcile}), and for each — `#xazl9u3` — try a lane-free resume FIRST, only assigning a
 * currently-free lane and running a full fresh dispatch when that resume attempt does not pan out. Read-then-
 * act, exactly like its siblings; a failure dispatching ONE entry is reported and does not stop the rest.
 *
 * `#xazl9u3` — WHY THE ORDER MATTERS. The bug this fixed: this loop used to pop a lane for EVERY planned entry
 * unconditionally, before ever asking whether the entry would actually use one — including a conflict-caused
 * entry that goes on to resume its original session and touches no lane at all. In a tick where free lanes are
 * scarce, that wasted one for nothing (self-correcting next tick, since {@link freeLaneNumbers} re-reads the
 * pool fresh, but still a real waste in the meantime). Calling {@link tryResumeFix} BEFORE `lanes.shift()` means
 * a successful resume returns straight into `dispatched` and `continue`s to the next entry having never touched
 * `lanes` — the pool is left exactly as {@link pickFreeLanes} produced it for every entry that resolves via
 * resume.
 *
 * #x33jgwt (multi-repo slice 5) — THE REPO GATE LIVES HERE, ON CAPABILITY, NOT IDENTITY
 * (`docs/agent/platform-decisions.md#conveyor-multi-repo-model` clause 1). This function reads `repo`'s profile
 * ONCE and asks two INDEPENDENT questions of it — `fix` and `ci-heal` are separate stages/capabilities, each
 * with its own on/off switch, not one "is this repo supported at all" bit:
 *   - `!profile.capabilities.fix` → this whole pass is a no-op for the repo: every `fix` entry `reconcile-pass`
 *     offered is recorded `unsupported-repo` (never touching the lane pool or a dispatch sink), exactly as
 *     EVERY non-WE repo behaved before this slice. Only `we` was ever missing this bit before; frontierui and
 *     plateau-app both flip it on in `repo-profile.mjs` as part of this same slice, so in practice this branch
 *     is only reachable today via an injected `resolveProfile` (see below) — a real, un-injected call never
 *     takes it for a real constellation repo, but the check itself must stay capability-shaped so the NEXT repo
 *     this constellation ever grows (with `fix` genuinely off) is refused for the right reason, not silently
 *     let through because it happens to resolve to *some* profile.
 *   - `!profile.capabilities.ciHeal` → independently of the above, any `ci-heal` entry in the SAME
 *     `reconcile-pass` reading is recorded `unsupported-repo` too (CI-heal was its own stage, held off `fix`'s
 *     switch, until multi-repo slice 7, `we:backlog/3967-*.md`, turned it on for frontierui/plateau-app too —
 *     both now resolve `ciHeal: true` in `repo-profile.mjs`, so a real call takes this branch only via an
 *     injected `resolveProfile` reporting it off, same as the `fix` branch above). This file dispatches no
 *     `ci-heal` itself EITHER WAY — that is `we:scripts/operations/ci-heal-pr-dispatch.mjs
 *     #runReconcileCiHealDispatch`'s own job, reading this SAME `reconcile-pass` output — so when the
 *     capability is on, a `ci-heal` entry is simply absent from both `dispatched` and `refusals` here (that
 *     other file is where it is acted on, or refused). Recording the refusal HERE only when the capability is
 *     off preserves the exact visibility the pre-slice-5 blanket branch gave every non-WE repo's ci-heal
 *     population, now scoped to its own capability instead of riding on `fix`'s.
 * Both checks read the SAME `profile`, computed once, never re-derived per entry or per kind.
 * @param {object} [o]
 * @param {Function} [o.reconcile] - injectable, defaults to the real {@link runReconcilePass}.
 * @param {Function} [o.tryResume] - injectable, defaults to the real {@link tryResumeFix}.
 * @param {Function} [o.resolveFallbackScope] - injectable, defaults to the real {@link fetchPrDiffScope} (one
 *   `gh pr diff --name-only` per entry that reaches it — see {@link planFixesFromReconcile}'s own docblock for
 *   why this is only ever called once a declared `scope:` has already come back empty, never unconditionally).
 * @param {Function} [o.resolveProfile] - injectable, defaults to the real {@link repoProfile}; a pure lookup, so
 *   the only reason a test ever overrides it is to exercise a `capabilities.fix === false` repo now that every
 *   REAL constellation repo profile has `fix` on (see the docblock above).
 * @param {Function} [o.pickFreeLanes] - injectable; when omitted, defaults to {@link freeLaneNumbers} scoped to
 *   THIS repo's own lane pool (`profile.lanePoolRepo`) — never the WE pool for a non-WE repo.
 * @returns {{dispatched:Array<object>, refusals:Array<object>, reconcileRefusals:number}}
 */
export function runReconcileFixDispatch({
  root = REPO_ROOT,
  repo = null,
  findItemFn = findItem,
  loadItems = () => defaultLoadItems(root),
  pickFreeLanes = null,
  tryResume = tryResumeFix,
  dispatch = dispatchFix,
  reconcile = runReconcilePass,
  resolveFallbackScope = (pr) => fetchPrDiffScope(pr, { root, repo }),
  // #xmtbdgs multi-repo slice 6 — the item-less diff read; UN-prefixed (see `planFixesFromReconcile`'s own
  // docblock for why this is a distinct binding from `resolveFallbackScope` above, which IS prefixed). #xcla4iv
  // — ALSO now reused for the named-item branch's card-in-diff check (see that call site's own comment).
  fetchItemlessDiffPaths = (pr) => fetchPrDiffPaths(pr, { root, repo }),
  // #xcla4iv — reads one backlog card's own committed `scope:` at a specific ref, for the file-item-in-PR
  // population {@link planFixesFromReconcile}'s docblock describes.
  resolveCardScopeAtRef = (path, ref) => fetchCardScopeAtRef(path, ref, { root, repo }),
  resolveProfile = repoProfile,
  checkStaleness,
  prsFile, unsupportedPath,
} = {}) {
  const repoKey = repo == null ? 'we' : repoKeyForSlug(repo);
  if (repoKey === null) throw new Error(`reconcile-fix-dispatch: --repo ${repo} is not a constellation repo`);
  // #x1rr9rh (multi-repo slice 2) — this staleness check guards the DISPATCHING checkout (this WE checkout's
  // own import path), not the target repo: the fix path always runs WE's own code, whatever repo it dispatches
  // (or, for an unsupported repo, merely records as unsupported) a fix for. Gating it on `repoKey === 'we'`
  // was therefore the wrong condition — it let a stale WE checkout record foreign-repo unsupported rows (and
  // will, once fix dispatch is turned on for that repo, dispatch fixes) from code that had already been proven
  // stale. Run it for every repo.
  assertMainNotStale(root, checkStaleness);
  const reconciled = reconcile({ repo, ...(prsFile ? { readPrs: () => readPrsFromFile(prsFile) } : {}) });
  const dispatchEntries = Array.isArray(reconciled.dispatch) ? reconciled.dispatch : [];
  const profile = resolveProfile(repoKey);

  const unsupportedFor = (kind, action, why) => dispatchEntries
    .filter((entry) => entry.kind === kind)
    .map((entry) => ({ kind: 'unsupported-repo', repo: repoKey, prNumber: entry.prNumber, action, why }));

  // CI-heal is a capability of its own — refused independently of whatever `fix` decides below (see this
  // function's own docblock).
  const ciHealRefusals = profile?.capabilities?.ciHeal ? [] : unsupportedFor(
    'ci-heal', 'ci-heal', 'CI-heal dispatch requires a repo-specific brief and gate; the existing worker is WE-only.',
  );

  if (!profile?.capabilities?.fix) {
    // This repo's fix stage is off entirely: every `fix` entry is unsupported, never touching the lane pool or
    // a dispatch sink. Durable ledger write mirrors the pre-slice-5 blanket branch exactly — preserve any
    // already-recorded `review` rows for this repo (a DIFFERENT stage this file knows nothing about), replace
    // its `fix`/`ci-heal` rows with what THIS pass just computed.
    const fixRefusals = unsupportedFor(
      'fix', 'fix', 'Fix dispatch requires a repo-specific brief and gate; the existing worker is WE-only.',
    );
    const refusals = [...fixRefusals, ...ciHealRefusals];
    const reviews = readUnsupported({ path: unsupportedPath }).filter((row) => row.repo === repoKey && row.action === 'review');
    recordUnsupported({ repo: repoKey, rows: [...reviews, ...refusals], path: unsupportedPath });
    return { dispatched: [], refusals, reconcileRefusals: reconciled.refusals.length };
  }
  // `fix` IS supported here — still durably record any ci-heal refusals (a separate capability, possibly still
  // off), preserving prior `review` rows exactly as above.
  if (ciHealRefusals.length) {
    const reviews = readUnsupported({ path: unsupportedPath }).filter((row) => row.repo === repoKey && row.action === 'review');
    recordUnsupported({ repo: repoKey, rows: [...reviews, ...ciHealRefusals], path: unsupportedPath });
  }
  const { planned, refusals: planRefusals } = planFixesFromReconcile(dispatchEntries, findItemFn, loadItems, resolveFallbackScope, repoKey, fetchItemlessDiffPaths, resolveCardScopeAtRef);
  const refusals = [...ciHealRefusals, ...planRefusals];

  // Lanes: THIS repo's own pool (`profile.lanePoolRepo` — `.` for WE, an absolute checkout path for a sibling
  // repo), never the WE pool for a non-WE repo (#x33jgwt).
  const lanes = [...(typeof pickFreeLanes === 'function' ? pickFreeLanes() : freeLaneNumbers({ root, lanePoolRepo: profile.lanePoolRepo }))];
  const dispatched = [];
  for (const entry of planned) {
    // #xazl9u3 — ask "would a resume work?" BEFORE ever touching the lane pool. Only a conflict-caused entry
    // is even eligible (tryResumeFix itself returns `resumed: false, resumeAttempt: null` immediately for any
    // other kind, at no lane cost either way).
    //
    // PR #1972 review finding (correctness) — this call must be its OWN try/catch, isolated from the
    // dispatch try/catch below: `tryResumeFix` does real IO (`claude agents --json --all`, a real `git
    // rev-parse HEAD` via `resolveHead`) the file's own docblocks already document as a real observed source
    // of flakiness (#3331's listing lag). Left unguarded, a throw here would abort the WHOLE pass (every
    // OTHER planned entry in this tick, including unrelated ordinary dispatches that would have succeeded)
    // rather than refusing just this one entry — the same per-entry isolation `dispatch(...)` below already
    // gets, now extended to cover this earlier call site too.
    let resumeAttempt = null;
    if (entry.isConflict) {
      let attempt;
      try {
        attempt = tryResume(entry, { root, repo: repoKey });
      } catch (e) {
        refusals.push({ pr: entry.pr, kind: 'dispatch-failed', why: String((e && e.message) || e).split('\n')[0] });
        continue;
      }
      if (attempt.resumed) {
        dispatched.push(attempt.result);
        continue; // no lane ever popped for this entry
      }
      resumeAttempt = attempt.resumeAttempt;
    }

    if (lanes.length === 0) {
      refusals.push({ pr: entry.pr, kind: 'no-lane', why: `no free lane to dispatch a fix agent for PR #${entry.pr}` });
      continue;
    }
    const lane = lanes.shift();
    try {
      dispatched.push(dispatch({ ...entry, lane }, { root, repo: repoKey, extraArgs: agentArgsFromEnv(), resumeAttempt }));
    } catch (e) {
      refusals.push({ pr: entry.pr, kind: 'dispatch-failed', why: String((e && e.message) || e).split('\n')[0] });
    }
  }

  return { dispatched, refusals, reconcileRefusals: reconciled.refusals.length };
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const flags = {};
  for (const a of process.argv.slice(2)) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  let result;
  try {
    result = runReconcileFixDispatch({ repo: typeof flags.repo === 'string' ? flags.repo : null, prsFile: flags['prs-file'] });
  } catch (e) {
    process.stderr.write(`✗ reconcile-fix-dispatch failed: ${String((e && e.message) || e).split('\n')[0]}\n`);
    process.exit(1);
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    const lines = [`reconcile-fix-dispatch — ${result.dispatched.length} dispatched, ${result.refusals.length} refusal(s)`];
    for (const d of result.dispatched) {
      const laneInfo = d.resumed ? 'no lane (resumed)' : `lane-${d.lane}`;
      // #3331 — report the ADDRESSABLE id (`claude logs/stop` take it) when we have one; a resume reports the
      // session it continued, and an unparseable spawn falls back to the slug, which `claude agents` carries.
      const who = d.agentId ? `agent ${d.agentId}` : (d.resumed ? `session ${d.sessionId}` : 'agent (id unread)');
      // #xmtbdgs multi-repo slice 6 — `d.itemNum` is `null` for an item-less PR; print "no backlog item"
      // rather than a literal "item #null".
      const itemLabel = d.itemNum ? `item #${d.itemNum}` : 'no backlog item';
      lines.push(`  → fix    PR #${d.pr} (${itemLabel}) — ${who} (${d.sessionSlug}), ${laneInfo}`);
    }
    for (const r of result.refusals) lines.push(`  ✗ ${r.kind} PR #${r.prNumber ?? r.pr} — ${r.why}`);
    process.stdout.write(lines.join('\n') + '\n');
  }
}
