#!/usr/bin/env node
/**
 * @file scripts/operations/review-dispatch.mjs
 * @description `#3279` — DISPATCH AN INDEPENDENT REVIEW OF A PR TO A FRESH SESSION.
 *
 *   node scripts/operations/review-dispatch.mjs --pr=1234 --repo=chalbert/web-everything
 *
 * THE GAP THIS CLOSES, PRECISELY. `review-pr` (via `we:scripts/operations/review-loop-cli.mjs`, #3072) already
 * runs a review UNATTENDED end to end — spawn two independent jurors, reduce their verdicts, bounce a `changes`
 * automatically, and QUEUE (never auto-record) an `accept`. But `we:scripts/lib/review-independence.mjs`'s
 * self-clear refusal keys on `CLAUDE_CODE_SESSION_ID`, and A SUBAGENT INHERITS ITS PARENT'S VALUE — so running
 * `review-loop-cli.mjs` as a subagent of the very session that opened the PR is still, as far as that refusal
 * is concerned, the SAME actor reviewing its own diff. `review-pr`'s own `read` step refuses that outright, for
 * ANY eventual verdict, not only an accept (see `shapeReadFinding`'s self-clear throw in `review-pr.mjs`) — so
 * the review cannot even BOUNCE from inside the authoring session, let alone accept. Something has to start a
 * session that is not that one. `we:scripts/operations/dispatch-lane.mjs` is the existing precedent for "start a
 * genuinely independent session" but is shaped for the conveyor's OWN tick core (`--num` resolves an item out
 * of `planTick`'s launch lists; it has no notion of "review this PR" and never takes a lane directly) — so it
 * cannot serve this, and nothing else declares the review-side equivalent. This file is that equivalent.
 *
 * WHY A PLAIN MODULE, NOT THE DECLARATIVE `op()` ENGINE (`we:scripts/operations/dispatch-lane.mjs`'s shape).
 * `dispatch-lane.mjs` earns its three declared steps (`read` / `plan` / `dispatch`) and its own effect type
 * because it is consumed BY the tick core's own bookkeeping loop: its `dispatch: true` effect rides the
 * `effect-executor.mjs` in-flight ledger the conveyor's waker (`wake.mjs`) polls, its guard reads the CALLER'S
 * OWN in-flight dispatch records to prevent a double-dispatch onto one lane, and its run record is what the
 * tick's own health-stall scan reverse-derives lane→item from. NONE of that applies here: this operation is not
 * part of the tick loop (this task's own instructions are explicit that wiring it into `we:skills-src/conveyor/
 * runner.mjs` / `we:scripts/conveyor/reconcile-pass.mjs` is separate, later work), it dispatches at most once
 * per invocation with no bookkeeping to guard against a sibling call, and its own session acquires its OWN lane
 * rather than being handed one by a tick plan. Declaring three steps and a run record for that would be
 * machinery with nothing to consume it — the same call `we:scripts/operations/dispatch-abort.mjs` already made
 * for a comparably-scoped, standalone dispatch action, and the one this file follows.
 *
 * WHAT ACTUALLY MAKES THE SPAWNED SESSION INDEPENDENT. Not a derived id, not an env-var override on this
 * process — a genuinely SEPARATE OS process started by `claude --bg`
 * (`we:scripts/operations/dispatch-lane-io.mjs#defaultSpawnAgent` / `#buildAgentArgv`, reused verbatim rather
 * than re-implemented), which gets a fresh session identity of its own and does NOT adopt an inherited
 * `CLAUDE_CODE_SESSION_ID`. That separateness is the whole property needed — "not the author's" — and it comes
 * from the spawn, not from any id this file chooses.
 *
 * CORRECTED 2026-09-11 (#3331). This paragraph used to say the independence came from "a BRAND NEW random
 * UUID, minted here and handed to `claude --bg --session-id=<uuid>` … supplying `--session-id` makes the
 * spawned session's identity exactly that value, deterministically". `claude --bg` DISCARDS `--session-id` and
 * assigns its own, so that sentence described a mechanism that was not running. The CONCLUSION was never in
 * danger — a `--bg` spawn is independent whoever names it — but the id this file then REPORTED belonged to no
 * session, which is a real defect and is fixed in `dispatchReview` below. The `we:scripts/lib/judge-spawn.mjs`
 * comparison the old text drew is NOT affected: jurors spawn with `claude -p`, and `-p` honours `--session-id`.
 *
 * WHAT THIS FILE DOES NOT DO. It does not run the review itself (that is `review-loop-cli.mjs`, which the
 * dispatched session runs FOR ITSELF, inside its own freshly-minted session — see the brief). It does not
 * acquire a lane (the dispatched session acquires its own, per the brief's own first step — this operation
 * would otherwise be leasing a resource whose release it cannot guarantee, the same reasoning
 * `dispatch-lane.mjs`'s own header gives for never acquiring on a delivery agent's behalf). It does not decide
 * WHETHER a review is owed for a PR — that is `we:scripts/conveyor/reconcile-core.mjs`'s `DISPATCH_KINDS`
 * decision (#3296, already landed); this file is what that decision calls, once something wires the two
 * together — which, per this item's own scope, is separate, later work.
 *
 * A CALLER STILL HOLDING ITS OWN BUILD LANE FOR THE SAME PR SHOULD RELEASE IT FIRST (#x3jmao3, soft doctrine,
 * not enforced here). Live-caught 2026-09-04: an ad hoc session dispatched a review for the PR it had just
 * landed WITHOUT releasing the lane it built that PR in — the dispatched session's own `lane-pool.mjs acquire`
 * (brief step 1) read the pool as fully held/dirty and gave up, because the caller's still-leased lane was one
 * unit of that pressure. `lane-pool.mjs acquire --wait-ms=<N>` (the brief's step 1 now passes it) is the
 * PRIMARY fix — it makes that acquire tolerant of a momentary full pool regardless of what any one caller
 * does — but releasing an unrelated lane before dispatching a review still costs the caller nothing and
 * removes one more unit of pool pressure at exactly the moment a fresh lane is needed.
 *
 * IMPURE: reads the brief template off disk, mints a UUID, and spawns one `claude --bg` process — through
 * INJECTED handles (mirroring `we:scripts/operations/dispatch-abort.mjs` and `dispatch-lane-io.mjs`), so the
 * whole thing is testable with no real subprocess and no real session.
 *
 * WHAT THIS FILE DOES NOT CLOSE, STATED PLAINLY (an independent review of PR #1756, security lens, CONFIRMED
 * this — the #2895 discipline: a residual left silent is worse than one left open). CORRECTED 2026-09-01
 * (`#3434`): `review-loop-policy.mjs#reviewLoopAutoConfirm` no longer refuses `accept` for the agent-addressed
 * (`review:pending`) tier — a genuinely independent clean verdict clears mechanically now, by design, THROUGH
 * `review-loop-cli.mjs`. The residual risk this paragraph names is narrower than it used to read: not "bypass
 * the never-self-accept refusal" (there is no such refusal left to bypass on `review:pending`), but "skip the
 * judging entirely" — nothing in `dispatchReview` technically restricts its tools, so a prompt-injection
 * payload embedded in the very PR it is reviewing could in principle talk it into running
 * `review-pr --answer=accept` directly WITHOUT the two independent jurors ever running, forging the SAME
 * outcome the mechanical path produces honestly. `review:human`'s own refusal is UNCHANGED by `#3434` and
 * still fully real — this residual is `review:pending`-only. `caller` here means a Bash-capable session
 * persuaded to run a different command instead — the same trust boundary
 * `we:scripts/lib/review-independence.mjs`'s own header names for `CLAUDE_CODE_SESSION_ID` ("not an unforgeable
 * actor signal … #2895 ruled that deferred"). Filed as its own item rather than solved here or left unfiled:
 * `we:backlog/xf38r2m-technically-enforce-review-dispatch-s-never-self-accept-neve.md`.
 *
 * NARROWED AND TECHNICALLY BACKED, 2026-09-02 (`#3433`, re-scoped by `#3434` to `review:human`'s never-
 * self-accept and never-merge — `review:pending`'s auto-clear is the ratified mechanism working as intended,
 * not a bypass to harden against). `dispatchReview` now bakes a `--disallowedTools` deny list
 * ({@link REVIEW_DISPATCH_DISALLOWED_TOOLS}) into EVERY spawned review session's own `claude` argv — a
 * harness-enforced refusal the model's own judgment is never consulted on, closer to what "restricted
 * tool/permission default" (this item's own words) means than prose alone. It denies `gh` OUTRIGHT (the r1
 * self-review below is why: an earlier draft denied only `gh pr merge`, and `gh pr edit --add-label
 * review:accepted --remove-label review:human` turned out to be the same self-clear one un-denied `gh` call
 * away), plus every script that can reach the `--to=clear-human` ceremony (`review-set-label.mjs` directly,
 * `apply-review-request.mjs`'s cloud-VM path, `run.mjs record-verdict`'s staging path) — none of which
 * `review-agent-brief.md`'s own sanctioned arc (lane-pool acquire → `review-loop-cli.mjs` → lane-pool release)
 * ever calls, so nothing legitimate is lost. STILL NOT A SANDBOX: a `Bash(<prefix>:*)` rule matches the
 * LITERAL command string the harness sees, so a sufficiently adversarial rewrite (`bash -c '...'`, a
 * relative-path indirection) is not caught by this alone — see {@link REVIEW_DISPATCH_DISALLOWED_TOOLS}'s own
 * header for what this narrows the residual to.
 *
 * R1 SELF-REVIEW (#3433, this item's own step-6 adversarial pass, CONFIRMED then fixed before the PR opened):
 * the first draft's deny list read `Bash(gh pr merge:*)` — literal-prefix-correct, but far too narrow. The
 * reviewer found `gh pr edit --add-label review:accepted --remove-label review:human` (a label flip, no merge
 * verb at all) reaches the exact same outcome as the `--to=clear-human` ceremony this file already denies three
 * scripts over, and `gh api`'s raw PUT-a-pull-request-merge-endpoint form reaches the same outcome as
 * `gh pr merge` under a different verb. Both are closed now by denying `gh` wholesale rather than by naming
 * merge/label/api shapes
 * one at a time — see {@link REVIEW_DISPATCH_DISALLOWED_TOOLS}'s own header for why enumerating GitHub-mutation
 * shapes individually is the game this file was already losing.
 */

