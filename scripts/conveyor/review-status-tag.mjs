#!/usr/bin/env node
/**
 * @file scripts/conveyor/review-status-tag.mjs
 * @description Tag a PR with an INFORMATIVE `review-status:<state>` label — "is a reviewer or a fixer
 *   currently working this PR right now, and is it actually making progress or stuck" — derived from live
 *   `claude agents --json` truth. Exception: an existing `review-status:draft-withdrawn` is a durable
 *   operator hold, read by promotion guards. Automatic writers preserve that label until explicit release.
 *
 * WHY THIS EXISTS (the operator, 2026-09-01): "expose if a reviewing is currently reviewing and if a fixer is
 * currently fixing... an understand if the agent crash it might hang, but better visibility on what is
 * actioned upon." A `blocked` (stuck, possibly hung) session is exactly the class of hazard this epic already
 * found live tonight (a 211-hour-held permission block, named in `we:scripts/conveyor/reconcile-core.mjs`'s own
 * docblock) — so `stalled` is a first-class state here, not an afterthought.
 *
 * "PERIODICALLY... REAL STATE AND TAG STAY ALIGNED" (the operator's own follow-up: no new internal design
 * needed) — this rides the SAME `we:skills-src/conveyor/runner.mjs` tick that already dispatches reviews/fixes
 * every ~120s, exactly like `review-round-tag.mjs` does. Every tick re-derives from a fresh `claude agents
 * --json` read and re-applies the label idempotently — self-correcting by construction, no separate poller.
 *
 * DELIBERATELY INDEPENDENT of `we:scripts/conveyor/reconcile-core.mjs`'s own liveness binding (`assessLiveness`)
 * — that exact code path is under live suspicion tonight (#xh0vtzh, the confirmed review-dispatch double-spawn
 * bug), so this reads `claude agents --json` fresh and matches by session NAME only (`review-<pr>` /
 * `fix-<pr>`, the same slugs `we:scripts/operations/review-dispatch.mjs#reviewSessionSlug` and
 * `we:scripts/operations/dispatch-lane.mjs`'s own `fix-${id}` mint), rather than sharing that binding.
 */
import { latestCiHealEscalationForHead } from './ci-heal-escalation-mark.mjs';
import { mintSessionSlug } from './session-slug.mjs';
import { readLiveFixClaim, FIX_DRAFT_REASONS } from './fix-procedure.mjs';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listAgentsWithReviewJobs } from '../operations/review-job-store.mjs';
import { createGhProvider } from '../lib/review-label-provider.mjs';
import { writeAllSync, writeLineSync } from '../lib/write-all-sync.mjs';

/** Matches this module's own label shape, and only this shape.
 *
 *  `awaiting-base` — a draft stacked on a non-default branch waits for its base PR to land.
 *
 *  `awaiting-ci` (draft-first PRs, operator-approved 2026-09-27) — added alongside the five LIVE-agent states
 *  below, though it is not one: it names a draft PR (`scripts/pr-land.mjs --park`'s new draft-by-default
 *  open) that no agent is, or should be, working — no review is dispatched for it until `scripts/conveyor/
 *  reconcile-core.mjs`'s `promote-draft` effect un-drafts it on green CI. Deterministic off the SAME PR
 *  record this module already reads (`pr.isDraft`), never off a fabricated "idle" guess — the exact bar
 *  `planStatusLabelChange`'s own docblock already holds every OTHER state here to. This is the operator-
 *  visible answer to "why hasn't this been reviewed yet" the feature's own build brief asked for.
 *
 *  `fixing-conflict` / `fixing-conflict-stalled` (draft reason at a glance, operator ask 2026-09-27, #2811
 *  follow-up, #2826) — a live `fix-<pr>` session is not always the SAME repair: `we:scripts/conveyor/
 *  rearm-review.mjs` already distinguishes a MECHANICAL conflict-resolution round (`--round=conflict`) from an
 *  ordinary review:changes bounce fix at the marker-comment layer, but nothing said so on the label a human
 *  glances at — both read as the same generic `fixing`. Deterministic off the SAME PR record every other
 *  state here already reads (`pr.mergeStateStatus === 'DIRTY'`, the identical field `reconcile-core.mjs
 *  #classifyPr`'s `conflicted` phase reads), never a fabricated guess: a live fixer working a PR GitHub
 *  itself reports as conflicting IS resolving that conflict, whatever else it might also be doing.
 *
 *  `draft-scope-change` / `draft-withdrawn` (fix-claim draft-only-on-withdrawal, operator ruling 2026-09-27,
 *  `we:docs/agent/platform-decisions.md#fix-claim-draft-only-on-withdrawal`, backlog `xyfvtfz`) — the two
 *  reasons `fix-procedure.mjs#fixBegin` ever converts a PR to draft, each with its own label named at
 *  `fix-begin` time (mutually exclusive with `fixing`/each other and with `awaiting-ci` — see
 *  {@link deriveReviewStatus}'s own `fixClaim` branch for how a LIVE claim's recorded reason is read back so
 *  this reconciler's own periodic pass never fights `fix-begin`'s freshly-applied label). */
