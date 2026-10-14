#!/usr/bin/env node
/** Re-park stale acceptances on human-only surfaces. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sensitiveSurfaceHits, resolveHumanReviewSurfaces } from '../lib/human-review-surfaces.mjs';
import { REVIEW_LABELS, hasReviewLabel, parseLatestHumanClearedSha, decideParkToHuman } from '../lib/review-escalation.mjs';
import { createGhProvider } from '../lib/review-label-provider.mjs';
import { writeAllSync, writeLineSync } from '../lib/write-all-sync.mjs';
import { defaultListPrs } from './advisory-label-sweep.mjs';
import { LIST_COMMENTS_PAGE_SIZE, readCompletePrComments } from './pr-comments-complete.mjs';

const candidate = labels => hasReviewLabel(labels, REVIEW_LABELS.accepted)
  && !hasReviewLabel(labels, REVIEW_LABELS.human) && !hasReviewLabel(labels, REVIEW_LABELS.heldMechanical);
const errorText = e => String(e?.message ?? e).split('\n')[0];
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
    + '\n\nThe prior `review:accepted` is stale for a human-only surface. Re-parked to `review:human`; the operator clears it with `review-set-label.mjs --to=clear-human`.\n';
}

export function sweepHumanSurfaceRepark({
  repo = null, listPrs = defaultListPrs, provider = createGhProvider(),
  readComments = readCompletePrComments, resolveSurfaces = resolveHumanReviewSurfaces, dryRun = false,
} = {}) {
  const results = [];
  let resolvedRepo = repo;
  for (const pr of listPrs({ repo }) ?? []) {
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
          const after = readComments(num, { repo: resolvedRepo });
          if (!Array.isArray(after)) throw new Error('comments read returned no array');
          const cleared = parseLatestHumanClearedSha(after);
          if (cleared && cleared.toLowerCase() === String(state.headRefOid).toLowerCase()) {
            provider.setLabels(resolvedRepo, num, { add: REVIEW_LABELS.accepted, remove: [REVIEW_LABELS.human] });
            Object.assign(entry, { repark: 'withdrawn', reason: 'human clearance at the live head landed during the write' });
          }
        } catch (e) {
          // Fail closed: the hold stays and the operator can clear it again.
          entry.error = `post-write clearance check failed: ${errorText(e)}`;
        }
      }
    }
    results.push(entry);
  }
  return results;
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
