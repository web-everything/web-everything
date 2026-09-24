/**
 * @file Read-only operator queue: the SOLE authority on which human-gated PRs are worth the operator's time.
 *
 * THE OPERATOR'S RULE (2026-09-19): "I won't look at a human PR until it carries `advisory:accepted` and has no
 * request-changes or review-pending." A PR is in NEEDS YOU only when ALL of these hold:
 *   - it carries `review:human` AND `advisory:accepted`, and carries NEITHER `review:pending` NOR `review:changes`
 *     (a HARD gate on the labels — `review:pending` is by definition not ready);
 *   - the advisory COMMENT, parsed independently (`we:scripts/lib/advisory-labels.mjs#parseAdvisories`), agrees:
 *     its newest advisory covers the live head and accepts. The comment is the source of truth; the label is a
 *     derived view of it. Any disagreement between the two is reported in NOT READY as the reason, never resolved
 *     silently in either direction;
 *   - CI is green, the PR is not conflicting, and GitHub reports it MERGEABLE.
 *
 * THREE BUCKETS, not two. `mergeable: UNKNOWN` is GitHub's transient "still computing" state, and reporting it in
 * NOT READY ("agent work is owed") made a healthy PR flap between ready and not-ready from run to run. So an
 * UNKNOWN PR is re-polled a few times with backoff (GitHub computes on request); one that is STILL unknown lands in
 * PENDING — "transient, re-run", where no agent work is owed. A PR with a real failure stays in NOT READY and does
 * not list the transient state among its reasons.
 *
 * A FIFTH SECTION, STOOD DOWN, ORTHOGONAL TO ALL OF THE ABOVE (we:backlog/x6cjgz5). A conveyor stand-down comment
 * (`we:scripts/conveyor/stand-down.mjs`) is posted whenever a fix agent stops to ask for human judgment, and BY
 * DESIGN it changes no label — `review:human` stays whatever it already was, which for most stood-down PRs is
 * nothing at all. So a stood-down PR without `review:human` was in nobody's queue (live: PR #2505 sat stood down
 * and invisible). This section lists every OPEN PR carrying at least one stand-down comment, regardless of its
 * labels, reusing `countStandDownComments`/`STAND_DOWN_MARKER` rather than re-deriving the match rule — and never
 * duplicates a PR already shown in NEEDS YOU.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  ADVISORY_LABELS, ADVISORY_OUTCOMES, advisoryCoversHead, latestAdvisory,
} from '../lib/advisory-labels.mjs';

import { CONSTELLATION_REPOS, repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { readUnsupported } from '../conveyor/unsupported-repo.mjs';
// Imports the LIGHTWEIGHT marker module directly, never `stuck-pr-watch-core.mjs` itself — that file pulls in
// `reconcile-core.mjs`'s much heavier transitive graph (`rearm-review.mjs` → `review-set-label.mjs` →
// `merge-ai-prs.mjs`), which broke this file's own mocked `node:child_process` test setup. See
// `we:scripts/conveyor/stuck-pr-dispatch-marker.mjs`'s own header for the full story.
import { stuckDispatchEpisodes } from '../conveyor/stuck-pr-dispatch-marker.mjs';
import { countStandDownComments, standDownComments, standDownReason } from '../conveyor/stand-down.mjs';
const hasLabel = (pr, name) => (pr.labels ?? []).some((label) => label.name === name);

/** How many times an UNKNOWN mergeability is re-polled, and the first backoff (doubling each attempt). */
export const MERGEABLE_POLL_ATTEMPTS = 4;
export const MERGEABLE_POLL_DELAY_MS = 1000;

/**
 * Evaluate one PR against every readiness gate. Pure.
 * @returns {{ready: boolean, reasons: string[], transient: boolean}} `transient` is true when the ONLY thing
 *   between this PR and `ready` is GitHub's still-computing mergeability — `ready` is then false and `reasons` empty.
 */