export const STATUS_LABEL_RE = /^review-status:(reviewing|review-stalled|fixing|fix-stalled|fixing-conflict|fixing-conflict-stalled|healing-ci|ci-heal-stalled|awaiting-ci|awaiting-base|draft-scope-change|draft-withdrawn|needs-human)$/;

/**
 * `claude agents --json` states this module treats as LIVE — something is currently actioned, or stuck trying
 * to be. `working` is real progress; `blocked` is the confirmed hang shape this module exists to surface (the
 * 211-hour permission-block this epic found live, `we:scripts/conveyor/reconcile-core.mjs`'s own docblock).
 * Every OTHER state — `done` above all — is NOT live: `claude agents --json` never prunes a finished session,
 * so a `done` row for `review-<pr>`/`fix-<pr>` can sit there indefinitely, long after the PR merged. Reading
 * `done` as "stalled" would tag every PR that ever had a review dispatched as permanently stuck — worse than
 * no signal at all. `done` (and anything unrecognized) means: nothing is being actioned on this PR right now.
 */
const LIVE_STATES = Object.freeze({ working: 'reviewing', blocked: 'stalled' });

/**
 * PURE: find the LIVE agent session (if any) bound to `pr` by NAME alone (`review-<pr>` / `fix-<pr>` /
 * `ci-heal-<pr>`) and classify it. See {@link LIVE_STATES} for exactly which raw states count as live.
 *
 * `ci-heal` ADDED (live gap found 2026-09-26, epic #4075/#3383, alongside the conflict-bounce audit this
 * module's own header describes): a red required check with a live `ci-heal-<pr>` session
 * (`we:scripts/operations/ci-heal-pr-dispatch.mjs`, minted via the SAME `mintSessionSlug`/`PR_KINDS` this file
 * already imports — `ci-heal` has been a first-class `PR_KINDS` entry since #3438/#3967) had NO representation
 * in this vocabulary at all: `deriveReviewStatus` only ever checked `review-<pr>`/`fix-<pr>`, so a PR mid-CI-heal
 * showed no `review-status:*` label whatsoever — indistinguishable from a PR nothing is touching. Checked
 * THIRD, after `review`/`fix`: a PR is never simultaneously owed a review/fix dispatch AND a ci-heal one
 * (`we:scripts/conveyor/reconcile-core.mjs#classifyPr`'s `ci-red` phase is its own branch ahead of the
 * `OWED`/`OWED_ELSEWHERE` table), so the ordering is precedence-in-name-only — it never actually shadows a
 * real ci-heal for a PR that also has a stale review/fix session row sitting in `claude agents --json`.
 * @param {{pr:number|string, agents?:Array<{name?:string, state?:string}>, isDraft?:boolean, baseRefName?:string, defaultBranch?:string, mergeConflicted?:boolean, fixClaim?:object|null, escalation?:object|null}} o
 * @returns {{role:'review'|'fix'|'ci-heal'|'draft', state:'reviewing'|'review-stalled'|'fixing'|'fix-stalled'|'fixing-conflict'|'fixing-conflict-stalled'|'healing-ci'|'ci-heal-stalled'|'awaiting-ci'|'awaiting-base'|'draft-scope-change'|'draft-withdrawn'|'needs-human'}|null}
 */
