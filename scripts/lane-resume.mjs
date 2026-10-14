#!/usr/bin/env node
/**
 * lane-resume.mjs — discover STUCK ready-to-merge lanes and plan their takeover (#2200).
 *
 * The consumer side of a recurring situation: a producer (`/workflow`, `/batch`) opens a
 * `ready-to-merge` PR per item, but some never land — a conflict with a peer that landed first, a red
 * required `test` (the lane shipped a real bug), or a `blockedBy` item that isn't landed yet. `/drain`
 * only lands couples that are ALREADY ready; it skips these. This engine finds them, says WHY each is
 * stuck, and orders them so the `/resume` skill can hand each to a finisher subagent (seeded with the
 * EXISTING lane ref — reuse the ~done work, repair only the broken part) and then land it via the
 * normal drain transport.
 *
 * Subcommands:
 *   node scripts/lane-resume.mjs discover [--json]     # classify + blockedBy-order every stuck lane
 *   node scripts/lane-resume.mjs discover --this-repo  # scope to the cwd repo only (default = all 3 repos)
 *   node scripts/lane-resume.mjs discover --repos=owner/a,owner/b   # an explicit repo set
 *   node scripts/lane-resume.mjs discover --window-days=N   # pr-missing age window (default 7; see PR-MISSING)
 *   node scripts/lane-resume.mjs land <pr> [--repo=owner/name] [--dry-run] [--json]   # land ONE stuck lane PR (#2202)
 *   node scripts/lane-resume.mjs open <laneRef> [--repo=owner/name] [--json]   # open the PR for a pushed-but-PR-less lane ref (#xcf4556)
 *   node scripts/lane-resume.mjs rebuild-plan [--spec=<file>|-]     # plan a repaired link's descendant-tail rebuild (#2396); `landed` derives from positive on-main proof (bornAs / status:resolved) when not supplied
 *   node scripts/lane-resume.mjs rebuild <laneRef> --onto=<sha>     # rebuild ONE descendant tip onto the repaired parent tip (#2396)
 *
 * MULTI-REPO (#2383 — parity with `/drain`'s #2287 constellation-default): `discover` sweeps ALL 3
 * constellation repos BY DEFAULT (WE + frontierui + plateau-app, self first), reusing the SAME `resolveRepos`
 * from `merge-ai-prs.mjs`. Every gh call is `--repo`-scoped; a remote lane reads its manifest via the GitHub
 * API and lands through that repo's sibling clone (deferred to the drain, #2263). The backlog is WE-global, so
 * a remote lane's `blockedBy` still resolves against the one WE backlog. Opt out with `--this-repo`.
 *
 * PR-MISSING (#xcf4556) — a lane can finish (commit + resolve its card + `git push`) and still never get a PR:
 * the live case was a `/workflow` orchestrator ending while a lane agent sat inside `pr-land` waiting on
 * required checks, so `gh pr create` never ran. That work is invisible to the labelled-PR sweep above AND to
 * `/drain` (which only lands what's already labelled). `discover` additionally enumerates every remote
 * `lane/*` ref per repo (local git for the cwd repo, the SAME sibling clone `../frontierui`/`../plateau-app`
 * the drain's rebase-drop plumbing already depends on for a remote one, #2263 — a repo with no sibling clone
 * provisioned is simply skipped for this bucket, fail-soft) and buckets a ref `pr-missing` when it has NO PR
 * in ANY state (open, merged, OR a deliberately-closed one — a human closing a PR is a decision, never
 * silently overridden), its tip is NOT already an ancestor of `origin/main` (nothing landed already), it
 * carries a real non-manifest delivery (any file besides `.lane-manifest.json` changed against main — an
 * empty/aborted lane is not a finished delivery), and its tip commit is within `--window-days` of now (default
 * 7 — an ancient orphan reads as abandoned, not mid-flight, and `/finish` never resurrects one silently). The
 * item it delivers, when derivable, comes from the lane manifest first, then a `resolve #NNN` commit subject,
 * then a changed `backlog/NNN-*.md` file's own id. `open <laneRef>` then opens the PR for exactly one such ref
 * through the SAME transport every lane uses — `scripts/pr-land.mjs --label-on-green` (never a raw
 * `gh pr create`) — refusing when a PR already exists for that head (any state), the tip is already on main,
 * or the card it resolves is already `status: resolved` on main by a DIFFERENT commit (a human/finisher must
 * reconcile which delivery is real first).
 *
 * LAND (#2202, #2290) — the durable, tested version of the 2026-07-03 scratchpad plumbing. Reuses the ONE #2198
 * rebase-drop-manifest helper (`scripts/lib/rebase-drop-manifest.mjs`, shared with the label lander): for a PR
 * whose required `test` is green but which is only CONFLICTING/BEHIND, it rebuilds the tip onto main (manifest
 * dropped) via pure plumbing — no branch checkout. #2290: lane-resume NO LONGER merges directly — the drain is
 * the sole writer to main. Instead it ENQUEUES (ensures the `ready-to-merge` label) and TRIGGERS a single-couple
 * drain pass (`merge-ai-prs.mjs --only=<pr>`) that lands the recovered lane through the shared gate. A red `test`
 * (a real bug) or a real (non-manifest) conflict is NOT enqueued — the finisher repairs code first. `UNSTABLE` +
 * `test=pass` IS mergeable (only `test` is required; `cla`/Workers-Builds are non-required). So `/finish` =
 * discover-then-repair-then-`land` (enqueue + trigger the drain, which shares the same helper).
 *
 * Guard-safe: read-only `discover` (git show / gh list); `land` only pushes to a `lane/*` ref (the #1934
 * carve-out) + labels/triggers the drain — never a branch checkout, never a direct `gh pr merge` (any such
 * merge would be rejected by `scripts/lib/pr-merge-gate.mjs`). Fails soft — a PR whose manifest can't be read is
 * reported as `unknown`, never crashes the plan.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath, join as joinPath } from 'node:path';
import { tmpdir } from 'node:os';
import { rebaseDropManifest, gitRunner } from './lib/rebase-drop-manifest.mjs';
// #2396 — resolve a stackParent's landed status via the durable bornAs-on-main proof (#2392): `landedNumberFor`
// greps origin/main's backlog for the birth-hash record, `isHash`/`asItemId` are the shared id semantics the
// drain's own proof-of-land gate uses (numeric NNN = post-land by JIT numbering, #2288). All import-safe
// (CLI-guarded modules already in this file's import graph via merge-ai-prs).
// #2410 slice D — the required-`test`-green classifier is single-sourced in lane-drain.mjs (the drain family's
// ONE reader of a required-check conclusion). lane-resume routes BOTH its `landDecision` gate and `classifyLane`'s
// `testRed` signal through it, RETIRING lane-resume's own hand-rolled FAIL list (the separate red-CI strand the
// #2410 capstone folds into the unified land condition). Import-safe (lane-drain is CLI-guarded).
import { landedNumberFor, requiredCheckState } from './lane-drain.mjs';
import { isHash } from './backlog/id.mjs';
import { asItemId } from './readiness/lane-manifest.mjs';
// #2396 — a broken stacked LINK is a lane the finisher must repair before its overlap-descendants can be
// rebuilt onto the repaired tip. "Broken" = a red required `test` (a real bug) OR a `review:changes` label
// (a human bounced the diff). Reuse the ratified verdict-label set + its tolerant reader, never re-parse names.
import { REVIEW_LABELS, hasReviewLabel, readyMergeConflictsWithHold } from './lib/review-escalation.mjs';
import { OPEN_PR_LIST_LIMIT, filterOpenPrsByLabel } from './lib/no-search-backed-pr-list.mjs';
// #2383 — reuse the SAME constellation repo-resolution as `/drain` (`merge-ai-prs.mjs`), so `/finish` sweeps
// all 3 repos (WE + frontierui + plateau-app) by default instead of only the cwd repo. `merge-ai-prs.mjs` is
// CLI-guarded (runs nothing on import), so this is a pure function import.
import { resolveRepos, latestRequiredCheck, siblingCloneName } from './merge-ai-prs.mjs';
// #2399 — the ONE remote-manifest `gh api` argv, shared with the drain so the two readers never drift.
// Re-exported to keep this file's public surface (and its tests' import site) stable.
import { remoteManifestApiArgs } from './lib/remote-manifest.mjs';
export { remoteManifestApiArgs };
// #2396 — `resolvedOnMain` must read `status:` INSIDE the frontmatter block, never anywhere in the file:
// a body can carry a column-0 `status: resolved` (e.g. a fenced frontmatter example). `readField` parses
// only the first `---`…`---` block — the same splice-scoped reader the backlog status verbs use.
import { readField } from './backlog/frontmatter.mjs';
import { writeAllSync } from './lib/write-all-sync.mjs';
// #xcf4556 review: pr-land's report is read through open-pr's ONE classifier, never re-parsed here.
import { classifySubmit } from './operations/open-pr.mjs';

/**
 * The ONE frontmatter-strict "is this backlog doc `status: resolved` on main?" predicate (#2455). BOTH
 * on-main resolved readers route through it — the discover blocker-gate (`resolvedItemSet`) and the
 * rebuild proof-of-land (`resolvedOnMain`) — so a body-text `status: resolved` (a fenced frontmatter
 * example in prose) can never be read as landed by one path while the other correctly refuses, and a future
 * proof-format change lands here once instead of drifting. `readField` parses only inside the first
 * `---`…`---` block, so body content never counts.
 * @param {string} doc  the backlog file's full text
 * @returns {boolean}
 */
function docIsResolved(doc) {
  return readField(doc, 'status') === 'resolved';
}

