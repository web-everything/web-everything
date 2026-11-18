/**
 * @file scripts/lib/pr-view-transport.mjs
 * @description THE CI-STAGED PR VIEW TRANSPORT, named once (#xaoja7a) — the branch, the two directories, the
 *   ref a view may be read from, the git argv that reads it, and the request a session pushes to ask for one.
 *
 * WHY IT EXISTS. `we:scripts/operations/stage-pr-view.mjs` took the PR's body, comments and file list from a
 * session-supplied file, because this host has no mechanical read path: `gh api` answers
 * `403 GitHub access is not enabled` and GraphQL serves only the pinned review-operation set. So the REVIEWING
 * session transcribed the PR into the view a juror then read, and nothing verified the transcription.
 * Observed live on PR #1542: the staged view carried a paraphrase of the body in the session's own voice plus a
 * comment the session had written itself, stamped `authorAssociation: OWNER`, that does not exist on the PR at
 * all. `authorAssociation` exists precisely so a juror can weight an owner's word above a drive-by, so
 * synthesizing one inverts the signal — it puts words in the operator's mouth inside the evidence.
 *
 * THE SHAPE IS THE APPLIER'S, POINTED AT READ. `we:.github/workflows/apply-review-request.yml` already does
 * this in the WRITE direction and is proven in production: a credential-less session pushes a FILE to an ops
 * branch, and a workflow holding a token acts on it. This is the sibling flow — the session pushes a REQUEST
 * (`{repo, pr}`), `we:.github/workflows/stage-pr-view.yml` runs `gh pr view --json` and commits the view back,
 * and the session reads it out of the fetched ref. The session never authors the material.
 *
 * ── THE SUBTLETY THAT MAKES OR BREAKS IT, and why {@link TRANSPORT_REF} is a constant ────────────────────────
 *
 * CI producing the view is NOT sufficient on its own. If the reader can still be pointed at a path — a local
 * file, a temp file `git show` was redirected into, a ref the caller names — the session can fetch the
 * CI-produced view, edit it, and stage that instead. The hole moves one step back and nothing has changed.
 *
 * So the ref is NOT a parameter anywhere on this path. {@link showViewArgv} builds
 * `git show origin/ops/pr-views:<path>` from constants in this file, the bytes go from that subprocess's stdout
 * straight into the check, and no input field of the operation can reach either half. A session that wants to
 * change what is read has to change THIS file, in a diff, under review — which is the difference between a
 * control and a convention.
 *
 * PURE, AND IT IMPORTS NOTHING. `we:scripts/operations/stage-pr-view.mjs` asserts its own import graph is free
 * of `node:` modules ("the declaration reaches nothing that can act"), and it imports these constants, so a
 * single `node:path` here would redden that test. String concatenation over `join` is deliberate for the same
 * reason: these are git PATHSPECS, which are `/`-separated on every platform, not host paths.
 */

/** The branch CI watches, and the only branch a view is ever read from. */
export const TRANSPORT_BRANCH = 'ops/pr-views';

/** The remote it lives on. Named so the ref below is derived rather than typed twice. */
export const TRANSPORT_REMOTE = 'origin';

/**
 * THE ONE REF A VIEW MAY BE READ FROM — the REMOTE-TRACKING ref, never the local branch.
 *
 * `git show ops/pr-views:…` would read a LOCAL branch, which the session can commit to with no network and no
 * credential; `origin/ops/pr-views` is what the last {@link fetchTransportArgv} wrote, and that fetch is not
 * optional on the read path. A local branch of the same name existing is not a hazard here because this string
 * is unambiguous: git resolves `origin/ops/pr-views` through `refs/remotes/` first, and the fetch immediately
 * before the read overwrites whatever a session may have pointed that ref at with `git update-ref`.
 */
export const TRANSPORT_REF = `${TRANSPORT_REMOTE}/${TRANSPORT_BRANCH}`;

/** Where CI commits the views it produced. */
export const VIEW_DIR = `${TRANSPORT_BRANCH}/views`;

/**
 * Where a session pushes the request that asks for one.
 *
 * A DIRECTORY OF ITS OWN, and that is what makes the workflow's push safe. `stage-pr-view.yml` triggers on
 * `paths: ['ops/pr-views/requests/*.json']`; the view it commits back lands under `views/`, so the workflow's
 * own push cannot re-trigger it. A single flat directory would have made this flow a loop.
 */
export const REQUEST_DIR = `${TRANSPORT_BRANCH}/requests`;

