#!/usr/bin/env node
/**
 * pr-land.mjs — the `/pr` PRODUCER: open a self-approved PR, wait for green, label it, and hand the merge to
 * the drain (#2138 Fork 5, #2153; #2290).
 *
 * SOLE WRITER TO MAIN (#2290). pr-land NO LONGER merges: the drain is the only route that runs `gh pr merge`.
 * The default path opens the self-approved PR, waits for required checks, labels it `ready-to-merge` when green,
 * then triggers a single-couple FAST DRAIN (`merge-ai-prs.mjs --only=<pr>`) so `/pr` still feels instant — the
 * drain lands it. The trigger is best-effort: if it can't land (e.g. review parks the PR), pr-land still exits
 * success with the PR labelled and the standalone drain picks it up later. The retained `--fallback-git` local
 * merge is ALSO a write to main, so it now routes through the shared gate (`scripts/lib/pr-merge-gate.mjs`,
 * caller 'pr-land') and is BLOCKED unless the documented `WE_MERGE_BREAK_GLASS=1` admin override is set.
 *
 * WHY: #2138 (ruled) moves lane landing onto PRs as the review/CI surface — each ready lane opens a
 * self-approved PR (`gh pr create`, 0 required reviewers + a required CI check, #2151/#2152) and the
 * custom drain merges it via `gh pr merge` in impl-first/WE-last couple-order. GitHub's NATIVE merge
 * queue stays OFF (it is branch-level and would reorder couples). This is the transport substrate the
 * drain command (#2162) calls; pure local `git merge` (push-if-green) is the retained fallback.
 *
 * This is the PR analogue of `push-if-green.mjs`: same flag / `emit` / exit-code conventions. Where
 * push-if-green ff-pushes an already-merged `main`, pr-land merges a `lane/*` ref INTO `main` through a
 * PR, so the merge rides GitHub's required-check gate (#2151 runs the SAME `check:standards`+suite on the
 * PR — one gate environment). Proven live by PR #4 (head `lane/fix-2165-ci-fui-checkout`, merged green).
 *
 * RULES (#2138 Fork 5):
 *  - Self-approved: `gh pr create` with NO reviewer; branch protection (#2152) requires 0 approvals + the
 *    `test` check, so the author merges their own PR once CI is green. Never requests a human review.
 *  - The DRAIN owns ordering, not GitHub: this merges ONE PR when called (`gh pr merge`, not `--auto` on a
 *    native queue). The caller (#2162 drain) sequences impl-first/WE-last across a couple.
 *  - Head is a `lane/*` ref (the #1934 guard carve-out) — never a local branch (guarded) and never a
 *    force-push. The ref is pushed to origin, the PR opened against `--base` (default `main`).
 *  - Wait for the required check before merging (default): poll `gh pr checks` until it passes; a failed
 *    check ABORTS the merge (never merge a red PR). `--no-wait` leaves it for a later drain pass.
 *  - Fallback: `--fallback-git` degrades to a local `git merge --no-ff` + push when `gh` is unavailable or
 *    the PR is unmergeable-and-not-recoverable — the coherent retained fallback (#2138 Fork 5 (a)).
 *  - Deletes the `lane/*` ref after a clean merge (`--delete-branch`), mirroring the integrator.
 *  - Self-heals NEW-item backlog id collisions after a clean merge (#2071), the SAME heal the parallel
 *    integrator runs — so every land route (this CLI, `/pr`, `/drain` which reuses this, a manual land)
 *    heals, not only the batch workflow. On post-merge `main` any two files claiming one NNN is an
 *    allocation collision; the just-merged (newest) file yields to the next free id via the sanctioned
 *    renumber-collisions script (NO `--base-ref` — see buildRenumberHealArgs), then the fix is gated +
 *    committed + pushed (never force-pushed). A heal problem is surfaced but NEVER fails the land (the merge
 *    already succeeded). `--no-heal` opts out.
 *
 * Delegated work: --delegation=<provider>:<model>:<taskType> stamps explicit metadata for #3690.
 * Usage:
 *   node scripts/pr-land.mjs --ref=lane/2153-pr-substrate                 # publish HEAD → lane ref, open self-approved PR, wait for `test`, merge, delete ref
 *   node scripts/pr-land.mjs --ref=lane/2153-… --sha=<commit>            # publish an explicit commit (default: HEAD) — no local branch is created (guarded)
 *   node scripts/pr-land.mjs --ref=lane/2153-… --base=main --method=merge # method ∈ merge|squash|rebase (default merge; the drain wants --no-ff history)
 *   node scripts/pr-land.mjs --ref=lane/… --label-on-green                 # PRODUCER mode (#2199): open, WAIT for required checks, label ready-to-merge ONLY when green, hand merge to the drain
 *   node scripts/pr-land.mjs --ref=lane/… --no-wait                       # open the PR UNLABELLED, don't wait/merge (CI unconfirmed — the drain won't collect it until labelled)
 *   node scripts/pr-land.mjs --ref=lane/… --park=review:human            # PARK mode (#2622): open the PR WITH the review label already on it and STOP (no wait, no ready-to-merge, no drain) — the first-class held-for-review open, replacing the hash-stranding `gh pr create` bypass. DRAFT BY DEFAULT (draft-first PRs, operator-approved 2026-09-27): the review label sits on it, but nothing dispatches a review until the daemon un-drafts it on green CI (`gh pr ready`, `scripts/conveyor/reconcile-core.mjs`'s `promote-draft`)
 *   node scripts/pr-land.mjs --ref=lane/… --park=review:human --no-draft # same, but opened READY FOR REVIEW immediately (opt-out for a human-opened or otherwise special-cased park — #2622's original behavior)
 *   node scripts/pr-land.mjs --ref=lane/… --dry-run                       # print the exact gh command sequence, execute nothing
 *   node scripts/pr-land.mjs --ref=lane/… --fallback-git                  # on gh failure / unmergeable, local git-merge + push instead
 *   node scripts/pr-land.mjs --ref=lane/… --no-heal                       # skip the post-land id-collision self-heal (#2071)
 *   node scripts/pr-land.mjs --ref=lane/… --no-regen                      # skip the post-land derived-artifact regen (#2182)
 *   node scripts/pr-land.mjs --ref=lane/… --no-sync-primary               # skip the post-land ff-sync of the user's PRIMARY checkout to origin/main
 *   node scripts/pr-land.mjs --ref=lane/… --no-label                      # do NOT apply the ready-to-merge label (#2196) — e.g. a PR that must stay human-reviewed
 *   node scripts/pr-land.mjs --ref=lane/… --label=<name>                  # apply a different label than the default `ready-to-merge`
 *   node scripts/pr-land.mjs --ref=lane/… --json                          # machine-readable result
 *
 * READY-TO-MERGE LABEL (#2196/#2199). Every AI-edit path that opens a PR routes through THIS transport, so
 * pr-land is the single deliberate step that marks a couple "a producer certified this" (never applied by hand
 * casually). #2199: the label now means "required checks are GREEN", so it is applied ONLY after the green-wait
 * — NEVER eagerly at open. In the default (land) path and the `--label-on-green` producer path the label goes
 * on once the required checks pass; a bare `--no-wait` opens the PR UNLABELLED (CI unconfirmed). That label is
 * the universal signal the label lander (`/drain`, `scripts/merge-ai-prs.mjs --label=ready-to-merge`) collects,
 * whatever session shape (`/pr`, solo `#2123` lane, batch closeout, `/workflow`) produced the PR. `--no-label`
 * opts a PR out; label-apply is best-effort and never fails the land.
 *
 * Exit codes: 0 = merged (or opened --no-wait / opened --park / labelled-on-green / dry-run OK); 2 = required check RED (nothing merged);
 * 3 = unmergeable / gh error / push failed / EMPTY DESCRIPTION (#2324 — nothing merged; recoverable — rebase the
 * ref and re-run, or pass --fallback-git; an empty-body refusal is fixed by editing the PR body and re-running);
 * 3 also covers soak-declaration: add a break scenario or body waiver before publishing a new PR.
 * 4 = BLOCKED-ON-INFRA (#2659) — the lane ref was PUSHED but `gh pr create` failed on an OUTSIDE dependency (a
 * GitHub outage / network fault). NOT a hard fail: the pushed handle is recorded in the conveyor infra-blocked
 * state, which auto-retries with backoff and resume-opens the PR once infra recovers (nothing is stranded; the
 * drain stays the sole writer to main). A non-zero exit means `main` was left UNTOUCHED.
 */
import { defaultShimDir, resolveOrgAwareShimDir, pathWithOrgAwareShim } from './lib/gh-app-shim.mjs';
import { publicationTitle, readMainCard } from './operations/machine-pr-title.mjs';
import { producerBuildContext, checkpointBuildPr } from './operations/build-pr-authorship.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { assertMayMerge, hasNonEmptyBody } from './lib/pr-merge-gate.mjs';
import { soakPrecheckAtOpen, soakPrecheckEnabled } from './lib/soak-precheck-at-open.mjs';
import { parseNameStatus } from './soak-replay-gate-cli.mjs';
import { createGhLandProvider, buildCreateArgs } from './lib/forge-land-provider.mjs'; // #3585 — the forge-land port
export { mergeMethodFlag, buildCreateArgs, buildMergeArgs, buildAddLabelArgs } from './lib/forge-land-provider.mjs'; // re-exported for backward compat — callers/tests still import these off pr-land.mjs
import { numberPendingHashes, isPostLandTreeDirty } from './lane-drain.mjs'; // JIT numbering + dirty-probe, shared single source (#2288/#xzxc92d/#2348)
import { withNumberingLock } from './readiness/drain-lock.mjs'; // #2391 — the numbering-critical-section mutex (sole-serial-writer)
export { isPostLandTreeDirty }; // re-exported for backward compat — callers/tests still import it off pr-land.mjs
import { findDuplicateIds, summarizeDuplicates } from './lib/duplicate-id-tripwire.mjs'; // post-land dup-NNN tripwire (#2318)
// SHARED net-diff derivation w/ the drain, single source (#1821/#2373/#2890): ONE basis resolution feeding the
// changed-file shape, the diff TEXT and the `diffHunks` contract mapping. Deliberately the ONLY net-diff import
// here — pr-land does not hold `computeNetDiffText`/`resolveNetDiffBasis`, so it CANNOT hand-roll the mapping
// the review caught (#2890-review-r2 finding 3); a source guard in pr-land.test.mjs holds that shut.
import { computeNetDiffSignals, recordParkVerdict } from './merge-ai-prs.mjs';
import {
  scoreEscalation, parseDeviationDisclosure, producerReviewLabel, shouldApplyReviewLabel, REVIEW_LABEL_META, REVIEW_LABELS,
  reconcileEscalationReasonBlock, reconcileRoster, ROSTER_TIMING,
  isReviewHoldLabel, READY_TO_MERGE_LABEL, readyMergeConflictsWithHold, hasUnclearedReviewLabel,
} from './lib/review-escalation.mjs'; // #2307 — deterministic review-escalation label AT PR-OPEN; #2635 — roster bind+reconcile; #2832 — hold/ready self-consistency
import { resolveJuryPlan } from './lib/review-core.mjs'; // #2635 — recompute the jury roster from the REAL diff at PR-open
import { POLICY_CARE_JURY } from './lib/review-policy.mjs'; // #2635 — the care→jury contract's roster-timing mode (knob #4)
import { parseManifest, embedManifestInBody, repoKeyFromSlug, manifestBaseForRepo } from './readiness/lane-manifest.mjs'; // xnsk54v — manifest rides the PR body, not a tracked file
import { buildDelegationMarker, DELEGATION_MARKER, DELEGATION_TASK_TYPES } from './lib/delegation-marker.mjs';
import { currentActorId, buildAuthorActorMarker, readAuthorActorStamps } from './lib/review-independence.mjs'; // #2844 — the author stamp the self-clear refusal compares against
import { classifyPrOpenFailure, recordInfraBlockIO, infraStorePath, primaryRootFromClone, originSlugOf, infraHas, readInfraStore } from './conveyor/infra-blocked.mjs'; // #2659 — a post-push PR-open failure on an outside dependency → the infra-blocked state (recorded for auto-retry/resume), not a hard fail
import { decideOpenPr, countOpenPrsForRepo, isGlobalOffLive, isBranchAllowedLive } from './lib/pr-limit.mjs'; // we:xniq7xs — the open-PR backpressure limit's pre-create refusal
import { repoKeyForSlug } from './lib/constellation-repos.mjs'; // we:xniq7xs — map this checkout's origin slug to the internal repo key the limit is keyed by
import { join } from 'node:path';
import { pushRefusal, callerIdentity, repoKeyForCheckout } from './conveyor/fix-procedure.mjs'; // fix procedure — refuse a push to a branch another fixer holds the fix claim on
import { writeAllSync } from './lib/write-all-sync.mjs';
import { admittedArgv } from './readiness/heavy-admission.mjs'; // xaipsbs — the heal's check:standards waits for a heavy-command slot
import { verifyGateDecision, readVerifyMarker, resolveVerifyOptions } from './lib/lane-verify.mjs'; // #2833 — the lane-verification finish-guard: refuse to land a HEAD whose synchronous suite run never finished (or, under --require-verified, was never recorded green). readVerifyMarker/resolveVerifyOptions are the SHARED marker reader + option resolver (findings 2/5) both this gate and verify-lane use, so the two can never drift (readVerifyMarker owns the VERIFY_FILENAME path — no bare JSON.parse of the marker here).
import { MAIN_CI_RED_DEFAULTS } from './conveyor/main-ci-red-core.mjs'; // card xu1nixv — a red-main fix PR never opens as a draft
import { laneRelevantChangeSinceForRecord } from './lib/verify-lane-gate.mjs'; // #4296 — keys the finish-guard's marker match to what LANE-RELEVANT files changed since the marker's recorded sha, not the exact commit (a no-op merge of BASE that conflicts only outside the lane's own touch-set must not force a fresh full re-verify).

// ── flag parsing (mirrors push-if-green.mjs) ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = {};
for (const a of argv) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) { flags[m[1]] = m[2] === undefined ? true : m[2]; continue; }
  // #3690 — keep malformed multiline --delegation values visible to bad-delegation validation;
  // scope this exception to that flag so every other flag retains its ordinary non-dotAll parsing.
  const md = a.match(/^--delegation=([\s\S]*)$/);
  if (md) flags.delegation = md[1];
}
const expandHome = (p) => (p && p.startsWith('~') ? p.replace(/^~/, homedir()) : p);
// Read a PR body from a file (the #2170 lane-review-composed body). Missing/unreadable → null (falls back
// to gh's --fill), never a hard failure: a body-file problem must not block a green landing.
function readBodyFile(p) {
  try { return readFileSync(expandHome(p), 'utf8'); } catch { return null; }
}

