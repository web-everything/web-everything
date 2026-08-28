/**
 * @file scripts/operations/dispatch-lane.mjs
 * @description THE `dispatch-lane` DECLARATION — the effect that STARTS rather than completes (#3037, epic #3029).
 *
 * WHAT THE CARD WAS AFRAID OF, AND WHY IT IS NOT HERE. Every other declared operation's effects are applied and
 * done; this one hands off — it launches a delivery agent that outlives the run by an hour. The card asked
 * whether `compute` / `judge` / `confirm` / `effect` can describe that. The #3030 spike answered that they can
 * (`we:reports/2026-08-11-dispatch-lifecycle-spike.md`), and the two mechanisms it named have since shipped:
 * `dispatch: true` + `inFlight({ handle })` on the executor (#3073) and the observer contract + the waker
 * (#3084). So there is NO fifth step kind here, and this declaration adds no mechanism of its own — it is three
 * ordinary steps over machinery that already existed.
 *
 * IT DECLARES OVER THE TICK CORE; IT DOES NOT RE-DERIVE IT. The conveyor's dispatch policy — the in-flight
 * build guard, the lane exclusion, the scope-lease arbitration, the TTLs, the union re-dispatch gate — is
 * `we:scripts/conveyor/tick-core.mjs#planTick`, which is pure and tested. This operation CONSUMES that core's
 * five launch lists — `decisions.spawnBuilds`, `decisions.spawnPrepareScope`, `decisions.spawnPrepareDecision`
 * (#3165), and `decisions.spawnFixes` / `decisions.spawnCiHeals` (#3383) — and refuses to invent a launch of
 * its own:
 *
 *   - ONE DISPATCH PER CALL, never a batch. `--num=<N>` resolves THAT item's kind and starts THAT item's
 *     agent. The tick already decides multiplicity; a loop here would be a second scheduler in front of it.
 *   - the KIND is never an input either. It is whichever of the five lists the core put this num in, and
 *     it selects the brief, the session slug and the lane scope together — see `shapeDispatchRead`.
 *
 *   - the LANE is never an input. A caller cannot ask for a lane; it dispatches the lane the core assigned, or
 *     it dispatches nothing. That is what makes "the same holds and the same lease arbitration as the current
 *     tick" a structural property rather than a promise.
 *   - a `num` the core SUPPRESSED (a live guard holds its num or its lane) comes back as a non-dispatch with the
 *     suppression reason, not as a launch.
 *   - the guard entry the core recorded for THIS launch rides the run record (`dispatchedGuard`), beside the
 *     whole tick's bookkeeping under its honest name (`tickNextState` — see `shapeDispatchRead`, which explains
 *     why a caller that runs only this operation must carry the first and not the second).
 *
 * If a reader finds a guard rule, a TTL or a lane assignment in this file, that is the bug.
 *
 * ── IO IS INJECTED, AND THIS FILE REACHES NOTHING ───────────────────────────────────────────────────────────
 *
 * Same split as {@link ./review-pr.mjs} / {@link ./review-pr-io.mjs}: the declaration is the WHAT, and
 * {@link ./dispatch-lane-io.mjs} is the only place it touches the world. Its whole static import graph is
 * `./registry.mjs` + `./step-kinds.mjs` — no `node:` specifier at all, so the step fns hold no spawner in
 * lexical scope and the fill below is unit-testable with a two-line stub.
 *
 * That is also why {@link planTickCoreSelection the selection} happens in the io shell rather than here: item
 * identity is normalized by `normNum` (`we:scripts/conveyor/queue-store.mjs`) — the SAME normalizer the state
 * read, the dispatch plan and the tick core key on — and a second copy of it in this file is precisely how two
 * halves of the system come to disagree about which item `#042` is. The shell selects; the declaration shapes,
 * decides and declares.
 *
 * ── THE THREE STEPS ─────────────────────────────────────────────────────────────────────────────────────────
 *
 *   | step       | kind      | what it does                                                                   |
 *   |------------|-----------|--------------------------------------------------------------------------------|
 *   | `read`     | `compute` | shape one tick read (already selected for this `num`) + FILL the delivery brief |
 *   | `plan`     | `compute` | the verdict: dispatching or not, and why not                                    |
 *   | `dispatch` | `effect`  | declares ONE `dispatch: true` effect — or NONE, when the core said no           |
 *
 * NO `confirm`, DELIBERATELY. A human stop in the per-lane dispatch loop is the thing
 * [#conveyor-orchestration-mechanics-not-per-lane-agent](../../docs/agent/platform-decisions.md#conveyor-orchestration-mechanics-not-per-lane-agent)
 * forbids, and the tick has never had one. NO `judge` either: nothing here is a judgement — the core already
 * decided, and re-asking a model would put a model back in the loop the ruling took it out of.
 *
 * PURE. No fs, no clock, no process, no network in this file.
 */

import { op } from './registry.mjs';
// #3224 — the raw invocation this operation declares over. Declared in ONE place and read by two
// consumers: `op()` validates its shape here, and the skill-wiring scan reads the same map.
import { DECLARED_HOMES } from './declared-homes.mjs';
import { compute, effect as effectStep } from './step-kinds.mjs';

/** The operation's stable id. Adapters resolve it by this name. */
export const DISPATCH_LANE_OP = 'dispatch-lane';

/**
 * The effect type a dispatch declares. ONE type, and both halves of the #3084 contract hang off it: the SINK
 * that starts the agent and the OBSERVER that later asks how it is going are registered under this same string
 * (`we:scripts/operations/dispatch-lane-io.mjs`), exactly as the executor's and the observer's tables expect.
 */
export const DISPATCH_EFFECT = 'conveyor.dispatch-delivery-agent';

/**
 * How long a delivery agent is expected to take, in minutes, before "still running" becomes "go look at it".
 *
 * It becomes the entry's `expectedBy`, which is the ONLY thing that separates `inFlightEntries().running` from
 * `.overdue` — a waker without one can tell finished from not-finished but never RUNNING from STALLED. 90
 * minutes is the conveyor's own observation of a build (claim → gate → converge → PR), and it is an ESTIMATE,
 * never a deadline: nothing kills or re-dispatches an overdue entry (`effect-observer.mjs` is explicit that
 * failing work on a clock alone kills slow-but-healthy builds).
 */
export const DEFAULT_EXPECTED_WITHIN_MINUTES = 90;

/** The five `{{PLACEHOLDER}}` tokens `we:skills-src/conveyor/delivery-agent-brief.md` declares — build and
 * both prepare kinds share this set (#3165). */
export const BRIEF_PLACEHOLDERS = Object.freeze(['ITEM_NUM', 'ITEM_SPEC_PATH', 'LANE', 'SESSION_SLUG', 'SCOPE']);

/**
 * The `{{PLACEHOLDER}}` tokens `we:skills-src/conveyor/fix-agent-brief.md` declares (#3383). No
 * `ITEM_SPEC_PATH` — a fix agent reconstitutes from the bounced PR's own ref, not the item's spec path — and
 * `PR_NUM`/`LANE_REF` replace it: which PR, and which ref to reconstitute onto.
 */