import { repoKeyForSlug, CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { repoProfile } from '../lib/repo-profile.mjs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  agentArgsFromEnv, assertNotALaneCheckout, buildAgentArgv, defaultSpawnAgent, parseBackgroundedId, REPO_ROOT,
  resolveGhShimSettingsEnv,
} from './dispatch-lane-io.mjs';
// #xqa9ttq — the single source of truth for the `claude`/`codex` juror-provider enum, shared with
// `we:scripts/operations/cli-adapter.mjs`'s own `--provider` flag so this dispatch's `--judge-provider`
// cannot silently drift out of step with what `review-loop-cli.mjs` (which the dispatched session runs)
// actually accepts.
import { JUDGE_PROVIDER_NAMES } from './cli-adapter.mjs';

/** The review-side twin of `we:scripts/operations/dispatch-lane-io.mjs#DISPATCHED_AGENT_SYSTEM_PROMPT_FILE`
 *  (`#xy8di3v`, extending `#3418`/`#xqyyoje`'s fix to the review-dispatch path). Passed via
 *  `--append-system-prompt-file` on every dispatched review session so its "this prompt is real, not a
 *  template" identity is a harness-level fact present BEFORE the per-PR brief is even read, rather than prose
 *  competing with a brief whose own "Fill these before spawning" table can read as unfilled post-substitution
 *  (live-confirmed 2026-09-07: review-1998/2024/2027 each self-aborted a genuinely-instantiated brief on
 *  exactly this confusion — see `we:backlog/3606-*.md`). A review-specific file, not a reuse of the
 *  delivery-side one verbatim, because that file names `we:scripts/operations/dispatch-lane.mjs` as the
 *  starting operation and talks about a lane id/backlog file path a review dispatch does not carry the same
 *  way — wrong specifics would be its own new confusion. */
