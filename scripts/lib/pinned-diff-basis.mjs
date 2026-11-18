/** Minimal isolated Git boundary for pinned scoring evidence. */
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})(?![\s\S])/i;
export const isPinnedDiffBasis = basis => basis?.ok === true &&
  ['baseSha', 'headSha', 'mergeBaseSha'].every(key => SHA.test(basis[key] ?? ''));
export const stampDiffBasis = basis => Object.fromEntries(
  ['baseSha', 'headSha', 'mergeBaseSha'].map(key => [key, basis?.[key] ?? null]));

export function pinnedGit(exec, args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG/.test(key) || /^GIT_(DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|REPLACE_REF_BASE|SHALLOW_FILE|GRAFT_FILE|EXTERNAL_DIFF|DIFF_OPTS)$/.test(key)) delete env[key];
  }
  Object.assign(env, { GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_ATTR_NOSYSTEM: '1' });
  const diff = args[0] === 'diff' ? ['--no-textconv', '--no-ext-diff', '--no-renames', '--no-color'] : [];
  return String(exec('git', ['-c', 'core.attributesFile=/dev/null', args[0], ...diff, ...args.slice(1)], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024, env,
  }) ?? '');
}

/** Fetch the base once; retrieve the exact head separately only if absent locally. */
export function resolvePinnedDiffBasis({ exec, remote = 'origin', baseRef = 'main', headSha } = {}) {
  const fail = reason => ({ ok: false, reason });
  if (typeof exec !== 'function' || !SHA.test(headSha ?? '') ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote) ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(baseRef)) return fail('ref-unresolved');
  const read = args => pinnedGit(exec, args).trim().toLowerCase();
  const commit = ref => read(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  try {
    pinnedGit(exec, ['fetch', '--quiet', '--end-of-options', remote,
      `+refs/heads/${baseRef}:refs/remotes/${remote}/${baseRef}`]);
  } catch { return fail('base-fetch-failed'); }
  let baseSha;
  try {
    baseSha = commit(`refs/remotes/${remote}/${baseRef}`);
    if (!SHA.test(baseSha) || commit('FETCH_HEAD') !== baseSha) return fail('base-fetch-failed');
  } catch { return fail('base-fetch-failed'); }
  try {
    let resolvedHead;
    try { resolvedHead = commit(headSha); }
    catch {
      pinnedGit(exec, ['fetch', '--quiet', '--no-write-fetch-head', '--end-of-options', remote, headSha]);
      resolvedHead = commit(headSha);
    }
    if (resolvedHead !== headSha.toLowerCase()) return fail('head-mismatch');
    const mergeBaseSha = read(['merge-base', '--end-of-options', baseSha, resolvedHead]).split('\n')[0];
    if (!SHA.test(mergeBaseSha)) return fail('diff-failed');
    return { ok: true, baseSha, headSha: resolvedHead, mergeBaseSha };
  } catch { return fail('ref-unresolved'); }
}

/** Both callers refuse absent evidence; operators retry or review the full diff. */
export function requireScoredNetDiff(sig, headSha) {
  if (!SHA.test(headSha ?? '') || !sig?.scored || !sig.netDiffText?.scored ||
      !isPinnedDiffBasis({ ...sig, ok: true }) || sig.headSha !== headSha.toLowerCase() ||
      ['baseSha', 'headSha', 'mergeBaseSha'].some(key => sig[key] !== sig.netDiffText[key])) {
    throw new Error('unscored or mismatched net diff; retry or request human review of the full diff');
  }
  return sig;
}

export function readPinnedDiff(exec, basis, flags = []) {
  if (!isPinnedDiffBasis(basis)) throw new Error('unscored diff basis; retry or request human review');
  return pinnedGit(exec, ['diff', ...flags, '--end-of-options', basis.mergeBaseSha, basis.headSha]);
}