export function deriveReviewStatus({ pr, agents = [], repo = 'we', isDraft = false, baseRefName, defaultBranch = 'main', mergeConflicted = false, fixClaim = null, escalation = null } = {}) {
  const reviewName = mintSessionSlug({ kind: 'review', id: pr, repo });
  const fixName = mintSessionSlug({ kind: 'fix', id: pr, repo });
  const ciHealName = mintSessionSlug({ kind: 'ci-heal', id: pr, repo });
  const list = Array.isArray(agents) ? agents : [];
  // Live incident 2026-09-28 (we#2852): `we:scripts/conveyor/reconcile-core.mjs`'s own `markSelfReportedDone`/
  // `markAuthExpiredSessions`/`markIdleFinishedSessions` already stamp a FINISHED verdict onto these SAME agent
  // rows (wired in by `we:scripts/conveyor/reconcile-pass.mjs#defaultReadAgents`, which the review daemon feeds
  // straight into this function via `tagReviewStatus`'s `agents` param) — but this module used to look at
  // nothing except the raw `claude agents --json` `state`, so a ci-heal session that had genuinely finished
  // (its own completion record said `done`, its dispatch claim was released) still read as `blocked` here
  // forever — the CLI never prunes a finished row — and got tagged `ci-heal-stalled`, which
  // `we:scripts/conveyor/build-dispatch-policy.mjs` then read as a landing freeze on EVERY queued build. A row
  // bearing any of these three markers is finished — exclude it from `LIVE_STATES` matching regardless of its
  // raw `state`, mirroring `reconcile-core.mjs#assessLiveness`'s own `isFinished`.
  //
  // DELIBERATELY NOT excluding `hung: true` here, unlike `assessLiveness` (which treats `hung` as finished too,
  // because ITS job is "may I redispatch a fresh session" — a hung session must not block that). This module's
  // job is the opposite: surfacing to a human that a session may be stuck (the 211-hour permission-block hazard
  // its own header names) — a transcript that has gone stale with no self-report is exactly that hazard, not
  // evidence of a clean finish, so it must keep reading as `-stalled`.
  const isFinishedOverride = (a) => a?.selfReportedDone === true || a?.authExpired === true || a?.idleFinished === true;
  // Prefer a `working` match over a `blocked` one for the SAME name (several historical rows can share a
  // name) — a session actually making progress right now is more informative than a stuck sibling. A `done`/
  // other row is simply not a candidate at all — see LIVE_STATES.
  const liveFor = (name) => {
    const matches = list.filter((a) => a?.name === name && Object.hasOwn(LIVE_STATES, a.state) && !isFinishedOverride(a));
    return matches.find((a) => a.state === 'working') ?? matches[0] ?? null;
  };
  if (escalation?.outcome === 'needs-human') return { role: 'ci-heal', state: 'needs-human' };
  const review = liveFor(reviewName);
  if (review) return { role: 'review', state: review.state === 'working' ? 'reviewing' : 'review-stalled' };
  // fix procedure (operator-approved 2026-09-27) — a LIVE fix claim (`fix-procedure.mjs`) is `fixing` whoever
  // holds it: an orchestrator worker is not a `fix-<pr>` session, and without this the tagger would strip the
  // `review-status:fixing` label `fix-begin` just set on the very next tick.
  //
  // draft-only-on-withdrawal (backlog `xyfvtfz`) — a claim that drafted the PR recorded WHY on the claim
  // itself (`fixBegin`'s own `draft`/`reason` meta, read back here via `fixClaim.meta`): read that back
  // verbatim rather than re-deriving it, so this reconciler's own periodic pass never fights the label
  // `fix-begin` just applied for the SAME reason `awaiting-ci` doesn't fight a draft-first PR's label.
  if (fixClaim) {
    const meta = fixClaim.meta ?? fixClaim;
    if (meta?.draft && FIX_DRAFT_REASONS.includes(meta.reason)) return { role: 'fix', state: `draft-${meta.reason}` };
    return { role: 'fix', state: mergeConflicted ? 'fixing-conflict' : 'fixing' };
  }
  const fix = liveFor(fixName);
  if (fix) {
    // `fixing-conflict` (see STATUS_LABEL_RE's own doc) — the ONE case a `fix-<pr>` session's generic label
    // gets a more specific name, and only from a fact already on the PR record, never a guess at intent.
    const base = mergeConflicted ? 'fixing-conflict' : 'fixing';
    return { role: 'fix', state: fix.state === 'working' ? base : (mergeConflicted ? 'fixing-conflict-stalled' : 'fix-stalled') };
  }
  const ciHeal = liveFor(ciHealName);
  if (ciHeal) return { role: 'ci-heal', state: ciHeal.state === 'working' ? 'healing-ci' : 'ci-heal-stalled' };
  // draft-first PRs (operator-approved 2026-09-27) — checked LAST, after every live-agent match above: a
  // ci-heal genuinely healing a red-required-check draft is more informative than a blanket "awaiting-ci" and
  // must still read `healing-ci`/`ci-heal-stalled` (a draft is never exempt from CI healing — only from
  // review, see `dispatchReviewRow`'s own `isDraft` gate). Only once NOTHING is live does a draft PR get its
  // own state at all: "awaiting-ci" — deterministic off the PR record (`pr.isDraft`), never a fabricated idle
  // guess, and the operator-visible answer to "why hasn't this been reviewed yet" (no `review:*` label match
  // needed: the label lander already knows this is a draft the moment `isDraft` is true).
  if (isDraft) return { role: 'draft', state: baseRefName && baseRefName !== defaultBranch ? 'awaiting-base' : 'awaiting-ci' };
  return null;
}

