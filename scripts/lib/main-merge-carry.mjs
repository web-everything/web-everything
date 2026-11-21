/** Stateless, fail-closed proof of an audit carried through at most four main merges.
 * The caller refreshes origin/main first and compares the returned fingerprint to both records.
 */
import { execFileSync } from 'node:child_process';
import { netDiffFingerprint, carriesAcross } from './net-diff-fingerprint.mjs';
import { mergeTimingsJson } from './daemon-rebuild/advisory-merge.mjs';

const SHA = /^[a-f0-9]{40}$/i;
export function mainMergeGitEnv(env = process.env) {
  const clean = { ...env, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_REPLACE_REF_BASE']) delete clean[key];
  return clean;
}
export function mainMergeCarry({ repo, auditedSha, head, exec = execFileSync, env = process.env }) {
  try {
    if (![auditedSha, head].every(s => typeof s === 'string' && SHA.test(s))) return { ok: false };
    auditedSha = auditedSha.toLowerCase(); head = head.toLowerCase();
    if (auditedSha === head) return { ok: false };
    const clean = mainMergeGitEnv(env);
    const hardenedExec = (cmd, args, options) => exec(cmd, ['-c', 'core.commitGraph=false', ...args], { ...options, env: clean, timeout: 10_000 });
    const raw = (...args) => Buffer.from(hardenedExec('git', ['-C', repo, ...args], {
      encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    }));
    const git = (...args) => raw(...args).toString('utf8').trim();
    const main = git('rev-parse', '--verify', '--end-of-options', 'origin/main^{commit}');
    if (!SHA.test(main)) return { ok: false };
    const fingerprint = netDiffFingerprint(repo, main, head, { exec: hardenedExec });
    if (!carriesAcross(fingerprint, fingerprint)) return { ok: false };
    const file = (sha, path) => {
      const entry = git('ls-tree', sha, '--', path);
      if (!entry) return null;
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t/.exec(entry);
      if (!match) throw Error('not a regular blob');
      return { mode: match[1], bytes: raw('cat-file', 'blob', `${sha}:${path}`) };
    };
    const equal = (a, b) => a === null ? b === null : b !== null && a.mode === b.mode && a.bytes.equals(b.bytes);
    const chain = [];
    let current = head, mainParent;
    for (let hops = 0; hops < 4; hops++) {
      chain.push(current);
      // Read the immutable commit itself: revision walkers may honor legacy grafts.
      const header = git('cat-file', 'commit', current).split('\n\n')[0];
      const parents = header.split('\n').filter(l => l.startsWith('parent ')).map(l => l.slice(7));
      if (parents.length !== 2 || !parents.every(p => SHA.test(p))) return { ok: false };
      const [p1, p2] = parents;
      git('merge-base', '--is-ancestor', p2, main);
      mainParent ??= p2;
      for (const path of ['scripts/ci/test-timings.json', '.lane-manifest.json']) {
        const [child, ours, theirs] = [current, p1, p2].map(s => file(s, path));
        if (path === '.lane-manifest.json' && child === null) continue;
        // A timing blob missing on any side cannot be exempted as an unchanged path.
        if (path.endsWith('test-timings.json') && [child, ours, theirs].some(v => v === null)) {
          if ([child, ours, theirs].every(v => v === null)) continue;
          return { ok: false };
        }
        if (equal(child, ours) || equal(child, theirs)) continue;
        if (path === '.lane-manifest.json' || !child || !ours || !theirs
          || child.mode !== ours.mode || child.mode !== theirs.mode) return { ok: false };
        const base = git('merge-base', '--all', p1, p2);
        if (!SHA.test(base)) return { ok: false };
        const original = file(base, path);
        if (!original || original.mode !== child.mode) return { ok: false };
        const union = mergeTimingsJson(original.bytes.toString('utf8'), ours.bytes.toString('utf8'), theirs.bytes.toString('utf8'));
        if (union === null || !child.bytes.equals(Buffer.from(union))) return { ok: false };
      }
      if (p1 === auditedSha) return { ok: true, from: auditedSha, to: head, mainParent, fingerprint, chain };
      current = p1;
    }
    return { ok: false };
  } catch { return { ok: false }; }
}
