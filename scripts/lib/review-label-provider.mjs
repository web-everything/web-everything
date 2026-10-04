/**
 * @file scripts/lib/review-label-provider.mjs
 * @description THE PROVIDER PORT for the review-label arc (#x8xf5rl) — the four operations
 *   `we:scripts/review-set-label.mjs` needs from a forge, behind one injectable seam.
 *
 * WHY THIS EXISTS, AND IT IS NOT "we might add GitLab". `review-set-label.mjs` reached GitHub through five
 * hardcoded `execFileSync('gh', …)` calls, and its 1787-line test file covers only PURE functions
 * (`decideSetLabel`, `presentRemoveLabels`, `buildVerdictComment`) because there was nothing to inject through.
 * So the WRITE ARC had no test at all — including the branch that file's own #2964 block calls "the safety
 * property": comment-first UNLESS `review:accepted` is already live, because an orphan LABEL makes
 * `acceptanceCoversHead` fail OPEN and the drain then merges with the #2409 staleness gate disarmed. That was
 * the most consequential untested line in the review path, and a seam is what makes it assertable.
 *
 * THE SHAPE IS FITTED TO THIS CALLER, NOT DECLARED FORGE-AGNOSTIC. One implementation never validates an
 * abstraction. If a second forge ever arrives this port is a far better starting point than five scattered
 * subprocess calls — and it should be expected to CHANGE shape then, not treated as already correct. Nothing
 * here claims otherwise.
 *
 * WHAT DELIBERATELY DID NOT MOVE BEHIND THE PORT: independence (#2844), the `reviewed-sha` / `reviewed-diff` /
 * `reviewed-contribution` markers, `decideSetLabel`, the #2964 ordering, and the verdict-ledger append. They are
 * DECISIONS, and they stay above the seam — which is the whole point. The port carries forge mechanics only.
 *
 * SYNCHRONOUS BY CONTRACT. Every operation here PERFORMS the work and reports its real outcome. A deferred
 * transport (stage a request, let CI run the adapter later) must NOT implement this port: it could only ever
 * answer "requested", and both available lies are known failures — reporting success on a write that never
 * landed wedges the run, reporting failure on one that did double-posts a durable comment. Deferral wraps a
 * provider call; it does not pretend to be one.
 *
 * IMPURE by construction in `createGhProvider`; the module itself is pure.
 *
 * DEFAULT `exec` IS THROTTLED (#3621) — `we:scripts/lib/gh-throttle.mjs#runGhSync`, a byte-for-byte transparent
 * `execFileSync('gh', args, opts)` replacement that gates every call through a host-wide concurrency semaphore
 * and retries a rate-limit-shaped failure with bounded backoff. This is the SAME `(args, opts) => …` shape the
 * inline call above had, so nothing about this adapter's return/throw contract changes — only the safety
 * margin under GitHub's secondary (burst) rate limit does. Every caller of `createGhProvider()` with no `exec`
 * override (`we:scripts/conveyor/parked-pr-conflict-watch.mjs`, `review-round-tag.mjs`, `review-status-tag.mjs`
 * — all three run every conveyor-runner tick) gets this for free.
 */

import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGhSync } from './gh-throttle.mjs';

/** The `--json` fields the label arc reads about a PR. Named once so a second adapter supplies the same shape
 *  rather than guessing at it, and so a stub in a test cannot drift from what the real one returns. */
export const PR_STATE_FIELDS = Object.freeze(['labels', 'headRefOid', 'headRefName', 'state', 'body', 'createdAt', 'title', 'comments', 'isDraft']);
// `isDraft` (#xe8y12n) rides the SAME call: the missing-only re-arm re-reads it at the pre-write boundary so a
// PR converted to draft after the caller's observation never receives `review:pending`.
// `title` supplies delegation trial descriptions on this same call, with no extra hop.
// `createdAt` (#3067) rides the SAME call — one more json field, no extra hop, the pattern #2844 used for
// `body` and #2953 for `state`. It is what turns a MISSING `authored-by-actor` stamp from an assumption into a
// checkable comparison: a PR opened after `STAMP_REGIME_START` and now lacking a stamp had one STRIPPED, while
// an older one simply never had it. Without this field `decideClearerIndependence` cannot tell the two apart
// and tolerates both as `unknown-author` — the tolerance #3067 exists to bound.
// `comments` (#x9krtkb) rides the SAME call too, for the ONE target that needs to read them back: `restamp`
// must know whether the acceptance it is carrying across a drain-authored rebase was a HUMAN clearance
// (`parseLatestHumanClearedSha` in `we:scripts/lib/review-escalation.mjs`), and there is no seam to fetch them
// separately from the pure decider below. Before this the restamp path had NO visibility into the PR's own
// comments at all — it could not have carried the `cleared-human` marker forward even if it tried. Every OTHER
// target ignores the field; one more json key on an existing `gh pr view` call costs nothing extra callers pay.