/**
 * PURE: what to add/remove so `currentLabels` shows EXACTLY the derived status label, or NO `review-status:*`
 * label at all when nothing is live, except an existing withdrawal hold, which takes precedence.
 * @param {{status:{state:string}|null, currentLabels?:Array<{name?:string}|string>}} o
 * @returns {{add:string|null, remove:string[]}}
 */
export function planStatusLabelChange({ status, currentLabels = [] } = {}) {
  const names = currentLabels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
  // Withdrawal is an explicit hold; expiry and automatic status changes cannot release it.
  const desired = names.includes('review-status:draft-withdrawn')
    ? 'review-status:draft-withdrawn' : status ? `review-status:${status.state}` : null;
  const stale = names.filter((n) => STATUS_LABEL_RE.test(n) && n !== desired);
  const alreadyCorrect = (desired ? names.includes(desired) : true) && stale.length === 0;
  return { add: alreadyCorrect ? null : desired, remove: stale };
}

/**
 * PURE (#4967): ONE plain review state for a PR, so a viewer never has to reconcile raw labels that read as
 * contradictory — live case PR #3490 carried `review:changes` + `review:human` + `review-status:fixing` at once.
 * `review:human` there does NOT mean "waiting on the operator now"; it means a human approval is still owed AFTER
 * the send-back fix. When BOTH `review:changes` and `review:human` are present this names that sequence; a
 * fixer claim is made only for a LIVE fixer state. Otherwise it falls back to the single existing state (the
 * status label's own state, or the lone review label). DERIVED, never a new `review-status:*` label, so
 * {@link STATUS_LABEL_RE} / {@link planStatusLabelChange} and every other label consumer are untouched.
 * @param {{labels?:Array<{name?:string}|string>, status?:{state:string}|null}} o
 * @returns {{code:string, text:string}|null} `null` when there is no review state to show at all
 */
