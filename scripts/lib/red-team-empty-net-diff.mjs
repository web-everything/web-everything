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
