#!/usr/bin/env node
/**
 * @file fake-gh-shim.mjs — the `gh` STAND-IN process (#3383, part 2 "Fake GitHub" of the daemon-scenario
 * simulator; see `reports/2026-09-24-daemon-scenario-simulator.md` and `fake-gh.mjs`'s own header for the
 * two-generation context this file is generation 2's CLI half of).
 *
 * A REAL FILE ON DISK, NOT AN EMBEDDED STRING (unlike generation 1's `SHIM` in `fake-gh.mjs`, or
 * `fake-claude.mjs`'s `SHIM`). `createFakeGithub` installs a tiny `#!/bin/sh` wrapper as the `gh` on `PATH`
 * that does nothing but `exec node "<this file's absolute path>" "$@"` — so this file can `import` the
 * store/lock/transition functions straight out of `fake-gh.mjs` instead of duplicating them into a string
 * literal. That is what makes "the in-process JS API and the out-of-process CLI share one state machine" true
 * rather than aspirational: both call the exact same functions against the exact same store file.
 *
 * TWO HARD RULES CARRIED FORWARD FROM GENERATION 1 (see `fake-gh.mjs`'s header for the incidents that found
 * them):
 *   1. Logging is ONE `appendFileSync` per call, never a read-modify-write of a shared log.
 *   2. NEVER `process.exit()` right after writing stdout — set `process.exitCode` and return; Node drains
 *      the pipe on its own. A large `pr list` (this fixture's own 200-PR/>64KB test) is exactly the payload
 *      size that made this bite generation 1 for real.
 *
 * VERB / FIELD / API-PATH SURFACE SUPPORTED (kept here, not scattered, per this task's own instruction to
 * list it in the shim's header — derived from grepping every `gh` call site under `scripts/conveyor/`,
 * `scripts/operations/review-dispatch.mjs`, `scripts/lib/{review-label-provider,daemon-live-smoke,
 * pr-merge-gate,forge-land-provider}.mjs`, `scripts/merge-ai-prs.mjs`, `scripts/lane-pool.mjs`,
 * `scripts/review-set-label.mjs`):
 *
 *   - `auth status`                                                          → exit 0 unconditionally
 *   - `pr list [--repo R] [--state open|closed|merged|all] [--limit N]
 *              [--head B] [--base B] [--label L] --json FIELDS [--jq Q]`
 *   - `pr view <n> [--repo R] --json FIELDS [--jq Q]`
 *   - `pr create --base B --head H [--title T] [--body Bd] [--fill]`         (no `--repo` — cwd-derived,
 *                                                                              matches `forge-land-provider.mjs`)
 *   - `pr edit <n> [--repo R] [--add-label X]... [--remove-label Y]...
 *              [--body B | --body-file F]`
 *   - `pr comment <n> [--repo R] (--body B | --body-file F)`
 *   - `pr diff <n> [--repo R] --name-only`
 *   - `pr merge <n> [--repo R] --merge|--squash|--rebase [--delete-branch]`
 *   - `pr close <n> [--repo R]` / `pr reopen <n> [--repo R]`
 *   - `pr checks <n> [--repo R] [--required] --json FIELDS`                  (forge-land-provider's
 *                                                                              `requiredChecks`)
 *   - `label create NAME [--repo R] [--color C] [--description D] [--force]`
 *   - `api [--method M | -X M] [--paginate] [-F k=v]... PATH [--jq Q]` for:
 *       `repos/{o}/{r}`, `repos/{o}/{r}/pulls/{n}`, `repos/{o}/{r}/pulls/{n}/files`,
 *       `repos/{o}/{r}/issues/{n}/events`, `repos/{o}/{r}/issues/{n}/timeline`,
 *       `repos/{o}/{r}/issues/{n}/comments`, `repos/{o}/{r}/compare/{a}...{b}`,
 *       `repos/{o}/{r}/contents/{path}?ref={sha}`,
 *       `repos/{o}/{r}/commits/{sha}/check-runs` and `…/status` (only for an open PR's current head sha;
 *       `…/status` always lists no legacy statuses)
 *   - Fields produced with GitHub's real shape (camelCase for `--json`, snake_case for `api`'s REST JSON) —
 *     see `fake-gh.mjs`'s `buildPrGraphqlView` / `restEvent` / `listChangedFilesRest`.
 *
 *   - `pr ready <n> [--repo R] [--undo]`                                     (draft-first promotion / fix-begin)
 *
 * NOT SUPPORTED, ON PURPOSE (a fixture gap, loud, per this task's brief): anything else — e.g.
 * `pr edit --add-reviewer`, `run list` (ci-queue-watch's own call site is a DIFFERENT fake in that file's own
 * test, not this one), `issue` commands. An unmatched verb/field/path prints `fake-gh: unsupported …` to
 * stderr and exits 1 rather than guessing — see this file's own `unsupported` responses below.
 *
 * TOKENS + FAULTS. A revoked `GH_TOKEN`, or an armed fault matching the call's verb, short-circuits BEFORE
 * any verb handler runs (checked inside the same locked `withStore` turn that would otherwise dispatch the
 * call, so a fault's `times` counter can never be double-consumed by a racing sibling call).
 */