const READY_LABEL = 'ready-to-merge';

/** The cwd repo's "owner/name" slug (from origin), or null if underivable. Same derivation as merge-ai-prs. */
export function localSlug() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    return m ? m[1] : null;
  } catch { return null; }
}

// ─────────────────────────── pure logic (exported, unit-tested) ───────────────────────────

/**
 * Classify ONE lane's takeover disposition from its already-collected signals.
 * @param {{num:number, mergeable:string, mergeState:string, testConclusion:string|null,
 *          item:number|null, repos:Array<{repo:string,ref:string,carriesResolve?:boolean}>,
 *          blockedBy:number[], stackParents?:Array<number|string>, reviewChanges?:boolean}} pr
 * @param {Set<number>} resolvedItems — items whose backlog file is status:resolved on main (blocker landed)
 * @returns {{num, item, repos, blockedBy, stackParents, reviewChanges, testRed, crossRepo, disposition, reason}}
 *   disposition ∈ 'ready' | 'conflict' | 'test-red' | 'review-changes' | 'blocked' | 'unknown'
 */
export function classifyLane(pr, resolvedItems, closedItems = new Set()) {
  if (closedItems.has(pr.item)) return { ...pr, disposition: 'blocked', reason: `target #${pr.item} is closed — reopen before resuming` };
  const blockedBy = pr.blockedBy || [];
  const unlanded = blockedBy.filter((b) => !resolvedItems.has(b));
  const crossRepo = (pr.repos || []).some((r) => r.repo && r.repo !== 'we');
  // #2396 — carry the stacked-chain signals through so `markStackDescendantsBlocked` can re-bucket a broken
  // link's overlap-descendants. `reviewChanges` (a human bounced the diff) is, like a red `test`, a broken link.
  // `testRed` is carried as a RAW flag (not just the disposition) so a lane whose disposition is overwritten by
  // the 'BLOCKED wins' rule below still reads as a broken link — otherwise a blockedBy+red-test lane would mask
  // its breakage and its stacked descendants would stay 'ready' and land past the unrepaired parent.
  const stackParents = pr.stackParents || [];
  const reviewChanges = pr.reviewChanges === true;
  // #2410 slice D — the broken-link signal is now the single-sourced `red` state (any definitive failing
  // conclusion — FAILURE / CANCELLED / TIMED_OUT / …), not a hand-rolled FAILURE-only check, so a cancelled or
  // timed-out required check is correctly treated as a lane bug too. `pending`/`green`/absent → not red.
  const testRed = requiredCheckState(pr.testConclusion) === 'red';
  const base = { num: pr.num, item: pr.item ?? null, repos: pr.repos || [], blockedBy, stackParents, reviewChanges, testRed, crossRepo };

  // BLOCKED wins: a finisher cannot land a lane whose blocker isn't on main yet (impl-first / dep-first).
  if (unlanded.length) return { ...base, disposition: 'blocked', reason: `blockedBy not landed: ${unlanded.join(',')}` };

  // A red required check means the lane shipped a real bug — the finisher must FIX code, not just rebase.
  if (testRed)
    return { ...base, disposition: 'test-red', reason: 'required `test` check is red (lane bug to fix)' };

  // #2396 — a `review:changes` bounce means a human rejected the diff: like a red test, the finisher must
  // REPAIR the code first. It must NEVER bucket 'ready' (green CI + mergeable is irrelevant — the drain's
  // #2366 hard refusal would park it anyway; here we keep it out of the auto-land list at the source).
  if (reviewChanges)
    return { ...base, disposition: 'review-changes', reason: 'review:changes — a human bounced the diff (repair before any land)' };

  // A conflict is repairable by rebase-onto-main + resolve (+ regen derived artifacts) — mechanical.
  if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY')
    return { ...base, disposition: 'conflict', reason: 'conflicts with main (rebase + resolve)' };

  // Clean + green ⇒ not stuck at all; `/drain` will take it. Surfaced so the plan is complete.
  if (pr.mergeable === 'MERGEABLE' && (!pr.testConclusion || String(pr.testConclusion).toUpperCase() === 'SUCCESS'))
    return { ...base, disposition: 'ready', reason: 'clean + green — `/drain` lands it' };

  return { ...base, disposition: 'unknown', reason: `mergeable=${pr.mergeable} state=${pr.mergeState} test=${pr.testConclusion ?? '—'}` };
}

/**
 * Order lanes so a lane never precedes a lane it is blockedBy (topological within the stuck set).
 * `blocked` lanes (blocker not landed at all) sort last — they can't run this pass. Ties keep PR order.
 * @param {ReturnType<typeof classifyLane>[]} lanes
 */
export function orderByBlockedBy(lanes) {
  const byItem = new Map(lanes.filter((l) => l.item != null).map((l) => [l.item, l]));
  const seen = new Set();
  const out = [];
  const visit = (l, stack) => {
    if (seen.has(l.num) || stack.has(l.num)) return; // cycle-safe: a back-edge is just skipped
    stack.add(l.num);
    for (const b of l.blockedBy) { const dep = byItem.get(b); if (dep) visit(dep, stack); }
    stack.delete(l.num);
    if (!seen.has(l.num)) { seen.add(l.num); out.push(l); }
  };
  for (const l of lanes) visit(l, new Set());
  // stable partition: attemptable (ready/conflict/test-red/unknown) before blocked
  return [...out.filter((l) => l.disposition !== 'blocked'), ...out.filter((l) => l.disposition === 'blocked')];
}

/**
 * Re-bucket a stacked chain's descendants behind a BROKEN link (#2396 / #2387 F5). A broken link is a lane the
 * finisher must REPAIR before anything stacked below it can rebuild: its required `test` is red (disposition
 * `test-red` — a real bug) OR it carries `review:changes` (a human bounced the diff). Any lane whose
 * `stackParents` chain reaches a broken link is re-bucketed to `blocked` (blocked-on-broken-link) — it must NOT
 * be attempted this pass: its tip literally contains the broken parent's code (CI red-poisons it anyway), and it
 * will be rebuilt onto the REPAIRED tip once the link is fixed, NEVER blind-rebased as part of the whole batch.
 * The broken link KEEPS its own disposition (the finisher fixes it in place). Transitive over the chain and
 * stowaway-proof: a descendant is deferred behind its parent's ABSENCE, so the tail can never land past the
 * unrepaired parent. Pure — no IO; returns a NEW array (inputs untouched).
 * @param {Array<{num, item, stackParents?:Array, disposition, reviewChanges?:boolean, reason}>} lanes
 * @returns {Array} the same lanes with poisoned descendants re-bucketed to `blocked`
 */
export function markStackDescendantsBlocked(lanes) {
  // Broken = the RAW breakage signals (`testRed` / `reviewChanges`), not just the disposition: classifyLane's
  // 'BLOCKED wins' rule overwrites a blockedBy+red-test lane's disposition to 'blocked', and a bounced lane now
  // buckets 'review-changes' — either way the link is still broken and its descendants must be re-bucketed.
  const isBroken = (l) => l.disposition === 'test-red' || l.disposition === 'review-changes'
    || l.testRed === true || l.reviewChanges === true;
  // Normalize EVERY id through `asItemId` before any Set/Map lookup — manifests spell the same item as a JSON
  // number (2396) and a quoted frontmatter string ("2396") interchangeably, and a raw-keyed match across that
  // spelling mismatch silently skips the poisoning (fails OPEN: the bounced parent's descendant stays `ready`
  // and lands). One normalizer on BOTH sides (broken items, adjacency keys, BFS lookups) makes it spelling-immune.
  const nid = (v) => (v == null ? null : asItemId(v));
  const brokenItems = new Set(lanes.filter(isBroken).map((l) => nid(l.item)).filter((i) => i != null));
  if (!brokenItems.size) return lanes.map((l) => ({ ...l }));
  // adjacency: a stackParent item → the child lanes stacked on it.
  const childrenOf = new Map();
  for (const l of lanes) for (const sp of l.stackParents || []) {
    const key = nid(sp);
    if (key == null) continue;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(l);
  }
  // BFS from every broken item over the stackParent edges → each reachable descendant is poisoned by it.
  // The poison record carries the broken ROOT (the nearest broken ANCESTOR), never the BFS predecessor — a
  // depth-≥2 descendant's reason must name the lane that actually needs the repair, not its (merely poisoned)
  // immediate parent.
  const poisonedBy = new Map(); // childItem (normalized) → the nearest broken ancestor item that poisons it
  const queue = [...brokenItems].map((b) => ({ item: b, root: b }));
  while (queue.length) {
    const { item: parent, root } = queue.shift();
    for (const child of childrenOf.get(parent) || []) {
      const c = nid(child.item);
      if (c == null || brokenItems.has(c) || poisonedBy.has(c)) continue;
      poisonedBy.set(c, root);
      queue.push({ item: c, root }); // transitively poison this descendant's own children too
    }
  }
  return lanes.map((l) => {
    const c = nid(l.item);
    return c != null && poisonedBy.has(c) && !brokenItems.has(c)
      ? { ...l, disposition: 'blocked', reason: `stacked ancestor #${poisonedBy.get(c)} is a broken link — repair it, then rebuild this onto the repaired tip (#2396)` }
      : { ...l };
  });
}

