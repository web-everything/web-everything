/**
 * @file scripts/conveyor/build-dispatch-policy.mjs
 * @description #3984 slice 1 — the build-dispatch daemon's DECLARED POLICY and its PURE planner.
 *
 * The standalone build-dispatch daemon (we:skills-src/conveyor/build-dispatch-daemon.mjs) asks the tick core
 * (we:scripts/conveyor/tick-core.mjs) which cleared items it may launch this tick (`decisions.spawnBuilds`) and
 * then runs this planner OVER that answer. The planner never re-derives a tick-core guard (lane exclusion,
 * scope-lease arbitration, TTLs, capacity) — it only ADDS the operator rules below as extra holds. An item the
 * tick core refused never reaches here as dispatchable; an item this planner holds is simply not dispatched this
 * tick and is re-planned next tick.
 *
 * THE OPERATOR RULES, as data (`BUILD_DISPATCH_POLICY`) — each row names who enforces it, so a rule that is
 * declared but not yet enforced by code is visible as such rather than silently assumed:
 *   - cap concurrent builds by executor (Claude default 1, external default 4), counted over DURABLE in-flight evidence (claims + run records), so a
 *     daemon restart cannot reset the count;
 *   - wip-cap (#4353): cap OPEN ITEMS — build start until merge (durable in-flight ∪ delivered-by-open-PR),
 *     the UNION not the sum — separately from `maxConcurrentBuilds`, which only bounds machine load. An item
 *     stops counting the moment it is no longer in-flight AND no open PR delivers it (merged, or the PR closed).
 *     Card xovjhwh (operator decision 2026-09-29): the delivered-by-open-PR side counts ONLY PRs this builder
 *     itself dispatched (per its own durable run records, `dispatchedByBuilder`) — a hand-dispatched worker's PR
 *     still counts toward `maxOpenPrs`/`hot-file`, but never toward this cap;
 *   - landing freeze: hold every new build while open PRs exceed `maxOpenPrs`, or while any open PR carries a
 *     label that means "a daemon failed to move this PR" (`freezeLabels`);
 *   - scope check against every open PR's files, and hot-file serialisation: no two in-flight builds (or two
 *     picks in one tick) touch the same file;
 *   - branch names never start with a bare number (the delivery ref is `lane/<num>...`);
 *   - task-prefixed scratch files and draft-first PRs — declared here, enforced by the brief / PR #2813.
 *
 * `maxOpenPrs` vs `maxOpenItems` (#4353 task 4, decided from LIVE data 2026-09-28): kept as two distinct
 * thresholds, not folded into one. Live `openPrs` that day included
 * `lane/investigate-lane-reset` — a real open PR with no leading-digit delivery ref, so it counts toward
 * `maxOpenPrs` (total review/CI load this repo is carrying) but NOT toward `maxOpenItems` (backlog-card WIP).
 * The populations provably diverge in practice, so `maxOpenPrs` stays as the coarser "how much is open in this
 * repo at all" ceiling while `maxOpenItems` is the per-card pipeline cap this card adds.
 *
 * PURE: no fs, no clock, no child_process. Every input is passed in; unit-tested in
 * we:scripts/conveyor/__tests__/build-dispatch-policy.test.mjs.
 */

import { normNum } from './queue-store.mjs';
import { parseScopeEntry, pathsOverlap, firstScopeOverlap, overlapsInFlight } from '../readiness/overlap-chain.mjs';

/** The declared policy. Numbers are defaults; the daemon may override the concurrency/open-item caps from
 *  flags, never the rule set itself. */
