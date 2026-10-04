/**
 * @file scripts/operations/record-verdict-io.mjs
 * @description THE IO SHELL of the `record-verdict` declaration — read the run the review wrote, and stage the
 *   request the transport carries.
 *
 * EVERY RULE IT APPLIES BELONGS TO SOMEBODY ELSE, and that is deliberate:
 *   · the run record is read through `./run-store.mjs`, the store the engine writes;
 *   · the staged write-up is located with `./review-pr-io.mjs`'s own `reviewBodyPath`, so this cannot disagree
 *     with where the review put it — the run-scoped path exists because a PR-keyed one let two runs clobber
 *     each other, and re-deriving it here would reintroduce exactly that;
 *   · the request's legality is `we:scripts/apply-review-request.mjs`'s `validateRequest`, imported by the
 *     caller in `./run.mjs` and passed in, never restated.
 *
 * WHAT IS GENUINELY NEW HERE is only the push: writing the request onto the transport branch. Nothing owned
 * that before, because it was a shell one-liner each time.
 *
 * THE PUSH IS A SEPARATE CHECKOUT ON PURPOSE. `ops/review-requests` is an orphan-ish transport branch, and the
 * lane you are working in is on a feature branch with your own uncommitted work. Checking the transport branch
 * out over that lane would destroy it — I did the equivalent by hand earlier in the session and it disrupted a
 * running juror. So the sink writes through a dedicated worktree, leaving the caller's checkout untouched.
 *
 * ONBOARDING A REPO IS PART OF THE SINK'S JOB, not a paragraph someone has to find (#3264). Since #3261 each
 * repo owns its own board, so the common case is now a repo that has never carried a verdict. `ensureBoardBranch`
 * cuts the board from `main` on first use, `assertApplierRidesBoard` refuses a board that cannot apply, and
 * `trackingRefspec` names the destination ref so none of it depends on how the checkout was cloned.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalizeSlug } from '../lib/constellation-repos.mjs';

import { stageOnTransportBranch, trackingRefspec } from '../lib/git-transport-branch.mjs';

// RE-EXPORTED, not re-declared (#2644). `trackingRefspec` moved to `we:scripts/lib/git-transport-branch.mjs`
// when the worktree dance was extracted there — it is a fact about git's refspec grammar, true of every
// transport branch, and that module is the one every transport shares. Kept exported from here because tests
// and #3264's own prose reference it at this path, and a moved symbol should not break its callers silently.
export { trackingRefspec };
import { createFileRunStore } from './run-store.mjs';
import { reviewBodyPath, createReviewPrReader, createReviewPrSinks } from './review-pr-io.mjs';
import { STAGE_REQUEST_EFFECT } from './record-verdict.mjs';
// #3540 — THE LOCAL DRIVE. `advance`/`runStatus` are the engine's own pure step machinery, `applyPendingEffects`
// is the ONE thing allowed to apply a declared effect, and `reviewPrOperation`/`REVIEW_EFFECTS`/`confirmAnswerFor`
// are review-pr's OWN declaration and vocabulary — all imported, none re-derived, so this file's auto-drive
// cannot answer `confirm` or stage a write-up any differently than a caller driving `review-pr` by hand would.
import { advance, runStatus } from './engine.mjs';
import { applyPendingEffects } from './effect-executor.mjs';
import { createRegistry } from './registry.mjs';
import {
  reviewPrOperation, REVIEW_EFFECTS, confirmAnswerFor, codexAdvisoryFromRun, correctnessAdvisoryFromEnv,
  antigravityReviewFromEnv,
} from './review-pr.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Resolved by SCRIPT LOCATION, never cwd — same reason `run-store.mjs` and `review-pr-io.mjs` do it. */
export const REPO_ROOT = resolve(HERE, '..', '..');

/** The branch CI watches. `we:.github/workflows/apply-review-request.yml` triggers on a push to it. */
export const TRANSPORT_BRANCH = 'ops/review-requests';

