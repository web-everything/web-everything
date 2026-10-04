/**
 * @file scripts/operations/stage-pr-view-io.mjs
 * @description THE IO SHELL of the `stage-pr-view` declaration — obtain the view, and write the checked one
 *   where the file transport looks for it.
 *
 * IT USED NOT TO FETCH, AND THAT WAS THE HOLE. This file's header used to call "it does not fetch" the honest
 * boundary: on a host with no GitHub credential nothing here could obtain a PR view, so the operator handed
 * over the bytes. What that missed is WHO the operator is. On a cloud VM the operator is the REVIEWING SESSION,
 * and on PR #1542 it handed over a paraphrase of the body in its own voice plus a comment it had authored
 * itself, stamped `authorAssociation: OWNER`, that is not on the PR at all — inside the evidence its own juror
 * then read. Nothing verified it, and nothing could: the boundary was honest about the credential and silent
 * about the authorship.
 *
 * So there are now TWO readers (#xaoja7a), and the declaration decides between them:
 *
 *   · {@link createTransportReader} — the honest one. Push a `{repo, pr}` request to `ops/pr-views`, let
 *     `we:.github/workflows/stage-pr-view.yml` run `gh pr view --json` with a token, and read the answer back
 *     with `git show origin/ops/pr-views:<path>`. The session's only role is asking.
 *   · {@link createFileReader} — the old path, kept ONLY for a repo that has not onboarded the workflow. It
 *     reports whether the transport branch exists on the remote, and `checkViewProvenance` refuses it wherever
 *     it does.
 *
 * ── THE BYTES NEVER TOUCH A SESSION-WRITABLE PATH ────────────────────────────────────────────────────────────
 *
 * The transport read is `run(showViewArgv(name))` — one `git show`, stdout straight into `JSON.parse`. There is
 * deliberately no temp file, no `--output`, no "fetch it into `/tmp` and read it back". A file in between would
 * be a place the session could edit, which is the same hole one step further along. The REF is a constant in
 * `we:scripts/lib/pr-view-transport.mjs` that no input field reaches, and the fetch immediately before the read
 * is not optional: a session can point a remote-tracking ref anywhere with `git update-ref`, and the fetch
 * overwrites it. Together those three facts are what make "CI produced this" a property rather than a hope.
 *
 * IMPURE by construction: `git`, `fs`, `process.env`. All of it injected, so the whole path is testable with
 * no network, no repository and no clock.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stageOnTransportBranch } from '../lib/git-transport-branch.mjs';
import {
  TRANSPORT_BRANCH,
  TRANSPORT_REF,
  buildViewRequest,
  fetchTransportArgv,
  requestPath,
  showViewArgv,
  transportBranchArgv,
  transportCommitArgv,
  viewBlobArgv,
  viewPath,
} from '../lib/pr-view-transport.mjs';
import { defaultOriginRepo, resolveTransportRoot } from './record-verdict-io.mjs';
import { canonicalizeSlug } from '../lib/constellation-repos.mjs';
import { WRITE_VIEW_EFFECT } from './stage-pr-view.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Resolved by SCRIPT LOCATION, never cwd — same reason `run-store.mjs` and `review-pr-io.mjs` do it. */
export const REPO_ROOT = resolve(HERE, '..', '..');

/**
 * The directory the READER resolves, read the same way it reads it. Returning `null` rather than a guessed
 * default is deliberate: a fabricated directory stages a file nowhere the reader looks, and the review then
 * fails with "no pre-fetched view" pointing at a path that was never the one written.
 */
export function defaultViewDir(env = process.env) {
  return env.WE_PR_VIEW_DIR ? resolve(env.WE_PR_VIEW_DIR) : null;
}