export const FIX_BRIEF_PLACEHOLDERS = Object.freeze(['ITEM_NUM', 'PR_NUM', 'LANE_REF', 'LANE', 'SESSION_SLUG', 'SCOPE']);

/**
 * The `{{PLACEHOLDER}}` tokens `we:skills-src/conveyor/fix-agent-ci-brief.md` declares (#3383). Same shape as
 * {@link FIX_BRIEF_PLACEHOLDERS} plus `REASON` (`red-ci` | `behind`, #2666) — the durable CI-heal comment names
 * why the heal fired, and only the tick core (via `isRedCi`) knows that.
 */
export const CI_HEAL_BRIEF_PLACEHOLDERS = Object.freeze([...FIX_BRIEF_PLACEHOLDERS, 'REASON']);

/** Per-{@link LAUNCH_KINDS} placeholder set — which of the above a given kind's brief requires. */
export const BRIEF_PLACEHOLDERS_BY_KIND = Object.freeze({
  build: BRIEF_PLACEHOLDERS,
  prepare: BRIEF_PLACEHOLDERS,
  'prepare-decision': BRIEF_PLACEHOLDERS,
  fix: FIX_BRIEF_PLACEHOLDERS,
  'ci-heal': CI_HEAL_BRIEF_PLACEHOLDERS,
});

/**
 * THE FIVE AGENT KINDS THIS OPERATION CAN START (#3165, extended #3383), in the order the shell resolves them.
 *
 * `planTick` returns five launch lists — `spawnBuilds`, `spawnPrepareScope`, `spawnPrepareDecision`,
 * `spawnFixes`, `spawnCiHeals`. Until #3165 the operation launched only the first; until #3383 it launched only
 * the first three — `spawnFixes`/`spawnCiHeals` were planned, guarded and briefed (`fix-agent-brief.md` /
 * `fix-agent-ci-brief.md` existed, unwired) but only ever SURFACED for a human/session to hand-execute
 * (`we:skills-src/conveyor/SKILL.md` §3c's "you EXECUTE `decisions.spawnCiHeals`") — the exact manual step the
 * background-mechanical-dispatcher epic exists to close.
 *
 * ONE ITEM IS IN AT MOST ONE LIST — an unscoped held item never reaches `spawnBuilds`, a decision is never an
 * unshaped build, and a fix/ci-heal targets an OPEN PR a build/prepare item cannot simultaneously be — so the
 * order below is a tie-break that no real tick exercises, not a precedence rule. Stated as data anyway, because
 * two files agreeing on the order by coincidence is how they stop agreeing.
 */
export const LAUNCH_KINDS = Object.freeze(['build', 'prepare', 'prepare-decision', 'fix', 'ci-heal']);

/** {@link LAUNCH_KINDS} whose scope is the item's OWN `scope:` frontmatter, same as a build (#3383) — a fix or
 * CI-heal repairs the item's PR in place, so it needs the same paths the build was allowed to touch, not the
 * prepare kinds' single-backlog-file scope. */
export const ITEM_SCOPED_LAUNCH_KINDS = Object.freeze(['build', 'fix', 'ci-heal']);

/** {@link LAUNCH_KINDS} that reconstitute from an existing PR ref rather than starting fresh from `main` — the
 * ones whose brief needs `PR_NUM`/`LANE_REF` instead of `ITEM_SPEC_PATH` (#3383). */
export const PR_REPAIR_LAUNCH_KINDS = Object.freeze(['fix', 'ci-heal']);

/**
 * How long an in-flight dispatch record whose agent's LIVENESS CANNOT BE ESTABLISHED keeps holding its item
 * past the deadline it was given. See {@link dispatchStillHolds} — this is the backstop for an entry nothing
 * can be observed about, and it never overrules a listing that says the agent is alive.
 *
 * THE VALUE IS PINNED BY A TEST WRITTEN WITH THE LITERAL (PR #1211 round 2, G5). The boundary tests were
 * written relative to this constant, so `30 → 0` left the whole suite green — a margin asserted only against
 * itself is a margin the next refactor deletes for free. It absorbs clock difference between the process that
 * wrote `expectedBy` and the process that reads `observedAt`; at 0 it is a knife edge.
 */
export const DISPATCH_HOLD_GRACE_MINUTES = 30;

/**
 * How long after a dispatch STARTED its session may still be missing from `claude agents --json` without that
 * absence meaning the agent is gone.
 *
 * `claude --bg` returns before its session is necessarily visible, so a listing taken inside this window
 * cannot tell *not yet listed* from *already finished*. The OBSERVER treats "absent and young" as still
 * `running` — the fail-closed direction for a reader whose wrong answer writes nothing.
 *
 * THIS IS THE OBSERVER'S WINDOW ONLY. It used to be the guard's too; it is not any more. The double-dispatch
 * guard reads {@link DISPATCH_GUARD_LISTING_GRACE_MINUTES} instead, because the two readers pay very different
 * prices for the same wrong answer — see that constant.
 *
 * ONE SOURCE OF TRUTH with the observer's own grace: `we:scripts/operations/dispatch-lane-io.mjs` derives its
 * `LISTING_GRACE_MS` from this constant rather than carrying a second number that could drift from it. That
 * derivation is still correct and still wanted; the guard is the one deliberate EXCEPTION to it, and it states
 * its own reason rather than silently carrying a second copy of this number.
 */
export const DISPATCH_LISTING_GRACE_MINUTES = 2;

/**
 * The same window as {@link DISPATCH_LISTING_GRACE_MINUTES}, for the DOUBLE-DISPATCH GUARD, and deliberately
 * larger.
 *
 * WHY TWO NUMBERS, when the comment above says two numbers that must agree eventually will not: these two must
 * NOT agree. They answer the same question — "how long is a session's absence from the listing still just *not
 * yet listed*?" — for two readers whose cost of being wrong differs by roughly 100x:
 *
 *   - THE OBSERVER is wrong → it reports `unresolved`. Nothing is written, nothing is started, and an operator
 *     looks at an entry that needed looking at anyway.
 *   - THE GUARD is wrong → it releases the item, and the next dispatch starts a SECOND agent in the same lane
 *     clone, racing one working tree, both opening a PR. That is the entire failure this guard exists for.
 *
 * An asymmetric cost gets an asymmetric window. Waiting longer costs the guard only latency on a dispatch that
 * was going to be re-attempted anyway; waiting too little costs a double-dispatch. Ten minutes is still far
 * below any real build and five times the slowest spawn→listed gap the observer needs to cover.
 *
 * IT MUST STAY GREATER THAN THE OBSERVER'S. Equal or smaller and the guard is back to trusting a single bad
 * read as fast as the reader whose wrong answer is free — the exact state this constant exists to end.
 * Asserted, not merely written down: `we:scripts/operations/__tests__/dispatch-lane-defaults.test.mjs`.
 */
export const DISPATCH_GUARD_LISTING_GRACE_MINUTES = 10;