export const BUILD_DISPATCH_POLICY = Object.freeze({
  maxConcurrentBuilds: 1, // --max-concurrent: Claude, including unknown legacy executors
  maxConcurrentExternalBuilds: 4, // Codex + Antigravity together
  maxOpenPrs: 12,
  // #4353 — open items from build start until MERGE (durable in-flight ∪ delivered-by-open-PR), a tighter,
  // separate cap from `maxConcurrentBuilds` (which only bounds builds actually running right now). Unmeasured
  // starting point per the operator's own framing — see `planBuildDispatch`'s `wip-cap` rule below.
  maxOpenItems: 7,
  // Card 80 — prepare just in time (operator OK 2026-10-06). Only the next `prepareAheadWindow` cards to build
  // (pinned first) get a prepare; a stamp older than `preparedMaxAgeDays`, or one whose scope files changed since
  // its `preparedAgainstSha`, is re-prepared before it builds (`prepare-stale`). Flags/env override both.
  prepareAheadWindow: 4,
  preparedMaxAgeDays: 3,
  // Live incident 2026-09-28 (we#2852): ONE PR mislabelled `review-status:ci-heal-stalled` (a ci-heal session
  // that had actually finished — see we:scripts/conveyor/review-status-tag.mjs's own fix for that bug) froze
  // EVERY queued build, unrelated scope or not, because these three per-PR labels used to feed the SAME global
  // `frozen` gate as the operator's manual `blocked:daemon-bug`. They are informative/derived
  // (we:scripts/conveyor/review-status-tag.mjs), not an operator decision, and a single stuck PR must never
  // freeze work that does not touch its files — that is exactly what `scope-vs-open-prs` below already proves
  // per candidate against EVERY open PR unconditionally (stalled or not), so a stalled PR still correctly holds
  // an overlapping build without a separate freeze clause. Only `blocked:daemon-bug` — the operator's own manual
  // signal, never auto-applied — still freezes the whole queue; see `globalFreezeLabels` below.
  freezeLabels: Object.freeze([
    'review-status:fix-stalled',
    'review-status:ci-heal-stalled',
    'review-status:review-stalled',
    'blocked:daemon-bug',
  ]),
  // The subset of `freezeLabels` that holds EVERY candidate regardless of scope — see the docblock just above
  // for why the three per-PR `*-stalled` labels were removed from this set (#3383 continuation, live incident
  // 2026-09-28). `freezeLabels` itself is kept, unchanged, purely for status/dry-run display
  // (we:skills-src/conveyor/build-dispatch-daemon.mjs) — `planBuildDispatch` reads `globalFreezeLabels` only.
  globalFreezeLabels: Object.freeze(['blocked:daemon-bug']),
  rules: Object.freeze([
    { id: 'cap', text: 'at most maxConcurrentBuilds Claude and maxConcurrentExternalBuilds external builds in flight', enforcedBy: 'build-dispatch-policy.mjs' },
    { id: 'wip-cap', text: 'at most maxOpenItems items open from build start until merge (durable in-flight ∪ delivered-by-open-PR)', enforcedBy: 'build-dispatch-policy.mjs' },
    { id: 'landing-freeze', text: 'no new build while open PRs > maxOpenPrs or any open PR carries a freeze label', enforcedBy: 'build-dispatch-policy.mjs' },
    { id: 'scope-vs-open-prs', text: "a build whose scope overlaps an open PR's files waits for that PR", enforcedBy: 'build-dispatch-policy.mjs' },
    { id: 'hot-file', text: 'no two in-flight builds on the same file', enforcedBy: 'build-dispatch-policy.mjs' },
    { id: 'branch-name', text: 'a delivery branch never starts with a bare number', enforcedBy: 'build-dispatch-policy.mjs (checks the planned ref)' },
    { id: 'scratch-prefix', text: 'scratch files in the brief are task-prefixed', enforcedBy: 'delivery brief (follow-up card)' },
    { id: 'draft-first', text: 'agent PRs open as drafts and are promoted on green', enforcedBy: 'PR #2813' },
    // Card #4470 (operator rule 2026-09-28: PREPARE = full design + explicit MVP cut, build only the MVP) —
    // enforced UPSTREAM of this file: a card with no truthful `preparedDate` never even becomes a candidate
    // this planner sees (`dispatch-plan.mjs` holds it `needs-prepare` before it ever reaches `spawnBuilds`), so
    // this row is DOCUMENTATION PARITY (every operator rule visible here, per this file's own header) — no
    // logic in this planner changes for it.
    { id: 'needs-prepare', text: 'a candidate carrying no truthful preparedDate is never built — held for a prepare pass first', enforcedBy: 'readiness/dispatch-plan.mjs' },
    { id: 'prepare-ahead-window', text: 'only the next prepareAheadWindow cards to build (pinned first) are prepared', enforcedBy: 'conveyor/tick-core.mjs (prepareAheadNums)' },
    { id: 'prepare-stale', text: 'a stamp older than preparedMaxAgeDays, or whose scope files changed since preparedAgainstSha, is re-prepared before build', enforcedBy: 'readiness/dispatch-plan.mjs' },
  ]),
});