/* ── THE LATENCY DECISION ────────────────────────────────────────────────────────────────────────────────────
 *
 * CI takes ~1–2 minutes to answer a request, so `--fromTransport` will routinely be asked for a view that is
 * NOT THERE YET. Two options were on the table and the choice is deliberate:
 *
 *   (i)  REFUSE IMMEDIATELY, telling the caller to re-run. Simplest, and it cannot hang. Rejected: it makes a
 *        double invocation the GUARANTEED shape of the primary path — every first stage of every review fails
 *        by design. That is precisely the friction that gets routed around, and the route around it is
 *        `--from=<a file I wrote>`, which is the defect this card exists to close. A guard people work around
 *        is worse than the hole it replaced, because now it also looks fixed.
 *   (ii) POLL WITH A BOUNDED TIMEOUT and a refusal that names what to do. Chosen. The honest path stays a
 *        single command; the wait is visible, capped, and ends in a message rather than a hang.
 *
 * WHAT KEEPS (ii) FROM BECOMING AN UNBOUNDED WAIT — two independent bounds, because a clock is not a bound:
 *   · a deadline from `now()`, and
 *   · `maxAttempts`, arithmetic from the budget. A stubbed or frozen clock, a suspended VM, an `now()` that
 *     never advances — none of them can produce an infinite loop, because the attempt counter does not consult
 *     the clock at all. The attempt cap is what the "do not let it hang unbounded" requirement actually needs;
 *     the deadline is what makes it end EARLY when the clock is real.
 *
 * THE NUMBERS. 180s against a ~1–2 minute CI run gives one comfortable margin, not five; 10s between polls is
 * ~18 cheap `git fetch`es on the branch, which is nothing next to the juror spend that follows. Both are
 * env-overridable so an operator on a slow runner is not forced to edit this file, and both are floored at
 * something positive so a typo cannot turn the loop into a spin.
 */

/** ~1–2 minutes of CI plus margin. */
export const DEFAULT_TRANSPORT_TIMEOUT_MS = 180_000;
/** Cheap enough to be invisible next to what a review costs. */
export const DEFAULT_TRANSPORT_INTERVAL_MS = 10_000;

/**
 * The wait budget, and the ATTEMPT CAP derived from it. PURE given `env`.
 *
 * `maxAttempts` is not a convenience — it is the bound that holds when the clock does not. See the block above.
 */
export function transportWaitBudget(env = process.env) {
  const positive = (raw, fallback) => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const timeoutMs = positive(env?.WE_PR_VIEW_TRANSPORT_TIMEOUT_MS, DEFAULT_TRANSPORT_TIMEOUT_MS);
  // Never longer than the whole budget: an interval above the timeout would sleep past the deadline and turn a
  // 3-minute cap into one arbitrarily long nap.
  const intervalMs = Math.min(positive(env?.WE_PR_VIEW_TRANSPORT_INTERVAL_MS, DEFAULT_TRANSPORT_INTERVAL_MS), timeoutMs);
  return { timeoutMs, intervalMs, maxAttempts: Math.ceil(timeoutMs / intervalMs) + 1 };
}

/**
 * Does this repo have the transport at all? The mechanical fact behind the structural refusal in
 * `checkViewProvenance` — `ops/pr-views` existing on the remote means CI can serve, and therefore that a
 * hand-supplied view has no excuse.
 *
 * IT FAILS CLOSED. A probe that ERRORS reports `available: true, probed: false`, because "I could not ask"
 * must not read as "there is no transport" — that would let a temporary network failure re-open the hole for
 * exactly as long as it lasted, silently. The `probed` flag travels with the answer so the refusal can say
 * which of the two it is.
 */
/**
 * Does `cwd` belong to `repo`? PURE apart from the injected probe.
 *
 * SHARED BY BOTH READERS ON PURPOSE (PR #1548 round 3). The file reader gained this check in round 2, after a
 * round-1 fix scoped the probe to `--repoRoot` without verifying the named checkout was the repo at all — so
 * pointing it at any checkout lacking `ops/pr-views` re-opened `--from=`. The transport reader was left
 * without the same check, which is the asymmetry this closes: one guarded door and one unguarded door is a
 * guarded door with a sign on it.
 *
 * FAILS CLOSED at both call sites: an origin that cannot be read is not a match, and each caller treats
 * "not a match" as the safe answer for its own path.
 */
export function ownsRepo({ cwd, repo, originRepo = defaultOriginRepo }) {
  const at = String(cwd ?? '');
  if (!at) return false;
  const want = String(repo ?? '').trim();
  if (!want) return false;
  try { return canonicalizeSlug(originRepo(at)) === canonicalizeSlug(want); } catch { return false; }
}

