/**
 * @file scripts/operations/gate-health-io.mjs
 * @description The INJECTED READERS for the `gate-health` operation — the only half that touches `gh`, `git`
 *   and the filesystem. Kept out of `gate-health.mjs` for the same reason `suggest-next-io.mjs` is kept out of
 *   `suggest-next.mjs`: the declaration's import graph is asserted to be free of `node:` specifiers, so the
 *   step functions provably hold no writer in lexical scope. Everything here READS.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');

/** Record separator for the git log stream. `\x1e` cannot appear in a commit subject. */
const LOG_SEP = '\x1e';

/** How far after a merge a fix still counts as "following" it. */
export const FOLLOW_WINDOW_DAYS = 14;

/**
 * Files churned by nearly every PR. Left in, they manufacture a follow-up for EVERY pull request and the
 * comparison collapses toward equal rates — a false null rather than a false positive, but wrong either way.
 *
 * The cut is a SHARE of the commits read, so it does not drift as history grows, with an absolute FLOOR
 * underneath it. The floor is what makes the rule safe on a short window: at 4 commits a 2% share rounds to 1,
 * and a file touched twice would be classified as repo-wide churn, which would discard nearly every record.
 * A file has to be genuinely churned — {@link HOT_FILE_MIN} commits — before its share is even consulted.
 */
export const HOT_FILE_SHARE = 0.02;
export const HOT_FILE_MIN = 20;

/** The churn count at or above which a file is treated as repo-wide noise. Pure; exported to be testable. */
export function hotFileCut(commitCount) {
  return Math.max(HOT_FILE_MIN, Math.ceil((Number(commitCount) || 0) * HOT_FILE_SHARE));
}

/**
 * Merged pull requests, newest first, via `gh`.
 *
 * NOTE the label caveat, which is load-bearing for anything read off `escalated`: labels are MUTATED in place
 * — the review-clear ceremony swaps `review:changes` for `review:accepted` — so the labels visible now are the
 * FINAL state, not the state at any point during review. `escalated` (did this PR carry ANY `review:*` label)
 * survives that, because the ceremony swaps one review label for another and never strips them all. Anything
 * finer, in particular "did a reviewer request changes", does NOT survive it and must come from the PR
 * timeline instead. This reader deliberately does not expose a field it cannot read honestly.
 *
 * @param {{repo?: string, limit?: number}} [o]
 * @returns {Array<object>} raw `gh` records.
 */