/**
 * The two paths, from ONE file name.
 *
 * THE NAMER IS THE READER'S OWN (`prViewFileName`, `we:scripts/operations/review-pr-io.mjs`), passed in rather
 * than re-derived — for the reason that file's header records at length: flattening `owner/name` with `-` is
 * NOT injective (`foo-bar/baz` and `foo/bar-baz` collide), and when it collided, one repo's view silently
 * answered for the other's while the diff still came from the right tree, so nothing could notice (#1466).
 * `<owner>-<repo>-<pr>.json` was the naming this transport was first sketched with; it is the collision, and
 * it is not used here.
 */
/**
 * The `--json` fields ONE `gh pr view` is asked for — the exact set `assembleReviewDetail` consumes. Named
 * once so an alternate transport supplies the same shape rather than guessing at it.
 *
 * MOVED HERE FROM `we:scripts/operations/review-pr-io.mjs` (#xaoja7a follow-up). It is a TRANSPORT fact —
 * what the wire carries — and living in the review operation's io shell made the VIEW PRODUCER import that
 * shell for two constants, dragging `we:scripts/merge-ai-prs.mjs` (4,800+ lines), the verdict ledger, the
 * review detail assembler and six more modules into a CI job whose whole task is "run one `gh pr view` and
 * commit the answer". That weight is why the transport could not be onboarded in `frontierui` or
 * `plateau-app` — the two repos whose PRs are the impl half of every cross-repo couple and therefore need it
 * most. `review-pr-io.mjs` re-exports both names, so every existing importer is unchanged.
 */
export const PR_VIEW_FIELDS = Object.freeze([
  'number', 'title', 'url', 'body', 'labels', 'comments', 'files', 'headRefName', 'headRefOid',
  // #xwp8ioh — `state` rides the SAME call (one more json field, no extra hop). Without it `review-pr` could
  // not tell a live PR from a merged one, so it paid a juror to review PRs that had already landed.
  'state',
  // #xwk0tzu (#3322) — `createdAt` rides that SAME call, for the same reason `state` does. It is #3067's
  // stamp-regime date input, and `we:scripts/review-set-label.mjs` reads it on its own `gh pr view`, so both
  // sides feed `decideClearerIndependence` the SAME inputs and cannot compute different statuses (#2644).
  'createdAt',
]);

/**
 * The on-disk name a pre-fetched view is looked up under, keeping the directory flat. PURE.
 *
 * THE SEPARATOR MUST NOT BE A CHARACTER A REPO NAME CAN CONTAIN. Flattening the slug with `-` was NOT
 * injective: a repo name may itself contain `-`, so `foo-bar/baz` and `foo/bar-baz` both produced
 * `foo-bar-baz-5.json`. Staging both in one `WE_PR_VIEW_DIR` silently overwrote one with the other, and
 * `filePrView` then returned the WRONG repo's title, body and LABELS for the requested PR — with the diff
 * still correctly taken from local git, so the mismatch was invisible (review-pr correctness juror on #1466).
 *
 * `encodeURIComponent` is injective over the slug charset GitHub allows (`[\w.-]` plus the one `/`): it
 * touches only the slash, which becomes `%2F`, and `%` cannot appear in a repo name.
 *
 * Moved here with {@link PR_VIEW_FIELDS} — `viewPath(prViewFileName(repo, pr))` is one thought, and it was
 * split across two modules with the heavier half in the review operation.
 */
export function prViewFileName(repo, pr) {
  return `${encodeURIComponent(String(repo))}-${pr}.json`;
}

export const viewPath = (fileName) => `${VIEW_DIR}/${assertBareName(fileName)}`;
export const requestPath = (fileName) => `${REQUEST_DIR}/${assertBareName(fileName)}`;

/**
 * A file name may not carry a path. Cheap, and it is the guard that stops a `repo` of `../../.github/workflows`
 * from turning a request into a write outside the transport directories when CI acts on it.
 */
function assertBareName(fileName) {
  const name = String(fileName ?? '');
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new TypeError(`pr-view-transport: expected a bare file name, got ${JSON.stringify(fileName)}`);
  }
  return name;
}

/**
 * Refresh the remote-tracking ref. FORCED and EXPLICIT about both sides of the refspec.
 *
 * `+` because the transport branch is rewritten by nothing today but must not wedge the read path if it ever
 * is; the explicit `refs/heads/… : refs/remotes/origin/…` because a bare `git fetch origin ops/pr-views` leaves
 * the result in `FETCH_HEAD` and does NOT update `origin/ops/pr-views` on every git configuration — and a read
 * that then silently used a stale tracking ref is exactly the class of failure this transport exists to close.
 */
export const fetchTransportArgv = () => [
  'fetch', '--quiet', TRANSPORT_REMOTE,
  `+refs/heads/${TRANSPORT_BRANCH}:refs/remotes/${TRANSPORT_REMOTE}/${TRANSPORT_BRANCH}`,
];

