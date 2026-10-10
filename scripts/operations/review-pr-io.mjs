import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { normalizeFinding, referralRecordState, referralFindingKey, mandatoryReferralReviewer, validateReferralRecord,
  readReferralRecords, mandatoryReferralState, renderReferralRecord, readOperatorRulings,
  findCarriedOperatorRuling, findCarriedReviewerRuling, exactCitedPath, REFERRAL_CARRY_REASON, activeReferrals, liveReferrals, findSupersedingNotReal, REFERRAL_SUPERSEDE_REASON, REFERRAL_DROP_REASON,
  findingIdentityTable, findingIdOf, findingIdentityPromptRows, sameAsLinkAllowed, FINDING_ID_PATTERN, FINDING_SAME_AS_MANDATE } from '../lib/jury-core.mjs';
import { judgeSpawn } from '../lib/judge-spawn.mjs';
import { appendJuryEvent } from '../lib/jury-ledger.mjs';
import { decideParkToHuman, referralCardReadable } from '../review-set-label.mjs';
import { buildReviewJudgeRequest } from './review-pr.mjs';
import { referralSeatDisabled } from './review-seat-policy.mjs';
export { referralSeatDisabled } from './review-seat-policy.mjs';
/**
 * @file scripts/operations/review-pr-io.mjs
 * @description THE IO SHELL of the `review-pr` declaration (#3035, under epic #3029) — the reader its `read`
 *   step is injected with, and the sinks its `record` step's effects are applied through.
 *
 * WHY IT IS A SEPARATE FILE. {@link ./review-pr.mjs} is the DECLARATION: what the operation is. This is the
 * only place it touches the world, which is the same pure-core / io-shell split
 * {@link ./run-record.mjs} / {@link ./run-store.mjs} use, and it is what lets the declaration be unit-tested
 * with a stub reader and stub sinks — no `gh`, no `git`, no network.
 *
 * EVERY BINDING HERE SHELLS AN EXISTING SCRIPT. Nothing in this file decides anything about a review:
 *   - the park context is `we:scripts/review-detail.mjs#assembleReviewDetail`, the PURE assembler, fed by ONE
 *     PR view — by default ONE `gh pr view`, the same single call its own CLI makes. That one call is this
 *     operation's ONLY reach for the network, so it is the one binding with a swappable transport
 *     (`resolveViewReader`): a host that cannot authenticate `gh` stages the same JSON on disk instead. The
 *     diff is still taken from local git either way, so the transport cannot influence what is judged;
 *   - the diff and the changed-file list are `computeNetDiffText` / `computeNetDiffPaths`
 *     (`we:scripts/merge-ai-prs.mjs`, #2450/#2901) off ONE shared basis;
 *   - the label swap is `we:scripts/review-set-label.mjs`, the SINGLE HOME (#2644), shelled as a subprocess so
 *     it keeps its own `gh` arc, its `reviewed-sha`/`reviewed-diff`/`reviewed-contribution` markers, its
 *     independence check (#2844) and its #2964 write ordering. Re-implementing any of that here is the exact
 *     defect this slice is forbidden to introduce.
 *
 * IMPURE by construction: `gh`, `git`, `fs`.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleReviewDetail } from '../review-detail.mjs';
import { computeNetDiffPaths, computeNetDiffText, resolveNetDiffBasis } from '../merge-ai-prs.mjs';
import { currentActorId, parseAuthorActorId } from '../lib/review-independence.mjs';
// #xlw02hw — the `advise` step's sink posts a BARE comment (never `we:scripts/review-set-label.mjs`, which
// always couples a comment with a label swap — #2644 — and this step swaps no label). `createGhProvider`'s
// `postComment` is the SAME primitive that single home already uses, imported rather than re-implemented.
import { createGhProvider } from '../lib/review-label-provider.mjs';
// The `advisory:accepted` / `advisory:changes` label the `advise` step's SECOND effect applies — the pure plan
// (`planAdvisoryLabels`) lives in the leaf, the writes go through the same provider port as the note above.
import { ADVISORY_LABEL_META, advisoryCoversHead, labelNames, planAdvisoryLabels } from '../lib/advisory-labels.mjs';
// #3007 — the real verdict ledger, behind the reserved `verdict-ledger.append` seam. See the LEDGER sink.
import { EVENT_TYPES, appendVerdict, buildLedgerEvent, buildVerdictRecord, foldRepo, parseLedgerEvents, verdictForLabelTarget, verdictLedgerPath } from '../lib/verdict-ledger.mjs';
// Card 5469 — the scoped re-review shadow: the declared setting and the pure round rules.
import { isValidRoundBudget, resolveReviewSettings, SCOPED_REREVIEW_MODES, ROUND_BUDGET_OFF } from '../lib/review-settings.mjs';
import { acceptanceIds, enclosingSymbol, foldFindingStatuses, lastReviewedHead, reviewRoundOf, reviewScope, shadowRound,
  FINDING_STATUSES } from '../lib/review-round-rules.mjs';
import { sharedRunsDir } from './run-store.mjs';
import { notApplied } from './effect-executor.mjs';
// #xgmzd0y — the DERIVED sibling table, so the subject checkout is computed rather than typed
// (`we:docs/agent/vm-sessions.md`: derivable by the repo's own tooling → in the tooling). Importing
// is safe: `bootstrap-session.mjs` guards its `main` on `import.meta.url === argv[1]`.
import { siblingsFor } from '../bootstrap-session.mjs';
// #xaoja7a follow-up — `PR_VIEW_FIELDS` and `prViewFileName` are TRANSPORT facts and now live in the
// transport lib, so the view PRODUCER can import them without dragging this shell (and `merge-ai-prs.mjs`
// behind it) into a CI job. Re-exported below: every existing importer of this module is unchanged.
import { PR_VIEW_FIELDS, prViewFileName } from '../lib/pr-view-transport.mjs';
import { defaultOriginRepo } from './record-verdict-io.mjs';
import { REVIEW_EFFECTS } from './review-pr.mjs';
import { canonicalizeSlug } from '../lib/constellation-repos.mjs';
import { isValidRunId } from './run-record.mjs';
// mechanical-dispatcher — the `AWAITING_ADVISORY_CLEAR` sink's own label name, imported rather than restated.
import { REVIEW_LABELS, hasReviewLabel } from '../lib/review-escalation.mjs';

export { PR_VIEW_FIELDS, prViewFileName };

/** The PR head moved while a referral pass was mid-run — a routine push race, never a reason to park for a human. */
class HeadChangedError extends Error {}

const HERE = dirname(fileURLToPath(import.meta.url));
/** The repo root, resolved by SCRIPT LOCATION and never by cwd — same reason `run-store.mjs` does it. */
export const REPO_ROOT = resolve(HERE, '..', '..');

/** Where the operation's own scratch lives — the gitignored `.operations/` sidecar, beside `runs/`. */
export function reviewSidecarDir(root = REPO_ROOT) {
  return join(root, '.operations', 'review');
}

/**
 * The staged write-up's path — RUN-SCOPED, and that is the whole point.
 *
 * The name in the payload (`<repo>-<pr>-verdict.md`) is keyed by PR only, so two runs reviewing the SAME PR in
 * the same checkout resolved to the SAME file: run B's write-up overwrote run A's staged bytes, and effect 1
 * then shelled the single home with `--body-file=` pointing at the wrong verdict. Interleaving the two runs'
 * effect 0 / effect 1 makes that a posted comment, not just a clobbered scratch file. A run id is the only
 * thing here that distinguishes them, so it is the directory.
 *
 * ORDINAL 0'S `idempotent: true` SURVIVES THIS, and the reason is that a replay is the SAME RUN. The effect
 * entry is created once and its payload frozen into the run record (`we:scripts/operations/engine.mjs`), and
 * `applyPendingEffects` re-applies the STORED entry with `ctx.runId = run.id` — the id of the record it is
 * resuming. So attempt N and attempt N+1 of one entry compute an identical path from an identical payload and
 * write identical bytes, which is exactly the property the declaration claims. Had the id been minted per
 * ATTEMPT rather than per run, this change would have broken it and would not be worth making.
 *
 * The id is validated with the SAME predicate the run store uses before putting it in a path, so a
 * `--run-id=` from the CLI cannot become a traversal. A missing or malformed id is refused rather than
 * silently falling back to the shared path — a fallback would restore the collision it exists to remove.
 *
 * @param {{root?: string, runId: string, bodyFile: string}} o
 * @returns {string} absolute path under `.operations/review/<runId>/`.
 */
export function reviewBodyPath({ root = REPO_ROOT, runId, bodyFile } = {}) {
  if (!isValidRunId(runId)) {
    throw new TypeError(
      `operations: the review write-up is staged per RUN, so it needs a valid run id — got ${JSON.stringify(runId)}. ` +
      'The sink reads it from the executor context (`ctx.runId`); a caller invoking the sink directly must supply one.',
    );
  }
  const name = String(bodyFile ?? '');
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new TypeError(`operations: invalid review write-up file name ${JSON.stringify(bodyFile)} — expected a bare file name`);
  }
  return join(reviewSidecarDir(root), runId, name);
}

/**
 * THE `exec` CONTRACT, spelled once. `resolveNetDiffBasis` and friends call it as
 * `exec('git', ['diff', …], { encoding: 'utf8', … })` — THREE positional args, `execFileSync`-shaped. The
 * natural-looking shell-exec `(cmd, opts) => execSync(cmd, opts)` receives the ARGS ARRAY in its `opts` slot and
 * throws inside a swallowed `try`, which surfaces as an unscored basis rather than as the caller bug it is
 * (#2952). `shapeReadFinding` REFUSES that case rather than falling back; this is the shape that avoids it.
 */
const execFileIn = (cwd) => (cmd, args, opts) => execFileSync(cmd, args, { ...opts, cwd });

/**
 * The default PR-view transport: ONE `gh pr view`, exactly as before.
 * @returns {object} the parsed `--json` view
 */
export function ghPrView({ pr, repo, cwd = REPO_ROOT } = {}) {
  try {
    return JSON.parse(execFileSync('gh', [
      'pr', 'view', String(pr), '--repo', repo, '--json', PR_VIEW_FIELDS.join(','),
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd }));
  } catch (e) {
    const msg = String((e && (e.stderr || e.message)) || e).split('\n').filter(Boolean).pop() || 'gh pr view failed';
    throw new Error(`review-pr-io: could not read ${repo}#${pr} — ${msg}`);
  }
}


/**
 * A PR-view transport that reads a PRE-FETCHED view from disk instead of calling `gh`.
 *
 * WHY THIS EXISTS. The review path is otherwise pure `git` + local files, and `gh` is its ONLY reach for the
 * network — one JSON blob. On a host where `gh` cannot authenticate (a cloud VM whose egress proxy refuses
 * every GitHub API call not routed through its own connector), that single blob blocks the whole encoded
 * review, even though the operator can obtain it by other means. This lets them hand it over.
 *
 * IT IS A TRANSPORT, NOT AN ESCAPE HATCH. It supplies the SAME shape `gh --json` returns and nothing else —
 * no verdict, no label, no diff. The judged diff still comes from local git, so a hand-edited view cannot
 * make the review agree with a tree that was never read.
 *
 * FAIL-CLOSED. A missing or unparseable file throws and names the path; it never silently degrades to an
 * empty view, which would review a PR as if it had no body, no labels and no comments.
 */
