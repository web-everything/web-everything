/**
 * @file scripts/operations/declared-homes.mjs
 * @description WHICH RAW INVOCATION EACH OPERATION WAS BUILT TO REPLACE (#3224) — the one fact about an
 *   operation that nothing can derive, declared once and read by two consumers.
 *
 * THE SPLIT THIS FILE EXISTS TO HOLD. Whether `we:scripts/backlog.mjs` reaches `operations/claim.mjs` is
 * visible in the import graph and is DERIVED (`homeDelegates`, in `we:scripts/lib/skill-operation-wiring.mjs`).
 * Whether the `claim` operation was BUILT to replace `backlog.mjs claim` is intent, and no graph holds it —
 * so it is declared here. Restating the derived half as a flag beside the declared half is the failure that
 * produced all three of PR #1510's blockers: a predicate re-derived instead of read from the home that owns
 * it, which then went stale without anything noticing.
 *
 * TWO CONSUMERS, ONE DEFINITION (#2644): each operation module passes its own entry to `op({declaresOver})`,
 * which validates the shape at REGISTRATION; and the #3224 scan reads the map to know what to look for. An
 * entry that parses to nothing throws out of `op()` rather than producing a scan that silently checks nothing.
 *
 * ── WHAT IS AND IS NOT IN HERE, AND WHY IT IS SHORT ─────────────────────────────────────────────────────────
 *
 * ONLY ENTRIES SUBSTANTIATED BY THE OPERATION'S OWN HEADER. The temptation is to fill this in for all twelve
 * operations from memory of what each one "is about", and a wrong entry here is not a harmless overreach: it
 * makes the scan flag a skill line that is perfectly correct, and a gate that cries wolf is one that gets
 * `--force`d past on reflex. Fewer correct entries beat more guessed ones — an operation missing from this map
 * costs a finding nobody gets, while a wrong one costs the gate's credibility.
 *
 * SEVERAL OPERATIONS BELONG IN NEITHER COLUMN, and that is not an oversight:
 *   - `record-verdict` replaces a hand-assembled shell one-liner, not a CLI. There is no home to name.
 *   - `review-pr`, `review-prep` and `stage-pr-view` REUSE `review-core.mjs` / `review-detail.mjs` rather than
 *     declaring over their command lines. A header naming a module means it imports it, which is not the same
 *     relationship at all, and reading it as one is how this map would fill up with false entries.
 *   - `gate-health`, `explore`, `mutation-check` and `suggest-next` had no raw CLI to begin with.
 *
 * `resolve` and `scaffold` WERE absent for a different reason — nobody added them — and that gap was measured
 * on 2026-09-06: the map held 5 entries against 17 operations, so the scan's only findings were four
 * `gap-sweep-status` lines while the two highest-traffic bypasses (60 raw calls between them, per the
 * operations' own headers) were invisible to it. A gate that can only see a third of its subject reports a
 * clean bill for the rest. Both are now entered, on their own headers' evidence.
 *
 * ── A CORRECTION TO #3224'S OWN PREMISE ─────────────────────────────────────────────────────────────────────
 *
 * The card motivates the gate with "14 skills instruct `we:scripts/lane-pool.mjs` while 0 instruct
 * `dispatch-lane`". That comparison does not hold, and the map is deliberately not built to satisfy it:
 * `dispatch-lane`'s header says it declares over `we:scripts/conveyor/tick-core.mjs#planTick` — the conveyor's
 * per-tick dispatch policy. `lane-pool.mjs` is LANE PROVISIONING, which no operation declares over. The two
 * were counted against each other as if they named the same job. The measured gap (5 of 11 operations named
 * by zero skills) is real; that particular pair of numbers was not evidence for it.
 */

/**
 * Operation name → the raw invocations it declares over, as `"<locus:path> [subcommand]"`.
 *
 * A subcommand is present exactly when the home HAS subcommands. `verify-lane.mjs` has none, so naming the
 * file names the whole invocation; `backlog.mjs` has a dozen and only `claim` is declared over, so a
 * file-granular entry there would condemn every other `backlog.mjs` line in every skill.
 */
