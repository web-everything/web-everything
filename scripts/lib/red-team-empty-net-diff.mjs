import { execFileSync } from 'node:child_process';

/** Positive, head-bound proof only: missing diff evidence never grants an exemption. */
export function provenEmptyNetDiff(read, head = read?.netBasis?.rev) {
  return typeof head === 'string' && /^[a-f0-9]{40}$/i.test(head)
    && read?.netBasis?.rev === head && read.netBasis.scored === true && read.diffScored === true
    && Array.isArray(read.netChangedFiles) && read.netChangedFiles.length === 0
    && typeof read.diffText === 'string' && read.diffText === '';
}

/**
 * A payload's read proves an empty diff for `head` only when it was taken on that head. A head-move carry rebinds
 * its source read's rev onto the new head but keeps the source's diff fields, so it never proves the new head empty.
 */
export function provenEmptyNetDiffPayload(loopPayload, head) {
  const from = loopPayload?.carriedFrom;
  return (from == null || from === head) && provenEmptyNetDiff(loopPayload?.findings?.read, head);
}

export const EMPTY_NET_DIFF_SKIP = Object.freeze({ status: 'skipped', policy: 'empty-net-diff',
  reason: 'red team skipped: empty net diff' });

/** Legacy skips can be recovered only from the stored read for this exact writer head. */
export function emptyNetDiffSkip(status, head = status?.head) {
  const result = status?.result;
  return status?.status === 'finished' && status.head === head
    && (typeof result === 'string' ? result : result?.status) === 'skipped'
    && (!result?.policy || result.policy === 'empty-net-diff')
    && !result?.deferredByGuard && !result?.deferredByCap
    && provenEmptyNetDiffPayload(status.loopPayload, head);
}

/** Re-read the stored range, never a live head ref. Unknown or oversized output retains the hold. */
export function verifyEmptyNetDiff(read, head, { exec = execFileSync, cwd } = {}) {
  if (!provenEmptyNetDiff(read, head) || typeof read.netBasis.base !== 'string' || !read.netBasis.base) return false;
  try {
    // Every Git read must ignore replacement objects, including resolution of the stored base.
    const git = args => exec('git', ['--no-replace-objects', ...args],
      { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    const base = git(['rev-parse', '--verify', '--end-of-options', `${read.netBasis.base}^{commit}`]).trim();
    // A replacement-aware merge-base may have recorded head itself. Even a replacement-free
    // head..head diff then says nothing about the contribution; retain the hold for inspection.
    if (!/^[a-f0-9]{40}$/i.test(base) || base.toLowerCase() === head.toLowerCase()) return false;
    return git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=none', '--name-only', '-z',
      '--end-of-options', `${base}..${head}`, '--']) === '';
  } catch { return false; }
}
