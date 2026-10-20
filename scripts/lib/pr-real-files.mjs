/** Verified PR net files, shared by card routing and review. No checkout or worktree writes. */
import { gitRun } from './git-run.mjs';
import { repoKeyForSlug } from './constellation-repos.mjs';
import { repoKeyFromRemoteUrl } from '../conveyor/fix-procedure.mjs';
import { isCardOnlyDiff } from '../ci-card-only.mjs';
import { loadCardConflictSettings } from './card-conflict-resolve.mjs';

// Bound both age and size. Scope by runner/clone as well as repo+head so ownership failures cannot leak
// across clones, and injected runners never consume real-process evidence.
const caches = new WeakMap();
// Answers proven by the full fetch path, keyed only by immutable inputs (repo, clone, branch, head sha, base sha).
// Never expired by time: a three-dot net diff of two fixed commits cannot change. Reuse still needs the remote's
// CURRENT main and branch tips (one ls-remote) to equal the key, so the base is exactly as fresh as a fetch makes it.
const verifiedCaches = new WeakMap();
// One round trip for both tips. Exactly one line per exact ref name, or null (the caller falls back to fetching).
function remoteTips({ run, cwd, branch }) {
  const refs = ['refs/heads/main', `refs/heads/${branch}`];
  const r = run('git', ['ls-remote', 'origin', ...refs], { cwd });
  if (r.status !== 0) return null;
  const tips = {};
  for (const line of String(r.stdout ?? '').split('\n').filter(Boolean)) {
    const [oid, ref, extra] = line.split('\t');
    if (extra !== undefined || !/^[a-f0-9]{40}$/.test(oid ?? '') || !refs.includes(ref)) continue;
    if (tips[ref] !== undefined) return null; // ambiguous
    tips[ref] = oid;
  }
  return tips[refs[0]] && tips[refs[1]] ? { main: tips[refs[0]], branch: tips[refs[1]] } : null;
}
const eligible = pr => pr?.headRefName?.startsWith('lane/') && pr.baseRefName === 'main' && /^[a-f0-9]{40}$/.test(pr.headRefOid ?? '');
export function gitRealFiles({ pr, repo, cwd = process.cwd(), run = gitRun } = {}) {
  if (!eligible(pr)) return null;
  const expected = repoKeyForSlug(repo);
  if (!expected) return null;
  let cache = caches.get(run);
  if (!cache) caches.set(run, cache = new Map());
  const readBase = () => {
    const r = run('git', ['rev-parse', '--verify', 'origin/main^{commit}'], { cwd });
    const oid = String(r.stdout ?? '').trim();
    return r.status === 0 && /^[a-f0-9]{40}$/.test(oid) ? oid : null;
  };
  let baseOid;
  try { baseOid = readBase(); } catch { return null; }
  if (!baseOid) return null;
  const keyFor = base => `${repo.toLowerCase()}\0${pr.headRefOid}\0${pr.headRefName}\0${cwd}\0${base}`;
  const hit = cache.get(keyFor(baseOid));
  try {
    if (hit && Date.now() - hit.at < 30_000
      && run('git', ['cat-file', '-e', `${pr.headRefOid}^{commit}`], { cwd }).status === 0)
      return hit.files?.slice() ?? null;
  } catch { /* Missing local evidence is a cache miss. */ }
  let verified = verifiedCaches.get(run);
  if (!verified) verifiedCaches.set(run, verified = new Map());
  // Fast path: reuse a fetched-and-verified answer only when the remote's current tips are exactly its key.
  // Any miss, ambiguity or error falls through to the full fetch below, unchanged.
  let remote = null; // read once; the full path below re-reads it only if this read threw
  try {
    if (verified.size) {
      remote = run('git', ['remote', 'get-url', 'origin'], { cwd });
      if (remote.status === 0 && repoKeyFromRemoteUrl(remote.stdout) === expected) {
        const tips = remoteTips({ run, cwd, branch: pr.headRefName });
        const proven = tips && tips.branch === pr.headRefOid ? verified.get(keyFor(tips.main)) : undefined;
        if (Array.isArray(proven)) return proven.slice();
      }
    }
  } catch { remote = null; /* fall through to the fetch */ }
  let files = null;
  try {
    remote ??= run('git', ['remote', 'get-url', 'origin'], { cwd });
    if (remote.status === 0 && repoKeyFromRemoteUrl(remote.stdout) === expected
      && run('git', ['fetch', 'origin', 'main'], { cwd }).status === 0
      && run('git', ['fetch', '--no-tags', 'origin', `refs/heads/${pr.headRefName}`], { cwd }).status === 0) {
      baseOid = readBase();
      if (!baseOid) return null;
      const head = run('git', ['rev-parse', 'FETCH_HEAD'], { cwd });
      if (head.status === 0 && String(head.stdout).trim() === pr.headRefOid) {
        // --no-renames exposes source paths too: moving code into backlog cannot buy an exemption.
        const diff = run('git', ['diff', '-z', '--name-only', '--no-renames', `${baseOid}...${pr.headRefOid}`], { cwd });
        // A concurrent fetch must not publish evidence under a different base.
        if (readBase() !== baseOid) return null;
        if (diff.status === 0) files = [...new Set(String(diff.stdout ?? '').split('\0').filter(Boolean))];
      }
    }
  } catch { return null; } // Unverifiable: never cache a failed base recheck.
  if (cache.size >= 128) cache.delete(cache.keys().next().value);
  cache.set(keyFor(baseOid), { at: Date.now(), files });
  if (Array.isArray(files)) {
    if (verified.size >= 1024) verified.delete(verified.keys().next().value);
    verified.set(keyFor(baseOid), files.slice());
  }
  return files?.slice() ?? null;
}
const normalize = files => Array.isArray(files) ? [...new Set(files.map(f => typeof f === 'string' ? f : f?.path ?? f?.filename).filter(Boolean))] : null;
export function resolveRealFiles({ pr, repo, ghFiles, cwd, run, enabled = loadCardConflictSettings().value.gitRecheckFiles } = {}) {
  // GitHub GraphQL and the review REST reader cap at 100 entries. Without explicit pagination
  // evidence this boundary is incomplete; only verified git can recover the complete list.
  const github = Array.isArray(ghFiles) && ghFiles.length >= 100 ? null : normalize(ghFiles);
  if (!enabled || !eligible(pr)) return { files: github, source: 'github', disagreed: false, reason: !enabled ? 'git recheck disabled' : 'ineligible PR' };
  const git = gitRealFiles({ pr, repo, cwd, run });
  if (git === null) return { files: github, source: 'github', disagreed: false, reason: 'git unverifiable' };
  const disagreed = github === null || JSON.stringify([...github].sort()) !== JSON.stringify([...git].sort());
  // Verified git evidence also establishes completeness when a REST page hit its cap.
  return { files: git, source: 'git', disagreed, reason: disagreed ? 'git net files override missing, capped or differing GitHub list' : 'git verified GitHub files' };
}
export function realFilesCardOnly(options) { return isCardOnlyDiff(resolveRealFiles(options).files); }