export const DECLARED_HOMES = Object.freeze({
  // `verify` SHELLS the home and classifies what it said — the operation is the fuller caller, so a skill
  // should name the operation. `verify.mjs`'s header states the relationship outright: "IT DECLARES OVER AN
  // EXISTING HOME, IT DOES NOT REPLACE ONE", and `verify-io.mjs` holds the actual `VERIFY_LANE_CLI` spawn.
  verify: Object.freeze(['we:scripts/verify-lane.mjs']),

  // THE NEGATIVE CONTROL, and the reason this scan is delegation-aware at all. `backlog.mjs claim` delegates
  // through `claimViaOperation`, so naming it IS naming the declared layer — and it additionally does the #083
  // reservation clear, the `claims.json` baseline and the rename-slug block that `run.mjs claim` does not.
  // PR #1508 rewired a skill off it on the theory that any raw-home mention is a miswiring and DROPPED all
  // three. This entry must never produce a finding; the suite pins that it does not.
  claim: Object.freeze(['we:scripts/backlog.mjs claim']),

  // `open-pr` SHELLS `we:scripts/pr-land.mjs`; its own header says it declares over that home. The entry was
  // withheld twice on purpose, and the reason it is here now is that the gap it named is actually closed:
  // #3242 built the `sha`/`requireVerified`/`dryRun` inputs, and #3245 made `title` optional to match the
  // home (which derives one from the commit subject). Until both landed, an entry would have emitted six
  // findings whose only honest answer was six exemption markers — a gate reporting a gap nobody could close,
  // which is how a gate gets ignored. Now every one of those six sites can name the operation instead.
  'open-pr': Object.freeze(['we:scripts/pr-land.mjs']),

  // `dispatch-lane` CONSUMES `planTick`'s `decisions.spawnBuilds` and refuses to invent a launch of its own —
  // "IT DECLARES OVER THE TICK CORE; IT DOES NOT RE-DERIVE IT". A skill telling an agent to run the core by
  // hand is telling it to execute a dispatch the operation exists to make structural.
  'dispatch-lane': Object.freeze(['we:scripts/conveyor/tick-core.mjs']),

  // `gap-sweep-status` SHELLS the home and classifies its fixed text output — its own header states the
  // relationship outright, same as `verify` above. No subcommand: the CLI takes flags only.
  'gap-sweep-status': Object.freeze(['we:scripts/gap-sweep-status.mjs']),

  // `resolve` and `scaffold` — added 2026-09-06, and the delay is the point. Both were absent while the map
  // held five entries against seventeen operations, so the scan could not fire for either; these two are the
  // highest-traffic bypasses in the repo BY THE OPERATIONS' OWN MEASUREMENTS, which is exactly the substantiation
  // bar this file sets ("ONLY ENTRIES SUBSTANTIATED BY THE OPERATION'S OWN HEADER" — no guessing).
  //
  // Both are NON-DELEGATING, and that is what separates them from the `claim` negative control above.
  // `we:scripts/backlog.mjs` imports `operations/claim.mjs` and routes `claim` through `claimViaOperation`,
  // so naming that home names the declared layer. It imports neither `operations/resolve.mjs` nor
  // `operations/scaffold.mjs`, so the raw verbs run their own path and skip the declaration's guards outright.
  //
  // `resolve` (#911/#658/#2803): its header records "a 1,786-call session audit on 2026-08-21 found 15 raw
  // `backlog.mjs resolve` calls and 0 through any operation, because there was none to call". The four guards
  // a raw call skips are wrong-status, an epic with open children, an uncodified decision, and undeclared
  // presentation drift. File-granular, like `claim`: only the `resolve` verb is declared over, so the entry
  // cannot condemn every other `backlog.mjs` line in every skill.
  //
  // BOTH ENTRIES REPORT CLEAN TODAY, and that is the honest reason to add them rather than an argument against
  // it. The scanned skills already instruct `run.mjs` for both verbs; the remaining raw mentions are prose
  // CONTRASTS of flag spelling, which the scan correctly ignores because `HOME_MENTION` matches an invocation
  // (`node <path>`) and not a bare reference. So these entries buy REGRESSION coverage, not a backlog of
  // findings — the map went from 5 of 17 operations to 7, and the two highest-traffic verbs moved from
  // unwatched to watched-and-clean. An unwatched verb that happens to be correct is indistinguishable from one
  // that is not, which is the whole reason this map exists.
  resolve: Object.freeze(['we:scripts/backlog.mjs resolve']),

  // `scaffold`: its header counts "45 raw `backlog.mjs scaffold` calls — the single most-invoked", the largest
  // raw-verb total measured. Same file-granular shape and the same reason.
  scaffold: Object.freeze(['we:scripts/backlog.mjs scaffold']),

  // `file-item` (#3383) — the FULL filing sequence a session otherwise hand-composes across TWO raw
  // invocations: `backlog.mjs scaffold` to write the card, then the separately-remembered
  // `conveyor/queue.mjs add` to clear it for the conveyor. Both are named here because this operation
  // declares over both ends of that gap, not just the first.
  'file-item': Object.freeze(['we:scripts/backlog.mjs scaffold', 'we:scripts/conveyor/queue.mjs add']),

  // `docket-refresh` (#3723, under epic #3383) — its own header states the relationship outright: the fetch +
  // stale-checkout refusal + content-hash gate + publish-owed hand-off AROUND the checkout's own
  // `gen-decision-docket.mjs data`/`render` steps, writing outside every checkout instead of the generator's
  // own dirty-tree defaults. A skill telling a session to run the generator by hand for a routine refresh is
  // telling it to skip the hash gate and the hand-off record this operation exists to add.
  'docket-refresh': Object.freeze(['we:scripts/gen-decision-docket.mjs']),

  // `runs-retention` (R549) — verified archive-then-delete of terminal run records; the older archive-only tool it
  // supersedes for deletion is `scripts/archive-retention.mjs` (never deletes without a writer-exclusion provider).
  'runs-retention': Object.freeze(['we:scripts/archive-retention.mjs']),
});