export { parseScopeEntry };

// One overlap definition, shared with fix dispatch (#4295) — lives in the pure chain planner.
export { pathsOverlap, firstScopeOverlap };

/**
 * The branch-name rule: the first path segment of a ref must not start with a digit (`lane/2385-x` is fine,
 * `2385-x` is not — the drain reads a leading digit run as "this PR delivers card N").
 * @returns {{ok:boolean, reason:string|null}}
 */
export function branchRefPolicy(ref) {
  const r = String(ref ?? '').trim();
  if (!r) return { ok: false, reason: 'empty ref' };
  if (/^[0-9]/.test(r)) return { ok: false, reason: `ref ${JSON.stringify(r)} starts with a bare number` };
  return { ok: true, reason: null };
}

/** The ref a build of `num` publishes to (mirrors delivery-agent-brief.md step 8: `lane/<num><attempt>-<slug>`). */
export function plannedBuildRef(num) {
  return `lane/${normNum(num) || String(num)}-build`;
}

/** The delivery-ref shape: `lane/<num>[attempt]-<slug>`. The digit/hash run must end there (so `lane/2385-x`
 *  matches 2385 but not 238), and a leading `x` marks a hash-numbered card (`lane/xcd92xh-x`). */
const DELIVERY_REF_RE = /^lane\/(\d+|x[0-9a-z]{6})[b-z]?-/i;

/** The num an open PR's `headRefName` delivers, or `null` when it does not match the delivery-ref shape at all
 *  (a hand-made / non-item PR, e.g. `lane/investigate-lane-reset` — counts toward `maxOpenPrs` but not toward
 *  `maxOpenItems`, #4353). */
export function prDeliveredNum(pr) {
  const m = DELIVERY_REF_RE.exec(String(pr?.headRefName ?? ''));
  return m ? normNum(m[1]) : null;
}

/** Does an open PR deliver `num`? Same delivery-ref match as {@link prDeliveredNum}, pinned to one num. */
export function prDeliversNum(pr, num) {
  const key = normNum(num);
  if (!key) return false;
  return prDeliveredNum(pr) === key;
}

/**
 * Turn an open-PR list (per repo) into `{repo, number, files:[{repo,path}], labels:[string]}` rows.
 * @param {Array<{repo:string, prs:Array<object>}>} byRepo
 */
export function normalizeOpenPrs(byRepo) {
  const out = [];
  for (const { repo, prs } of byRepo || []) {
    for (const pr of prs || []) {
      out.push({
        repo,
        number: pr.number,
        headRefName: pr.headRefName ?? '',
        labels: (pr.labels || []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean),
        files: (pr.files || []).map((f) => ({ repo, path: String(f?.path ?? f ?? '') })).filter((f) => f.path),
      });
    }
  }
  return out;
}

function executorClass(executor) {
  return executor === 'codex' || executor === 'antigravity' ? 'external' : 'claude';
}