export function describeReviewState({ labels = [], status = null } = {}) {
  const names = (Array.isArray(labels) ? labels : []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
  const state = status?.state ?? null;
  if (names.includes('review:changes') && names.includes('review:human')) {
    if (state === 'fixing' || state === 'fixing-conflict') {
      return { code: 'fixing-then-human', text: 'fixing the send-back, then needs operator approval' };
    }
    if (state === 'fix-stalled' || state === 'fixing-conflict-stalled') {
      return { code: 'fix-stalled-then-human', text: 'send-back fix stalled, then needs operator approval' };
    }
    return { code: 'changes-waiting-then-human', text: 'send-back waiting for a fix, then needs operator approval' };
  }
  // A preserved draft-withdrawn label is a durable state that wins over a derived one (see the label planner).
  if (names.includes('review-status:draft-withdrawn')) return { code: 'draft-withdrawn', text: 'draft withdrawn' };
  if (state) return { code: state, text: state.replaceAll('-', ' ') };
  const lone = names.find((n) => /^review:(changes|human|pending|accepted)$/.test(n));
  return lone ? { code: lone, text: lone.replace(':', ' ') } : null;
}

/**
 * THE IO SHELL. Reads live agents + the PR's current labels, derives the status, applies the change only if
 * one is needed. Both reads are injectable so a test asserts behavior with no `claude`/`gh` process.
 *
 * `agents`/`currentLabels`, WHEN SUPPLIED, SKIP `listAgents()`/`provider.readLabels` ENTIRELY (#4133, epic
 * #3383/#4075 — audit `we:reports/2026-09-24-daemon-blocking-antipatterns.md` finding R2): this function used
 * to spend a FRESH `claude agents --json` AND a fresh `gh pr view --json labels` call for EVERY status
 * candidate a tick tags, even though `we:scripts/conveyor/reconcile-pass.mjs`'s own `defaultReadPrs`/
 * `defaultReadAgents` already read both, once, for the whole tick. A caller with that data in hand
 * (`we:skills-src/conveyor/review-daemon.mjs#runReviewTick`, wired to reuse it) passes it straight through.
 * Omitting either (the default, and every pre-existing caller/test) reads fresh, byte-identical to before
 * these options existed.
 * @param {{pr:number|string, repo:string, listAgents?:Function, provider?:object, agents?:Array<object>, currentLabels?:Array<{name?:string}|string>, isDraft?:boolean, baseRefName?:string, defaultBranch?:string, mergeConflicted?:boolean, readFixClaim?:Function}} o
 * @returns {{changed:boolean, label:string|null, removed:string[], reviewState:{code:string, text:string}|null}}
 */
// x26lw6u — the default listing includes live review JOBS (`we:scripts/operations/review-job.mjs`): a review no
// longer runs as a `claude --bg` session, so without them every job-run review would read as "nothing live" and
// never carry `review-status:reviewing`.
export function tagReviewStatus({
  pr, repo, listAgents = () => listAgentsWithReviewJobs(), provider = createGhProvider(),
  agents: suppliedAgents, currentLabels: suppliedLabels, prState,
  // Reuse explicit facts or the PR snapshot; standalone calls read that snapshot from the provider.
  isDraft, baseRefName, defaultBranch = 'main',
  // `fixing-conflict` (draft reason at a glance, operator ask 2026-09-27, #2826) — same "false by default, no
  // existing caller affected" convention as `isDraft` above.
  mergeConflicted = false,
  // fix procedure — the live fix-claim read (a local file read, no `gh`); injectable so a test stays hermetic.
  readFixClaim = ({ repo: r, pr: p }) => readLiveFixClaim({ repo: r, pr: p }),
} = {}) {
  const repoKey = repo === undefined ? 'we' : repoKeyForSlug(repo);
  if (repoKey === null) throw new Error(`review-status-tag: --repo ${repo} is not a constellation repo`);
  const agents = suppliedAgents ?? listAgents();
  let fixClaim = null;
  try { fixClaim = readFixClaim({ repo: repoKey, pr: Number(pr) }); } catch { fixClaim = null; }
  // Reuse the daemon snapshot; standalone CLI calls read the same head and comments fresh.
  // A failed read throws before any label write, preserving an existing human signal.
  const subject = prState ?? provider.readPrState?.(repo, pr);
  const escalation = latestCiHealEscalationForHead(subject?.comments, subject?.headRefOid);
  const status = deriveReviewStatus({ pr, agents, repo: repoKey, isDraft: isDraft ?? subject?.isDraft ?? false,
    baseRefName: baseRefName ?? subject?.baseRefName, defaultBranch, mergeConflicted, fixClaim, escalation });
  const currentLabels = suppliedLabels ?? provider.readLabels(repo, pr);
  const plan = planStatusLabelChange({ status, currentLabels });
  // #4967 — the single plain state, returned for a viewer to show instead of the raw, possibly contradictory
  // labels. The labels themselves are untouched; rendering it is Plateau's follow-up.
  const reviewState = describeReviewState({ labels: currentLabels, status });
  if (!plan.add && plan.remove.length === 0) {
    return { changed: false, label: currentLabels.some(l => (typeof l === 'string' ? l : l?.name) === 'review-status:draft-withdrawn')
      ? 'review-status:draft-withdrawn' : status ? `review-status:${status.state}` : null, removed: [], reviewState };
  }
  // `review-status:*` is a small fixed enum, but a repo that has never carried one yet still needs it created
  // before `gh pr edit --add-label` will accept it — same reasoning as `review-round-tag.mjs`'s own ensure.
  if (plan.add) provider.ensureLabel(repo, plan.add, { color: 'c5def5', description: plan.add === 'review-status:awaiting-base'
    ? 'Waiting for the base PR to land and this PR to retarget before required CI runs'
    : 'informative: a reviewer/fixer is currently working this PR, or stuck (auto-managed)' });
  // `add` is optional on the shared port (#2026-09-01 extension) precisely for this remove-only case: nothing
  // is live, so there is no replacement label — only the stale one comes off.
  provider.setLabels(repo, pr, { add: plan.add ?? undefined, remove: plan.remove });
  return { changed: true, label: plan.add, removed: plan.remove, reviewState };
}

/**
 * THE IO SHELL, DISPATCH-TIME VARIANT (#3383 follow-up, live-caught 2026-09-26: a ci-heal dispatched for PR
 * #2771 by `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs` at 18:06 ET carried no `review-status:*`
 * label at all, because ONLY the separate Review daemon's own tick ever called {@link tagReviewStatus} — and
 * that tick was itself stuck behind an unbounded session-reap sweep the whole time; see
 * `we:scripts/conveyor/session-reaper.mjs`'s own per-tick budget for that half of the incident).
 *
 * THE DAEMON THAT DISPATCHES A SESSION APPLIES ITS OWN STATUS TAG RIGHT AT DISPATCH — never waiting on a
 * DIFFERENT daemon's tick to notice. This is deliberately NOT just "call `tagReviewStatus` from the fix
 * daemon too": {@link tagReviewStatus} DERIVES its state from a fresh `claude agents --json` read (or an
 * injected snapshot), and a session THIS SAME CALL just spawned is exactly the case
 * `we:skills-src/conveyor/review-daemon.mjs`'s own header already documents as a real, measured race ("a
 * `claude agents --json` listing lag right after a fresh spawn... a real (pre-existing, not newly introduced)
 * race window") — reading the listing immediately after dispatch would often see nothing live yet and
 * silently no-op the very tag this function exists to set. A caller that JUST dispatched the session already
 * knows its state with certainty; this function applies that KNOWN state directly, with no listing read at
 * all, and is otherwise byte-identical in its label mechanics to `tagReviewStatus` — same idempotent
 * `planStatusLabelChange`, same label home (`provider.ensureLabel`/`setLabels`), so the two never fight: this
 * one seeds the tag the instant it's true, and the Review daemon's own {@link tagReviewStatus} pass (fed by
 * `we:scripts/conveyor/reconcile-core.mjs#selectStatusCandidates`) remains the periodic RECONCILER that
 * corrects it once the session finishes, stalls, or the listing catches up — never a second, competing writer.
 * @param {{pr:number|string, repo:string, state:string|null, provider?:object, currentLabels?:Array<{name?:string}|string>}} o
 * @returns {{changed:boolean, label:string|null, removed:string[]}}
 */
export function applyReviewStatus({ pr, repo, state, provider = createGhProvider(), currentLabels: suppliedLabels } = {}) {
  const repoKey = repo === undefined ? 'we' : repoKeyForSlug(repo);
  if (repoKey === null) throw new Error(`review-status-tag: --repo ${repo} is not a constellation repo`);
  const currentLabels = suppliedLabels ?? provider.readLabels(repo, pr);
  const plan = planStatusLabelChange({ status: state ? { state } : null, currentLabels });
  if (!plan.add && plan.remove.length === 0) {
    return { changed: false, label: currentLabels.some(l => (typeof l === 'string' ? l : l?.name) === 'review-status:draft-withdrawn')
      ? 'review-status:draft-withdrawn' : state ? `review-status:${state}` : null, removed: [] };
  }
  if (plan.add) provider.ensureLabel(repo, plan.add, { color: 'c5def5', description: plan.add === 'review-status:awaiting-base'
    ? 'Waiting for the base PR to land and this PR to retarget before required CI runs'
    : 'informative: a reviewer/fixer is currently working this PR, or stuck (auto-managed)' });
  provider.setLabels(repo, pr, { add: plan.add ?? undefined, remove: plan.remove });
  return { changed: true, label: plan.add, removed: plan.remove };
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const argv = process.argv.slice(2);
  const flag = (name) => (argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3) || undefined;
  const pr = argv.find((a) => /^\d+$/.test(a));
  const repo = flag('repo');
  if (!pr || !repo) {
    writeLineSync(2, 'usage: review-status-tag.mjs <pr> --repo=<owner/name>');
    process.exitCode = 2;
  } else {
    try {
      const result = tagReviewStatus({ pr, repo });
      writeAllSync(1, `${JSON.stringify(result)}\n`);
    } catch (e) {
      writeLineSync(2, `error: ${String(e?.message ?? e)}`);
      process.exitCode = 1;
    }
  }
}