/**
 * Plan rebuilding a broken link's descendant TAIL onto the REPAIRED tip (#2396 / #2387 F5) — after the finisher
 * fixes the link, re-stack only the salvageable descendants, in `stackParents` topological order, NEVER past an
 * unlanded parent. A descendant is placed only once every `stackParent` it stacks on is AVAILABLE — the repaired
 * item itself, a descendant already placed earlier this pass, or an item proven `landed` (landedThisPass ∪
 * `bornAs`-on-main). A descendant whose parent is none of those is DEFERRED (its base doesn't exist yet — the
 * positive proof-of-land invariant: absence is never read as landed). Per placed descendant the action is:
 *   `ff`              — the repair touched NONE of this descendant's files → a clean fast-forward rebuild.
 *   `guided-conflict` — the repair touched a file this descendant also touches → exactly ONE guided conflict
 *                       (resolved WITH the manifest topology), never a blind whole-batch rebase.
 * Pure. Returns `{ order:[{item, ref, onto, action, reason}], deferred:[{item, reason}] }`.
 * @param {object} o
 * @param {number|string} o.repaired            the repaired link's item id (its tip is the new base)
 * @param {Array<{item, ref, stackParents?:Array, fileset?:Iterable}>} o.descendants  the poisoned tail
 * @param {Iterable} [o.fixTouched=[]]           repo-qualified files the repair changed (ff vs conflict)
 * @param {Set} [o.landed=new Set()]             items proven landed (landedThisPass ∪ provenOnMain)
 */
export function planStackRebuild({ repaired, descendants = [], fixTouched = [], landed = new Set() } = {}) {
  const fix = new Set(fixTouched);
  // Normalize every id ONCE at entry (`asItemId`) — manifests and caller-supplied `spec.landed` spell the same
  // item as a JSON number (300) or a quoted string ("300") interchangeably, and the `placed`/`landedSet` Set
  // lookups below use SameValueZero equality (300 ≠ "300"). Normalizing here makes every lookup spelling-immune
  // and lets `deriveLandedFromMain` return one canonical form instead of dual-adding raw + normalized.
  const repairedId = asItemId(repaired);
  const landedSet = new Set([...(landed instanceof Set ? landed : new Set(landed))].map((v) => asItemId(v)));
  const placed = new Set([repairedId]); // the repaired tip is available as a base from the start
  const order = [];
  const pending = descendants
    .filter((d) => d && d.item != null)
    .map((d) => ({ ...d, item: asItemId(d.item), stackParents: (d.stackParents || []).map((p) => asItemId(p)) }));
  // Fixed-point sweeps: place any descendant all of whose stackParents are available; repeat until no progress.
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const d of pending) {
      if (placed.has(d.item)) continue;
      const parents = d.stackParents;
      const available = parents.every((p) => placed.has(p) || landedSet.has(p));
      if (!available) continue; // a parent isn't ready yet — a later sweep may place it, else it defers
      const files = new Set(d.fileset || []);
      const overlaps = [...fix].some((f) => files.has(f));
      const onto = parents.find((p) => placed.has(p)) ?? repairedId; // rebuild onto the (repaired) chain member
      order.push({
        item: d.item, ref: d.ref, onto, action: overlaps ? 'guided-conflict' : 'ff',
        reason: overlaps
          ? 'repair touched a shared file — one guided conflict, resolved with the manifest topology (#2396)'
          : 'repair touched no shared file — fast-forward rebuild onto the repaired tip (#2396)',
      });
      placed.add(d.item);
      progressed = true;
    }
  }
  const deferred = pending
    .filter((d) => !placed.has(d.item))
    .map((d) => ({ item: d.item, reason: 'a stackParent is neither landed nor rebuilt this pass — never rebuilt past an unlanded parent (#2396)' }));
  return { order, deferred };
}

/**
 * Positive proof-of-land for a NUMERIC item id (#2396) — the numeric analogue of `landedNumberFor`'s
 * bornAs-on-main proof: the item's `backlog/NNN-*.md` on origin/main carries `status: resolved` in its
 * FRONTMATTER (body text never counts — a fenced example in prose must not spoof the proof). A bare
 * number is NEVER trusted as landed-by-construction: numbered-yet-unlanded items exist (pre-#2288 legacy
 * numbering, and an in-flight batch's own numbered siblings whose lanes are still queued), so only this
 * positive on-main record proves the land. Fails CLOSED — a missing file, an open/active status, or any
 * git error all read NOT landed.
 * @param {number|string} num  the numeric NNN
 * @param {string} [cwd]
 * @returns {boolean}
 */
