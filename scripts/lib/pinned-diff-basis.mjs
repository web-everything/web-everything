/** Minimal isolated Git boundary for pinned scoring evidence. */
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})(?![\s\S])/i;
export const isPinnedDiffBasis = basis => basis?.ok === true &&
  ['baseSha', 'headSha', 'mergeBaseSha'].every(key => SHA.test(basis[key] ?? ''));
export const stampDiffBasis = basis => Object.fromEntries(
  ['baseSha', 'headSha', 'mergeBaseSha'].map(key => [key, basis?.[key] ?? null]));

export function pinnedGit(exec, args, { attrSource } = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG/.test(key) || /^GIT_(DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|REPLACE_REF_BASE|SHALLOW_FILE|GRAFT_FILE|EXTERNAL_DIFF|DIFF_OPTS|ATTR_SOURCE)$/.test(key)) delete env[key];
  }
  Object.assign(env, { GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_ATTR_NOSYSTEM: '1', GIT_GRAFT_FILE: '/dev/null' });
  // `.gitattributes` decides what renders as binary. Read it from the pinned base tree, never the checked-out
  // worktree or the PR's own head: a branch cannot mark its own edits opaque, nor its own binaries as text.
  if (args[0] === 'diff' && SHA.test(attrSource ?? '')) env.GIT_ATTR_SOURCE = attrSource;
  // A fetch only writes refs, so it keeps the operator's global/system config (credential.helper); revision and diff stay isolated.
  if (args[0] === 'fetch') { delete env.GIT_CONFIG_GLOBAL; delete env.GIT_CONFIG_NOSYSTEM; }
  const diff = args[0] === 'diff' ? ['--no-textconv', '--no-ext-diff', '--no-renames', '--no-color', '--unified=3',
    '--src-prefix=a/', '--dst-prefix=b/', '--no-relative', '--submodule=short', '--ignore-submodules=none'] : [];
  // Repo-local diff rendering keys cannot be ignored, so pin every one that changes paths or prefixes.
  const pins = ['core.attributesFile=/dev/null', 'diff.noprefix=false', 'diff.mnemonicPrefix=false',
    'diff.relative=false', 'diff.context=3', 'diff.interHunkContext=0', 'core.quotepath=false', 'diff.suppressBlankEmpty=false', 'diff.orderFile=/dev/null',
    'diff.ignoreSubmodules=none', 'diff.submodule=short', 'diff.external=', 'color.ui=false', 'color.diff=false'].flatMap(c => ['-c', c]);
  return String(exec('git', [...pins, args[0], ...diff, ...args.slice(1)], {
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

const RAW_HEADER = /^diff --git a\/(.+) b\/\1$/;

/**
 * Pinned diffs force -U3; a hunk that starts past line 1 yet carries no context line is zero-context output
 * (repo-local diff.context=0) and would hide edits under an unchanged @invariant marker. No review can fix that.
 */
function hasZeroContextHunk(lines) {
  for (let i = 0; i < lines.length; i++) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[i]);
    if (!m || (m[1] === '1' && m[2] === '1') || m[1] === '0' || m[2] === '0') continue;
    let context = false;
    for (let j = i + 1; j < lines.length && !/^(@@|diff --git)/.test(lines[j]); j++) if (lines[j].startsWith(' ')) context = true;
    if (!context) return true;
  }
  return false;
}

/** The tamper parser only understands raw, matching two-tree paths. */
export function isScorableDiffText(text) {
  if (!isLandableDiffText(text)) return false;
  // Renames are disabled: both raw paths must agree. C-quoted/unknown headers cannot be parsed safely.
  return text.split('\n').filter(line => line.startsWith('diff --git')).every(line => RAW_HEADER.test(line));
}

/**
 * Well-formed pinned diff text a human can review. Sections the tamper parser cannot read (C-quoted or unknown
 * headers, binary bodies) are not refused here: `opaqueDiffFiles` names them and every landing path holds them
 * for a human clearance of the exact head.
 */
export function isLandableDiffText(text) {
  if (typeof text !== 'string') return false;
  const lines = text.split('\n');
  if (hasZeroContextHunk(lines)) return false;
  return !text || lines.some(line => line.startsWith('diff --git'));
}

/**
 * Paths of file sections no text scanner can read: Git rendered them as binary (a NUL byte, an image, or a base
 * tree `-diff` attribute), or their header is C-quoted/unknown so the tamper parser cannot attribute them.
 * The diff stays scored at file level and these paths need a human clearance of the exact head.
 * Column 0 is unambiguous: content lines carry a +/-/space prefix.
 */
export function opaqueDiffFiles(text) {
  const files = [];
  const add = path => { if (!files.includes(path)) files.push(path); };
  let path = null;
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('diff --git')) {
      path = RAW_HEADER.exec(line)?.[1] ?? null;
      if (path === null) add(line.slice('diff --git'.length).trim() || '(unknown)');
      continue;
    }
    const binary = (line.startsWith('Binary files ') && line.endsWith(' differ')) || line === 'GIT binary patch';
    if (binary && path !== null) add(path);
    else if (binary && !files.length) add('(unknown)');
  }
  return files;
}

/** Producer and drain share this: opaque content always requires `review:human` and a human clearance at this head. */
export function opaqueDiffEscalation(text) {
  const files = opaqueDiffFiles(text);
  return files.length
    ? { humanRequired: true, files, reasons: [`opaque content no scanner can read (${files.join(', ')}); a human must clear this exact head`] }
    : { humanRequired: false, files, reasons: [] };
}

/** Both callers refuse absent evidence; operators retry or review the full diff. */
export function requireScoredNetDiff(sig, headSha) {
  if (!SHA.test(headSha ?? '') || !sig?.scored || !sig.netDiffText?.scored ||
      !isLandableDiffText(sig.netDiffText.text) ||
      !isPinnedDiffBasis({ ...sig, ok: true }) || sig.headSha !== headSha.toLowerCase() ||
      ['baseSha', 'headSha', 'mergeBaseSha'].some(key => sig[key] !== sig.netDiffText[key])) {
    throw new Error('unscored or mismatched net diff; retry or request human review of the full diff');
  }
  return sig;
}

export function readPinnedDiff(exec, basis, flags = []) {
  if (!isPinnedDiffBasis(basis)) throw new Error('unscored diff basis; retry or request human review');
  return pinnedGit(exec, ['diff', ...flags, '--end-of-options', basis.mergeBaseSha, basis.headSha], { attrSource: basis.baseSha });
}