/**
 * DETECTION is wider than SUBSTITUTION, and the gap is the whole point (PR #1211 review, F3 → round 2, G4).
 *
 * Substitution is keyed to the five names spelled EXACTLY `{{NAME}}`. If detection used the same shape, every
 * near-miss spelling — `{{ ITEM_NUM }}`, `{{item_num}}`, `{{ITEM-NUM}}` — would match nothing at all: not
 * substituted, and not reported either, since `unknownTokens` is fed by the same scan. A one-character typo in
 * the brief would then reach a dispatched agent verbatim and silently, which is the failure this fill exists to
 * prevent.
 *
 * ROUND 1'S FIX WAS STILL TOO NARROW, and the claim above {@link fillBrief} was stated more strongly than the
 * code delivered: the character class was `[A-Za-z0-9_-]`, so `{{ITEM NUM}}` and `{{ITEM.NUM}}` — an underscore
 * typed as a space, or as a dot — matched NOTHING and reached the agent verbatim AND unreported. The class is
 * now "anything that is not a brace and not a newline", which covers every spelling a placeholder can actually
 * be typed as. Newlines are excluded deliberately: a placeholder never spans lines, and admitting them would
 * let one unclosed `{{` swallow a paragraph of the brief's prose into a single bogus token.
 */
export const BRIEF_TOKEN_RE = /\{\{\s*([^{}\n]*?)\s*\}\}/g;

/**
 * The canonical placeholder a detected token name is a MISSPELLING OF, or null when it names nothing this
 * operation fills.
 *
 * NORMALIZES EVERY NON-ALPHANUMERIC RUN TO ONE `_`, then upper-cases — so `item-num`, `ITEM NUM`, `Item.Num`
 * and `item_num` all canonicalize to `ITEM_NUM`. Dashes alone were not enough (PR #1211 round 2, G4): the
 * separators typos actually produce are the space and the dot as much as the dash.
 *
 * @param {string} name - the token name, without braces.
 * @param {readonly string[]} [placeholders] - the kind's own required set (#3383) — defaults to
 *   {@link BRIEF_PLACEHOLDERS} so every pre-#3383 caller is byte-identical.
 * @returns {string|null}
 */
export function canonicalPlaceholder(name, placeholders = BRIEF_PLACEHOLDERS) {
  const norm = String(name ?? '').trim().replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  return placeholders.includes(norm) ? norm : null;
}

/**
 * What a placeholder VALUE may contain. An allowlist, and narrow on purpose.
 *
 * WHY IT IS NOT COSMETIC. The brief tells the agent to run `lane-pool.mjs acquire … --scope={{SCOPE}}
 * --item={{ITEM_NUM}}` — UNQUOTED, inside a `$( … )`. `SCOPE` is backlog frontmatter, so a scope entry
 * carrying a backtick, a `;` or a newline would land inside a shell command an agent is instructed to run.
 * That was survivable while a human filled the brief in a live session and read what they were pasting; this
 * operation mechanizes the fill, and a mechanized fill has to do its own checking.
 *
 * Every legitimate value is an id, a repo-relative path, a lane number or a comma-joined list of
 * repo-qualified paths, so letters, digits, `_ . , : / @ # -` covers all five with nothing left over.
 */
export const BRIEF_VALUE_RE = /^[A-Za-z0-9_.,:/@#-]+$/;

/**
 * The lane-lease session slug a dispatched agent carries. It MUST agree with `releaseSessionForNum`
 * (`we:scripts/conveyor/tick-core.mjs`), which derives the slug a merged PR's watcher hands to
 * `pr-watch --release-session` so the lease is auto-released at merge. A slug that disagreed here would strand
 * the lease: the watcher would release a session nobody acquired.
 *
 * PER KIND, because the core's side already is (#3165). `releaseSessionForNum` reads the PR's owning
 * PREPARE GUARD to pick `prepare-<num>` / `prepare-decision-<num>` and falls back to `conveyor-<num>`, so
 * dispatching a prepare under the build slug arms a watcher that would release a session which was never
 * created — and the failure is silent on both sides.
 *
 * MIRRORED, NOT IMPORTED, and deliberately: this file reaches nothing (its whole import graph is
 * `./registry.mjs` + `./step-kinds.mjs`), and importing the core here would put the conveyor's tick machinery
 * inside the pure declaration. The agreement is asserted instead, against the core's OWN function, in
 * `we:scripts/operations/__tests__/dispatch-lane.test.mjs`.
 *
 * FIX/CI-HEAL SLUGS (#3383) mirror the brief tables' own examples verbatim (`fix-agent-brief.md`: `` `{{SESSION_SLUG}}` | a
 * stable per-repair session slug, e.g. `fix-{{ITEM_NUM}}` ``) — not `releaseSessionForNum`'s business, since a
 * fix/ci-heal lease is released by the fix agent itself (`rearm-review.mjs`/`ci-heal-mark.mjs` exit, never a
 * merge watcher) and carries no risk of arming a watcher for a session nobody created.
 *
 * @param {string|number} num
 * @param {'build'|'prepare'|'prepare-decision'|'fix'|'ci-heal'} [kind] - defaults to `build`, so every
 *   pre-#3165 caller is byte-identical.
 * @returns {string}
 */
export function sessionSlugFor(num, kind = 'build') {
  const id = String(num).trim();
  if (kind === 'prepare-decision') return `prepare-decision-${id}`;
  if (kind === 'prepare') return `prepare-${id}`;
  if (kind === 'fix') return `fix-${id}`;
  if (kind === 'ci-heal') return `ci-heal-${id}`;
  return `conveyor-${id}`;
}

/**
 * FILL the delivery-agent brief. PURE.
 *
 * The brief is a TEMPLATE, not a prompt — `we:skills-src/conveyor/delivery-agent-brief.md` says so in its first
 * line, and the skill's §3 says the five tokens "are the whole fill — do not rewrite its prose". So this
 * substitutes those five and nothing else.
 *
 * ONE PASS, NOT FIVE. A sequential substitute-per-placeholder expands a token that appeared inside an EARLIER
 * value on a later iteration, which is both a wrong fill and one no leftover check can see afterwards. A single
 * regex pass reads each token exactly once, so a value is inert by construction.
 *
 * WHAT IT REFUSES — a value that is missing, blank, or outside {@link BRIEF_VALUE_RE}. Both are holes an agent
 * cannot recover from: it acquires no lane, or it runs a brief carrying shell metacharacters.
 *
 * WHAT IT DOES **NOT** REFUSE — an UNKNOWN `{{TOKEN}}`, one that names none of the five. This is a correction of
 * the first cut, which threw on any leftover. The real brief's own prose carries two (`{{PLACEHOLDERS}}` and
 * `{{LIKE_THIS}}`, both inside code spans, both explaining the fill convention to a reader), so that check
 * refused EVERY dispatch of EVERY item — and no test caught it, because every test used a synthetic five-token
 * template. The check was also mis-weighted: a token in prose that names nothing costs an agent one confusing
 * line, while a false refusal costs the whole dispatch. So unknown tokens are REPORTED (`unknownTokens`, which
 * rides the run record) and never fatal.
 *
 * WHAT IT REFUSES AGAIN, and this is the correction of THAT correction (PR #1211 review, F3): a MISSPELLED
 * placeholder — a token that names one of the five in any other spelling (`{{ ITEM_NUM }}`, `{{item_num}}`,
 * `{{ITEM-NUM}}`, `{{ITEM NUM}}`, `{{ITEM.NUM}}`). The over-broad first fix made those neither substituted NOR
 * reported, because the scan regex matched only the exact shape; a one-character typo in the brief would reach
 * the agent verbatim and invisible.
 *
 * THE PROPERTY, and it is now exactly as wide as {@link BRIEF_TOKEN_RE}: **no placeholder of this operation's
 * own may reach a dispatched agent unsubstituted, spelled with any run of separators (spaces, dots, dashes,
 * underscores) and in any case — and the refusal names which one.** Round 1 claimed "in any spelling" while
 * the scan covered only `[A-Za-z0-9_-]`, which left `{{ITEM NUM}}` and `{{ITEM.NUM}}` invisible (round 2, G4);
 * the claim and the class are stated together here so the next reader can check one against the other. The one
 * spelling still outside it is a token carrying a BRACE or a NEWLINE, which no placeholder ever is.
 *
 * A token that names nothing we fill is still merely reported, so the real brief's prose still dispatches.
 *
 * @param {string} template - the brief's markdown.
 * @param {Record<string, string|number>} values - keyed by placeholder NAME (`ITEM_NUM`, not `{{ITEM_NUM}}`).
 * @param {readonly string[]} [placeholders] - the kind's own required set (#3383, {@link BRIEF_PLACEHOLDERS_BY_KIND}) —
 *   defaults to {@link BRIEF_PLACEHOLDERS} so every pre-#3383 caller (build, both prepare kinds) is byte-identical.
 * @returns {{prompt: string, unknownTokens: string[]}}
 */
export function fillBrief(template, values = {}, placeholders = BRIEF_PLACEHOLDERS) {
  const text = String(template ?? '');
  if (!text.trim()) {
    throw new Error('dispatch-lane: the delivery-agent brief template is empty — refusing to dispatch an agent with no instructions');
  }
  for (const name of placeholders) {
    const value = values[name];
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new Error(`dispatch-lane: no value for the brief placeholder {{${name}}} — refusing to fill it with nothing`);
    }
    if (!BRIEF_VALUE_RE.test(String(value))) {
      throw new Error(
        `dispatch-lane: the value for {{${name}}} (${JSON.stringify(String(value))}) has characters the brief cannot carry `
        + 'safely — it is pasted UNQUOTED into a shell command the agent is told to run. Refusing.',
      );
    }
  }
  const unknown = new Set();
  const misspelled = new Set();
  const prompt = text.replace(BRIEF_TOKEN_RE, (whole, name) => {
    // The EXACT shape is the only one that substitutes. `whole` is compared rather than `name` alone because
    // the scan strips the surrounding whitespace into the match but not into the capture, so `{{ ITEM_NUM }}`
    // and `{{ITEM_NUM}}` arrive with the same `name` and must NOT be treated the same.
    if (whole === `{{${name}}}` && placeholders.includes(name)) return String(values[name]);
    const canonical = canonicalPlaceholder(name, placeholders);
    if (canonical) { misspelled.add(`${whole} (meaning {{${canonical}}})`); return whole; }
    unknown.add(whole);
    return whole;
  });
  if (misspelled.size) {
    throw new Error(
      `dispatch-lane: the brief carries a MISSPELLED placeholder — ${[...misspelled].sort().join(', ')}. No `
      + 'substitution reaches it, so the dispatched agent would run the token verbatim (a lane leased under a '
      + 'literal `{{ SESSION_SLUG }}` is a lease nothing ever releases). Refusing to dispatch. Spell it exactly '
      + `as one of ${placeholders.map((n) => `{{${n}}}`).join(', ')}.`,
    );
  }
  return { prompt, unknownTokens: [...unknown].sort() };
}