const REPO = resolve(expandHome(flags.repo) || process.cwd());
// xpd70wx — a direct pr-land run whose PATH carries the stale legacy gh shim (no owner map: it cannot see the
// plateauapp org) swaps it for the daemons' org-aware shim. Only ever replaces the legacy dir; a test's or an
// operator's own `gh` earlier on PATH is untouched. No token is read or printed.
if ((process.env.PATH || '').split(':').includes(defaultShimDir())) {
  const orgPath = pathWithOrgAwareShim({ pathEnv: process.env.PATH || '', orgDir: resolveOrgAwareShimDir() });
  if (orgPath) process.env.PATH = orgPath;
}
const REF = typeof flags.ref === 'string' ? flags.ref : null;
const SRC = typeof flags.sha === 'string' ? flags.sha : 'HEAD'; // source commit to publish to the lane ref (the lane clone's HEAD)
const BASE = typeof flags.base === 'string' ? flags.base : 'main';
const REMOTE = typeof flags.remote === 'string' ? flags.remote : 'origin';
const METHOD = typeof flags.method === 'string' ? flags.method : 'merge';
const WAIT = !flags['no-wait'];
const DRY_RUN = !!flags['dry-run'];
const FALLBACK_GIT = !!flags['fallback-git'];
const AS_JSON = !!flags.json;
// #2833 — the lane-verification finish-guard. #3321 INVERTED WHO HAS TO SPEAK UP. This comment used to read
// "`--require-verified` (or env WE_REQUIRE_VERIFIED=1) DEMANDS a fresh GREEN marker for the HEAD being landed —
// the solo / conveyor build flow passes it so a lane that skipped its synchronous suite run cannot deliver."
// THAT IS NOW WRONG in its load-bearing half: a fresh GREEN marker is demanded BY DEFAULT, of every caller, and
// `--require-verified` is merely the (still-honoured) explicit spelling of the default. The solo / conveyor flow
// no longer has to pass anything to be gated. What a caller must now do explicitly is the OPPOSITE — say
// `--no-require-verified` to land without a marker, which BOTH CI-gated callers do — the drain (`buildPrLandArgs`
// in we:scripts/lane-drain.mjs) and the parallel `/workflow` producer's four argvs
// (we:skills-src/batch-backlog-items/parallel-execute.workflow.js) — because they land from the PRIMARY checkout
// against a lane ref, where a lane clone's marker cannot exist. Which callers say what is not left to a comment:
// the caller sweep in we:scripts/__tests__/lane-verify.test.mjs harvests `pr-land` COMMAND STRINGS from the
// tracked file set and requires each to declare a posture (a verify flag, or an adjacent `verify-lane` run).
// #3321 round 5 — THIS SENTENCE READ "harvests EVERY `pr-land` invocation in the tracked file set". That was a
// completeness claim larger than the check, which is the exact defect this PR was bounced for five rounds
// running: round 4's harvest regex knew only the bare `node scripts/pr-land.mjs` spelling, so a live emitter
// written with this repo's own `we:` locus prefix was invisible to it. The sweep's real scope and its stated
// limits (which path spellings it knows, that array-built argvs need their own case, that source adjacency is a
// proxy and not proof of order) live beside the sweep itself — read them there, do not infer them from here.
// An UNFINISHED (`running`) marker for that HEAD is refused UNCONDITIONALLY (it is the exact observed stall — a
// backgrounded run that yielded mid-flight), and the opt-out does NOT relax that. The documented break-glass
// WE_LAND_UNVERIFIED=1 overrides the whole gate (the PR still rides the required CI check).
// #2833 finding 5 — resolve through the SHARED resolver so this gate and `verify-lane check` agree on the same
// flag/env pair (both call `resolveVerifyOptions`): the #3321 default, `--require-verified` /
// `WE_REQUIRE_VERIFIED=1`, the `--no-require-verified` / `WE_REQUIRE_VERIFIED=0` opt-out, plus the
// `WE_LAND_UNVERIFIED=1` break-glass.
const { requireVerified: REQUIRE_VERIFIED, breakGlass: VERIFY_BREAK_GLASS } = resolveVerifyOptions({ flags, env: process.env });
const TITLE = typeof flags.title === 'string' ? flags.title : null;
// Body precedence: --body-file (a path — robust for the multi-line body the #2170 lane review composes,
// where the dismissed-findings block has newlines a CLI --body flag would mangle) wins over --body.
const BODY = typeof flags['body-file'] === 'string'
  ? readBodyFile(flags['body-file'])
  : (typeof flags.body === 'string' ? flags.body : null);
// xnsk54v — the lane manifest (drain metadata: cross-repo `repos`, `blockedBy`, `mergeRiskFiles`,
// `dismissedFindings`) is passed as a SCRATCH file (never committed into the tree) and ridden in the PR body
// instead. Load it here; a missing/malformed file degrades to no manifest (the drain then finds none and the
// escalation score loses the couple-shape signal — never a hard failure). Distinct from `--body`: this is the
// machine payload the drain reads, appended to the human body as a delimited block at create.
const LANE_MANIFEST = typeof flags['manifest-file'] === 'string'
  ? (() => { try { return parseManifest(readFileSync(expandHome(flags['manifest-file']), 'utf8')); } catch { return null; } })()
  : null;
// Explicit metadata from the delegating session; never infer authorship from commits.
const delegationParts = typeof flags.delegation === 'string' ? flags.delegation.split(':') : [];
const [provider, model, taskType] = delegationParts;
const DELEGATION_MARKER_LINE = delegationParts.length === 3 && DELEGATION_TASK_TYPES.includes(taskType)
  ? buildDelegationMarker({ provider, model, taskType }) : '';
// #2844 — the AUTHOR's actor id, stamped into the PR body at OPEN. This is the durable half of the self-clear
// refusal: it is written HERE, by the producer, before any review exists and before this session knows it might
// later want to clear the PR — so the later clearance check compares against a value recorded by a different
// tool at a different time, not against something the clearing process asserts about itself. Empty when the
// harness supplies no session id, in which case no marker is written and the autonomous seam refuses to
// auto-clear the PR (fail-closed, by design). See `we:scripts/lib/review-independence.mjs`.
const AUTHOR_MARKER = buildAuthorActorMarker(currentActorId());
/**
 * we:scripts/pr-land.mjs#withAuthorStamp — append the #2844 author stamp to a PR body, idempotently (a body that
 * already carries one is returned unchanged — pr-land is re-run routinely, and a second stamp must never appear).
 * PURE, with the marker INJECTABLE so the stamp is unit-testable (PR #1100 review): it was module-private and
 * read the module-scope `AUTHOR_MARKER` directly, so mutating it to stop stamping passed all 65 pr-land tests
 * while silently disarming half of the whole self-clear mechanism. `composePrBody` is the exported entry point.
 * @param {string} body
 * @param {string} [marker] - the rendered author marker ('' when the harness supplied no session id).
 */
export function withAuthorStamp(body, marker = AUTHOR_MARKER) {
  // A null/empty body is returned UNTOUCHED: `prCreateBodyGuard` refuses a bodyless create anyway (#2332), and
  // synthesising a marker-only body here would turn that hard refusal into a PR whose whole description is an
  // HTML comment — the #2324 stall this producer exists to prevent.
  if (!marker || typeof body !== 'string' || !body.trim()) return body;
  // PRESENCE, not the resolved id (`readAuthorActorStamps`, not `parseAuthorActorId`): a body carrying two
  // CONFLICTING stamps resolves to '' by design, and asking for the id there would append a THIRD stamp on every
  // re-run. Any stamp at all means this producer has already stamped, or someone else has — either way, hands off.
  if (readAuthorActorStamps(body).length) return body;
  return `${body}\n\n${marker}\n`;
}
/** Append only when absent, including when an existing stamp is malformed or ambiguous. */
export function withDelegationStamp(body, marker = DELEGATION_MARKER_LINE) {
  if (!marker || typeof body !== 'string' || !body.trim()) return body;
  if (new RegExp(`<!--\\s*${DELEGATION_MARKER}:`).test(body)) return body;
  return `${body}\n\n${marker}\n`;
}
/**
 * we:scripts/pr-land.mjs#composePrBody — the body actually shipped to `gh pr create` AND to the re-run backfill
 * edit: the human body with the lane manifest block embedded (xnsk54v) and the #2844 author stamp appended. PURE,
 * with its inputs injectable so each part of the composition is provable without shelling the CLI. The
 * #2332/#2324 body guards still run on the HUMAN `BODY` (a manifest-only body must not pass as real content).
 * @param {string} body
 * @param {object|null} [manifest]
 * @param {string} [marker]
 * @param {string} [delegationMarker]
 */
export function composePrBody(body, manifest = LANE_MANIFEST, marker = AUTHOR_MARKER, delegationMarker = DELEGATION_MARKER_LINE) {
  return withDelegationStamp(withAuthorStamp(manifest ? embedManifestInBody(body, manifest) : body, marker), delegationMarker);
}
const CREATE_BODY = composePrBody(BODY);
// Post-land id-collision self-heal (#2071, generalized to EVERY land route). After a clean merge, heal any
// NEW-item backlog id collision the land created against `main` (two files claiming one NNN) — the exact
// heal the parallel integrator runs at Phase 4b, now shared so `/pr`, `/drain` (which reuses this) AND a
// manual land all self-heal, not only the batch workflow. ON by default for a real land; `--no-heal` opts
// out. Never runs on --dry-run / --no-wait (nothing merged) by construction.
const HEAL = !flags['no-heal'];
// Post-land derived-artifact regen (#2182). After a clean merge, regenerate the WE derived artifacts once
// (the AGENTS.md inventory block via gen:inventory; src/_data/referenceIndex.json via gen:reference-index)
// — the same generators the drain's Phase 4c runs, now folded into every land route so a `/pr`- or
// manually-landed change whose inputs feed a derived artifact never leaves `main` with stale output.
// Gate behind `--no-regen` to allow opt-out (mirrors `--no-heal`). Never runs on --dry-run / --no-wait.
const REGEN = !flags['no-regen'];
// Post-land primary-checkout sync. pr-land runs in a LANE clone; the drain that lands the PR ff-syncs THAT
// clone's local main, but the user's PRIMARY checkout (a separate directory) drifts behind origin/main on every
// land. After a land, fast-forward the primary too so it never lags what we just landed. Gate behind
// `--no-sync-primary` (mirrors --no-heal/--no-regen). Best-effort, never fails a land.
const SYNC_PRIMARY = !flags['no-sync-primary'];
// The producer-certified `ready-to-merge` label (#2196) — applied to every opened PR so the label lander
// (/drain) can collect ALL AI-generated work, whatever session opened it. `--no-label` opts out; `--label=<n>`
// overrides the name. Default on.
const LABEL = flags['no-label'] ? null : (typeof flags.label === 'string' ? flags.label : 'ready-to-merge');
// #2199 — the `ready-to-merge` label must mean "every required check is GREEN, the drain may land", never
// just "a local lint passed". `--label-on-green` is the producer mode: open the PR, WAIT for the required
// checks, apply the label ONLY once they pass, and STOP (hand the merge to the drain — do not merge here). It
// replaces the old fire-and-forget `--no-wait` (which labelled at open, before ANY CI — so red PRs entered the
// queue, observed 2026-07-03: #55/#57/#59/#67 labelled with a red `test`). In every mode the label is now
// applied only after the green-wait, never eagerly at open.
const LABEL_ON_GREEN = !!flags['label-on-green'];
// we:xniq7xs — the `force-open`/`reason` flag pair is the per-PR escape hatch for the open-PR backpressure
// limit (below): a deliberate, logged, one-shot override for THIS land call only — never a standing
// exemption. A reason is expected (not enforced here — see pr-limit.mjs): every override this module
// honours is logged with actor + reason, and an unstated one would be the sole silently-unaccountable override.
const FORCE_OPEN = !!flags['force-open'];
const FORCE_OPEN_REASON = typeof flags.reason === 'string' ? flags.reason : null;
// draft-first PRs (operator-approved, 2026-09-27) — a `--park`-ed PR (the agent-opened default, #2622) is
// what applies a review label AT OPEN with no CI confirmed yet — measured live: 6 of 26 PRs opened overnight
// failed their OWN FIRST CI run, and every one of them still got a full independent review (~12 min each,
// several re-reviewed after their fix), because the review daemon dispatches off the `review:*` label alone
// and never asked whether CI had even run yet. `--no-draft` is the explicit opt-out (mirrors `--no-label`/
// `--no-heal`'s naming) for a human-opened or otherwise special-cased `--park` call that WANTS review to start
// immediately. Scoped to `park` ONLY (applied where `PLAN.mode === 'park'` below): `land`/`label-on-green`
// already never apply a review label until AFTER their own green-wait poll loop breaks (see `pollVerdict`'s
// docblock) — those two modes never had this bug, and `pollVerdict` has no `'DRAFT'` branch, so opening a
// `land`/`label-on-green` PR as a draft would spin its poll loop to timeout on GitHub's own `mergeStateStatus:
// 'DRAFT'` (neither `CLEAN`/`UNSTABLE` nor `BEHIND`) instead of ever landing. The daemon (never pr-land) is
// what un-drafts it: `scripts/conveyor/reconcile-core.mjs`'s new `promote-draft` dispatch calls `gh pr ready`
// once the PR's required checks are ALL green, which is what lets the review daemon dispatch a review at all
// (its own new `isDraft` gate in `dispatchReviewRow` refuses one on any draft PR, whatever label it carries).
const DRAFT_OPT_OUT = !!flags['no-draft'];

// ── PURE helpers (unit-tested in scripts/__tests__/pr-land.test.mjs) ──────────────────────────────────

/**
 * Resolve the producer's land plan from the wait/label flags (#2199, #2290, #2622). Pure. pr-land NEVER merges
 * any more — the drain is the sole writer to main — so `mergeWhenGreen` is always false; the label is NEVER
 * applied before the required checks are green. The four modes:
 *   - `land`           (default): wait for required checks → label when green → TRIGGER a single-couple fast
 *     drain (`triggerDrain`) so /pr feels instant. Does NOT merge here.
 *   - `label-on-green` (`--label-on-green`): wait → label when green → STOP. Pure producer: does not trigger a
 *     drain (a batch/workflow closeout runs the standalone drain over the whole set).
 *   - `open-only`      (`--no-wait`, no label-on-green): open, do NOT wait, do NOT label → left for a drain
 *     that re-checks (an UNLABELLED PR — the label lander won't collect it until something labels it).
 *   - `park`           (`--park=review:human|review:pending`): open WITH the review label already on it and
 *     STOP — no green-wait, no `ready-to-merge`, no drain trigger (a parked PR is meant to sit for review, #2622).
 *     Park composes the `open-only` open semantics (no wait, no landing label) WITH the caller-chosen review
 *     label applied at open. It takes PRECEDENCE over `labelOnGreen`/`wait` — a held-for-review PR must never
 *     also carry the auto-land signal. `park` is the ALREADY-VALIDATED label string (see `resolveParkLabel`).
 * @returns {{waitForChecks:boolean, labelWhenGreen:boolean, mergeWhenGreen:boolean, triggerDrain:boolean, mode:string, parkLabel?:string}}
 */
export function planPrLand({ wait, labelOnGreen, park } = {}) {
  if (park) return { waitForChecks: false, labelWhenGreen: false, mergeWhenGreen: false, triggerDrain: false, mode: 'park', parkLabel: park };
  if (labelOnGreen) return { waitForChecks: true, labelWhenGreen: true, mergeWhenGreen: false, triggerDrain: false, mode: 'label-on-green' };
  if (!wait) return { waitForChecks: false, labelWhenGreen: false, mergeWhenGreen: false, triggerDrain: false, mode: 'open-only' };
  return { waitForChecks: true, labelWhenGreen: true, mergeWhenGreen: false, triggerDrain: true, mode: 'land' };
}

/** The review labels `--park` may open a PR with — the deliberately-held-for-review set (#2622). A parked PR
 *  is one a producer wants a human/independent review on BEFORE it lands, so only the two "not yet cleared"
 *  labels are valid park targets: `review:human` (a human must clear it) and `review:pending` (an independent
 *  review is owed). Sourced from `REVIEW_LABELS` so the names never drift from the escalation module. */
export const PARK_LABELS = Object.freeze([REVIEW_LABELS.human, REVIEW_LABELS.pending]);

/**
 * #draft-first-prs (operator-approved 2026-09-27) — whether THIS create should carry `--draft`. Pure.
 *
 * SCOPED TO `park` ONLY, DELIBERATELY. `park` is the ONE mode that applies a `review:*` label at OPEN, before
 * any CI has run at all (`planPrLand`'s own docblock: "no green-wait, no ready-to-merge") — measured live:
 * 6 of 26 PRs opened overnight failed their OWN first CI run, and every one still got a full independent
 * review, because the review daemon dispatches off the label alone. `land`/`label-on-green` never had this
 * bug: both apply their review-escalation label only AFTER their own green-wait poll loop already broke
 * (see `pollVerdict`'s own docblock) — CI has always finished by then. Opening either of THOSE as a draft
 * would additionally break: `pollVerdict` has no `'DRAFT'` branch, so GitHub's own `mergeStateStatus: 'DRAFT'`
 * would fall to `'wait'` and spin the poll loop to its timeout instead of ever landing.
 * @param {{mode:string, optOut:boolean}} o
 * @returns {boolean}
 */
export function resolveDraft({ mode, optOut, ref = '', title = '' }) {
  // Card xu1nixv (incident 2026-10-08: #4522, the fix for red main, opened as a draft and sat refused "still a
  // draft" while main stayed red) — a PR that fixes red main opens READY: it is the one PR that cannot wait.
  if (isMainFixPr({ ref, title })) return false;
  return mode === 'park' && !optOut;
}

/** A red-main fix PR: from the main-fix owner branch, or titled as a fix of red main (`main-ci-red-core.mjs`'s
 *  declared pattern — the same rule that recognises the owner). Pure. */