import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  withStore, sleepSyncMs, requirePr, pickFields, parseFieldsCsv, restEvent,
  createLabelPure, addLabelsPure, removeLabelsPure, addCommentPure, closePrPure,
  reopenPrPure, mergePrPure, applyBranchDeletionPure, openPrPure, filterPrs,
  refOid, createMergeCommit, listChangedFilesNative, listChangedFilesRest,
  buildPrGraphqlView, pushCommitToRef,
} from './fake-gh.mjs';

const STORE_PATH = process.env.FAKE_GH_STORE;
const LOG_PATH = process.env.FAKE_GH_LOG;
const ACTOR = process.env.FAKE_GH_ACTOR || 'we-daemon-bot';
const TOKEN = process.env.GH_TOKEN || null;
const CWD = process.cwd();
const argv = process.argv.slice(2);

// Rule 1 — one appendFileSync per call, no read-modify-write. Logged for EVERY call, including ones that
// go on to fail (a fault/401/unsupported-verb call is still a call the harness may want to assert on).
try {
  appendFileSync(LOG_PATH, `${JSON.stringify({ argv, cwd: CWD, token: TOKEN, at: Date.now() })}\n`);
} catch { /* a log path is always provided by createFakeGithub — best-effort if a caller omitted it */ }

const HTTP_401 = "HTTP 401: Bad credentials (https://api.github.com/graphql)\n";
const HTTP_RATE_LIMIT = 'API rate limit exceeded for user ID 1\n';
const HTTP_5XX = 'HTTP 502: Bad Gateway\n';
const HTTP_406_TOO_LARGE = 'could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300). Consider using \'List pull requests files\' API or locally cloning the repository instead.\nPullRequest.diff too_large\n';
// #4075 soak harness gap (break `sticky-smoke-rejection`): `gh` is a Go binary — a real network failure prints
// Go's net/http error text, never one of the HTTP_* fixtures above. Live 2026-09-25 08:14 ET both gh smoke checks
// failed together with exactly this shape (`daemon-live-smoke.mjs#TRANSIENT_FAILURE_PATTERNS` added
// `error connecting to api\.github\.com` / `dial tcp` / `i\/o timeout` for it); no existing fault `kind` could
// reproduce that text (`fault()`'s only kinds were rate-limit/5xx/401/timeout/push-to-main[-diverge]), so this
// scenario could not drive the real daemon code through a genuinely Go-shaped network fault without one.
const GO_NETWORK_ERROR = 'error connecting to api.github.com\ndial tcp 140.82.112.6:443: i/o timeout\n';

/** `argv[0] argv[1]` when `argv[0]` has subcommands (`pr`, `label`) and `argv[1]` is one of them; otherwise
 *  just `argv[0]` (`api`, `auth`). Matches the `verb` shape `createFakeGithub().fault({verb, ...})` takes. */
function callVerb() {
  if ((argv[0] === 'pr' || argv[0] === 'label') && argv[1] && !argv[1].startsWith('-')) return `${argv[0]} ${argv[1]}`;
  return argv[0];
}

// -------------------------------------------------------------------------------------------------------
// Tiny argv helpers — hand-rolled per subcommand rather than one generic parser, so each handler's flag set
// stays obviously readable against the header's own list above.
// -------------------------------------------------------------------------------------------------------

function flagValue(rest, name) {
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === name) return rest[i + 1];
    if (rest[i].startsWith(`${name}=`)) return rest[i].slice(name.length + 1);
  }
  return null;
}

function flagValues(rest, name) {
  const out = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === name) { out.push(rest[i + 1]); continue; }
    if (rest[i].startsWith(`${name}=`)) out.push(rest[i].slice(name.length + 1));
  }
  return out;
}

function hasFlag(rest, name) { return rest.includes(name); }

function resolveRepoSlug(store, explicitRepo) {
  if (explicitRepo) {
    if (store.repos[explicitRepo]) return explicitRepo;
    const err = new Error(`unknown repo "${explicitRepo}"`);
    err.code = 'UNKNOWN_REPO';
    throw err;
  }
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = url.match(/[:/]([^/]+)\/([^/]+?)(\.git)?$/);
    if (m) {
      const slug = `${m[1]}/${m[2]}`;
      if (store.repos[slug]) return slug;
    }
  } catch { /* not inside a git dir with an origin — fall through to the "first repo" default */ }
  const keys = Object.keys(store.repos);
  if (keys.length) return keys[0];
  const err = new Error('no repos configured');
  err.code = 'NO_REPOS';
  throw err;
}