/**
 * Does an in-flight dispatch record still HOLD its item against a fresh dispatch?
 *
 * ── TWO OPPOSITE FAILURES, AND THIS FUNCTION HAS TO AVOID BOTH ───────────────────────────────────────────────
 *
 * **The wedge (PR #1211 round 1, F1).** Three shipped decisions composed into a permanent, per-item lockout:
 * the observer never answers `succeeded` (`claude agents` reports liveness, not outcome — #x9ylkp7),
 * `unresolved` writes nothing, so the entry stays `in-flight` forever; and the guard refused any item with ANY
 * in-flight record. Run records are never pruned, so ONE dispatch per item was the ceiling and the conveyor's
 * own loop (dispatch → PR → review bounces → re-dispatch) could never run.
 *
 * **The hole (PR #1211 round 2, G1).** The first fix aged the hold out on WALL CLOCK alone, and its docblock
 * claimed an entry past `expectedBy + grace` was "by construction" finished or dead. That is false, and the
 * same module proves it: the observer's other answer is `running`, and nothing bounds it. A background session
 * stalled on a permission prompt is ALIVE, holds no lane lease and has claimed no item — so at t+2h the tick
 * core hands out the same cleared row and the same lane, and a SECOND agent starts under the same session slug.
 * The clock removed the cover in precisely the case where the cover was doing work.
 *
 * ── THE AXIS IS LIVENESS; THE CLOCK IS ONLY THE BACKSTOP ────────────────────────────────────────────────────
 *
 * `entry.live` is the answer `claude agents --json` gave about THIS record's handle, stamped onto the row by
 * the io shell (`we:scripts/operations/dispatch-lane-io.mjs#stampLiveness`) so this stays pure. Three values,
 * three rules:
 *
 *   | `live`  | meaning                                   | verdict                                            |
 *   |---------|-------------------------------------------|----------------------------------------------------|
 *   | `true`  | the session is LISTED — the agent is alive | HOLDS, and no clock may overrule it                |
 *   | `false` | listed-and-absent — the agent is gone      | ages out as soon as it is older than the listing grace |
 *   | nullish | no handle, or the listing could not be read | the CLOCK backstop below                          |
 *
 * That satisfies both constraints at once, which is the whole point: a record whose session is gone forever
 * still ages out (in MINUTES now, not hours), and a record whose session is alive is never released on a clock.
 *
 * WHY `false` STILL WAITS OUT A GRACE. `claude --bg` returns before its session is necessarily listed, so
 * "absent" inside {@link DISPATCH_GUARD_LISTING_GRACE_MINUTES} of the anchor below is *not yet visible*, not
 * *gone* — and those seconds are exactly the spawn→claim window this guard exists for. Absent with no usable
 * anchor at all cannot be told apart from either, so it holds. The guard's window is its OWN and is larger
 * than the observer's {@link DISPATCH_LISTING_GRACE_MINUTES}; that constant's docblock says why.
 *
 * AND WHY IT AGES FROM `lastSeenLiveAt`, NOT `startedAt`. `startedAt` answers "how long ago did this begin?",
 * which is the wrong question for an agent that has been confirmed alive since. Anchored on `startedAt`, ONE
 * bad listing read against a long-running build is instantly past the grace and releases the lane — the age
 * that matters is the age of the last CONFIRMATION, not of the dispatch. `lastSeenLiveAt` is stamped every
 * time a listing read answers `live: true` (`dispatch-lane-io.mjs#persistLastSeenLive`), so a bad read
 * arriving straight after a real "seen alive" cannot release the item, while two bad reads spaced by the
 * window still can. It falls back to `startedAt` only when it was never set — a dispatch never yet seen alive,
 * which is the case the original window was written for and where the two anchors agree.
 *
 * WHY THE CLOCK IS SOUND FOR THE NULLISH CASE AND ONLY THERE. A handle-less INDETERMINATE entry can never be
 * observed at all, and an unreadable listing means the system has NO liveness signal — so the `running` answer
 * that made the clock wrong cannot be the one being contradicted. G1's property holds: this never releases an
 * item while the system's own liveness signal says the agent is running.
 *
 * FAIL-CLOSED ON A DATE IT CANNOT READ. No usable instant, or a record carrying neither `expectedBy` nor
 * `startedAt`, means the age is unknown — and an unknown age holds, because the cost of a wrong "aged out" is
 * two agents in one clone and the cost of a wrong "still holding" is a refusal an operator can see and act on
 * (`wake.mjs --resolve`, which now refuses to close out a LIVE handle without `--force`).
 *
 * @param {{expectedBy?: string|null, startedAt?: string|null, lastSeenLiveAt?: string|null, live?: boolean|null}} entry -
 *   an in-flight dispatch record summary, with the liveness answer the io shell stamped onto it and the
 *   instant a listing read last confirmed it alive.
 * @param {string} at - the instant the read was taken, ISO. The io shell supplies it; this stays pure.
 * @param {{expectedWithinMinutes?: number, graceMinutes?: number, listingGraceMinutes?: number}} [o]
 * @returns {boolean}
 */