/**
 * THE PLANNER. Given this tick's candidates (the tick core's `spawnBuilds`, each enriched with the item's
 * scope and executor predicted by dispatch routing), the durable in-flight builds, and the open PRs, decide which to dispatch and why each other one waits.
 *
 * @param {object} o
 * @param {Array<{num:string, lane?:number, scope:string[], executor?:string, route?:object}>} o.candidates  in tick-core order
 * @param {Array<{num:string, scope:string[], source:string, executor?:string|null}>} o.inFlight   durable
 *   in-flight builds — `executor` (card xao7080/#4518, `claude`/`antigravity`/`codex`/`null`) rides through
 *   used to count each executor class independently; unknown executors consume Claude capacity
 * @param {Array<{repo:string, number:number, files:Array, labels:string[], headRefName:string}>} o.openPrs
 * @param {number} [o.externalBuilding]  the conveyor's machine-wide "building" count — hand-dispatched workers,
 *   fix workers, ci-heal workers, stranded claims, AND this daemon's own builds, all folded into one tally with
 *   no way to tell them apart. Operator decision (2026-09-29, card x3vs6tu): this cap bounds ONLY the builder's
 *   own concurrent builds; machine-wide load is the separate load guard's job (#4076) and the heavy-admission
 *   slots', not this cap's. So `externalBuilding` is NEVER folded into `busy` any more — see the live incident
 *   below. It still rides through to the return value (`externalBuilding` field) purely as a logged signal, so
 *   the daemon's dry-run/status line can keep showing it even though it no longer gates anything here.
 *
 *   Live incident, 2026-09-29 ~10:35 AM ET: with 2 stranded claims + 4 hand-dispatched workers, this builder
 *   read "6 building" at its own cap of 6 (0 of its own builds actually making progress) and dispatched NOTHING
 *   for 30+ minutes while 116 items sat queued — the old `max(durable in-flight, externalBuilding)` math let a
 *   machine-wide count that had nothing to do with this builder's own concurrency hold every candidate. At the
 *   operator's chosen cap of 3 the builder would never build at all while ANY other worker ran anywhere.
 * @param {Array<{pr:number, scope:string[]}>} [o.fixInFlight]  #4295 — live FIX/ci-heal claims' scopes; a candidate
 *   overlapping one is held `hot-file`. Separate from `inFlight` (fix claims have no item `num`).
 * @param {{engaged:boolean, reason?:string}} [o.killSwitch]
 * @param {object} [o.policy]
 * @param {Iterable<string>|null} [o.dispatchedByBuilder] card xovjhwh (operator decision 2026-09-29): the set of
 *   item nums THIS builder's own durable dispatch-lane run records show it dispatched a build for (in-flight or
 *   already settled — see `build-dispatch-daemon.mjs`'s `runBuildDispatchTick`, which derives it from the same
 *   `listRunStoreInFlight`/`listSettledBuilds` reads it already makes). When given, an open PR only feeds the
 *   `wip-cap` union when its delivered num is IN this set — a hand-dispatched worker's PR (fix worker, ci-heal
 *   worker, stranded-claim resume) never went through this builder's own run records, so it must not fill
 *   `maxOpenItems` just because its branch name matches the delivery-ref shape. It still counts toward
 *   `maxOpenPrs` and still participates in `scope-vs-open-prs`/`hot-file` — neither reads this set. `null` (the
 *   default) keeps the OLD, unfiltered union — every existing caller/test that predates this card sees no
 *   change; the real daemon always passes its own set.
 * @returns {{freeze:{frozen:boolean, reasons:string[]}, slots:number, dispatch:Array<object>, hold:Array<object>,
 *   openItems:{count:number, cap:number, nums:string[]}}} `openItems` is the PRE-TICK union
 *   (`{inFlight} ∪ {delivered-by-open-PR ∩ dispatchedByBuilder}`), #4353/xovjhwh — the value the `wip-cap` rule
 *   below checks and decrements.
 */
