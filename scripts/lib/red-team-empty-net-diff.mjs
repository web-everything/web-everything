import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { MissingStoreError, readStore, resolveScorecardStorePath } from '../conveyor/run-scorecard-store.mjs';

export const EMPTY_NET_DIFF_SKIP = Object.freeze({ status: 'skipped', policy: 'empty-net-diff',
  reason: 'red team skipped: empty net diff' });

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
const refused = reason => ({ exempt: false, reason });

/**
 * The ONLY empty-net-diff exemption decision. Callers must supply the subject checkout and
 * the prior read/skip record, never a boolean claiming the records were readable. Read the actual
 * store in strict mode, distinguishing missing history from a present-empty store. Unknown evidence keeps the red team owed;
 * operators must inspect stored evidence (including oversized Git output) before retrying.
 */
export function emptyDiffExemptionEvidence({ repo, pr, head, seatRecord, loopPayload = seatRecord?.loopPayload,
  read = loopPayload?.findings?.read, requireSkip = false, env = process.env,
  storePath = resolveScorecardStorePath(env), readFile = readFileSync, cwd, exec = execFileSync } = {}) {
  let store;
  try {
    store = readStore({ path: storePath, strict: true, read: path => readFile(path, 'utf8') });
  } catch (error) {
    return refused(error instanceof MissingStoreError ? 'store-missing'
      : error?.message === 'scorecard store malformed' ? 'store-unparseable' : 'store-unreadable');
  }
  if (typeof repo !== 'string' || !repo || !Number.isSafeInteger(Number(pr)) || Number(pr) <= 0
    || !sha(head) || !store.records.some(row => row?.dispatchKind === 'review-seat'
      && typeof row.seat === 'string' && row.seat.length > 0 && row.repo === repo
      && ['number', 'string'].includes(typeof row.pr) && Number(row.pr) === Number(pr) && row.rev === head)) return refused('seat-record-missing');
  if (seatRecord && seatRecord.head !== head) return refused('seat-record-mismatch');
  if (requireSkip) {
    const result = seatRecord?.result;
    if (seatRecord?.status !== 'finished'
      || (typeof result === 'string' ? result : result?.status) !== 'skipped'
      || (result?.policy && result.policy !== EMPTY_NET_DIFF_SKIP.policy)
      || result?.deferredByGuard || result?.deferredByCap) return refused('skip-record-invalid');
  }
  if ((loopPayload?.carriedFrom != null && loopPayload.carriedFrom !== head)
    || read?.netBasis?.rev !== head || read.netBasis.scored !== true || read.diffScored !== true
    || !Array.isArray(read.netChangedFiles) || read.netChangedFiles.length !== 0
    || read.diffText !== '') return refused('read-unproven');
  if (typeof cwd !== 'string' || !cwd.trim()) return refused('cwd-missing');
  if (typeof read.netBasis.base !== 'string' || !read.netBasis.base) return refused('base-unresolvable');
  const git = args => {
    const output = exec('git', ['--no-replace-objects', ...args],
      { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } });
    if (typeof output !== 'string' || Buffer.byteLength(output) > 1024 * 1024) throw Error('unreadable Git output');
    return output;
  };
  let base, recomputed;
  try {
    base = git(['rev-parse', '--verify', '--end-of-options', `${read.netBasis.base}^{commit}`]).trim();
    recomputed = git(['merge-base', '--all', '--end-of-options', 'origin/main', head]).trim().split('\n');
  } catch { return refused('base-unresolvable'); }
  if (!sha(base) || !recomputed.every(sha)) return refused('base-unresolvable');
  base = base.toLowerCase();
  recomputed = recomputed.map(value => value.toLowerCase());
  const ambiguous = recomputed.length > 1;
  if (base === head.toLowerCase() || !recomputed.includes(base))
    return refused(ambiguous ? 'base-ambiguous' : 'base-mismatch');
  try {
    // Probe the stored base first, then every other valid base: one empty range is insufficient.
    for (const candidate of [base, ...recomputed.filter(value => value !== base)]) {
      if (git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=none', '--name-only', '-z',
        '--end-of-options', `${candidate}..${head}`, '--']) !== '')
        return refused(ambiguous ? 'diff-nonempty-vs-base' : 'diff-nonempty');
    }
  } catch { return refused('diff-unreadable'); }
  return { exempt: true, reason: 'empty-net-diff' };
}