export const REVIEW_DISPATCH_SYSTEM_PROMPT_FILE = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills-src', 'review', 'review-agent-system-prompt.md',
);
import { assertMainNotStale } from '../lib/main-staleness.mjs';
// #3875 — re-exported so this file's own two existing importers (this module's own `dispatchReview` below,
// and we:scripts/conveyor/reconcile-fix-dispatch.mjs) need no import change: the implementation moved to
// we:scripts/lib/main-staleness.mjs (a pure lib, importable by a future daemon with no dependency on this
// whole review-dispatch module), byte-identical default behavior (same wording, same `label`).
export { assertMainNotStale } from '../lib/main-staleness.mjs';
import { writeAllSync, writeLineSync } from '../lib/write-all-sync.mjs';
import { reviewSessionSlug } from '../conveyor/review-session-slug.mjs';

// re-exported so nothing that already imports `reviewSessionSlug` from this file has to change (#3437) — the
// slug itself now lives in `we:scripts/conveyor/review-session-slug.mjs`, a PURE module both this file and
// `we:scripts/conveyor/reconcile-core.mjs` import, so the pure reconciler never pulls in this file's impure
// transitive imports (`node:child_process`/`node:crypto`/`node:fs`, via `dispatch-lane-io.mjs`).
export { reviewSessionSlug };