export function evaluatePr(pr) {
  const reasons = [];
  if (!hasLabel(pr, 'review:human')) reasons.push('no review:human label');

  const advisory = latestAdvisory(pr.comments);
  const head = (pr.headRefOid ?? '').toLowerCase();
  const covers = advisory ? advisoryCoversHead(advisory, head) : false;
  if (!advisory) {
    reasons.push('no advisory verdict');
  } else if (!covers) {
    reasons.push(`advisory is on ${advisory.head.toLowerCase().slice(0, 9)}, head is ${head.slice(0, 9)}`);
  }
  if (advisory?.outcome === ADVISORY_OUTCOMES.CHANGES || hasLabel(pr, 'review:changes')) {
    reasons.push('changes requested');
  }
  if (hasLabel(pr, 'review:pending')) reasons.push('review:pending label (advisory not accepted yet)');

  // THE LABEL GATE, and its cross-check against the parsed comment. `parsed` is what the comment says about the
  // CURRENT head: a stale or missing advisory says nothing, so any advisory label riding on it is a disagreement.
  const accepted = hasLabel(pr, ADVISORY_LABELS.ACCEPTED);
  const changes = hasLabel(pr, ADVISORY_LABELS.CHANGES);
  const parsed = advisory && covers ? advisory.outcome : null;
  const parsedText = parsed
    ? `advisory comment says ${parsed} on this head`
    : (advisory ? 'advisory comment is not on this head' : 'no advisory comment');
  if (accepted && changes) {
    reasons.push(`label/comment disagreement: ${ADVISORY_LABELS.ACCEPTED} and ${ADVISORY_LABELS.CHANGES} are both set`);
  } else if (accepted && parsed !== ADVISORY_OUTCOMES.ACCEPT) {
    reasons.push(`label/comment disagreement: ${ADVISORY_LABELS.ACCEPTED} is set but ${parsedText}`);
  } else if (changes && parsed !== ADVISORY_OUTCOMES.CHANGES) {
    reasons.push(`label/comment disagreement: ${ADVISORY_LABELS.CHANGES} is set but ${parsedText}`);
  } else if (!accepted && parsed === ADVISORY_OUTCOMES.ACCEPT) {
    reasons.push(`label/comment disagreement: ${parsedText} but ${ADVISORY_LABELS.ACCEPTED} is absent`);
  }

  const checks = (pr.statusCheckRollup ?? []).filter((check) => check.name !== 'review-gate');
  const pending = checks.filter((check) => check.status !== 'COMPLETED');
  const failing = checks.filter((check) => check.status === 'COMPLETED'
    && !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(check.conclusion));
  const names = (entries) => entries.map((check) => check.name || check.context || 'unnamed check').join(', ');
  if (failing.length) reasons.push(`CI failing: ${names(failing)}`);
  if (pending.length) reasons.push(`CI pending: ${names(pending)}`);
  if (hasLabel(pr, 'ci:failed')) reasons.push('ci:failed label');

  if (pr.mergeable === 'CONFLICTING' || hasLabel(pr, 'merge-status:conflicting')) {
    reasons.push('conflicts with base');
  }
  const mergeabilityUnknown = pr.mergeable !== 'MERGEABLE' && pr.mergeable !== 'CONFLICTING';
  const transient = mergeabilityUnknown && reasons.length === 0;
  return { ready: reasons.length === 0 && !mergeabilityUnknown, reasons, transient };
}

/**
 * Build the STUCK — INSPECTED row for a PR the stuck-PR watch (epic #3383) has already dispatched at least one
 * diagnosis-only inspection agent for, or `null` for a PR carrying no such marker. Pure — reuses
 * {@link stuckDispatchEpisodes} (`we:scripts/conveyor/stuck-pr-watch-core.mjs`) rather than re-deriving the
 * marker match, mirroring {@link standDownRow}'s own "read the same durable marker the watch itself reads"
 * shape. The MOST RECENT episode is what's surfaced when a PR has been inspected more than once.
 * @param {string} repo
 * @param {{number:number, title:string, comments?: unknown}} pr
 * @returns {{repo:string, number:number, title:string, episodes:number, lastEpisode:string}|null}
 */
export function stuckInspectedRow(repo, pr) {
  const episodes = stuckDispatchEpisodes(pr.comments);
  if (!episodes.length) return null;
  return { repo, number: pr.number, title: pr.title, episodes: episodes.length, lastEpisode: episodes[episodes.length - 1] };
}

/**
 * Build the STOOD DOWN row for a PR that carries at least one stand-down comment, or `null` for a PR that carries
 * none. Pure — reuses {@link countStandDownComments}/{@link standDownComments}/{@link standDownReason} rather than
 * re-deriving the leading-line marker match; this function only shapes the ones that already matched.
 *
 * When a PR has stood down more than once (cleared, then stood down again), the MOST RECENT comment is what's
 * surfaced — same "most recent wins" convention `latestAdvisory` uses, sorted by `createdAt` (ties keep array
 * order) rather than assuming `gh` always returns comments oldest-first.
 * @param {string} repo
 * @param {{number:number, title:string, comments?: unknown, labels?: Array<{name:string}>}} pr
 * @returns {{repo:string, number:number, title:string, standDownAt: ?string, reason: ?string, alsoReviewHuman: boolean}|null}
 */