export function dispatchStillHolds(entry, at, {
  expectedWithinMinutes = DEFAULT_EXPECTED_WITHIN_MINUTES,
  graceMinutes = DISPATCH_HOLD_GRACE_MINUTES,
  listingGraceMinutes = DISPATCH_GUARD_LISTING_GRACE_MINUTES,
} = {}) {
  const now = Date.parse(String(at ?? ''));
  if (Number.isNaN(now)) return true;
  const startedAt = Date.parse(String(entry?.startedAt ?? ''));

  // THE AGENT IS ALIVE. No clock, at any age. This is the branch the round-2 fix did not have.
  if (entry?.live === true) return true;

  // THE AGENT IS GONE from a listing that WAS read. Nothing can collide with a session that does not exist, so
  // the hold ends as soon as the record is too old for "absent" to mean "not listed yet".
  if (entry?.live === false) {
    // THE ANCHOR IS THE LAST CONFIRMATION, falling back to the start only for a dispatch never seen alive.
    const lastSeenLive = Date.parse(String(entry?.lastSeenLiveAt ?? ''));
    const anchor = Number.isNaN(lastSeenLive) ? startedAt : lastSeenLive;
    if (Number.isNaN(anchor)) return true;
    // THE FALLBACK IS THE GUARD'S WINDOW TOO. Reading the observer's constant here would hand a caller that
    // passed a malformed or negative `listingGraceMinutes` the smaller number back — the guard's default
    // quietly downgraded to the observer's by a bad argument, which is the hole the default alone leaves open.
    const listingGrace = Number(listingGraceMinutes) >= 0 ? Number(listingGraceMinutes) : DISPATCH_GUARD_LISTING_GRACE_MINUTES;
    return now < anchor + listingGrace * 60_000;
  }

  // LIVENESS IS UNKNOWN — the clock backstop, and the only case it is sound for.
  const expectedBy = Date.parse(String(entry?.expectedBy ?? ''));
  // `expectedBy` is the deadline the sink recorded. A handle-less INDETERMINATE entry never got one, so its
  // deadline is reconstructed from `startedAt` and the same estimate the dispatch would have used.
  const deadline = Number.isNaN(expectedBy)
    ? (Number.isNaN(startedAt) ? NaN : startedAt + (Number(expectedWithinMinutes) > 0 ? Number(expectedWithinMinutes) : DEFAULT_EXPECTED_WITHIN_MINUTES) * 60_000)
    : expectedBy;
  if (Number.isNaN(deadline)) return true;
  return now < deadline + (Number(graceMinutes) >= 0 ? Number(graceMinutes) : DISPATCH_HOLD_GRACE_MINUTES) * 60_000;
}

/**
 * The answers `stampLiveness` may give about where an in-flight record's liveness came from. Anything else
 * (including an absent field) reads as `unknown`, which is the honest word for a reader that did not say.
 */
export const LIVENESS_SOURCES = Object.freeze(['claude-agents', 'unreadable', 'not-needed']);

/** A launch/suppression row from the tick core, or null. Shape-checked, never trusted blind. */
function shapeRow(row, what) {
  if (row == null) return null;
  if (typeof row !== 'object' || row.num == null) {
    throw new Error(`dispatch-lane.read: the injected reader returned a malformed \`${what}\` row`);
  }
  return row;
}

/**
 * SHAPE one tick read into the `read` finding, and FILL the brief while everything needed is in hand. PURE —
 * separated from the injected reader so every refusal below is testable without `gh`, `git` or a lane pool.
 *
 * WHAT THE READER OWES, and why each piece is refused when missing:
 *   - `launch` — the `decisions.spawnBuilds` row for THIS num, already selected by the shell's `normNum`. Its
 *     `lane` is the core's assignment and the only lane this operation will ever dispatch.
 *   - `suppressed` — the `decisions.suppressedBuilds` row, when the core dropped this num instead. Carried so
 *     the non-dispatch says WHY (`by: 'num'` — an agent is already in flight for it; `by: 'lane'` — its lane is).
 *   - `item` — the spec path and the repo-qualified `scope:`, both of which go into the brief.
 *   - `briefTemplate` — the delivery brief's markdown.
 *   - `bookkeepingSource` — where the in-flight guards came from. `'none'` is a REAL degradation and is
 *     reported, not hidden: with no bookkeeping the core sees no in-flight guards, so its only protection
 *     against a double-dispatch is the durable state (a leased lane, a claimed item), which leaves the
 *     spawn→claim window uncovered. Legible, never silent.
 *
 * @param {object} raw - what `we:scripts/operations/dispatch-lane-io.mjs`'s `readTick` returns.
 * @param {{num: string, expectedWithinMinutes: number}} asked
 * @returns {object} the `read` finding.
 */
