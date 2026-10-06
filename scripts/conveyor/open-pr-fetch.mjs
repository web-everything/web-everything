/** One open-PR snapshot per mechanical tick, shared across subprocesses via --prs-file=<path>.
 * The runner owns the file's lifetime; standalone passes retain their narrower, throttled queries.
 */
import { readFileSync } from 'node:fs';
import { runGhSync, execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { ghRestGetPaged } from '../lib/gh-rest-read.mjs';
import { enrichPrsWithCompleteComments } from './pr-comments-complete.mjs';

// #3383 — `baseRefName` joined the union once `reconcile-pass.mjs` and `parked-pr-conflict-watch.mjs` each
// started reading it (the STACKED-BASE CONFLICT branch needs it to tell a PR stacked on another lane/PR apart
// from an ordinary conflict against `main`); `open-pr-fetch.test.mjs` pins this as the DEDUPLICATED UNION of
// every standalone reader's own field list, so a reader that starts reading a new field and forgets to widen
// this one goes red here, not silently.
// `isDraft` (draft-first PRs, operator-approved 2026-09-27) — see `reconcile-pass.mjs#PR_LIST_JSON_FIELDS`'s
// own comment; this is the SAME field, on the field list the real daemon actually reads (this fetch feeds the
// `--prs-file=` every mechanical pass in `skills-src/conveyor/runner.mjs` shares for one tick).
export const OPEN_PR_LIST_FIELDS = 'number,headRefName,title,body,labels,files,mergeable,mergeStateStatus,headRefOid,baseRefName,statusCheckRollup,comments,isDraft,createdAt';
export const PR_LIST_LIMIT = 200;

/** Throws on a failed fetch so the runner can fall back to each pass's standalone discovery. */
export function defaultFetchOpenPrs({ repo = null, exec = runGhSync, readComments } = {}) {
  const argv = ['pr', 'list', '--state', 'open', '--limit', String(PR_LIST_LIMIT), '--json', OPEN_PR_LIST_FIELDS];
  if (repo) argv.push('--repo', repo);
  const out = exec(argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(String(out || '[]'));
  return Array.isArray(parsed) ? enrichPrsWithCompleteComments(parsed, { repo, ...(readComments ? { readComments } : {}) }) : [];
}

/** A missing, malformed, or non-array snapshot is an empty safe list, never another network read. */
export function readPrsFromFile(path, { readFile = readFileSync } = {}) {
  try {
    const parsed = JSON.parse(readFile(path, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// #4351's own build-dispatch follow-up (guided by #4309 spend accounting) — the standalone BUILD-DISPATCH DAEMON called
// `defaultFetchOpenPrs` directly, once per constellation repo, every tick (`DEFAULT_INTERVAL_MS`): the widest,
// 13-field GraphQL query above, paying its full nested-resolver cost (mergeable, statusCheckRollup, comments, …)
// even though `build-dispatch-policy.mjs#normalizeOpenPrs`/`#prDeliversNum` — its ONLY consumers of the result —
// read exactly `number`, `headRefName`, `labels`, `files` (paths only); `isDraft` is read by NEITHER (checked:
// `build-dispatch-policy.mjs` has no `isDraft`/`.draft` reference at all), included below anyway because the
// REST list endpoint gives it for free. Measured live 2026-09-29: this ONE caller was the top GraphQL spender —
// 121 calls/3h at ~50 points/call (`gh-spend.mjs report --by=caller+op`), well over half the shared GraphQL
// bucket that hour. `BUILD_DISPATCH_PR_FIELDS` is the caller-read field list this REST path is held to; a
// consumer that starts reading a new field must widen it here first (or read a field this path never sends).
export const BUILD_DISPATCH_PR_FIELDS = Object.freeze(['number', 'headRefName', 'labels', 'files', 'isDraft']);

/**
 * One REST `pulls` LIST item + its (separately-fetched) `files` page, in the shape `build-dispatch-policy.mjs`
 * reads: `head.ref` → `headRefName`, `labels[].name` kept as `{name}` (parity with the GraphQL shape
 * `normalizeOpenPrs` already tolerates either way), `draft` → `isDraft`, and REST's `filename` → `path` (REST
 * has no per-file `path` key — `gh pr list --json files` derives `path` from GraphQL's own `path` field, REST's
 * nearest equivalent is `filename`). PURE.
 * @param {object} p  one item from `GET /repos/{o}/{r}/pulls?state=open`
 * @param {Array<object>} files  the PR's own `GET .../pulls/{number}/files` page(s), already concatenated
 */
export function restPullToBuildDispatchShape(p, files = []) {
  return {
    number: p.number,
    headRefName: p.head?.ref ?? '',
    labels: (p.labels || []).map((l) => ({ name: (typeof l === 'string' ? l : l?.name) ?? '' })).filter((l) => l.name),
    isDraft: !!p.draft,
    files: (files || []).map((f) => ({ path: f?.filename ?? '' })).filter((f) => f.path),
  };
}

/**
 * REST replacement for `defaultFetchOpenPrs`, scoped to exactly what the build-dispatch daemon reads
 * ({@link BUILD_DISPATCH_PR_FIELDS}) — spends the `core` REST bucket (`gh api`) instead of `graphql`
 * (`gh pr list`), via the shared ETag-conditional path (`lib/gh-rest-read.mjs#ghRestGetPaged`, #4351).
 *
 * `files` needs a SEPARATE REST call per PR (the list endpoint never includes it) — one extra `core`-bucket GET
 * per open PR, every tick. That is the real cost this path adds back, and it is why "only fetch files when
 * needed" here means the SAME mechanism as the list fetch itself: every call is ETag-conditional, so a PR whose
 * file set has not changed since the last tick (the overwhelming common case — files rarely change once a PR is
 * up) answers with a free `304`. `build-dispatch-policy.mjs`'s scope-vs-open-prs rule checks EVERY open PR's
 * files against every candidate's scope unconditionally, so skipping the fetch outright for a subset of PRs is
 * not an option here — the ETag 304 path is what makes "fetch every PR's files every tick" cheap instead of
 * fetching every PR's files fresh every tick.
 *
 * @param {{repo?:string|null, exec?:Function, dir?:string|null, env?:NodeJS.ProcessEnv, maxItems?:number}} [o]
 * @returns {Array<object>} one row per open PR, in {@link restPullToBuildDispatchShape}'s shape
 */
// @test-only-export-ok: the real consumer is the build-dispatch daemon's cliFetchOpenPrs, which reaches this
// module via a dynamic await-import rather than a static import specifier this scan's import graph follows.
export function fetchOpenPrsRest({
  repo = null, exec = execFileSyncThrottled, dir = null, env = process.env, maxItems = PR_LIST_LIMIT,
} = {}) {
  const repoPath = repo ? `repos/${repo}` : 'repos/{owner}/{repo}';
  const context = repo || process.cwd();
  const pulls = ghRestGetPaged(`${repoPath}/pulls?state=open`, {
    exec, dir, env, context, op: 'rest pr-list (build-dispatch)', maxItems,
  });
  return pulls.map((p) => {
    const files = ghRestGetPaged(`${repoPath}/pulls/${p.number}/files`, {
      exec, dir, env, context: `${context}#${p.number}`, op: 'rest pr-files (build-dispatch)', maxItems: 300,
    });
    return restPullToBuildDispatchShape(p, files);
  });
}