export function probeTransportBranch({ run = defaultGit, cwd = REPO_ROOT } = {}) {
  try {
    return { available: String(run(transportBranchArgv(), { cwd })).trim() !== '', probed: true };
  } catch (e) {
    return { available: true, probed: false, error: String(e?.message ?? e).split('\n')[0] };
  }
}

/**
 * The commit `origin/<headRefName>` currently points at — the head the JUDGED DIFF will be taken from, which is
 * the only thing worth comparing a view's `headRefOid` against.
 *
 * IT FETCHES FIRST, because a lane branch this clone has never seen has no tracking ref, and "no ref" would
 * otherwise read as "unresolvable" and refuse a perfectly fresh view. Returns `''` — never throws — when the
 * ref genuinely cannot be resolved; the DECISION about what an unresolvable head means belongs to
 * `checkViewFreshness`, not here.
 *
 * A FAILED FETCH IS UNRESOLVABLE, and the `rev-parse` below is NOT consulted after one. This is the round-6
 * finding, and it is worth stating why the obvious reading is wrong: "the fetch failed but `rev-parse` still
 * answers" looks like a harmless fallback, and it is the opposite. **Git leaves a remote-tracking ref exactly
 * where it was when a fetch fails** — it does not clear it — so on any clone that has fetched this branch
 * before, a transient failure (network blip, rate limit) leaves `origin/<ref>` pointing at the head as of the
 * LAST successful fetch. `rev-parse` then succeeds and returns that stale commit, `checkViewFreshness` compares
 * a stale view's `headRefOid` against an equally stale live head, they MATCH, and the view is staged — the
 * precise "body and diff are two reads of two moments" failure this whole check exists to refuse, reached
 * through a failed fetch instead of a moved head. The louder the failure, the quieter the bug: a clone that had
 * never seen the branch would have failed `rev-parse` too and refused correctly, so this only misfires on the
 * clones that review a PR repeatedly.
 *
 * That is the same class of failure `probeTransportBranch` above already treats as fail-closed, and it gets the
 * same answer here. "The branch may be gone (a merged PR)" — the case the old comment deferred to `rev-parse`
 * for — resolves the same way and must: a deleted branch fails the fetch and leaves the same stale ref behind,
 * so deferring never distinguished the two, it just trusted the cache in both.
 *
 * THE REF NAME IS VALIDATED before it reaches a refspec. It comes out of a JSON file on a branch anyone who can
 * push can write, and a `headRefName` of `--upload-pack=…` or a path traversal has no business being spliced
 * into a git argument.
 */
export function probeHeadOid({ headRefName, run = defaultGit, cwd = REPO_ROOT } = {}) {
  const ref = String(headRefName ?? '').trim();
  if (!ref || !/^[\w.][\w./-]*$/.test(ref) || ref.includes('..')) return '';
  try {
    run(['fetch', '--quiet', 'origin', `+refs/heads/${ref}:refs/remotes/origin/${ref}`], { cwd });
  } catch {
    // Unresolvable — see the header. NOT a fall-through to `rev-parse`: the tracking ref that survives a
    // failed fetch is the stale one, and answering with it is what let a superseded view pass as fresh.
    return '';
  }
  try {
    return String(run(['rev-parse', `origin/${ref}`], { cwd })).trim();
  } catch { return ''; }
}

/**
 * THE TRANSPORT READER. Ask CI for a view, wait for it, read it out of the fetched ref.
 *
 * `viewFileName` is the READER'S OWN `prViewFileName`, injected — never re-derived. `<owner>-<repo>-<pr>.json`
 * was the naming this transport was first sketched with, and it is exactly the non-injective flattening that
 * made `foo-bar/baz` and `foo/bar-baz` collide, so one repo's view silently answered for the other's (#1466).
 */
