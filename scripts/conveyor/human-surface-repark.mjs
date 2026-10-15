#!/usr/bin/env node
/** Re-park stale acceptances on human-only surfaces. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sensitiveSurfaceHits, resolveHumanReviewSurfaces } from '../lib/human-review-surfaces.mjs';
import { REVIEW_LABELS, hasReviewLabel, parseLatestHumanClearedSha, decideParkToHuman } from '../lib/review-escalation.mjs';
import { createGhProvider } from '../lib/review-label-provider.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { writeAllSync, writeLineSync } from '../lib/write-all-sync.mjs';
import { defaultListPrs } from './advisory-label-sweep.mjs';
import { LIST_COMMENTS_PAGE_SIZE, readCompletePrComments } from './pr-comments-complete.mjs';

const candidate = labels => hasReviewLabel(labels, REVIEW_LABELS.accepted)
  && !hasReviewLabel(labels, REVIEW_LABELS.human) && !hasReviewLabel(labels, REVIEW_LABELS.heldMechanical);
// A marked park can sit beside `review:accepted` (a racing clear-human re-adds it); never beside a bounce or mechanical hold.
const healCandidate = labels => hasReviewLabel(labels, REVIEW_LABELS.human)
  && !hasReviewLabel(labels, REVIEW_LABELS.changes) && !hasReviewLabel(labels, REVIEW_LABELS.heldMechanical);
const errorText = e => String(e?.message ?? e).split('\n')[0];
const sameSha = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

/**
 * PR #5273 — the machine-readable marker in this sweep's park comment, so a later reader can tell this park from
 * another. The SAME pattern is duplicated in review-set-label.mjs#HUMAN_SURFACE_REPARK_RE (clear-human must not
 * import this module's daemon graph); the tests pin the two together.
 */
export const buildHumanSurfaceReparkMarker = headSha => `<!-- human-surface-repark: ${String(headSha).toLowerCase()} -->`;
export function hasHumanSurfaceReparkMarker(comments, headSha) {
  const want = buildHumanSurfaceReparkMarker(headSha);
  return (Array.isArray(comments) ? comments : [])
    .some(c => isTrustedMarkerAuthor(c) && typeof c?.body === 'string' && c.body.toLowerCase().includes(want));
}
// Both automatic read-then-write parks: this sweep's, and review-set-label.mjs's mechanical-hold hand-off.
const PARK_MARKER_RE = /<!-- (?:human-surface-repark|mechanical-hold-handoff): ([0-9a-f]{40}) -->/gi;
const PARK_MARKER_HINT = /human-surface-repark:|mechanical-hold-handoff:/i;
const marksPark = (c, head) => typeof c?.body === 'string' && [...c.body.matchAll(PARK_MARKER_RE)].some(m => sameSha(m[1], head));

/**
 * PR #5273 — proof, from the complete thread alone, that `review:human` at `head` is a marked park that lost a race
 * with a clear-human of the same head: the latest clearance names `head`, a marked park of `head` exists, and the
 * last trusted comment is one of those two. Any later trusted comment (a rearm, a verdict, a hold) may have put
 * `review:human` back for its own reason, so the proof fails and the hold stays.
 */
export function raceLostParkProven(comments, head) {
  const trusted = (Array.isArray(comments) ? comments : []).filter(isTrustedMarkerAuthor);
  if (!trusted.length || !sameSha(parseLatestHumanClearedSha(trusted), head)) return false;
  const last = trusted.at(-1);
  const clearsHead = c => sameSha(parseLatestHumanClearedSha([c]), head);
  if (!marksPark(last, head) && !clearsHead(last)) return false;
  return trusted.some(c => marksPark(c, head)) && trusted.some(clearsHead);
}
const commentKey = c => c?.id ?? JSON.stringify([c?.body, c?.createdAt, c?.author?.login]);

/** Pure decision over a live head and its complete comment thread. */
export function planHumanSurfaceRepark({ currentLabels = [], files = [], headSha, comments = [], surfaces = 'narrow' } = {}) {
  if (!candidate(currentLabels)) return { repark: false, reason: 'not an accepted PR without a hold' };
  const hits = sensitiveSurfaceHits(files, () => undefined, surfaces).filter(hit => hit.category !== 'permission');
  if (!hits.length) return { repark: false, reason: 'no human-only surface' };
  const cleared = parseLatestHumanClearedSha(comments);
  if (cleared) {
    return { repark: false, reason: cleared.toLowerCase() === String(headSha).toLowerCase()
      ? 'human clearance at the live head'
      : 'older human clearance — left to the accept carry-forward / drain' };
  }
  return { repark: true, hits, decision: decideParkToHuman({ currentLabels, keepHumanClearance: false }) };
}