/**
 * The argv a `gh` adapter runs for each operation. PURE, and exported SEPARATELY from the adapter so a test can
 * assert the command is byte-identical to what this file executed before the port existed — a refactor of a
 * merge-safety path must be provably argv-preserving, not merely "looks right".
 */
export const GH_ARGV = Object.freeze({
  readPrState: (repo, pr) => ['pr', 'view', String(pr), '--repo', repo, '--json', PR_STATE_FIELDS.join(',')],
  readLabels: (repo, pr) => ['pr', 'view', String(pr), '--repo', repo, '--json', 'labels'],
  // The removals are INTERSECTED with the PR's live labels by `presentRemoveLabels` before they reach here —
  // `gh pr edit --remove-label` errors on a label the PR does not carry, so passing an absent one is a failure,
  // not a no-op. The port does not re-derive that; it is a decision and it stays above the seam.
  // `add` is OPTIONAL (#2026-09-01, `we:scripts/conveyor/review-status-tag.mjs`'s own caller): a purely
  // informative label can go from "something to show" to "nothing live" with no replacement, and `gh pr edit`
  // has no way to add nothing — omitting `--add-label` entirely, rather than passing a falsy value through, is
  // the only remove-only shape `gh` accepts. Every EXISTING caller always supplies a real `add` (a verdict
  // transition never adds nothing), so this is additive — the byte-identical two-arg shape above is unchanged.
  setLabels: (repo, pr, { add, remove = [] }) => {
    const argv = ['pr', 'edit', String(pr), '--repo', repo];
    if (add) argv.push('--add-label', add);
    for (const rm of remove) { argv.push('--remove-label', rm); }
    return argv;
  },
  // `--body-file`, never `--body`: the verdict body carries newlines and emoji, and shell-quoting them is the
  // kind of thing that works until one comment does not.
  postComment: (repo, pr, bodyFile) => ['pr', 'comment', String(pr), '--repo', repo, '--body-file', bodyFile],
  currentRepo: () => ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
  // `--force` makes this CREATE-OR-UPDATE, never an error on an already-existing label — the only shape that
  // is safe to call unconditionally before every `setLabels`. `gh pr edit --add-label` REFUSES a label that
  // does not exist in the repo yet ("'X' not found"), unlike `we:scripts/review-set-label.mjs`'s own small,
  // long-lived FIXED label set (created once, years ago) — an open-ended label family like
  // `we:scripts/conveyor/review-round-tag.mjs`'s `review-round:<N>` mints a brand new name on its very first
  // use at every N, so ensuring existence has to be part of applying it, not a one-time setup step.
  ensureLabel: (repo, name, { color = 'ededed', description = '' } = {}) =>
    ['label', 'create', name, '--repo', repo, '--color', color, '--description', description, '--force'],
  // The PR's changed files, NET versus its base (#4034 follow-up, card 4034b) — read-only, used ONLY to stamp
  // `changedFiles` on a delegation-trial row before it is written; never to gate or edit anything about the PR
  // itself. `--method GET` IS LOAD-BEARING, not decoration: `gh api` silently switches to `POST` once an `-f`/
  // `-F` parameter is present, and `pulls/{n}/files` has no `POST` handler — every call then 404s. Same shape,
  // same gotcha, as `we:scripts/conveyor/parked-pr-conflict-watch.mjs#defaultListPrFiles` (confirmed live
  // 2026-09-23 against real PR #2514) — duplicated here rather than imported, because that file is a heavy
  // conveyor daemon module (`rebase-drop-manifest.mjs`, `queue-scope.mjs`, `stand-down.mjs`, …) this port's own
  // caller (`review-set-label.mjs`) already goes out of its way NOT to pull in transitively (per that same
  // file's documented reason for avoiding `reconcile-core.mjs#assessLiveness` — a heavy load-time import chain
  // is exactly the hazard both sides are keeping out of each other's graph).
  readPrFiles: (repo, pr) => ['api', '--paginate', '--method', 'GET', '-F', 'per_page=100', `repos/${repo}/pulls/${pr}/files`, '--jq', '.[].filename'],
});