export function createTransportReader({
  run = defaultGit,
  sleep = defaultSleep,
  now = () => Date.now(),
  env = process.env,
  cwd = REPO_ROOT,
  viewFileName,
  originRepo = defaultOriginRepo,
  // THE FILESYSTEM SEAMS OF THE REQUEST PUSH, injected for the reason `record-verdict-io.mjs` records at
  // length: a suite that stubbed only `run` still executed the real `mkdirSync` against its fixture root and
  // went GREEN as root while creating a directory at the filesystem root. `git` alone is not enough.
  mkdir = mkdirSync,
  write = writeFileSync,
  rm = rmSync,
} = {}) {
  if (typeof viewFileName !== 'function') {
    throw new TypeError(
      'stage-pr-view: the transport reader needs the reader\'s own `prViewFileName` — a second namer here is a '
      + 'second answer to where a view lives, and the review would look under the other one (#1466).',
    );
  }
  const git = (argv) => String(run(argv, { cwd }));
  const tryGit = (argv) => { try { return git(argv).trim(); } catch { return ''; } };

  return ({ repo, pr, refresh = false }) => {
    // #1548 r3 — the SAME ownership check the file reader makes, before anything touches the branch. Without
    // it this path fetched, pushed a request into, and read a view out of whatever checkout it was handed,
    // on the strength of a flag. `resolveTransportRoot` catches the mismatch later on the push, but only
    // after work has happened and with a message about staging rather than about the flag that was wrong.
    if (!ownsRepo({ cwd, repo, originRepo })) {
      throw new Error(
        `stage-pr-view: refusing to use ${cwd} as ${repo}'s checkout — its \`origin\` is not ${repo} `
        + '(#1548). `--repoRoot` names the checkout that carries THAT repo\'s `ops/pr-views` branch; pointing '
        + 'it anywhere else would fetch, push and read against a repo nobody asked about. Pass a checkout of '
        + `${repo}, or omit \`--repoRoot\` when reviewing this repo's own PRs.`,
      );
    }
    const fileName = viewFileName(repo, pr);
    const path = viewPath(fileName);

    const probe = probeTransportBranch({ run, cwd });
    if (!probe.available) {
      throw new Error(
        `stage-pr-view: this repo has no \`${TRANSPORT_BRANCH}\` branch on origin, so nothing can produce a `
        + 'view for it. Onboard it by landing `.github/workflows/stage-pr-view.yml` and pushing the branch, or '
        + 'stage by hand with `--from=<path>` (which nothing verifies, and which is refused once the branch '
        + 'exists).',
      );
    }

    git(fetchTransportArgv());
    const baseline = tryGit(viewBlobArgv(fileName));

    // ASK ONLY WHEN THERE IS SOMETHING TO ASK FOR. A view already on the branch and no `--refresh` means CI has
    // nothing to do; pushing a request anyway would spend a workflow run per stage and put a commit on the
    // branch for every poll.
    const asked = refresh || !baseline;
    if (asked) {
      pushViewRequest({ repo, pr, fileName, run, cwd, env, originRepo, root: cwd, mkdir, write, rm, now });
    }

    const { timeoutMs, intervalMs, maxAttempts } = transportWaitBudget(env);
    const deadline = now() + timeoutMs;
    let attempts = 0;
    let blob = '';
    for (;;) {
      const seen = tryGit(viewBlobArgv(fileName));
      // The poll predicate answers BOTH shapes of "not ready" with one cheap `rev-parse`: the view is absent,
      // or it is the stale one `--refresh` just asked to replace. Comparing blob shas needs no parse and no
      // timestamp in the file — which is why `produce-pr-view.mjs` deliberately writes none.
      if (seen && (!asked || seen !== baseline)) { blob = seen; break; }
      attempts += 1;
      if (attempts >= maxAttempts || now() >= deadline) {
        throw new Error(
          `stage-pr-view: gave up waiting for CI to publish ${path} on \`${TRANSPORT_REF}\` `
          + `(${Math.round(timeoutMs / 1000)}s, ${attempts} attempt(s)). The request IS pushed and nothing is `
          + 'lost — check the `Stage PR view` workflow run, then re-run this command; it will read the view as '
          + 'soon as the branch carries it. Do NOT fall back to `--from=`: that is the hand-authored path this '
          + 'transport exists to replace (#xaoja7a).',
        );
      }
      sleep(intervalMs);
      git(fetchTransportArgv());
    }

    // THE READ. Straight from `git show`'s stdout — no temp file, nothing on disk the session could have
    // edited between the fetch and the parse.
    let raw;
    try {
      raw = git(showViewArgv(fileName));
    } catch (e) {
      throw new Error(`stage-pr-view: could not read ${path} from \`${TRANSPORT_REF}\` — ${String(e?.message ?? e).split('\n')[0]}`);
    }
    let view;
    try {
      view = JSON.parse(raw);
    } catch (e) {
      throw new Error(
        `stage-pr-view: ${path} on \`${TRANSPORT_REF}\` is not valid JSON (${e.message}). CI writes this file `
        + 'from `gh pr view --json`, so bytes that do not parse mean the branch was written by something else.',
      );
    }

    return {
      view,
      provenance: {
        source: 'transport',
        ref: TRANSPORT_REF,
        path,
        commit: tryGit(transportCommitArgv()),
        blob,
        requested: asked,
        transportAvailable: true,
        probed: probe.probed,
        headOid: probeHeadOid({ headRefName: view?.headRefName, run, cwd }),
      },
    };
  };
}