export function standDownRow(repo, pr) {
  const matches = standDownComments(pr.comments);
  if (!matches.length) return null;
  const latest = matches
    .map((c, index) => ({ ...c, time: Date.parse(c.createdAt) || 0, index }))
    .sort((a, b) => b.time - a.time || b.index - a.index)[0];
  return {
    repo,
    number: pr.number,
    title: pr.title,
    standDownAt: latest.createdAt,
    reason: standDownReason(latest.body),
    alsoReviewHuman: hasLabel(pr, 'review:human'),
  };
}

/**
 * #3383 — LANE RECLAIM, best-effort. `lane-whois.mjs` (a SEPARATE module — see that file's own header) is
 * the read-only per-lane report over the WE lane pool; this shells out to its `--json` output rather than
 * statically importing it, so a host/checkout with no lane pool at all (or a copy of this file staged without
 * that sibling, as `operator-queue-entry.test.mjs` does) degrades to an EMPTY queue instead of failing this
 * whole report. Only `finished-needs-review` / `unknown-work` lanes are worth the operator's time — an
 * `in-use` or `finished-reclaimable` lane needs no decision at all (the latter's dry-run reclaim plan is
 * `lane-whois.mjs`'s own concern, never actioned here).
 */
export function laneReclaimQueue({ exec = execFileSync, scriptDir = dirname(fileURLToPath(import.meta.url)) } = {}) {
  try {
    const script = join(scriptDir, '..', 'lane-whois.mjs');
    // A full-pool scan is genuinely slow — one `git` read (or more) per lane, times every lane in the pool,
    // plus a `gh pr search` per distinct guessed card — 9+ minutes measured live against the real ~65-lane WE
    // pool under normal host contention. A short timeout here silently degrades every run to "[]" long before
    // that, which is worse than just being slow: it reads as "nothing needs a decision" instead of "unknown".
    const out = exec('node', [script, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20 * 60_000 });
    const report = JSON.parse(out);
    return (report.lanes || [])
      .filter((row) => row.exists && (row.verdict === 'finished-needs-review' || row.verdict === 'unknown-work'))
      .map((row) => ({ lane: row.lane, path: row.path, verdict: row.verdict, reason: row.reason }));
  } catch {
    return []; // no pool on this host, no gh/claude available, or the sibling module isn't staged — never fail the PR queue over this
  }
}

/** Blocking sleep — `main` is synchronous, and this only runs on the rare UNKNOWN-mergeability path. */
const blockingSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Re-poll one PR's mergeability until GitHub reports a definite answer or the attempts run out. GitHub computes
 * `mergeable` on request, so the answer usually arrives on the first or second poll. A failed poll counts as
 * "still unknown" — it must never turn a transient state into a hard failure.
 * @returns {string} the last `mergeable` value seen (`UNKNOWN` if it never settled).
 */