export function shapeDispatchRead(raw, { num, expectedWithinMinutes } = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`dispatch-lane.read: the injected reader returned ${typeof raw}, not a tick read`);
  }
  const launch = shapeRow(raw.launch, 'launch');
  const suppressed = shapeRow(raw.suppressed, 'suppressed');
  // WHICH OF THE CORE'S THREE LAUNCH LISTS this row came out of (#3165). The shell resolved it; this half
  // REFUSES an unknown one rather than defaulting, for the same reason `briefPath` throws: the fallback would
  // hand a scope-prep agent the 39 KB delivery mandate — an agent told to build an item whose scope is exactly
  // what nobody has written yet. An ABSENT kind is the pre-#3165 shape and reads as `build`; a PRESENT but
  // unrecognized one is a shell that changed under us, and is fatal.
  const launchKind = raw.launchKind === undefined || raw.launchKind === null ? 'build' : String(raw.launchKind);
  if (!LAUNCH_KINDS.includes(launchKind)) {
    throw new Error(
      `dispatch-lane.read: the injected reader returned an unknown \`launchKind\` ${JSON.stringify(raw.launchKind)} `
      + `— it must be one of ${LAUNCH_KINDS.join(', ')}. Refusing to guess which agent to start.`,
    );
  }
  const resolvedNum = String(raw.resolvedNum ?? '').trim();
  if (!resolvedNum) {
    throw new Error(`dispatch-lane.read: the reader could not resolve ${JSON.stringify(num)} to an item id`);
  }

  // THIS OPERATION'S OWN IN-FLIGHT DISPATCHES, read from the run store by the io shell. Split below, but read
  // here so the PARTIAL-GUARD count can ride `base` — every exit from this function reports it.
  const inFlight = raw.inFlightDispatches && typeof raw.inFlightDispatches === 'object' ? raw.inFlightDispatches : { runs: [], unreadable: 0 };
  const allRuns = Array.isArray(inFlight.runs) ? inFlight.runs : [];

  const base = {
    asked: String(num ?? ''),
    num: resolvedNum,
    // WHICH AGENT this call is about, on every exit — a non-dispatch that says "not cleared" is a different
    // fact depending on whether a build or a prepare was asked for, and the run record has to say which.
    launchKind,
    // The tick's own one-line status and notes, carried verbatim so an operator reading a run record sees the
    // same sentence the conveyor's status line shows. Display only — nothing downstream decides on them.
    statusLine: String(raw.statusLine || ''),
    notes: Array.isArray(raw.notes) ? raw.notes.map((n) => String(n?.text ?? n)) : [],
    bookkeepingSource: raw.bookkeepingSource === 'file' ? 'file' : 'none',
    // WHICH OF THE CALLER'S OWN SETTINGS THIS RUN DID NOT HONOUR. The io shell forwards only `bookkeeping` to
    // the tick core (`config` carries the TTLs and the retry caps, `signals` retires guards outright), and
    // dropping `config` is not purely conservative — a caller running a LONGER `buildTtlTicks` gets the shipped
    // default instead. So the drops are carried onto the verdict rather than being a comment's promise.
    droppedBookkeeping: Array.isArray(raw.droppedBookkeepingKeys) ? raw.droppedBookkeepingKeys.map(String) : [],
    // THE WHOLE TICK'S NEXT BOOKKEEPING — and it describes a tick that did NOT fully happen, which is why it is
    // named for what it is rather than offered as `nextState`.
    //
    // `planTick` plans the ENTIRE tick: a build guard for every row in `spawnBuilds`, plus prepare, fix and
    // CI-heal guards and their `launchedNums`. This operation executes exactly ONE of those decisions. So a
    // caller that carried this map forward would hold guards for agents nobody started — the next call for a
    // sibling item would come back "an agent is already in flight for this item" for the whole TTL, for a
    // dispatch that never occurred.
    //
    // A CALLER RUNNING ONLY THIS OPERATION CARRIES `dispatchedGuard`, NOT THIS. `tickNextState` is here for
    // the caller that DOES drive the whole tick (the runner), and for a reader who wants to see what the core
    // decided; #xaibmeu is where the bridge chooses which of the two it is.
    tickNextState: raw.nextState && typeof raw.nextState === 'object' ? raw.nextState : null,
    // THIS DISPATCH'S OWN GUARD ENTRY — `{ num, lane, spawnedTick }`, exactly the shape `filterLaunches` reads,
    // and the only bookkeeping this operation actually earns. Null on a non-dispatch.
    dispatchedGuard: raw.dispatchedGuard && typeof raw.dispatchedGuard === 'object' ? raw.dispatchedGuard : null,
    expectedWithinMinutes: Number(expectedWithinMinutes) > 0 ? Number(expectedWithinMinutes) : DEFAULT_EXPECTED_WITHIN_MINUTES,
    // HOW PARTIAL THE DOUBLE-DISPATCH GUARD WAS. `inFlightDispatchesFor` skips a run record it cannot read
    // rather than wedging every dispatch behind one corrupt file — a real trade, and its docblock promised the
    // count "rides the result so a caller can see the guard was partial". It did not: the number was read and
    // dropped (PR #1211 review, F4). It rides `base` now, so it reaches the verdict on EVERY exit, dispatch or
    // not. The guard's failure mode is two agents in one lane clone; a silently-partial one is the last thing
    // that should be invisible.
    unreadableRunRecords: Number(inFlight.unreadable) > 0 ? Number(inFlight.unreadable) : 0,
    // WHERE THE HOLD'S LIVENESS ANSWER CAME FROM (PR #1211 round 2, G1). `claude-agents` means each in-flight
    // record was checked against the real session listing; `unreadable` means the listing could not be read at
    // all and every hold fell back to the CLOCK backstop, which is a materially weaker guard and must not look
    // like the strong one; `not-needed` means there was nothing in flight to ask about.
    dispatchLiveness: LIVENESS_SOURCES.includes(inFlight.livenessSource) ? inFlight.livenessSource : 'unknown',
  };

  // THIS OPERATION'S OWN IN-FLIGHT DISPATCHES, checked BEFORE the launch — because the case it covers is
  // exactly the one where the tick core sees nothing wrong. The core's build guard lives in the CALLER'S
  // session bookkeeping, which defaults to empty here, and the LANE is leased by the agent seconds after it
  // starts. So two back-to-back invocations get the same cleared row, the same lane, and two agents in one
  // clone. The run store is the only thing that remembers the first one, and it remembers it across a restart.
  //
  // BUT ONLY WHILE IT COULD STILL BE THAT WINDOW — see `dispatchStillHolds`. Holding on EVERY in-flight record
  // made one completed dispatch lock its item out forever, because nothing ever resolves the entry
  // (`unresolved` writes nothing) and run records are never pruned; releasing on the CLOCK ALONE handed the
  // same lane to a second agent while the first was still listed as running.
  const holdingRuns = allRuns.filter((r) => dispatchStillHolds(r, raw.observedAt, { expectedWithinMinutes: base.expectedWithinMinutes }));
  const agedOutRuns = allRuns.filter((r) => !holdingRuns.includes(r));
  if (holdingRuns.length) {
    // WHICH KIND OF HOLD IT IS, in the operator's own line: a session `claude agents` still lists is a
    // materially different fact from one whose liveness nothing could establish, and the remedies differ.
    const liveHolds = holdingRuns.filter((r) => r.live === true);
    return {
      ...base,
      dispatching: false,
      lane: null,
      sessionSlug: null,
      prompt: null,
      briefUnknownTokens: [],
      itemSpecPath: null,
      scope: [],
      dispatchedGuard: null,
      inFlightRuns: holdingRuns,
      agedOutRuns,
      holdReason:
        `this operation already has a dispatch in flight for #${resolvedNum} (run ${holdingRuns.map((r) => r.runId).join(', ')}) — `
        + (liveHolds.length
          ? `its session is STILL LISTED by \`claude agents\` (${liveHolds.map((r) => r.handle).join(', ')}), so the agent is alive. `
          : 'nothing could establish whether its agent is alive, and it is still inside the clock backstop. ')
        + 'Resolve or close out that run '
        + '(`node scripts/operations/wake.mjs --resolve=<runId> --key=<effectKey> --status=failed`) before dispatching '
        + 'again; starting a second agent would put two of them in one lane clone.',
    };
  }

  if (!launch) {
    return {
      ...base,
      inFlightRuns: [],
      agedOutRuns,
      dispatching: false,
      lane: null,
      sessionSlug: null,
      prompt: null,
      briefUnknownTokens: [],
      itemSpecPath: null,
      scope: [],
      dispatchedGuard: null,
      // The core's own word for why, or the honest "it was not in this tick's launch set at all" — which is
      // what a blocked, unscoped, lease-overlapped or not-cleared item looks like from here.
      holdReason: suppressed
        ? `suppressed by the in-flight build guard (${suppressed.by === 'lane' ? `lane ${suppressed.lane} is held` : 'an agent is already in flight for this item'})`
        : 'the tick core did not clear this item for dispatch — it is not in `decisions.spawnBuilds`, '
          + '`decisions.spawnPrepareScope`, `decisions.spawnPrepareDecision`, `decisions.spawnFixes` or '
          + '`decisions.spawnCiHeals`',
    };
  }

  if (launch.lane == null || String(launch.lane).trim() === '') {
    throw new Error(`dispatch-lane.read: the tick core cleared #${resolvedNum} but assigned it no lane — refusing to dispatch without one`);
  }
  const item = raw.item && typeof raw.item === 'object' ? raw.item : null;
  const specPath = String(item?.specPath || '').trim();
  const itemScope = Array.isArray(item?.scope) ? item.scope.map(String).filter(Boolean) : [];
  if (!specPath) {
    throw new Error(`dispatch-lane.read: no backlog file resolved for #${resolvedNum} — the brief needs the item's spec path`);
  }
  // THE LANE-LEASE SCOPE, and the word `scope` doing two jobs is what made this look like a blocker (#3165).
  //
  //   - a BUILD's (and, #3383, a FIX's / CI-HEAL's) lane scope is the item's own `scope:` FRONTMATTER — the
  //     paths a repair may touch is the same set a build was allowed to touch, since a fix/ci-heal repairs
  //     that PR in place;
  //   - a PREPARE's lane scope is `we:<specPath>`, the item's own backlog file. It is not a choice made here:
  //     `we:skills-src/conveyor/SKILL.md:272` says a prepare's `--scope` is "a single, distinct backlog file
  //     … disjoint by construction", and both prepare briefs already run exactly that `acquire`.
  //
  // A prepare agent is dispatched PRECISELY BECAUSE the item has no `scope:` — that is the thing it is being
  // sent to write. So the refusal below is ITEM-SCOPED-KINDS-ONLY and stays where it is, and the prepare
  // branch routes past it rather than around it being weakened.
  //
  // PINNED RESIDUAL: `prepare-decision-agent-brief.md:68-69`'s own `acquire` declares a WIDER scope than this
  // one file — it appends `we:src/_data/researchTopics.json` and `we:src/_includes/research-descriptions/`,
  // the `/research/` files a decision prepare authors. The brief is the thing that actually takes the lease,
  // so that is the scope the lane ends up holding; this value is what the run record says was declared. The
  // card (#3165) sets one rule for both prepare kinds, so this is recorded rather than silently widened.
  const itemScopedKind = ITEM_SCOPED_LAUNCH_KINDS.includes(launchKind);
  const scope = itemScopedKind ? itemScope : [`we:${specPath}`];
  if (itemScopedKind && !itemScope.length) {
    // Unreachable through the core for a BUILD (`dispatch-plan` holds an unscoped item `unshaped-no-scope` and
    // auto-prepares it, so it never reaches `spawnBuilds`) — refused anyway for every item-scoped kind, because
    // an empty `--scope` declares a lane that owns no paths and the scope-lease collector would let an
    // overlapping sibling launch beside it.
    throw new Error(`dispatch-lane.read: #${resolvedNum} has no \`scope:\` — the dispatcher never launches an unscoped item to ${launchKind}`);
  }

  // A FIX/CI-HEAL RECONSTITUTES FROM AN EXISTING PR (#3383), never from `main` — see `fix-agent-brief.md` /
  // `fix-agent-ci-brief.md`'s own step 1 ("reuse the ref — never rebuild from scratch"). Both facts the brief
  // needs to do that — WHICH PR, and WHICH REF to reconstitute onto — come off the core's own spawn row and the
  // io shell's PR-listing read respectively; neither is inventable here, so both are refused when absent rather
  // than guessed.
  const prRepairKind = PR_REPAIR_LAUNCH_KINDS.includes(launchKind);
  let prNum = null;
  let laneRef = null;
  let reason = null;
  if (prRepairKind) {
    prNum = String(launch.pr ?? '').trim();
    if (!prNum) {
      throw new Error(`dispatch-lane.read: the tick core cleared #${resolvedNum} for a ${launchKind} but named no PR — refusing to dispatch without one`);
    }
    laneRef = String(raw.prHeadRef ?? '').trim();
    if (!laneRef) {
      throw new Error(`dispatch-lane.read: no head ref resolved for PR #${prNum} — the ${launchKind} brief needs it to reconstitute onto`);
    }
    if (launchKind === 'ci-heal') {
      reason = String(launch.reason ?? '').trim();
      if (!reason) {
        throw new Error(`dispatch-lane.read: the tick core cleared PR #${prNum} for a ci-heal but named no reason — refusing to dispatch without one`);
      }
    }
  }

  const sessionSlug = sessionSlugFor(resolvedNum, launchKind);
  const placeholders = BRIEF_PLACEHOLDERS_BY_KIND[launchKind];
  // FILLED HERE, not in the sink. The prompt is a pure function of the item and the core's assignment, so it
  // belongs on the pure side — and freezing it into the effect payload means the run record says exactly what
  // was dispatched, which is what a restart needs and a sink-side fill would not give.
  const brief = fillBrief(String(raw.briefTemplate ?? ''), {
    ITEM_NUM: resolvedNum,
    LANE: launch.lane,
    SESSION_SLUG: sessionSlug,
    SCOPE: scope.join(','),
    // ITEM_SPEC_PATH for build/prepare kinds; PR_NUM + LANE_REF (+ REASON for ci-heal) for a PR-repair kind —
    // `placeholders` (the kind's own required set) decides which of these `fillBrief` actually looks for, so
    // handing it a superset it does not need for this kind is inert, not a defect.
    ITEM_SPEC_PATH: specPath,
    ...(prRepairKind ? { PR_NUM: prNum, LANE_REF: laneRef } : {}),
    ...(launchKind === 'ci-heal' ? { REASON: reason } : {}),
  }, placeholders);
  return {
    ...base,
    dispatching: true,
    lane: launch.lane,
    sessionSlug,
    itemSpecPath: specPath,
    // null for build/prepare — only a PR-repair kind targets an existing PR. Carried on the verdict (and so
    // onto the run record) the same way `itemSpecPath` is, for the same reason: a restart needs to see what
    // was actually dispatched, not re-derive it.
    pr: prRepairKind ? Number(prNum) : null,
    prHeadRef: prRepairKind ? laneRef : null,
    scope,
    holdReason: null,
    inFlightRuns: [],
    // The records this dispatch went PAST. They are still `in-flight` on disk and still need closing out; the
    // verdict says so rather than letting an aged-out guard disappear silently.
    agedOutRuns,
    prompt: brief.prompt,
    // REPORTED, never fatal — see `fillBrief`. Two of these are the brief's own prose today.
    briefUnknownTokens: brief.unknownTokens,
  };
}