export function planBuildDispatch({
  candidates = [], inFlight = [], openPrs = [], externalBuilding = 0, killSwitch = { engaged: false }, policy = BUILD_DISPATCH_POLICY,
  dispatchedByBuilder = null, fixInFlight = [],
} = {}) {
  const hold = [];
  const dispatch = [];
  const freezeReasons = [];
  // Card x60i0ie — WHY the queue is frozen, as stable kinds (`kill-switch` | `open-prs` | `label`), so a caller can
  // tell an open-PR-count freeze (a build-WIP limit) from a kill switch or a freeze label (hold everything).
  const freezeKinds = new Set();
  if (killSwitch?.engaged) { freezeReasons.push(`kill switch engaged${killSwitch.reason ? ` (${killSwitch.reason})` : ''}`); freezeKinds.add('kill-switch'); }
  if (openPrs.length > policy.maxOpenPrs) { freezeReasons.push(`${openPrs.length} open PRs > maxOpenPrs ${policy.maxOpenPrs}`); freezeKinds.add('open-prs'); }
  // GLOBAL freeze set — `blocked:daemon-bug` only (#3383 continuation, live incident 2026-09-28). A per-PR
  // `*-stalled` label never reaches this set any more; it is still an ordinary open PR below, so the
  // `scope-vs-open-prs` loop still holds any candidate whose scope overlaps ITS files. Falls back to the full
  // `freezeLabels` only for a caller passing a policy object that predates `globalFreezeLabels` (defensive, not
  // expected in this codebase — every caller here uses `BUILD_DISPATCH_POLICY`).
  const freezeSet = new Set(policy.globalFreezeLabels ?? policy.freezeLabels ?? []);
  for (const pr of openPrs) {
    const hit = pr.labels.find((l) => freezeSet.has(l));
    if (hit) { freezeReasons.push(`${pr.repo}#${pr.number} is labelled ${hit}`); freezeKinds.add('label'); }
  }
  const frozen = freezeReasons.length > 0;

  // Dedupe in-flight by num (a claim and a run record for the same build are one build).
  const inFlightByNum = new Map();
  for (const f of inFlight) {
    const k = normNum(f.num);
    if (!k) continue;
    const prev = inFlightByNum.get(k);
    inFlightByNum.set(k, prev ? { ...prev, executor: (['claude', 'codex', 'antigravity'].includes(prev.executor) ? prev.executor : f.executor ?? prev.executor), scope: [...new Set([...(prev.scope || []), ...(f.scope || [])])], source: `${prev.source}+${f.source}` } : { ...f, num: k });
  }
  const running = [...inFlightByNum.values()];
  // Card x3vs6tu (2026-09-29): the cap counts ONLY this builder's own durable in-flight builds — never
  // `externalBuilding` (machine-wide "building", not attributable to this builder). Kept as a logged signal
  // below (`externalBuilding` on the return value), never folded into `busy`/`slots` any more.
  const busy = running.length;
  // Legacy `slots` reports Claude headroom; `slotsByClass` exposes both pools.
  const caps = { claude: policy.maxConcurrentBuilds, external: policy.maxConcurrentExternalBuilds ?? BUILD_DISPATCH_POLICY.maxConcurrentExternalBuilds };
  const counts = { claude: 0, external: 0 };
  for (const r of running) counts[executorClass(r.executor)] += 1;
  const slotsByClass = Object.fromEntries(Object.entries(caps).map(([kind, cap]) => [kind, Math.max(0, cap - counts[kind])]));
  const picked = [];
  // #4353 — a policy object missing `maxOpenItems` (a caller predating this field) must never silently disable
  // the cap: `>= undefined` is always false, so an unguarded read would fail OPEN. Falls back to the declared
  // default the same way `globalFreezeLabels ?? freezeLabels` already does above for an older policy shape.
  const maxOpenItems = Number.isFinite(policy.maxOpenItems) ? policy.maxOpenItems : BUILD_DISPATCH_POLICY.maxOpenItems;

  // #4353 — the WIP union: {inFlight} ∪ {delivered-by-open-PR}, deduped by num (a build whose OWN PR is already
  // open and counted is not double-counted just because its claim also still shows in-flight).
  // `openItemsInitial` is the PRE-TICK snapshot the return value / report field reads; `openItems` (below) is the
  // WORKING COPY the loop mutates as each candidate is admitted, exactly like `slots` already does for
  // `maxConcurrentBuilds` — a static one-time gate would wrongly admit multiple candidates in one pass once
  // their combined count crosses `maxOpenItems` (Risks, #4353).
  // xovjhwh — the builder-owned subset of the delivered-by-open-PR side. `null` means the caller did not supply
  // an attribution set at all (every pre-existing caller/test): keep counting every delivered PR, unchanged. A
  // caller that DOES supply one (only `build-dispatch-daemon.mjs`, live) gets the filtered union instead.
  const ownedNums = dispatchedByBuilder == null ? null : new Set([...dispatchedByBuilder].map(normNum).filter(Boolean));
  // Card 87 — a borrowed FIX holds a builder slot (counted in `running`) but is not a backlog item for the WIP cap.
  const openItemsInitial = new Set([...inFlightByNum].filter(([, f]) => !f.borrowedFix).map(([k]) => k));
  for (const pr of openPrs) {
    const n = prDeliveredNum(pr);
    if (n && (ownedNums == null || ownedNums.has(n))) openItemsInitial.add(n);
  }
  const openItems = new Set(openItemsInitial);

  for (const c of candidates) {
    const num = normNum(c.num);
    const base = { num, lane: c.lane ?? null };
    if (frozen) { hold.push({ ...base, rule: 'landing-freeze', reason: freezeReasons.join('; ') }); continue; }
    if (inFlightByNum.has(num)) { hold.push({ ...base, rule: 'in-flight', reason: `already in flight (${inFlightByNum.get(num).source})` }); continue; }
    const deliveringPr = openPrs.find((pr) => prDeliversNum(pr, num));
    if (deliveringPr) { hold.push({ ...base, rule: 'in-flight', reason: `${deliveringPr.repo}#${deliveringPr.number} already delivers it` }); continue; }
    const ref = branchRefPolicy(plannedBuildRef(num));
    if (!ref.ok) { hold.push({ ...base, rule: 'branch-name', reason: ref.reason }); continue; }
    if (!Array.isArray(c.scope) || c.scope.length === 0) { hold.push({ ...base, rule: 'scope-vs-open-prs', reason: 'no scope: cannot prove it is disjoint from open PRs' }); continue; }
    let blocked = null;
    for (const pr of openPrs) {
      const hit = firstScopeOverlap(c.scope, pr.files);
      if (hit) { blocked = { rule: 'scope-vs-open-prs', reason: `${hit} is in open PR ${pr.repo}#${pr.number}` }; break; }
    }
    if (!blocked) {
      for (const r of [...running, ...picked]) {
        const hit = firstScopeOverlap(c.scope, r.scope);
        if (hit) { blocked = { rule: 'hot-file', reason: `${hit} is already being built by #${r.num}` }; break; }
      }
    }
    if (!blocked) {
      // #4295 — a live FIX claim (`[{pr, scope}]`) is in-flight work too: never build beside a fixer on the same file.
      const fx = overlapsInFlight(c.scope, fixInFlight.map((f) => ({ id: f.pr, scope: f.scope })));
      if (fx) blocked = { rule: 'hot-file', reason: `${fx.hit} is already being fixed by PR #${fx.with}` };
    }
    if (blocked) { hold.push({ ...base, ...blocked }); continue; }
    // #4353 wip-cap — checked BEFORE the plain concurrency `cap` below, inside the SAME per-candidate loop
    // (`openItems` grows as candidates are admitted, never a static pre-tick gate). `num` is guaranteed absent
    // from `openItems` here: EITHER member of the union that could already hold it — already in-flight
    // (`inFlightByNum.has(num)`, above) or already delivered by an open PR (`deliveringPr`, above) — already
    // `continue`d this candidate via the `in-flight` rule before this line is ever reached. So admitting it
    // here always grows the union by exactly one.
    if (openItems.size >= maxOpenItems) {
      hold.push({ ...base, rule: 'wip-cap', reason: `${openItems.size} open items (cap ${maxOpenItems}): ${[...openItems].sort().join(', ')}` });
      continue;
    }
    if (c.route?.error || c.route?.refusal) {
      hold.push({ ...base, rule: 'routing', reason: c.route.error || c.route.refusal });
      continue;
    }
    const kind = executorClass(c.executor);
    if (slotsByClass[kind] <= 0) { hold.push({ ...base, rule: 'cap', reason: `${counts[kind]} ${kind} builds in flight (cap ${caps[kind]})` }); continue; }
    slotsByClass[kind] -= 1;
    counts[kind] += 1;
    openItems.add(num);
    const pick = { ...base, scope: c.scope, source: 'this-tick', ...(c.executor ? { executor: c.executor } : {}) };
    picked.push(pick);
    dispatch.push(pick);
  }
  return {
    freeze: { frozen, reasons: freezeReasons, kinds: [...freezeKinds] }, inFlight: running, busy, slots: slotsByClass.claude, slotsByClass, dispatch, hold,
    // Card x3vs6tu — logged signal only (never gates `busy`/`slots` above): the machine-wide "building" count
    // the tick core passed in, visible to a dry-run/status line even though this cap no longer reads it.
    externalBuilding: Number(externalBuilding) || 0,
    openItems: { count: openItemsInitial.size, cap: maxOpenItems, nums: [...openItemsInitial].sort() },
  };
}