/** The template `we:skills-src/review/review-agent-brief.md` — read once per dispatch, never cached across
 *  calls, so an edited brief takes effect on the very next dispatch with no process restart. */
export function reviewBriefPath(root = REPO_ROOT) {
  return join(root, 'skills-src', 'review', 'review-agent-brief.md');
}

/** The `{{PLACEHOLDER}}` tokens the review brief declares. Mirrors `we:scripts/operations/
 *  dispatch-lane.mjs#BRIEF_PLACEHOLDERS`'s NAMING convention (a small, closed, named list) without importing
 *  that file's machinery — see the file header for why this operation owns its own, smaller copy.
 *  `JUDGE_PROVIDER` (#xqa9ttq) is ALWAYS filled, even when nobody asked for anything but the default: see
 *  `dispatchReview`'s own `judgeProvider = 'claude'` default — never blank, so `fillReviewBrief`'s
 *  every-declared-placeholder-must-have-a-value refusal never fires for the ordinary, opt-out case. */
export const REVIEW_BRIEF_PLACEHOLDERS = Object.freeze(['PR', 'REPO', 'SESSION_SLUG', 'JUDGE_PROVIDER', 'LANE_REPO']);

/** #xqa9ttq (PR #2115 review, CONFIRMED) - judge providers that are TOOL-FREE ONLY (#3581) and so can never serve review-pr's judge steps, every one of which is tool-bearing (REVIEW_JUROR_TOOLS, by ratified design). */
export const TOOL_FREE_ONLY_JUDGE_PROVIDERS = Object.freeze(['codex']);

/** Any run of separators a placeholder name might be typo'd with, canonicalized — same shape as `dispatch-
 *  lane.mjs#canonicalPlaceholder`, scoped to this brief's own three names. */
export function canonicalReviewPlaceholder(name) {
  const norm = String(name ?? '').trim().replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  return REVIEW_BRIEF_PLACEHOLDERS.includes(norm) ? norm : null;
}

/** A placeholder token, in ANY spelling (whitespace/case/separator variants) — the same detection width
 *  `dispatch-lane.mjs#BRIEF_TOKEN_RE` uses, and for the identical reason: a near-miss spelling must be
 *  CAUGHT, not silently invisible to the scan that looks for it. */
const REVIEW_BRIEF_TOKEN_RE = /\{\{\s*([^{}\n]*?)\s*\}\}/g;

/**
 * BASH DENY LIST baked into every dispatched review session's own `claude` invocation (#3433). Prefix-match
 * rules, in this repo's own `Bash(<prefix>:*)` convention (`we:.claude/settings.json`'s
 * `Bash(node scripts/backlog.mjs:*)` is the same shape) — the harness refuses a matching command BEFORE the
 * model's own judgment is consulted, so a prompt-injection payload in the reviewed diff cannot talk the session
 * into it merely by asking.
 *
 * THE FOUR, AND WHY EXACTLY THESE FOUR. `review-agent-brief.md`'s own sanctioned arc never calls any of them —
 * one `lane-pool.mjs acquire`, one `review-loop-cli.mjs`, one `lane-pool.mjs release` — so denying all four
 * costs a well-behaved dispatch nothing:
 *   • `gh` — THE WHOLE CLI, not just `gh pr merge`. An adversarial review (`#3433` r1) found that denying only
 *     `gh pr merge` still left `gh pr edit --add-label review:accepted --remove-label review:human` reachable —
 *     the exact same self-clear the `review-set-label.mjs` deny below exists to stop, just one `gh` call away
 *     with no script involved at all — and `gh api`'s raw PUT-a-pull-request-merge-endpoint form reachable as
 *     an un-prefixed merge. The sanctioned arc never calls `gh` directly (whatever it needs from GitHub happens INSIDE
 *     `review-loop-cli.mjs`'s own subprocess, never as a fresh top-level Bash-tool command), so there is no
 *     narrower `gh ...` prefix worth carving out — the whole CLI is denied.
 *   • `review-set-label.mjs` — the #2895 SINGLE HOME the `--to=clear-human` ceremony actually writes through.
 *     `review-loop-cli.mjs` never shells this directly for a dispatched review (its own auto-clear path for
 *     `review:pending` is a DIFFERENT, already-independence-checked route) — a dispatched session invoking it
 *     by hand has no legitimate reason to.
 *   • `apply-review-request.mjs` — the cloud-VM applier. Its `clear-human` guard is a NAMED field
 *     (`operatorInstruction`), not a verified one — any Bash-capable actor can populate it with a fabricated
 *     "operator instruction" and a self-authored request.json. Denied outright.
 *   • `run.mjs` (the whole operations CLI, not just `record-verdict`) — `record-verdict --to=clear-human`
 *     stages exactly the same ceremony for `apply-review-request.mjs` to later apply, and the dispatched
 *     session's brief never calls `run.mjs` for anything at all, so the broader deny costs nothing and closes
 *     the door on whatever OTHER operation might reach the ceremony later.
 *
 * NOT A SANDBOX — see the file header's own note on what a literal-prefix rule does and does not catch. This is
 * why `gh` is denied WHOLESALE rather than pattern-by-pattern against every mutation it can perform (a label
 * edit, a merge, a review submission) — enumerating GitHub-mutation shapes one at a time is exactly the game
 * the r1 finding proved this file was already losing.
 */