export function buildHumanSurfaceReparkComment({ headSha, hits }) {
  return `Human-only surface at head ${headSha.slice(0, 9)} (\`${headSha}\`):\n\n`
    + hits.map(hit => `- \`${hit.file}\` (${hit.category})`).join('\n')
    + '\n\nThe prior `review:accepted` is stale for a human-only surface. Re-parked to `review:human`; the operator clears it with `review-set-label.mjs --to=clear-human`.\n'
    + `\n${buildHumanSurfaceReparkMarker(headSha)}\n`;
}

export function sweepHumanSurfaceRepark({
  repo = null, listPrs = defaultListPrs, provider = createGhProvider(),
  readComments = readCompletePrComments, resolveSurfaces = resolveHumanReviewSurfaces, dryRun = false,
} = {}) {
  const results = [];
  let resolvedRepo = repo;
  const prs = listPrs({ repo }) ?? [];
  if (prs.some(pr => healCandidate(pr.labels))) {
    try {
      resolvedRepo ??= provider.currentRepo();
      if (resolvedRepo) healRaceLostParks({ prs, provider, repo: resolvedRepo, readComments, dryRun, results });
    } catch (e) {
      results.push({ num: 0, skipped: `heal failed: ${errorText(e)}` });
    }
  }
  for (const pr of prs) {
    if (!candidate(pr.labels)) continue;
    const num = pr.number;
    let state, files, comments, surfaces;
    try {
      resolvedRepo ??= provider.currentRepo();
      if (!resolvedRepo) throw new Error('missing repository');
      state = provider.readPrState(resolvedRepo, num);
      if (state.state !== 'OPEN') throw new Error('PR is not open');
      if (!state.headRefOid) throw new Error('missing head');
      files = provider.readPrFiles(resolvedRepo, num);
      if (!Array.isArray(files)) throw new Error('files read returned no array');
      comments = readComments(num, { repo: resolvedRepo });
      if (!Array.isArray(comments)) throw new Error('comments read returned no array');
      const fresh = provider.readPrState(resolvedRepo, num);
      if (fresh.headRefOid !== state.headRefOid) {
        results.push({ num, skipped: 'head moved during read' });
        continue;
      }
      state = fresh;
      if (state.state !== 'OPEN') throw new Error('PR is not open');
      if (!Array.isArray(state.labels)) throw new Error('labels read returned no array');
      // A full fresh page can hide a clearance posted or edited after the complete read.
      // Skip rather than re-park using that stale snapshot, even at exactly the page size.
      if (Array.isArray(state.comments) && state.comments.length >= LIST_COMMENTS_PAGE_SIZE) {
        results.push({ num, skipped: 'fresh comments may be truncated' });
        continue;
      }
      // Keep the complete thread's order. Update known comments in place and append new ceremonies.
      const observedComments = new Map(comments.map(c => [commentKey(c), c]));
      for (const c of Array.isArray(state.comments) ? state.comments : []) observedComments.set(commentKey(c), c);
      comments = [...observedComments.values()];
      surfaces = resolveSurfaces();
    } catch (e) {
      results.push({ num, skipped: `live re-read failed: ${errorText(e)}` });
      continue;
    }
    const plan = planHumanSurfaceRepark({ currentLabels: state.labels, files, headSha: state.headRefOid, comments, surfaces });
    if (!plan.repark) continue;
    const entry = { num, repark: dryRun ? 'would-repark' : 'reparked', head: state.headRefOid, files: [...new Set(plan.hits.map(hit => hit.file))] };
    if (!dryRun) {
      try {
        provider.postComment(resolvedRepo, num, buildHumanSurfaceReparkComment({ headSha: state.headRefOid, hits: plan.hits }));
        provider.setLabels(resolvedRepo, num, { add: plan.decision.addLabel,
          remove: plan.decision.removeLabels.filter(label => hasReviewLabel(state.labels, label)) });
      } catch (e) { entry.error = errorText(e); }
      // PR #5273: GitHub has no conditional label write, so a clear-human ceremony can land between the final read
      // and this write. Write first, then read for the other writer's effect (clear-human does the mirror image).
      if (!entry.error) {
        try {
          if (withdrawRaceLostPark({ provider, repo: resolvedRepo, num, head: state.headRefOid, readComments })) {
            Object.assign(entry, { repark: 'withdrawn', reason: 'human clearance at the live head landed during the write' });
          }
        } catch (e) {
          // The hold stays for now. The heal pass below withdraws it on a later sweep.
          entry.error = `post-write clearance check failed: ${errorText(e)}`;
        }
      }
    }
    results.push(entry);
  }
  return results;
}