export function filePrView({ pr, repo, dir } = {}) {
  const path = join(dir, prViewFileName(repo, pr));
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `review-pr-io: could not read ${repo}#${pr} — no pre-fetched view at ${path}. `
      + `Write the \`gh pr view --json ${PR_VIEW_FIELDS.join(',')}\` output there, or unset WE_PR_VIEW_DIR to use gh.`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`review-pr-io: could not read ${repo}#${pr} — ${path} is not valid JSON (${e.message})`);
  }
}

/**
 * Pick the PR-view transport. `gh` unless the operator has explicitly staged views on disk. PURE given `env`.
 */
export function resolveViewReader(env = process.env) {
  const dir = env.WE_PR_VIEW_DIR;
  return dir ? (o) => filePrView({ ...o, dir: resolve(dir) }) : ghPrView;
}

/**
 * Read one PR's review context. The `readPr` the declaration is injected with.
 *
 * ONE `gh pr view`, then ONE net-diff basis shared by the text and the path list — the same economy
 * `computeNetDiffSignals` documents (independent resolution measured 5 → 11 subprocesses per PR).
 *
 * @param {{pr: number, repo: string, exec?: Function, cwd?: string, readView?: Function, originRepo?: Function}} o
 * @returns {{detail: object, net: object, diff: object, headRefName: string, body: string}}
 */
export function readPr({
  pr, repo, exec = null, cwd = REPO_ROOT, readView = resolveViewReader(), originRepo = defaultOriginRepo,
  // #xgmzd0y — the checkouts the caller's subject resolution already tried, named in the refusal below so
  // an operator sees WHERE it looked rather than only that it failed. Message-only; decides nothing.
  probed = null,
  // Card 5469 — the declared `scopedRereview` mode (we:scripts/review-settings.json); injectable for tests.
  scopedRereview = null,
  // Card 5471 — the declared `roundBudget` K, and the ledger reader the round count comes from; injectable for tests.
  roundBudget = null,
  readLedgerRows = defaultReadLedgerRows,
} = {}) {
  // The net-diff helpers take no `cwd`, so it is baked into the injected `exec` (the drain does the same thing
  // for the opposite reason — see the `escCwd` note in `we:scripts/merge-ai-prs.mjs`).
  const gitExec = exec || execFileIn(cwd);
  if (!Number.isInteger(pr) || pr <= 0) throw new TypeError(`review-pr-io: \`pr\` must be a positive integer, got ${JSON.stringify(pr)}`);
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new TypeError(`review-pr-io: \`repo\` must be <owner/name>, got ${JSON.stringify(repo)}`);
  }
  // #3137 — REFUSE A CROSS-REPO TARGET LOUDLY, BEFORE ANY NET-DIFF WORK. The net-diff git calls below are
  // rooted at `cwd` (this checkout by default) with no per-call repo override, so a `--repo=` pointed at a
  // DIFFERENT repository cannot resolve its head ref here. `shapeReadFinding`'s `ref-unresolved` degrade path
  // was written for that failure INSIDE the same repo (a lane branch this clone has not fetched yet), where
  // limping through with a note is the right call; a cross-repo target hits the identical path for a
  // completely different reason and used to degrade the same way — `degraded: true`, an EMPTY diff — handing
  // the judge nothing to find fault with and no error anywhere in the run (a false-pass hazard, live on
  // plateau-app#139). Checked here, ahead of the `gh pr view` call too, so a mismatched target fails fast
  // rather than spending a network round trip it cannot use.
  const haveRepo = originRepo(cwd);
  if (canonicalizeSlug(haveRepo) !== canonicalizeSlug(repo)) {
    throw new Error(
      `review-pr-io: refusing to review ${repo}#${pr} — this checkout's origin is ${haveRepo || '(unknown)'}, `
      + `not ${repo}. review-pr's diff comes from LOCAL git rooted at this checkout, so a cross-repo target `
      + 'cannot be resolved here; it used to silently degrade to an empty diff instead (#3137). '
      + (Array.isArray(probed) && probed.length > 1
        ? `The subject resolver (#xgmzd0y) probed ${probed.length} checkout(s) and none had that origin: `
          + `${probed.join(', ')}. Clone ${repo} beside this one (the lane pool mints the constellation `
          + 'siblings for exactly this — `scripts/lane-pool.mjs provision`), then re-run.'
        : `Run review-pr from a checkout of ${repo}.`),
    );
  }

  const view = readView({ pr, repo, cwd });
  // THE TRANSPORT SUPPLIES THE SUBJECT, SO THE SUBJECT IS VERIFIED. `gh` could only ever return the PR it was
  // asked for, so nothing checked; a FILE has no such property. A stale or mispasted view sitting under the
  // right filename was otherwise accepted whole — and because `headRefName` a few lines below decides the diff
  // basis, the judged DIFF was for the wrong PR too. Every consumer downstream is told it is looking at `pr`,
  // so nothing could notice. Fails closed, which is what this module's header already claims of the seam: a
  // hand-supplied view "cannot make the review agree with a tree that was never read" (review-pr correctness
  // juror on #1466, round 2 — the round-1 fix made the FILENAME injective and left the CONTENT unchecked).
  //
  // An ABSENT `number` is refused as well as a wrong one: `number` is in `PR_VIEW_FIELDS`, so a view without it
  // was not produced the declared way, and "no subject" is not better evidence than "wrong subject".
  if (Number(view?.number) !== pr) {
    const got = view?.number === undefined ? 'no `number` field at all' : `#${view.number}`;
    throw new Error(
      `review-pr-io: refusing to review ${repo}#${pr} — the view supplied by the transport has ${got}. `
      + 'A view carries the title, body, labels AND the head ref that decides which diff is judged, so a '
      + `mismatched one silently reviews a different PR. Re-stage ${prViewFileName(repo, pr)}, `
      + 'or unset WE_PR_VIEW_DIR to read through gh.',
    );
  }
  // `gh pr view` does not echo the repo back; carry the requested one, exactly as review-detail.mjs's CLI does.
  view.repo = repo;
  const detail = assembleReviewDetail({ view });
  const headRefName = typeof view.headRefName === 'string' ? view.headRefName : '';

  // ONE basis, shared. `fetchExtraRefs` carries the head ref so a lane branch this clone has never seen still
  // resolves — and NOTHING here moves HEAD (#2336): it fetches tracking refs and diffs two trees in place.
  const basis = resolveNetDiffBasis({
    exec: gitExec, rev: headRefName, fetchExtraRefs: headRefName ? [headRefName] : [],
  });
  const netText = computeNetDiffText({ exec: gitExec, rev: headRefName, fetchExtraRefs: [], basis });
  // `computeNetDiffPaths` resolves its own basis (it takes no `basis` param); the fetch above has already put
  // the head ref in this clone, so the second resolution is a local probe, not a second network round trip.
  const netPaths = computeNetDiffPaths({ exec: gitExec, rev: headRefName, fetchExtraRefs: [] });

  const priorRounds = priorRoundsFor(repo, pr);
  const revSha = revParseCommit(gitExec, netPaths.rev);
  const scopedMode = resolveScopedRereviewMode(scopedRereview);
  const budget = resolveRoundBudget(roundBudget);

  return {
    priorRounds,
    detail,
    headRefName,
    // #xwp8ioh — carried up so the PURE `shapeReadFinding` can refuse an inert PR. Read here, judged there:
    // the io shell fetches, the declaration decides, which is what keeps the refusal testable with no `gh`.
    state: typeof view.state === 'string' ? view.state : '',
    body: typeof view.body === 'string' ? view.body : '',
    // #xwk0tzu (#3322) — THE TWO HALVES OF THE INDEPENDENCE COMPARISON, carried up for the SAME reason
    // `state` is: read here, judged in the PURE `shapeReadFinding`. The author half is already in `body`
    // above (the `authored-by-actor` stamp `we:scripts/pr-land.mjs` writes at open), so only these two are
    // new — `createdAt`, which tells a STRIPPED stamp from one that never existed (#3067), and the CLEARING
    // actor, which is this process's own harness session id and is therefore the one thing the declaration
    // cannot read for itself without becoming impure.
    //
    // NOTHING IS DECIDED HERE. `parseAuthorActorId` / `hasStampLostMarker` are pure functions of `body`, so
    // they run on the declaration side beside the refusal they feed; duplicating them here would put the
    // same predicate in two places, which is the drift #2644 forbids.
    createdAt: typeof view.createdAt === 'string' ? view.createdAt : '',
    clearerId: currentActorId(),
    // PIN THE REV. `computeNetDiffPaths` reports `rev` as the candidate it resolved — `origin/<headRefName>`,
    // a MUTABLE ref — so the recorded basis stopped describing the judged diff as soon as the lane pushed
    // again. Resolve it here, in the io shell, where the git call belongs; `shapeReadFinding` keeps both the
    // commit and the ref. It is the SAME candidate the diff was taken from and not the PR's `headRefOid`:
    // `headRefOid` is GitHub's view of the head, which can differ from the ref this clone actually diffed, and
    // recording it would pin the basis to a tree that was never read.
    comments: view.comments,
    net: { ...netPaths, revSha },
    latestFix: readLatestFixRange({ exec: gitExec, comments: view.comments, head: revSha }),
    diff: netText,
    // Card 5469 — carried only when the shadow is on (or `on`, card 5470), so an `off` read is byte-identical to before.
    ...(['shadow', 'on'].includes(scopedMode) ? { scopedRereview: scopedMode } : {}),
    // Card 5471 — the round budget K and this PR's reviewed-head round from the ledger. Carried only when the budget is
    // set, so an `off` read is byte-identical to before. An unknown round is `null`: the budget never acts on it.
    ...(budget !== ROUND_BUDGET_OFF ? { roundBudget: budget, reviewRound: readReviewRound({ repo, pr, head: revSha, readLedgerRows }) } : {}),
  };
}

/** The repo's verdict-ledger rows (the default reader for the round count and the shadow). Throws when unreadable. */
function defaultReadLedgerRows(repo) {
  return parseLedgerEvents(readFileSync(verdictLedgerPath(repo), 'utf8'));
}

/**
 * Card 5471 — THIS PR'S REVIEW ROUND from the ledger (edge 5: per PR, from the ledger): 1 + the distinct heads it was
 * reviewed on before `head` (review-run rows, and the scoped re-review's finding rows written at review time). The
 * same count the scoped re-review shadow uses. An unreadable ledger or an unpinned head is `null` (edge 2: an unknown
 * round never earns the budget).
 * @param {{repo: string, pr: number, head: string|null, readLedgerRows?: Function}} o
 * @returns {number|null}
 */
export function readReviewRound({ repo, pr, head, readLedgerRows = defaultReadLedgerRows }) {
  if (typeof head !== 'string' || !/^[0-9a-f]{40}$/i.test(head)) return null;
  try {
    const rows = (readLedgerRows(repo) ?? []).filter((r) => Number(r?.pr) === Number(pr)
      && (r.type === EVENT_TYPES.REVIEW_RUN || r.type === EVENT_TYPES.FINDING));
    return reviewRoundOf(rows, head);
  } catch { return null; }
}

/**
 * Card 5471 — the round budget: an explicit value, else the declared setting. Any doubt is `off`. An explicit `off` is
 * an override too (a caller disabling the budget beats an enabled setting), same as `resolveScopedRereviewMode`.
 */