/** Resolve `{headOid, baseOid}` for a PR's diff-shaped verbs — falling back to the PR's own
 *  `lastKnownHeadRefOid` when the head branch was deleted (a merged/closed PR), same reasoning as
 *  `buildPrGraphqlView`: a `git diff`/`merge-tree` against a dangling branch NAME fails loudly instead of
 *  ever silently using the wrong ref. */
function resolveDiffOids(repoState, pr) {
  const liveHeadOid = refOid(repoState.originPath, pr.headRefName);
  if (liveHeadOid) pr.lastKnownHeadRefOid = liveHeadOid;
  const headOid = liveHeadOid || pr.lastKnownHeadRefOid;
  const baseOid = refOid(repoState.originPath, pr.baseRefName);
  return { headOid, baseOid };
}

function requireRepo(store, slug) {
  const repoState = store.repos[slug];
  if (!repoState) {
    const err = new Error(`unknown repo "${slug}"`);
    err.code = 'UNKNOWN_REPO';
    throw err;
  }
  return repoState;
}

/** Converts a thrown pure-function error into `{stdout?, stderr?, exitCode}` — the one place every handler's
 *  errors funnel through, so every verb fails the same recognizable way. */
function guarded(fn) {
  try {
    return fn();
  } catch (err) {
    if (err.code === 'LABEL_NOT_FOUND') return { stderr: `could not add label: ${err.message}\n`, exitCode: 1 };
    if (err.code === 'LABEL_EXISTS') return { stderr: `could not create label: ${err.message}\n`, exitCode: 1 };
    if (err.code === 'PR_NOT_FOUND') return { stderr: `GraphQL: ${err.message} (repository.pullRequest)\n`, exitCode: 1 };
    if (err.code === 'CONFLICTING') return { stderr: 'X Pull request is not mergeable\n', exitCode: 1 };
    if (err.code === 'UNKNOWN_REPO' || err.code === 'NO_REPOS') return { stderr: `fake-gh: ${err.message}\n`, exitCode: 1 };
    return { stderr: `fake-gh: ${err.message}\n`, exitCode: 1 };
  }
}

