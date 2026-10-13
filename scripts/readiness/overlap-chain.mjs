/**
 * @file scripts/readiness/overlap-chain.mjs
 * @description Producer overlap-stacking (#2394, under #2387 F1) — the PURE planner a serial `/batch` uses to
 *   author a SELECTIVE overlap-stacked lane chain, plus the push-time `actual ⊆ declared` safety re-check.
 *
 * WHY (#2387): a serial batch today cuts every item's lane off `origin/main`, so N serial items become N
 * siblings off one base — and the deferred drain re-discovers, blind, every conflict between overlapping
 * items that the authoring session already understood and threw away. The fix is SELECTIVE stacking: only
 * items whose DECLARED file-sets actually overlap stack (each based on its predecessor's pushed tip, via
 * `lane-pool acquire --base`, #2386); provably-disjoint items stay plain siblings off `origin/main`. A landed
 * parent is then an ancestor of main, so the child's drain merge is three-way clean — the conflict was
 * resolved ONCE, at authoring time, with the context hot.
 *
 * THE CHAIN MODEL (union-find flavored, incremental). Items arrive in the batch's serial work order, each
 * with its DECLARED repo-qualified file-set (`"<repo>:<path>"` — the same qualification as
 * `lane-partition.mjs`'s `filesOf`, so the same path in two repos never collides and a genuine same-repo
 * overlap always does). Per item:
 *   • overlaps NO open chain  → a SIBLING off `origin/main`; opens its own chain (a chain of depth 1).
 *   • overlaps ONE chain      → STACKS on that chain's frontier tip (the last pushed item) and extends it.
 *   • overlaps ≥2 chains      → a BRIDGE: bases on the deepest chain's frontier, merges the other chains'
 *     tips in-session, records ALL frontier tips as `stackParents`; the chains fuse into one.
 *   • the extension would exceed the DEPTH CAP → fall back to a SIBLING (today's behavior — the drain may
 *     pay a rebase) and RE-ROOT the chain at this item. The re-rooted chain is CAPPED: its root's history
 *     is conflict-bound with the already-pushed frontier (the drain rewrites it at land), so nothing may
 *     stack on it for the rest of the plan — later overlapping items are siblings in the same capped
 *     cluster, each paying its own drain rebase, never riding a false clean-lineage certificate. The cap
 *     bounds cumulative stacked-CI cost (#2387 open risk).
 *
 * THE PUSH-TIME RE-CHECK (#2387 F1, the critical half). The base is chosen PRE-work but files are known
 * POST-work, so a declared-disjoint sibling can turn out to overlap after all. At push the producer
 * recomputes the ACTUAL touched set (`git diff --name-only <base>...HEAD` — the CLI owns git) and asserts
 * `actual ⊆ declared`. On a violation that overlaps another chain, the verdict is `rebase-required`: the
 * producer rebases onto that chain's frontier IN-SESSION (context hot), re-resolves, records the new
 * `stackParents`, and only then pushes. A post-hoc overlap can therefore NEVER reach the deferred drain as a
 * mislabelled certified-disjoint sibling — the exact blind-conflict reproduction predicted-set stacking
 * without the re-check would have (#2387 F1's rejected alternative).
 *
 * CAPABILITY GATE (#2387 F4 / #2393): stacking is only SAFE once the drain's proof-of-land gate is live on
 * main (a stacked child landing before its parent drags the parent's unreviewed code onto main under the
 * child's number). `createStackPlan` therefore takes the `stackingSupported` verdict read off
 * `origin/main`'s durable capability marker (`drain-capability.mjs`) and, when unsupported, plans EVERY item
 * a plain sibling and disarms the re-check's rebase directive (a rebase-onto-frontier would CREATE a stacked
 * PR the drain can't gate) — defaulting hard to today's behavior, the conservative direction.
 *
 * PURE — no fs, no child_process, no `Date`. The plan is a plain JSON-serializable object: the CLI
 * (`we:scripts/lane-stack.mjs`) persists it to a scratch file between the batch's seams and owns all git.
 * SERIAL contract: items are planned one at a time, each AFTER its predecessor pushed (`recordPushed`) — the
 * frontier a stacked item bases on is always an already-pushed tip.
 */
import { isDrainTransientPath } from '../lib/transient-paths.mjs';