/** Does the transport branch exist on the remote at all? The probe that decides whether a repo is onboarded. */
export const transportBranchArgv = () => ['ls-remote', '--heads', TRANSPORT_REMOTE, `refs/heads/${TRANSPORT_BRANCH}`];

/** THE READ. `git show <remote-tracking ref>:<path>` — bytes to stdout, never through a file. */
export const showViewArgv = (fileName) => ['show', `${TRANSPORT_REF}:${viewPath(fileName)}`];

/**
 * The blob sha of the view currently on the ref, or nothing when it is not there. Used as the POLL PREDICATE:
 * "has CI published something different from what was here when I asked" is one cheap `rev-parse`, and it
 * answers both "the view is not there yet" and "the view is there but is the stale one I just asked to
 * replace" without parsing anything.
 */
export const viewBlobArgv = (fileName) => ['rev-parse', `${TRANSPORT_REF}:${viewPath(fileName)}`];

/** The commit the view was read out of — recorded on the staged view as provenance. */
export const transportCommitArgv = () => ['rev-parse', TRANSPORT_REF];

/**
 * THE `--json` FIELD LIST CI ASKS `gh pr view` FOR — the UNION of the two lists that already exist, never a
 * third hand-typed one.
 *
 * `PR_VIEW_FIELDS` (`we:scripts/operations/review-pr-io.mjs`) is what `assembleReviewDetail` consumes, so a
 * view missing any of it is refused by `checkStagedView` before it can be believed. `PR_STATE_FIELDS`
 * (`we:scripts/lib/review-label-provider.mjs`) is what the label arc reads, and it carries the one field the
 * reader's list does not: `headRefOid`. That field is what makes a view falsifiable — a view whose head has
 * moved describes a body, a comment set and a file list for a tree that is no longer the one under review, and
 * without it staging a stale view silently reviews the wrong commit.
 *
 * Taking the union rather than typing the fields means adding a field to EITHER home reaches CI with no edit
 * here, and no chance of the two drifting.
 *
 * @param {readonly string[]} readerFields - the reader's `PR_VIEW_FIELDS`.
 * @param {readonly string[]} stateFields - the label arc's `PR_STATE_FIELDS`.
 * @returns {readonly string[]} deduped, reader's order first, frozen.
 */
export function transportViewFields(readerFields, stateFields) {
  for (const [name, list] of [['readerFields', readerFields], ['stateFields', stateFields]]) {
    if (!Array.isArray(list) || !list.length || list.some((f) => typeof f !== 'string' || !f)) {
      throw new TypeError(
        `pr-view-transport: \`${name}\` must be the non-empty field list its own home exports — this file `
        + 'restates neither, because a third copy is how CI starts fetching a different shape than the reader reads.',
      );
    }
  }
  return Object.freeze([...new Set([...readerFields, ...stateFields])]);
}

/**
 * The request a session pushes. `{repo, pr}` and nothing that could steer what CI fetches — the two identifying
 * fields plus a stamp of who asked and when, which exist so the branch is legible in a diff, not so anything
 * reads them back.
 *
 * `requestedAt` IS LOAD-BEARING despite reading like decoration. A re-request for the same PR must produce
 * DIFFERENT bytes, or `git diff --cached` finds nothing to commit, no push happens, and the workflow that would
 * have refreshed a stale view never runs. That is the silent-under-delivery shape
 * `we:scripts/collect-review-requests.mjs` was written about, one flow over.
 */
export function buildViewRequest({ repo, pr, requestedAt, requestedBy = '' } = {}) {
  const check = validateViewRequest({ repo, pr });
  if (!check.ok) throw new TypeError(`pr-view-transport: ${check.error}`);
  return {
    repo: check.request.repo,
    pr: check.request.pr,
    requestedAt: String(requestedAt || ''),
    ...(requestedBy ? { requestedBy: String(requestedBy) } : {}),
  };
}

/**
 * Validate a request CI is about to act on. PURE — returns `{ok, request}` or `{ok:false, error}`, never
 * throws, so every refusal is testable without a runner, exactly as `validateRequest` in
 * `we:scripts/apply-review-request.mjs` is.
 *
 * THE `repo` PATTERN IS THE GUARD, not a formality. This value reaches `gh pr view --repo <repo>` inside a job
 * holding a write token; anything that is not `<owner>/<name>` has no business getting that far, and the
 * request arrives on a branch anyone who can push can write to.
 */
export function validateViewRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'request must be a JSON object' };
  }
  const { repo, pr } = raw;
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return { ok: false, error: `\`repo\` must be <owner/name>, got ${JSON.stringify(repo)}` };
  }
  if (!Number.isInteger(pr) || pr <= 0) {
    return { ok: false, error: `\`pr\` must be a positive integer, got ${JSON.stringify(pr)}` };
  }
  return { ok: true, request: { repo, pr } };
}