/**
 * BUILD THE DECLARATION. `readTick` is the injected reader; {@link ./dispatch-lane-io.mjs} supplies the real
 * one and tests supply a stub. Built per call so nothing leaks between registries.
 *
 * @param {{readTick: (o: {num: string, bookkeepingFile: string}) => object}} deps
 * @returns {object} the frozen declaration from `op()`.
 */
export function dispatchLaneOperation({ readTick } = {}) {
  if (typeof readTick !== 'function') {
    throw new TypeError(
      'dispatch-lane: needs a `readTick({num, bookkeepingFile})` reader — the io is INJECTED so the declaration '
      + 'stays testable without a lane pool or a live queue; the real binding is `we:scripts/operations/dispatch-lane-io.mjs`.',
    );
  }

  return op(DISPATCH_LANE_OP, {
    declaresOver: DECLARED_HOMES['dispatch-lane'],
    input: {
      // A STRING, not a number: an item id may be a `xNNNNNN` JIT hash, and the shell's `normNum` is what turns
      // either spelling into one identity.
      num: 'string',
      // The conveyor's live guard bookkeeping — the SESSION-EPHEMERAL `{ buildGuards, watched, … }` the tick
      // threads from tick to tick (`we:skills-src/conveyor/SKILL.md` §5). Passed as a FILE because it is the
      // runner's process state, not repo state: no parallel on-disk store is created by this operation, it only
      // reads whatever the caller already has. Omitted → the read runs with no in-flight guards, which the
      // finding reports as `bookkeepingSource: 'none'`.
      bookkeepingFile: { type: 'string', required: false, default: '' },
      expectedWithinMinutes: { type: 'number', required: false, default: DEFAULT_EXPECTED_WITHIN_MINUTES },
    },
    verdictFrom: 'plan',

    // ── 1. read ─────────────────────────────────────────────────────────────────────────────────────────────
    // ONE tick read, already selected for this num by the shell, shaped and turned into a filled brief.
    read: compute({
      reads: ['input.num', 'input.bookkeepingFile', 'input.expectedWithinMinutes'],
      fn: (view) => shapeDispatchRead(
        readTick({ num: view.input.num, bookkeepingFile: view.input.bookkeepingFile }),
        { num: view.input.num, expectedWithinMinutes: view.input.expectedWithinMinutes },
      ),
    }),

    // ── 2. plan ─────────────────────────────────────────────────────────────────────────────────────────────
    // THE VERDICT, and it decides nothing: it restates what the tick core already decided, in the one shape the
    // effect step and every derived caller read. A non-dispatch is a first-class outcome here, not an error —
    // "the guard says an agent is already in flight" is the normal answer on most ticks.
    plan: compute({
      reads: ['findings.read'],
      fn: (view) => {
        const read = view.findings.read;
        const agedOut = Array.isArray(read.agedOutRuns) ? read.agedOutRuns : [];
        return {
          dispatching: read.dispatching === true,
          num: read.num,
          // WHICH AGENT WAS STARTED, beside the fact that one was (#3165). Without it a run record of a
          // prepare dispatch and one of a build are indistinguishable, and they are not the same event: they
          // run different briefs, take different lane scopes and are retired by different session slugs.
          launchKind: read.launchKind,
          lane: read.lane,
          sessionSlug: read.sessionSlug,
          reason: read.dispatching
            ? `cleared for ${read.launchKind} on lane ${read.lane}`
              + (agedOut.length
                ? ` (past ${agedOut.length} aged-out in-flight dispatch record(s): ${agedOut.map((r) => r.runId).join(', ')} — `
                  + 'each is still open on disk and still needs closing out)'
                : '')
            : read.holdReason,
          // THE GUARD'S OWN HONESTY, all three parts on the verdict where the decision is read:
          //   - `unreadableRunRecords` — how many run records the double-dispatch guard could not read at all;
          //   - `agedOutDispatches` — which in-flight records it deliberately dispatched past;
          //   - `dispatchLiveness` — whether those releases were decided on a real session listing or on the
          //     clock backstop, which is the difference between the strong guard and the weak one (G1).
          // Any one of them silently zeroed would make a partial guard look like a complete one.
          unreadableRunRecords: Number(read.unreadableRunRecords) || 0,
          agedOutDispatches: agedOut.map((r) => String(r.runId)),
          dispatchLiveness: read.dispatchLiveness,
          // SURFACED ON THE VERDICT, not buried in the read finding: a dispatch decided without the caller's
          // in-flight guards is weaker than one decided with them, and whoever reads the verdict is exactly who
          // needs to know that. `droppedBookkeeping` is here for the same reason — a setting the caller passed
          // and this run did not honour belongs where the decision is read, not in a comment.
          guardsFrom: read.bookkeepingSource,
          droppedBookkeeping: read.droppedBookkeeping,
          statusLine: read.statusLine,
        };
      },
    }),

    // ── 3. dispatch ─────────────────────────────────────────────────────────────────────────────────────────
    // DECLARES the start and performs none of it. One effect or zero — never two, because a lane holds one
    // agent and the whole guard apparatus exists to keep it that way.
    dispatch: effectStep({
      reads: ['verdict', 'findings.read'],
      effects: (view) => {
        const verdict = view.verdict || {};
        // THE NON-DISPATCH EXIT. Zero effects, which the engine resolves in the same `advance` rather than
        // suspending — so a tick where the guard holds every item completes the run instead of parking it.
        if (!verdict.dispatching) return [];

        const read = view.findings.read;
        return [{
          type: DISPATCH_EFFECT,
          // DISPATCH: TRUE — the declaration says so BEFORE the sink runs (#3073). The executor writes
          // `in-flight` first, so a process killed between starting the agent and hearing its handle back lands
          // in `inFlightEntries().unknown` (visible, closable through `resolveInFlight`) rather than in
          // `pending`, where it would look like an ordinary unknown outcome and be invisible to both.
          dispatch: true,
          // IDEMPOTENT: FALSE, and this is the flag that matters most in this file. Re-applying it starts a
          // SECOND delivery agent on the same lane — two agents in one clone, racing on one working tree, both
          // opening a PR for one item. So an attempt whose outcome is unknown must stop and ask a person. The
          // cost of the fail-closed answer is a stalled run; the cost of the other is a corrupted lane.
          idempotent: false,
          payload: {
            num: read.num,
            launchKind: read.launchKind,
            lane: read.lane,
            sessionSlug: read.sessionSlug,
            itemSpecPath: read.itemSpecPath,
            scope: read.scope,
            // The filled brief, verbatim. It is what the agent is told, so a run record read after a restart
            // says exactly what was dispatched rather than "a brief was filled from a template that has since
            // been edited".
            prompt: read.prompt,
            expectedWithinMinutes: read.expectedWithinMinutes,
          },
        }];
      },
    }),
  });
}