export function pollMergeable({
  repo, number, exec = execFileSync, sleep = blockingSleep,
  attempts = MERGEABLE_POLL_ATTEMPTS, delayMs = MERGEABLE_POLL_DELAY_MS,
}) {
  let mergeable = 'UNKNOWN';
  for (let attempt = 0; attempt < attempts && mergeable === 'UNKNOWN'; attempt += 1) {
    sleep(delayMs * 2 ** attempt);
    try {
      const out = exec('gh', ['pr', 'view', String(number), '--repo', repo, '--json', 'mergeable'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      mergeable = JSON.parse(out).mergeable || 'UNKNOWN';
    } catch { /* transient — keep the last known value and try again */ }
  }
  return mergeable;
}

export function main(args = process.argv.slice(2), { sleep, pollAttempts, pollDelayMs, unsupportedPath } = {}) {
  const requested = args.filter((arg) => arg.startsWith('--repo=')).map((arg) => arg.slice(7));
  const unsupported = readUnsupported({ path: unsupportedPath }).filter(
    (row) => !requested.length || requested.some((repo) => repoKeyForSlug(repo) === row.repo),
  );
  // #3383 — LANE RECLAIM is opt-in via `--with-lanes` (a real `node`+`lane-whois.mjs` subprocess call, best-
  // effort): a bare `main()` call must stay side-effect-free over the PR queue's own `execFileSync('gh', …)`
  // sequence — several existing tests replace the WHOLE `node:child_process` module with one shared mock
  // queued per expected gh call, and an unconditional extra call here would silently consume one of those
  // slots and cascade-fail every assertion after it. Real operator usage passes the flag explicitly.
  const laneDecisions = args.includes('--with-lanes') ? laneReclaimQueue() : [];
  const report = { ready: [], pending: [], notReady: [], stoodDown: [], stuck: [], errors: [], unsupported, laneDecisions };
  for (const repo of requested.length ? requested : Object.values(CONSTELLATION_REPOS).map(({ slug }) => slug)) {
    try {
      const prs = JSON.parse(execFileSync('gh', [
        'pr', 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json',
        'number,title,labels,headRefOid,mergeable,statusCheckRollup,comments',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
      const readyNumbersThisRepo = new Set();
      for (const listed of prs.filter((candidate) => hasLabel(candidate, 'review:human'))) {
        let pr = listed;
        let result = evaluatePr(pr);
        // Only a PR that would otherwise be ready is worth re-polling — one with a real failure is not-ready
        // whatever GitHub says about mergeability.
        if (result.transient) {
          pr = { ...pr, mergeable: pollMergeable({
            repo, number: pr.number, sleep, attempts: pollAttempts, delayMs: pollDelayMs,
          }) };
          result = evaluatePr(pr);
        }
        const row = { repo, number: pr.number, title: pr.title };
        if (result.ready) {
          report.ready.push(row);
          readyNumbersThisRepo.add(pr.number);
        } else if (result.transient) report.pending.push(row);
        else report.notReady.push({ ...row, reasons: result.reasons });
      }
      // STOOD DOWN — every OPEN PR (any labels) carrying a stand-down comment, minus anything already in NEEDS
      // YOU above. `countStandDownComments` is the reused, single-sourced gate for "does this PR qualify at all".
      for (const pr of prs) {
        if (readyNumbersThisRepo.has(pr.number)) continue;
        if (countStandDownComments(pr.comments) === 0) continue;
        report.stoodDown.push(standDownRow(repo, pr));
      }
      // STUCK — INSPECTED (epic #3383's stuck-PR watch): every open PR the watch has already dispatched a
      // diagnosis-only inspection agent for — this costs no extra `gh` call, since `comments` already rode the
      // ONE listing fetched above. Same "minus anything already in NEEDS YOU" narrowing as STOOD DOWN.
      for (const pr of prs) {
        if (readyNumbersThisRepo.has(pr.number)) continue;
        const row = stuckInspectedRow(repo, pr);
        if (row) report.stuck.push(row);
      }
    } catch (error) {
      const detail = String(error.stderr || error.message).trim().replace(/\s+/g, ' ');
      report.errors.push(`${repo}: ${detail}`);
    }
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const error of report.errors) console.error(`ERROR ${error}`);
    console.log('NEEDS YOU (review:human + advisory:accepted, all gates pass):');
    console.log(report.ready.map((pr) => `${pr.repo}#${pr.number}  ${pr.title}`).join('\n') || '(none)');
    console.log('PENDING — transient, re-run (GitHub is still computing mergeability; no agent work owed):');
    console.log(report.pending.map((pr) => `${pr.repo}#${pr.number}  ${pr.title}`).join('\n') || '(none)');
    console.log('UNSUPPORTED REPO — owed work the conveyor cannot dispatch for this repo:');
    console.log(report.unsupported.map((row) => `${row.repo}#${row.prNumber}  ${row.action}  ${row.why}`).join('\n') || '(none)');
    console.log('NOT READY — agent work (review:human but gates fail):');
    console.log(report.notReady.map((pr) => `${pr.repo}#${pr.number}  ${pr.reasons.join('; ')}`).join('\n') || '(none)');
    console.log('STOOD DOWN — needs your judgment (a fix agent asked a question; no label changed):');
    console.log(report.stoodDown.map((pr) => `${pr.repo}#${pr.number}  ${pr.title}  `
      + `[stood down ${pr.standDownAt || 'time unknown'}] ${pr.reason || '(no reason recorded)'}`
      + (pr.alsoReviewHuman ? '  [also review:human]' : '')).join('\n') || '(none)');
    console.log('STUCK — inspected (epic #3383 dispatched a diagnosis-only agent; read its comment):');
    console.log(report.stuck.map((pr) => `${pr.repo}#${pr.number}  ${pr.title}  `
      + `[${pr.episodes} episode${pr.episodes === 1 ? '' : 's'}, last ${pr.lastEpisode}]`).join('\n') || '(none)');
    console.log('LANE RECLAIM — needs your decision (#3383, see `node scripts/lane-whois.mjs`):');
    console.log(report.laneDecisions.map((d) => `lane-${d.lane}  [${d.verdict}]  ${d.reason}  ${d.path}`).join('\n') || '(none)');
  }
}

/** True when this module is the CLI entry, even if argv[1] was typed via a symlink or a doubled slash (`$TMPDIR//x`). */
export function isCliEntry(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false;
  let resolved = argv1;
  try { resolved = realpathSync(argv1); } catch { /* not on disk — compare the raw spelling */ }
  return moduleUrl === pathToFileURL(resolved).href;
}

if (isCliEntry()) main();