/**
 * The applier definition that MUST RIDE THE BOARD ITSELF, and the reason the board is a full branch (#3264).
 *
 * GitHub runs a `push`-triggered workflow from the definition ON THE PUSHED REF, not from `main`. So a board
 * that does not carry this file accepts every push and applies nothing: the verdict looks staged, the run
 * reports `pushed: true`, and no label ever moves. That is a FAIL-SILENT — the direction this transport can
 * least afford, because the only signal a verdict was applied is the label itself.
 *
 * `we:` board works because it happens to be a full branch off `main`. That was an accident of how it was
 * first made by hand; `assertApplierRidesBoard` is what turns it into a checked requirement.
 */
export const APPLIER_WORKFLOW = '.github/workflows/apply-review-request.yml';

/** Where a board is BORN from — the branch that carries the applier. Never an orphan; see `APPLIER_WORKFLOW`. */
export const BOARD_SOURCE_BRANCH = 'main';

/**
 * Which checkout carries the transport branch for `repo`, and a REFUSAL when it is not this one (#3261).
 *
 * THE RULING: each repo owns its own notes. A verdict for `owner/x` is staged on `owner/x`'s OWN
 * `ops/review-requests` branch, applied by that repo's own workflow with its own repo-scoped token. Ruled on a
 * scaling test — at 100 repos a central board is not merely large, it is structurally wrong: every applier
 * would need cross-repo READ on a branch none of them owns.
 *
 * WHY THIS FUNCTION REFUSES RATHER THAN DEFAULTS. Before the ruling, a verdict for a sibling repo was pushed
 * onto THIS repo's branch and the applier failed with a raw `Could not resolve to a Repository` — the token is
 * repo-scoped (#3261's own evidence: one failure in fifty applier runs, and it was the only cross-repo
 * request). Defaulting to the local checkout would put a plateau-app verdict on web-everything's board again,
 * where the right applier will never see it and the wrong one cannot act on it. So a mismatch is an ERROR that
 * names both repos, never a silent push to the wrong board.
 *
 * `originRepo` is INJECTED so this is testable with no git, and so a caller that already knows the checkout
 * (the conveyor, a test) can say so instead of being probed.
 *
 * THE RULING IS BROADER THAN THIS ONE TRANSPORT, so the wording is parameterised (#xaoja7a). `stage-pr-view`
 * pushes a VIEW request to `ops/pr-views` and needs the identical decision — same repo-scoped token, same
 * stranding failure if it lands on the wrong board. Copying the function to say "a view request" instead of
 * "a verdict" would be a second answer to which board a repo's notes live on. The defaults reproduce
 * `record-verdict`'s own message byte for byte, so nothing that reads it changes.
 *
 * @param {{repo: string, root?: string, repoRoot?: string, originRepo?: Function, who?: string, what?: string, branch?: string}} o
 * @returns {string} the checkout whose `origin` is `repo`
 */
export function resolveTransportRoot({
  repo,
  root = REPO_ROOT,
  repoRoot = '',
  originRepo = defaultOriginRepo,
  who = 'record-verdict',
  what = 'a verdict',
  branch = TRANSPORT_BRANCH,
} = {}) {
  const want = String(repo ?? '').trim();
  if (!want) throw new Error(`${who}: no \`repo\` on the request — cannot decide which board it belongs on`);
  const candidate = String(repoRoot ?? '').trim() || root;
  const have = originRepo(candidate);
  if (canonicalizeSlug(have) === canonicalizeSlug(want)) return candidate;
  throw new Error(
    `${who}: refusing to stage ${what} for ${want} on ${have || '(unknown)'}'s transport branch (#3261). `
    + `Each repo owns its own notes: the request must be pushed to that repo's own \`${branch}\`, where `
    + 'ITS applier — holding ITS repo-scoped token — can act on it. A request left on the wrong board is picked '
    + 'up by an applier that cannot resolve the repository, which is how plateau-app#144 was stranded. '
    + `Pass \`--repoRoot=<path to a ${want} checkout>\`.`,
  );
}

/**
 * `owner/name` of a checkout's `origin`, or '' when it cannot be read. Probing must never throw.
 * A LEGACY `chalbert/<repo>` origin (every clone and lane minted before the 2026-10-03 org move) is returned as
 * the repo's CURRENT slug (`canonicalizeSlug`) — otherwise every caller that compares it to a `--repo=` slug
 * refuses, which blocked ALL reviews before their read step (outage 2026-10-03).
 */