/**
 * Push the `{repo, pr}` request that asks CI for a view.
 *
 * THE BOARD IS THE #3261 DECISION, reused rather than re-answered: a request for `owner/x` goes on `owner/x`'s
 * OWN transport branch, applied by that repo's own workflow with its own repo-scoped token. A request left on
 * the wrong board is picked up by a workflow that cannot resolve the repository — how plateau-app#144 was
 * stranded — so a mismatch is an error naming both repos, never a silent push to the local checkout.
 */
export function pushViewRequest({
  repo, pr, fileName, run, cwd, env = process.env, originRepo = defaultOriginRepo, root = REPO_ROOT,
  mkdir = mkdirSync, write = writeFileSync, rm = rmSync, now = () => Date.now(),
} = {}) {
  const board = resolveTransportRoot({
    repo,
    root: cwd || root,
    originRepo,
    who: 'stage-pr-view',
    what: 'a view request',
    branch: TRANSPORT_BRANCH,
  });
  const request = buildViewRequest({
    repo,
    pr,
    // A DISTINCT `requestedAt` PER ASK IS LOAD-BEARING, not decoration: identical bytes leave `git diff
    // --cached` empty, nothing is committed, nothing is pushed, and the workflow that would have refreshed a
    // stale view never runs. Silent under-delivery, which is the shape `we:scripts/collect-review-requests.mjs`
    // was written about one flow over.
    requestedAt: new Date().toISOString(),
    // Unverified and honest about it — it exists so the branch is legible in a diff, and nothing reads it back.
    requestedBy: String(env?.CLAUDE_CODE_SESSION_ID ?? ''),
  });
  return stageOnTransportBranch({
    board,
    branch: TRANSPORT_BRANCH,
    files: [{ path: requestPath(fileName), content: `${JSON.stringify(request, null, 2)}\n` }],
    message: `pr-view: request ${repo}#${pr}`,
    run, mkdir, write, rm, now,
  });
}

/**
 * THE OLD PATH, kept only for a repo that has not onboarded the workflow. FAILS CLOSED on both halves — a path
 * that cannot be read and bytes that are not JSON are each named specifically, because "could not stage" does
 * not tell an operator whether to fix their path or their paste.
 *
 * IT REPORTS ITS OWN WEAKNESS. `transportAvailable` comes back on the provenance, and `checkViewProvenance`
 * refuses these bytes wherever it is true. That refusal is what stops the #1542 fabrication from simply moving
 * one step back — fetch the CI view, edit it, stage the edit through here.
 */