export const REVIEW_DISPATCH_DISALLOWED_TOOLS = Object.freeze([
  'Bash(gh:*)',
  'Bash(node scripts/review-set-label.mjs:*)',
  'Bash(node scripts/apply-review-request.mjs:*)',
  'Bash(node scripts/operations/run.mjs:*)',
]);

/**
 * The `--disallowedTools=<patterns>` argv element for {@link REVIEW_DISPATCH_DISALLOWED_TOOLS} — ONE `=`-joined
 * string, never `['--disallowedTools', '<value>']` as two separate elements. `--disallowedTools` is documented
 * (`claude --help`) as `<tools...>`, a VARIADIC option: `claude`'s commander-style parser keeps consuming
 * subsequent non-flag argv tokens as MORE tool patterns, not just the one immediately after the flag — so a
 * two-element `['--disallowedTools', joined]` form still swallows the prompt that `buildAgentArgv` appends
 * right after it (its own header already warns the prompt's position guarantees nothing; this is that hazard,
 * hit for real).
 *
 * R2 SELF-REVIEW (#3433, CONFIRMED then fixed before the PR opened): an earlier draft of THIS function shipped
 * the two-element form on the theory that "one flag, one already-joined value" was safe from variadic
 * swallowing. It was not — the parser does not care how many logical values are packed into the token after
 * the flag, only how many SEPARATE argv elements follow it, and two elements is still two. Verified empirically
 * against the real `claude` binary (local-only, no PR, no `gh`, cleaned up after): the two-element form started
 * a session with the prompt silently swallowed as bogus deny patterns ("Permission deny rule 'hello' matches no
 * known tool") and NOTHING to review; the single `=`-joined element correctly preserved the prompt. A regression
 * back to the two-element form does not fail loud — it silently no-ops every dispatched review — so the r2 test
 * below asserts the argv shape directly, not just its stringified contents.
 */
export function reviewDispatchDisallowedToolsArgs() {
  return [`--disallowedTools=${REVIEW_DISPATCH_DISALLOWED_TOOLS.join(',')}`];
}

/** What a placeholder VALUE may safely contain — an id, a repo-qualified path, an `owner/repo` slug, a lane
 *  session slug. Deliberately the same narrow allowlist `dispatch-lane.mjs#BRIEF_VALUE_RE` uses: these values
 *  are pasted UNQUOTED into shell commands the dispatched agent is told to run. */
export const REVIEW_BRIEF_VALUE_RE = /^[A-Za-z0-9_.,:/@#-]+$/;

/**
 * FILL the review brief. PURE. Same three refusals as `dispatch-lane.mjs#fillBrief`, scoped to this brief's own
 * placeholders — see that function's own header for the full reasoning (a missing/blank/unsafe value refuses;
 * a MISSPELLED placeholder refuses, because nothing would substitute it and the dispatched agent would run the
 * literal token; an UNKNOWN token — one that names none of the three — is reported, never fatal, because this
 * brief's own prose legitimately contains bracketed examples that are not meant to be filled).
 *
 * @param {string} template
 * @param {{PR: string|number, REPO: string, SESSION_SLUG: string}} values
 * @returns {{prompt: string, unknownTokens: string[]}}
 */
export function fillReviewBrief(template, values = {}) {
  const text = String(template ?? '');
  if (!text.trim()) {
    throw new Error('review-dispatch: the review-agent brief template is empty — refusing to dispatch an agent with no instructions');
  }
  for (const name of REVIEW_BRIEF_PLACEHOLDERS) {
    const value = values[name];
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new Error(`review-dispatch: no value for the brief placeholder {{${name}}} — refusing to fill it with nothing`);
    }
    if (!REVIEW_BRIEF_VALUE_RE.test(String(value))) {
      throw new Error(
        `review-dispatch: the value for {{${name}}} (${JSON.stringify(String(value))}) has characters the brief `
        + 'cannot carry safely — it is pasted UNQUOTED into a shell command the agent is told to run. Refusing.',
      );
    }
  }
  const unknown = new Set();
  const misspelled = new Set();
  const prompt = text.replace(REVIEW_BRIEF_TOKEN_RE, (whole, name) => {
    if (whole === `{{${name}}}` && REVIEW_BRIEF_PLACEHOLDERS.includes(name)) return String(values[name]);
    const canonical = canonicalReviewPlaceholder(name);
    if (canonical) { misspelled.add(`${whole} (meaning {{${canonical}}})`); return whole; }
    unknown.add(whole);
    return whole;
  });
  if (misspelled.size) {
    throw new Error(
      `review-dispatch: the brief carries a MISSPELLED placeholder — ${[...misspelled].sort().join(', ')}. No `
      + 'substitution reaches it, so the dispatched agent would run the token verbatim. Refusing to dispatch. '
      + `Spell it exactly as one of ${REVIEW_BRIEF_PLACEHOLDERS.map((n) => `{{${n}}}`).join(', ')}.`,
    );
  }
  return { prompt, unknownTokens: [...unknown].sort() };
}