/**
 * PR #5273: withdraw this sweep's own park when a trusted clearance names the live head. The sweep never parks over
 * such a clearance, so the pair can only come from a race. Reads the complete thread, then the labels and head.
 * Leaves a moved head, a `review:changes` bounce or a mechanical hold alone. Returns whether it withdrew.
 */
function withdrawRaceLostPark({ provider, repo, num, head, readComments, requireMarker = false, dryRun = false }) {
  const after = readComments(num, { repo });
  if (!Array.isArray(after)) throw new Error('comments read returned no array');
  const live = provider.readPrState(repo, num);
  if (!Array.isArray(live?.labels)) throw new Error('labels read returned no array');
  if (!sameSha(live.headRefOid, head) || !sameSha(parseLatestHumanClearedSha(after), head)) return false;
  if (hasReviewLabel(live.labels, REVIEW_LABELS.changes) || hasReviewLabel(live.labels, REVIEW_LABELS.heldMechanical)) return false;
  // Right after its own write the sweep knows the park is its own; a later heal must prove it from the thread.
  if (requireMarker && !raceLostParkProven(after, head)) return false;
  // Neither label: something else took the acceptance away. Never create one.
  if (!hasReviewLabel(live.labels, REVIEW_LABELS.human)) return hasReviewLabel(live.labels, REVIEW_LABELS.accepted);
  if (dryRun) return true;
  provider.setLabels(repo, num, { add: REVIEW_LABELS.accepted, remove: [REVIEW_LABELS.human] });
  return true;
}

/**
 * Heal a marked park left behind when no post-write check caught the race: a crash, or a failed read, on the
 * sweep, the mechanical-hold hand-off or clear-human. Acts only on {@link raceLostParkProven}. The listed (oldest)
 * comments pre-filter: a short listed thread with no park marker is never read in full.
 */
function healRaceLostParks({ prs, provider, repo, readComments, dryRun, results }) {
  for (const pr of prs) {
    if (!healCandidate(pr.labels)) continue;
    if (Array.isArray(pr.comments) && pr.comments.length < LIST_COMMENTS_PAGE_SIZE
      && !pr.comments.some(c => PARK_MARKER_HINT.test(String(c?.body ?? '')))) continue;
    const num = pr.number;
    try {
      const state = provider.readPrState(repo, num);
      if (state?.state !== 'OPEN' || !state.headRefOid || !healCandidate(state.labels)) continue;
      if (withdrawRaceLostPark({ provider, repo, num, head: state.headRefOid, readComments, requireMarker: true, dryRun })) {
        results.push(dryRun ? { num, repark: 'would-withdraw', head: state.headRefOid }
          : { num, repark: 'withdrawn', head: state.headRefOid, reason: 'healed a park that lost a race with a human clearance' });
      }
    } catch (e) {
      results.push({ num, skipped: `heal read failed: ${errorText(e)}` });
    }
  }
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const argv = process.argv.slice(2);
  const verb = argv.find(arg => !arg.startsWith('--')) || 'sweep';
  if (verb !== 'sweep') {
    writeLineSync(2, 'usage: human-surface-repark.mjs sweep [--repo=<owner/name>] [--dry-run]');
    process.exitCode = 2;
  } else {
    try {
      const repo = argv.find(arg => arg.startsWith('--repo='))?.slice(7) || null;
      writeAllSync(1, `${JSON.stringify(sweepHumanSurfaceRepark({ repo, dryRun: argv.includes('--dry-run') }))}\n`);
    } catch (e) {
      writeLineSync(2, `error: ${errorText(e)}`);
      process.exitCode = 1;
    }
  }
}