/**
 * The `gh` provider — the default, and byte-identical to what `review-set-label.mjs` executed inline before.
 *
 * `exec` is injectable so the ADAPTER itself is testable without `gh` on PATH; a test asserts the argv it builds.
 * That is a different seam from the port: this one proves the adapter is faithful, the port proves the caller's
 * ordering is right.
 *
 * @param {{exec?: Function, writeFile?: Function, removeFile?: Function, tmpDir?: string}} [o]
 */
export function createGhProvider({
  exec = (args, opts) => runGhSync(args, { encoding: 'utf8', ...opts }),
  writeFile = writeFileSync,
  removeFile = unlinkSync,
  tmpDir = tmpdir(),
} = {}) {
  return {
    name: 'gh',

    readPrState(repo, pr) {
      return JSON.parse(exec(GH_ARGV.readPrState(repo, pr), { maxBuffer: 64 * 1024 * 1024 }));
    },

    readLabels(repo, pr) {
      return JSON.parse(exec(GH_ARGV.readLabels(repo, pr), { maxBuffer: 64 * 1024 * 1024 })).labels || [];
    },

    setLabels(repo, pr, spec) {
      exec(GH_ARGV.setLabels(repo, pr, spec), { maxBuffer: 16 * 1024 * 1024 });
    },

    ensureLabel(repo, name, opts) {
      exec(GH_ARGV.ensureLabel(repo, name, opts), { maxBuffer: 16 * 1024 * 1024 });
    },

    // The temp file is written and removed HERE rather than by the caller: it is an artefact of this adapter's
    // `--body-file` mechanic, and a second adapter posting over an API would have no file at all. `finally` so a
    // failed post still cleans up — the body can be large and it is not the caller's litter to sweep.
    postComment(repo, pr, body) {
      const path = join(tmpDir, `review-label-${pr}-${process.pid}.md`);
      try {
        writeFile(path, body, 'utf8');
        exec(GH_ARGV.postComment(repo, pr, path), { maxBuffer: 16 * 1024 * 1024 });
      } finally {
        try { removeFile(path); } catch { /* best-effort cleanup */ }
      }
    },

    /** NOT part of the port proper — it answers "which repo am I in", not "what about this PR". Kept on the
     *  adapter because it is the same `gh` arc, and it fires only when `--repo` was omitted. */
    currentRepo() {
      return exec(GH_ARGV.currentRepo(), { maxBuffer: 4 * 1024 * 1024 }).trim();
    },

    /** The PR's changed files, net versus its base — real pagination applied, no cap. Read-only; see
     *  {@link GH_ARGV.readPrFiles} for why `--method GET` cannot be dropped. */
    readPrFiles(repo, pr) {
      const out = exec(GH_ARGV.readPrFiles(repo, pr), { maxBuffer: 64 * 1024 * 1024 });
      return String(out || '').split('\n').map((s) => s.trim()).filter(Boolean);
    },
  };
}

/**
 * Decide the ORDER the two writes must land in. PURE, and extracted for one reason: this was the branch with no
 * test.
 *
 * NOT ALREADY ACCEPTED (the ordinary first accept, and every `changes` / `rearm` / `clear-human` bounce) →
 * COMMENT FIRST. An orphan comment is INERT — `parseReviewedSha` is only ever reached behind a live
 * `review:accepted` — whereas an orphan LABEL is not: `review:accepted` with no marker makes
 * `acceptanceCoversHead` fail OPEN, and the drain then merges with the #2409 staleness gate disarmed.
 *
 * ALREADY ACCEPTED (re-accept after a fix) → SWAP FIRST. Comment-first would post a marker naming the LIVE head
 * while the acceptance is already live, so a run whose swap then FAILED would have freshened the coverage of an
 * acceptance it never applied.
 *
 * Keyed on the LABEL, not on `to`: `buildComment` is caller-supplied, so this cannot know whether a given
 * caller's body stamps a marker, and assuming it might is the conservative direction.
 *
 * @param {{acceptanceAlreadyLive: boolean}} o
 * @returns {['comment','swap']|['swap','comment']}
 */
export function writeOrder({ acceptanceAlreadyLive } = {}) {
  return acceptanceAlreadyLive ? ['swap', 'comment'] : ['comment', 'swap'];
}
