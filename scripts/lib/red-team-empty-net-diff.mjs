import { execFileSync } from 'node:child_process';

/** Positive, head-bound proof only: missing diff evidence never grants an exemption. */
export function provenEmptyNetDiff(read, head = read?.netBasis?.rev) {
  return typeof head === 'string' && /^[a-f0-9]{40}$/i.test(head)
    && read?.netBasis?.rev === head && read.netBasis.scored === true && read.diffScored === true
    && Array.isArray(read.netChangedFiles) && read.netChangedFiles.length === 0
    && typeof read.diffText === 'string' && read.diffText === '';
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
    && provenEmptyNetDiff(status.loopPayload?.findings?.read, head);
}

/** Re-read the stored range, never a live head ref. Unknown or oversized output retains the hold. */
export function verifyEmptyNetDiff(read, head, { exec = execFileSync, cwd } = {}) {
  if (!provenEmptyNetDiff(read, head) || typeof read.netBasis.base !== 'string' || !read.netBasis.base) return false;
  try {
    return exec('git', ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=none', '--name-only', '-z',
      '--end-of-options', `${read.netBasis.base}..${head}`, '--'],
    { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 }) === '';
  } catch { return false; }
}

/** Compare complete binary net patches against main. Unknown, empty or oversized patches never carry a result. */
export function proveEquivalentRedTeamDiff({ fromSha, toSha, mainRef = 'origin/main', exec = execFileSync, cwd } = {}) {
  const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
  if (!sha(fromSha) || !sha(toSha) || fromSha === toSha) return { ok: false };
  const git = (args, input) => {
    const out = exec('git', args, { cwd, input, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    if (typeof out !== 'string' || Buffer.byteLength(out) > 1024 * 1024) throw Error('net patch unreadable or oversized');
    return out;
  };
  try {
    const patch = head => {
      const base = git(['merge-base', mainRef, head]).trim();
      if (!sha(base)) throw Error('net base unreadable');
      return git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=none', '--binary',
        '--end-of-options', `${base}..${head}`, '--']);
    };
    const before = patch(fromSha), after = patch(toSha);
    if (!before || before !== after) return { ok: false };
    const patchId = git(['patch-id', '--verbatim'], before).trim().split(/\s+/)[0];
    return sha(patchId) ? { ok: true, patchId } : { ok: false };
  } catch { return { ok: false }; }
}