// #3875 — `assertMainNotStale` (the #3439/#3474/#3637 dispatch-chokepoint staleness guard) and its
// `staleRemedy` tail MOVED to we:scripts/lib/main-staleness.mjs — a pure lib a future daemon can import
// with no dependency on this whole review-dispatch module — and are re-exported above, byte-identical
// default behavior. Read the guard's full history/design there, not here. Both of this guard's callers
// (this file's `dispatchReview` below, and we:scripts/conveyor/reconcile-fix-dispatch.mjs) are unchanged.

/**
 * Shape one dispatch request and verify the selected checkout before filling or spawning.
 *
 * @param {{pr: number|string, repo: string}} o
 * @returns {{pr: number, repo: string, sessionSlug: string}}
 */
export function planReviewDispatch({ pr, repo, checkoutExists = existsSync, home = homedir() } = {}) {
  const prNum = Number(pr);
  if (!Number.isInteger(prNum) || prNum <= 0) {
    throw new Error(`review-dispatch: --pr must be a positive integer, got ${JSON.stringify(pr)}`);
  }
  const repoStr = String(repo ?? '').trim();
  const repoKey = repoKeyForSlug(repoStr);
  if (repoKey === null) throw new Error(`review-dispatch: --repo ${repoStr} is not a constellation repo`);
  const laneRepo = repoProfile(repoKey, { home }).lanePoolRepo;
  if (repoKey !== 'we' && !checkoutExists(laneRepo)) {
    throw new Error(`unsupported-repo: ${repoKey} checkout does not exist at ${laneRepo}`);
  }
  return { pr: prNum, repo: CONSTELLATION_REPOS[repoKey].slug, repoKey, laneRepo, sessionSlug: reviewSessionSlug(prNum, repoKey) };
}

/**
 * DISPATCH ONE INDEPENDENT REVIEW SESSION. The composition: plan → fill the brief → mint a fresh session id →
 * spawn. Mirrors `we:scripts/operations/dispatch-lane-io.mjs#createDispatchSinks`'s own composition closely —
 * same `assertNotALaneCheckout` guard (a dispatcher run FROM a lane clone would hand the dispatched agent a
 * confusing root, and could not itself be released the way a lane can), same "the handle is minted, not
 * discovered" reasoning for why `sessionId` is chosen here rather than read back from a listing afterward.
 *
 * @param {object} o
 * @param {number|string} o.pr
 * @param {string} o.repo
 * @param {string} [o.root] - the cwd the dispatched session starts in (never a lane — it acquires its own).
 * @param {(root?: string) => string} [o.readBrief] - injectable brief-template reader.
 * @param {() => string} [o.mintSessionId] - injectable UUID minter.
 * @param {Function} [o.spawnAgent] - injectable `(argv, opts) => stdout`; the default shells `claude`.
 * @param {string[]} [o.extraArgs] - forwarded to `buildAgentArgv`, exactly like `dispatch-lane-io.mjs`'s own.
 * @param {(root: string) => ReturnType<typeof checkMainStaleness>} [o.checkStaleness] - injectable staleness
 *   check (#3439) — see `assertMainNotStale`.
 * @param {string} [o.judgeProvider] - #xqa9ttq — which `JudgeProvider` the dispatched session's OWN
 *   `review-loop-cli.mjs` invocation (brief step 2) is told to pass `--provider=<this>`. One of
 *   `JUDGE_PROVIDER_NAMES`; defaults to `'claude'`, today's behaviour, unchanged — this is OPT-IN. Note what
 *   this does NOT do: it never makes the DISPATCHED SESSION ITSELF (a tool-bearing `claude --bg` agent) run on
 *   Codex — only the TOOL-FREE judge steps `review-loop-cli.mjs` could spawn underneath it would ever be
 *   eligible (#3581: Codex is tool-free-only). `codex` is now REFUSED here before anything is read or spawned
 *   (see {@link TOOL_FREE_ONLY_JUDGE_PROVIDERS}), as review-pr's real judge steps are tool-bearing and would be
 *   refused at the first judge step. `claude` is the only accepted value today.
 * @returns {{sessionId: string, sessionSlug: string, pr: number, repo: string, prompt: string, unknownTokens: string[]}}
 */