export function resolveRoundBudget(explicit = null, { settings = resolveReviewSettings } = {}) {
  if (explicit === ROUND_BUDGET_OFF || isValidRoundBudget(explicit)) return explicit;
  try {
    const k = settings().roundBudget;
    return isValidRoundBudget(k) ? k : ROUND_BUDGET_OFF;
  } catch { return ROUND_BUDGET_OFF; }
}

/** Card 5469 — the append-only shadow journal (one JSON line per reviewed round), beside the ledger-shadow journal. */
export function scopedRereviewJournalPath(env = process.env) {
  const named = String(env?.WE_SCOPED_REREVIEW_JOURNAL ?? '').trim();
  return named || join(dirname(sharedRunsDir(env)), 'ledger-shadow', 'scoped-rereview.jsonl');
}

/** Append one journal entry. Throws on a write failure; the caller reports it. */
export function appendScopedRereviewJournal(entry, { env = process.env } = {}) {
  const path = scopedRereviewJournalPath(env);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
  return path;
}

/** A cited path safe to hand to `git show <head>:<path>`: repo-relative, no `..`, no leading `-` or `/`. */
const SAFE_GIT_PATH = /^(?!-)(?!\/)[\w.@+\/-]+$/;

/**
 * Card 5469 — THE SCOPED RE-REVIEW SHADOW for one review run. The io half: reads the PR's ledger rows (last reviewed
 * head, prior finding statuses), the fix range since that head, the cited files at the head (for each finding's
 * symbol) and the card's Acceptance list; calls the pure rules (we:scripts/lib/review-round-rules.mjs); appends one
 * `finding` ledger row per identity; journals the round. NEVER throws and never changes a verdict, a comment or a label:
 * any failure is one loud `scoped-rereview-shadow-miss` line. An unreadable ledger runs the rules with no prior head,
 * which is the full review (edge 4: fail closed).
 * @returns {object|null} the round summary, or null on a miss.
 */