/**
 * The default chain-depth cap (#2387: "cap chain depth — fall back to siblings past the cap"). Each stacked
 * child runs CI over the cumulative stack and a parent repush re-triggers every descendant's CI, so depth is
 * a real cost multiplier; 4 keeps the worst chain a small multiple of a sibling's CI while still absorbing
 * the common 2–3-item overlap runs a serial batch actually produces.
 */
export const DEFAULT_DEPTH_CAP = 4;

/** Normalize a declared/actual file list → a deduped array of repo-qualified path strings. */
function normFiles(files) {
  return [...new Set((Array.isArray(files) ? files : []).map((f) => String(f)).filter(Boolean))];
}

function intersects(listA, listB) {
  const b = new Set(listB);
  return listA.some((f) => b.has(f));
}

/**
 * Split a repo-qualified scope entry (`plateau-app:src/x.ts`, `we:scripts/`) into `{ repo, path }`. An entry with
 * no known prefix is a WE path (the backlog's own convention). `null` for an empty entry.
 */
export function parseScopeEntry(entry) {
  const s = String(entry ?? '').trim();
  if (!s) return null;
  const m = /^([A-Za-z0-9._-]+):(.*)$/.exec(s);
  const repo = m ? m[1] : 'we';
  const path = (m ? m[2] : s).replace(/^\.\//, '').trim();
  if (!path) return null;
  return { repo: repo === 'plateau' ? 'plateau-app' : repo, path };
}

/** Two paths overlap when equal, or when one is a directory prefix of the other (segment boundary). */
export function pathsOverlap(a, b) {
  const x = String(a).replace(/\/+$/, '');
  const y = String(b).replace(/\/+$/, '');
  if (!x || !y) return false;
  return x === y || y.startsWith(`${x}/`) || x.startsWith(`${y}/`);
}

/**
 * The first overlapping pair between two scope lists, or `null`. Entries are repo-qualified strings or
 * `{repo,path}` objects; entries in different repos never overlap. Directory-prefix rule (a superset of the
 * exact-match `intersects` the batch planner uses) — the ONE overlap definition for concurrent dispatch.
 * Ignore drain-transient paths even in stale claims (2026-10-13: #4965/#5083/#5026 blocked behind #5038 on evidence).
 */
export function firstScopeOverlap(scopeA, scopeB) {
  const parse = (list) => (list || []).map((e) => (typeof e === 'string' ? parseScopeEntry(e) : e))
    .filter((e) => e && !isDrainTransientPath(e.path));
  const bs = parse(scopeB);
  for (const a of parse(scopeA)) {
    for (const b of bs) {
      if (a.repo === b.repo && pathsOverlap(a.path, b.path)) return `${a.repo}:${a.path}`;
    }
  }
  return null;
}

/**
 * Does `files` overlap any in-flight item's scope? `inFlight` is `[{id, scope}]`; returns
 * `{hit, with}` (first overlapping path, and the in-flight item's `id`) or `null`. Pure. Dispatch SERIALIZES on
 * a hit (holds the later item) — it cannot stack, since a concurrent predecessor has no pushed tip yet.
 */
export function overlapsInFlight(files, inFlight) {
  for (const r of inFlight || []) {
    const hit = firstScopeOverlap(files, r?.scope);
    if (hit) return { hit, with: r.id };
  }
  return null;
}

/**
 * Create a fresh stack plan. JSON-serializable (arrays/objects only — the CLI round-trips it to a scratch
 * file between seams).
 * @param {{supported:boolean, depthCap?:number}} opts  `supported` = the capability-marker verdict read off
 *   `origin/main` ({@link ../readiness/drain-capability.mjs} `stackingSupported`) — false ⇒ every item plans
 *   as a plain sibling (the hard conservative default).
 */
export function createStackPlan({ supported, depthCap = DEFAULT_DEPTH_CAP } = {}) {
  return {
    supported: !!supported,
    depthCap: Number.isInteger(depthCap) && depthCap >= 1 ? depthCap : DEFAULT_DEPTH_CAP,
    // id → { id, declared:[…], chain, stackParents:[…], sibling:bool, pushed:bool, actual:[…]|null,
    //        tips:{ [repo]: {sha, ref} } } — `tips` are the item's pushed per-repo lane tips (recordPushed).
    items: {},
    // chainId → { files:[…], frontier: itemId|null (last PUSHED member), depth } — `frontier:null` only
    // before the chain's root pushes. A chain absorbed by a bridge gets `mergedInto: <chainId>` instead.
    // `capped: true` marks a depth-cap re-root cluster: conflict-bound history, never stackable-on.
    chains: {},
    nextChain: 1,
  };
}

/** Follow a chain's `mergedInto` pointers (bridge fusions) to its live root's chain ID. */
function liveChainId(plan, chainId) {
  let id = chainId;
  while (plan.chains[id] && plan.chains[id].mergedInto != null) id = plan.chains[id].mergedInto;
  return id;
}

/** Follow a chain's `mergedInto` pointers (bridge fusions) to its live root. */
function liveChain(plan, chainId) {
  return plan.chains[liveChainId(plan, chainId)];
}

/**
 * THE one chain-fusion mutation (#2394 review round 2 — previously hand-rolled at four sites with drifting
 * rules). Absorb live chain `fromId` into live chain `intoId`: union the files, carry the deeper depth, and
 * propagate the CAPPED flag (conflict-bound history survives any fusion — a cluster that fuses with a capped
 * chain is itself conflict-bound). `fromId` becomes a `mergedInto` pointer at its live root. Both ids may be
 * stale — they are resolved to live roots here; fusing a chain with itself is a no-op.
 */
function fuseChains(plan, intoId, fromId) {
  const liveInto = liveChainId(plan, intoId);
  const liveFrom = liveChainId(plan, fromId);
  if (liveInto === liveFrom) return liveInto;
  const into = plan.chains[liveInto];
  const from = plan.chains[liveFrom];
  into.files = [...new Set([...into.files, ...from.files])];
  into.depth = Math.max(into.depth, from.depth);
  if (from.capped) into.capped = true;
  from.mergedInto = liveInto;
  return liveInto;
}

/**
 * The distinct LIVE chains whose cumulative file-sets intersect `files`. Only live roots are scanned — a
 * merged chain's files were absorbed into its live root at fusion time, so its stale entry never needs
 * pointer-chasing here (the live root the scan already visits carries the superset).
 */
function overlappingChains(plan, files, excludeItemId = null) {
  const excluded = excludeItemId != null && plan.items[excludeItemId]
    ? liveChain(plan, plan.items[excludeItemId].chain)
    : null;
  const out = [];
  for (const [cid, c] of Object.entries(plan.chains)) {
    if (c.mergedInto != null) continue;
    if (c === excluded) continue;
    if (intersects(files, c.files)) out.push({ chainId: cid, chain: c });
  }
  return out;
}

/**
 * Plan the NEXT item of the serial batch (call in work order, after the predecessor's `recordPushed`).
 * Returns the stacking decision; the caller maps parent item-ids to concrete refs via each parent's recorded
 * `tips` (exposed on the decision as `baseTips`).
 *
 * @param {object} plan
 * @param {{id:string|number, files:Array<string>}} item  `files` = the DECLARED repo-qualified file-set
 *   (`"<repo>:<path>"`), derived from the item's body/locus at pack time.
 * @returns {{id:string, stacked:boolean, base:string|null, mergeParents:string[], stackParents:string[],
 *   baseTips:object|null, reason:string}}
 *   `base` = the item-id whose pushed tip to `lane-pool acquire --base` on (null ⇒ `origin/main`);
 *   `mergeParents` = further frontier item-ids a BRIDGE merges in-session after acquiring at `base`;
 *   `stackParents` = every frontier item-id stacked on (goes into the manifest, #2389);
 *   `baseTips` = the base parent's recorded per-repo `{sha, ref}` tips (the concrete acquire/manifest refs).
 */
export function planNextItem(plan, { id, files }) {
  const itemId = String(id);
  if (plan.items[itemId]) throw new Error(`item ${itemId} is already planned`);
  const declared = normFiles(files);

  const sibling = (reason) => {
    const chainId = String(plan.nextChain++);
    plan.chains[chainId] = { files: [...declared], frontier: null, depth: 0 };
    plan.items[itemId] = { id: itemId, declared, chain: chainId, stackParents: [], sibling: true, pushed: false, actual: null, tips: null };
    return { id: itemId, stacked: false, base: null, mergeParents: [], stackParents: [], baseTips: null, reason };
  };

  // Capability gate (#2387 F4): no positive proof the drain's proof-of-land gate is live ⇒ plain siblings.
  if (!plan.supported) return sibling('stacking-unsupported (capability marker absent/stale — default hard to siblings)');

  const rawOverlaps = overlappingChains(plan, declared);

  // CAPPED cluster (#2394 review): a chain re-rooted by a depth-cap fallback carries CONFLICT-BOUND history —
  // its root edits files an already-pushed frontier also edits, off pre-frontier main, so the drain WILL
  // rewrite it at land. Stacking on such a chain would extend a clean-lineage certificate the drain's rebase
  // then falsifies for every descendant. So the capped flag is sticky for the plan's lifetime (nothing lands
  // mid-batch): any overlap with a capped chain ⇒ sibling, and the overlapping chains fuse into the new
  // sibling's chain — itself capped — so the whole file cluster stays overlap-visible but never stackable.
  if (rawOverlaps.some((o) => o.chain.capped)) {
    const d = sibling('overlaps a depth-capped chain — its history is conflict-bound (drain will rewrite it at land), so no clean-lineage certificate is possible; sibling, drain may pay a rebase (today’s cost)');
    const ownId = plan.items[itemId].chain;
    for (const o of rawOverlaps) fuseChains(plan, ownId, o.chainId);
    plan.chains[ownId].capped = true;
    return d;
  }

  // Only chains with a PUSHED frontier can be stacked on (serial contract); a frontier-less chain (its root
  // was planned but never pushed — a carried/dropped item) is overlap-visible but not stackable.
  const overlaps = rawOverlaps.filter((o) => o.chain.frontier != null);
  if (overlaps.length === 0) {
    return sibling(rawOverlaps.length
      ? 'overlapping chain(s) have no pushed frontier (carried/dropped root) — nothing to stack on'
      : 'disjoint from every open chain');
  }

  // Deepest chain first: base on it (fewest in-session merges for a bridge) and cap-check against it.
  overlaps.sort((a, b) => b.chain.depth - a.chain.depth);
  const newDepth = overlaps[0].chain.depth + 1;
  if (newDepth > plan.depthCap) {
    // Past the cap: fall back to a sibling (the drain may pay a rebase — today's cost) and RE-ROOT: the new
    // chain absorbs the over-deep chain's cumulative files so the cluster stays overlap-visible. The re-root
    // is marked CAPPED — this sibling edits the cluster's files off pre-frontier main, so the drain will
    // rewrite it at land; NOTHING may stack on it (or on any later member) until the plan ends, else the
    // clean-lineage certificate would be false for every descendant (#2394 review). Later overlapping items
    // become siblings in the same capped cluster (the branch above) — the cap's cost stays "one drain rebase
    // PER capped sibling", never a silently-broken stacked guarantee.
    const d = sibling(`depth cap (${plan.depthCap}) reached — sibling fallback, chain re-rooted (capped: not stackable)`);
    const rerootedId = plan.items[itemId].chain;
    for (const o of overlaps) fuseChains(plan, rerootedId, o.chainId);
    plan.chains[rerootedId].capped = true;
    return d;
  }

  const parents = overlaps.map((o) => o.chain.frontier);
  const [baseParent, ...mergeParents] = parents;
  // Fuse: everything joins the deepest (base) chain; the bridged chains point at it.
  const baseChainId = overlaps[0].chainId;
  for (const o of overlaps.slice(1)) fuseChains(plan, baseChainId, o.chainId); // frontier + depth advance at recordPushed
  const baseChain = liveChain(plan, baseChainId);
  baseChain.files = [...new Set([...baseChain.files, ...declared])];
  plan.items[itemId] = { id: itemId, declared, chain: baseChainId, stackParents: parents, sibling: false, pushed: false, actual: null, tips: null };
  return {
    id: itemId,
    stacked: true,
    base: baseParent,
    mergeParents,
    stackParents: parents,
    baseTips: plan.items[baseParent] ? plan.items[baseParent].tips : null,
    reason: mergeParents.length ? `bridges ${overlaps.length} chains — merge their tips in-session` : `overlaps open chain — stacks on #${baseParent}`,
  };
}

/**
 * The push-time safety re-check (#2387 F1): assert the ACTUAL touched set (`git diff --name-only
 * <base>...HEAD`, repo-qualified by the CLI) is a subset of the DECLARED set, and classify any excess.
 * Read-only — records nothing; act on the verdict, then `applyRebase`/`recordPushed`.
 *
 * Verdicts:
 *   • `clean`               — `actual ⊆ declared`; push as planned.
 *   • `undeclared-disjoint` — excess files, but they overlap NO other chain: no mislabelling hazard, push
 *     (the excess is absorbed into the item's chain at `recordPushed` so later planning sees reality).
 *   • `rebase-required`     — excess overlaps other chain(s): do NOT push. `ok:false`; `onto` names the
 *     frontier item-ids to rebase onto in-session (then `applyRebase`, re-gate, re-run this check).
 *   • `undeclared-capped`   — the item (or its excess) touches a CAPPED cluster, OR the directed rebase
 *     would fuse the item past `depthCap` (the cap binds on this path exactly as in planNextItem — else a
 *     run of under-declared items grows a chain without bound): a rebase onto the frontier would mint a
 *     clean-lineage certificate the drain's rewrite falsifies (capped) or a stack the cap forbids (depth),
 *     so the directive is disarmed and the item ships as the sibling it is — the drain pays the rebase
 *     (today's cost, honestly labelled). Applies even when the excess ALSO overlaps a normal chain: a
 *     partial certificate (stacked on the normal frontier, still conflict-bound with the capped cluster)
 *     would be a false guarantee, worse than a plain sibling that claims nothing.
 *   • `stacking-unsupported`— capability off: the rebase directive is disarmed (it would CREATE a stacked
 *     PR the drain can't gate); excess is reported for the ledger but the item ships as the sibling it is.
 *
 * @param {object} plan
 * @param {{id:string|number, actualFiles:Array<string>}} input
 * @returns {{ok:boolean, verdict:string, undeclared:string[], onto:string[], ontoTips:object}}
 */
export function recheckAtPush(plan, { id, actualFiles }) {
  const itemId = String(id);
  const item = plan.items[itemId];
  if (!item) throw new Error(`item ${itemId} is not in the plan`);
  const actual = normFiles(actualFiles);
  const declared = new Set(item.declared);
  const undeclared = actual.filter((f) => !declared.has(f));
  if (undeclared.length === 0) return { ok: true, verdict: 'clean', undeclared: [], onto: [], ontoTips: {} };
  if (!plan.supported) return { ok: true, verdict: 'stacking-unsupported', undeclared, onto: [], ontoTips: {} };
  const overlapsAll = overlappingChains(plan, undeclared, itemId);
  // CAPPED involvement disarms the rebase directive (see the verdict table above): rebasing would mint a
  // certificate the drain's rewrite of the capped root falsifies. Ship as the sibling it is.
  if (liveChain(plan, item.chain).capped || overlapsAll.some((o) => o.chain.capped)) {
    return { ok: true, verdict: 'undeclared-capped', undeclared, onto: [], ontoTips: {} };
  }
  const clashes = overlapsAll.filter((o) => o.chain.frontier != null);
  if (clashes.length === 0) return { ok: true, verdict: 'undeclared-disjoint', undeclared, onto: [], ontoTips: {} };
  // The depth cap binds at push time too (#2394 review round 2): a rebase onto these frontiers would fuse
  // the item into the clash chain(s) and `recordPushed` would bump the fused depth PAST `depthCap` —
  // unbounded growth invisible to planNextItem's cap because the item DECLARED disjoint. Same rule as the
  // planner's fallback: past the cap the item ships as the sibling it is (the drain pays the rebase,
  // honestly labelled `undeclared-capped`), and `recordPushed` then fuses + caps the cluster so nothing
  // later stacks on this conflict-bound frontier either.
  const fusedDepth = Math.max(liveChain(plan, item.chain).depth, ...clashes.map((o) => o.chain.depth)) + 1;
  if (fusedDepth > plan.depthCap) return { ok: true, verdict: 'undeclared-capped', undeclared, onto: [], ontoTips: {} };
  const onto = clashes.map((o) => o.chain.frontier);
  const ontoTips = Object.fromEntries(onto.map((p) => [p, plan.items[p] ? plan.items[p].tips : null]));
  return { ok: false, verdict: 'rebase-required', undeclared, onto, ontoTips };
}

/**
 * Record an IN-SESSION rebase performed on a `rebase-required` verdict: the item now sits on the named
 * frontier tips, so they join its `stackParents`, its declared set absorbs the actual files (the overlap is
 * now resolved history, not an undeclared surprise), and the chains fuse. Re-run {@link recheckAtPush}
 * after — it must come back `ok` before the push.
 * @param {object} plan
 * @param {{id:string|number, onto:string[], actualFiles?:Array<string>}} input  `onto` = the verdict's
 *   frontier item-ids the lane was rebased onto.
 */
export function applyRebase(plan, { id, onto, actualFiles = [] }) {
  const itemId = String(id);
  const item = plan.items[itemId];
  if (!item) throw new Error(`item ${itemId} is not in the plan`);
  for (const parentId of (onto || []).map(String)) {
    const parent = plan.items[parentId];
    if (!parent) throw new Error(`rebase parent ${parentId} is not in the plan`);
    if (!item.stackParents.includes(parentId)) item.stackParents.push(parentId);
    // Fuse into the parent's chain (it has the pushed frontier); the item's own chain points at it.
    // fuseChains re-resolves BOTH live roots per iteration: a multi-parent rebase (`onto` from a
    // bridge-shaped violation) must fuse EVERY parent's chain into one — comparing against a pre-loop
    // snapshot would overwrite `mergedInto` per iteration and leave stale live frontiers behind.
    item.chain = fuseChains(plan, parent.chain, item.chain);
  }
  item.sibling = false;
  item.declared = [...new Set([...item.declared, ...normFiles(actualFiles)])];
  const c = liveChain(plan, item.chain);
  c.files = [...new Set([...c.files, ...item.declared])];
}

/**
 * Record a successful push: the item becomes its chain's FRONTIER (depth +1), its actual files are absorbed
 * into the chain's cumulative set (later planning sees reality, not just declarations), and its per-repo
 * tips (`{ [repo]: {sha, ref} }`) are stored — the concrete refs a successor's acquire/manifest will use.
 * @param {object} plan
 * @param {{id:string|number, actualFiles?:Array<string>, tips?:object}} input
 */
export function recordPushed(plan, { id, actualFiles = [], tips = null }) {
  const itemId = String(id);
  const item = plan.items[itemId];
  if (!item) throw new Error(`item ${itemId} is not in the plan`);
  item.pushed = true;
  item.actual = normFiles(actualFiles);
  item.tips = tips || item.tips;
  const ownId = liveChainId(plan, item.chain);
  const c = plan.chains[ownId];
  c.files = [...new Set([...c.files, ...item.actual])];
  c.frontier = itemId;
  c.depth += 1;
  // Overlap propagation (#2394 review round 2 — was capped-only): reaching record with a still-live
  // overlapping chain means the recheck disarmed its rebase directive (capped cluster, the depth cap, or
  // stacking-unsupported) — the item pushed WITHOUT stacking on that chain. Fuse them so the whole file
  // cluster stays one overlap-visible chain, and when the other side has PUSHED history (a frontier, or it
  // was already capped) mark the fused chain CAPPED: this item's pushed history is conflict-bound with that
  // frontier — the drain will rewrite one of them at land — so nothing may stack on it. A frontier-less
  // overlap (a dropped/carried root) fuses for visibility only: no pushed history exists to conflict with,
  // so the fused chain stays stackable.
  for (const o of overlappingChains(plan, c.files, itemId)) {
    if (o.chain.capped || o.chain.frontier != null) c.capped = true;
    fuseChains(plan, ownId, o.chainId);
  }
}

/**
 * Drop a planned-but-never-pushed item (carried / gate-red — no PR). Its declared files STAY in the chain's
 * cumulative set (conservative: a later item overlapping them still stacks rather than risk a blind
 * conflict), but since the item never pushed it was never a frontier, so nothing else changes.
 */
export function dropItem(plan, { id }) {
  const itemId = String(id);
  const item = plan.items[itemId];
  if (!item) throw new Error(`item ${itemId} is not in the plan`);
  if (item.pushed) throw new Error(`item ${itemId} already pushed — cannot drop`);
  item.dropped = true;
}