/** The report/status-line shape for `plan.openItems` (#4353) — `nums` renamed to `filling`, the name a reader
 *  outside this module (a dry-run report, a live status line) expects. Pure, exported so the field rename is
 *  pinned by a test independent of the daemon's IO shell. */
export function reportOpenItems(openItems) {
  return { count: openItems.count, cap: openItems.cap, filling: openItems.nums };
}

// ── Card 80 — prepare just in time ───────────────────────────────────────────────────────────────────────────

/** Hold reasons (dispatch-plan) of a cleared item that is on its way to a build: it builds as soon as a lane,
 *  the cap, an overlap or a prepare pass clears. Anything else (blocked, an epic, a decision, unscoped, unsized,
 *  already done) is not "about to build", so it never counts toward the prepare-ahead window. */
const BUILD_BOUND_REASONS = new Set([
  'needs-prepare', 'prepare-stale', 'no free lane', 'capacity-cap', 'dispatch-paused', 'pr-limit', 'branch-drift-blocked',
]);
const isBuildBound = (reason) => BUILD_BOUND_REASONS.has(reason) || /^overlaps lane-/.test(String(reason));

/**
 * Card 80 (a) — the items within the next `window` to build: the cleared queue in build order (pinned tier
 * first, then the queue's own rank order), keeping only items that are launching now or held for a reason that
 * clears on its own (see {@link BUILD_BOUND_REASONS}). A prepare is spent only on these, so a card is prepared
 * shortly before its build — never days ahead, when its scope may drift. Pure.
 *
 * builder-starved (2026-10-07) — `skip` is the set of nums the CALLER holds this tick (the build daemon's own
 * holds: a prepare-failure hold, a dispatch backoff, a non-PR cooldown). A held card cannot move this tick, so it
 * never takes a window slot: the window is the next `window` cards that CAN move. Before, two failure-held cards
 * at the head of the pinned tier filled half of the 4-slot window every tick, and with the other two starved
 * behind them nothing was ever prepared, so nothing ever became build-ready.
 * @param {{queue?:Array<{num:*, tier?:string|null}>, launch?:Array<{num:*}>, held?:Array<{num:*, reason:string}>, window?:number, skip?:Iterable<*>}} o
 * @returns {Set<string>|null} the in-window nums (normalized), or `null` when the window is off (not a finite number ≥ 0)
 */