export function recordScopedRereviewShadow({ payload, exec, readLedgerRows, appendLedgerRow, appendJournal, out = () => {}, now = () => new Date().toISOString() }) {
  const { repo, pr } = payload ?? {};
  try {
    const facts = payload.roundFacts;
    const head = typeof facts?.head === 'string' ? facts.head.toLowerCase() : null;
    if (!head) { out(`scoped-rereview-shadow-miss: ${repo}#${pr} no pinned head; nothing recorded`); return null; }
    let rows = [];
    let ledger = 'ok';
    try { rows = (readLedgerRows(repo) ?? []).filter((r) => Number(r?.pr) === Number(pr)); } catch { rows = []; ledger = 'unreadable'; }
    // Reviewed heads, in append order: a completed run's review-run row, and the shadow's own finding rows (written at
    // review time, so a round parked for a ruling is counted too).
    const reviewRuns = rows.filter((r) => r.type === EVENT_TYPES.REVIEW_RUN || r.type === EVENT_TYPES.FINDING);
    const fromLedger = ledger === 'ok' ? lastReviewedHead(reviewRuns, head) : null;
    // The ledger names the last reviewed head (edge 6). A PR whose earlier rounds predate the review-run rows falls
    // back to the trusted `Net basis:` marker the latest-fix read already used; anything else is a full review.
    const markerHead = ledger === 'ok' && typeof facts.latestFix?.priorHead === 'string' ? facts.latestFix.priorHead.toLowerCase() : null;
    const priorHead = fromLedger ?? markerHead;
    const priorHeadSource = fromLedger ? 'ledger' : markerHead ? 'net-basis-marker' : null;
    const round = Math.max(reviewRoundOf(reviewRuns, head), priorHead ? 2 : 1);
    const delta = !priorHead ? null
      : facts.latestFix?.priorHead?.toLowerCase() === priorHead && facts.latestFix.files ? facts.latestFix
        : readFixRange({ exec, priorHead, head });
    const prior = ledger === 'ok' ? foldFindingStatuses(rows, { pr, head }) : new Map();
    const sentBack = [...prior].filter(([, p]) => p.status === FINDING_STATUSES.RAISED && String(p.headSha ?? '').toLowerCase() === priorHead).map(([id]) => id);
    const show = new Map();
    const fileAt = (path) => {
      if (!SAFE_GIT_PATH.test(path) || path.split('/').includes('..')) return null;
      if (!show.has(path)) {
        try { show.set(path, String(exec('git', ['show', '--end-of-options', `${head}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }) ?? '')); }
        catch { show.set(path, null); }
      }
      return show.get(path);
    };
    const acceptance = (Array.isArray(facts.cardPaths) ? facts.cardPaths : []).flatMap((p) => acceptanceIds(fileAt(p) ?? ''));
    const findings = (Array.isArray(facts.findings) ? facts.findings : []).map((item) => {
      const file = typeof item?.finding?.file === 'string' ? item.finding.file.trim().replace(/^\.\//, '').replace(/:\d+(?::\d+)?$/, '') : '';
      const text = file && Number.isInteger(item.finding.line) ? fileAt(file) : null;
      return { ...item, symbol: text == null ? '' : enclosingSymbol(text, item.finding.line, file) };
    });
    const scope = reviewScope({ priorHead, head, delta, sentBack, acceptance });
    const result = shadowRound({ repo, pr: Number(pr), head, round, scope, findings, prior,
      liveVerdict: facts.liveVerdict, humanRequired: facts.humanRequired === true });
    const at = now();
    const missed = [];
    for (const row of result.rows) {
      try {
        const res = appendLedgerRow(buildLedgerEvent({ type: EVENT_TYPES.FINDING, repo, pr: Number(pr), at, source: 'review-pr',
          channel: 'review-pr', session: currentActorId(), headSha: head, ...row }));
        if (!res?.ok || res.ledgerWriteMiss) missed.push(row.findingId);
      } catch { missed.push(row.findingId); }
    }
    const summary = { ...result.summary, priorHead, priorHeadSource, ledger, findingRows: result.rows.length, findingRowsMissed: missed.length };
    appendJournal({ v: 1, kind: 'we.scoped-rereview-shadow', at, repo, pr: Number(pr), head, priorHead, priorHeadSource, round,
      scope: { kind: scope.kind, reason: scope.reason, files: Object.keys(scope.files ?? {}).length, carried: scope.carried, acceptance: scope.acceptance },
      summary, entries: result.entries });
    const verdictWord = round < 2 ? 'round 1 (full review; identities recorded)'
      : summary.shadowBlocked ? `would still block (${summary.blocked} blocking, ${summary.carded} carded)`
        : summary.liveBlocked ? `would have ACCEPTED with ${summary.carded} card(s) — round avoided` : 'accepted live; nothing to scope';
    out(`scoped-rereview-shadow: ${repo}#${pr} round ${round} on ${head.slice(0, 8)} (scope ${scope.kind}${priorHead ? ` since ${priorHead.slice(0, 8)}` : ''}): live ${summary.liveVerdict || 'n/a'} → ${verdictWord}${missed.length ? `; ${missed.length} finding row(s) not written` : ''}`);
    return summary;
  } catch (e) {
    out(`scoped-rereview-shadow-miss: ${repo}#${pr} ${String(e?.message ?? e).split('\n')[0]}; the live review is unaffected`);
    return null;
  }
}

/** Card 5469 — the scoped re-review mode: an explicit value, else the declared setting. Any doubt is `off`. */
export function resolveScopedRereviewMode(explicit = null, { settings = resolveReviewSettings } = {}) {
  if (SCOPED_REREVIEW_MODES.includes(explicit)) return explicit;
  try { return SCOPED_REREVIEW_MODES.includes(settings().scopedRereview) ? settings().scopedRereview : 'off'; } catch { return 'off'; }
}

/** #5135 — output cap for the latest-fix `git diff`; past it the read fails and the scope falls back to `all`. */
export const LATEST_FIX_DIFF_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * #5135 — the changed new-side lines of the latest fix range (`<prior reviewed head>..<head>`). Never throws:
 * `{priorHead: null}` on round 1, `{priorHead, head, error}` when the range cannot be read, else
 * `{priorHead, head, files: {path: number[] | null}}` (`null` = changed, lines unknown).
 */
export function readLatestFixRange(options = {}) {
  const { exec, comments, head } = options ?? {};
  let priorHead = null;
  try {
    const current = typeof head === 'string' && /^[0-9a-f]+$/i.test(head) ? head.toLowerCase() : null;
    for (const comment of (Array.isArray(comments) ? comments : []).slice().reverse()) {
      if (!isTrustedMarkerAuthor(comment) || typeof comment.body !== 'string') continue;
      // The LAST line-anchored match: the renderer emits the real `Net basis:` line after the juror text, so a line
      // forged above it by a PR author must not choose the prior head.
      const reviewed = [...comment.body.matchAll(/^Net basis: `([0-9a-f]+)\.\.([0-9a-f]+)`/gim)].at(-1)?.[2]?.toLowerCase();
      if (reviewed && (!current || (!reviewed.startsWith(current) && !current.startsWith(reviewed)))) {
        priorHead = reviewed;
        break;
      }
    }
    if (!priorHead) return { priorHead: null };
    return readFixRange({ exec, priorHead, head });
  } catch {
    return { priorHead, head, error: 'diff-unparseable' };
  }
}

/**
 * The changed new-side lines of `<priorHead>..<head>`, in {@link readLatestFixRange}'s shape. Shared by the latest-fix
 * read (prior head from the last trusted `Net basis:` marker) and the scoped re-review shadow (card 5469, prior head
 * from the ledger's review-run rows). Never throws.
 * @param {{exec: Function, priorHead: string, head: string|null}} o
 * @returns {{priorHead: string, head?: string, files?: object, error?: string}}
 */
export function readFixRange({ exec, priorHead, head } = {}) {
  const current = typeof head === 'string' && /^[0-9a-f]+$/i.test(head) ? head.toLowerCase() : null;
  try {
    if (typeof priorHead !== 'string' || !/^[0-9a-f]+$/i.test(priorHead)) return { priorHead, head, error: 'prior-head-invalid' };
    if (!current) return { priorHead, error: 'head-unpinned' };
    let diff;
    try {
      diff = String(exec('git', ['diff', '--no-ext-diff', '--no-color', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', '--unified=0', priorHead, head], {
        // A rebase between rounds can make this diff several MB; the 1 MB default would throw and fall back to `all`.
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: LATEST_FIX_DIFF_MAX_BUFFER,
      }) ?? '');
    } catch {
      return { priorHead, head, error: 'git-diff-failed' };
    }
    const files = {};
    if (!diff.trim()) return { priorHead, head, files };
    // Split only at a real LF line start: no `m` flag, because `^` under `/m` also matches after CR, U+2028,
    // U+2029, NEL, VT and FF, so an added line like `x<U+2028>diff --git a/zzz b/zzz` would forge a section and
    // misattribute the real file's hunks. (A genuine header always starts a line; content lines start with `+`/`-`/` `.)
    const sections = diff.split(/(?:^|\n)diff --git /).slice(1);
    if (!sections.length) return { priorHead, head, error: 'diff-unparseable' };
    const decodePath = value => value.startsWith('"') ? JSON.parse(value) : value;
    for (const section of sections) {
      const lines = section.split('\n');
      const newPath = lines.find(line => line.startsWith('+++ '))?.slice(4);
      const oldPath = lines.find(line => line.startsWith('--- '))?.slice(4);
      const deleted = newPath === '/dev/null';
      // `--no-renames` makes both sides the same path, so the header is `a/P b/P`: split at the exact midpoint (a path
      // may itself contain ` b/`) and refuse a header whose sides differ rather than guess.
      const headerPath = (() => {
        const quoted = lines[0].match(/^("a\/.*") ("b\/.*")$/);
        if (quoted) return quoted[1].slice(2) === quoted[2].slice(2) ? quoted[2] : null;
        const half = (lines[0].length - 5) / 2;
        return Number.isInteger(half) && half > 0 && lines[0][2 + half] === ' '
          && lines[0].startsWith('a/') && lines[0].slice(3 + half, 5 + half) === 'b/'
          && lines[0].slice(2, 2 + half) === lines[0].slice(5 + half) ? lines[0].slice(3 + half) : null;
      })();
      const rawPath = deleted ? oldPath : newPath ?? headerPath;
      const path = rawPath && decodePath(rawPath).replace(/^[ab]\//, '').replace(/\t$/, '');
      if (!path) return { priorHead, head, error: 'diff-unparseable' };
      const unknown = deleted || lines.some(line => line.startsWith('Binary files ') || line === 'GIT binary patch'
        || line.startsWith('rename from ') || line.startsWith('rename to '));
      const changed = new Set();
      if (!unknown) for (const line of lines) {
        if (!line.startsWith('@@')) continue;
        const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
        if (!hunk) return { priorHead, head, error: 'diff-unparseable' };
        const start = Number(hunk[1]);
        const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(start + count)) return { priorHead, head, error: 'diff-unparseable' };
        if (count === 0) { changed.add(start); changed.add(start + 1); }
        else for (let n = start; n < start + count; n++) changed.add(n);
      }
      Object.defineProperty(files, path, { value: unknown ? null : [...changed].sort((a, b) => a - b), enumerable: true, configurable: true });
    }
    return { priorHead, head, files };
  } catch {
    return { priorHead, head, error: 'diff-unparseable' };
  }
}

/**
 * Resolve a rev to its full commit SHA, or `null`. Never throws: an unresolvable rev is recorded as unpinned
 * (and rendered with a warning) rather than failing a review that has otherwise succeeded.
 */
export function revParseCommit(exec, rev) {
  if (typeof exec !== 'function' || typeof rev !== 'string' || !rev) return null;
  try {
    // `--end-of-options` for the same reason `resolveNetDiffBasis` uses it: `rev` derives from a branch name
    // off the `gh` API, and a dash-leading refname is legal.
    const out = String(exec('git', ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }) || '').trim();
    return /^[0-9a-f]{40}$/i.test(out) ? out.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** `readPr` bound to one repo/exec, which is the shape the declaration wants. */
/**
 * HOW MANY ROUNDS THIS LOOP HAS ALREADY RUN, from the durable ledger — so the round number needs no new state.
 *
 * ROUNDS SINCE THE LAST CLEAR, not rows ever written (PR #1178 review, finding 3). `history` is every verdict
 * this PR has ever carried, including rows from an already-CONVERGED loop, so counting its length made a
 * brand-new review of a previously-accepted PR report itself as round N of a cap of 5. Measured on real repo
 * data before the fix: PRs 1162 and 1164 each ran three `changes` rounds then an `accepted` that cleared them,
 * and the old expression reported `exhausted` on the FIRST round of the next loop. #1164's four-round run is
 * the very reason the cap is 5 (`we:scripts/lib/jury-core.mjs`), so the miscount strangled exactly the case
 * the cap exists to allow.
 *
 * `outstandingHolds` is the LEDGER'S OWN answer to "what is still standing" — it slices from the last
 * `clears: true` row. Reusing it keeps one definition of a loop rather than two that can disagree.
 *
 * EXPORTED so the count is testable on its own. Inline in the reader it was only reachable through a `gh` call
 * and a git fetch, which is why the wrong expression shipped with no test to redden.
 *
 * Fail-soft: an unreadable ledger yields 0, which reads as "first round" rather than blocking a review on
 * bookkeeping.
 *
 * @param {string} repo - `owner/name`.
 * @param {number} pr
 * @returns {number}
 */
export function priorRoundsFor(repo, pr) {
  try { return (foldRepo(repo).get(pr)?.outstandingHolds ?? []).length; } catch { return 0; }
}

/**
 * THE SUBJECT CHECKOUT for `repo` — the clone `review-pr`'s `read` step takes its LOCAL GIT from (#xgmzd0y).
 *
 * WHY THIS EXISTS. `readPr` reads the diff from local git rooted at one checkout, so a `--repo=` naming a
 * DIFFERENT constellation member could not resolve and was refused outright (#3137, and that refusal was
 * right — it replaced a silent degrade to an EMPTY diff, a false-pass hazard live on plateau-app#139). But the
 * refusal made the operation unable to judge ANY Frontier UI or Plateau PR, which is the impl half of every
 * cross-repo couple — while `we:scripts/review-set-label.mjs` takes `--repo=<owner/name>` and will happily
 * STAMP a verdict on one. The machinery could record a verdict it had no way to form.
 *
 * The clone was already on disk the whole time: the lane pool mints the constellation siblings as REAL git
 * clones beside the lanes (#2282/#2349, `#pool-siblings-real-built-clones`). Nothing fetched it because
 * nothing asked. This asks.
 *
 * DERIVED, NOT TYPED. The candidates come from {@link siblingsFor} — the same table `bootstrap-session.mjs`
 * probes, which resolves BOTH plausible parents (beside the primary checkout on a laptop, beside the lane in
 * a cloud pool). Each candidate is matched by its ACTUAL `git remote get-url origin`, never by directory
 * name: the constellation answers to more than one basename (`web-everything` vs `webeverything`), so a
 * name match would be the wrong fact. Matching on origin also means this resolver and the #3137 guard below
 * agree by construction — the guard re-derives the same fact and still refuses if it disagrees.
 *
 * FAIL CLOSED, UNCHANGED. An unresolvable subject returns `null`, the caller passes the ORIGINAL cwd, and
 * `readPr`'s guard fires with its loud refusal. Nothing here can produce an empty diff: this only ever points
 * the read at a checkout that PROVABLY is the requested repo, or gives up and lets the refusal stand.
 *
 * @param {{repo: string, cwd?: string, originRepo?: Function, siblings?: Function}} o
 * @returns {{path: string, probed: string[]}|{path: null, probed: string[]}}
 */
export function resolveSubjectCheckout({
  repo, cwd = REPO_ROOT, originRepo = defaultOriginRepo, siblings = siblingsFor,
} = {}) {
  const probed = [cwd];
  if (canonicalizeSlug(originRepo(cwd)) === canonicalizeSlug(repo)) return { path: cwd, probed };
  let candidates = [];
  // A broken/absent sibling table must not turn a refusal into a crash — the guard is the one that speaks.
  try { candidates = siblings(cwd) || []; } catch { candidates = []; }

  // POOL-LOCAL BEFORE PRIMARY (#2123). `siblingsFor` probes the primary's parent FIRST, so from a lane it
  // answers `/home/user/frontierui` — the SHARED primary checkout — while the pool's own isolated clone sits
  // right beside the lane being driven from. Reading a review's diff out of a checkout another agent may be
  // mid-work in is the exact thing lane isolation exists to prevent, and it is the wrong default here even
  // though this operation only reads: the primary's refs move under it. So each sibling is probed at its
  // POOL-LOCAL path first (same directory name, resolved beside `cwd`), falling back to whatever the table
  // chose. Off a lane the two collapse to the same path and nothing changes.
  const poolDir = dirname(cwd);
  for (const sibling of candidates) {
    if (!sibling?.path) continue;
    const poolLocal = join(poolDir, basename(sibling.path));
    for (const candidate of poolLocal === sibling.path ? [sibling.path] : [poolLocal, sibling.path]) {
      // `present` gates only the TABLE's path — a pool-local clone the table never looked at is probed on its
      // own merit, and `originRepo` answers '' for a path that is not a repo, so a miss is free.
      if (candidate === sibling.path && !sibling.present) continue;
      if (probed.includes(candidate)) continue;
      probed.push(candidate);
      if (canonicalizeSlug(originRepo(candidate)) === canonicalizeSlug(repo)) return { path: candidate, probed };
    }
  }
  return { path: null, probed };
}

export function createReviewPrReader({
  exec = null, cwd = REPO_ROOT, originRepo = defaultOriginRepo, siblings = siblingsFor,
} = {}) {
  return ({ pr, repo }) => {
    // Resolve per CALL, not per reader: `repo` is run INPUT and is unknown when the reader is constructed
    // (`we:scripts/operations/run.mjs` builds it with no arguments).
    const { path, probed } = resolveSubjectCheckout({ repo, cwd, originRepo, siblings });
    // `path === null` → pass the original cwd so `readPr`'s #3137 guard refuses, naming where it looked.
    return readPr({ pr, repo, exec, cwd: path ?? cwd, originRepo, probed });
  };
}

/**
 * Refusal texts `we:scripts/review-set-label.mjs` emits BEFORE any `gh` mutation. Matching one PROVES nothing
 * landed, so the entry is marked `failed` (retried on replay) instead of the default INDETERMINATE.
 *
 * THE DEFAULT IS THE SAFE ONE, AND THAT IS THE POINT: anything NOT on this list is treated as indeterminate,
 * because the CLI's two write failures surface as `gh`'s own stderr text (`ghErr` replaces the label with the
 * last stderr line), so there is no reliable string to recognise them by. Guessing "nothing landed" on an
 * unrecognised failure is how a comment gets double-posted. This list only ever narrows the refusal; it never
 * widens what counts as safe.
 */
const PRE_WRITE_REFUSALS = Object.freeze([
  'usage: review-set-label.mjs',
  'invalid --repo',
  'invalid --to',
  '--to=clear-human',
  'the rendered comment is',
  'renders a ',
  'gate-self: review:human is human-ceremony-only',
  'no review:human label',
  'no review:changes label',
  ', not OPEN',
  'nothing was changed (#2844)',
  // #3334 — `decideSetLabel`'s reasonless-bounce refusal. It is decided by the PURE core, which runs before the
  // provider is touched at all, so a run that reports it PROVABLY wrote nothing. The literal is the head of
  // `REASONLESS_BOUNCE_REFUSAL` in `we:scripts/review-set-label.mjs`, asserted against that constant in the
  // #3334 tests so the two cannot drift into a refusal this list no longer recognises.
  'reasonless bounce:',
]);

// Keep v1's identity-bearing fields intact: old readers recompute the key from them.
// In particular, a huge summary/key cannot be hashed away without breaking those readers.
const referralHash = (text) => createHash('sha256').update(text).digest('hex');
/** Parks a re-ask of a carried finding whose backing was withdrawn: it is asked once, then held for a person. */
const WITHDRAWN_CARRY_REASK = 'withdrawn carry: the reviewer was asked once more for a carried finding whose backing no longer stands';
function boundedReferral(original, source) {
  const bounded = { ...original };
  for (const [field, value] of Object.entries(original)) {
    if (['summary', 'finding', 'file', 'line', 'verdict', 'impactIfUnfixed'].includes(field)) continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text?.length > 1024) {
      // Array/object-valued extension fields are audit data too; keep a bounded serialized excerpt.
      bounded[field] = `${Array.from(text).slice(0, 512).join('')}\n[excerpt; sha256:${referralHash(text)}; source:${source}]`;
    }
  }
  return bounded;
}

/** Is this CLI error text one we can PROVE happened before any write? */
export function isPreWriteRefusal(text) {
  const s = String(text || '');
  return PRE_WRITE_REFUSALS.some((p) => s.includes(p));
}

/** Lines around a cited line that count as "the cited code changed" when carrying an operator ruling forward. */
export const CARRY_CHANGE_WINDOW = 3;
/** The compare API lists at most this many files; a full list may be truncated. */
export const COMPARE_FILE_CAP = 300;

/**
 * The changed new-side lines of `file` in a compare payload (the returned Set's `.old` holds the changed OLD-side lines,
 * so each citation can be checked in its own revision's coordinates), or `null` when that cannot be PROVEN (fail closed).
 * A pure deletion or insertion (zero-count range) marks the two lines it sits between.
 * `null`: the base is not an ancestor of the head (`status` other than `ahead`/`identical` — a three-dot compare of
 * diverged heads diffs from the merge base, not from the ruled head), a missing/truncated file list, a rename, a
 * removed file, or a missing patch. A file absent from a complete list is unchanged only when `fileExists()` shows
 * the path is a real file at both ends; a path that matches nothing is unknown, not unchanged.
 * @returns {Set<number>|null}
 */
export function changedLinesFromCompare(compare, file, fileExists = () => false) {
  if (!compare || !['ahead', 'identical'].includes(compare.status) || !Array.isArray(compare.files)) return null;
  const files = compare.files;
  const entry = files.find(f => f.filename === file || f.previous_filename === file);
  if (!entry) return files.length >= COMPARE_FILE_CAP || !fileExists() ? null : new Set();
  if (entry.status === 'removed' || entry.status === 'renamed' || typeof entry.patch !== 'string' || !entry.patch) return null;
  const lines = new Set();
  lines.old = new Set();
  let hunks = 0;
  // A zero-count range (`+N,0` after a pure deletion, `-N,0` before a pure insertion) names the line AFTER which the
  // change sits, so the change is adjacent to both N and N+1: record both, or a deletion would read as "no change".
  const mark = (set, start, count) => {
    if (count === 0) { set.add(start); set.add(start + 1); return; }
    for (let n = start; n < start + count; n++) set.add(n);
  };
  for (const match of entry.patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    hunks++;
    mark(lines.old, Number(match[1]), Number(match[2] ?? 1));
    mark(lines, Number(match[3]), Number(match[4] ?? 1));
  }
  return hunks ? lines : null;
}

/** True when any changed line falls within the window of a cited line; a missing cited line means any change blocks. */
export function changesTouchCitedLines(changed, citedLines) {
  if (citedLines.some(l => !Number.isInteger(l))) return changed.size > 0;
  return [...changed].some(n => citedLines.some(l => Math.abs(n - l) <= CARRY_CHANGE_WINDOW));
}

/**
 * The default `(repo, base, head, file) => Set|null` reader behind the operator-ruling carry: one compare per
 * (repo, base, head) cached for the reader's life — failures included — and a contents probe for the
 * absent-from-compare case. `ghJson(args)` is the injectable `gh api` runner (parsed JSON; throws on failure).
 */
export function createChangedLinesReader(ghJson) {
  const comparisons = new Map();
  const exists = (repo, ref, file) => {
    try {
      // A directory answers with an array; a submodule or symlink with another `type`. Only a real file can be "unchanged".
      const entry = ghJson(['api', `repos/${repo}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`]);
      return !Array.isArray(entry) && entry?.type === 'file';
    } catch { return false; }
  };
  return (repo, base, head, file) => {
    const key = JSON.stringify([repo, base, head]);
    if (!comparisons.has(key)) {
      try { comparisons.set(key, ghJson(['api', `repos/${repo}/compare/${base}...${head}`])); } catch { comparisons.set(key, null); }
    }
    return changedLinesFromCompare(comparisons.get(key), file, () => exists(repo, base, file) && exists(repo, head, file));
  };
}

/**
 * THE SINKS, bound to a repo root and an output channel.
 *
 * @param {{root?: string, out?: (line: string) => void, runNode?: Function, postComment?: Function, labelProvider?: object,
 *   json?: boolean, readLabels?: Function, setLabels?: Function}} [o] -
 *   `runNode` is the injectable subprocess runner (`(argv) => stdout`), so the label sink is testable without
 *   `gh`; `postComment` is the injectable `(repo, pr, body) => void` the `advise` sink posts through (#xlw02hw),
 *   so it too is testable without `gh` — defaults to `createGhProvider().postComment`. `readLabels` (`(repo, pr)
 *   => Array`) and `setLabels` (`(repo, pr, {add, remove}) => void`) are the mechanical-dispatcher lane's
 *   `AWAITING_ADVISORY_CLEAR` sink's own two primitives, same reason and same default
 *   (`createGhProvider().readLabels`/`.setLabels`) — injected rather than reaching for `createGhProvider()`
 *   inline, so that sink is testable without `gh` too. `json` is STDOUT-PURITY FOR THE NOTICE SINK ONLY (see the
 *   default `out` below) — a caller building sinks for a `--json` invocation passes `json: true` so the sink's
 *   default writer moves off stdout; every other sink here is unaffected because none of them write to stdout
 *   at all.
 * @returns {Record<string, Function>} effect type → `async (payload, ctx) => result`.
 */
export function createReviewPrSinks({
  root = REPO_ROOT,
  env = process.env,
  referralJudge = judgeSpawn,
  readChangedLines,
  mirrorReferral = (record) => appendJuryEvent(`${record.repo}#${record.pr}`, { type: 'mandatory-referrals', round: 0, record }, { root }),
  cardReadable = (ref) => referralCardReadable(ref, root),
  // #xstdout-json — A `--json` CALLER WANTS STDOUT TO BE ONE PARSEABLE DOCUMENT, END TO END. The `NOTICE`
  // sink below is the one sink in this file that writes a human-readable line through `out`, and until now it
  // did so UNCONDITIONALLY to stdout — so `review-loop-cli.mjs --json` (and `run.mjs review-pr --json` on its
  // recording call) could print `"PR o/n#7 — human review …"` followed by the real JSON on the very same
  // stream. A strict `JSON.parse` of that combined stdout throws before it ever sees the JSON, which is exactly
  // what turned a clean review into a reported `blocked-on-infra` for the first non-agentic caller of this CLI
  // (`review-dispatch-wrapper.mjs`) — every prior caller was an LLM agent reading its own output, which can look
  // past an extra text line a strict parser cannot.
  //
  // `json` decides WHERE the default writer below sends a line; it decides nothing else, and every other sink
  // in this file is untouched because none of them writes to stdout. The flag is derived from the INVOCATION's
  // own argv by the caller (`hasJsonFlag`, `we:scripts/operations/cli-adapter.mjs`) before this builder runs —
  // this function does not re-parse argv itself, so there is exactly one place that decides what `--json` means.
  json = false,
  // STDERR, NOT SILENCE, when `json` is set: the notice still has to reach a human somewhere. An operator
  // running the unattended CLI interactively (or piping only stdout for its JSON) still sees the notice on
  // their terminal; a machine capturing stdout — `JSON.parse(execFileSync(...))`, `review-dispatch-wrapper.mjs`
  // — sees only the JSON it asked for. `process.stderr.write` is synchronous in Node (`we:scripts/lib/
  // write-all-sync.mjs`'s own header), so this needs none of that module's drain-before-exit machinery either.
  out = (line) => (json ? process.stderr : process.stdout).write(`${line}\n`),
  runNode = (argv, opts) => execFileSync(process.execPath, argv, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts }),
  postComment = createGhProvider().postComment,
  // The forge port the ADVISORY_LABEL sink reads live PR state and writes labels through — injectable so the sink
  // is testable with no `gh`, exactly like `postComment` above. Defaults to the same real provider.
  labelProvider = createGhProvider(),
  // mechanical-dispatcher — the `AWAITING_ADVISORY_CLEAR` sink's own two primitives (see the header note above).
  readLabels = createGhProvider().readLabels,
  setLabels = createGhProvider().setLabels,
  // Card 5469 — the scoped re-review shadow's reads and writes, injectable so the sink is testable with no git/ledger.
  shadowGitExec = execFileIn(root),
  readLedgerRows = defaultReadLedgerRows,
  appendLedgerRow = (row) => appendVerdict(row),
  appendShadowJournal = (entry) => appendScopedRereviewJournal(entry, { env }),
} = {}) {
  return {
    [REVIEW_EFFECTS.MANDATORY_REFERRALS]: async (payload, ctx) => {
      const { read } = payload;
      // Cache comparisons only for this invocation, including failures. Missing patches cannot prove clearance.
      const changedLines = readChangedLines ?? createChangedLinesReader(args => JSON.parse(execFileSyncThrottled('gh', args,
        { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 })));
      const commentBudget = 60_000;
      const fresh = () => {
        const state = labelProvider.readPrState(read.repo, read.pr);
        if (state.headRefOid !== read.netBasis.rev) throw new HeadChangedError('mandatory referral: reviewed head changed; hold retained');
        if (!Array.isArray(state.comments)) throw new Error('mandatory referral: comments unavailable; hold retained');
        return state;
      };
      const context = (state) => ({ repo: read.repo, pr: read.pr, head: state.headRefOid,
        body: typeof state.body === 'string' ? state.body : '', createdAt: state.createdAt, cardReadable });
      const park = (state) => {
        const plan = decideParkToHuman({ currentLabels: labelNames(state.labels) });
        const remove = plan.removeLabels.filter(l => labelNames(state.labels).includes(l));
        if (remove.length || !labelNames(state.labels).includes(plan.addLabel)) {
          labelProvider.setLabels(read.repo, read.pr, { add: plan.addLabel, remove });
        }
        if (labelNames(state.labels).includes('review:changes')) out(plan.reason);
      };
      const persist = (record) => {
        const body = renderReferralRecord(record);
        if (body.length > commentBudget) throw new Error(`mandatory referral record exceeds ${commentBudget} characters`);
        const before = fresh();
        // xuxcsw6: never repost a record the thread already carries byte-for-byte (trusted-author read).
        const same = r => JSON.stringify(r) === JSON.stringify(record);
        if (!readReferralRecords(before.comments, context(before)).records.some(same)) {
          labelProvider.postComment(read.repo, read.pr, body);
        }
        const state = fresh();
        const parsed = readReferralRecords(state.comments, context(state));
        if (parsed.malformed || !parsed.records.some(r => JSON.stringify(r) === JSON.stringify(record))) {
          throw new Error('mandatory referral: post read-back failed; hold retained');
        }
        mirrorReferral(record);
        return state;
      };
      const overflows = [];
      const overflow = (detail) => {
        const reason = `referral-overflow: ${detail}`;
        overflows.push(reason);
        out(reason);
        return reason;
      };
      let state;
      try {
        state = fresh();
        const prior = readReferralRecords(state.comments, context(state));
        if (prior.malformed) { park(state); return mandatoryReferralState(state.comments, context(state)); }
        // Retire only persisted findings, before merging this run's fresh referrals. Keep the source bytes
        // and a durable reason so every acceptance reader sees the same decision, including after a restart.
        for (let i = 0; i < prior.records.length; i++) {
          const record = prior.records[i];
          if (record.repo !== read.repo || record.pr !== read.pr) continue;
          // Never retire a finding that already has a ruling: it would silently clear a standing `block`.
          const dropped = activeReferrals(record).filter(f => referralSeatDisabled(f.seat, env)
            && !record.rulings.some(r => r.key === f.key))
            .map(f => ({ key: f.key, reason: REFERRAL_DROP_REASON }));
          if (!dropped.length) continue;
          const updated = { ...record, dropped: [...(record.dropped ?? []), ...dropped] };
          // Existing snapshots are immutable under v1: rewriting their findings/body or splitting
          // their runId would invalidate history. Retain the hold and carry their keys forward.
          if (renderReferralRecord(updated).length > commentBudget) {
            overflow(`historical run ${record.runId} retirement exceeds ${commentBudget} characters; original record retained`);
            continue;
          }
          state = persist(updated);
          prior.records[i] = updated;
        }
        const existing = prior.records.filter(r => r.head === read.netBasis.rev && r.repo === read.repo && r.pr === read.pr);
        const covered = new Set(existing.flatMap(r => activeReferrals(r).map(f => f.key)));
        const prUrl = `https://github.com/${read.repo}/pull/${read.pr}`;
        const sourceByKey = new Map();
        const sourceByOriginal = new Map();
        for (const comment of state.comments) {
          const source = comment.url ?? comment.html_url ?? (comment.id ? `${prUrl}#issuecomment-${comment.id}` : prUrl);
          for (const record of readReferralRecords([comment]).records) {
            for (const referral of record.referrals) {
              if (!sourceByKey.has(referral.key)) sourceByKey.set(referral.key, source);
              sourceByOriginal.set(JSON.stringify(referral.original), source);
            }
          }
        }
        const sources = [...payload.referrals, ...prior.records.filter(r => r.repo === read.repo && r.pr === read.pr).flatMap(activeReferrals)];
        const additions = new Map();
        for (const f of sources) {
          const key = referralFindingKey(f.seat, f.original);
          if (!covered.has(key)) {
            const original = boundedReferral(f.original, sourceByOriginal.get(JSON.stringify(f.original)) ?? prUrl);
            additions.set(key, { key, seat: f.seat, original, finding: normalizeFinding(original) });
          }
        }
        if (additions.size) {
          const chunks = [];
          const body = state.body ?? '';
          // Only the author identity is consumed by v1 readers. Do not duplicate a large PR
          // description in every chunk; retain its digest and the canonical body location.
          const actor = parseAuthorActorId(body);
          const authorBody = body.length <= 1024 ? body
            : `${actor ? `<!-- authored-by-actor: ${actor} -->` : ''}\n[sha256:${referralHash(body)}; source:${prUrl}]`;
          const usedRunIds = new Set(existing.map(r => r.runId));
          let chunkIndex = 0;
          const newRecord = () => {
            let runId;
            do {
              runId = chunkIndex++ ? `${ctx.runId}:referral-chunk:${chunkIndex}` : ctx.runId;
            } while (usedRunIds.has(runId));
            usedRunIds.add(runId);
            return { version: 1, repo: read.repo, pr: read.pr, head: read.netBasis.rev,
              runId, reviewer: mandatoryReferralReviewer(runId), authorBody,
              attempted: false, referrals: [], rulings: [] };
          };
          // Advisory supersession defaults on; WE_REFERRAL_ADVISORY_SUPERSEDE=0 restores independent attempts.
          const supersessionContext = {
            records: readReferralRecords(state.comments, context(state)).records,
            operatorRulings: readOperatorRulings(state.comments, context(state)).rulings,
            head: read.netBasis.rev, repo: read.repo, pr: read.pr,
          };
          const live = [], superseded = [];
          for (const referral of additions.values()) {
            const by = env.WE_REFERRAL_ADVISORY_SUPERSEDE === '0' ? null : findSupersedingNotReal(referral, supersessionContext);
            (by ? superseded : live).push({ referral, by });
            if (by) out(`referral superseded: ${referral.seat} ${referral.finding.file ?? ''}${referral.finding.line == null ? '' : `:${referral.finding.line}`} — mandatory not-real ruling ${by.rulingId ?? 'operator'} stands`);
          }
          // Keep retired obligations in their own chunks so they never spend an automated attempt.
          for (const group of [live, superseded]) {
            if (!group.length) continue;
            let record = newRecord();
            for (const { referral, by } of group) {
              const append = r => ({ ...r, referrals: [...r.referrals, referral],
                ...(by ? { superseded: [...(r.superseded ?? []), { key: referral.key, reason: REFERRAL_SUPERSEDE_REASON, by }] } : {}) });
              const candidate = append(record);
              // Leave room for ordinary rulings; persist still checks every completed/failure snapshot.
              if (record.referrals.length && renderReferralRecord(candidate).length > commentBudget / 2) {
                chunks.push(record);
                record = newRecord();
              }
              const single = append(record);
              if (renderReferralRecord(single).length > commentBudget - 2000) {
                overflow(`finding key sha256:${referralHash(referral.key)} from ${sourceByKey.get(referral.key) ?? prUrl} exceeds ${commentBudget} characters with its v1 identity intact; requires manual review`);
                continue;
              }
              record = single;
            }
            if (record.referrals.length) chunks.push(record);
          }
          for (const chunk of chunks) {
            state = persist(chunk);
            existing.push(chunk);
          }
        }
        if (env.WE_REFERRAL_CARRY_OPERATOR_RULINGS !== '0') {
          const records = readReferralRecords(state.comments, context(state)).records;
          const operatorRulings = readOperatorRulings(state.comments, context(state)).rulings;
          for (let i = 0; i < existing.length; i++) {
            const record = existing[i], carried = [];
            // Findings a reviewer's ruling on THIS head already settles (counted: independent clearer, readable card).
            // `referralRecordState` reads `carried` before rulings, so a carry here would silently replace a
            // current-head block with an earlier head's operator ruling. An UNcounted ruling settles nothing.
            const stillPending = record.rulings.length
              ? new Set(referralRecordState(record, { ...context(state), head: record.head, records, operatorRulings }).pending) : null;
            for (const f of activeReferrals(record)) {
              if ((record.carried ?? []).some(c => c.key === f.key)
                || (stillPending && record.rulings.some(r => r.key === f.key) && !stillPending.has(f.key))
                || operatorRulings.some(o => o.repo === record.repo && o.pr === record.pr
                  && o.head === record.head && o.runId === record.runId && o.key === f.key)) continue;
              // #76c — else the mandatory reviewer's own counted not-real/card on the same deterministic finding
              // identity (never a block, never a declared link); the same unchanged-lines proof applies below.
              const match = findCarriedOperatorRuling(f, { records, operatorRulings,
                head: record.head, repo: record.repo, pr: record.pr })
                ?? findCarriedReviewerRuling(f, { records, operatorRulings, head: record.head, repo: record.repo,
                  pr: record.pr, body: state.body ?? '', createdAt: state.createdAt ?? '', cardReadable });
              if (!match) continue;
              // `referralRecordState` keeps a carried `card` pending while its card is unreadable, yet `liveReferrals`
              // drops a carried finding from dispatch: that pairing would hold the gate with no reviewer to clear it.
              if (match.result === 'card' && !cardReadable(match.card)) continue;
              let changed;
              try {
                // The exact cited path: an `a/` or `b/` prefix may be a real directory, so it is never stripped for a lookup.
                const file = exactCitedPath(f.finding.file);
                changed = await changedLines(record.repo, match.from.head, record.head, file);
              } catch { changed = null; }
              if (!(changed instanceof Set)) continue;
              // Each citation is checked in its own revision's coordinates: this finding's line against the new side,
              // the earlier ruled finding's line against the old side (a plain injected Set serves for both).
              if (changesTouchCitedLines(changed, [f.finding.line])
                || changesTouchCitedLines(changed.old ?? changed, [match.finding.line])) continue;
              carried.push({ key: f.key, reason: REFERRAL_CARRY_REASON, from: match.from,
                result: match.result, ...(match.card ? { card: match.card } : {}) });
            }
            if (!carried.length) continue;
            const updated = { ...record, carried: [...(record.carried ?? []), ...carried] };
            if (renderReferralRecord(updated).length > commentBudget) {
              overflow(`historical run ${record.runId} carry exceeds ${commentBudget} characters; original record retained`);
              continue;
            }
            state = persist(updated);
            existing[i] = updated;
            for (const c of carried) {
              const f = record.referrals.find(f => f.key === c.key).finding;
              out(`referral carried: ${f.file ?? ''}${f.line == null ? '' : `:${f.line}`} — ${c.from.rulingId !== undefined ? 'reviewer' : 'operator'} ${c.result} from ${c.from.head.slice(0, 8)} stands (cited lines unchanged)`);
            }
          }
        }
        // Persist the attempt before dispatch. A crash or timeout spends this set's single automated attempt.
        for (const initial of existing) {
          // A record already attempted (or parked on a failure) is never re-asked wholesale; only a carried finding
          // whose backing was withdrawn since (below) is asked again, once.
          if (initial.attempted && (initial.failure || !(initial.carried ?? []).length)) continue;
          if (!liveReferrals(initial).length && !(initial.carried ?? []).length) continue;
          const records = readReferralRecords(state.comments, context(state)).records;
          const initialState = referralRecordState(initial, { ...context(state), records,
            // #4979 — an operator ruling already settled these findings; never spend the automated attempt on them.
            operatorRulings: readOperatorRulings(state.comments, context(state)).rulings });
          if (!initialState.pending.length) continue;
          // A carry the gate holds pending no longer stands (its backing was withdrawn: a later block, a superseded or
          // re-ruled source, an unreadable card). `liveReferrals` drops carried keys from dispatch, so without this the
          // hold would have no owner and no automatic way out — the reviewer rules the finding afresh instead.
          const withdrawn = new Set((initial.carried ?? [])
            .filter(c => initialState.pending.includes(c.key) && !initial.rulings.some(r => r.key === c.key)).map(c => c.key));
          const reask = initial.attempted;
          const askable = liveReferrals(initial, { withdrawn }).filter(f => !reask || withdrawn.has(f.key));
          // #76b — one ruling per finding per head: a finding whose id already holds a counted block on this head is
          // blocked by that ruling (`linkedBlockedFindingIds`), so the reviewer is never asked about it again. The rest
          // go out with their own `findingId` and the PR's identity table, so the reviewer can link a re-wording.
          const identityTable = findingIdentityTable(records);
          const linkedKeys = new Set(initialState.rulings.filter(r => r.linked).map(r => r.key));
          const ask = askable.filter(f => !linkedKeys.has(f.key))
            .map(f => ({ ...f, findingId: findingIdOf(identityTable, { head: initial.head, runId: initial.runId, key: f.key }) }));
          if (!ask.length) continue;
          // A re-ask of a withdrawn carry spends its single attempt the same way, with a durable marker (cleared when
          // the reviewer answers): a crash or an omitted ruling leaves the record parked, never asked again.
          let record = { ...initial, attempted: true, ...(reask ? { failure: WITHDRAWN_CARRY_REASK } : {}) };
          state = persist(record);
          // Hold before dispatch too: an exhausted or interrupted worker must leave a visible owner.
          if (!labelNames(state.labels).includes('review:human')) {
            labelProvider.setLabels(read.repo, read.pr, { add: 'review:pending',
              remove: ['review:accepted', 'review:changes'].filter(l => labelNames(state.labels).includes(l)) });
          }
          try {
            const request = buildReviewJudgeRequest({ read, lens: 'correctness' });
            const answer = await referralJudge({ ...request, runId: record.runId,
              lens: 'mandatory-referral-correctness', sessionId: record.reviewer.id,
              // This bounded evidence pass reads the same pinned diff. It cannot edit or file a promised card.
              allowedTools: null,
              mandate: request.mandate + '\nIndependently verify every referral in the input. Return exactly one '
                + 'block, card, or not-real ruling per key, with rationale and evidence references. A general accept '
                + 'is not a ruling. card requires an existing durable we:backlog/*.md reference. Do not recursively refer findings.\n'
                + FINDING_SAME_AS_MANDATE,
              input: request.input + '\nUntrusted known findings on this PR (identity table; for sameAs only):\n'
                + JSON.stringify(findingIdentityPromptRows(identityTable))
                + '\nUntrusted reported findings:\n' + JSON.stringify(ask),
              shape: { type: 'object', additionalProperties: false, required: ['rulings'], properties: {
                rulings: { type: 'array', items: { type: 'object', additionalProperties: false,
                  required: ['key', 'result', 'rationale', 'evidence', 'card', 'sameAs'], properties: {
                    key: { type: 'string' }, result: { type: 'string', enum: ['block', 'card', 'not-real'] },
                    rationale: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } },
                    card: { type: 'string' }, sameAs: { type: 'string' },
                  } } },
              } },
            });
            if (answer.sessionId !== record.reviewer.id || answer.timedOut) throw new Error('mandatory reviewer authority or budget unavailable');
            // #76b — a declared link is kept only when it names ANOTHER known id and passes the structural guard (same
            // path, same lens, no contradicting cited line); "new", a self-link or anything else records no link, so
            // the deterministic binding stands. The link rides on the append-only ruling, never on the referral entry.
            const sameAsFor = (key, sameAs) => {
              const f = ask.find(x => x.key === key);
              if (!f || !FINDING_ID_PATTERN.test(sameAs ?? '') || sameAs === f.findingId) return undefined;
              return sameAsLinkAllowed(identityTable.find(e => e.findingId === sameAs), f.original) ? sameAs : undefined;
            };
            // A re-ask lands on a record that already holds rulings (`runId:0`…): number past them, or the duplicate id
            // makes the whole record invalid and the answer is lost.
            const takenIds = new Set(record.rulings.map(r => r.id));
            let nextId = 0;
            const rulings = (answer.value?.rulings ?? []).map(({ sameAs, ...r }) => {
              const link = sameAsFor(r.key, sameAs);
              if (link) out(`referral linked: ${r.key} sameAs ${link}`);
              while (takenIds.has(`${record.runId}:${nextId}`)) nextId++;
              const id = `${record.runId}:${nextId}`;
              takenIds.add(id);
              return { ...r, ...(link ? { sameAs: link } : {}), id, reviewerId: record.reviewer.id, lens: record.reviewer.lens };
            });
            const completed = { ...record, rulings: [...record.rulings, ...rulings] };
            if (!validateReferralRecord(completed)) throw new Error('incomplete or malformed mandatory rulings');
            // Preserve every ruling that fits; omitted rulings leave their keys pending in all
            // existing readers. Never lose an otherwise durable batch to one verbose answer.
            for (const ruling of rulings) {
              const candidate = { ...record, rulings: [...record.rulings, ruling] };
              if (renderReferralRecord(candidate).length <= commentBudget - 2000) record = candidate;
              else {
                const reason = overflow(`ruling ${ruling.id} for key sha256:${referralHash(ruling.key)} exceeds ${commentBudget} characters; ruling sha256:${referralHash(JSON.stringify(ruling))} withheld, key remains pending`);
                record = { ...record, failure: reason };
              }
            }
          } catch (error) {
            // The attempted record is already durable; no second automatic dispatch on resume.
            record = { ...record, failure: String(error.message).slice(0, 400) };
            out(`Mandatory referral review parked: ${error.message}`);
          }
          // The re-ask marker only parks a re-ask that produced no ruling: an answered one leaves no failure behind.
          if (record.failure === WITHDRAWN_CARRY_REASK && ask.every(f => record.rulings.some(r => r.key === f.key))) {
            const { failure, ...answered } = record;
            record = answered;
          }
          state = persist(record);
        }
        state = fresh();
        const result = mandatoryReferralState(state.comments, context(state));
        if (overflows.length) {
          const reason = `${overflows.length} overflow hold(s). ${overflows[0]}`;
          for (const detail of overflows) {
            labelProvider.postComment(read.repo, read.pr, `Mandatory referral review parked to review:human: ${detail}`);
          }
          result.pending.push('referral-overflow');
          result.reason = reason;
        }
        if (result.pending.length) park(state);
        for (const record of result.records) mirrorReferral(record);
        return result;
      } catch (error) {
        // A push that lands mid-run is a routine race, not a persistence refusal: rethrow so the hold the earlier
        // pass left stays as-is and the effect is retried against the new head, never parked for a human.
        if (error instanceof HeadChangedError) throw error;
        // A persistence refusal is terminal for automation, including a failed failure snapshot.
        // Re-read labels without the head guard so the park lands on the PR's live labels.
        let live = state;
        try { live = labelProvider.readPrState(read.repo, read.pr); }
        catch (readError) { out(`Could not refresh referral park labels: ${readError.message}`); }
        if (!live) live = { labels: read.labels ?? [] };
        park(live);
        const reason = String(error.message ?? error).replace(/\s+/g, ' ').slice(0, 400);
        const message = `Mandatory referral review parked to review:human: ${reason}.`;
        try { labelProvider.postComment(read.repo, read.pr, message); }
        catch (commentError) { out(`Could not post referral park reason: ${commentError.message}`); }
        out(message);
        return { records: [], pending: ['referral-persistence-failed'], blocked: [], malformed: false, reason };
      }
    },
    // ── 0. THE COMMENT BODY, staged locally. Deterministic path, deterministic bytes → safe to redo. ────────
    // The path is RUN-SCOPED (`reviewBodyPath`) so two runs on the same PR in one checkout cannot cross-stage.
    // Deterministic PER RUN is still deterministic for a replay, which is what `idempotent: true` asserts.
    [REVIEW_EFFECTS.WRITE_UP]: async (payload, ctx) => {
      const path = reviewBodyPath({ root, runId: ctx?.runId, bodyFile: payload.bodyFile });
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, String(payload.body), 'utf8');
      return { path, bytes: String(payload.body).length };
    },

    // ── 1. THE LABEL SWAP — the SINGLE HOME, as a subprocess. ───────────────────────────────────────────────
    // It posts the staged write-up (with the markers) AND applies the label, in the #2964 order it owns. This
    // sink adds no policy of its own: it builds argv, runs it, and reports.
    [REVIEW_EFFECTS.LABEL]: async (payload, ctx) => {
      // The SAME run-scoped path effect 0 wrote — both sinks derive it from `ctx.runId`, which is one run's id
      // for every effect in that run, so 1 always posts the write-up 0 staged and never a sibling run's.
      const bodyPath = reviewBodyPath({ root, runId: ctx?.runId, bodyFile: payload.bodyFile });
      const argv = [
        join(root, 'scripts', 'review-set-label.mjs'),
        String(payload.pr),
        `--repo=${payload.repo}`,
        `--to=${payload.to}`,
        `--actor=${payload.actor}`,
        // #2898 — state the surface the verdict actually came through. Conditional because the payload shape
        // predates the flag: a run record written before it (a `--resume` across the upgrade) has no `channel`,
        // and the single home's own default for an absent one is the NEUTRAL sentence, never a wrong channel.
        ...(payload.channel ? [`--channel=${payload.channel}`] : []),
        `--body-file=${bodyPath}`,
      ];
      let stdout = '';
      try {
        stdout = String(runNode(argv, { cwd: root }));
      } catch (e) {
        stdout = String((e && e.stdout) || '');
        const text = parseCliError(stdout) || String((e && e.message) || e).split('\n').filter(Boolean).pop() || 'review-set-label.mjs failed';
        if (isPreWriteRefusal(text)) {
          // PROVABLY nothing landed → `failed`, retried on the next pass.
          throw notApplied(`review-set-label.mjs refused before any write: ${text}`, { argv });
        }
        // INDETERMINATE. A plain throw leaves the entry `pending`; the effect is declared NON-idempotent, so
        // the executor REFUSES to replay it and a person decides. That is the fail-closed answer, and it is
        // what stops a second durable comment being posted on a guess.
        throw new Error(`review-set-label.mjs failed and its outcome is UNKNOWN: ${text}`);
      }
      const parsed = safeJson(stdout);
      if (parsed && parsed.error) {
        if (isPreWriteRefusal(parsed.error)) throw notApplied(`review-set-label.mjs refused: ${parsed.error}`, { argv });
        throw new Error(`review-set-label.mjs reported an error and its outcome is UNKNOWN: ${parsed.error}`);
      }
      return parsed ?? { raw: stdout.trim() };
    },

    // ── 2. THE LEDGER ROW — NOW THE REAL #3007 LEDGER, VIA RECONCILIATION RATHER THAN A SECOND WRITE. ───────
    //
    // WHAT THIS REPLACED. Until #3007 shipped a writer, this sink appended to a gitignored, session-local
    // sidecar at `.operations/review/verdicts.pending.jsonl` whose own result string said "NOT the #3007
    // verdict ledger". Its doc said the default would be "deleted rather than migrated" when the real writer
    // arrived. It is deleted here, and NOT migrated: those rows carry no write timestamp, no session id and no
    // head sha — the three fields that make a row a verdict RECORD rather than a payload echo — so importing
    // them would mean inventing the values the schema exists to attest. One row existed in the primary
    // checkout (PR #1146, 2026-08-09, accepted), and the label + comment it mirrors are still on that PR, which
    // is the durable record of it. The sidecar is session-local and gitignored, so there was never a complete
    // set to import in the first place.
    //
    // WHY THIS RECONCILES INSTEAD OF APPENDING. `we:scripts/review-set-label.mjs` is the SINGLE HOME of a label
    // swap and is now also the single home of a ledger row — effect 1 above shells it, so by the time this sink
    // runs the row already exists. Appending again here would put TWO rows in an append-only merge authority
    // for one verdict, which no dedupe can undo later. So this sink READS the ledger and reports the row effect
    // 1 wrote; it appends only when the ledger's LIVE verdict for the PR is not the one this round decided —
    // which means the single home's fail-soft write missed — and stamps that recovery row
    // `source: 'operation-reconcile'` so the ledger says which path produced it.
    //
    // WHAT COUNTS AS "ALREADY THERE" — THIS ROUND'S VERDICT, NOT ANY ROW AT ALL (PR #1149 review).
    // The first cut asked only whether the PR had a folded entry, and that is wrong in the ORDINARY
    // multi-round case, which is most PRs: a PR that got `changes` and later `accepted` has a `changes` row
    // from round 1, so when round 2's single-home append fail-softs the sink finds that stale row, reports
    // `{reconciled: true, verdict: 'changes'}`, and NEVER writes the acceptance. The ledger is then left
    // holding the superseded verdict while the label says accepted — the exact ledger/label disagreement this
    // whole item exists to detect, manufactured by the thing meant to prevent it. Reproduced by appending an
    // older `changes` row and calling this sink with `to: 'accepted'`.
    //
    // So the test is `folded.current.verdict === the verdict this payload implies`. The fold is latest-wins,
    // so `current` IS the ledger's live verdict for the PR; the question "did effect 1's write land?" is
    // exactly "does the live verdict already say what this round decided?". Both sides derive the verdict
    // through the ONE `verdictForLabelTarget` the writer uses, so they cannot disagree about what `to` means —
    // which is what makes the comparison sound rather than merely plausible.
    //
    // WHY NOT A CORRELATION ID FROM EFFECT 1, the exact alternative. It would distinguish rounds perfectly,
    // and its FAILURE MODE is the one thing that must never happen. The id has to survive being frozen into
    // the run record at suspend, cross a process boundary as a `review-set-label.mjs` argv flag, and land in a
    // new schema field; the moment any of those drops it, no row carries the id, the sink concludes the write
    // missed, and it APPENDS — a second row for one verdict in an append-only authority, which nothing can
    // undo. Verdict comparison fails the other way: its one ambiguity is a verdict that legitimately REPEATS
    // (a second `accepted` after a re-review), where the sink treats the earlier identical row as this
    // round's and writes nothing. That costs a duplicate history row saying what the ledger already says —
    // `current`, `clears` and `outstandingHolds` are all unchanged by its absence, so no consumer, present or
    // Phase-2, computes a different answer. An under-write of a redundant row against an unrecoverable
    // double-write of a real one is not a close call.
    //
    // The DECLARATION is unchanged (`we:scripts/operations/review-pr.mjs` still declares
    // `verdict-ledger.append` at ordinal 2, still `idempotent: false`), which was the point of the reserved
    // seam: #3007 registers a writer behind the same effect type without the operation moving.
    [REVIEW_EFFECTS.LEDGER]: async (payload) => {
      const pr = Number(payload.pr);
      // FAIL CLOSED on a target this repo does not know: `null` here would become a `verdict` the record
      // builder refuses, so say so as a refusal rather than recording a guessed disposition.
      const verdict = verdictForLabelTarget(payload.to);
      if (!verdict) throw notApplied(`verdict-ledger: unknown label target ${JSON.stringify(payload.to)}`);
      const folded = foldRepo(payload.repo).get(pr);
      if (folded && folded.current && folded.current.verdict === verdict) {
        return {
          reconciled: true,
          path: verdictLedgerPath(payload.repo),
          verdict: folded.current.verdict,
          at: folded.current.at,
          source: folded.current.source,
        };
      }
      const appended = appendVerdict(buildVerdictRecord({
        repo: payload.repo,
        pr,
        verdict,
        at: new Date().toISOString(),
        reason: payload.reason || `recorded by the review-pr operation (${payload.lens} lens)`,
        declaredActor: payload.actor,
        session: currentActorId(),
        channel: payload.channel || '',
        source: 'operation-reconcile',
        findingCount: Array.isArray(payload.findings) ? payload.findings.length : null,
      }));
      if (!appended.ok) throw notApplied(`verdict-ledger append refused: ${appended.errors.join('; ')}`);
      return { reconciled: false, path: appended.path, verdict: appended.record.verdict, source: 'operation-reconcile' };
    },

    // ── LEDGER EVENTS (plan slice E2): `referral` (when this run opened findings) and `review-run{posted}`. ──
    // ADDITIVE: it changes no comment, label or decision. Both events are NON-CLEARING (holding), so the
    // statute write-miss posture (#verdict-ledger-pr-state-store rule 4) is: a failed append never blocks or
    // throws; it prints a loud `ledger-write-miss` line and the run goes on with its label hold unchanged.
    [REVIEW_EFFECTS.LEDGER_EVENTS]: async (payload, ctx) => {
      // #xrw21vx — each row's identity is THIS EFFECT (ctx.key) plus the row type, never the row's own bytes.
      // `ledgerEventId` otherwise hashes the whole row, `at` included: two distinct runs in one millisecond then
      // collide into one row, and a replay of one effect gets a new `at` and counts twice. No key (a direct call
      // outside the executor) has no replay identity to honour, so it gets a fresh random id: never merged.
      const rowId = (type) => (ctx?.key
        ? `review-pr:${createHash('sha256').update(`${ctx.key}\n${type}`).digest('hex')}`
        : `review-pr:rand:${randomUUID()}`);
      const base = { repo: payload.repo, pr: payload.pr, source: 'review-pr', session: currentActorId(), channel: 'review-pr' };
      const rows = [];
      const keys = Array.isArray(payload.referralKeys) ? payload.referralKeys : [];
      if (payload.headSha && keys.length) {
        rows.push({ type: EVENT_TYPES.REFERRAL, headSha: payload.headSha, findingKeys: keys.map((k) => `sha256:${referralHash(String(k))}`) });
      }
      if (payload.headSha) rows.push({ type: EVENT_TYPES.REVIEW_RUN, headSha: payload.headSha, phase: 'completed', posted: payload.posted === true });
      // An unpinned or degraded read names no head, so there is nothing to key a row on. That is a skipped write,
      // not a quiet success: say so loudly, the same way a write miss does, so the undercount is never silent.
      if (!payload.headSha) out(`ledger-write-skip: ${payload.repo}#${payload.pr} no pinned head, so no review-run row was recorded for this run (it will not count toward the visit cap); comments, labels and decisions are unaffected`);
      const written = []; const missed = [];
      for (const row of rows) {
        try {
          const res = appendVerdict({ ...buildLedgerEvent({ ...base, ...row, at: new Date().toISOString() }), id: rowId(row.type) });
          if (res.ok && !res.ledgerWriteMiss) written.push(row.type); else missed.push(`${row.type}: ${(res.errors ?? []).join('; ') || 'git write miss'}`);
        } catch (e) { missed.push(`${row.type}: ${String(e?.message ?? e).split('\n')[0]}`); }
      }
      if (missed.length) out(`ledger-write-miss: ${payload.repo}#${payload.pr} review events not fully recorded (${missed.join(' | ')}); comments, labels and decisions are unaffected`);
      return { written, missed };
    },

    // ── Card 5469 — THE SCOPED RE-REVIEW SHADOW: finding-identity ledger rows + the would-block / would-card journal.
    // SHADOW ONLY: it changes no comment, label or verdict, and it never throws (a miss is one loud line).
    [REVIEW_EFFECTS.SCOPED_REREVIEW_SHADOW]: async (payload) => {
      const summary = recordScopedRereviewShadow({ payload, exec: shadowGitExec, readLedgerRows, appendLedgerRow, appendJournal: appendShadowJournal, out });
      return { recorded: summary !== null, ...(summary ? { summary } : {}) };
    },

    // ── 3. THE EVENT: the operator notice, rendered by `renderReviewNotice` in the declaration. ──────────────
    [REVIEW_EFFECTS.NOTICE]: async (payload) => {
      out(String(payload.notice));
      return { reported: true };
    },

    // ── `advise`'s ADVISORY_NOTE — a BARE comment, no label touched (#xlw02hw). ─────────────────────────────
    // Deliberately NOT `we:scripts/review-set-label.mjs`: that single home always couples a comment with a
    // label swap (#2644), and this step declares no label-swap effect, ever — reaching for it here would mean
    // either inventing a `to` this step has no business deciding, or teaching the single home a comment-only
    // mode it does not have and every OTHER caller must then be trusted not to misuse. `createGhProvider`'s
    // `postComment` is the exact primitive that single home itself calls for its own comment write, so this
    // reuses it directly rather than re-implementing a `gh pr comment` invocation a third time.
    [REVIEW_EFFECTS.ADVISORY_NOTE]: async (payload) => {
      postComment(payload.repo, payload.pr, String(payload.body));
      return { posted: true };
    },

    // ── `advise`'s ADVISORY_LABEL — `advisory:accepted` / `advisory:changes`, never a `review:*` decision. ────
    // The pure decision is `planAdvisoryLabels`; this sink only adds the two guards that need LIVE state:
    //   • the PR must STILL carry `review:human` (a cleared PR is no longer human-gated; its advisory is moot);
    //   • the PR's head must STILL be the commit the panel judged (`reviewedHead`). A push during the review
    //     means the label would describe a head that no longer exists — the exact staleness the sweep in
    //     `we:scripts/conveyor/advisory-label-sweep.mjs` exists to catch afterwards, refused here up front.
    // Both refusals are a quiet `{ applied: false, reason }`, not an error: nothing landed and nothing is owed.
    // It adds only an `advisory:*` label and removes only the opposite one and `review:pending` — never
    // `review:human`, never `review:accepted` (`planAdvisoryLabels` cannot produce either).
    [REVIEW_EFFECTS.ADVISORY_LABEL]: async (payload) => {
      const state = labelProvider.readPrState(payload.repo, payload.pr);
      const labels = labelNames(state?.labels);
      if (!labels.includes('review:human')) return { applied: false, reason: 'not-human-gated' };
      if (!payload.reviewedHead) return { applied: false, reason: 'unpinned-basis' };
      if (!advisoryCoversHead({ head: payload.reviewedHead }, state?.headRefOid)) {
        return { applied: false, reason: 'head-moved' };
      }
      const plan = planAdvisoryLabels({ outcome: payload.outcome, currentLabels: labels });
      if (plan.reason) return { applied: false, reason: plan.reason };
      if (!plan.add && plan.remove.length === 0) return { applied: false, reason: 'already-current' };
      // `gh pr edit --add-label` refuses a label the repo has never had; ensure is create-or-update (`--force`).
      if (plan.add) labelProvider.ensureLabel(payload.repo, plan.add, ADVISORY_LABEL_META[plan.add]);
      labelProvider.setLabels(payload.repo, payload.pr, { add: plan.add ?? undefined, remove: plan.remove });
      return { applied: true, added: plan.add, removed: plan.remove };
    },
    // ── `advise`'s AWAITING_ADVISORY_CLEAR — the mechanical flip of `review:awaiting-advisory` (mechanical-
    // dispatcher lane). Declared ONLY ever reached AFTER `ADVISORY_NOTE` above has actually landed (see the
    // ordering note on that effect in `review-pr.mjs`'s `advise` step) — this sink's own job is narrower still:
    // re-read the PR's LIVE labels right before writing (the same "narrow the removal to what is actually
    // there" discipline `we:scripts/review-set-label.mjs#presentRemoveLabels` uses), because `gh pr edit
    // --remove-label` ERRORS on a label the PR does not carry rather than no-op'ing. A live miss (the label was
    // already cleared by an earlier attempt, or never applied at all) is therefore treated as ALREADY the
    // desired end state, not a failure — which is what makes this effect genuinely safe to mark `idempotent:
    // true` above. Never `we:scripts/review-set-label.mjs`: that single home always couples a comment with a
    // full verdict label-swap (#2644), and this is a bare removal with no verdict attached, exactly the same
    // reason `ADVISORY_NOTE` reuses `createGhProvider` directly instead.
    [REVIEW_EFFECTS.AWAITING_ADVISORY_CLEAR]: async (payload) => {
      const live = readLabels(payload.repo, payload.pr);
      if (!hasReviewLabel(live, REVIEW_LABELS.awaitingAdvisory)) {
        return { cleared: false, alreadyAbsent: true };
      }
      setLabels(payload.repo, payload.pr, { remove: [REVIEW_LABELS.awaitingAdvisory] });
      return { cleared: true };
    },
  };
}

/** The `{"error": …}` payload the review CLIs print on a refusal, or `''`. */
function parseCliError(stdout) {
  const parsed = safeJson(stdout);
  return parsed && typeof parsed.error === 'string' ? parsed.error : '';
}

/** Parse the LAST JSON line of a CLI's stdout, tolerating banner noise. Returns `null` when there is none. */
function safeJson(stdout) {
  const lines = String(stdout || '').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch { /* keep walking back */ }
  }
  return null;
}