export function isMainFixPr({ ref = '', title = '' } = {}) {
  const d = MAIN_CI_RED_DEFAULTS;
  const branch = String(ref).replace(/^refs\/heads\//, '');
  if (branch.startsWith(d.mainCiRedOwnerBranchPrefix)) return true;
  try { if (d.mainCiRedOwnerBranchPattern && new RegExp(d.mainCiRedOwnerBranchPattern, 'i').test(branch)) return true; } catch { /* bad pattern: title only */ }
  try { return new RegExp(d.mainCiRedOwnerTitlePattern, 'i').test(String(title)); } catch { return false; }
}

/**
 * #2622 — validate + resolve the `--park=<label>` value. Pure. `--park` opens a PR already carrying a review
 * label and holds it (no wait/land), the first-class replacement for the `gh pr create` bypass an agent used to
 * reach for when it needed a PARKED PR (that bypass skipped pr-land's producer land-prep and could strand a new
 * item's hash id). Only the two held-for-review labels are valid (`PARK_LABELS`); anything else is a fail-fast
 * (the CLI turns `ok:false` into an error emit BEFORE any push/create, never a silently-ignored flag).
 *   - flag absent (`undefined`/`false`)      → `{ park: false }` (not a park run).
 *   - flag present, valid label              → `{ park: true, ok: true, label }`.
 *   - flag present, missing/invalid value    → `{ park: true, ok: false, reason }`.
 * @param {string|boolean|undefined} park  the raw `flags.park` (a string value, `true` for a bare `--park`, or undefined)
 * @returns {{park:boolean, ok?:boolean, label?:string, reason?:string}}
 */
export function resolveParkLabel(park) {
  if (park == null || park === false) return { park: false };
  const label = park === true ? '' : String(park);
  if (!PARK_LABELS.includes(label)) {
    return { park: true, ok: false, reason: `--park must be one of ${PARK_LABELS.join(' | ')} (got ${label ? `"${label}"` : '(no value)'}) — the review label a parked, held-for-review PR opens with (#2622)` };
  }
  return { park: true, ok: true, label };
}

/**
 * A `--label-on-green` producer that exits WITHOUT labelling (green-wait ended red / timed out / behind) must not
 * strand the PR label-less: nothing owns a green PR with no `review:*` or `ready-to-merge` label (PR #3830).
 * Returns the neutral hand-off label to apply, or null. Pure. A conflict is left to the conflict-repair path.
 * @param {{mode?:string, reason?:string, labelApplied?:boolean, prNum?:(number|string|null)}} o
 * @returns {string|null}
 */
export function unlabelledHandOffLabel({ mode, reason, labelApplied = false, prNum = null } = {}) {
  if (mode !== 'label-on-green' || labelApplied || prNum == null) return null;
  return ['check-red', 'check-timeout', 'behind'].includes(reason) ? 'review:pending' : null;
}

/**
 * #2284 — the producer's per-poll verdict on an open PR's merge state. Pure (unit-tested transition table).
 * pr-land NO LONGER merges (the drain is the sole writer and rebases a behind PR before merging), so a
 * BEHIND-but-green PR is landable: the producer LABELS it and hands off rather than aborting — behind-ness is
 * the drain's job, never a labelling precondition (the bug that defeated the handoff live: #145 / the
 * 2026-07-06 pipeline batch, where a churning main left every re-land BEHIND and pr-land refused to label a
 * green PR). Verdicts:
 *   'conflict' — CONFLICTING / DIRTY → abort (rebase or --fallback-git).
 *   'red'      — a required check failed → abort.
 *   'behind'   — BEHIND but this path actually MERGES (non-producer; only the break-glass git-merge) → abort.
 *   'label'    — ready to apply the producer label + hand off: CLEAN/UNSTABLE+passed, OR (producer) BEHIND with
 *                a NON-EMPTY passed required set (never the empty-set 'passed', which for a not-yet-registered
 *                check would race a premature label on a behind PR — CLEAN/UNSTABLE is guarded by GitHub state).
 *   'wait'     — not ready yet (checks pending / BLOCKED) → keep polling.
 * @param {{state:string, checkStatus:string, requiredCount:number, labelWhenGreen:boolean, conflicting?:boolean}} o
 * @returns {'conflict'|'red'|'behind'|'label'|'wait'}
 */
export function pollVerdict({ state, checkStatus, requiredCount = 0, labelWhenGreen = false, conflicting = false } = {}) {
  if (conflicting || state === 'DIRTY') return 'conflict';
  if (checkStatus === 'failed') return 'red';
  if (state === 'BEHIND') {
    if (!labelWhenGreen) return 'behind';
    return requiredCount > 0 && checkStatus === 'passed' ? 'label' : 'wait';
  }
  if ((state === 'CLEAN' || state === 'UNSTABLE') && checkStatus === 'passed') return 'label';
  return 'wait';
}

// mergeMethodFlag / buildCreateArgs / buildMergeArgs / buildAddLabelArgs moved to
// `./lib/forge-land-provider.mjs` (#3585 — the forge-land port) and re-exported below so every existing
// importer of this module keeps resolving them unchanged.

/**
 * #2332 — producer fail-fast: NEVER open a bodyless PR. An empty-body PR passes the producer, but the #2324
 * drain-side gate then REFUSES to LAND it, stalling the queue until a human hand-fills the body (observed
 * 2026-07-08: #2226/PR #222 opened bodyless, blocking the drain). #2324 fixed only the consumer-side refusal;
 * this is the missing producer-side prevention. The producer requires a non-empty `--body-file`/`--body` AT
 * OPEN and fails fast where the omission is — never emitting a PR that stalls a later drain and needs manual
 * repair. Guards the CREATE path ONLY: a re-run against an already-open PR is exempt (its body already exists).
 * Pure decision; the CLI turns `ok:false` into a fail-fast emit BEFORE `gh pr create`. */
export function prCreateBodyGuard(body) {
  return hasNonEmptyBody(body)
    ? { ok: true }
    : { ok: false, reason: 'refusing to open a bodyless PR — pass --body-file=<path> (or --body) with a non-empty body (#2332: the #2324 drain gate rejects an empty body at land, stalling the queue)' };
}

/**
 * #2832 / #984 findings 4+5 (+ R4/minor-1) — the producer's hold/go-ahead decision, as a pure function so the
 * write-time invariant is unit-testable without the `gh` write. Given the escalation VERDICT label, the PR's
 * OBSERVED labels, and whether THIS run just applied the go-ahead, decide two things:
 *   - `held`  — is this PR held for review? True if the fresh verdict is a review-HOLD label OR the PR ALREADY
 *     OBSERVABLY carries an uncleared review hold (`hasUnclearedReviewLabel`). The #984 R4 fix: an OBSERVED hold
 *     is STICKY — a PR parked `review:human`/`review:pending` (by the drain, a #2409 re-park, a human, or a prior
 *     `--park`) whose FRESH rubric happens clean is STILL held, so this must not emit `held:false` and let the
 *     workflow Finalize re-run `pr-land --label-on-green` on it (re-adding the go-ahead a hold strips — the
 *     flip-flop) or the unconditional `applyLabel()` leave it `held AND ready`. Distinct from a `ready-to-merge`
 *     label-apply FAILURE (`labelApplied:false`) — a hold with a failed apply is STILL a hold.
 *   - `strip` — must the producer STRIP `ready-to-merge`? True iff held AND the go-ahead is present, judged BOTH
 *     from the OBSERVED set (`currentLabels` ∪ the just-decided hold — #984 finding 5, so a re-run against an
 *     already-`ready-to-merge` held PR strips even when this run's add "failed") AND, belt-and-braces, from
 *     `labelApplied` (#984 minor 1). Reuses the SHARED `readyMergeConflictsWithHold` predicate (no fork).
 *
 * EXACT SCOPE OF THE `labelApplied` BELT (#984 F3 — the doc claim, corrected). It covers the case where the live
 * `gh pr view --json labels` read FAILS OPEN to `[]` **and this run's own verdict is a hold**: the hold is then
 * known from `verdictLabel` even though the observed set is empty, so the go-ahead this run just stamped is still
 * stripped. It does NOT — and provably cannot — cover a failed label read combined with a CLEAN fresh verdict
 * (`decideHoldReadyStrip(null, [], {labelApplied:true})` → `{held:false, strip:false}`, pinned by test). In that
 * composition there is NO evidence of a hold from either input: `verdictLabel` is null and `currentLabels` is
 * empty because the read missed, and the function cannot tell that from a genuinely unheld PR. The reviewer's
 * suggested widening — computing `strip` from `labelApplied` independently of `held` — must NOT be taken: it
 * would strip the go-ahead from EVERY healthy PR the producer just stamped, un-queueing the whole happy path.
 * The residual is covered downstream instead: the drain's park seam (`decideParkReadyStrip`) strips on the
 * OBSERVED hold every pass, for all three hold labels, with no dependence on this run's reads.
 * @param {string|null|undefined} verdictLabel - the producer's final review-escalation label (a hold, or null)
 * @param {Array} currentLabels - the PR's OBSERVED labels (string or `{name}` shape)
 * @param {{labelApplied?: boolean}} [opts] - did THIS run's `--add-label ready-to-merge` succeed?
 * @returns {{held:boolean, strip:boolean}}
 */
export function decideHoldReadyStrip(verdictLabel, currentLabels, { labelApplied = false } = {}) {
  const held = (!!verdictLabel && isReviewHoldLabel(verdictLabel)) || hasUnclearedReviewLabel(currentLabels);
  const strip = held && (readyMergeConflictsWithHold([...(currentLabels || []), verdictLabel]) || labelApplied);
  return { held, strip };
}

/**
 * #3342 — build the flags for the #2331 producer locus-prefix sweep. `--root` is the load-bearing one: this
 * script resolves the linter off its OWN location, and the linter used to sweep whatever clone it was found
 * in. pr-land almost always runs from the PRIMARY checkout against a LANE clone (`--repo=<lane>`), so the
 * range named a commit the primary had never fetched, git exited 128, and the sweep was skipped — with a
 * reassuring "CI still backstops it" — on essentially every lane-opened PR. Passing the repo we are landing
 * FROM points the sweep at the clone that actually holds the commits. Pure — returns the argv tail.
 */
export function buildLocusLintArgs({ root, range } = {}) {
  return [`--root=${root}`, `--range=${range}`];
}

/** Build the argv for the post-land id-collision heal (#2071). Passes `--onto-ref=<pre-merge-main sha>` when
 *  known (#2213): the files already published on the branch being landed ONTO are immutable keepers, so the
 *  INCOMING lane's newly-created file is the only legitimate yielder. WITHOUT it the heal yields the highest
 *  git-ordinal file — correct for a same-batch parallel land (neither file is on main yet) but WRONG for a
 *  resume land where a lagging `lane/*` authored FIRST lands LAST: the already-published main item then has the
 *  higher ordinal and would be renumbered out from under everything that cites it. Pure — returns the argv. */
export function buildRenumberHealArgs({ ontoRef } = {}) {
  const args = ['scripts/backlog-renumber-collisions.mjs', '--json'];
  if (ontoRef) args.push(`--onto-ref=${ontoRef}`);
  return args;
}

/**
 * #2312 — scope a heal's `git diff --name-only` output to ONLY the renumber plan's own touched paths, so
 * `runHeal` never builds its commit from the ambient checkout state. `plan` is the parsed JSON that
 * `backlog-renumber-collisions.mjs --json` prints (carries `writePaths`/`deletePaths`, the exact
 * `backlog/*.md` basenames this renumber wrote/deleted); `allChanged` is every path `git diff --name-only`
 * reports in the checkout AFTER running that CLI. Pure — no fs, no git.
 *
 * Splits `allChanged` into:
 *   - `changed` — the subset that IS one of the renumber's own expected paths (safe for `git add`).
 *   - `foreign` — anything else (a dirty tracked file the heal must NEVER commit — e.g. a concurrent
 *     session's in-flight edits sitting uncommitted in the SAME primary checkout, the #2301 "primary leak"
 *     class). A non-empty `foreign` means the checkout wasn't clean beyond the renumber's own writes; the
 *     caller must ABORT the heal rather than either (a) silently commit the foreign paths too (the bug this
 *     fixes — observed live, PR #168, #2312) or (b) silently drop them from `changed` and proceed (that
 *     would report `healed:true` while a real foreign edit is left half-adopted by a detached-HEAD checkout).
 * @param {{writePaths?:string[], deletePaths?:string[]}} plan
 * @param {string[]} allChanged
 * @returns {{changed:string[], foreign:string[]}}
 */
export function scopeHealChangedPaths(plan, allChanged) {
  const expected = new Set([
    ...(Array.isArray(plan?.writePaths) ? plan.writePaths : []),
    ...(Array.isArray(plan?.deletePaths) ? plan.deletePaths : []),
  ].map((name) => `backlog/${name}`));
  const changed = [];
  const foreign = [];
  for (const f of Array.isArray(allChanged) ? allChanged : []) {
    if (expected.has(f)) changed.push(f); else foreign.push(f);
  }
  return { changed, foreign };
}

/** The set of derived-artifact regen commands to run after a clean merge (#2182). Mirrors the drain's
 *  `DERIVED_REGEN` exactly — kept in lock-step so every land route (this CLI, `/pr`, `/drain` which reuses
 *  this) regenerates the same artifact set that the drain's Phase-4c step has always regenerated. Pure —
 *  returns an array of `[cmd, ...args]` tuples (same shape as `lane-drain.mjs`'s DERIVED_REGEN). */
export function buildRegenArgs() {
  return [
    ['npm', 'run', 'gen:inventory'],
    ['npm', 'run', 'gen:reference-index'],
  ];
}

/** #2225 secondary hardening — which post-land steps genuinely SKIPPED (so a real skip can't read as "did
 *  everything"). A step's result carries `skipped: true` when its dirty-probe bailed. Pure. */
export function postLandSkips(heal, regen) {
  const s = [];
  if (heal && heal.skipped) s.push('heal');
  if (regen && regen.skipped) s.push('regen');
  return s;
}

/**
 * #2218 — build the post-land heal/regen report SUFFIX for the success line, safely. Pure. The merge has
 * already SUCCEEDED, so this must NEVER throw: `regen`/`heal` are `null` on the `--no-heal`/`--no-regen` opt-out
 * and, on a dirty-checkout skip, carry `{ skipped: true }` with empty `done`. Reading `regen.done.length`
 * unguarded there threw a TypeError that misreported a completed land as a failure (surfaced landing #75). Every
 * read is optional-chained and a skipped step reports "skipped" (not a crash) / a no-op reports "none".
 * @param {null|{skipped?:boolean, healed?:boolean, renumbered?:{oldNum,newNum}[]}} heal
 * @param {null|{skipped?:boolean, done?:string[], failed?:{cmd:string}[]}} regen
 * @returns {string} e.g. `; healed id collision(s): #2219→#2220; regenerated: none` (or `''` when nothing to say)
 */
export function postLandReport(heal, regen) {
  const parts = [];
  if (heal?.skipped) parts.push('id-collision heal: skipped (tracked-dirty tree)');
  else if (heal?.healed && heal.renumbered?.length) parts.push(`healed id collision(s): ${heal.renumbered.map((r) => `#${r.oldNum}→#${r.newNum}`).join(', ')}`);

  if (regen?.skipped) parts.push('derived-artifact regen: skipped (tracked-dirty tree)');
  else if (regen) {
    const done = regen.done?.length ?? 0;
    const failed = regen.failed?.length ?? 0;
    if (done > 0) parts.push(`regenerated: ${regen.done.join(', ')}`);
    else if (failed === 0) parts.push('regenerated: none');
    if (failed > 0) parts.push(`regen failed (non-fatal): ${regen.failed.map((f) => f.cmd).join(', ')}`);
  }
  return parts.length ? `; ${parts.join('; ')}` : '';
}

/**
 * Classify `gh pr checks --json state,bucket` output (array of check rows) into a merge decision. Pure.
 *  - `pending` — at least one check still running/queued → wait.
 *  - `failed`  — at least one check failed/cancelled/timed-out → ABORT (never merge a red PR).
 *  - `passed`  — every check passed/skipped and none pending → mergeable.
 * Buckets follow `gh`: pass | fail | pending | skipping | cancel.
 */
export function classifyChecks(rows) {
  const checks = Array.isArray(rows) ? rows : [];
  if (checks.length === 0) return { status: 'passed', reason: 'no required checks' };
  const bucket = (c) => c.bucket || c.state || '';
  const isFail = (b) => ['fail', 'cancel', 'timed_out', 'timeout'].includes(String(b).toLowerCase());
  const isPending = (b) => ['pending', 'queued', 'in_progress', 'waiting'].includes(String(b).toLowerCase());
  if (checks.some((c) => isFail(bucket(c)))) return { status: 'failed', reason: 'a required check failed' };
  if (checks.some((c) => isPending(bucket(c)))) return { status: 'pending', reason: 'a required check is still running' };
  return { status: 'passed', reason: 'all required checks passed' };
}

/**
 * #2307 — resolve the review-escalation label pr-land should apply AT PR-OPEN (deterministically, never
 * lazily left to a later drain sweep — #2281's rule applied to the review dimension), from signals the
 * producer already has: the net two-dot diff (`changedFiles`/`diffLines`) and the lane's `.lane-manifest.json`
 * (`dismissedFindings`/`crossRepo`). Pure — wraps the shared rubric
 * (`scoreEscalation` → `producerReviewLabel`) plus the shared double-apply guard (`shouldApplyReviewLabel`),
 * the SAME two the drain (`merge-ai-prs.mjs`) reads back later, so producer- and drain-applied verdicts can
 * never drift. `currentLabels` is normally empty at open (a fresh PR) but is honoured either way — re-running
 * pr-land against an already-labelled PR (e.g. a retried `--label-on-green`) must not double-apply.
 *
 * #2890 — also accepts `diffHunks` (the net base-vs-head diff TEXT) and threads it straight into
 * `scoreEscalation`. Precondition plumbing only: no signal reads it yet. Per `scoreEscalation`'s contract the
 * default is `null` = NOT COMPUTED, distinct from `''` = computed and genuinely empty; callers derive it with
 * `computeNetDiffSignals(...).diffHunks`, never from a raw `.text` (#2890-review-fix finding 1).
 * #3317 — also accepts `cumulativeDiffLines` (the `mergeBase(origin/main, head)…head` line count) and threads it
 * into the rubric, which floors SIZE at it. Together with `humanBasisFiles` that makes EVERY signal cumulative,
 * so a stacked lane's self-declared `base` can no longer de-inflate the size or blast-radius the producer stamps.
 * `computeNetDiffSignals` supplies it off the already-resolved basis; omitting it is the pre-#3317 behaviour.
 * @param {{changedFiles?:string[], diffLines?:number, humanBasisFiles?:string[]|null, cumulativeDiffLines?:number|null,
 *          dismissedFindings?:number, crossRepo?:boolean, currentLabels?:Array, diffHunks?:string|null}} o
 * @returns {{label:string|null, apply:boolean, reasons:string[], humanRequired:boolean}}
 */
export function resolveProducerReviewLabel({
  changedFiles = [], diffLines = 0, humanBasisFiles = null, cumulativeDiffLines = null, dismissedFindings = 0, crossRepo = false, currentLabels = [], diffHunks = null, basisNarrowed = true, deviation = null,
} = {}) {
  // #3343 — `basisNarrowed` comes from `computeNetDiffSignals`: `false` means the cumulative file set is the
  // un-narrowed base TIP, so it may name files only upstream touched. It never relaxes the human gate (see
  // `scoreEscalation`); it only makes that fact visible on the verdict. Default `true` — a caller that supplies
  // nothing scores exactly as before.
  const score = scoreEscalation({ changedFiles, diffLines, humanBasisFiles, cumulativeDiffLines, dismissedFindings, crossRepo, diffHunks, basisNarrowed, deviation });
  const label = producerReviewLabel(score);
  // #2635 — expose the advisory care-level too, so the caller can recompute the jury roster (`resolveJuryPlan`)
  // for the SAME care band this rubric scored, then bind + reconcile it against the pre-registered roster.
  // #3317 — `basisFiles` (the honest cumulative-floored file set the rubric actually scored) rides along too, so
  // the roster recompute selects lenses over the SAME basis rather than the possibly de-inflated own delta.
  return { label, apply: shouldApplyReviewLabel(label, currentLabels), reasons: score.reasons, humanRequired: !!score.humanRequired, careLevel: score.careLevel, basisFiles: score.basisFiles, basisUntrusted: !!score.basisUntrusted };
}

/**
 * #2635 — BIND + RECONCILE the jury roster at PR-open against the REAL diff. Pure (both `resolveJuryPlan` and
 * `reconcileRoster` are pure — no I/O). Recomputes the roster from the ACTUAL net diff (`careLevel` +
 * `changedFiles` → the same care→roster pass the drain would run over this diff) and reconciles it against the
 * pre-registered roster (the item's charter roster, carried on the lane manifest when a prepare-time slice
 * recorded it) via `reconcileRoster`. Returns the effective (union) roster plus whether the real diff EXPANDED
 * past pre-registration — which, under the strict `up-front` timing default, re-triggers human alignment.
 *
 * `preRegistered == null` (no charter roster recorded yet) degrades to a pure BIND (no re-alignment). A falsy /
 * `none` care-level means the PR did not escalate, so there is no jury at all → an empty recomputed roster. The
 * timing mode comes from the human-gated care→jury contract (`POLICY_CARE_JURY.rosterTimingMode.value`), never a
 * hardcoded literal, so a governance flip of the knob is one contract edit.
 * @param {{careLevel?: string, changedFiles?: string[], preRegistered?: string[]|null, mode?: string}} o
 * @returns {{effective: string[], added: string[], removed: string[], expanded: boolean,
 *   humanAlignmentRequired: boolean, mode: string, reasons: string[]}}
 */
export function resolveRosterReconcile({ careLevel, changedFiles = [], preRegistered = null, mode } = {}) {
  const timing = mode || POLICY_CARE_JURY?.rosterTimingMode?.value || ROSTER_TIMING.UP_FRONT;
  const recomputed = careLevel
    ? resolveJuryPlan({ careLevel, changedFiles }).lenses.map((seat) => seat.lens)
    : [];
  return reconcileRoster({ preRegistered, recomputed, mode: timing });
}

/**
 * #2833's finish-guard decision, extracted so it is directly testable with a real (or fake) git runner instead
 * of only through source-text regex assertions on the CLI (converge round 1, correctness/security/standards-
 * conformance jurors — three independently flagged the same gap: the wiring that matters most for landing was
 * behaviorally untested). Reads the marker, computes the #4296 lane-relevant overlap for a stale-sha record
 * (never for an exact match — {@link laneRelevantChangeSinceForRecord} owns that guard), and returns the SAME
 * `verifyGateDecision` verdict the CLI's inline block acts on. Pure given `readMarker`/`runGit` — no CLI argv,
 * no `process.exit`, no gh.
 * @param {{gitDir: string, headSha: string, remote: string, base: string, runGit: (args: string[]) => string,
 *   readMarker: (gitDir: string) => object|null, breakGlass?: boolean, requireVerified?: boolean}} args
 * @returns {{ ok: boolean, status: string, reason: string, detail: string }}
 */
export function resolveFinishGuardVerdict({ gitDir, headSha, remote, base, runGit, readMarker, breakGlass = false, requireVerified = true }) {
  const verifyRecord = readMarker(gitDir);
  const laneRelevantChangeSinceRecord = laneRelevantChangeSinceForRecord({ record: verifyRecord, headSha, base: `${remote}/${base}`, runGit });
  return verifyGateDecision({ record: verifyRecord, headSha, breakGlass, requireVerified, laneRelevantChangeSince: laneRelevantChangeSinceRecord });
}

/** Preserve the original push error while explaining a rejected lane tip. */
export function pushFailedDetail(message, { SRC, REF, REMOTE }) {
  const full = String(message);
  const detail = `git push ${REMOTE} ${SRC}:refs/heads/${REF} failed (${full.split('\n')[0]})`;
  if (!/non-fast-forward|\[rejected\]|fetch first/i.test(full)) return detail;
  return detail + ` — the lane HEAD is not the tip of ${REF} — re-acquire a fresh lane with `
    + '`node we:scripts/lane-pool.mjs acquire --base=<tip>`'
    + ` (use --base=${REF} for the pushed tip), or fetch and rebase onto ${REMOTE}/${REF}, then re-run`;
}

// Allow importing the pure helpers without running the CLI (the test file imports this module).
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (IS_CLI) runCli();

function runCli() {
  const gitC = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  // #2217 — pr-land is a SANCTIONED main-writer (fallback-git merge, post-land heal/regen). Those pushes go to
  // `main`, so they must carry the MAIN_PUSH_OK=1 override the new pre-push hook (guard-git-push.mjs) checks —
  // otherwise the strict-lock hook would block pr-land's own legitimate landing. Scoped to THESE calls only, so
  // any OTHER (rogue/buggy) push to main stays blocked. The initial lane/* push does NOT use this (not main).
  const gitPushMain = (args) => execFileSync('git', ['push', ...args], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MAIN_PUSH_OK: '1' } }).toString().trim();
  const tryGit = (args) => { try { return gitC(args); } catch { return null; } };
  const forge = createGhLandProvider({ cwd: REPO }); // #3585 — every bare `gh` call below goes through this port

  // #2290 — the single-couple FAST DRAIN pr-land shells after labelling green so /pr still feels instant. The
  // drain is the sole writer to main; scoping it to this ONE PR (+ --this-repo) lands the couple immediately
  // instead of waiting for a full standalone sweep. Resolved off this module's own dir so it works from any cwd.
  const DRAIN_SCRIPT = resolve(fileURLToPath(new URL('./merge-ai-prs.mjs', import.meta.url)));
  // Best-effort: a non-zero drain (e.g. review parks the PR, or gh hiccups) NEVER fails the land — the PR is
  // already labelled `ready-to-merge`, so the standalone drain lands it on a later pass. Inherits stderr so the
  // drain's own land/park narration surfaces under /pr.
  const triggerSingleCoupleDrain = (prNum) => {
    if (!LABEL) return { triggered: false, reason: 'no label (nothing for the drain to collect)' };
    try {
      execFileSync('node', [DRAIN_SCRIPT, `--only=${prNum}`, `--label=${LABEL}`, '--this-repo'], { cwd: REPO, stdio: ['ignore', 'inherit', 'inherit'] });
      return { triggered: true };
    } catch (e) {
      if (!AS_JSON) process.stderr.write(`pr-land [${REPO}] · single-couple drain for #${prNum} did not land it (${String(e.message || e).split('\n')[0]}) — it stays labelled ${LABEL}; the standalone drain lands it later\n`);
      return { triggered: true, landed: false, detail: String(e.message || e).split('\n')[0] };
    }
  };

  function emit(result, exitCode) {
    // LIVE INCIDENT 2026-10-03/04, PR #3830: a `--label-on-green` run that ends red/timeout/behind left the PR with
    // NO label of any kind; once the fix daemon healed the red the PR sat green and label-less forever.
    let handOff = null;
    try { handOff = unlabelledHandOffLabel({ mode: PLAN.mode, reason: result?.reason, labelApplied, prNum }); } catch { /* emitted before the PR/plan existed (TDZ) — nothing to hand off */ }
    if (handOff) {
      try { forge.ensureLabel(handOff, { color: 'FBCA04', description: 'Review pending — an independent review is owed once required checks are green' }); } catch { /* already exists — fine */ }
      try { forge.addLabel(prNum, handOff); result = { ...result, handOffLabel: handOff }; }
      catch (e) { if (!AS_JSON) process.stderr.write(`pr-land [${REPO}] · could not hand #${prNum} off with "${handOff}" (${String(e.message || e).split('\n')[0]})\n`); }
    }
    if (AS_JSON) writeAllSync(1, JSON.stringify(result) + '\n');
    else {
      const tag = result.merged ? '✓ merged' : result.reason === 'dry-run' ? '· dry-run' : result.reason === 'opened' ? '· opened (no-wait)'
        : result.reason === 'parked' ? '· parked (review — held, not landed)'
        : result.reason === 'enqueued' ? '✓ enqueued (drain lands it)' : result.reason === 'labelled-on-green' ? '✓ labelled (drain lands it)'
        : result.reason === 'blocked-on-infra' ? '⊘ infra-blocked (recorded — auto-retry/resume)' : '✗ not merged';
      process.stderr.write(`pr-land [${result.repo}] ${tag}: ${result.detail}\n`);
    }
    process.exit(exitCode);
  }

  // #2659 — a `gh pr create` failure AFTER the lane ref was already pushed (step 2) is the PRE-PR infra-failure
  // case. If the error is a KNOWN-transient outside-dependency fault (a GitHub outage / network fault), the
  // built + pushed work must NOT hard-fail: it lands in the conveyor INFRA-BLOCKED state (#2659), which records
  // the resumable handle (ref/sha/base/body), auto-retries with backoff, and resume-opens the PR once infra
  // recovers — the drain still lands it (pr-land never merges; nothing is stranded). A NON-transient error (a
  // bad/empty body, auth, "a pull request already exists", validation) is NOT infra → the normal hard fail
  // (ghFailed) applies, never a doomed retry loop.
  function onCreateFailed(e) {
    const errText = `${String(e?.message || e)}\n${String(e?.stderr || '')}`;
    const { infra, cause } = classifyPrOpenFailure(errText);
    if (!infra) return ghFailed(`gh pr create failed (${String(e?.message || e).split('\n')[0]})`);
    // Record the pushed handle. pr-land runs in a LANE clone, so write the record into the PRIMARY checkout
    // (where the /conveyor tick's retry pass reads) via the clone's git alternates; fall back to this checkout
    // when not a lane clone (e.g. a direct /pr from the primary). Best-effort — a record hiccup never changes
    // the already-diagnosed outcome; the emit below still surfaces the resume handle.
    //
    // #<found this pass> — TWO bugs used to make a real infra block silently vanish (found while wiring the
    // gh-throttle self-calibration): (1) `itemNum`'s regex only matched the standard `lane/<NNN>` or
    // `lane/x<hash>` shapes; a ref like `lane/mark-3521-deliveryagent-codex` (a housekeeping/marker commit,
    // not a numbered backlog item) matched neither, so `itemNum` came back `null` — and
    // `recordInfraBlock`/`recordInfraBlockIO` treat a blank `num` as "nothing to track" and silently NO-OP
    // (never throw). (2) this code then set `recorded = true` unconditionally after the call merely finished
    // without THROWING, never checking whether the item was actually IN the store afterward — so a silent
    // no-op above was reported as a successful record, and the resume/retry loop had nothing to find. Fixed
    // by (a) falling back to the ref's own slug when the standard id patterns don't match — ANY lane ref is
    // now a valid tracking key, never dropped — and (b) reading the store back to confirm ground truth
    // instead of trusting a bare no-throw.
    const itemNum = (REF.match(/^lane\/(x[a-z0-9]{5,7}|\d+)/i) || [])[1] || REF.replace(/^lane\//, '').trim() || null;
    let recorded = false;
    try {
      const root = primaryRootFromClone(REPO) || REPO;
      const path = infraStorePath(root);
      recordInfraBlockIO({ num: itemNum, ref: REF, sha: refSha, base: BASE, repo: originSlugOf(REPO), cause, body: CREATE_BODY, builderContext: process.env.WE_BUILD_PR_CONTEXT || null }, { path });
      recorded = infraHas(readInfraStore(path), itemNum);
    } catch { /* best-effort */ }
    emit({
      repo: REPO, merged: false, reason: 'blocked-on-infra',
      num: itemNum, ref: REF, sha: refSha, base: BASE, cause, recorded,
      resumeHandle: { ref: REF, sha: refSha, base: BASE },
      detail: `PR-open failed on an outside dependency (${cause}) — lane ref ${REF} is PUSHED and recorded in the conveyor infra-blocked state${recorded ? '' : ' (record write failed — resume by hand from the ref)'}; it auto-retries + resume-opens once infra recovers (${BASE} left untouched, nothing stranded)`,
    }, 4);
  }

  if (Object.hasOwn(flags, 'delegation') && !DELEGATION_MARKER_LINE) {
    emit({ repo: REPO, merged: false, reason: 'bad-delegation', detail: `invalid --delegation — expected <provider>:<model>:<taskType> with non-empty whitespace-free tokens; taskType must be one of: ${DELEGATION_TASK_TYPES.join(', ')}` }, 3);
  }
  if (!REF) emit({ repo: REPO, merged: false, reason: 'no-ref', detail: 'pass --ref=lane/<name> (the head ref to land onto ' + BASE + ')' }, 3);
  if (!/^lane\//.test(REF)) emit({ repo: REPO, merged: false, reason: 'bad-ref', detail: `--ref="${REF}" must be a lane/* ref (the #1934 guard carve-out) — never a local branch` }, 3);
  // #2622 — `--park=<review:human|review:pending>`: open the PR with that review label already on it and STOP
  // (no green-wait, no ready-to-merge, no drain trigger). The first-class way to open a deliberately-held-for-
  // review PR through the producer, so an agent no longer reaches for `gh pr create` (which skips pr-land's
  // land-prep and can strand a new item's hash id). Resolved HERE (inside runCli) — not at module scope — so its
  // `resolveParkLabel` call sees the already-initialised `PARK_LABELS` const (a module-scope call would hit its
  // temporal dead zone). An invalid `--park` value is a fail-fast BEFORE any push/create, never a silent no-op.
  const PARK = resolveParkLabel(flags.park);
  if (PARK.park && !PARK.ok) emit({ repo: REPO, merged: false, reason: 'bad-park', detail: PARK.reason }, 3);

  // #2199/#2622 — resolve the land plan up front (wait/label/merge/park sequencing) so the dry-run plan reflects
  // it too. A validated `--park` label takes precedence over wait/label-on-green (see planPrLand).
  const PLAN = planPrLand({ wait: WAIT, labelOnGreen: LABEL_ON_GREEN, park: PARK.ok ? PARK.label : null });

  // 1. Resolve the SOURCE commit to publish (the lane clone's HEAD, or an explicit --sha). No local
  //    branch is created (that's guarded) — the lane model pushes `<source>:lane/<n>` straight to origin.
  const refSha = tryGit(['rev-parse', SRC]);
  // E3 (#3929) — record the producer's own hold in the verdict ledger, ALONGSIDE the label (strictly additive).
  // Fail-soft by construction: `recordParkVerdict` never throws, a miss is reported on stderr only, and nothing
  // here is read by any park / label / land decision. Written BEFORE the label call, like the drain's park.
  const ledgerProducerHold = (label, reason, prNumber) => {
    try {
      const slug = originSlugOf(REPO);
      if (!slug) return;
      const r = recordParkVerdict({ repo: slug, pr: prNumber, applyLabel: label, reason, headSha: refSha || null, declaredActor: 'producer', source: 'pr-land' });
      if (!r.ok && !AS_JSON) process.stderr.write(`pr-land [${REPO}] · verdict-ledger append (E3 #3929, producer hold, non-fatal) for #${prNumber} — ${r.errors.join('; ')}\n`);
    } catch { /* ledger miss never changes a hold */ }
  };
  if (!refSha) emit({ repo: REPO, merged: false, reason: 'no-such-src', detail: `source commit "${SRC}" not found — pass --sha=<commit> or run from a checkout whose HEAD carries the lane work` }, 3);

  // Derive a title when none was passed: `--fill` can't autofill for a lane/* head (it's remote-only, so
  // gh can't diff it locally). Use the source commit's subject — a meaningful, always-available title —
  // so the create never needs `--fill` and a `--body-file` (the #2170 dismissals) always ships. When the
  // source has multiple commits, validate its HEAD subject; legacy boilerplate needs real card metadata.
  const sourceTitle = TITLE ?? tryGit(['log', '-1', '--format=%s', SRC]);
  const titleItem = /^(?:WE|FUI|PLATEAU) #([a-z0-9]+):/i.exec(sourceTitle ?? '')?.[1];
  // ONE source of truth for the create params — the dry-run render below still needs the built ARGV (via
  // buildCreateArgs directly, nothing is executed there), while the real create goes through the port with
  // these same semantic params so the two never drift apart.
  // draft-first PRs — scoped to `park` only; see `DRAFT_OPT_OUT`'s own comment for why `land`/`label-on-green`
  // are excluded (their poll loop has no `'DRAFT'` branch and would spin to timeout).
  const DRAFT = resolveDraft({ mode: PLAN.mode, optOut: DRAFT_OPT_OUT, ref: REF, title: sourceTitle ?? '' });
  // Existing PRs keep their title even when their latest commit is a merge/repair. Only CREATE (or its
  // dry-run preview) reads this getter, so absent title metadata cannot block landing an existing PR.
  const createParams = { base: BASE, head: REF, body: CREATE_BODY, draft: DRAFT,
    get title() { return publicationTitle({ title: sourceTitle,
      card: titleItem ? readMainCard(titleItem, gitC) : null }); },
  };

  function soakCreatePrecheck() {
    if (!soakPrecheckEnabled()) return { ok: true, skipped: 'disabled' };
    let files;
    try {
      files = parseNameStatus(gitC(['diff', '--name-status', '-M', `${REMOTE}/${BASE}...${refSha}`]));
    } catch (e) {
      process.stderr.write(`pr-land [${REPO}] · soak precheck: diff unavailable (${String(e.message || e).split('\n')[0]}); CI still enforces it\n`);
      return { ok: true, skipped: 'diff unavailable; CI still enforces it' };
    }
    return soakPrecheckAtOpen({ title: createParams.title, body: CREATE_BODY, files });
  }

  if (DRY_RUN) {
    const createArgs = buildCreateArgs(createParams);
    const soak = soakCreatePrecheck();
    emit({
      repo: REPO, merged: false, reason: 'dry-run', ref: REF, base: BASE, method: METHOD,
      plan: [
        `node scripts/lint-locus-prefix.mjs ${buildLocusLintArgs({ root: REPO, range: `${REMOTE}/${BASE}..${refSha}` }).join(' ')}   # #2331 producer locus-prefix re-check (fail fast on the #2170 review-append leak) — swept in --root, the clone holding the commits (#3342)`,
        `soak precheck (if no PR exists yet): ${soak.ok ? soak.skipped || soak.reason : `REFUSE: ${soak.message}`}`,
        `git push ${REMOTE} ${SRC}:refs/heads/${REF}   # publish the lane clone's ${SRC} (${refSha.slice(0, 8)}) to the lane ref`,
        prCreateBodyGuard(BODY).ok ? `gh ${createArgs.join(' ')}` : `REFUSE (if no PR exists yet): ${prCreateBodyGuard(BODY).reason}  # #2332 fail-fast — an existing PR for this head is exempt`,
        PLAN.waitForChecks ? 'poll: gh pr view <pr> mergeStateStatus + gh pr checks <pr> --required  (wait until green; abort on red)'
          : PLAN.mode === 'park' ? '(--park: skip check-wait — the PR is HELD for review, not landed by this run)'
          : '(--no-wait: skip check-wait, leave for a later drain pass)',
        // #2199 — the label is applied ONLY after the required checks are green, never eagerly at open.
        LABEL && PLAN.labelWhenGreen ? `gh pr edit <pr> --add-label ${LABEL}   # #2196 label — applied ONLY once required checks pass (#2199)`
          : PLAN.mode === 'park' ? `gh pr edit <pr> --add-label ${PLAN.parkLabel}   # #2622 PARK — the review label applied AT OPEN; the PR is HELD (no ready-to-merge, no wait, no drain)`
          : PLAN.mode === 'open-only' ? '(--no-wait: PR opened UNLABELLED — CI not confirmed green; use --label-on-green)'
          : '(--no-label)',
        // #2307 — score the SAME deterministic rubric the drain uses and apply review:human/review:pending
        // AT OPEN when it escalates, so a PR needing review is never indistinguishable from a plain ready PR.
        PLAN.labelWhenGreen ? 'score scoreEscalation(net-diff, .lane-manifest.json) → gh pr edit <pr> --add-label review:human|review:pending (#2307, only when it escalates)' : null,
        // #2290 — pr-land NEVER merges (the drain is the sole writer to main). The default path triggers a
        // single-couple fast drain so /pr stays instant; --label-on-green stops (a standalone drain lands it).
        PLAN.triggerDrain
          ? `node scripts/merge-ai-prs.mjs --only=<pr> --label=${LABEL || 'ready-to-merge'} --this-repo   # #2290 single-couple FAST DRAIN (the drain lands it — pr-land never merges)`
          : PLAN.mode === 'park' ? '(--park: STOP — the PR is HELD review:*; a human clears it via /review, then the drain lands it)'
          : '(label-on-green: STOP after labelling — the standalone drain lands it; no direct merge here)',
        FALLBACK_GIT ? `fallback on failure (BREAK-GLASS only, WE_MERGE_BREAK_GLASS=1): git merge --no-ff ${REMOTE}/${REF} + push ${REMOTE} ${BASE}` : null,
      ].filter(Boolean),
      detail: `would open+label ${SRC} (${refSha.slice(0, 8)}) as a self-approved PR from ${REF}${PLAN.triggerDrain ? ' and trigger a single-couple drain' : ''} — the drain lands it onto ${BASE}`,
    }, 0);
  }

  // 1b. #2833 — THE VERIFICATION FINISH-GUARD. The observed stall: a build subagent backgrounded its long
  //     suite run, then yielded/terminated before it finished — the lane sat mid-flight, never erroring, and
  //     nothing reclaimed it, because a half-run verification LOOKED complete. This guard makes an unfinished
  //     verification NOT look complete: it reads the lane's `.git/.lane-verify` marker (written synchronously by
  //     `scripts/verify-lane.mjs`) and refuses to publish/land the source commit when that commit's verification
  //     is UNFINISHED (`running` — the exact stall), CORRUPT (marker present but unparseable), or — under
  //     BY DEFAULT since #3321 — absent or red. A `running` marker for THIS HEAD is ALWAYS refused (a half-run
  //     must never look complete); a `red` marker and a missing marker block unless the caller took the
  //     `--no-require-verified` opt-out, since the required CI check gates the merge for such a caller.
  //     #3321 — THE PARENTHETICAL HERE USED TO READ "a missing marker only blocks when verification is required
  //     (the CI-gated drain / parallel-workflow paths verify via the required GitHub check, not this marker, so
  //     they are not blocked)". That stated the mechanism BACKWARDS once the default flipped: those paths are not
  //     blocked because they now PASS `--no-require-verified` — the drain in `buildPrLandArgs`
  //     (we:scripts/lane-drain.mjs) and the parallel workflow at all four of its invocations
  //     (we:skills-src/batch-backlog-items/parallel-execute.workflow.js) — NOT because saying nothing is read as
  //     "not tracked here, go ahead". (This retraction itself named only the drain at first, while asserting both
  //     were handled; review round 2 caught that and the workflow was wired to match.) Saying
  //     nothing now means "verified, please". Left as written, the sentence would tell the next reader that a
  //     CI-gated caller needs no flag, which is exactly the wedge #3321's review caught.
  //     WE_LAND_UNVERIFIED=1 is the documented break-glass. Runs AFTER the dry-run block (a dry run reports the
  //     plan without being gated) and BEFORE any push.
  {
    // Resolve the marker in the REAL git dir (`.git` is a directory in a clone, a FILE in a worktree; #2833
    // finding 4) and read it through the SHARED reader `readVerifyMarker` (#2833 finding 2) — NEVER a hand-inlined
    // JSON.parse here: pr-land's old inline parser caught only a throw, so a valid-JSON non-object (`null`/`"x"`/
    // `[]`) slipped through as "no sha → untracked → land unverified". `readVerifyMarker` folds any such value to
    // `{ corrupt: true }` (refused), distinguishes a torn marker (corrupt → refuse) from a missing one (absent →
    // gate decides per --require-verified), and is the SAME read `verify-lane.mjs` performs.
    const gitDir = tryGit(['rev-parse', '--absolute-git-dir']) || join(REPO, '.git');
    // #4296 — a marker recorded for an EARLIER sha than `refSha` may still cover it (a no-op merge of BASE
    // conflicting only outside the lane's own touch-set). `resolveFinishGuardVerdict` owns the whole decision —
    // marker read, the lane-relevant overlap, and the `verifyGateDecision` call — so it is directly testable with
    // a real or fake git runner (see `scripts/__tests__/pr-land-finish-guard.test.mjs`), not only via the CLI's
    // own source-text wiring assertions.
    const gate = resolveFinishGuardVerdict({
      gitDir, headSha: refSha, remote: REMOTE, base: BASE, runGit: gitC, readMarker: readVerifyMarker,
      breakGlass: VERIFY_BREAK_GLASS, requireVerified: REQUIRE_VERIFIED,
    });
    if (!gate.ok) {
      emit({ repo: REPO, merged: false, reason: gate.reason, ref: REF, sha: refSha, verifyStatus: gate.status, detail: `refusing to land ${REF} — ${gate.detail} (${BASE} left untouched; this is #2833's stall guard)` }, 3);
    }
  }

  // 1c. #2331 — PRODUCER locus-prefix re-check. The #2170 pre-PR review can edit an item body AFTER the
  //     author's write-time gate ran (and via a route the PostToolUse hook does not see), leaking a bare
  //     code-path ref (#883) that only CI would catch — going red AFTER the PR is open. Re-lint THIS lane's
  //     OWN committed corpus changes (${REMOTE}/${BASE}..SRC) before publishing, so the producer fails fast,
  //     never CI. A real leak (linter exit 2) is a hard stop; any other failure (git/node infra) is
  //     best-effort — CI still backstops it — never a false block.
  //
  //     #3342 — the sweep is anchored with `--root=REPO`, the clone being landed FROM. `LOCUS_LINT` resolves
  //     off THIS script's location, and the linter used to read whichever clone it was found in; since
  //     pr-land normally runs from the primary checkout against a lane clone, the range named a commit the
  //     primary had never fetched and the sweep was skipped on essentially every lane-opened PR. It stays
  //     NON-fatal when it cannot run (an unreachable base / missing git must not block a build that CI still
  //     gates) — but no longer INVISIBLE: a completed sweep now says so on stderr, so "no line" means "did
  //     not run" instead of being indistinguishable from a pass, and the skip line names the swept root.
  const LOCUS_LINT = resolve(fileURLToPath(new URL('./lint-locus-prefix.mjs', import.meta.url)));
  const LOCUS_RANGE = `${REMOTE}/${BASE}..${refSha}`;
  try {
    execFileSync('node', [LOCUS_LINT, ...buildLocusLintArgs({ root: REPO, range: LOCUS_RANGE })], { cwd: REPO, stdio: ['ignore', 'inherit', 'inherit'] });
    if (!AS_JSON) process.stderr.write(`pr-land [${REPO}] · locus-prefix range sweep ran and is clean (${LOCUS_RANGE})\n`);
  }
  catch (e) {
    if (e && e.status === 2) emit({ repo: REPO, merged: false, reason: 'locus-prefix', detail: `bare code-path ref(s) without a <repo>: prefix in this lane's corpus changes (#883/#2331 — the #2170 review-append leak) — prefix them (e.g. "foo.ts" → "we:foo.ts"), \`git commit --amend\`, and re-run; refusing to open a PR CI would fail` }, 3);
    if (!AS_JSON) process.stderr.write(`pr-land [${REPO}] · locus-prefix range sweep DID NOT RUN over ${LOCUS_RANGE} in ${REPO} — this lane's corpus changes were NOT checked here (${String(e.message || e).split('\n')[0]}); CI still backstops it\n`);
  }

  // 1d. fix procedure (operator-approved 2026-09-27, live incident PR #2811) — refuse to push to a lane ref
  //     whose PR another fixer holds the LIVE fix claim on (`we:scripts/conveyor/fix-procedure.mjs`). Only the
  //     claim holder (same Claude session, or the same `WE_FIX_WHO` + `WE_FIX_TOKEN`) may push until its `fix-end`.
  {
    // `REPO` is the resolved checkout PATH (never a slug); read the URL of the remote this run actually pushes to.
    const refusal = pushRefusal({ repo: repoKeyForCheckout(REPO, { remote: REMOTE }), branch: REF, ...callerIdentity() });
    if (refusal) emit({ repo: REPO, merged: false, reason: 'fix-claimed', ref: REF, pr: refusal.pr, holder: refusal.holder, detail: refusal.message }, 3);
  }

  // Create only: existing PRs use their live body; lookup failure falls toward checking.
  let existingSoakPr = null;
  try { existingSoakPr = forge.listOpenByHead(REF)?.[0] ?? null; } catch { /* check locally */ }
  if (!existingSoakPr) {
    const soak = soakCreatePrecheck();
    if (!soak.ok) emit({ repo: REPO, merged: false, reason: 'soak-declaration', ref: REF, detail: soak.message }, 3);
    if (!AS_JSON && !soak.skipped?.startsWith('diff unavailable')) {
      process.stderr.write(`pr-land [${REPO}] · soak precheck: ${soak.skipped || soak.reason}\n`);
    }
  }

  // 2. Publish the source commit to the lane ref on origin (guard-safe: lane/*). Never force, no local branch.
  try { gitC(['push', REMOTE, `${SRC}:refs/heads/${REF}`]); }
  catch (e) { emit({ repo: REPO, merged: false, reason: 'push-failed', detail: pushFailedDetail(e.message || e, { SRC, REF, REMOTE }) }, 3); }

  // 2b. (#2291 — pruned) The PRE-CHECK id-collision self-heal (#2222) that used to run here is now DEAD wiring:
  //     under JIT numbering (#2288) a NEW backlog item is born with a collision-free hash id, never an `NNN`,
  //     so "this lane's new item reuses a base NNN" is structurally unrepresentable before the drain assigns
  //     the real number — this precheck could only ever return `{ action: 'none' }`. The shared collision-heal
  //     helper (`scripts/lib/nnn-collision-heal.mjs`) is NOT deleted — it is retained as a dormant backstop at
  //     the drain (`scripts/merge-ai-prs.mjs`'s `HEAL_COLLISION`, and folded into `rebase-drop-manifest.mjs`),
  //     the sole writer to main. pr-land no longer merges by default (#2290), so healing HERE, before a PR the
  //     drain will separately merge (and separately precheck-heal), was pure duplicated dead weight.

  // 3. Find an existing open PR for this head, else create a self-approved one.
  const buildContext = producerBuildContext();
  let prNum = null;
  try { prNum = forge.listOpenByHead(REF)?.[0]?.number ?? null; } catch { /* gh may be absent */ }
  if (prNum == null) {
    // #2332 — fail fast BEFORE creating: never open a bodyless PR (the #2324 drain gate would refuse to land
    // it, stalling the queue for a human to hand-fill the body). Create-path only — an existing PR is exempt.
    const bodyGuard = prCreateBodyGuard(BODY);
    if (!bodyGuard.ok) emit({ repo: REPO, merged: false, reason: 'empty-body', detail: `${bodyGuard.reason} (head ${REF})` }, 3);

    // we:xniq7xs — the open-PR backpressure limit. Too many open PRs is usually a REVIEW-SYSTEM problem
    // (the drain/review pipeline can't keep up), not a build problem, so a NEW PR over the per-repo cap is
    // refused HERE, AFTER the ref is already pushed (step 2 above) — the branch stays pushed; only the
    // `gh pr create` is skipped, exactly like the empty-body guard just above. Never runs for an EXISTING
    // PR (the `else` branch below) — fixing/re-pushing to an already-open PR is never blocked by this.
    {
      const repoKeyForLimit = repoKeyForSlug(originSlugOf(REPO)) || 'we';
      let changedFilesForLimit = [];
      try { changedFilesForLimit = gitC(['diff', '--name-only', '--no-renames', `${REMOTE}/${BASE}...${refSha}`]).split('\n').filter(Boolean); } catch { /* --no-renames: both sides of a rename, as `isCardOnlyDiff` requires; best-effort — an unresolvable diff degrades to "not exempt", never blocks on its own */ }
      const { count: openCount, limit, excludeCardOnly, cardOnly: cardOnlyExcluded, accepted: acceptedExcluded, stacked: stackedExcluded } = countOpenPrsForRepo(repoKeyForLimit);
      const limitDecision = decideOpenPr({
        repoKey: repoKeyForLimit, limit, openCount, cardOnlyExcluded, acceptedExcluded, stackedExcluded, excludeCardOnly, changedFiles: changedFilesForLimit, branch: REF,
        branchAllowed: isBranchAllowedLive(REF), globalOff: isGlobalOffLive(), forceOpen: FORCE_OPEN, forceReason: FORCE_OPEN_REASON,
      });
      if (!AS_JSON) process.stderr.write(`pr-land [${REPO}] · pr-limit(${repoKeyForLimit}): ${limitDecision.reason}\n`);
      if (!limitDecision.allowed) {
        emit({ repo: REPO, merged: false, reason: 'pr-limit', detail: `${limitDecision.reason} (ref ${REF} left pushed on ${REMOTE} — re-run pr-land once the count drops, or use one of the overrides named above)` }, 3);
      }
    }

    try { const out = forge.create(createParams); prNum = (out.match(/\/pull\/(\d+)/) || [])[1] ?? null; }
    catch (e) { return onCreateFailed(e); }
    if (prNum != null) checkpointBuildPr(buildContext, { repo: originSlugOf(REPO), pr: prNum, ref: REF });
  } else if (LANE_MANIFEST || AUTHOR_MARKER || DELEGATION_MARKER_LINE) {
    // xnsk54v — an existing PR (a re-run, or one opened before the manifest was ready) may lack the manifest
    // block the drain reads. Best-effort embed it (idempotent — embedManifestInBody replaces in place); a gh
    // hiccup never aborts a land, the drain's ref fallback still covers it.
    // #2844 — the same backfill carries the AUTHOR stamp, for the same reason: a PR this producer re-runs
    // against must not stay unstamped, or the autonomous seam refuses to ever auto-clear it. `withAuthorStamp`
    // is idempotent and never overwrites a stamp already present, so a re-run by a DIFFERENT session cannot
    // quietly re-attribute authorship to itself — the stamp already on the body is left alone. Note this is a
    // WRITE-side property only: the reader (`parseAuthorActorId`) is AGREEMENT-OR-NOTHING, NOT first-match — a
    // body that somehow ends up carrying two conflicting stamps resolves to '' (`unknown-author`), because
    // position in a body carries no temporal meaning. So the two halves agree on the outcome (the re-runner
    // never becomes the recorded author) by different means, and neither one "picks the first stamp".
    try {
      const liveBody = forge.viewPr(prNum, 'body').body || '';
      const updated = composePrBody(liveBody);
      if (updated !== liveBody) forge.editBody(prNum, updated);
    } catch { /* best-effort — drain ref fallback covers a miss */ }
  }
  if (prNum == null) return ghFailed('could not determine the PR number after create');

  // 3b. The producer-certified `ready-to-merge` label (#2196) is the universal signal the label lander (/drain)
  //     collects. #2199: it must mean "required checks GREEN", so it is applied ONLY after the green-wait below
  //     — NEVER eagerly at open. `applyLabel()` is the deferred, best-effort apply (ensure the label exists,
  //     then add it; a failure is recorded but never aborts — the PR is already open).
  let labelApplied = false;
  // #2832 / #984 finding 4 — a DELIBERATELY-held PR (the escalation verdict is a review-hold, so the strip below
  // removes `ready-to-merge`) needs its OWN signal, distinct from `labelApplied: false` (which also means "the
  // `--add-label` call FAILED"). The parallel-workflow Finalize (`parallel-execute.workflow.js`) treats a
  // `labelApplied:false` PR as a drain-invisible strand and RE-RUNS `pr-land --label-on-green` on it — which would
  // re-add the go-ahead this hold just stripped (a flip-flop) and record a false `carried-for-label`. Emitting
  // `held:true` lets that parser leave a held strand alone (it is held for review ON PURPOSE, not un-labelled by a
  // gh hiccup).
  let held = false;
  const applyLabel = () => {
    if (!LABEL || prNum == null) return; // same guard buildAddLabelArgs applies internally — don't run it twice
    try { forge.ensureLabel(LABEL, { color: '0E8A16', description: 'Producer-certified: required checks green, safe for the label lander (/drain) to merge' }); } catch { /* already exists — fine */ }
    try { forge.addLabel(prNum, LABEL); labelApplied = true; }
    catch (e) { if (!AS_JSON) process.stderr.write(`pr-land [${REPO}] · could not apply label "${LABEL}" to #${prNum} (${String(e.message || e).split('\n')[0]}) — land continues\n`); }
  };

  // #2307 — the deterministic REVIEW-ESCALATION label, applied AT PRODUCER TIME (never left for a later drain
  // sweep to be the first to apply it — #2281's rule applied to the review dimension). Scores the SAME rubric
  // the drain reads back later (`scoreEscalation`, shared module — see `resolveProducerReviewLabel` above) off
  // signals the producer already has once checks are green: the net two-dot diff (origin/BASE..refSha — the
  // content actually landing, not a stale PR `files` list) and the lane's `.lane-manifest.json`
  // (dismissedFindings / cross-repo couple shape). Best-effort: a
  // signal-fetch miss degrades to no-escalate — never blocks a green land over a scoring hiccup, and the
  // drain's own idempotent backstop pass still catches an unlabelled-but-should-be PR later.
  //
  // #2373 — the diff basis comes from `computeNetDiffChangedFiles` (SHARED with the drain backstop's own
  // scoring, in merge-ai-prs.mjs), which fetches `BASE` with an EXPLICIT destination refspec
  // (`+BASE:refs/remotes/REMOTE/BASE`) rather than a bare `git fetch REMOTE BASE`: the bare form relies on
  // git's opportunistic tracking-ref update and can silently leave a stale local `REMOTE/BASE` even after a
  // "successful" fetch, sweeping already-landed upstream commits (e.g. a gate-fix another lane merged onto
  // `main` between this lane's claim and its PR-open, live repro: PR #324) into the score as if the PR itself
  // touched them.
  const applyReviewEscalationLabel = () => {
    const exec = (cmd, args, opts) => execFileSync(cmd, args, { cwd: REPO, ...opts });
    // xnsk54v — prefer the SCRATCH manifest (--manifest-file, the new off-tree carrier); fall back to the
    // legacy tree-committed `.lane-manifest.json` off the ref for a lane that still commits it. Loaded BEFORE
    // the net diff so #2390's per-repo `base` can seed the diff basis.
    let manifest = LANE_MANIFEST;
    if (!manifest) {
      const manifestRaw = tryGit(['show', `${refSha}:.lane-manifest.json`]);
      if (manifestRaw) { try { manifest = JSON.parse(manifestRaw); } catch { /* malformed — degrade to no manifest signal */ } }
    }
    // #2390 — score this lane on its OWN delta from the manifest per-repo `base` (its predecessor's tip when
    // overlap-stacked), NOT the cumulative diff vs main — the SAME basis the drain backstop uses (#2373's
    // no-drift invariant). The repo key comes from this clone's origin slug; a sibling lane has no base → null →
    // the unchanged `origin/main` basis.
    const originSlug = (() => { try { const u = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); const m = u.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/); return m ? m[1] : null; } catch { return null; } })();
    const baseRev = manifestBaseForRepo(manifest, repoKeyFromSlug(originSlug));
    // #2890-review-fix finding 3 / #2890-review-r2 finding 3 — ALL of the net-diff escalation inputs come from
    // the ONE shared derivation in merge-ai-prs.mjs (`computeNetDiffSignals`), which the drain's scoring loop
    // also calls. It resolves the basis ONCE (one `git fetch`, one candidate probe) and feeds both the
    // changed-file shape and the diff TEXT off it: the first cut called them independently and re-ran the whole
    // of `resolveNetDiffBasis`, measured 5 → 11 git subprocesses and 1 → 2 network fetches per PR open; sharing
    // brings that to 6 subprocesses and 1 fetch. Assembling it here instead would leave that sharing — and the
    // `diffHunks` mapping below — pinned by nothing a test can observe at this call site.
    const sig = computeNetDiffSignals({ exec, remote: REMOTE, base: BASE, baseRev, rev: refSha });
    const changedFiles = sig.changedFiles;
    const diffLines = sig.diffLines;
    // #2390-review-fix — the CUMULATIVE origin/main…head basis the gate-self/human trigger scores over; a
    // stacked base de-inflates SIZE (`changedFiles`) but can never shrink this.
    const humanBasisFiles = sig.humanBasisFiles;
    // #3317 — the cumulative LINE count off that same basis. `humanBasisFiles` alone made only the human gate
    // un-shrinkable; this makes SIZE un-shrinkable too, so neither a stacked base nor the sanctioned
    // slice-into-two-PRs route can de-inflate the care level a PR opens with. Measurement only — size still
    // never refuses a PR (#3320), it only routes more reviewers at it.
    const cumulativeDiffLines = sig.cumulativeDiffLines;
    // #2890 — that same basis's TEXT (not just the changed-file/line-count shape above). #2890-review-fix
    // finding 1 — the shared derivation applies `diffHunksFrom`, so this is the text when it was really
    // computed and `null` when it was NOT; never a raw `.text`, which is `''` on every failure path and so
    // indistinguishable from a genuinely content-free diff. Still best-effort — an unresolvable basis degrades
    // to `null` and never blocks a green land — but the signal now SAYS it is absent instead of impersonating
    // an empty diff.
    const diffHunks = sig.diffHunks;
    const crossRepo = manifest && Array.isArray(manifest.repos) ? manifest.repos.length > 1 : false;
    const dismissedFindings = manifest && Number.isFinite(Number(manifest.dismissedFindings)) ? Number(manifest.dismissedFindings) : 0;
    let currentLabels = [];
    try { currentLabels = (forge.viewPr(prNum, 'labels').labels || []).map((l) => l.name); } catch { /* fresh PR — no labels yet */ }
    // #3343 — whether that cumulative basis is provably this PR's file set (merge-base / ancestry) or the
    // un-narrowed base TIP. `scored:false` means nothing was measured at all, which is a different fact from a
    // measurement taken on the wrong basis — don't stamp the un-narrowed reason on an empty score.
    const basisNarrowed = sig.scored ? sig.basisNarrowed !== false : true;
    const rubric = resolveProducerReviewLabel({ changedFiles, diffLines, humanBasisFiles, cumulativeDiffLines, dismissedFindings, crossRepo, currentLabels, diffHunks, basisNarrowed, deviation: parseDeviationDisclosure(BODY) });

    // #2635 — BIND + RECONCILE the jury roster against the REAL diff. The pre-registered roster (the item's
    // charter roster) rides the lane manifest when a prepare-time slice recorded it (`preRegisteredLenses`);
    // absent it, this is a pure bind (nothing to have drifted past). An expansion PAST pre-registration under the
    // strict `up-front` default re-triggers HUMAN alignment — so fold it into the producer verdict by UPGRADING
    // the review label to review:human (never a silent rebind). This only ever ADDS the human trigger; a
    // gate-self / statute change already forces review:human via the rubric and is never relaxed here.
    const preRegistered = manifest && Array.isArray(manifest.preRegisteredLenses) ? manifest.preRegisteredLenses : null;
    // #3317 — pick lenses over the rubric's own cumulative-floored basis, not the possibly de-inflated own delta:
    // a lens earned by an ANCESTOR's file is earned by the diff this PR merges. Falls back to `changedFiles` if a
    // caller ever hands back a verdict without it.
    const roster = resolveRosterReconcile({ careLevel: rubric.careLevel, changedFiles: rubric.basisFiles || changedFiles, preRegistered });
    const humanRequired = rubric.humanRequired || roster.humanAlignmentRequired;
    const finalLabel = humanRequired ? REVIEW_LABELS.human : rubric.label;
    const reasons = [...rubric.reasons, ...roster.reasons];
    const verdict = { label: finalLabel, apply: shouldApplyReviewLabel(finalLabel, currentLabels), reasons, humanRequired, roster };

    if (verdict.label && verdict.apply) {
      const meta = REVIEW_LABEL_META[verdict.label];
      try { forge.ensureLabel(verdict.label, { color: meta.color, description: meta.description }); } catch { /* already exists — fine */ }
      ledgerProducerHold(verdict.label, verdict.reasons.join('; ') || 'producer review escalation', prNum);
      try { forge.addLabel(prNum, verdict.label); }
      catch (e) { if (!AS_JSON) process.stderr.write(`pr-land [${REPO}] · could not apply review label "${verdict.label}" to #${prNum} (${String(e.message || e).split('\n')[0]}) — land continues\n`); }
      // mechanical-dispatcher — a PR that opens review:human also opens carrying review:awaiting-advisory: the
      // operator's standing rule is that no review:human PR is ever reviewed cold, and that "the advisory panel
      // hasn't posted yet" state has to be a visible label, not something inferred from a missing bot comment.
      // review-pr.mjs's `advise` step mechanically clears it the moment the panel actually posts (#xlw02hw).
      if (verdict.label === REVIEW_LABELS.human && shouldApplyReviewLabel(REVIEW_LABELS.awaitingAdvisory, currentLabels)) {
        const awaitMeta = REVIEW_LABEL_META[REVIEW_LABELS.awaitingAdvisory];
        try { forge.ensureLabel(REVIEW_LABELS.awaitingAdvisory, { color: awaitMeta.color, description: awaitMeta.description }); } catch { /* already exists — fine */ }
        try { forge.addLabel(prNum, REVIEW_LABELS.awaitingAdvisory); }
        catch (e) { if (!AS_JSON) process.stderr.write(`pr-land [${REPO}] · could not apply "${REVIEW_LABELS.awaitingAdvisory}" to #${prNum} (${String(e.message || e).split('\n')[0]}) — land continues\n`); }
      }
      // Stamp the WHY into the PR body (mirrors the drain's #2324 guarantee) so an operator sees it without
      // re-deriving the rubric — and, for #2635, so the roster-expansion re-alignment reason is trailed where
      // the jury ledger (#2641) will read it. Best-effort. #3044 — RECONCILE, not guard-then-append: a re-run
      // that scores a different reason set than the first park now replaces the stale block instead of leaving
      // it stamped once; a re-run that scores the SAME set writes nothing (`changed:false`), so this stays
      // idempotent. The RAW-text duplicate-append guard did not go away — it moved INSIDE the reconcile
      // function, which is the only place it can now be stated once for both write sites. It is still
      // load-bearing: "would this duplicate" is a different question from "is there a trustworthy record",
      // and answering it from the trusted reader made a body that blanks its own appended block (an unclosed
      // fence) re-append on every pass, unboundedly.
      try {
        let liveBody = '';
        try { liveBody = forge.viewPr(prNum, 'body').body || ''; } catch { /* fetch miss — augment from empty */ }
        const reconciled = reconcileEscalationReasonBlock(liveBody, verdict.reasons);
        if (reconciled.changed) forge.editBody(prNum, reconciled.body);
      } catch { /* best-effort — the label already carries the signal */ }
    }
    // #2832 — the producer applies `ready-to-merge` (applyLabel, on green) BEFORE this escalation verdict. When
    // the verdict is a review-HOLD (review:human/pending/changes), that go-ahead and the hold would coexist —
    // the exact contradictory state this item removes. Strip `ready-to-merge` in the same producer step so the
    // held-AND-ready window is closed at the source, not left to the next drain sweep. #984 review (reviewer B) —
    // this is add-then-strip EVENTUAL CONSISTENCY, not construction-time atomicity: GitHub has no atomic
    // multi-label swap, so there is a sub-second window where both labels coexist, and the strip is best-effort (a
    // gh miss leaves the PR held-and-ready until the drain reconcile strips it next pass). It is never a merge-
    // safety hole regardless: the drain's merge gate independently re-checks `hasUnclearedReviewLabel` and PARKS a
    // held PR whether or not `ready-to-merge` is present — the label is only a collection filter, not the land gate.
    //
    // #984 findings 4+5 — `decideHoldReadyStrip` (pure) makes both calls off the OBSERVED label set: `held` (this
    // PR is deliberately held for review — the #4 signal, distinct from `labelApplied:false` apply-failure) and
    // `strip` (the PR observably carries `ready-to-merge` while held, so remove it — gated on what the PR actually
    // holds, NOT on whether THIS run's applyLabel add succeeded, #5).
    const holdDecision = decideHoldReadyStrip(verdict.label, currentLabels, { labelApplied });
    if (holdDecision.held) held = true;
    if (holdDecision.strip) {
      try { forge.removeLabel(prNum, READY_TO_MERGE_LABEL); labelApplied = false; }
      catch (e) { if (!AS_JSON) process.stderr.write(`pr-land [${REPO}] · #${prNum} held ${verdict.label} — could not strip ${READY_TO_MERGE_LABEL} (${String(e.message || e).split('\n')[0]}); the drain reconcile will strip it (#2832)\n`); }
    }
    return verdict;
  };

  // open-only (`--no-wait`, no `--label-on-green`): open WITHOUT the `ready-to-merge` landing-gate label
  // (nothing has confirmed it green) and leave it. #2421 — this is NOT an ambiguous bare state read from a
  // label's absence: the drain's total ci-lifecycle reconcile (`lifecycleLabelFromCiTruth`,
  // `merge-ai-prs.mjs`'s `reconcileCiLifecycleLabels`, every drain pass + `--watch` interval) picks up this PR
  // on its next sweep and applies `checking`/`ci:failed`/`blocked` from CI truth — never per-check-tick writes
  // from HERE. `ready-to-merge` itself keeps its unchanged landing-gate absence-semantics (#2183 F1/#2138 F4):
  // its absence still means "not queued"; the label lander won't collect a red PR either way. A producer that
  // wants the drain to land it must use `--label-on-green` (wait → label when green → hand off).
  if (PLAN.mode === 'open-only') {
    // #3902 (live 2026-10-04) — open-only used to skip the #2307 review-escalation score entirely, so a
    // `--no-wait` PR opened with NO review label and depended on the drain's land-time pass to score it — which
    // only sees fully-green merge candidates. PR #3902 went red before that and was never reviewed. The score
    // needs no green (net diff + manifest), so apply it AT OPEN, like every other producer mode. Best-effort.
    let openVerdict = null;
    try { openVerdict = applyReviewEscalationLabel(); } catch { /* a scoring miss never blocks the open */ }
    if (openVerdict?.label && !AS_JSON) process.stderr.write(`pr-land [${REPO}] · #${prNum} review-escalation at open → ${openVerdict.label}\n`);
    if (!AS_JSON && LABEL) process.stderr.write(`pr-land [${REPO}] · #${prNum} opened UNLABELLED (--no-wait): use --label-on-green so the ${LABEL} label is applied only when required checks pass; the drain's ci-lifecycle reconcile labels its checking/ci:failed/blocked state on its next sweep (#2421)\n`);
    emit({ repo: REPO, merged: false, reason: 'opened', pr: Number(prNum), ref: REF, label: null, labelApplied: false, ...(openVerdict?.label ? { reviewLabel: openVerdict.label, reviewLabelApplied: openVerdict.apply } : {}), detail: `opened self-approved PR #${prNum} for ${REF} (--no-wait, no ready-to-merge label yet — CI not confirmed green; the drain's ci-lifecycle reconcile covers its checking/ci:failed/blocked state, #2421)` }, 0);
  }

  // #2622 — PARK mode (`--park=review:human|review:pending`): the PR is open (through the SAME producer create
  // path above — locus-prefix re-check, body guard, manifest embed, JIT/#2288 land-prep — never a `gh pr create`
  // bypass). Apply the caller-chosen review label AT OPEN (the #2307 determinism, caller-chosen rather than
  // rubric-scored) and STOP: no green-wait, no `ready-to-merge` (PLAN.labelWhenGreen is false → applyLabel and
  // the escalation-scorer below never run), no drain trigger. A parked PR is meant to sit for review; the drain
  // numbers any born-as-hash item AT LAND once a human clears the review — the SAME footing as an auto-landing
  // PR (numbering stays JIT, never minted early on the branch, which would defeat parallel-lane collision
  // avoidance). Provision the label on demand (mirrors the escalation-label path) so a fresh repo has it.
  if (PLAN.mode === 'park') {
    const parkLabel = PLAN.parkLabel;
    const meta = REVIEW_LABEL_META[parkLabel];
    let parkApplied = false;
    try { forge.ensureLabel(parkLabel, { color: meta.color, description: meta.description }); } catch { /* already exists — fine */ }
    ledgerProducerHold(parkLabel, `producer --park ${parkLabel}`, prNum);
    try { forge.addLabel(prNum, parkLabel); parkApplied = true; }
    catch (e) { if (!AS_JSON) process.stderr.write(`pr-land [${REPO}] · could not apply park label "${parkLabel}" to #${prNum} (${String(e.message || e).split('\n')[0]}) — the PR IS open; set the label by hand\n`); }
    emit({
      repo: REPO, merged: false, reason: 'parked', pr: Number(prNum), ref: REF,
      // #984 review (R4) — a `--park` PR is HELD by definition (opened straight into a review hold, never
      // labelled ready-to-merge). Emit `held:true` — same as the escalation-verdict hold path — so the
      // parallel-workflow Finalize treats it as a deliberate hold, NOT a `labelApplied:false` un-labelled strand
      // to re-run `pr-land --label-on-green` on (which would stamp the go-ahead onto a held PR — the flip-flop).
      label: null, labelApplied: false, held: true, reviewLabel: parkLabel, reviewLabelApplied: parkApplied,
      // draft-first PRs — `draft:true` here means GitHub itself will never surface this for review until the
      // daemon calls `gh pr ready` on it (`reconcile-core.mjs`'s `promote-draft` dispatch, fired once every
      // required check is green); `false` means either `--no-draft` opted out or `gh` failed to open it as a
      // draft (see `detail` for which).
      draft: DRAFT,
      detail: `opened self-approved PR #${prNum} for ${REF} PARKED ${parkLabel}${DRAFT ? ' as a DRAFT (promoted by the daemon once required checks are green — draft-first PRs)' : ''} (${parkApplied ? `labelled ${parkLabel}` : 'label apply FAILED — set it by hand'}) — held for review, NOT waited/labelled ready-to-merge/landed; the drain numbers any born-as-hash item at land once a human clears the review`,
    }, 0);
  }

  // 4. Wait until GitHub itself says the PR is ready, then merge. We gate on the AUTHORITATIVE
  //    `mergeStateStatus` (not a raw `gh pr checks` list) — a fresh PR's checks haven't registered yet, so
  //    an empty check list must NOT read as "passed" (that races the merge to a BLOCKED state). We ALSO
  //    read the REQUIRED checks so a genuinely-failed required check aborts fast instead of waiting out the
  //    timeout. Non-required checks (e.g. `cla`) never block: only the branch-protection required set does.
  //      CLEAN    → all required checks passed + up-to-date → merge.
  //      UNSTABLE → mergeable, but a NON-required check failed/pending → merge iff required checks passed.
  //      BLOCKED  → a required check is pending (wait) or failed (the required-check read aborts us).
  //      BEHIND   → strict "up-to-date" needs the ref rebased onto BASE → abort (recoverable; rebase+re-run).
  //      DIRTY    → real conflict → abort (the drain serial-replays / rebases).
  const deadlineMs = Date.now() + (Number(flags['timeout-min'] || 15) * 60_000);
  for (;;) {
    let view = {};
    try { view = forge.viewPr(prNum, 'mergeable,mergeStateStatus'); } catch { view = {}; }
    let required = [];
    try { required = forge.requiredChecks(prNum); } catch { required = []; }
    const reqVerdict = classifyChecks(required);
    const state = view.mergeStateStatus || 'UNKNOWN';

    const verdict = pollVerdict({ state, checkStatus: reqVerdict.status, requiredCount: required.length, labelWhenGreen: !!PLAN.labelWhenGreen, conflicting: view.mergeable === 'CONFLICTING' });
    if (verdict === 'conflict') emit({ repo: REPO, merged: false, reason: 'conflict', pr: Number(prNum), detail: `PR #${prNum} has merge conflicts with ${BASE} — ${BASE} left untouched (rebase the ref + re-run, or --fallback-git)` }, 3);
    // #2421 — this abort intentionally does NOT write a `ci:failed` label itself (never a per-check-tick
    // pr-land write, per the #2281 ruling): the drain's `reconcileCiLifecycleLabels` reads the SAME required-
    // check truth on its next sweep and applies `ci:failed`, so a PR left here is never a permanently-ambiguous
    // bare state — just a producer-side exit the drain's self-healing reconcile corrects shortly after.
    if (verdict === 'red') emit({ repo: REPO, merged: false, reason: 'check-red', pr: Number(prNum), detail: `PR #${prNum} required check RED — ${reqVerdict.reason}; ${BASE} left untouched (fix + re-run) — the drain's ci-lifecycle reconcile will label it ci:failed (#2421)` }, 2);
    if (verdict === 'behind') emit({ repo: REPO, merged: false, reason: 'behind', pr: Number(prNum), detail: `PR #${prNum} is behind ${BASE} (strict up-to-date) — rebase the ref onto ${BASE} + re-run` }, 3);
    if (verdict === 'label') break; // ready: green (for BEHIND, a NON-EMPTY green set) → apply the producer label
    // verdict === 'wait' → not ready yet (checks pending / BLOCKED); keep polling until the timeout. A timeout
    // below likewise leaves the PR for the drain's reconcile to label `checking`/`ci:failed` from CI truth —
    // never inferred from this exit's absence of a label (#2421).
    if (Date.now() > deadlineMs) emit({ repo: REPO, merged: false, reason: 'check-timeout', pr: Number(prNum), detail: `PR #${prNum} not ready past timeout (mergeStateStatus=${state}); leaving for a later drain pass — the drain's ci-lifecycle reconcile covers its labelling (#2421)` }, 3);
    execFileSync('sleep', ['20']);
  }

  // Required checks are GREEN — before labelling, refuse to land a PR carrying an empty/whitespace description
  // (#2324: PR #206 landed bodyless even though a body is nominally required — enforce it here, loud, not as
  // unenforced skill prose). Read the PR's LIVE body (not just the `--body`/`--body-file` this invocation
  // passed) since an already-open PR found via `gh pr list --head` may predate this run; a fetch miss falls
  // back to the body this invocation supplied, defaulting to "no body confirmed" (fail-safe, never fail-open).
  if (PLAN.labelWhenGreen) {
    let liveBody = BODY;
    try { const v = forge.viewPr(prNum, 'body'); if (typeof v.body === 'string') liveBody = v.body; } catch { /* gh miss — fall back to the body this invocation supplied, if any */ }
    if (!hasNonEmptyBody(liveBody)) {
      emit({ repo: REPO, merged: false, reason: 'empty-body', pr: Number(prNum), detail: `PR #${prNum} has an empty/whitespace description — refusing to land it (pass --body-file with a real summary of what changed and why; #2324); ${BASE} left untouched` }, 3);
    }
  }

  // Required checks are GREEN — NOW apply the producer-certified label (#2199: never before this point).
  if (PLAN.labelWhenGreen) applyLabel();

  // #2307 — and the deterministic review-escalation label (review:human / review:pending), alongside
  // ready-to-merge — a green producer PR IS ready; the review label is the *landing gate*, which the drain
  // already honours (a couple with a human-required half withholds via the existing blockedBy/crossRepo path).
  const reviewVerdict = PLAN.labelWhenGreen ? applyReviewEscalationLabel() : { label: null, apply: false, reasons: [], humanRequired: false };

  // #2290 — pr-land NEVER merges: the drain is the SOLE writer to main. In the DEFAULT (land) mode, trigger a
  // single-couple FAST DRAIN so /pr still feels instant — the drain lands THIS labelled PR immediately. Then
  // best-effort ff-sync the user's PRIMARY checkout to the just-advanced origin/main (a no-op if the drain
  // parked the PR instead of landing it). `--label-on-green` skips the trigger (a batch/workflow closeout runs
  // the standalone drain over the whole set). The trigger NEVER fails the land — the PR is labelled either way.
  let drainTrigger = null;
  let primarySynced = null;
  if (PLAN.triggerDrain) {
    drainTrigger = triggerSingleCoupleDrain(prNum);
    if (SYNC_PRIMARY) primarySynced = syncPrimaryMain();
  }
  emit({
    repo: REPO, merged: false, reason: PLAN.triggerDrain ? 'enqueued' : 'labelled-on-green',
    pr: Number(prNum), ref: REF, label: LABEL, labelApplied,
    // #984 finding 4 — `held:true` marks a DELIBERATE review-hold (ready-to-merge stripped on purpose), so the
    // parallel-workflow Finalize does NOT mistake it for a `labelApplied:false` apply-failure to re-label.
    ...(held ? { held: true } : {}),
    ...(reviewVerdict.label ? { reviewLabel: reviewVerdict.label, reviewLabelApplied: reviewVerdict.apply, escalateReasons: reviewVerdict.reasons, humanRequired: reviewVerdict.humanRequired } : {}),
    // #2635 — surface the bound jury roster + any expansion-past-registration (the ledger flag the #2641 durable
    // log will consume; observable today in the producer's JSON result). Emitted whenever a roster was bound.
    ...(reviewVerdict.roster && reviewVerdict.roster.effective.length ? { juryRoster: reviewVerdict.roster.effective, rosterExpanded: reviewVerdict.roster.expanded, ...(reviewVerdict.roster.added.length ? { rosterAdded: reviewVerdict.roster.added } : {}) } : {}),
    ...(drainTrigger ? { drainTriggered: !!drainTrigger.triggered } : {}),
    ...(primarySynced !== null ? { primarySynced } : {}),
    detail: `PR #${prNum} (${REF}) required checks green${labelApplied ? ` — labelled ${LABEL}` : ''}`
      + (reviewVerdict.label ? `${reviewVerdict.apply ? ' — labelled' : ' — already labelled'} ${reviewVerdict.label} (${reviewVerdict.reasons.join('; ')})` : '')
      + (PLAN.triggerDrain ? '; triggered a single-couple drain (the drain lands it — pr-land never merges)' : '; left for the drain to land'),
  }, 0);

  // ff-sync the user's PRIMARY checkout after a land. The drain (a separate process, shelled by the trigger, or
  // the fallback-git merge below) advanced origin/main; the primary is a SEPARATE directory that otherwise
  // drifts behind origin/main on every land (the "N behind" a human then has to pull by hand). The lane→primary
  // link is the clone's git alternates: a lane is `git clone --reference <primary>`, so
  // `<REPO>/.git/objects/info/alternates` points at `<primary>/.git/objects` — strip the two trailing segments
  // to get the primary root. Returns:
  //   null  — nothing to sync (REPO is not a lane clone, or IS the primary)
  //   true  — primary fast-forwarded (or already up-to-date)
  //   false — skipped/failed (primary not on BASE, or a genuine divergence) — REPORTED, never fatal.
  // ff-only + --autostash: advance main, preserve the user's dirty/session-state edits, never force/rebase.
  function syncPrimaryMain() {
    let primary;
    try {
      const alt = readFileSync(resolve(REPO, '.git/objects/info/alternates'), 'utf8').trim().split('\n')[0];
      if (!alt) return null;                       // no alternates content
      primary = resolve(alt, '..', '..');          // <primary>/.git/objects → <primary>
    } catch { return null; }                       // no alternates file → REPO is not a lane clone
    try { if (realpathSync(primary) === realpathSync(REPO)) return null; } // running FROM the primary — already synced
    catch { return null; }
    const atPrimary = (args) => execFileSync('git', ['-C', primary, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    // Only fast-forward a primary that is actually on BASE — never yank a detached / feature checkout out from under the user.
    let branch = null; try { branch = atPrimary(['rev-parse', '--abbrev-ref', 'HEAD']); } catch { /* unknown */ }
    if (branch !== BASE) {
      if (!AS_JSON) process.stderr.write(`pr-land [${REPO}] · primary checkout (${primary}) not on ${BASE} (on ${branch || 'unknown'}) — skipped primary ff-sync; pull it by hand\n`);
      return false;
    }
    try { atPrimary(['pull', '--ff-only', '--autostash']); return true; }
    catch { if (!AS_JSON) process.stderr.write(`pr-land [${REPO}] · primary ${BASE} (${primary}) NOT fast-forwarded (diverged, or a reapplied local edit conflicts) — pull it by hand\n`); return false; }
  }

  // Fallback path (#2138 Fork 5 (a)): local git merge + push when gh is the problem. #2290 — this is ALSO a
  // write to main, so it routes through the shared gate as caller 'pr-land': the gate BLOCKS it (throws) unless
  // the documented `WE_MERGE_BREAK_GLASS=1` admin override is armed. i.e. --fallback-git is now break-glass-only
  // (the drain is the sole normal-path writer to main); the gate's throw surfaces as a `fallback-failed` emit.
  function ghFailed(detail) {
    if (!FALLBACK_GIT) emit({ repo: REPO, merged: false, reason: 'gh-error', detail: `${detail} — pass --fallback-git for the local git-merge fallback` }, 3);
    try {
      // #2290 — assert this route may write to main BEFORE touching git (blocked unless break-glass, and a
      // break-glass use emits the loud audit line). Capture the pre-merge base sha for the heal's onto-ref.
      assertMayMerge({ caller: 'pr-land', pr: null, repo: REPO });
      const preMergeBaseSha = tryGit(['rev-parse', `${REMOTE}/${BASE}`]) || null;
      tryGit(['fetch', REMOTE, `${REF}`, '--quiet']);
      gitC(['checkout', BASE]);
      gitC(['merge', '--no-ff', `${REMOTE}/${REF}`, '-m', `merge ${REF} (pr-land git fallback)`]);
      // JIT numbering (#2288 / #xzxc92d): the fallback-git merge is a LAND path too — the last one #2288 left
      // un-numbered. Number every provisional hash file the merge just brought onto BASE BEFORE the push, so
      // no hash strands on main (this is the exact route that stranded #xzxc92d itself). Shares lane-drain's
      // `numberPendingHashes` (single source, never a fork); it commits the rename+rewrite locally, so the push
      // below carries the numbering to main together with the merge. Best-effort — a numbering error is
      // surfaced but never unwinds the successful merge (the post-land heal is the collision backstop).
      // #2391 — number+publish is the NUMBERING CRITICAL SECTION (sole-serial-writer, #2288/#2290). Wrap it in
      // the TTL-bounded numbering mutex so this break-glass land never races a concurrent drain onto the same NNN.
      const numLock = withNumberingLock(() => {
        const n = numberPendingHashes(REPO);
        if (n && n.error) process.stderr.write(`pr-land [${REPO}] ⚠ JIT numbering skipped (${n.error}) — a provisional hash may reach ${BASE} un-numbered; run the drain's numbering by hand\n`);
        gitPushMain([REMOTE, `${BASE}:${BASE}`]);
        return n;
      });
      const numbered = numLock.result;
      if (numLock.contended) process.stderr.write(`pr-land [${REPO}] ⚠ numbering mutex not acquired (held by ${numLock.heldBy || '?'}) — numbered+pushed without it (#2391); the #2318 duplicate-NNN tripwire is the backstop\n`);
      if (SYNC_PRIMARY) syncPrimaryMain(); // ff-sync the user's primary checkout too (the lane's local BASE is already merged)
      // #xsyia6k — snapshot the duplicate set on BASE BEFORE the heal mutates the local tree. gitPushMain above
      // just published the merged tree to ${BASE}, so this reflects what actually sits on BASE; the tripwire below
      // falls back to it when the heal healed-but-didn't-publish (else it would read the healed-but-unpushed local
      // dir as clean — the read-local-tree hazard the drain's tripwire guards with `healPublished`).
      const preHealDups = findDuplicateIds(resolve(REPO, 'backlog'));
      const heal = HEAL ? runHeal({ ontoRef: preMergeBaseSha }) : null;
      if (heal && heal.warning) process.stderr.write(`pr-land [${REPO}] ⚠ ${heal.warning}\n`);
      const regen = REGEN ? runRegen() : null;
      if (regen && regen.warning) process.stderr.write(`pr-land [${REPO}] ⚠ ${regen.warning}\n`);
      const skipped = postLandSkips(heal, regen);
      if (skipped.length) process.stderr.write(`pr-land [${REPO}] ⚠⚠ POST-LAND ${skipped.join(' + ')} SKIPPED (tracked-dirty tree) — ${BASE} may carry an unhealed id collision / stale derived artifacts; run the steps by hand.\n`);
      // #2318 — post-land DUPLICATE-NNN tripwire. runHeal above renumbers an intra-corpus collision, but if a
      // duplicate SURVIVES (heal skipped on a dirty tree, or a mode the healer can't resolve), it must be LOUD,
      // never silent on main. Re-detect after the heal and surface it so the fallback-git land can't leave a
      // duplicate id sitting on ${BASE} (the #2316 double-land failure mode).
      // #xsyia6k — but runHeal WRITES the renumber to the local tree before it gates/commits/pushes, so a heal that
      // healed-but-didn't-publish (gate red, or push failed → `renumbered.length && !healed`) leaves the local dir
      // clean while ${BASE} still holds the dup. Trust the fresh scan only then; otherwise report the pre-heal set.
      const healUnpublished = !!(heal && Array.isArray(heal.renumbered) && heal.renumbered.length && !heal.healed);
      const residualDups = healUnpublished ? preHealDups : findDuplicateIds(resolve(REPO, 'backlog'));
      if (residualDups.length) process.stderr.write(`pr-land [${REPO}] ✗✗ TRIPWIRE (#2318): duplicate id(s) on ${BASE} after heal — ${summarizeDuplicates(residualDups)}; resolve by hand (${BASE}'s standards gate will stay RED until then).\n`);
      emit({ repo: REPO, merged: true, reason: 'merged-git-fallback', ref: REF, healed: heal && heal.healed ? heal.renumbered : [], ...(heal && heal.warning ? { healWarning: heal.warning } : {}), ...(numbered && numbered.assigned && numbered.assigned.length ? { numbered: numbered.assigned } : {}), regenDone: regen ? regen.done : [], regenFailed: regen ? regen.failed : [], ...(regen && regen.warning ? { regenWarning: regen.warning } : {}), ...(skipped.length ? { skipped } : {}), ...(residualDups.length ? { duplicateIdsOnMain: residualDups } : {}), detail: `${detail}; landed ${REF} onto ${BASE} via the local git-merge fallback${numbered && numbered.assigned && numbered.assigned.length ? `; JIT-numbered ${numbered.assigned.map((a) => `${a.hash}→#${a.nnn}`).join(', ')}` : ''}${residualDups.length ? `; ⚠ DUPLICATE ids survive: ${summarizeDuplicates(residualDups)}` : ''}${postLandReport(heal, regen)}` }, 0);
    } catch (e) {
      emit({ repo: REPO, merged: false, reason: 'fallback-failed', detail: `${detail}; git-merge fallback ALSO failed (${String(e.message || e).split('\n')[0]}) — ${BASE} left untouched` }, 3);
    }
  }

  // Post-land id-collision heal (#2071, generalized). After a clean merge, sync to POST-MERGE ${BASE}
  // (detached — never rewriting a local branch, so an accidental --repo=<primary-with-work> can't be reset
  // out from under the user) and run the sanctioned renumber-collisions script with NO --base-ref: on
  // post-merge main any duplicate NNN is a real allocation collision and the newest (just-merged) file
  // yields. If it renumbered, gate the healed tree, then commit + push the fix (never force-pushed). A heal
  // problem is REPORTED but NEVER fails the land — the merge already succeeded; the worst case is a loudly-
  // surfaced residual a human resolves, exactly as the batch integrator's heal step behaves.
  function runHeal({ ontoRef = null } = {}) {
    const firstLine = (e) => String((e && e.message) || e).split('\n')[0];
    // #2225 — ignore untracked/git-ignored noise (the deps-symlinked clone's `node_modules` symlink); skip only
    // on a genuinely TRACKED-dirty tree (a detached checkout could carry those edits into the heal commit).
    if (isPostLandTreeDirty(tryGit(['status', '--porcelain', '--untracked-files=no']))) return { skipped: true, warning: `skipped id-collision heal — the checkout at ${REPO} has TRACKED local changes (won't reset a dirty working tree); if the gate flags "ids must be unique", run scripts/backlog-renumber-collisions.mjs on ${BASE} by hand` };
    try {
      gitC(['fetch', REMOTE, BASE, '--quiet']);
      gitC(['checkout', '--detach', `${REMOTE}/${BASE}`]);
    } catch (e) { return { warning: `skipped id-collision heal — could not sync to ${REMOTE}/${BASE} (${firstLine(e)})` }; }
    let plan;
    try {
      const out = execFileSync('node', buildRenumberHealArgs({ ontoRef }), { cwd: REPO, encoding: 'utf8' });
      plan = JSON.parse((out.trim().split('\n').filter(Boolean).pop()) || '{}');
    } catch (e) { return { warning: `id-collision heal could not run renumber-collisions (${firstLine(e)}) — if the gate flags "ids must be unique", run it by hand on ${BASE}` }; }
    const renumbered = Array.isArray(plan.renumbered) ? plan.renumbered : [];
    if (renumbered.length === 0) return { healed: false, renumbered: [] };
    const tag = renumbered.map((r) => `#${r.oldNum}→#${r.newNum}`).join(', ');
    // A collision was healed on disk — full-gate the healed tree before committing (never push a red heal).
    try {
      const admitted = admittedArgv('npm', ['run', 'check:standards']);
      execFileSync(admitted.file, admitted.args, {
        cwd: REPO, stdio: 'ignore',
        // #2548 — this self-check runs on an unpushed, freshly-renumbered tree (checkout --detach at
        // origin/main + the heal's own uncommitted writes) that the hand-numbered-item gate cannot tell
        // apart from a real mistake by git state alone; the heal IS the sanctioned numbering path.
        env: { ...process.env, WE_SKIP_HAND_NUMBERED_GATE: '1' },
      });
    }
    catch { return { healed: false, renumbered, warning: `id collision healed (${tag}) but check:standards is RED on the healed tree — NOT pushed; fix on ${BASE} by hand` }; }
    // #2312 — SCOPE the commit to the renumber's OWN file set (`plan.writePaths`/`deletePaths`), never a bare
    // `git diff --name-only`. This checkout is often the user's PRIMARY (REPO defaults to `process.cwd()`, and
    // the detached checkout above deliberately never resets a local branch so an accidental
    // `--repo=<primary-with-work>` isn't yanked out from under the user, see the comment above `runHeal`) — it
    // can carry OTHER dirty tracked files from a concurrent session's in-flight work (the exact #2301 "primary
    // leak" class: agent-memory/skill/script edits sitting uncommitted). A bare unscoped diff would sweep those
    // straight into this heal's commit and land them on `${BASE}` (observed live, PR #168, #2312). If the diff
    // carries anything OUTSIDE the renumber's own paths, ABORT loud rather than silently drop or silently land
    // foreign content — mirrors the #2290 regen fix's `outputPaths` discipline.
    const allChanged = (tryGit(['diff', '--name-only']) || '').split('\n').filter(Boolean);
    const { changed, foreign } = scopeHealChangedPaths(plan, allChanged);
    if (foreign.length) return { healed: false, renumbered, warning: `id collision healed on disk but the checkout at ${REPO} also carries FOREIGN tracked change(s) outside the renumber's own file set (${foreign.join(', ')}) — ABORTING the heal (nothing committed/pushed) to avoid landing foreign content; reset this checkout to a clean ${BASE} and re-run, or run scripts/backlog-renumber-collisions.mjs on ${BASE} by hand` };
    if (changed.length === 0) return { healed: false, renumbered };
    try {
      gitC(['add', ...changed]);
      gitC(['commit', '-m', `backlog: heal new-item id collision(s) on land (${tag}) (#2071)`]);
      gitPushMain([REMOTE, `HEAD:${BASE}`]);
    } catch (e) { return { healed: false, renumbered, warning: `id collision healed + committed but push to ${BASE} failed (${firstLine(e)}) — re-run pr-land or push by hand (no force-push)` }; }
    return { healed: true, renumbered };
  }

  // Post-land derived-artifact regen (#2182). After a clean merge, run the same deterministic generators
  // the drain's Phase 4c runs — once per land so every land route (this CLI, `/pr`, `/drain`) keeps `main`
  // free of stale derived output. Mirrors the drain's `regenDerived()`: best-effort, never fatal. If
  // anything changed, commit + push (the generators are deterministic — a diff means the inputs changed).
  // A regen problem is REPORTED but NEVER fails the land (the merge already succeeded).
  function runRegen() {
    const firstLine = (e) => String((e && e.message) || e).split('\n')[0];
    // Sync to post-merge main so we regenerate against the LANDED tree (same tree the drain regen targets).
    // Skip only if TRACKED-dirty (#2225) — untracked noise like the deps-symlinked clone's `node_modules`
    // symlink is irrelevant; a tracked-dirty tree could be generating against uncommitted input, which is wrong.
    if (isPostLandTreeDirty(tryGit(['status', '--porcelain', '--untracked-files=no']))) return { done: [], failed: [], skipped: true, warning: `skipped derived-artifact regen — the checkout at ${REPO} has TRACKED local changes; run npm run gen:inventory && npm run gen:reference-index on ${BASE} by hand` };
    try {
      gitC(['fetch', REMOTE, BASE, '--quiet']);
      gitC(['checkout', '--detach', `${REMOTE}/${BASE}`]);
    } catch (e) { return { done: [], failed: [], warning: `skipped derived-artifact regen — could not sync to ${REMOTE}/${BASE} (${firstLine(e)})` }; }
    const done = [];
    const failed = [];
    for (const [cmd, ...args] of buildRegenArgs()) {
      try { execFileSync(cmd, args, { cwd: REPO, stdio: ['ignore', 'ignore', 'pipe'] }); done.push([cmd, ...args].join(' ')); }
      catch (e) { failed.push({ cmd: [cmd, ...args].join(' '), detail: firstLine(e) }); }
    }
    if (done.length === 0) return { done, failed, warning: failed.length > 0 ? `derived-artifact regen failed (non-fatal): ${failed.map((f) => f.cmd).join(', ')}` : undefined };
    const changed = (tryGit(['diff', '--name-only']) || '').split('\n').filter(Boolean);
    if (changed.length === 0) return { done, failed }; // regen was a no-op (inputs didn't change)
    try {
      gitC(['add', ...changed]);
      gitC(['commit', '-m', `chore: regen derived artifacts post-land (#2182) [${done.map((c) => c.replace('npm run ', '')).join(', ')}]`]);
      gitPushMain([REMOTE, `HEAD:${BASE}`]);
    } catch (e) { return { done, failed, warning: `derived-artifact regen committed but push to ${BASE} failed (${firstLine(e)}) — re-run gen:inventory + gen:reference-index on ${BASE} by hand` }; }
    return { done, failed };
  }
}
