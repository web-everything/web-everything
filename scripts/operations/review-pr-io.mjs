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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleReviewDetail } from '../review-detail.mjs';
import { computeNetDiffPaths, computeNetDiffText, resolveNetDiffBasis } from '../merge-ai-prs.mjs';
import { currentActorId } from '../lib/review-independence.mjs';
// #xlw02hw — the `advise` step's sink posts a BARE comment (never `we:scripts/review-set-label.mjs`, which
// always couples a comment with a label swap — #2644 — and this step swaps no label). `createGhProvider`'s
// `postComment` is the SAME primitive that single home already uses, imported rather than re-implemented.
import { createGhProvider } from '../lib/review-label-provider.mjs';
// #3007 — the real verdict ledger, behind the reserved `verdict-ledger.append` seam. See the LEDGER sink.
import { appendVerdict, buildVerdictRecord, foldRepo, verdictForLabelTarget, verdictLedgerPath } from '../lib/verdict-ledger.mjs';
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
import { isValidRunId } from './run-record.mjs';

export { PR_VIEW_FIELDS, prViewFileName };

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
  if (haveRepo !== repo) {
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
    net: { ...netPaths, revSha: revParseCommit(gitExec, netPaths.rev) },
    diff: netText,
  };
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
  if (originRepo(cwd) === repo) return { path: cwd, probed };
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
      if (originRepo(candidate) === repo) return { path: candidate, probed };
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

/** Is this CLI error text one we can PROVE happened before any write? */
export function isPreWriteRefusal(text) {
  const s = String(text || '');
  return PRE_WRITE_REFUSALS.some((p) => s.includes(p));
}

/**
 * THE SINKS, bound to a repo root and an output channel.
 *
 * @param {{root?: string, out?: (line: string) => void, runNode?: Function, postComment?: Function, json?: boolean}} [o] -
 *   `runNode` is the injectable subprocess runner (`(argv) => stdout`), so the label sink is testable without
 *   `gh`; `postComment` is the injectable `(repo, pr, body) => void` the `advise` sink posts through (#xlw02hw),
 *   so it too is testable without `gh` — defaults to `createGhProvider().postComment`. `json` is STDOUT-PURITY
 *   FOR THE NOTICE SINK ONLY (see the default `out` below) — a caller building sinks for a `--json` invocation
 *   passes `json: true` so the sink's default writer moves off stdout; every other sink here is unaffected
 *   because none of them write to stdout at all.
 * @returns {Record<string, Function>} effect type → `async (payload, ctx) => result`.
 */
export function createReviewPrSinks({
  root = REPO_ROOT,
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
} = {}) {
  return {
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
