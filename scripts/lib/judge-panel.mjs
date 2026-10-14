/**
 * judge-panel.mjs — N jurors, spawned at once, awaited as one, budgeted as one (#3050, under #3029).
 *
 * THE LAYER BETWEEN `judgeSpawn` AND A `judge` STEP. `we:scripts/lib/judge-spawn.mjs` (#3028) spawns ONE
 * tool-free juror. `we:scripts/lib/jury-core.mjs` NAMES the fan-out set (`PANEL_LENSES`,
 * `panelRigorForCareLevel` → `lenses` + `jurorsPerLens`) and reduces the verdicts, but spawns nothing. This
 * module is the missing middle and NOTHING ELSE: it takes a roster, runs one `judgeSpawn` per seat
 * concurrently, awaits every one, and hands back the per-juror results together.
 *
 * IT REIMPLEMENTS NOTHING AND RULES NOTHING. No second argv recipe (`buildJudgeArgv`), no second denylist
 * (`assertNoForbiddenArgv`), no second session-id derivation (`deriveSessionId`) and no second seed encoding
 * (`sessionSeed`, #3058) — every one of them is IMPORTED from `judge-spawn.mjs`. And no reduction: `derivePanelVerdict` / `buildPanelFindings` / diversity-selection stay
 * in `jury-core.mjs`, because a second reducer here is precisely the defect that module's `AGGREGATION`
 * constant exists to prevent (#3050 "Not in scope").
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 * THE ONE PROPERTY THAT IS THE PRODUCT: PAIRWISE-DISTINCT SIBLINGS.
 *
 * The fan-out that exists today (`we:skills-src/jury/subject-jury.workflow.js`, #2658) uses the Workflow
 * runtime's subagent primitive, and A SUBAGENT INHERITS ITS PARENT'S `CLAUDE_CODE_SESSION_ID` — measured
 * 2026-08-08 in #3006 (parent `01f39b97…`, child `f4386de9…`) and re-measured 2026-08-09 in #3048 (a subagent
 * reported its parent's id byte-for-byte). By the test this repo already keys reviewer identity on
 * (`we:scripts/lib/review-independence.mjs`), that panel is ONE ACTOR WEARING N HATS. A headless spawn is not:
 * #3028 records three spawns whose environment carried the parent's id each reporting a DIFFERENT
 * `session_id`.
 *
 * So this module makes sibling distinctness STRUCTURAL rather than incidental. Every seat gets its own
 * `--session-id`, derived from `runId` + the seat's id, and `panelSeats` self-checks that the derived set is
 * pairwise distinct before anything is spawned. The seat id is `lens#slot` — the SAME convention
 * `materializeRoster` already uses in `jury-core.mjs` — which is what separates the TWO SEATS ON ONE LENS that
 * `panelRigorForCareLevel` produces at care `high` (`jurorsPerLens: 2`). Seeding on the lens alone would
 * collapse those two seats onto one id, i.e. one actor, which is the whole failure being removed.
 *
 * Read the limit honestly, per #2895 and #3028's own header: a distinct session id is NOT an unforgeable actor
 * signal. What it removes is the failure a subagent juror has BY CONSTRUCTION and cannot argue its way out of.
 *
 * WHICH `sessionId` THE RESULT CARRIES, AND WHY. Each result's `sessionId` is the id THIS MODULE DERIVED AND
 * PUT IN THE CHILD'S ARGV — the panel's own record of which actor it seated. `reportedSessionId` is what the
 * child's own stdout echoed back (empty on a failed seat). They are the same value in a real run (`--session-id`
 * is accepted and echoed by `claude` 2.1.220, per #3028's `deriveSessionId` note), and keeping both means a
 * caller can NOTICE if that ever stops being true instead of silently trusting one of them.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 * FOUR REFUSALS, ALL FAIL-CLOSED, ALL BEFORE THE FIRST CHILD STARTS.
 *
 *  1. DEPTH. `depth >= maxDepth` is refused — and so is a `depth` or `maxDepth` that is absent, null, or not a
 *     finite number. Unknown depth is a REFUSAL, not a default, applying the fail-closed principle ratified in
 *     #3013 Fork 2 on 2026-08-09 (*"absent diff ⇒ not routine"*; commit `d84f7cb9`, PR #1127).
 *
 *     STATE THE RISK ACCURATELY, because the obvious version of it is already foreclosed: `buildJudgeArgv`
 *     always emits `--tools ''`, so a juror CANNOT SPAWN ANYTHING AT ALL — no subagent, no second headless
 *     process. Juror-spawns-juror recursion is structurally impossible at the judge step, and this cap is NOT
 *     what prevents it. What the cap governs is the OPERATION nesting one level up: a `judgePanel` invoked from
 *     a context that is itself a panel child, or re-entered through a `compute`/`effect` step of the operations
 *     engine (#3032, resolved 2026-08-09 → `we:scripts/operations/`). There the floor is not natural and the
 *     bill compounds, so depth is an explicit parameter that fails closed rather than an assumption. A caller
 *     that nests a panel passes `depth + 1`.
 *
 *  2. AGGREGATE BUDGET. `judgeSpawn` takes `budget` PER SPAWN (`--max-budget-usd`, defaulting to
 *     `DEFAULT_BUDGET_USD` — read the number THERE, not here; this line said `0.5` for as long as that was
 *     true and it stopped being true in #3187). Five jurors at that cap is five times the bill with nothing
 *     watching the total. `maxTotalBudgetUsd` is REQUIRED — an unset aggregate ceiling is the same fail-open
 *     the depth cap rejects — and the sum of the seats' per-juror budgets is checked BEFORE THE FIRST SPAWN,
 *     so a panel that cannot afford its roster bills nothing at all rather than half a roster.
 *
 *     THIS PANEL IS THE MODULE THAT NAMES THAT DEFAULT, and #3187 is why the number moved. Nothing here sets
 *     a `JUDGE_BUDGET_USD` of its own, so every seat that omits `budget` gets whatever `judge-spawn.mjs` calls
 *     the default. (This line said *"the two declared operations set their own `JUDGE_BUDGET_USD`"* — wrong:
 *     `git grep -n "judgeStep("` finds FOUR live declarations, and `explore.mjs`'s `synthesize` sets no budget
 *     at all. The count is not this file's to keep; see the list named below.)
 *
 *     IT IS NOT THE ONLY THING THAT INHERITS THAT DEFAULT — anything reaching `judgePanel` without a per-seat
 *     budget inherits it THROUGH here while importing nothing, and a third path reaches `judgeSpawn` without
 *     coming through here at all. `DEFAULT_BUDGET_USD`'s own "WHO INHERITS THIS" is the ONE list of all three;
 *     do not answer "what does this reach" from this file. #3187 got that question wrong twice — once by
 *     counting importers (red CI), once by grepping for `kind: 'judge'` instead of `judgeStep(`.
 *
 *     While that default was `0.5`, sized for a TOOL-FREE juror, a tool-bearing seat here was killed
 *     mid-run — 6 of 8 seats on one converge run,
 *     escalating `needs-human` on `mandatory-lens-absent` as though the panel had failed. Raising the default
 *     is what unblocked this path; `JudgeBudgetError` is what stops the next one costing a misdiagnosis.
 *
 *     WHY THE DEFAULT CANNOT SIMPLY BE `null` HERE, unlike in those operations: `assertPanelBudget` refuses a
 *     non-positive-finite per-juror budget, because an aggregate ceiling is not checkable over a roster of
 *     `null`s. A seat that genuinely wants no ceiling must say so per seat, and pays for it by leaving the
 *     aggregate admission check with nothing to sum.
 *
 *     Its honest limit: this is ADMISSION CONTROL over the DECLARED ceilings, not a live meter. What actually
 *     stops a running juror is its own `--max-budget-usd`, enforced by the CLI. The result reports the observed
 *     `totalCostUsd` so a caller can compare the two, and no claim is made here that the observed total is
 *     policed mid-flight.
 *
 *  3. SYNCHRONOUS BY CONSTRUCTION. The panel AWAITS its children — one promise, resolved only after every seat
 *     has settled. This is deliberately not caller discipline: THERE IS NO DETACH PATH ON THE EXPORTED SURFACE
 *     to get wrong. No `unref`, no `detached`, no handle handed back to poll. The precedent is on the record:
 *     #2833 (resolved 2026-08-02) exists because a build subagent *"launched a check in the background and then
 *     blocked, waiting for a completion signal that never advanced it"*, holding a lane producing nothing until
 *     a person nudged it; its own remedy names this shape — *"or subagents must run their checks
 *     synchronously"*.
 *
 *  4. THE ARGV DENYLIST, PER SEAT, PRE-FLIGHT. Every seat's argv is built and passed through the IMPORTED
 *     `assertNoForbiddenArgv` before ANY child starts, so a `--bare` juror is refused inside a panel exactly as
 *     it is alone — and refused hard: the whole call throws and zero processes start, rather than one seat
 *     failing while its siblings bill. `judgeSpawn`'s own per-child call to the same guard is unchanged and
 *     still in the path; because this module feeds it the identical arguments it already validated, that inner
 *     call is now belt-and-braces from THIS caller and no test here pretends to reach it. (It IS reached and
 *     pinned from the single-spawn path — see `we:scripts/lib/__tests__/judge-spawn.test.mjs`.)
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 * PARTIAL FAILURE IS A RESULT, NOT AN EXCEPTION. One juror rejecting must neither orphan its siblings nor
 * resolve the panel early. Children are collected with `Promise.allSettled`, so the panel still waits for every
 * seat, reports the failed one as `{ ok: false, error }`, and returns the rest. A caller reduces what it got —
 * the reduction lives in `jury-core.mjs`, and deciding what a missing seat means is that reducer's business,
 * not this module's. `judgePanel` therefore throws ONLY for the four admission refusals above, never because a
 * child failed.
 *
 * NO NEW ROUTE FROM CALLER INPUT TO A CHILD'S ARGV (#3056, open). That item records that `buildJudgeArgv`
 * accepts any non-empty `model` string while `FORBIDDEN_ARGV` names only `--bare`, so a flag-shaped option
 * VALUE reaches argv. It is captured there and NOT fixed here — but it is not widened either. Every option this
 * module forwards (`mandate`, `shape`, `model`, `effort`, `budget`) was already a `judgeSpawn` argv input, and
 * this module's OWN new inputs reach argv through exactly one funnel or not at all: `runId`, `lens`, `slot` and
 * `id` go only into `sessionSeed` → `deriveSessionId`, which SHA-256s them into a canonical UUID, and `depth` /
 * `maxDepth` / `maxTotalBudgetUsd` never touch argv in any form. A test pins that with flag-shaped lens and run
 * ids.
 *
 * PURE except `judgePanel`, which spawns subprocesses through the injectable `spawnFn` it forwards to
 * `judgeSpawn` — the same seam the unit tests use, so the whole suite spawns nothing. A LEAF module above
 * `judge-spawn.mjs`: it imports that and nothing else from the review/jury seams.
 */

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 * RULING (#3158 / x27e4xs) — PANEL SEATS STAY TOOL-FREE BY DESIGN, FOR NOW.
 *
 * The alternative this module could take instead is threading a per-seat `allowedTools` plus a per-seat lane
 * `cwd` through to `judgeSpawn` (which already supports both — see `assertLaneCwd`) — but that means N seats
 * need N lane clones, acquired, scoped, and released around a single review round. Nothing in this repo
 * provisions or bills for that today, and paying it just to recover ONE finding class (a mutation actually
 * run) is not this card's call to make unilaterally. So the ruling is: panel seats stay `--tools ''` — this
 * module forwards no `allowedTools` and takes no per-seat `cwd` — and the mutation probe belongs to whichever
 * transport can actually run it, not to every seat by default. Revisit if a caller ever prices the N-lane
 * cost and decides it is worth paying for a specific seat.
 *
 * What this DOES change: THREE clauses in `we:scripts/lib/review-core.mjs` used to instruct EVERY juror —
 * tool-free or not — to break a line and clone a repo it structurally cannot: `MUTATION_PROBE_RULE`,
 * `buildMandate`'s clone-escape body line, and `GUARANTEE_NEEDS_A_TEST_RULE`, which carries the IDENTICAL
 * "BREAK the guarded line and confirm a NAMED test reddens" demand narrowed to prose guarantees (conditioning
 * only the first two would have left half the bug in place — the sibling rule was missed the same way on more
 * than one review round of this card). All three now branch ON THEIR OWN WORDING (the #3094 pattern: scope by
 * phrasing, not by a caller flag) on whether the juror has tools, which `skills-src/jury/panel-fanout.mjs`
 * already tells a tool-free juror about itself.
 *
 * WHY WORDING AND NOT A `toolsAvailable` PARAMETER. The rejected alternative threads an explicit flag from
 * every caller down through `buildMandate`/`buildPanelMandate`/`buildValidatorMandate`. It cannot be made
 * correct at the default: `true` leaves every tool-free caller that forgets it still holding the original bug,
 * and `false` tells a genuinely tool-bearing juror it has no tools — suppressing the highest-yield finding
 * technique this repo has. Worse, the flag has to survive a `review-core-cli.mjs --toolsAvailable` argv string
 * embedded in a Workflow subagent's PROMPT, so a prompt edit silently loses it and no test can see the loss.
 * #3094's own ruling in `review-core.mjs` already settled this exact shape — *"an opt-in flag is a way to omit
 * the single highest-yield line by forgetting it"*. Tool availability is a property of the SPAWN that only the
 * juror observes directly, so the wording asks the one party that always knows.
 * `we:skills-src/drain/SKILL.md`'s panel-review section documents which finding classes a tool-free seat can
 * and cannot reach, so an `accept` from this panel is never read as a tool-backed one.
 */

import { resolveClaudeHelperRoute } from './claude-helper-route.mjs';
import {
  judgeSpawn,
  buildJudgeArgv,
  assertNoForbiddenArgv,
  deriveSessionId,
  sessionSeed,
  DEFAULT_EFFORT,
  DEFAULT_BUDGET_USD,
} from './judge-spawn.mjs';

/** A finite, non-negative number — the only thing the depth cap will accept as "known". */
function isKnownDepth(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

function isNonEmptyString(s) {
  return typeof s === 'string' && s.trim().length > 0;
}

/**
 * REFUSAL 1 — the depth cap, fail-closed on BOTH the over-cap case and the unknown case.
 *
 * Pure. Unknown depth is not "probably fine": `undefined`, `null`, `NaN`, `Infinity`, a numeric STRING, or a
 * negative all refuse, because the failure this guards is a panel re-entered from a context that never told it
 * where it was. `maxDepth` must additionally be at least 1 — a cap of 0 admits nothing and is far more likely a
 * mistake than a policy.
 *
 * @param {{depth?: unknown, maxDepth?: unknown}} [o]
 * @returns {{depth: number, maxDepth: number}} the validated pair.
 * @throws when either value is unknown, or when `depth >= maxDepth`.
 */
export function assertPanelDepth({ depth, maxDepth } = {}) {
  if (!isKnownDepth(depth)) {
    throw new TypeError(
      `judge-panel: \`depth\` must be a finite non-negative number, got ${JSON.stringify(depth ?? null)} — ` +
      'an unknown depth is REFUSED, not defaulted (#3050 constraint 1, fail-closed per #3013 Fork 2)',
    );
  }
  if (!isKnownDepth(maxDepth)) {
    throw new TypeError(
      `judge-panel: \`maxDepth\` must be a finite non-negative number, got ${JSON.stringify(maxDepth ?? null)} — ` +
      'an unknown cap is REFUSED, not defaulted (#3050 constraint 1, fail-closed per #3013 Fork 2)',
    );
  }
  if (maxDepth < 1) {
    throw new RangeError(`judge-panel: \`maxDepth\` must be at least 1 — a cap of ${maxDepth} admits no panel at all`);
  }
  if (depth >= maxDepth) {
    throw new RangeError(
      `judge-panel: refusing to convene a panel at depth ${depth} with maxDepth ${maxDepth} — the nesting cap is closed`,
    );
  }
  return { depth, maxDepth };
}

/**
 * REFUSAL 2 — the aggregate ceiling, checked over the DECLARED per-juror budgets before anything is spawned.
 *
 * Pure. An absent or non-positive `maxTotalBudgetUsd` is itself a refusal: a panel multiplies the bill, so an
 * unset total is the fail-open the depth cap already rejects.
 *
 * @param {{budgets?: number[], maxTotalBudgetUsd?: unknown}} [o]
 * @returns {{totalBudgetUsd: number, maxTotalBudgetUsd: number}}
 * @throws when the ceiling is absent/invalid, or the roster's declared budgets exceed it.
 */
export function assertPanelBudget({ budgets = [], maxTotalBudgetUsd } = {}) {
  if (typeof maxTotalBudgetUsd !== 'number' || !Number.isFinite(maxTotalBudgetUsd) || maxTotalBudgetUsd <= 0) {
    throw new TypeError(
      `judge-panel: \`maxTotalBudgetUsd\` must be a positive finite number of USD, got ` +
      `${JSON.stringify(maxTotalBudgetUsd ?? null)} — an unset aggregate ceiling is REFUSED, not defaulted ` +
      '(#3050 constraint 2)',
    );
  }
  const list = Array.isArray(budgets) ? budgets : [];
  for (const b of list) {
    if (typeof b !== 'number' || !Number.isFinite(b) || b <= 0) {
      throw new TypeError(`judge-panel: every per-juror budget must be a positive finite number of USD, got ${JSON.stringify(b ?? null)}`);
    }
  }
  const totalBudgetUsd = list.reduce((a, b) => a + b, 0);
  if (totalBudgetUsd > maxTotalBudgetUsd) {
    throw new RangeError(
      `judge-panel: refusing to spawn ${list.length} juror(s) — their declared budgets total ` +
      `$${totalBudgetUsd} against a maxTotalBudgetUsd of $${maxTotalBudgetUsd}. Nothing was spawned.`,
    );
  }
  return { totalBudgetUsd, maxTotalBudgetUsd };
}

/**
 * THE PURE SEAM, AND THE PLACE SIBLING DISTINCTNESS IS MADE STRUCTURAL — a roster in, named seats out.
 *
 * Spawns nothing, reads no environment. Each seat gets:
 *   • `slot` — its 1-based index AMONG THE SEATS ON ITS OWN LENS, so a `jurorsPerLens: 2` lens yields slots 1
 *     and 2 rather than two of the same thing. A caller may pin `slot` explicitly.
 *   • `id` — `lens#slot`, the SAME identity string `materializeRoster` mints in `we:scripts/lib/jury-core.mjs`,
 *     so a panel's seats line up with a `roster-picked` ledger event's jurors without a translation table. A
 *     caller may supply `id` outright.
 *   • `sessionId` — `deriveSessionId(sessionSeed([runId, id]))`. Deterministic (the run record can point at
 *     the transcript), and distinct per seat because `id` is distinct per seat. The seed goes through the
 *     IMPORTED `sessionSeed` encoder rather than a join written here: a space join is not injective, so
 *     `("a", "b c#1")` and `("a b", "c#1")` used to name the same actor across two runs (#3058). There is
 *     exactly one seed encoding in the constellation and it lives in `judge-spawn.mjs` — a second one here
 *     would be the same defect wearing a different hat.
 *
 * `runId` IS REQUIRED. `judgeSpawn` alone may fall back to a one-off random seed — still a distinct actor, just
 * not a reproducible name — but recordability is the entire reason a panel is worth owning (#3050), so a panel
 * without a run id is refused rather than silently un-recordable.
 *
 * The pairwise-distinctness self-check at the end is deliberately not just a test's job: it is cheap, and if it
 * ever fires, the module's one product claim has failed and nothing should be spawned.
 *
 * @param {{jurors?: Array<object>, runId?: string}} [o]
 * @returns {Array<{id: string, lens: string, slot: number, sessionId: string, juror: object}>}
 */
export function panelSeats({ jurors, runId } = {}) {
  if (!isNonEmptyString(runId)) {
    throw new TypeError('judge-panel: `runId` must be a non-empty string — a panel that cannot be recorded is not worth spawning');
  }
  if (!Array.isArray(jurors) || jurors.length === 0) {
    throw new TypeError('judge-panel: `jurors` must be a non-empty array of seats');
  }

  const perLensCount = new Map();
  const seats = [];
  for (const [i, juror] of jurors.entries()) {
    if (!juror || typeof juror !== 'object' || Array.isArray(juror)) {
      throw new TypeError(`judge-panel: juror ${i} must be an object`);
    }
    if (!isNonEmptyString(juror.lens)) {
      throw new TypeError(`judge-panel: juror ${i} needs a non-empty \`lens\``);
    }
    const lens = juror.lens.trim();
    const next = (perLensCount.get(lens) ?? 0) + 1;
    perLensCount.set(lens, next);
    let slot = next;
    if (juror.slot !== undefined) {
      if (!Number.isInteger(juror.slot) || juror.slot < 1) {
        throw new TypeError(`judge-panel: juror ${i} (\`${lens}\`) has slot ${JSON.stringify(juror.slot)} — must be a positive integer`);
      }
      slot = juror.slot;
    }
    let id = `${lens}#${slot}`;
    if (juror.id !== undefined) {
      if (!isNonEmptyString(juror.id)) {
        throw new TypeError(`judge-panel: juror ${i} (\`${lens}\`) has a non-string \`id\``);
      }
      id = juror.id.trim();
    }
    seats.push({ id, lens, slot, sessionId: deriveSessionId(sessionSeed([runId, id])), juror });
  }

  const ids = new Set(seats.map((s) => s.id));
  if (ids.size !== seats.length) {
    throw new Error(
      'judge-panel: two seats share an id, so they would be ONE actor wearing two hats — the failure the ' +
      `panel exists to remove (#3050). Seat ids: ${seats.map((s) => s.id).join(', ')}`,
    );
  }
  const sids = new Set(seats.map((s) => s.sessionId));
  if (sids.size !== seats.length) {
    // Unreachable short of a SHA-256 collision; kept because the claim it defends is the module's whole point.
    throw new Error('judge-panel: derived session ids are not pairwise distinct — refusing to seat a panel that is not independent');
  }
  return seats;
}

/**
 * @typedef {Object} PanelJurorResult
 * @property {string} id - the seat's `lens#slot` identity.
 * @property {string} lens - the lens this seat judged under.
 * @property {number} slot - the seat's index among its lens's seats.
 * @property {string} sessionId - the session id THIS PANEL derived and put in the child's argv.
 * @property {boolean} ok - false when the seat failed; its siblings are unaffected either way.
 * @property {object|null} value - the shape-enforced answer, or null on a failed seat.
 * @property {number} costUsd - observed spend for this seat (0 on failure).
 * @property {number} wallMs - wall time for this seat.
 * @property {number} loadedContextTokens - context the child actually loaded (0 on failure).
 * @property {string} reportedSessionId - the id the child's own stdout echoed ('' on failure).
 * @property {number} durationMs - the CLI's self-reported duration (0 on failure).
 * @property {string} stopReason - the CLI's stop reason ('' on failure).
 * @property {object} usage - the CLI's usage block ({} on failure).
 * @property {string|null} error - the failure's message, verbatim from `judgeSpawn`, or null.
 */

/**
 * THE FAN-OUT. One `judgeSpawn` per seat, started together, ALL awaited, returned together.
 *
 * Refuses (throwing, with nothing spawned) on: an unknown or exceeded depth; an absent or exceeded aggregate
 * budget; a malformed roster; and any seat whose argv trips `assertNoForbiddenArgv`. Does NOT throw because a
 * child failed — see the header on partial failure.
 *
 * Per-seat options override the panel-wide defaults of the same name, so a caller can run one dial for the
 * whole panel or a different model/effort/budget per lens without a second code path.
 *
 * @param {object} opts
 * @param {Array<{lens: string, slot?: number, id?: string, mandate?: string, input?: string, shape?: object,
 *                model?: string, effort?: string, budget?: number}>} opts.jurors - the roster; one spawn each.
 * @param {string} opts.runId - run identity every seat's session id derives from. REQUIRED.
 * @param {number} opts.maxTotalBudgetUsd - aggregate USD ceiling over the roster's declared budgets. REQUIRED.
 * @param {number} opts.depth - this panel's nesting depth. REQUIRED, fails closed when unknown.
 * @param {number} opts.maxDepth - the nesting cap. REQUIRED, fails closed when unknown.
 * @param {string} [opts.mandate] - panel-wide default juror instruction.
 * @param {string} [opts.input] - panel-wide default material to judge.
 * @param {object} [opts.shape] - panel-wide default JSON Schema the answers are forced to satisfy.
 * @param {string} [opts.model] - panel-wide default model.
 * @param {string} [opts.effort] - panel-wide default effort.
 * @param {number} [opts.budget] - panel-wide default PER-JUROR budget.
 * @param {string} [opts.cwd] - working directory for each spawn.
 * @param {object} [opts.env] - environment for each spawn.
 * @param {string} [opts.cli] - the binary each juror runs as.
 * @param {number} [opts.timeoutMs] - per-juror kill timeout.
 * @param {Function} [opts.spawnFn] - injectable `child_process.spawn`, forwarded to every seat.
 * @returns {Promise<{runId: string, depth: number, maxDepth: number, maxTotalBudgetUsd: number,
 *                    totalBudgetUsd: number, totalCostUsd: number, wallMs: number, ok: boolean,
 *                    failedCount: number, jurors: PanelJurorResult[]}>}
 */
export async function judgePanel({
  jurors,
  runId,
  maxTotalBudgetUsd,
  depth,
  maxDepth,
  mandate,
  input,
  shape,
  model = resolveClaudeHelperRoute().model,
  effort = DEFAULT_EFFORT,
  budget = DEFAULT_BUDGET_USD,
  cwd,
  env,
  cli,
  timeoutMs,
  spawnFn,
} = {}) {
  // ── REFUSAL 1: depth, before anything else is even looked at. ──────────────────────────────────────────
  assertPanelDepth({ depth, maxDepth });

  // ── The roster becomes named seats (and pairwise-distinct session ids) or it throws. ───────────────────
  const seats = panelSeats({ jurors, runId });

  // Resolve each seat's effective call. Nothing here spawns; the whole roster is made well-formed FIRST so a
  // panel that cannot run every seat runs none of them.
  const calls = seats.map((seat) => {
    const j = seat.juror;
    const call = {
      mandate: j.mandate ?? mandate,
      input: j.input ?? input,
      shape: j.shape ?? shape,
      model: j.model ?? model,
      effort: j.effort ?? effort,
      budget: j.budget ?? budget,
      sessionId: seat.sessionId,
    };
    if (!isNonEmptyString(call.input)) {
      throw new TypeError(`judge-panel: seat \`${seat.id}\` has no \`input\` — there is nothing for it to judge`);
    }
    return { seat, call };
  });

  // ── REFUSAL 2: the aggregate ceiling, over the DECLARED budgets, before the first spawn. ───────────────
  const { totalBudgetUsd } = assertPanelBudget({
    budgets: calls.map(({ call }) => call.budget),
    maxTotalBudgetUsd,
  });

  // ── REFUSAL 4: the argv denylist, once per seat, still nothing spawned. Same imported guard `judgeSpawn`
  //    uses — there is no second denylist in this module (see the header, and #3056 for the guard's own
  //    known narrowness, which is captured there and neither fixed nor widened here). Building the argv here
  //    also surfaces every malformed seat (bad effort, bad budget, missing mandate) before any child starts.
  for (const { seat, call } of calls) {
    let argv;
    try {
      argv = buildJudgeArgv(call);
    } catch (e) {
      throw new TypeError(`judge-panel: seat \`${seat.id}\` cannot be made well-formed: ${e.message}`);
    }
    assertNoForbiddenArgv(argv);
  }

  // ── REFUSAL 3 IS THE SHAPE OF WHAT FOLLOWS: every child is started, then EVERY child is awaited. There is
  //    no detach, no `unref`, no handle returned to poll — `allSettled` is what makes one rejecting juror a
  //    reported seat rather than an orphaning of its siblings or an early resolve.
  const startedAt = Date.now();
  const settled = await Promise.allSettled(calls.map(({ call }) => judgeSpawn({
    ...call,
    cwd,
    env,
    cli,
    timeoutMs,
    spawnFn,
  })));
  const wallMs = Date.now() - startedAt;

  const results = settled.map((outcome, i) => {
    const { seat } = calls[i];
    const base = { id: seat.id, lens: seat.lens, slot: seat.slot, sessionId: seat.sessionId };
    if (outcome.status === 'rejected') {
      const err = outcome.reason;
      return {
        ...base,
        ok: false,
        value: null,
        costUsd: 0,
        wallMs: 0,
        loadedContextTokens: 0,
        reportedSessionId: '',
        durationMs: 0,
        stopReason: '',
        usage: {},
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const r = outcome.value;
    return {
      ...base,
      ok: true,
      value: r.value,
      costUsd: r.costUsd,
      wallMs: r.wallMs,
      loadedContextTokens: r.loadedContextTokens,
      reportedSessionId: r.sessionId,
      durationMs: r.durationMs,
      stopReason: r.stopReason,
      usage: r.usage,
      error: null,
    };
  });

  const failedCount = results.filter((r) => !r.ok).length;
  return {
    runId,
    depth,
    maxDepth,
    maxTotalBudgetUsd,
    totalBudgetUsd,
    totalCostUsd: results.reduce((a, r) => a + r.costUsd, 0),
    wallMs,
    ok: failedCount === 0,
    failedCount,
    jurors: results,
  };
}