// `compact` mirrors real non-TTY `gh --jq`, which prints each emitted object on ONE line (callers such as
// `pr-status-io.mjs#parseJsonLines` split on newlines). Opt-in per route so existing routes keep their output.
function pipeJq(json, expr, { compact = false } = {}) {
  const res = spawnSync('jq', [compact ? '-rc' : '-r', expr], { input: json, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`jq failed on ${expr}: ${res.stderr}`);
  return res.stdout;
}

function jsonResult(value, jq, opts) {
  const json = JSON.stringify(value);
  return { stdout: jq ? pipeJq(json, jq, opts) : `${json}\n` };
}

// -------------------------------------------------------------------------------------------------------
// Verb handlers. Each returns `{stdout?, stderr?, exitCode?}` (default exitCode 0).
// -------------------------------------------------------------------------------------------------------

function handlePrList(store, rest) {
  return guarded(() => {
    const repo = flagValue(rest, '--repo');
    const slug = resolveRepoSlug(store, repo);
    const repoState = requireRepo(store, slug);
    const state = flagValue(rest, '--state') || 'open';
    const limit = Number(flagValue(rest, '--limit') || 30);
    const head = flagValue(rest, '--head');
    const base = flagValue(rest, '--base');
    const label = flagValue(rest, '--label');
    const json = flagValue(rest, '--json');
    const jq = flagValue(rest, '--jq');
    const fields = json ? parseFieldsCsv(json) : null;
    const prs = filterPrs(repoState, { state, head, base, label }).slice(0, limit);
    const views = prs.map((pr) => buildPrGraphqlView(repoState, pr, { originPath: repoState.originPath, callerActor: ACTOR, fields }));
    const picked = json ? views.map((v) => pickFields(v, json)) : views;
    return jsonResult(picked, jq);
  });
}

function handlePrView(store, rest) {
  return guarded(() => {
    const number = Number(rest[0]);
    const repo = flagValue(rest, '--repo');
    const slug = resolveRepoSlug(store, repo);
    const repoState = requireRepo(store, slug);
    const pr = requirePr(repoState, number);
    const json = flagValue(rest, '--json');
    const jq = flagValue(rest, '--jq');
    const fields = json ? parseFieldsCsv(json) : null;
    const view = buildPrGraphqlView(repoState, pr, { originPath: repoState.originPath, callerActor: ACTOR, fields });
    const picked = json ? pickFields(view, json) : view;
    return jsonResult(picked, jq);
  });
}

function handlePrCreate(store, rest) {
  return guarded(() => {
    // No --repo on this arc (see header) — always cwd-derived.
    const slug = resolveRepoSlug(store, null);
    const repoState = requireRepo(store, slug);
    const base = flagValue(rest, '--base');
    const head = flagValue(rest, '--head');
    const title = flagValue(rest, '--title');
    const body = flagValue(rest, '--body');
    if (!head) throw Object.assign(new Error('pr create: --head is required'), { code: 'BAD_ARGS' });
    if (!refOid(repoState.originPath, head)) {
      return { stderr: `pull request create failed: head ref "${head}" not found\n`, exitCode: 1 };
    }
    const pr = openPrPure(repoState, {
      head, base: base || repoState.defaultBranch, title: title ?? undefined, body: body ?? '(body)',
      author: ACTOR, headRefOid: refOid(repoState.originPath, head),
    });
    return { stdout: `https://github.com/${slug}/pull/${pr.number}\n` };
  });
}

function handlePrEdit(store, rest) {
  return guarded(() => {
    const number = Number(rest[0]);
    const repo = flagValue(rest, '--repo');
    const slug = resolveRepoSlug(store, repo);
    const repoState = requireRepo(store, slug);
    const add = flagValues(rest, '--add-label');
    const remove = flagValues(rest, '--remove-label');
    const body = flagValue(rest, '--body');
    const bodyFile = flagValue(rest, '--body-file');
    if (add.length) addLabelsPure(repoState, number, add, { actor: ACTOR });
    if (remove.length) removeLabelsPure(repoState, number, remove, { actor: ACTOR });
    if (body !== null || bodyFile !== null) {
      const pr = requirePr(repoState, number);
      pr.body = bodyFile !== null ? readFileSync(bodyFile, 'utf8') : body;
      pr.updatedAt = new Date().toISOString();
    }
    return { stdout: `https://github.com/${slug}/pull/${number}\n` };
  });
}

function handlePrComment(store, rest) {
  return guarded(() => {
    const number = Number(rest[0]);
    const repo = flagValue(rest, '--repo');
    const slug = resolveRepoSlug(store, repo);
    const repoState = requireRepo(store, slug);
    const body = flagValue(rest, '--body');
    const bodyFile = flagValue(rest, '--body-file');
    const text = bodyFile !== null ? readFileSync(bodyFile, 'utf8') : (body ?? '');
    const comment = addCommentPure(repoState, number, text, { author: ACTOR });
    return { stdout: `https://github.com/${slug}/pull/${number}#issuecomment-${comment.id}\n` };
  });
}

function handlePrDiff(store, rest) {
  return guarded(() => {
    const number = Number(rest[0]);
    const repo = flagValue(rest, '--repo');
    const slug = resolveRepoSlug(store, repo);
    const repoState = requireRepo(store, slug);
    const pr = requirePr(repoState, number);
    if (!hasFlag(rest, '--name-only')) {
      return { stderr: 'fake-gh: unsupported `pr diff` without --name-only\n', exitCode: 1 };
    }
    const { headOid, baseOid } = resolveDiffOids(repoState, pr);
    const files = headOid && baseOid ? listChangedFilesNative(repoState.originPath, baseOid, headOid) : [];
    return { stdout: files.map((f) => f.path).join('\n') + (files.length ? '\n' : '') };
  });
}

function handlePrMerge(store, rest) {
  return guarded(() => {
    const number = Number(rest[0]);
    const repo = flagValue(rest, '--repo');
    const slug = resolveRepoSlug(store, repo);
    const repoState = requireRepo(store, slug);
    const pr = requirePr(repoState, number);
    if (pr.state !== 'OPEN') return { stderr: `pull request #${number} is not open\n`, exitCode: 1 };
    const deleteBranch = hasFlag(rest, '--delete-branch');
    const baseOid = refOid(repoState.originPath, pr.baseRefName);
    const headOid = refOid(repoState.originPath, pr.headRefName);
    if (!baseOid || !headOid) return { stderr: 'fake-gh: pr merge: missing base/head ref on origin\n', exitCode: 1 };
    const commitOid = createMergeCommit(repoState.originPath, {
      baseBranch: pr.baseRefName, baseOid, headOid,
      message: `Merge pull request #${number} from ${pr.headRefName}`,
      deleteHeadBranch: deleteBranch, headBranch: pr.headRefName,
    });
    mergePrPure(repoState, number, { actor: ACTOR });
    if (deleteBranch) applyBranchDeletionPure(repoState, pr.headRefName, pr.baseRefName, { actor: ACTOR });
    return { stdout: `${commitOid} https://github.com/${slug}/pull/${number}\n` };
  });
}

function handlePrClose(store, rest) {
  return guarded(() => {
    const number = Number(rest[0]);
    const slug = resolveRepoSlug(store, flagValue(rest, '--repo'));
    closePrPure(requireRepo(store, slug), number, { actor: ACTOR });
    return { stdout: `closed #${number}\n` };
  });
}

// fix procedure (2026-09-27) — `pr ready <n> [--repo R] [--undo]`: the draft-first promotion (`gh pr ready`) and
// the fix claim's back-to-draft (`gh pr ready --undo`). Flips the stored `isDraft`, which every PR view already
// serves; a closed PR is refused like real `gh`.
function handlePrReady(store, rest) {
  return guarded(() => {
    const number = Number(rest.find((a) => /^\d+$/.test(a)));
    const slug = resolveRepoSlug(store, flagValue(rest, '--repo'));
    const pr = requirePr(requireRepo(store, slug), number);
    if (pr.state !== 'OPEN') return { stderr: `fake-gh: PR #${number} is not open\n`, exitCode: 1 };
    pr.isDraft = rest.includes('--undo');
    return { stdout: `${pr.isDraft ? 'converted to draft' : 'marked ready'} #${number}\n` };
  });
}

function handlePrReopen(store, rest) {
  return guarded(() => {
    const number = Number(rest[0]);
    const slug = resolveRepoSlug(store, flagValue(rest, '--repo'));
    reopenPrPure(requireRepo(store, slug), number, { actor: ACTOR });
    return { stdout: `reopened #${number}\n` };
  });
}

function handlePrChecks(store, rest) {
  return guarded(() => {
    const number = Number(rest[0]);
    const slug = resolveRepoSlug(store, flagValue(rest, '--repo'));
    const repoState = requireRepo(store, slug);
    const pr = requirePr(repoState, number);
    const rows = pr.checks.map((c) => ({
      name: c.name,
      state: c.conclusion || c.status,
      bucket: c.conclusion === 'SUCCESS' ? 'pass' : c.conclusion === 'FAILURE' ? 'fail' : 'pending',
    }));
    const json = flagValue(rest, '--json');
    const picked = json ? rows.map((r) => pickFields(r, json)) : rows;
    return jsonResult(picked, null);
  });
}

/** `gh run list --branch <b> [--limit N] --json <fields> [--repo]` — #4075 soak harness gap: `reconcile-pass.mjs`
 *  reads main's own CI runs (`x5uqim1`, main-red windows) whenever a PR's CI is red, and this verb was missing, so
 *  EVERY reconcile over a red-CI PR failed in the simulator. Runs live on `repoState.runs` (default none = main was
 *  never red); a scenario seeds them via `createFakeGithub#setRuns`. */
function handleRunList(store, rest) {
  return guarded(() => {
    const slug = resolveRepoSlug(store, flagValue(rest, '--repo'));
    const repoState = requireRepo(store, slug);
    const branch = flagValue(rest, '--branch');
    const limit = Number(flagValue(rest, '--limit')) || 20;
    const rows = (repoState.runs ?? []).filter((r) => !branch || r.headBranch === branch).slice(0, limit);
    const json = flagValue(rest, '--json');
    const picked = json ? rows.map((r) => pickFields(r, json)) : rows;
    return jsonResult(picked, flagValue(rest, '--jq'));
  });
}

function handleLabelCreate(store, rest) {
  return guarded(() => {
    const name = rest[0];
    const slug = resolveRepoSlug(store, flagValue(rest, '--repo'));
    const repoState = requireRepo(store, slug);
    createLabelPure(repoState, name, {
      color: flagValue(rest, '--color') || 'ededed',
      description: flagValue(rest, '--description') || '',
      force: hasFlag(rest, '--force'),
    });
    return { stdout: `created label ${name}\n` };
  });
}

// -------------------------------------------------------------------------------------------------------
// `gh api` — REST-shaped (snake_case), matched by path against the endpoints this fixture supports.
// -------------------------------------------------------------------------------------------------------

function handleApi(store, rest) {
  return guarded(() => {
    const method = flagValue(rest, '--method') || flagValue(rest, '-X') || 'GET';
    const jq = flagValue(rest, '--jq');
    let path = rest.find((a, i) => {
      if (a.startsWith('-')) return false;
      const prev = rest[i - 1];
      // skip values that belong to a preceding flag (-F k=v, --method/-X M, --jq Q)
      if (prev === '-F' || prev === '--method' || prev === '-X' || prev === '--jq') return false;
      return true;
    });
    // Real `gh api` expands `{owner}/{repo}` from the cwd's remote; mirror that (PR #3794 fallback reads use it).
    if (path && path.includes('{owner}/{repo}')) path = path.replace('{owner}/{repo}', resolveRepoSlug(store, null));
    if (method !== 'GET') return { stderr: `fake-gh: unsupported api --method ${method}\n`, exitCode: 1 };
    if (!path) return { stderr: 'fake-gh: api: no path given\n', exitCode: 1 };

    let m;
    if ((m = path.match(/^repos\/([^/]+)\/([^/]+)$/))) {
      const slug = `${m[1]}/${m[2]}`;
      const repoState = requireRepo(store, slug);
      return jsonResult({
        name: m[2], full_name: slug, default_branch: repoState.defaultBranch,
        delete_branch_on_merge: !!repoState.deleteBranchOnMerge,
      }, jq);
    }
    if ((m = path.match(/^repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files$/))) {
      const slug = `${m[1]}/${m[2]}`; const num = Number(m[3]);
      const repoState = requireRepo(store, slug); const pr = requirePr(repoState, num);
      const oids = resolveDiffOids(repoState, pr);
      const filesRest = oids.headOid && oids.baseOid ? listChangedFilesRest(repoState.originPath, oids.baseOid, oids.headOid) : [];
      return jsonResult(filesRest, jq);
    }
    if ((m = path.match(/^repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/))) {
      const slug = `${m[1]}/${m[2]}`; const num = Number(m[3]);
      const repoState = requireRepo(store, slug); const pr = requirePr(repoState, num);
      const headOid = refOid(repoState.originPath, pr.headRefName) || pr.lastKnownHeadRefOid;
      return jsonResult({
        number: pr.number, title: pr.title, body: pr.body,
        state: pr.state === 'MERGED' ? 'closed' : pr.state.toLowerCase(),
        merged: pr.state === 'MERGED', draft: pr.isDraft, user: pr.author,
        created_at: pr.createdAt, updated_at: pr.updatedAt, closed_at: pr.closedAt, merged_at: pr.mergedAt,
        base: { ref: pr.baseRefName }, head: { ref: pr.headRefName, sha: headOid },
      }, jq);
    }
    // #3383 (scenario B, I-07) — a trailing `?per_page=100` query string is real usage
    // (`parked-pr-conflict-watch.mjs#defaultConflictLabelAgeMs`'s own `--paginate` call), harness gap: this
    // regex used to require an EXACT path match with no query string at all, so that call's real argv fell
    // through to "unsupported api path" — caught by that function's own try/catch and misread as "cannot tell
    // the label's age", which is the SAFE direction (wait rather than bounce) but silently wrong here: it made
    // the grace timer never fire at all, no matter how long `advance` moved the clock. The query string is
    // otherwise IGNORED (this fixture answers the whole thread in one page always — see this file's own
    // header on why a real `--paginate` client is still correct against a single unpaginated response).
    if ((m = path.match(/^repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/events(?:\?.*)?$/))) {
      const slug = `${m[1]}/${m[2]}`; const num = Number(m[3]);
      const repoState = requireRepo(store, slug); const pr = requirePr(repoState, num);
      return jsonResult(pr.events.map(restEvent), jq);
    }
    // Same query-string tolerance as `/events` just above — real callers append `?per_page=100`
    // (`pr-body-edit.mjs`, `stuck-pr-watch.mjs`).
    if ((m = path.match(/^repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/timeline(?:\?.*)?$/))) {
      const slug = `${m[1]}/${m[2]}`; const num = Number(m[3]);
      const repoState = requireRepo(store, slug); const pr = requirePr(repoState, num);
      const items = [
        ...pr.events.map(restEvent),
        ...pr.comments.map((c) => ({ event: 'commented', body: c.body, created_at: c.createdAt, user: c.author })),
      ].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      return jsonResult(items, jq);
    }
    if ((m = path.match(/^repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/))) {
      const slug = `${m[1]}/${m[2]}`; const num = Number(m[3]);
      const repoState = requireRepo(store, slug); const pr = requirePr(repoState, num);
      return jsonResult(pr.comments.map((c) => ({ id: c.id, user: c.author, body: c.body, created_at: c.createdAt })), jq);
    }
    // Soak harness gap (PR #2821 ci-heal) — `promote-draft-pr-dispatch.mjs#defaultReadHeadCheckState` re-reads a
    // draft's checks for its EXACT head sha (`pr-status-io.mjs#checksArgv`) right before `gh pr ready`. Without
    // this route every promotion refused `stale-check-unreadable` in the simulator. Checks live per PR here (not
    // per commit, and a push does not reset them — same limitation as `pr view`'s rollup), so a sha is answered
    // with the checks of the open PR whose CURRENT head it is. Any other sha (e.g. a main commit) stays
    // UNSUPPORTED, exactly as before this route existed, so main-side readers keep their "no evidence" path.
    // `?check_name=X` filters by name, as real GitHub does.
    if ((m = path.match(/^repos\/([^/]+)\/([^/]+)\/commits\/([0-9a-f]{7,40})\/check-runs(?:\?(.*))?$/))) {
      const slug = `${m[1]}/${m[2]}`; const sha = m[3];
      const checkName = new URLSearchParams(m[4] ?? '').get('check_name');
      const repoState = requireRepo(store, slug);
      const pr = Object.values(repoState.prs ?? {}).find((p) => {
        if (p.state !== 'OPEN') return false;
        const oid = resolveDiffOids(repoState, p).headOid;
        return oid && oid.startsWith(sha);
      });
      if (!pr) return { stderr: `fake-gh: unsupported api path ${path} (no open PR has head ${sha})\n`, exitCode: 1 };
      // Real GitHub always returns a numeric run `id`, and `reconcile-pass.mjs#hydrateChecks` rejects rows without
      // one as malformed — so the simulator numbers each check by its position on the PR (stable per head).
      const runs = (pr.checks ?? []).map((c, index) => ({ c, id: index + 1 })).filter(({ c }) => !checkName || c.name === checkName).map(({ c, id }) => ({
        id, name: c.name, status: String(c.status).toLowerCase(), conclusion: c.conclusion ? String(c.conclusion).toLowerCase() : null,
        started_at: c.startedAt, completed_at: c.completedAt, head_sha: sha,
      }));
      const page = { total_count: runs.length, check_runs: runs };
      // `--paginate --slurp` wraps every page in one array (this fixture answers a single page).
      return jsonResult(hasFlag(rest, '--slurp') ? [page] : page, jq, { compact: true });
    }
    // Legacy commit statuses for a sha — `review-ci-gate-io.mjs#readReviewChecks` reads the combined-status
    // endpoint right after check-runs, and an unsupported answer made every review gate read `unreadable-ci` in
    // the simulator. The fake publishes checks only as check runs, so an open PR's current head answers an empty
    // status list (the same open-PR-head-only scope as the check-runs route above); any other sha stays unsupported.
    if ((m = path.match(/^repos\/([^/]+)\/([^/]+)\/commits\/([0-9a-f]{7,40})\/status(?:\?(.*))?$/))) {
      const slug = `${m[1]}/${m[2]}`; const sha = m[3];
      const repoState = requireRepo(store, slug);
      const pr = Object.values(repoState.prs ?? {}).find((p) => {
        if (p.state !== 'OPEN') return false;
        const oid = resolveDiffOids(repoState, p).headOid;
        return oid && oid.startsWith(sha);
      });
      if (!pr) return { stderr: `fake-gh: unsupported api path ${path} (no open PR has head ${sha})\n`, exitCode: 1 };
      const page = { state: 'pending', sha, total_count: 0, statuses: [] };
      return jsonResult(hasFlag(rest, '--slurp') ? [page] : page, jq, { compact: true });
    }
    // Branch protection's required status checks — only when a scenario declared them (`setRequiredChecks`);
    // otherwise unsupported, exactly as before, so readers keep their documented fallback.
    if ((m = path.match(/^repos\/([^/]+)\/([^/]+)\/branches\/([^/]+)\/protection$/))) {
      const repoState = requireRepo(store, `${m[1]}/${m[2]}`);
      if (Array.isArray(repoState.requiredChecks)) {
        return jsonResult({ required_status_checks: { contexts: repoState.requiredChecks } }, jq);
      }
    }
    if ((m = path.match(/^repos\/([^/]+)\/([^/]+)\/compare\/(.+)\.\.\.(.+)$/))) {
      const slug = `${m[1]}/${m[2]}`; const a = m[3]; const b = m[4];
      const repoState = requireRepo(store, slug);
      let mergeBase;
      try { mergeBase = execFileSync('git', ['merge-base', a, b], { cwd: repoState.originPath, encoding: 'utf8' }).trim(); } catch { mergeBase = a; }
      // #4075 soak harness gap — GitHub's own `ahead_by` (commits in `b` that `a` lacks) / `behind_by` (the
      // reverse): `reconcile-pass.mjs#defaultReadAheadBy` reads `.ahead_by`, and without it every main-red
      // rebase candidate refused `unknown-ahead-by` in the simulator. `null` when either side is unresolvable.
      const count = (range) => {
        try { return Number(execFileSync('git', ['rev-list', '--count', range], { cwd: repoState.originPath, encoding: 'utf8' }).trim()); } catch { return null; }
      };
      return jsonResult({
        merge_base_commit: { sha: mergeBase }, ahead_by: count(`${a}..${b}`), behind_by: count(`${b}..${a}`),
        files: listChangedFilesRest(repoState.originPath, a, b),
      }, jq);
    }
    if ((m = path.match(/^repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/))) {
      const slug = `${m[1]}/${m[2]}`;
      const [filePath, query] = m[3].split('?');
      const ref = new URLSearchParams(query || '').get('ref');
      const repoState = requireRepo(store, slug);
      const useRef = ref || repoState.defaultBranch;
      let content;
      try { content = execFileSync('git', ['show', `${useRef}:${filePath}`], { cwd: repoState.originPath, encoding: 'utf8' }); }
      catch { return { stderr: 'HTTP 404: Not Found\n', exitCode: 1 }; }
      return jsonResult({ path: filePath, content: Buffer.from(content, 'utf8').toString('base64'), encoding: 'base64' }, jq);
    }
    return { stderr: `fake-gh: unsupported api path ${path}\n`, exitCode: 1 };
  });
}

// -------------------------------------------------------------------------------------------------------
// Dispatch + faults/tokens, all inside one locked turn.
// -------------------------------------------------------------------------------------------------------

function dispatch(store) {
  if (argv[0] === 'auth' && argv[1] === 'status') return { stdout: 'logged in to github.com\n' };
  if (argv[0] === 'pr') {
    const sub = argv[1]; const rest = argv.slice(2);
    if (sub === 'list') return handlePrList(store, rest);
    if (sub === 'view') return handlePrView(store, rest);
    if (sub === 'create') return handlePrCreate(store, rest);
    if (sub === 'edit') return handlePrEdit(store, rest);
    if (sub === 'comment') return handlePrComment(store, rest);
    if (sub === 'diff') return handlePrDiff(store, rest);
    if (sub === 'merge') return handlePrMerge(store, rest);
    if (sub === 'close') return handlePrClose(store, rest);
    if (sub === 'reopen') return handlePrReopen(store, rest);
    if (sub === 'ready') return handlePrReady(store, rest);
    if (sub === 'checks') return handlePrChecks(store, rest);
  }
  if (argv[0] === 'run' && argv[1] === 'list') return handleRunList(store, argv.slice(2));
  if (argv[0] === 'label' && argv[1] === 'create') return handleLabelCreate(store, argv.slice(2));
  if (argv[0] === 'api') return handleApi(store, argv.slice(1));
  return { stderr: `fake-gh: unsupported verb "${argv.join(' ')}"\n`, exitCode: 1 };
}

const result = withStore(STORE_PATH, (store) => {
  if (!store.tokens) store.tokens = { revoked: [] };
  if (!store.faults) store.faults = {};
  if (!store.repos) store.repos = {};

  if (TOKEN && store.tokens.revoked.includes(TOKEN)) {
    return { stderr: HTTP_401, exitCode: 1 };
  }

  const verb = callVerb();
  const bucket = store.faults[verb];
  if (bucket && bucket.length) {
    const f = bucket[0];
    f.timesLeft -= 1;
    if (f.timesLeft <= 0) bucket.shift();
    if (f.kind === 'rate-limit') return { stderr: HTTP_RATE_LIMIT, exitCode: 1 };
    if (f.kind === '5xx') return { stderr: HTTP_5XX, exitCode: 1 };
    // PR #3794 — GitHub's answer to `gh pr diff` on a PR over 300 files; permanent for that endpoint.
    if (f.kind === 'too-large') return { stderr: HTTP_406_TOO_LARGE, exitCode: 1 };
    if (f.kind === '401') return { stderr: HTTP_401, exitCode: 1 };
    if (f.kind === 'timeout') return { sleepMs: 120_000 };
    // #4075 soak harness gap — see GO_NETWORK_ERROR's own comment above.
    if (f.kind === 'network') return { stderr: GO_NETWORK_ERROR, exitCode: 1 };
    // #3383 scenario A2 — NOT a failure: a real side-effecting push, mid-call, then fall through to the
    // ordinary verb handler below so THIS call still answers normally. See `fake-gh.mjs#pushCommitToRef`'s own
    // docblock for why this must live here (inside the shim's own dispatch) rather than a scenario play step.
    //
    // `push-to-main-diverge` additionally commits (empty, `--allow-empty`) directly into THIS CALL'S OWN cwd
    // (`CWD` — the dispatching daemon's own shared clone, since every `gh` child this simulator spawns inherits
    // its parent daemon's cwd) — i.e. it leaves the DISPATCHING checkout genuinely AHEAD of origin at the same
    // moment origin gains a commit of its own, a real DIVERGED tree. This is deliberately the stronger of the
    // two variants: `assertMainNotStale`'s own `cleanOnly` staleness check silently self-heals a plain
    // BEHIND-only checkout via `git merge --ff-only` (see `main-staleness.mjs#checkMainStaleness` — that IS the
    // point of `cleanOnly`, and it means a bare `push-to-main` alone never reproduces a genuine refusal here) —
    // only a DIVERGED tree (ahead AND behind) refuses to fast-forward and throws, which is exactly the shape
    // this file's own header describes as the REAL live incident's underlying condition ("the clone is usually
    // ALSO ahead — unmerged fixes merged in to run ahead of main").
    if (f.kind === 'push-to-main' || f.kind === 'push-to-main-diverge') {
      try {
        const slug = f.repo || resolveRepoSlug(store, null);
        const repoState = store.repos[slug];
        if (repoState) pushCommitToRef(repoState.originPath, f.branch || 'main', f.files || {}, f.message);
      } catch { /* best-effort — the fault is still consumed once regardless (see timesLeft above) */ }
      if (f.kind === 'push-to-main-diverge') {
        try {
          execFileSync('git', [
            '-c', 'user.email=sim-fault@example.com', '-c', 'user.name=Sim Fault', '-c', 'commit.gpgsign=false',
            'commit', '--allow-empty', '-m', f.localMessage || 'sim: local-ahead (mid-tick fault, #3383 A2)',
          ], { cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch { /* best-effort — same as above */ }
      }
      // falls through to `dispatch(store)` below — no early return
    }
  }

  return dispatch(store);
});

// Rule 2 — no process.exit() on the write path. `sleepMs` (the 'timeout' fault) sleeps AFTER the lock has
// already been released above, so a slow-timeout call never blocks any other concurrent caller.
if (result.sleepMs) {
  sleepSyncMs(result.sleepMs);
  process.exitCode = 0;
} else {
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout !== undefined) process.stdout.write(result.stdout);
  process.exitCode = result.exitCode ?? 0;
}