export function defaultOriginRepo(cwd) {
  try {
    const url = String(execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', cwd })).trim();
    const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    return m ? canonicalizeSlug(m[1]) : '';
  } catch { return ''; }
}


/**
 * BOARD GENESIS: on a repo that has never carried a verdict, create `ops/review-requests` from `main` (#3264).
 *
 * WHY THIS EXISTS AT ALL. The sink used to fetch the board unconditionally, so the FIRST verdict for every
 * newly-onboarded repo failed on a raw `couldn't find remote ref`. #3261 made per-repo boards the standard,
 * which turned that from a one-time curiosity into the normal onboarding path — plateau-app hit it, and was
 * onboarded BY HAND with `git push origin origin/main:refs/heads/ops/review-requests`, a step that lived
 * nowhere but in a backlog paragraph. This is that step, made code.
 *
 * WHY FROM `main` AND NOT AN ORPHAN. See `APPLIER_WORKFLOW`: the workflow must ride the board or nothing
 * applies. Branching from `main` is what puts it there — and it also encodes the ordering the human had to
 * get right by judgement, since a board cut from a `main` predating the applier would silently apply nothing.
 * `assertApplierRidesBoard` catches that case rather than trusting the ordering.
 *
 * WHY IT PUSHES FROM `refs/remotes/origin/main` AND FETCHES IT FIRST. Same failure as (3) above, one ref over:
 * the remote-tracking ref for `main` is not guaranteed to exist in a narrow clone either, and pushing from the
 * LOCAL `main` would publish whatever that checkout happens to be sitting on — stale, or a lane. The remote tip
 * is the only honest source.
 *
 * @param {{run: Function, board: string, repo?: string, sourceBranch?: string}} o
 * @returns {{created: boolean}} whether this call is the one that brought the board into existence
 */
export function ensureBoardBranch({ run, board, repo = '', sourceBranch = BOARD_SOURCE_BRANCH }) {
  // ONE probe for both refs, read as a SET OF EXACT REF NAMES rather than as a yes/no on the output. Two
  // things make the looser reading wrong: this asks for `main` in the same breath, so the output is non-empty
  // in every healthy case including the one where no board exists; and `ls-remote` patterns match a ref's
  // TAIL, so `ops/review-requests` also answers for `refs/heads/legacy/ops/review-requests`. Either shortcut
  // would conclude "the board exists", skip genesis, and hand the caller back the raw fetch failure this
  // whole function is here to prevent.
  const listed = String(run(['ls-remote', '--heads', 'origin', TRANSPORT_BRANCH, sourceBranch], { cwd: board }) ?? '');
  const refs = new Set(listed.split('\n').map((line) => line.split('\t')[1]?.trim()).filter(Boolean));
  if (refs.has(`refs/heads/${TRANSPORT_BRANCH}`)) return { created: false };

  const onboarding = `git push origin origin/${sourceBranch}:refs/heads/${TRANSPORT_BRANCH}`;
  const subject = repo ? `${repo}'s` : 'this repo\'s';
  if (!refs.has(`refs/heads/${sourceBranch}`)) {
    throw new Error(
      `record-verdict: ${subject} \`origin\` carries no \`${TRANSPORT_BRANCH}\` board and no \`${sourceBranch}\` `
      + `to cut one from (#3264). The board must be a full branch off \`${sourceBranch}\` so that `
      + `\`${APPLIER_WORKFLOW}\` rides it — an orphan branch accepts the push and applies nothing. Onboard the `
      + `repo by hand once its default branch carries the applier: \`${onboarding}\`.`,
    );
  }
  try {
    run(['fetch', '--quiet', 'origin', trackingRefspec(sourceBranch)], { cwd: board });
    run(['push', '--quiet', 'origin', `refs/remotes/origin/${sourceBranch}:refs/heads/${TRANSPORT_BRANCH}`], { cwd: board });
  } catch (cause) {
    throw new Error(
      `record-verdict: ${subject} \`${TRANSPORT_BRANCH}\` board does not exist and could not be created from `
      + `\`${sourceBranch}\` (#3264): ${cause?.message || cause}. The onboarding step is \`${onboarding}\`, run `
      + `in a checkout of that repo by someone who can push to it.`,
      { cause },
    );
  }
  return { created: true };
}

/**
 * REFUSE to stage onto a board that cannot apply — the loud half of #3264's fix.
 *
 * A board missing `APPLIER_WORKFLOW` is not a broken push, it is a push that WORKS and does nothing: GitHub
 * accepts it, no workflow is defined on the pushed ref, and the verdict sits there looking staged forever.
 * Checked from the board's OWN TREE (`ls-tree HEAD`), never from the driver's checkout — the driver having the
 * applier on `main` says nothing about what rides the branch being pushed to, and conflating the two is the
 * exact assumption that made this silent in the first place.
 *
 * `ls-tree` rather than `cat-file -e` because a missing path must be an ANSWER (empty output), not a thrown
 * git error this would then have to tell apart from a real failure.
 */
export function assertApplierRidesBoard({ run, wt, repo = '' }) {
  const found = String(run(['ls-tree', '--name-only', 'HEAD', '--', APPLIER_WORKFLOW], { cwd: wt }) ?? '').trim();
  if (found) return;
  const subject = repo ? `${repo}'s` : 'this repo\'s';
  throw new Error(
    `record-verdict: refusing to stage onto ${subject} \`${TRANSPORT_BRANCH}\` — its tree does not carry `
    + `\`${APPLIER_WORKFLOW}\` (#3264). GitHub runs a push-triggered workflow from the definition ON THE PUSHED `
    + 'REF, so this board would accept the request and apply nothing: the verdict would look staged and no label '
    + 'would ever move. INSPECT THE BOARD BEFORE RE-CUTTING IT. This refusal fires exactly when no applier '
    + 'rode the board, which means the push-triggered workflow never ran on it — so any request sitting there '
    + 'was NEVER applied, and a force-push discards it with no other record. Read `git log` and '
    + `\`git ls-tree\` on \`origin/${TRANSPORT_BRANCH}\` first, apply or re-stage anything outstanding, and only `
    + `then re-cut from a \`${BOARD_SOURCE_BRANCH}\` that carries the applier: `
    + `\`git push --force origin origin/${BOARD_SOURCE_BRANCH}:refs/heads/${TRANSPORT_BRANCH}\`.`,
  );
}

/** The write-up file name `review-pr` stages, per its own `prViewFileName`-style convention. */
export function writeUpName(repo, pr) {
  return `${String(repo).replace('/', '-')}-${pr}-verdict.md`;
}

/**
 * Read one run and its staged write-up. The write-up is OPTIONAL at this layer and refused in the declaration:
 * reading returns what is there, deciding whether that is enough is the declaration's job.
 */
export function createRunReader({ root = REPO_ROOT, store = createFileRunStore() } = {}) {
  return ({ runId }) => {
    const record = store.read(runId) ?? null;
    let body = '';
    if (record?.input?.repo && record?.input?.pr) {
      try {
        body = readFileSync(reviewBodyPath({ root, runId, bodyFile: writeUpName(record.input.repo, record.input.pr) }), 'utf8');
      } catch { body = ''; }
    }
    return { record, body };
  };
}

/**
 * #3540 — ADVANCE `review-pr` TO A STAGED WRITE-UP, LOCALLY, WITH NO `gh`. This is what makes ONE
 * `record-verdict` call (via `we:scripts/operations/record-verdict-cli.mjs`) end to end on a credential-less
 * host: before this, the ONLY thing that staged a write-up was `review-pr`'s own `record` step, whose SAME
 * effect list also swapped the label (needs `gh`) — so reaching the write-up meant a separate, manual
 * `review-pr --resume=<runId> --answer=accept` first, which then halted on the label swap it could never
 * complete (#3540's own reproduction, PR #1961).
 *
 * WHAT THIS DOES. If `record` (the run) is genuinely `awaiting-confirm` and `to` names a real `confirm` answer
 * (see {@link confirmAnswerFor} — `clear-human` names none, since it is the human ceremony's own clearance, not
 * a `review-pr` confirm answer), answers it and applies ONLY the resulting `stageVerdict` effect (#3540's own
 * split — the WRITE_UP, and nothing past it) through the SAME sink `review-pr` itself uses for that type. The
 * run is then advanced ONE step further so `record`'s own label/ledger/notice effects are DECLARED — a legible
 * "here's exactly what's left" record — but they are NEVER APPLIED here: they still need `gh`, and applying
 * them is left to the CI-side applier (`we:.github/workflows/apply-review-request.yml`) once the request this
 * transport stages lands.
 *
 * PURELY ADDITIVE. A run that is not a `review-pr` run, is not genuinely `awaiting-confirm` (already staged,
 * mid-judge, or answered `abstain`), or a `to` that names no confirm answer, passes through UNCHANGED — this
 * never invents a decision the caller has not asked for, and never re-answers a run that already has one.
 *
 * @param {object|null} record - the run record read from the store, or `null`.
 * @param {{to: string, store: {read: Function, write: Function}, sinks?: Record<string, Function>}} o
 * @returns {Promise<object|null>} the (possibly advanced) run record.
 */
export async function advanceReviewPrToWriteUp(record, { to, store, sinks = createReviewPrSinks() } = {}) {
  const answer = confirmAnswerFor(to);
  if (!answer || !record || record.op !== 'review-pr') return record;

  const registry = createRegistry();
  // #xqa9ttq / #x8n4crp / #3383 — the roster this registration seats must match the one the run was STARTED
  // with, or a resume here would be reasoning about a run shape that no longer exists.
  // PR #2117 review: seat 3 (Codex advisory) reads its roster from the SAVED RUN (`codexAdvisoryFromRun`), not
  // the ambient env. Seats 4 and 5 still read the SAME env vars `run.mjs` reads
  // (`REVIEW_PR_CODEX_CORRECTNESS_ADVISORY`, `REVIEW_PR_ANTIGRAVITY_REVIEW`) — see
  // `correctnessAdvisoryFromEnv`/`antigravityReviewFromEnv`'s own docs (`we:scripts/operations/review-pr.mjs`).
  registry.register(reviewPrOperation({
    readPr: createReviewPrReader(),
    codexAdvisory: codexAdvisoryFromRun(record),
    correctnessAdvisory: correctnessAdvisoryFromEnv(),
    antigravityReview: antigravityReviewFromEnv(),
  }));
  if (runStatus(record, { registry }) !== 'awaiting-confirm') return record;

  // TWO `advance` calls, not one: the first resolves the `confirm` resume (an answer is recorded, cursor moves
  // to `stageVerdict`) and returns — resolving a suspend never executes the NEXT step's function, per the
  // engine's own contract (`resolvePending`). The second is what actually calls `stageVerdict`'s `effects` fn
  // and declares the WRITE_UP effect.
  //
  // #3540 round 4 (converge, claim-accuracy) — A THROW HERE IS TAGGED, a throw BELOW IS NOT, and that
  // difference is deliberate, not an oversight. A throw from these two `advance` calls can only be
  // `planRecordDecision`'s OWN pure-core refusal (INVARIANT 2 / the reasonless-bounce guard) — a deliberate
  // policy decision, never an infrastructure failure, since nothing here has touched a sink yet. The caller
  // (`record-verdict-cli.mjs`) needs to tell that apart from a genuine crash (a real disk-write failure inside
  // the WRITE_UP sink below, say) so it does not relabel an unexpected bug as an expected, no-action-needed
  // "refused" — see `reviewPrRefusal` there.
  let run;
  try {
    run = advance(record, { registry, resume: { step: record.pending.step, value: answer } });
    run = advance(run, { registry });
  } catch (e) {
    if (e && typeof e === 'object') e.reviewPrRefusal = true;
    throw e;
  }
  store.write(run);
  if (runStatus(run, { registry }) === 'awaiting-effect') {
    const outcome = await applyPendingEffects(run, {
      // ONLY the WRITE_UP sink — see the docblock above. `stageVerdict` never declares anything else, but
      // scoping the sink table to just this type keeps that a property of THIS call, not an assumption about
      // the declaration staying that way forever.
      sinks: { [REVIEW_EFFECTS.WRITE_UP]: sinks[REVIEW_EFFECTS.WRITE_UP] },
      store,
    });
    run = outcome.run;
    // NOT tagged `reviewPrRefusal` — this is the sink's own failure (e.g. a real disk-write error), a genuine
    // infrastructure fault, never a deliberate refusal. It propagates as an ordinary, un-tagged throw.
    if (outcome.error) throw outcome.error;
    // TWO MORE `advance` calls: the first resolves `stageVerdict`'s finding and moves the cursor to `record`;
    // the second calls `record`'s `effects` fn, which DECLARES its label/ledger/notice effects — but declaring
    // is not applying, and this function never calls `applyPendingEffects` on them. The run ends up cleanly
    // `awaiting-effect` at `record`, a legible "here's exactly what's left, and it needs `gh`" state, rather
    // than a bare `running` cursor a reader would have to interpret.
    run = advance(run, { registry });
    run = advance(run, { registry });
    store.write(run);
  }
  return run;
}

/**
 * Stage the request on the transport branch and push it.
 *
 * THE WORKTREE DANCE ITSELF NOW LIVES IN `we:scripts/lib/git-transport-branch.mjs` (#xaoja7a), because a
 * SECOND transport needed it: `stage-pr-view` pushes a view REQUEST to `ops/pr-views` the same way this pushes
 * a verdict request to `ops/review-requests`. The hazards that dance encodes — never switching the caller's
 * lane onto the transport branch, always removing the worktree AND pruning its registration, injecting the
 * filesystem calls as well as `git`, treating "nothing to commit" as success — are not obvious, and a second
 * copy would have re-earned each of them one at a time. That header records what each one cost.
 *
 * WHAT STAYS HERE is the DECISION: which checkout the request belongs on (`resolveTransportRoot`, #3261),
 * which refuses a cross-repo push rather than defaulting to the local clone.
 *
 * The injected `run`/`mkdir`/`write`/`rm` are passed straight through, so this sink is still exercisable with
 * no git and no filesystem at all.
 */
export function createRecordVerdictSinks({
  root = REPO_ROOT,
  repoRoot = '',
  originRepo = defaultOriginRepo,
  run = defaultGit,
  now = () => Date.now(),
  mkdir = mkdirSync,
  write = writeFileSync,
  rm = rmSync,
} = {}) {
  return {
    [STAGE_REQUEST_EFFECT]: async (payload) => {
      // #3261 — WHICH BOARD, decided before anything is written. Refuses rather than defaulting; see
      // `resolveTransportRoot`.
      // The PAYLOAD's `repoRoot` wins over the constructor's: sinks are built before any input is
      // parsed, so a CLI caller can only reach this through the payload. The constructor arg stays for
      // a programmatic caller (and for tests) that knows the checkout up front.
      const board = resolveTransportRoot({ repo: payload.repo, root, repoRoot: payload.repoRoot || repoRoot, originRepo });
      // #3264 — GENESIS, before anything assumes the board exists. A repo onboarding to the transport has never
      // carried a verdict, so its board has to be born here or the first verdict for it fails on a raw git error.
      // OUTSIDE the staging call deliberately: no worktree exists yet, so there is nothing to clean up, and a
      // genesis failure must reach the caller as its own refusal rather than as a cleanup.
      ensureBoardBranch({ run, board, repo: payload.repo });
      const out = stageOnTransportBranch({
        board,
        branch: TRANSPORT_BRANCH,
        files: [{ path: payload.path, content: payload.content }],
        message: `review: #${payload.pr} → ${payload.to} (via record-verdict)`,
        // #3264 — the applier check rides the extraction's `assertReady` seam rather than being inlined here,
        // because it can only be asked once the worktree exists and that now happens inside the helper. It stays
        // THIS operation's business: a board that must carry the applier is a fact about the review-request
        // transport, not about transport branches in general.
        assertReady: ({ run: r, wt }) => assertApplierRidesBoard({ run: r, wt, repo: payload.repo }),
        run, mkdir, write, rm, now,
      });
      // NOTHING TO COMMIT IS A SUCCESS, not a failure: the identical request is already staged, which is
      // exactly what `idempotent: true` promises on replay. The wording stays this operation's own — an
      // operator reading it is looking at a review request, not at "content".
      return out.pushed
        ? { path: payload.path, pushed: true }
        : { path: payload.path, pushed: false, reason: 'identical request already staged' };
    },
  };
}

function defaultGit(args, opts) {
  return execFileSync('git', args, { encoding: 'utf8', ...opts });
}

export { existsSync };