export function dispatchReview({
  pr, repo, root = REPO_ROOT,
  readBrief = (r) => readFileSync(reviewBriefPath(r), 'utf8'),
  mintSessionId = () => randomUUID(),
  spawnAgent = defaultSpawnAgent,
  extraArgs = [],
  checkStaleness,
  judgeProvider = 'claude',
  checkoutExists = existsSync, home = homedir(),
  // #x8mpubm follow-up (live-caught 2026-09-24, review-2591/2593/2600/2599/2594/2582) — THIS FUNCTION NEVER
  // WIRED THE GH-APP-SHIM AT ALL. `dispatch-lane-io.mjs#createDispatchSinks` resolves it for the conveyor's
  // OWN build-dispatch effect, but `dispatchReview` builds its own `buildAgentArgv` call directly and never
  // referenced `settingsEnv` — so no review session ever got `--settings`, and (after the earlier follow-up)
  // no review session ever got `<root>/.claude/settings.local.json` either. Every review 401 traced back to
  // this: the shim was simply never on `PATH`, at all, for any review dispatch, since before this fix
  // existed. NEVER throws — see `resolveGhShimSettingsEnv`'s own contract.
  resolveSettingsEnv = resolveGhShimSettingsEnv,
} = {}) {
  const planned = planReviewDispatch({ pr, repo, checkoutExists, home });
  assertNotALaneCheckout(root);
  // #3439 — refuse (not silently spawn) when this checkout is behind origin/main: see `assertMainNotStale`.
  // `checkStaleness` undefined here falls straight through to that function's own default — no need to
  // duplicate it.
  assertMainNotStale(root, checkStaleness);
  // #xqa9ttq — validated HERE, before the brief is ever filled: an unrecognised name would otherwise reach
  // `review-loop-cli.mjs`'s own `--provider` parse INSIDE the dispatched session, where the refusal happens
  // minutes into a real dispatch instead of at the command line that requested it.
  if (!JUDGE_PROVIDER_NAMES.includes(judgeProvider)) {
    throw new Error(`review-dispatch: \`judgeProvider\` must be one of ${JUDGE_PROVIDER_NAMES.join('|')}, got ${JSON.stringify(judgeProvider)}`);
  }
  if (TOOL_FREE_ONLY_JUDGE_PROVIDERS.includes(judgeProvider)) {
    throw new Error(
      `review-dispatch: \`judgeProvider: ${JSON.stringify(judgeProvider)}\` is refused - it is a TOOL-FREE-only provider (#3581) and every judge step review-pr runs is tool-bearing, `
      + 'so a dispatched review would be refused at its first judge step. Use the default `claude`. '
      + 'A tool-free Codex seat is a per-request pin inside the review-pr declaration, not a dispatch-wide flag. '
      + 'Opt in with REVIEW_PR_CODEX_ADVISORY=1 in the environment instead.',
    );
  }
  const { prompt, unknownTokens } = fillReviewBrief(readBrief(root), {
    PR: planned.pr, REPO: planned.repo, LANE_REPO: planned.laneRepo, SESSION_SLUG: planned.sessionSlug, JUDGE_PROVIDER: judgeProvider,
  });
  const sessionId = String(mintSessionId());
  // #xw3k2v9 — REVIEW FINDING (PR #1756 r1): `extraArgs` was destructured and documented as "forwarded to
  // buildAgentArgv, exactly like dispatch-lane-io.mjs's own" but the call below never referenced it — every
  // caller-supplied flag (a `--permission-mode`, a `--model` override) was silently dropped. Fixed by actually
  // passing it through, matching `we:scripts/operations/dispatch-lane-io.mjs#createDispatchSinks`'s own call.
  // #3433 — the mandatory deny list comes FIRST, ahead of any caller-supplied `extraArgs`: it is baked into
  // every dispatch regardless of what an operator's WE_DISPATCH_AGENT_ARGS sets, not something a caller opts
  // into. See `REVIEW_DISPATCH_DISALLOWED_TOOLS`'s own header for what it denies and why.
  const argv = buildAgentArgv({
    sessionId,
    payload: { prompt, sessionSlug: planned.sessionSlug },
    systemPromptFile: REVIEW_DISPATCH_SYSTEM_PROMPT_FILE,
    extraArgs: [...reviewDispatchDisallowedToolsArgs(), ...extraArgs],
    // #x8mpubm follow-up — resolved once, here, for this FRESH dispatch, mirroring
    // `reconcile-fix-dispatch.mjs`'s own call exactly. `root` is threaded through so the durable
    // `.claude/settings.local.json` delivery (`gh-app-shim.mjs#ensureSettingsFileEnv`) writes into the SAME
    // checkout this dispatched review session actually starts in.
    settingsEnv: resolveSettingsEnv(root),
  });
  // #3331 — THE HANDLE COMES BACK OFF STDOUT, it is not the uuid minted above. `claude --bg` DISCARDS
  // `--session-id` (it says so on stderr; measured 3/3 at CLI 2.1.246 by #3331's probe and 2/2 at 2.1.269 with
  // this exact argv) and assigns its own id, which it prints as `backgrounded · <id> · <name>`. Reporting the
  // minted uuid instead is what made a WORKING dispatch look like a silent failure: `claude agents --json |
  // grep <that uuid>` is always empty and no transcript exists under it, so every operator who checked
  // concluded no session had started — while the real session (findable by its `-n` slug) was running the
  // review to completion. `agentId` is the id that actually addresses it; `sessionId` is kept on the result
  // only so an existing caller reading that field still gets the old, documented shape.
  const stdout = String(spawnAgent(argv, { cwd: root }) ?? '');
  const agentId = parseBackgroundedId(stdout);
  return {
    sessionId, agentId, sessionSlug: planned.sessionSlug, pr: planned.pr, repo: planned.repo, repoKey: planned.repoKey, prompt,
    unknownTokens, judgeProvider,
  };
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  try {
    // #xw3k2v9 — REVIEW FINDING (PR #1756 r1): with `extraArgs` now actually forwarded (see `dispatchReview`),
    // the CLI still had no way to SUPPLY any — `dispatch-lane.mjs`'s own CLI wiring reads `WE_DISPATCH_AGENT_ARGS`
    // (`agentArgsFromEnv`) so an operator can pass a restrictive `--permission-mode` to a dispatched agent; this
    // one silently could not. Reused verbatim, not re-derived, for the same reason every other primitive here is.
    // #xqa9ttq — `--judge-provider` is OPTIONAL; `dispatchReview`'s own `judgeProvider = 'claude'` default
    // applies when the flag is omitted, so `flag('judge-provider')` returning `undefined` here is the ordinary
    // case, not a gap.
    const result = dispatchReview({
      pr: flag('pr'), repo: flag('repo'), extraArgs: agentArgsFromEnv(), judgeProvider: flag('judge-provider'),
    });
    // #3331 — PRINT THE ID THAT ACTUALLY ADDRESSES THE SESSION. This used to print the minted uuid and tell the
    // operator to grep for it; that grep can never match (see `dispatchReview`), which is how a working
    // dispatch read as a silent failure. When stdout could not be parsed we say so rather than printing an id
    // that will not be found — the session slug is still a real handle in that case (`claude agents --json`
    // carries `-n` verbatim).
    writeAllSync(
      1,
      (result.agentId
        ? `dispatch-review: started agent ${result.agentId} (slug ${result.sessionSlug}) reviewing `
          + `${result.repo}#${result.pr} (judge provider: ${result.judgeProvider})\n`
          + `watch it: claude agents --json | grep ${result.agentId}   # or: claude logs ${result.agentId}\n`
        : `dispatch-review: started a session (slug ${result.sessionSlug}) reviewing ${result.repo}#${result.pr} `
          + `(judge provider: ${result.judgeProvider}), `
          + 'but could NOT read its id off `claude --bg`\'s output\n'
          + `watch it by name: claude agents --json | grep ${result.sessionSlug}\n`)
      + (result.unknownTokens.length ? `note: unrecognized brief tokens (reported, not fatal): ${result.unknownTokens.join(', ')}\n` : ''),
    );
  } catch (e) {
    writeLineSync(2, `error: ${String(e?.message ?? e)}`);
    process.exitCode = 1;
  }
}