export function prepareAheadNums({ queue = [], launch = [], held = [], window = Infinity, skip = [] } = {}) {
  if (!Number.isFinite(window) || window < 0) return null;
  const skipped = new Set([...(skip ?? [])].map(normNum));
  const launching = new Set((Array.isArray(launch) ? launch : []).map((l) => normNum(l?.num)));
  const reasonOf = new Map((Array.isArray(held) ? held : []).map((h) => [normNum(h?.num), h?.reason]));
  const rows = (Array.isArray(queue) ? queue : []).filter((r) => r && r.num != null)
    .map((r, i) => ({ num: normNum(r.num), pinned: r.tier === 'pinned', i }))
    .sort((a, b) => (b.pinned - a.pinned) || (a.i - b.i));
  const out = new Set();
  for (const r of rows) {
    if (out.size >= window) break;
    if (skipped.has(r.num)) continue;
    if (launching.has(r.num) || isBuildBound(reasonOf.get(r.num))) out.add(r.num);
  }
  return out;
}

/** Card 80 (b) — the day count between two `YYYY-MM-DD` dates (`to − from`), or `null` when either is malformed. */
export function daysBetween(from, to) {
  const ok = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!ok(from) || !ok(to)) return null;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Card 80 (b) — is a card's main-branch prepare stamp the RESULT of a prepare attempt claimed at `claimedAt`, or
 * an older stamp that attempt is replacing? A re-prepare (a `prepare-stale` card) starts with a stamp already on
 * main; reading that stamp as "prepared on main" would retire the claim at once.
 *
 * `replaces` is the stamp the claim recorded when it was taken: `null` (the card was unstamped, so ANY stamp is
 * the result) or `{preparedDate, preparedAgainstSha}`. The stamp is the result exactly when it is not that same
 * stamp — a revision comparison, not a date one, because a scope-drift re-prepare can start hours after the
 * stamp it replaces, so a same-day or yesterday stamp is still the OLD one.
 *
 * Only a claim that recorded nothing (`replaces === undefined`: taken by an older daemon, or its read failed) falls
 * back to dates. `prepare-stamp` writes the LOCAL date while a claim time is UTC, so that fallback allows one day
 * of slack. Pure.
 */