export function createFileReader({
  read = readFileSync, run = defaultGit, cwd = REPO_ROOT, originRepo = defaultOriginRepo,
} = {}) {
  return ({ from, repo, pr }) => {
    let raw;
    try {
      raw = read(from, 'utf8');
    } catch (e) {
      throw new Error(`stage-pr-view: could not read the payload at ${from} — ${e.code || e.message}`);
    }
    let view;
    try {
      view = JSON.parse(raw);
    } catch (e) {
      throw new Error(`stage-pr-view: ${from} is not valid JSON (${e.message})`);
    }
    // THE CHECKOUT MUST BE THE REPO'S (PR #1548 round 2). Scoping the probe to `repoRoot` fixed reading a
    // sibling, and opened a bypass in the same move: nothing checked that the named checkout IS the repo under
    // review, so `--repoRoot=<any checkout without the branch>` reported "no transport here" and re-opened the
    // hand-authored path this whole change exists to close. My own round-1 fix, and my commit message claimed
    // the opposite — the juror proved it by trace and reproduction.
    //
    // Verified the way the push side already verifies it (`resolveTransportRoot`, #3261): the checkout's
    // `origin` must BE `repo`. FAILS CLOSED — an unreadable origin, or one that does not match, reports the
    // transport as PRESENT, so `--from=` stays refused. A probe that cannot answer must never be the reason a
    // weaker path opens.
    const at = String(cwd ?? '');
    const owns = ownsRepo({ cwd: at, repo, originRepo });
    const probe = owns
      ? probeTransportBranch({ run, cwd: at })
      : { available: true, probed: false, error: `checkout ${at} does not belong to ${repo}` };
    return {
      view,
      provenance: {
        source: 'file',
        from,
        repo,
        pr,
        transportAvailable: probe.available,
        probed: probe.probed,
        headOid: probeHeadOid({ headRefName: view?.headRefName, run, cwd }),
      },
    };
  };
}

/**
 * The reader the declaration is injected with: ONE function that dispatches on the source `chooseViewSource`
 * already decided. The dispatch is a `switch` over the closed set and its default THROWS rather than falling
 * back to the file path — a fallback here would be a third way to reach hand-supplied bytes, reachable by
 * getting a string wrong.
 */
export function createPayloadReader({
  read = readFileSync,
  run = defaultGit,
  sleep = defaultSleep,
  now = () => Date.now(),
  env = process.env,
  cwd = REPO_ROOT,
  viewFileName,
  originRepo = defaultOriginRepo,
  mkdir = mkdirSync,
  write = writeFileSync,
  rm = rmSync,
} = {}) {
  // BUILT PER CALL, against the checkout that carries the TARGET repo's transport (#1548 juror).
  //
  // These used to be constructed once here, closed over the driver's own `cwd`. Every read was therefore
  // scoped to the checkout the tooling runs FROM rather than the repo being reviewed — so once `we` onboarded
  // its own `ops/pr-views`, staging a view for any other repo was impossible: `--from=` refused with "this
  // repo HAS the CI transport" (true of `we`, false of the target), and `--fromTransport` hit #3261's
  // cross-repo guard pointing at a `--repoRoot` this operation did not declare. The readers are cheap
  // closures; rebuilding one per call costs nothing and is what lets the caller name the checkout.
  return ({ source, from, repo, pr, refresh = false, repoRoot = '' }) => {
    const at = String(repoRoot || '').trim() || cwd;
    if (source === 'file') return createFileReader({ read, run, cwd: at, originRepo })({ from, repo, pr });
    if (source === 'transport') {
      return createTransportReader({ run, sleep, now, env, cwd: at, viewFileName, originRepo, mkdir, write, rm })({ repo, pr, refresh });
    }
    throw new Error(`stage-pr-view: unknown view source ${JSON.stringify(source)} — nothing reads bytes for it`);
  };
}

/**
 * Write the checked view. The directory is created rather than required to exist: the reader's own default
 * lives under a scratch dir that a fresh host has not made yet, and failing on that would be a refusal about
 * nothing.
 */
export function createStagePrViewSinks({ write = writeFileSync, mkdir = mkdirSync } = {}) {
  return {
    [WRITE_VIEW_EFFECT]: async (payload) => {
      mkdir(dirname(payload.path), { recursive: true });
      write(payload.path, payload.content);
      return { path: payload.path, bytes: payload.content.length };
    },
  };
}

function defaultGit(args, opts) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

/**
 * A SYNCHRONOUS sleep, because the engine calls a `compute` step's `fn` synchronously (`engine.mjs`:
 * `const value = step.fn(view)`) and a returned Promise would be stored as the finding itself. `Atomics.wait`
 * blocks the thread without spinning a CPU; injected everywhere so no test ever waits for real.
 */
function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
