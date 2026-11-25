/** Forge-backed equivalent of computeNetDiffSignals; unreadable evidence never becomes an empty scored diff. */
import { readCompareNetDiff, isPermanentReadReason } from './drain-api-reads.mjs';
import { diffHunksFrom } from './review-escalation.mjs';

export function forgeNetDiffSignals({ repo, headSha, allowedRepos, read = readCompareNetDiff, env, baseRef = 'main' } = {}) {
  const failed = (reason) => ({
    changedFiles: [], humanBasisFiles: [], diffLines: 0, cumulativeDiffLines: 0,
    basisKind: null, basisNarrowed: false, scored: false, diffHunks: null,
    netDiffText: { text: '', base: null, rev: null, scored: false, reason: `forge-${reason}`, transient: !isPermanentReadReason(reason) },
  });
  // A stacked PR's own delta is not the compare against main; never score the cumulative diff in its place.
  if (baseRef !== 'main') return failed('stacked-base');
  try {
    const r = read(repo, headSha, { allowedRepos, env });
    if (r?.ok !== true) return failed(r?.reason || 'source-error');
    const { text, mergeBase, baseTip, changedFiles, diffLines } = r.value;
    if (typeof text !== 'string' || !/^[0-9a-f]{40}$/i.test(mergeBase ?? '') || !/^[0-9a-f]{40}$/i.test(baseTip ?? '') || r.value.headSha !== headSha || !Array.isArray(changedFiles) || !changedFiles.every(p => typeof p === 'string') || !Number.isSafeInteger(diffLines) || diffLines < 0) return failed('source-error');
    const netDiffText = { text, base: mergeBase, rev: headSha, revSha: headSha, scored: true, source: 'forge', baseTip };
    return { changedFiles, humanBasisFiles: changedFiles, diffLines, cumulativeDiffLines: diffLines,
      basisKind: 'merge-base', basisNarrowed: true, scored: true, netDiffText, diffHunks: diffHunksFrom(netDiffText) };
  } catch { return failed('source-error'); }
}

/** Stable per cause/head: repeated drain passes do not create repeated reason comments. */
export function describeUnverifiedNetDiff({ repo, headSha, reason = 'unscored', transient } = {}) {
  const prefix = `net diff unverified (${reason}); `;
  if (!reason.startsWith('forge-')) return prefix + 'restore diff access and rerun the drain, or obtain human review of the full diff';
  if (reason === 'forge-stacked-base') return prefix + 'stacked PR: net diff is read once its base lands. Wake: the base PR merges and this PR is retargeted to main.';
  const cause =`the forge compare read of ${repo} main...${String(headSha ?? 'unknown').slice(0, 12)} failed (${reason}); without a verified diff the anti-test-gaming scan cannot run, so the hold stays and clear-human does not override it. `;
  const wake = transient === false
    ? 'Wake: a re-read gives the same answer; split the PR so its diff is readable, or obtain human review of the full diff.'
    : 'Wake: the drain re-reads on its next pass; a new head re-arms it.';
  return prefix + cause + wake;
}