export function stampCoversClaim(preparedDate, claimedAt, { replaces, preparedAgainstSha } = {}) {
  if (!preparedDate) return false;
  if (replaces === null) return true;
  if (replaces && typeof replaces === 'object') {
    return !(replaces.preparedDate === preparedDate && (replaces.preparedAgainstSha ?? null) === (preparedAgainstSha ?? null));
  }
  if (typeof claimedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(claimedAt)) return true;
  const d = daysBetween(claimedAt.slice(0, 10), preparedDate);
  return d == null || d >= -1;
}

// ── Build-hold visibility ───────────────────────────────────────────────────────────────────────────────────

/**
 * One row per cleared card that is NOT dispatched this tick, with the stage that held it and why — the tick log
 * and the dry-run both print this, so a held card always names its reason (queue-cap and load-cap included,
 * which used to show only as "not a candidate"). Stages, first match wins: `daemon` (this planner's own
 * rules), `cooldown` (a recent non-PR outcome), `prepare` (a prepare is in flight), `tick-core` (a gate in the
 * tick core after planning: queue-cap / load-cap / capacity-cap / guard), `plan` (dispatch-plan's hold reason).
 * Pure.
 * @returns {Array<{num:string, stage:string, reason:string, detail?:string}>}
 */
export function collectBuildHolds({ queue = [], planHeld = [], suppressed = [], prepareQueueHeld = [], policyHold = [], cooldown = [], prepareBusy = [], dispatched = [] } = {}) {
  const out = new Map();
  const put = (num, row) => { const n = normNum(num); if (n && !out.has(n)) out.set(n, { num: n, ...row }); };
  const sent = new Set((Array.isArray(dispatched) ? dispatched : []).map((d) => normNum(d?.num ?? d)));
  for (const h of Array.isArray(policyHold) ? policyHold : []) if (!sent.has(normNum(h.num))) put(h.num, { stage: 'daemon', reason: h.rule, detail: h.reason });
  for (const n of Array.isArray(cooldown) ? cooldown : []) put(n, { stage: 'cooldown', reason: 'recent non-PR outcome (hold)' });
  for (const n of Array.isArray(prepareBusy) ? prepareBusy : []) put(n, { stage: 'prepare', reason: 'prepare in flight' });
  for (const s of Array.isArray(suppressed) ? suppressed : []) {
    const detail = s.by === 'queue-cap' ? `projected heavy-test wait ${s.projectedMinutes ?? '?'}m (this build +${s.demandMinutes ?? '?'}m)` : undefined;
    put(s.num, { stage: 'tick-core', reason: s.by || 'suppressed', ...(detail ? { detail } : {}) });
  }
  // A prepare tick-core held on queue-cap (`decisions.queueCapHeld.prepare`) must beat the plan's own bare
  // `needs-prepare` / `prepare-stale` row below, or the hold the operator needs to see reads as a plain prepare wait.
  for (const h of Array.isArray(prepareQueueHeld) ? prepareQueueHeld : []) {
    put(h.num, { stage: 'tick-core', reason: 'queue-cap',
      detail: `prepare${h.kind ? ` (${h.kind})` : ''} held: projected heavy-test wait ${h.projectedMinutes ?? '?'}m (this prepare +${h.demandMinutes ?? '?'}m)` });
  }
  for (const h of Array.isArray(planHeld) ? planHeld : []) put(h.num, { stage: 'plan', reason: h.reason, ...(h.detail ? { detail: h.detail } : {}) });
  const order = new Map((Array.isArray(queue) ? queue : []).map((r, i) => [normNum(r?.num), i]));
  return [...out.values()].sort((a, b) => (order.get(a.num) ?? Infinity) - (order.get(b.num) ?? Infinity));
}