export function resolvedOnMain(num, cwd = process.cwd()) {
  if (!/^\d{1,5}$/.test(String(num))) return false; // the numeric NNN id form only (ID_TOKEN_RE's numeric arm) — never a rev/pathspec injection surface
  const n = Number(num);
  try {
    // One scoped whole-line grep on origin/main (mirrors landedNumberFor's shape) LOCATES the candidate
    // file(s): the `NNN-*.md` pathspec pins the exact leading id (the `-` stops a longer number from
    // partial-hitting). The grep hit alone is NOT proof — it matches anywhere in the file, and an OPEN
    // item's body can carry a column-0 `status: resolved` (a fenced frontmatter example) — so each hit is
    // re-read and the status verified INSIDE the frontmatter block (`readField` parses only the first
    // `---`…`---`). `git grep` exits 1 on no match → the catch reads it as NOT landed.
    const out = execFileSync('git', ['grep', '-l', '-E', '^status:[ \t]*resolved', 'origin/main', '--', `backlog/${n}-*.md`],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    for (const hit of out.split('\n')) {
      const path = hit.replace(/^origin\/main:/, '');
      if (!path) continue;
      const doc = execFileSync('git', ['show', `origin/main:${path}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (docIsResolved(doc)) return true;
    }
    return false;
  } catch { return false; }
}

/**
 * Derive `planStackRebuild`'s `landed` set from the durable proof-of-land on origin/main (#2396/#2392) — the
 * "resolving each stackParent landed status via bornAs-on-main" half of the item, wired as the CLI
 * `rebuild-plan` default so a caller never has to hand-assemble the proof. For every stackParent any
 * descendant references (excluding items IN the descendant set — those are rebuilt this pass, not "landed"),
 * landed requires POSITIVE proof on origin/main — absence or id-format is NEVER read as landed (the F5
 * stowaway guard), for BOTH id forms:
 *   - a NUMERIC NNN is proven landed only by its backlog file on origin/main carrying `status: resolved`
 *     (`resolvedOnMain`) — a number alone proves nothing (numbered-yet-unlanded items exist: legacy ids and
 *     an in-flight batch's own numbered siblings).
 *   - a provisional HASH is proven landed only by a positive `bornAs:<hash>` record on origin/main
 *     (`landedNumberFor`, #2392).
 * Every returned id is in canonical `asItemId` form — `planStackRebuild` normalizes at entry, so one form
 * suffices. `lookup`/`resolvedLookup` are injectable (unit-testable without a repo).
 * @param {Array<{item, stackParents?:Array}>} descendants  the poisoned tail about to be planned
 * @param {{lookup?:(hash:string, cwd?:string)=>string|null, resolvedLookup?:(num:number, cwd?:string)=>boolean, cwd?:string}} [o]
 * @returns {Set} items proven landed on main
 */
export function deriveLandedFromMain(descendants = [], { lookup = landedNumberFor, resolvedLookup = resolvedOnMain, cwd = process.cwd() } = {}) {
  const inSet = new Set(descendants.filter((d) => d && d.item != null).map((d) => asItemId(d.item)));
  const landed = new Set();
  const checked = new Set();
  for (const d of descendants) for (const sp of (d && d.stackParents) || []) {
    const id = asItemId(sp);
    if (inSet.has(id) || checked.has(id)) continue; // rebuilt this pass (or already checked) — not re-proven
    checked.add(id);
    const proven = (typeof id === 'number' && Number.isFinite(id))
      ? resolvedLookup(id, cwd) === true                          // numeric → positive resolved-on-main proof
      : (isHash(String(id)) && lookup(String(id), cwd) != null);  // hash → positive bornAs-on-main proof (#2392)
    if (proven) landed.add(id);
  }
  return landed;
}

/**
 * Rebuild ONE descendant lane tip onto the REPAIRED parent tip (#2396). Reuses the proven #2198
 * `rebaseDropManifest` plumbing UNCHANGED — but with `base` = the repaired parent SHA instead of `origin/main`,
 * so the child's ancestry now contains the repaired code (the drain then lands the couple with the parent as an
 * ancestor, impl-first/parent-first). A clean / manifest-only merge is the fast-forward rebuild; a REAL
 * (non-manifest) conflict is the ONE guided conflict this descendant directly overlapping the fix must resolve —
 * surfaced as `guided-conflict` (the finisher resolves it WITH the topology), never force-resolved here.
 * @param {object} o
 * @param {string} o.laneRef        the descendant lane ref
 * @param {string} o.ontoSha        the repaired parent tip SHA to rebuild onto
 * @param {(cmd,args,opts?)=>{status,stdout,stderr}} [o.run]  injected runner (unit-testable)
 * @returns {{action:'rebased'|'guided-conflict'|'error', laneRef, ...}} `rebased` = ff; `guided-conflict` = one conflict
 */
export function rebuildDescendant({ laneRef, ontoSha, run = gitRunner, ...rest } = {}) {
  if (!laneRef || !ontoSha) return { action: 'error', laneRef: laneRef ?? null, reason: 'rebuildDescendant needs both laneRef and ontoSha (the repaired parent tip)' };
  // SECURITY — `ontoSha` can originate from branch-controlled manifest content (`repos[].base`); it is fed to
  // git plumbing as an argv token, so a crafted value starting with `-` (e.g. `--upload-pack=<cmd>`) would be
  // parsed as a git OPTION, not a revision. Accept ONLY a plain abbreviated-or-full commit SHA — never a ref
  // name, never anything that could carry an option or a rev-expression.
  if (!/^[0-9a-f]{7,40}$/i.test(String(ontoSha)))
    return { action: 'error', laneRef, reason: `ontoSha ${JSON.stringify(String(ontoSha))} is not a commit SHA (7-40 hex) — refusing to pass non-SHA (possibly branch-controlled) content to git (#2396)` };
  // SECURITY — `laneRef` rides the SAME branch-controlled path (manifest `repos[].ref` → discover →
  // rebuild-plan → `rebuild <laneRef>`) and is fed to `git fetch` argv AND the push refspec. A crafted value
  // could name a PROTECTED branch (`main` — the rebuilt merge commit would fast-forward straight onto main,
  // bypassing the PR transport and the required `test` check) or smuggle an option/refspec token
  // (`--upload-pack=…`, `x:refs/heads/main`, `+refs/…`). Accept ONLY the vocabulary the lane transport mints:
  // a `lane/…` ref in the plain ref charset (no `-` lead, no `:`/`+`/whitespace, no `..`) — every legitimate
  // caller satisfies this, and `main` never does.
  if (!/^lane\/[\w.-]+(?:\/[\w.-]+)*$/.test(String(laneRef)) || String(laneRef).includes('..'))
    return { action: 'error', laneRef, reason: `laneRef ${JSON.stringify(String(laneRef))} is not a lane/* ref — refusing to pass non-lane (possibly branch-controlled) content to git (#2396)` };
  const r = rebaseDropManifest({ laneRef, base: ontoSha, run, ...rest });
  if (r.action === 'skip') return { action: 'guided-conflict', laneRef, ontoSha, conflictPaths: r.conflictPaths || [], reason: `${r.reason} — one guided conflict to resolve with the manifest topology (#2396)` };
  return { ...r, ontoSha };
}

/**
 * The `testConclusion` to feed {@link landDecision} / {@link classifyLane}, read off a `gh pr view` / `gh pr list`
 * PR object through the drain's OWN shared selector (`latestRequiredCheck`, #xkfv491) — never a local
 * `.find(...)`. This is the ONE extraction seam both lane-resume rollup readers now go through, so the enqueue
 * side cannot disagree with the lander about which entry is "the" `test` check.
 *
 * Why it matters: a head SHA routinely carries SEVERAL runs of one check — a workflow `concurrency` group cancels
 * the in-flight run when a push supersedes it, leaving a `CANCELLED` entry ahead of the `SUCCESS` that actually
 * finished. Taking the first entry made `land <pr>` return `red` and REFUSE to enqueue a genuinely green PR, and
 * made `classifyLane` re-bucket every overlap-descendant behind that phantom broken link (#2396) — the #1042 jam
 * one layer earlier than the drain. Pure.
 *
 * @param {{statusCheckRollup?: Array<object>}|null|undefined} pr the parsed gh PR object
 * @param {string} requiredCheck the check name to read (default `test`)
 * @returns {string|null} the latest run's conclusion/state, or `null` when the check has not reported at all
 *   (in-flight — `requiredCheckState` maps that to `not-green`, never to `red`).
 */
export function testConclusionOf(pr, requiredCheck = 'test') {
  const check = latestRequiredCheck(pr, requiredCheck);
  return check ? (check.conclusion || check.state || null) : null;
}

/**
 * Decide how to land ONE lane PR from its GitHub signals (#2202). Pure. Only the required `test` check gates —
 * `UNSTABLE` (a non-required check like `cla`/Workers-Builds red) is still mergeable.
 *   'red'       — required `test` failed → NEVER land (a real bug; the finisher fixes code first).
 *   'not-green' — required `test` not reported / still pending → wait (no land yet).
 *   'clean'     — test green + mergeable → `gh pr merge` directly.
 *   'rebuild'   — test green but CONFLICTING/DIRTY/BEHIND → rebase-drop the manifest, then merge.
 * #2410 slice D — the required-`test` classification (red / not-green / green) is single-sourced through
 * `requiredCheckState` (lane-drain.mjs), retiring lane-resume's own FAIL list (the strand the capstone folds into
 * the unified land condition). The mergeable/rebuild half stays here (it is lane-resume-specific).
 * Its `testConclusion` argument comes from {@link testConclusionOf} at both shell call sites.
 * @param {{mergeable:string, mergeState:string, testConclusion:string|null}} sig
 */
export function landDecision({ mergeable, mergeState, testConclusion } = {}) {
  const state = requiredCheckState(testConclusion);
  const test = String(testConclusion || '').toLowerCase();
  if (state === 'red') return { action: 'red', reason: `required \`test\` check is ${test}` };
  if (state !== 'green') return { action: 'not-green', reason: `required \`test\` check not green (${test || 'none'})` };
  const m = String(mergeable || '').toUpperCase();
  const s = String(mergeState || '').toUpperCase();
  if (m === 'CONFLICTING' || s === 'DIRTY' || s === 'BEHIND') return { action: 'rebuild', reason: `test green but not up-to-date (mergeable=${m || '?'} state=${s || '?'}) — rebase-drop the manifest` };
  return { action: 'clean', reason: 'required check green + mergeable' };
}

/**
 * Land ONE stuck lane PR (#2202, #2290): repair-then-ENQUEUE. Reuses the #2198 `rebaseDropManifest` helper.
 * #2290 — lane-resume no longer merges directly (the drain is the sole writer to main): after any needed
 * rebase-drop rebuild, it ensures the `ready-to-merge` label and triggers a single-couple drain pass
 * (`node <drainScript> --only=<pr>`) that lands the couple through the shared merge gate. Best-effort trigger —
 * a park/failure just leaves the PR labelled for the standalone drain. `run(cmd,args,opts)->{status,stdout,stderr}`,
 * `prInfo`, and `drainScript` are injectable so this is unit-testable without a live repo/GitHub. Returns a
 * verdict object (never throws on a git/gh non-zero).
 * @returns {{action:string, pr:(number|string), merged:boolean, reason:string, rebased?:boolean}}
 */
export function land({ prNum, run = gitRunner, prInfo = null, base = 'origin/main', dryRun = false, label = READY_LABEL, triggerDrain = true, drainScript = 'scripts/merge-ai-prs.mjs', repo = null } = {}) {
  if (prNum == null) return { action: 'error', merged: false, reason: 'no PR number (usage: lane-resume.mjs land <pr>)' };
  // #2383 — a `repo` slug scopes every gh call to that constellation repo (frontierui/plateau-app); null = the
  // cwd repo (the established local-git path). The LOCAL rebase-drop plumbing only touches the cwd clone, so for
  // a remote repo the rebuild is deferred to the drain (which is sibling-clone-aware, #2263).
  const repoFlag = repo ? ['--repo', repo] : [];
  if (!prInfo) {
    const v = run('gh', ['pr', 'view', String(prNum), ...repoFlag, '--json', 'number,headRefName,mergeable,mergeStateStatus,statusCheckRollup,labels']);
    try { prInfo = JSON.parse(v.stdout || '{}'); } catch { prInfo = {}; }
  }
  // #2396 — a `review:changes` bounce is a broken link: NEVER enqueue it (green CI + mergeable is irrelevant —
  // a human rejected the diff; the finisher repairs and the reviewer re-verdicts before any land). Mirrors the
  // drain's #2366 hard refusal at this earlier layer so `land <pr>` can't push a bounced diff into the queue.
  if (hasReviewLabel(prInfo.labels, REVIEW_LABELS.changes))
    return { action: 'review-changes', pr: prNum, merged: false, reason: 'review:changes — a human bounced this diff; repair + re-review before any land (#2396)' };
  // #2832 / #984 finding 6 — this is a WRITE site for the go-ahead (`--add-label ready-to-merge` below). It added
  // the label UNCONDITIONALLY, so `/finish` on a PR carrying an uncleared review HOLD (review:human / review:pending)
  // made it "held AND ready" again — the exact self-inconsistent state #2832 removes — then the drain reconcile
  // stripped it next pass, flip-flopping forever. Consult the SHARED invariant predicate BEFORE the add: if applying
  // the go-ahead here would leave the PR both held and ready, refuse to enqueue and leave it held for the human.
  // (review:changes is already refused above with its own bounce reason; this catches the remaining holds. Only the
  // `ready-to-merge` go-ahead trips this — a non-go-ahead `label` never conflicts, so the predicate returns false.)
  if (readyMergeConflictsWithHold([...(prInfo.labels || []), label]))
    return { action: 'held', pr: prNum, merged: false, reason: `held for review — refusing to add ${label} to a PR carrying an uncleared review hold (a go-ahead + hold is contradictory, #2832); a human clears the hold before any land` };
  const laneRef = prInfo.headRefName;
  const decision = landDecision({ mergeable: prInfo.mergeable, mergeState: prInfo.mergeStateStatus, testConclusion: testConclusionOf(prInfo) });

  if (decision.action === 'red') return { action: 'red', pr: prNum, merged: false, reason: decision.reason };
  if (decision.action === 'not-green') return { action: 'not-green', pr: prNum, merged: false, reason: decision.reason };
  if (!laneRef) return { action: 'error', pr: prNum, merged: false, reason: 'the PR has no head ref (gh pr view returned none)' };
  if (dryRun) return { action: decision.action, pr: prNum, merged: false, laneRef, reason: `dry-run: would ${decision.action === 'rebuild' ? (repo ? 'defer the rebase-drop to the drain then ' : 'rebase-drop the manifest then ') : ''}enqueue #${prNum} (${laneRef}) — label ${label} + trigger a single-couple drain${repo ? ` in ${repo}` : ''}` };

  let rebased = false;
  let alreadyCurrent = false;
  if (decision.action === 'rebuild') {
    if (repo) {
      // #2383 — a REMOTE repo tip can't be rebuilt by the LOCAL rebase-drop plumbing; enqueue and let the drain
      // rebuild it through that repo's sibling clone (#2263). If no sibling clone is provisioned the drain leaves
      // it for its author — the same graceful degradation `/drain` already has, not an error here.
    } else {
      const r = rebaseDropManifest({ laneRef, base, run });
      if (r.action === 'skip') return { action: 'skip', pr: prNum, merged: false, reason: r.reason, conflictPaths: r.conflictPaths };
      if (r.action === 'error') return { action: 'error', pr: prNum, merged: false, reason: r.reason };
      // `current` = the idempotency short-circuit ran: the tip is ALREADY on base and manifest-free, so NOTHING
      // was minted or pushed. Still landable (enqueue below), but it is NOT a rebuild — don't set `rebased` or
      // claim a manifest was dropped in the reason.
      if (r.action === 'current') alreadyCurrent = true;
      else rebased = true;
    }
  }
  // #2290 — ENQUEUE instead of merging: ensure the ready-to-merge label, then trigger a single-couple drain (the
  // sole writer to main lands it via the shared gate). Both are best-effort — a label race or a park/failure just
  // leaves the PR labelled for the standalone drain; lane-resume never itself calls `gh pr merge`.
  // #2383 — scope the trigger to the PR's repo: `--repos=<slug>` for a remote constellation repo, `--this-repo`
  // for the cwd repo (the drain is constellation-default, so an unscoped trigger could sweep the wrong repo).
  const drainScope = repo ? [`--repos=${repo}`] : ['--this-repo'];
  run('gh', ['pr', 'edit', String(prNum), ...repoFlag, '--add-label', label]);
  if (triggerDrain) run('node', [drainScript, `--only=${prNum}`, '--label', label, ...drainScope]);
  const reason = rebased
    ? 'rebased onto main (manifest dropped), labelled + single-couple drain triggered'
    : alreadyCurrent
      ? `already current on main (manifest-free) — labelled + single-couple drain triggered${repo ? ` (${repo})` : ''}`
      : `labelled ready-to-merge + single-couple drain triggered${repo ? ` (${repo})` : ''}`;
  return { action: rebased ? 'rebuilt-enqueued' : 'enqueued', pr: prNum, merged: false, rebased, reason };
}

// ─────────────────────────────────── IO helpers ───────────────────────────────────

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const shJSON = (cmd, args, dflt) => { try { return JSON.parse(sh(cmd, args) || 'null') ?? dflt; } catch { return dflt; } };

/**
 * Read a lane's `.lane-manifest.json` off its head ref. Returns {item, repos, blockedBy, stackParents} or null.
 * #2383 — repo-aware, mirroring `/drain`: for the LOCAL repo (`repo` null/self) read it from local git; for a
 * REMOTE constellation repo read it via the GitHub API (`gh api …/contents/.lane-manifest.json?ref=<headRef>`
 * → base64 `.content`) — never a local clone. Fail-soft to null: a manifest-less lane (e.g. plateau-app's own
 * batch branches carry none) degrades to item null / blockedBy [] — unordered within its repo, exactly like the
 * drain's orphan-PR handling, never a crash.
 * #2396 — also surfaces `stackParents` (the frontier-tip item(s) this lane was cut from / merged onto, #2387 F3)
 * and keeps each `repos[].base` intact, so `/finish` can bucket a stacked chain's descendants behind a broken
 * link and rebuild the salvageable tail onto the repaired tip. Absent ⇒ `stackParents: []` (sibling behaviour).
 */
function readManifest(ref, { repo = null } = {}) {
  const shape = (m) => ({ item: m.item ?? null, repos: m.repos || [], blockedBy: m.blockedBy || [], stackParents: Array.isArray(m.stackParents) ? m.stackParents : [] });
  if (repo) {
    try {
      const b64 = execFileSync('gh', remoteManifestApiArgs(repo, ref), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (!b64) return null;
      return shape(JSON.parse(Buffer.from(b64, 'base64').toString('utf8')));
    } catch { return null; }
  }
  for (const rev of [`origin/${ref}`, ref]) {
    try {
      return shape(JSON.parse(execFileSync('git', ['show', `${rev}:.lane-manifest.json`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })));
    } catch { /* try next rev */ }
  }
  return null;
}

/**
 * Item numbers whose backlog file is `status: resolved` on origin/main (a blocker counts as landed) —
 * discover's blocker-gate. Reads each candidate's status FRONTMATTER-strict via {@link docIsResolved}, the
 * same reader `resolvedOnMain` uses (#2455): a body-text `status: resolved` (a fenced frontmatter example)
 * never spoofs a discover blocker. Keeps discover's one-sweep read (`ls-tree` + per-file `git show`) rather
 * than resolvedOnMain's per-num grep — this fans out over the whole backlog in one pass.
 * @param {string} [cwd]
 * @returns {Set<number>}
 */
export function resolvedItemSet(cwd = process.cwd(), { status = 'resolved' } = {}) {
  const set = new Set();
  let files = [];
  try { files = execFileSync('git', ['ls-tree', '-r', '--name-only', 'origin/main'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter((f) => /^backlog\/\d+-/.test(f)); } catch { return set; }
  for (const f of files) {
    const n = Number((f.match(/^backlog\/(\d+)-/) || [])[1]);
    try {
      const doc = execFileSync('git', ['show', `origin/main:${f}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (readField(doc, 'status') === status) set.add(n);
    } catch { /* skip */ }
  }
  return set;
}

// ─────────────────────────── pr-missing: pure classification (#xcf4556) ───────────────────────────

/**
 * Derive the backlog item number a `pr-missing` lane ref delivers, from whichever signal names one. Preference
 * order: the lane manifest's `item` (authoritative — the lane declared it explicitly) → a `resolve #NNN` commit
 * subject on the ref (the graduation/resolve commit names its own card) → a changed `backlog/NNN-*.md` file's
 * own id (the file path itself). Pure — every input is pre-collected by the IO layer
 * ({@link collectPrMissingLanes}). Returns null when nothing names a number.
 * @param {{manifestItem?: number|null, commitSubjects?: string[], changedBacklogFiles?: string[]}} [o]
 * @returns {number|null}
 */
export function deriveItemFromRef({ manifestItem = null, commitSubjects = [], changedBacklogFiles = [] } = {}) {
  if (Number.isFinite(manifestItem)) return manifestItem;
  for (const subject of commitSubjects) {
    const m = String(subject || '').match(/resolve #(\d+)/i);
    if (m) return Number(m[1]);
  }
  for (const f of changedBacklogFiles) {
    const m = String(f || '').match(/^backlog\/(\d+)-/);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Classify ONE remote `lane/*` ref as a `pr-missing` `/finish` recovery candidate (#xcf4556): pushed, carrying
 * real delivered work, and invisible to `discover`'s labelled-PR sweep because no PR was ever opened for it
 * (the live case: a `/workflow` orchestrator ended while a lane agent sat inside `pr-land` waiting on required
 * checks, so `gh pr create` never ran). Pure — every signal is pre-collected by the IO layer
 * ({@link collectPrMissingLanes}).
 *
 *   - `prStates` non-empty (ANY PR ever recorded against this head — open, merged, OR CLOSED) → not a
 *     candidate: open/merged means discover's normal labelled-PR sweep already owns it, and CLOSED means a
 *     human deliberately closed it — silently reopening it behind their back is the exact kind of unasked-for
 *     "fix it by hand" this tool must never do.
 *   - `tipOnMain` → not a candidate: the work already landed some other route (e.g. a rebase-drop merge, or a
 *     manual land); there is nothing left to recover.
 *   - `!deliversRealChange` → not a candidate: a tip with no non-manifest diff against main (an aborted/empty
 *     lane, or one whose only content is `.lane-manifest.json`) is not a finished delivery.
 *   - too old (`committerDate` further than `windowDays` from `now`) → not a candidate: an ancient orphaned
 *     ref reads as abandoned, not mid-flight; `/finish` must not resurrect one silently. `windowDays` is
 *     caller-configurable (default 7) via `discover --window-days=N`.
 * @param {{ref:string, repo?:string|null, tipSha:string, committerDate:string, prStates?:Array<{number:number,state:string}>,
 *           tipOnMain?:boolean, deliversRealChange?:boolean, item?:number|null, now?:number, windowDays?:number}} o
 * @returns {{ref:string, repo:string|null, item:number|null, tip:string, disposition:'pr-missing', reason:string}|null}
 */
export function classifyPrMissingRef({
  ref, repo = null, tipSha, committerDate, prStates = [], tipOnMain = false,
  deliversRealChange = false, item = null, now = Date.now(), windowDays = 7,
} = {}) {
  if (Array.isArray(prStates) && prStates.length) return null; // any PR at all (incl. CLOSED) — not this bucket
  if (tipOnMain) return null; // already landed some other way
  if (!deliversRealChange) return null; // nothing but a manifest (or no diff at all) — not a finished delivery
  const committedMs = Date.parse(committerDate);
  const ageMs = Number.isFinite(committedMs) ? now - committedMs : Infinity;
  const windowMs = Math.max(0, Number(windowDays) || 0) * 24 * 60 * 60 * 1000;
  if (ageMs > windowMs) return null; // stale — reads as abandoned, not mid-flight
  const hasItem = Number.isFinite(item);
  return {
    ref, repo: repo || null, item: hasItem ? item : null, tip: tipSha, disposition: 'pr-missing',
    reason: hasItem
      ? `pushed lane ref carries a real delivery (resolves #${item}) with no PR ever opened for it — recover with \`lane-resume.mjs open ${ref}\``
      : `pushed lane ref carries a real delivery with no PR ever opened for it (item not derivable) — recover with \`lane-resume.mjs open ${ref}\``,
  };
}

/**
 * Decide whether `open <laneRef>` may proceed (#xcf4556). Pure — every fact is pre-collected by the IO layer
 * ({@link openPrMissingLane}). Refuses (never opens a PR) when:
 *   - `existingPr` is set (ANY PR — open, merged, or closed — already recorded against this head): opening a
 *     second one would duplicate, or silently override, a decision that already exists — including a human's
 *     deliberate close.
 *   - `tipOnMain` — the ref's tip is already reachable from `origin/main`: nothing is left to land.
 *   - `item` is set AND `resolvedOnMainByOtherCommit` is true — the card this ref resolves is ALREADY
 *     `status: resolved` on main (and, since `tipOnMain` is false here, necessarily by a DIFFERENT commit):
 *     opening this PR would re-resolve (or conflict on) a card another lane already delivered. A human or
 *     finisher reconciles which delivery is real before either lands.
 * Otherwise `{ ok: true }` — the IO layer proceeds to push (a no-op if the ref is already current at that sha)
 * and open through `pr-land.mjs --label-on-green`.
 * @param {{ref:string, existingPr?:{number:number,state:string}|null, tipOnMain?:boolean, item?:number|null, resolvedOnMainByOtherCommit?:boolean}} o
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function planOpenPrMissingRef({ ref, existingPr = null, tipOnMain = false, item = null, resolvedOnMainByOtherCommit = false } = {}) {
  if (existingPr) {
    return { ok: false, reason: `refusing to open a PR for ${ref} — #${existingPr.number} (${existingPr.state}) already exists for this head` };
  }
  if (tipOnMain) {
    return { ok: false, reason: `refusing to open a PR for ${ref} — its tip is already reachable from main; nothing to land` };
  }
  if (item != null && resolvedOnMainByOtherCommit) {
    return { ok: false, reason: `refusing to open a PR for ${ref} — #${item} is already status:resolved on main by a different commit; reconcile before landing this ref` };
  }
  return { ok: true };
}

// ─────────────────────────── pr-missing: IO layer (#xcf4556) ───────────────────────────

/**
 * A sibling constellation clone's directory (`../frontierui`, `../plateau-app`, next to this repo's clone),
 * mirroring the SAME provisioning `merge-ai-prs.mjs`'s own `siblingCloneDir` already depends on for the
 * drain's rebase-drop plumbing (#2263 — kept private there; this is a two-line duplicate for the one caller
 * here, not shared cross-module plumbing). Null for the local repo, an unrecognized repo, or a directory that
 * isn't a provisioned git working copy (fail-soft: nothing here clones on the fly).
 * @param {string|null} repo
 * @param {string|null} self
 * @returns {string|null}
 */
function siblingCloneDirFor(repo, self) {
  if (!repo || repo === self) return null;
  const name = siblingCloneName(repo);
  if (!name) return null;
  const dir = resolvePath(process.cwd(), '..', name);
  try { return existsSync(joinPath(dir, '.git')) ? dir : null; } catch { return null; }
}

/**
 * IO: enumerate every remote `lane/*` ref across the constellation repos and classify each against
 * {@link classifyPrMissingRef} (#xcf4556). The local repo reads local git directly; a remote repo routes
 * through its SIBLING CLONE ({@link siblingCloneDirFor}) — a repo with none provisioned is skipped for this
 * bucket only (fail-soft, mirroring the drain's own #2263 degradation), never a crash. PR-state and manifest
 * reads still go through `gh`/`readManifest` (repo-scoped via `--repo`, exactly like the rest of `discover`) —
 * those work from any cwd and need no sibling clone.
 * @param {{repos?:string|null, singleRepo?:boolean, self?:string|null, windowDays?:number, now?:number}} [o]
 * @returns {Array<NonNullable<ReturnType<typeof classifyPrMissingRef>>>}
 */
function collectPrMissingLanes({ repos = null, singleRepo = false, self = null, windowDays = 7, now = Date.now() } = {}) {
  const REPOS = resolveRepos({ repos, singleRepo, self });
  const out = [];
  for (const repo of REPOS) {
    const isLocal = repo == null || repo === self;
    const dir = isLocal ? process.cwd() : siblingCloneDirFor(repo, self);
    if (!dir) continue; // no local git to enumerate refs from — fail-soft skip (#2263 parity)
    try { execFileSync('git', ['fetch', 'origin', '--quiet'], { cwd: dir, stdio: 'ignore' }); } catch { /* best-effort — work with whatever refs are already local */ }
    let refLines = [];
    try {
      refLines = execFileSync('git', ['for-each-ref', '--format=%(refname:short)|%(objectname)|%(committerdate:iso-strict)', 'refs/remotes/origin/lane/*'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean);
    } catch { continue; }
    const repoFlag = isLocal ? [] : ['--repo', repo];
    // #xcf4556-perf — ONE `gh pr list --state all` call per repo, not one per ref: a per-ref `--head` query
    // (152 refs measured live in this repo alone) took over two minutes end to end. Building the by-headRef map
    // once turns that into a single call. `--limit 5000` comfortably covers this repo's full PR history
    // (2635 at measurement time); a `gh` miss degrades to an empty map, which — like the old per-ref fail-soft
    // — reads every ref as PR-less, so it can only ever surface MORE candidates for a human/finisher to look
    // at, never silently hide a real one.
    const prByHead = new Map();
    try {
      for (const p of shJSON('gh', ['pr', 'list', ...repoFlag, '--state', 'all', '--json', 'number,state,headRefName', '--limit', '5000'], [])) {
        if (!prByHead.has(p.headRefName)) prByHead.set(p.headRefName, []);
        prByHead.get(p.headRefName).push({ number: p.number, state: p.state });
      }
    } catch { /* prByHead stays empty — see comment above */ }
    for (const line of refLines) {
      const [shortRef, tipSha, committerDate] = line.split('|');
      const ref = shortRef.replace(/^origin\//, '');
      const prStates = prByHead.get(ref) || [];
      if (prStates.length) continue; // any PR at all — not this bucket; skip the rest of the work
      let tipOnMain = false;
      try { execFileSync('git', ['merge-base', '--is-ancestor', tipSha, 'origin/main'], { cwd: dir, stdio: 'ignore' }); tipOnMain = true; } catch { tipOnMain = false; }
      let changedFiles = [];
      let commitSubjects = [];
      try {
        const base = execFileSync('git', ['merge-base', 'origin/main', tipSha], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        changedFiles = execFileSync('git', ['diff', '--name-only', base, tipSha], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean);
        commitSubjects = execFileSync('git', ['log', '--format=%s', `${base}..${tipSha}`], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean);
      } catch { /* fail-soft: no delivery signal collected — deliversRealChange stays false below */ }
      const deliversRealChange = changedFiles.some((f) => f !== '.lane-manifest.json');
      const man = readManifest(ref, { repo: isLocal ? null : repo });
      const changedBacklogFiles = changedFiles.filter((f) => /^backlog\/\d+-/.test(f));
      const item = deriveItemFromRef({ manifestItem: man?.item ?? null, commitSubjects, changedBacklogFiles });
      const lane = classifyPrMissingRef({ ref, repo: repo || self || null, tipSha, committerDate, prStates, tipOnMain, deliversRealChange, item, now, windowDays });
      if (lane) out.push(lane);
    }
  }
  return out;
}

/**
 * IO: open the PR for ONE `pr-missing` lane ref (#xcf4556's `open <laneRef>` — see {@link planOpenPrMissingRef}
 * for the pure refusal rules this enforces). Pushes the ref's own tip back to itself (a no-op — the ref is
 * already at that sha on origin) and opens through `scripts/pr-land.mjs --label-on-green` — the SAME producer
 * transport every lane uses, never a raw `gh pr create`. `--no-require-verified`: the `.lane-verify` marker for
 * this tip lived in the ORIGINAL (now-gone) lane clone that pushed it, so it is structurally unreachable here —
 * the SAME shape the drain and the `/workflow` producer already opt out for (`scripts/lib/lane-verify.mjs`,
 * #3321); the PR's own required `test` check still gates the eventual land.
 * @param {string} ref
 * @param {{repo?:string|null, json?:boolean}} [o]
 * @returns {{ok:boolean, ref:string, reason?:string, prOpened?:boolean, outcome?:string, pr?:number|null, url?:string|null, detail?:string}}
 *   a pre-spawn refusal carries only `{ok:false, ref, reason}`; a spawn returns {@link submitPrMissingOpen}'s shape.
 */
function openPrMissingLane(ref, { repo = null } = {}) {
  const self = localSlug();
  const targetRepo = repo || self;
  const isLocal = targetRepo == null || targetRepo === self;
  const dir = isLocal ? process.cwd() : siblingCloneDirFor(targetRepo, self);
  if (!dir) return { ok: false, ref, reason: `no local git to operate on for ${targetRepo || '(local)'} — the sibling clone isn't provisioned` };
  try { execFileSync('git', ['fetch', 'origin', '--quiet'], { cwd: dir, stdio: 'ignore' }); } catch { /* best-effort */ }
  let tipSha;
  try { tipSha = execFileSync('git', ['rev-parse', `origin/${ref}`], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return { ok: false, ref, reason: `origin/${ref} not found in ${dir} — fetch it first` }; }
  const repoFlag = isLocal ? [] : ['--repo', targetRepo];
  let prStates = [];
  try { prStates = shJSON('gh', ['pr', 'list', ...repoFlag, '--head', ref, '--state', 'all', '--json', 'number,state'], []); } catch { prStates = []; }
  const existingPr = Array.isArray(prStates) && prStates.length ? prStates[0] : null;
  let tipOnMain = false;
  try { execFileSync('git', ['merge-base', '--is-ancestor', tipSha, 'origin/main'], { cwd: dir, stdio: 'ignore' }); tipOnMain = true; } catch { tipOnMain = false; }
  let changedFiles = [];
  let commitSubjects = [];
  try {
    const base = execFileSync('git', ['merge-base', 'origin/main', tipSha], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    changedFiles = execFileSync('git', ['diff', '--name-only', base, tipSha], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean);
    commitSubjects = execFileSync('git', ['log', '--format=%s', `${base}..${tipSha}`], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean);
  } catch { /* fail-soft */ }
  const man = readManifest(ref, { repo: isLocal ? null : targetRepo });
  const changedBacklogFiles = changedFiles.filter((f) => /^backlog\/\d+-/.test(f));
  const item = deriveItemFromRef({ manifestItem: man?.item ?? null, commitSubjects, changedBacklogFiles });
  // The backlog is WE-global (#2383's own rule): resolve against THIS process's cwd (the WE checkout the
  // operator is running `/finish` from), never `dir` — a remote repo's sibling clone has no `backlog/` tree.
  const resolvedOnMainByOtherCommit = item != null && (resolvedItemSet().has(item) || resolvedItemSet(process.cwd(), { status: 'closed' }).has(item));
  const plan = planOpenPrMissingRef({ ref, existingPr, tipOnMain, item, resolvedOnMainByOtherCommit });
  if (!plan.ok) return { ok: false, ref, reason: plan.reason };

  const body = [
    '/finish recovered this lane: a lane agent had already committed its work' + (item != null ? ` and resolved #${item}` : ' and resolved its card') + ',',
    'but the session ended before a PR was ever opened for it (the orchestrator exited while the lane sat',
    'inside `pr-land`, waiting on required checks).',
    '',
    `Ref: ${ref}`,
    `Tip: ${tipSha}`,
    item != null ? `Item: #${item}` : 'Item: not derivable from the manifest, commit messages, or changed backlog files',
    '',
    'Opened by `lane-resume.mjs open` (#xcf4556) — see its `pr-missing` discover bucket.',
  ].join('\n');
  const bodyDir = mkdtempSync(joinPath(tmpdir(), 'lane-resume-open-'));
  const bodyFile = joinPath(bodyDir, 'body.md');
  writeFileSync(bodyFile, body, 'utf8');

  return submitPrMissingOpen({ ref, tipSha, bodyFile, dir });
}

/**
 * The pr-land argv `open <laneRef>` spawns. PURE — exported so the transport guarantee (`pr-land.mjs
 * --label-on-green`, never a raw `gh pr create`) is pinned by a test, not only by a docstring (#xcf4556
 * review). `--no-require-verified` is safe ONLY because `--label-on-green` still waits on the PR's required
 * checks before any ready-to-merge label; the two travel together.
 * @param {{prLandScript:string, ref:string, tipSha:string, bodyFile:string, dir:string}} o
 * @returns {string[]}
 */
export function prMissingOpenArgs({ prLandScript, ref, tipSha, bodyFile, dir }) {
  return [prLandScript, `--ref=${ref}`, `--sha=${tipSha}`, '--label-on-green', '--no-require-verified', `--body-file=${bodyFile}`, `--repo=${dir}`, '--json'];
}

/**
 * Spawn pr-land for a recovered ref and read its report through open-pr's SHARED `classifySubmit` /
 * `HOME_REASONS` table — never a local re-parse (#xcf4556 review). In `--label-on-green` mode pr-land opens
 * the PR FIRST, then waits on checks, so `check-timeout`/`check-red`/`behind`/`conflict` exit non-zero while
 * naming a PR that EXISTS. Recovery's job is to make that PR exist, so `ok` is true whenever one does
 * (`prOpened`); pr-land's own `outcome`/`reason` ride along so the caller still sees what happened after the
 * open. `exec` is injectable so the test pins the argv and replays pr-land's real post-open payloads.
 * @returns {{ok:boolean, ref:string, prOpened:boolean, outcome:string, pr:number|null, url:string|null, reason?:string, detail?:string}}
 */
export function submitPrMissingOpen({ ref, tipSha, bodyFile, dir, exec = execFileSync, prLandScript = fileURLToPath(new URL('./pr-land.mjs', import.meta.url)) }) {
  const args = prMissingOpenArgs({ prLandScript, ref, tipSha, bodyFile, dir });
  let report;
  try {
    report = { status: 0, stdout: String(exec('node', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) };
  } catch (e) {
    // execFileSync throws on a non-zero exit WITH status/stdout attached; a spawn failure carries neither.
    report = e && (e.status != null || e.signal)
      ? { status: e.status, signal: e.signal, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }
      : { error: e instanceof Error ? e : new Error(String(e)) };
  }
  const c = classifySubmit(report);
  const pr = c.pr ?? null;
  const prOpened = c.outcome === 'opened' || pr != null;
  return { ok: prOpened, ref, prOpened, outcome: c.outcome, pr, url: c.url ?? null, ...(c.reason ? { reason: c.reason } : {}), ...(c.detail ? { detail: c.detail } : {}) };
}

function discover(asJson, { repos = null, singleRepo = false, windowDays = 7 } = {}) {
  execFileSync('git', ['fetch', 'origin', '--quiet'], { stdio: 'ignore' }); // local repo's refs (backlog + local lanes)
  // #2383 — sweep the constellation by DEFAULT, exactly like `/drain` (#2287): self's owner × {web-everything,
  // frontierui, plateau-app}, self first. `--this-repo` scopes to the cwd repo; `--repos=a,b` is an explicit set.
  // A null entry = the cwd repo (local git); a slug entry routes every gh call through `--repo` + the manifest
  // read through the GitHub API. resolvedItemSet stays WE-local — the backlog is WE-global, so a cross-repo
  // lane's WE `blockedBy` resolves against the one backlog regardless of which repo the lane lives in.
  const self = localSlug();
  const REPOS = resolveRepos({ repos, singleRepo, self });
  const resolved = resolvedItemSet();
  const closed = resolvedItemSet(process.cwd(), { status: 'closed' });
  const lanes = [];
  for (const repo of REPOS) {
    const isLocal = repo == null || repo === self;
    const repoFlag = repo ? ['--repo', repo] : [];
    // #2396 — `labels` too: a `review:changes` bounce is a broken stacked LINK (like a red `test`), so its
    // overlap-descendants must be re-bucketed behind it, not attempted this pass.
    // #no-label-search (2026-09-27 live incident) — `--label` on `gh pr list` is search-backed (a separate,
    // much smaller budget than the ordinary GraphQL list this call already is) and rate-limits independently
    // of the real GraphQL budget. `labels` is already requested below, so filter by READY_LABEL client-side.
    // The cap now bounds the RAW open-PR list (not a pre-filtered set): list at the shared OPEN_PR_LIST_LIMIT and
    // surface a full page loudly, so a ready PR past it is never dropped silently.
    const allOpenPrs = shJSON('gh', ['pr', 'list', ...repoFlag, '--state', 'open', '--json', 'number,mergeable,mergeStateStatus,headRefName,statusCheckRollup,labels', '--limit', String(OPEN_PR_LIST_LIMIT)], []);
    const { prs, truncated } = filterOpenPrsByLabel(allOpenPrs, READY_LABEL);
    if (truncated) process.stderr.write(`lane-resume ⚠ ${repo || 'cwd repo'}: the open-PR listing hit the --limit ${OPEN_PR_LIST_LIMIT} cap — it MAY be truncated, so a ${READY_LABEL} PR past it can be missing this pass (#no-label-search)\n`);
    for (const p of prs) {
      const man = readManifest(p.headRefName, { repo: isLocal ? null : repo }) || { item: null, repos: [], blockedBy: [], stackParents: [] };
      if (closed.has(man.item)) continue;
      const lane = classifyLane({
        num: p.number, mergeable: p.mergeable, mergeState: p.mergeStateStatus,
        testConclusion: testConclusionOf(p),
        item: man.item, repos: man.repos, blockedBy: man.blockedBy,
        stackParents: man.stackParents, reviewChanges: hasReviewLabel(p.labels, REVIEW_LABELS.changes),
      }, resolved);
      lane.repo = repo || self || null; // tag the owning repo so the skill lands each in the right place
      lanes.push(lane);
    }
  }
  // #2396 — re-bucket every overlap-descendant of a broken link (red `test` OR `review:changes`) to `blocked`
  // BEFORE ordering, so the salvageable tail waits for the repaired tip instead of a blind whole-batch rebase.
  const ordered = orderByBlockedBy(markStackDescendantsBlocked(lanes));
  const bucket = (d) => ordered.filter((l) => l.disposition === d);
  // #xcf4556 — a SEPARATE sweep: pushed lane/* refs that carry a real delivery but never got a PR at all (so
  // they can never appear in the labelled-PR sweep above). Its own bucket, not folded into `ordered` — these
  // aren't PRs, `orderByBlockedBy`/`markStackDescendantsBlocked` don't apply to them.
  const prMissing = collectPrMissingLanes({ repos, singleRepo, self, windowDays });
  const result = {
    ok: true,
    counts: { ready: bucket('ready').length, conflict: bucket('conflict').length, testRed: bucket('test-red').length, reviewChanges: bucket('review-changes').length, blocked: bucket('blocked').length, unknown: bucket('unknown').length, prMissing: prMissing.length },
    ready: bucket('ready'), conflict: bucket('conflict'), testRed: bucket('test-red'), reviewChanges: bucket('review-changes'), blocked: bucket('blocked'), unknown: bucket('unknown'), prMissing,
    order: ordered.map((l) => ({ pr: l.num, repo: l.repo, item: l.item, disposition: l.disposition, crossRepo: l.crossRepo, blockedBy: l.blockedBy, stackParents: l.stackParents || [], reviewChanges: l.reviewChanges === true, reason: l.reason })),
  };
  if (asJson) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return; }
  const repoTag = (l) => (l.repo && l.repo !== self ? `${l.repo.split('/').pop()}#` : '#'); // short prefix per repo
  const line = (l) => `  ${l.disposition === 'ready' ? '✓' : l.disposition === 'blocked' ? '⊘' : '→'} ${repoTag(l)}${l.num}${l.item ? ` (#${l.item})` : ''}${l.crossRepo ? ' [cross-repo]' : ''} — ${l.reason}`;
  process.stderr.write(`lane-resume · ${lanes.length} labelled PR(s) across ${REPOS.length} repo(s): ${JSON.stringify(result.counts)}\n`);
  for (const d of ['ready', 'conflict', 'test-red', 'review-changes', 'blocked', 'unknown']) {
    const b = bucket(d); if (!b.length) continue;
    process.stderr.write(`\n${d.toUpperCase()} (${b.length}):\n${b.map(line).join('\n')}\n`);
  }
  if (prMissing.length) {
    const missLine = (l) => `  → ${repoTag(l)}${l.ref}${l.item ? ` (#${l.item})` : ''} @ ${l.tip.slice(0, 8)} — ${l.reason}`;
    process.stderr.write(`\nPR-MISSING (${prMissing.length}):\n${prMissing.map(missLine).join('\n')}\n`);
  }
}

const IS_CLI = process.argv[1] && process.argv[1].endsWith('lane-resume.mjs');
if (IS_CLI) {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a) => !a.startsWith('--'));
  const cmd = positional[0] || 'discover';
  const asJson = argv.includes('--json');
  // #2383 — repo scoping shared with `/drain`: `--this-repo` = cwd repo only; `--repos=a,b` = an explicit set;
  // neither = the constellation (default). `--repo=<slug>` scopes a single `land` to the PR's repo.
  const flagVal = (name) => { const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`)); return hit == null ? null : (hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : ''); };
  const singleRepo = argv.includes('--this-repo');
  const repos = flagVal('repos');
  if (cmd === 'discover') {
    // #xcf4556 — the pr-missing bucket's staleness cutoff; `discover --window-days=N` widens/narrows it (default 7).
    const windowDaysFlag = flagVal('window-days');
    const windowDays = windowDaysFlag != null && windowDaysFlag !== '' && Number.isFinite(Number(windowDaysFlag)) ? Number(windowDaysFlag) : 7;
    discover(asJson, { repos, singleRepo, windowDays });
  }
  else if (cmd === 'open') {
    // #xcf4556 — recover ONE pushed-but-PR-less lane ref discover's `pr-missing` bucket surfaced: open its PR
    // through the same producer transport every lane uses (`pr-land.mjs --label-on-green`), never a raw `gh pr
    // create`. `--repo=<owner/name>` names a remote constellation repo (from discover's `repo` tag); omit for
    // the cwd repo.
    const ref = positional[1];
    if (ref == null) { process.stderr.write('usage: lane-resume.mjs open <laneRef> [--repo=<owner/name>] [--json]\n'); process.exit(2); }
    const self = localSlug();
    const repoArg = flagVal('repo');
    const repo = repoArg && repoArg !== self ? repoArg : null;
    const verdict = openPrMissingLane(ref, { repo });
    if (asJson) writeAllSync(1, JSON.stringify(verdict, null, 2) + '\n');
    else {
      // A post-open pr-land stop (check-timeout/check-red/…) still OPENED the PR — name it, so nobody reads
      // "not landed yet" as "no PR" and opens a second one by hand.
      const status = verdict.prOpened
        ? `✓ opened PR #${verdict.pr ?? '?'}${verdict.outcome !== 'opened' ? ` — pr-land then stopped (${verdict.reason}); the PR exists, do NOT open another` : ''}`
        : `✗ not opened (${verdict.outcome || 'refused'})`;
      const why = verdict.detail || (!verdict.prOpened ? verdict.reason : '');
      process.stderr.write(`lane-resume open ${ref}${repo ? ` (${repo})` : ''}: ${status}${why ? ` — ${why}` : ''}\n`);
    }
    process.exit(verdict.ok ? 0 : 2);
  }
  else if (cmd === 'land') {
    const prNum = positional[1];
    if (prNum == null) { process.stderr.write('usage: lane-resume.mjs land <pr> [--repo=<owner/name>] [--dry-run] [--json]\n'); process.exit(2); }
    execFileSync('git', ['fetch', 'origin', '--quiet'], { stdio: 'ignore' });
    // #2290 — resolve the drain script off this module's dir so `--only` works from any cwd.
    const drainScript = fileURLToPath(new URL('./merge-ai-prs.mjs', import.meta.url));
    // #2383 — `--repo=<slug>` lands a remote constellation-repo PR (from `discover`'s `repo` tag); omit for the cwd repo.
    const self = localSlug();
    const repo = repos ? null : (flagVal('repo') || null); // a bare non-self slug → route through --repo
    const verdict = land({ prNum, dryRun: argv.includes('--dry-run'), drainScript, repo: repo && repo !== self ? repo : null });
    if (asJson) writeAllSync(1, JSON.stringify(verdict, null, 2) + '\n');
    else process.stderr.write(`lane-resume land #${verdict.pr}${repo ? ` (${repo})` : ''}: ${verdict.merged ? '✓ merged' : verdict.action} — ${verdict.reason}\n`);
    // 0 = enqueued / dry-run / clean / not-green (soft — the drain lands later); red/skip/error = 2.
    const soft = ['enqueued', 'rebuilt-enqueued', 'clean', 'rebuild', 'rebuilt-awaiting-ci', 'not-green'];
    process.exit(verdict.merged || soft.includes(verdict.action) ? 0 : 2);
  }
  // #2396 — the repair-then-rebuild entry points `/finish` drives after fixing a broken stacked link:
  //   rebuild-plan  — plan the salvageable descendant tail (`planStackRebuild`), reading the spec JSON from
  //                   `--spec=<file>` or stdin: {repaired, descendants:[{item,ref,stackParents,fileset}],
  //                   fixTouched?, landed?}. When `landed` is omitted it is DERIVED from the durable
  //                   bornAs-on-main proof (`deriveLandedFromMain`) — never from ref-absence.
  //   rebuild       — execute ONE planned step (`rebuildDescendant`): rebuild <laneRef> onto the repaired
  //                   parent tip SHA. Exit 0 = rebased (ff); exit 2 = guided-conflict (the finisher resolves
  //                   it WITH the manifest topology) or error.
  else if (cmd === 'rebuild-plan') {
    const specPath = flagVal('spec');
    let spec;
    try {
      spec = JSON.parse(readFileSync(specPath && specPath !== '-' ? specPath : 0, 'utf8'));
    } catch (e) {
      process.stderr.write(`rebuild-plan: cannot read spec (${e.message})\nusage: lane-resume.mjs rebuild-plan [--spec=<file>|-] [--json]  # spec = {repaired, descendants:[{item,ref,stackParents,fileset}], fixTouched?, landed?}\n`);
      process.exit(2);
    }
    try { execFileSync('git', ['fetch', 'origin', '--quiet'], { stdio: 'ignore' }); } catch { /* bornAs proof degrades to the local origin/main */ }
    const landed = Array.isArray(spec.landed) ? new Set(spec.landed) : deriveLandedFromMain(spec.descendants || []);
    const plan = planStackRebuild({ repaired: spec.repaired, descendants: spec.descendants || [], fixTouched: spec.fixTouched || [], landed });
    writeAllSync(1, JSON.stringify({ ok: true, repaired: spec.repaired ?? null, landed: [...landed], ...plan }, null, 2) + '\n');
  }
  else if (cmd === 'rebuild') {
    const laneRef = positional[1];
    const ontoSha = flagVal('onto');
    if (!laneRef || !ontoSha) { process.stderr.write('usage: lane-resume.mjs rebuild <laneRef> --onto=<repaired-tip-sha> [--json]\n'); process.exit(2); }
    const verdict = rebuildDescendant({ laneRef, ontoSha });
    if (asJson) writeAllSync(1, JSON.stringify(verdict, null, 2) + '\n');
    else process.stderr.write(`lane-resume rebuild ${laneRef} onto ${ontoSha}: ${verdict.action}${verdict.reason ? ` — ${verdict.reason}` : ''}\n`);
    // `current` (idempotency short-circuit) is SUCCESS, not a guided-conflict/error: a re-run of `rebuild` on an
    // already-rebuilt-but-unlanded descendant (tip already on ontoSha, manifest-free) returns `current` with
    // nothing to do — `/finish` must read exit 0, not 2 (2 reads as a guided conflict and derails the finisher).
    process.exit(['rebased', 'current'].includes(verdict.action) ? 0 : 2);
  }
  else { process.stderr.write(`unknown subcommand: ${cmd}\nusage: lane-resume.mjs discover [--json] [--this-repo|--repos=a,b] [--window-days=N] | open <laneRef> [--repo=<owner/name>] [--json] | land <pr> [--repo=<owner/name>] [--dry-run] [--json] | rebuild-plan [--spec=<file>|-] [--json] | rebuild <laneRef> --onto=<sha> [--json]\n`); process.exit(2); }
}
