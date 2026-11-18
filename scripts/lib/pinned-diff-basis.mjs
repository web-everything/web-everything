import { hardenedGitRead, hardenedGitDiff } from './hardened-git-diff.mjs';

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
export function isPinnedDiffBasis(basis) {
  return basis?.ok === true && ['baseSha', 'headSha', 'mergeBaseSha'].every(key => SHA.test(basis[key] ?? ''));
}
export function stampDiffBasis(basis) {
  return { baseSha: basis?.baseSha ?? null, headSha: basis?.headSha ?? null, mergeBaseSha: basis?.mergeBaseSha ?? null };
}
export function sameDiffBasis(a, b) {
  return isPinnedDiffBasis({ ...a, ok: true }) && isPinnedDiffBasis({ ...b, ok: true }) &&
    ['baseSha', 'headSha', 'mergeBaseSha'].every(key => a[key] === b[key]);
}

/** The sole network/identity boundary for scored net diffs. No mutable names escape. */
export function resolvePinnedDiffBasis({ exec, remote = 'origin', baseRef = 'main', headSha } = {}) {
  const fail = reason => ({ ok: false, reason });
  if (typeof exec !== 'function' || !SHA.test(headSha ?? '') ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote) ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(baseRef)) return fail('ref-unresolved');
  const read = args => String(hardenedGitRead(exec, args) ?? '').trim().toLowerCase();
  const commit = ref => read(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  try {
    hardenedGitRead(exec, ['fetch', '--quiet', '--end-of-options', remote,
      `+refs/heads/${baseRef}:refs/remotes/${remote}/${baseRef}`, headSha]);
  } catch (error) { return fail(error instanceof TypeError ? 'exec-contract' : 'base-fetch-failed'); }
  try {
    const baseSha = commit(`refs/remotes/${remote}/${baseRef}`);
    if (!SHA.test(baseSha)) return fail('ref-unresolved');
    let fetched;
    try { fetched = commit('FETCH_HEAD'); }
    catch { return fail('base-fetch-failed'); }
    if (fetched !== baseSha) return fail('base-fetch-failed');
    const resolvedHead = commit(headSha);
    if (resolvedHead !== headSha.toLowerCase()) return fail('head-mismatch');
    let mergeBaseSha, numstat;
    try {
      mergeBaseSha = read(['merge-base', '--end-of-options', baseSha, resolvedHead]).split('\n')[0];
      if (!SHA.test(mergeBaseSha)) return fail('diff-failed');
      numstat = String(hardenedGitDiff(exec, ['diff', '--numstat', '--end-of-options', mergeBaseSha, resolvedHead]));
    } catch (error) { return fail(error instanceof TypeError ? 'exec-contract' : 'diff-failed'); }
    if (!SHA.test(mergeBaseSha)) return fail('diff-failed');
    return { ok: true, baseSha, headSha: resolvedHead, mergeBaseSha, numstat };
  } catch (error) { return fail(error instanceof TypeError ? 'exec-contract' : 'ref-unresolved'); }
}