export function readMergedPrs({ repo = CONSTELLATION_REPOS.we.slug, limit = 300 } = {}) {
  const out = execFileSync('gh', [
    'pr', 'list', '--repo', repo, '--state', 'merged', '--limit', String(limit),
    '--json', 'number,title,labels,mergedAt,mergeCommit,additions,deletions,changedFiles',
  ], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  return JSON.parse(out);
}

/**
 * The first-parent commit stream with each commit's touched files.
 *
 * `--first-parent` is CORRECTNESS, not tidiness. Without it a merge commit lists no files at all (git shows
 * no diff for a merge by default), every merge-commit lookup returns an empty set, and the analysis reports
 * "0 measurable" while looking exactly like a successful run. That failure is silent and self-consistent,
 * which is why it is called out here rather than left to the flag.
 *
 * @param {{root?: string, ref?: string, max?: number}} [o]
 * @returns {Array<{sha:string, t:number, subject:string, files:string[]}>} newest first.
 */
export function readCommitStream({ root = REPO_ROOT, ref = 'origin/main', max = 4000 } = {}) {
  const raw = execFileSync('git', [
    'log', '--first-parent', `--format=${LOG_SEP}%H|%ct|%s`, '--name-only', ref, '-n', String(max),
  ], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const commits = [];
  for (const block of raw.split(LOG_SEP).slice(1)) {
    const nl = block.indexOf('\n');
    const head = nl < 0 ? block : block.slice(0, nl);
    const [sha, ct, ...rest] = head.split('|');
    commits.push({
      sha,
      t: Number(ct) || 0,
      subject: rest.join('|'),
      files: (nl < 0 ? '' : block.slice(nl + 1)).split('\n').map((s) => s.trim()).filter(Boolean),
    });
  }
  return commits;
}

/**
 * Join the two reads into the flat per-PR records `assessCriteria` consumes.
 *
 * PURE given its inputs — it performs no IO, so the whole join is testable with fixture arrays. Exported
 * separately from {@link createHistoryReader} for exactly that reason.
 *
 * @param {object} o
 * @param {Array<object>} o.prs - from {@link readMergedPrs}.
 * @param {Array<object>} o.commits - from {@link readCommitStream}.
 * @param {(subject: string) => string|null} o.classify - `classifyFollowUp` from `we:scripts/lib/gate-health.mjs`,
 *   injected rather than imported so this module stays a pure join over its arguments.
 * @param {number} [o.windowDays]
 * @returns {{records: Array<object>, unmeasurable: number, hotFiles: string[]}}
 */
export function joinHistory({ prs, commits, classify, windowDays = FOLLOW_WINDOW_DAYS }) {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const churn = new Map();
  for (const c of commits) for (const f of c.files) churn.set(f, (churn.get(f) || 0) + 1);
  const hotCut = hotFileCut(commits.length);
  const hot = new Set([...churn.entries()].filter(([, n]) => n >= hotCut).map(([f]) => f));
  const windowSec = windowDays * 24 * 3600;

  const records = [];
  let unmeasurable = 0;
  for (const pr of prs) {
    const mc = pr.mergeCommit?.oid ? bySha.get(pr.mergeCommit.oid) : null;
    // Not in the log window, or every file it touched is hot — either way there is no attributable surface,
    // and a PR with no surface must be DROPPED rather than counted as "no follow-up". Counting it as a clean
    // outcome would deflate the defect rate of whichever group happens to hold more of them.
    const own = mc ? mc.files.filter((f) => !hot.has(f)) : [];
    if (!mc || own.length === 0) { unmeasurable += 1; continue; }
    let followUp = null;
    let followUpSource = null;
    for (const c of commits) {
      if (c.t <= mc.t || c.t > mc.t + windowSec || c.sha === mc.sha) continue;
      const kind = classify(c.subject);
      if (!kind) continue;
      if (!own.some((f) => c.files.includes(f))) continue;
      // First match wins, but a review-followup does NOT get to mask a later independent fix — the
      // independent one is the signal being measured, so it takes precedence when both exist.
      if (kind === 'independent-fix') { followUp = kind; followUpSource = c.sha; break; }
      if (followUp === null) { followUp = kind; followUpSource = c.sha; }
    }
    records.push({
      number: pr.number,
      title: pr.title,
      lines: (Number(pr.additions) || 0) + (Number(pr.deletions) || 0),
      files: Number(pr.changedFiles) || 0,
      escalated: (pr.labels ?? []).some((l) => String(l.name).startsWith('review:')),
      followUp,
      // WHICH commit produced the signal. One fix touching thirty files marks thirty PRs from a single event,
      // so without this the analysis counts thirty independent trials where there is one.
      followUpSource,
      // Merge time, so a PR whose follow-up window has not closed can be excluded rather than scored clean.
      mergedAtSec: mc.t,
    });
  }
  return { records, unmeasurable, hotFiles: [...hot].sort() };
}

/**
 * The reader the declaration injects. Binds the two reads and the join into one call.
 *
 * @param {{repo?: string, root?: string, classify: (s: string) => string|null}} o
 * @returns {(input: {limit?: number, windowDays?: number}) => object}
 */
export function createHistoryReader({ repo = CONSTELLATION_REPOS.we.slug, root = REPO_ROOT, classify } = {}) {
  if (typeof classify !== 'function') {
    throw new TypeError('gate-health-io: `classify` is required — pass `classifyFollowUp` from we:scripts/lib/gate-health.mjs');
  }
  // `repo` comes from the CALL, not from binding time. Bound at construction it silently ignored
  // `--repo=frontier-ui/frontierui` and answered with web-everything's history — a wrong answer wearing the
  // right label, which is worse than a refusal. `root` still binds, so a cross-repo request is refused below
  // rather than joined against the wrong commit stream.
  return ({ repo: asked = repo, limit = 300, windowDays = FOLLOW_WINDOW_DAYS } = {}) => {
    if (asked !== repo) {
      throw new Error(
        `gate-health: this reader is bound to ${repo} but was asked for ${asked}. The commit stream comes from a `
        + 'local checkout, so answering would join one repo\'s PRs against another\'s history. Run it from that repo.',
      );
    }
    const prs = readMergedPrs({ repo: asked, limit });
    const commits = readCommitStream({ root });
    // The clock is read HERE and passed through, never called inside the analysis — so a given history plus a
    // given `nowSec` always produces the same assessment.
    return { repo, nowSec: Math.floor(Date.now() / 1000), ...joinHistory({ prs, commits, classify, windowDays }) };
  };
}
