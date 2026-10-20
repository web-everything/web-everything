/** Verified PR net files, shared by card routing and review. No checkout or worktree writes. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gitRun } from './git-run.mjs';
import { repoKeyForSlug } from './constellation-repos.mjs';
import { repoKeyFromRemoteUrl } from '../conveyor/fix-procedure.mjs';
import { isCardOnlyDiff } from '../ci-card-only.mjs';
import { loadCardConflictSettings } from './card-conflict-resolve.mjs';

// Bound both age and size. Scope by runner/clone as well as repo+head so ownership failures cannot leak
// across clones, and injected runners never consume real-process evidence.
const caches = new WeakMap();
// One fetch for main AND the PR branch (one network round trip instead of two). Returns the branch's fetched oid
// only when FETCH_HEAD is exactly those two lines, in order, naming `main` then the branch; otherwise null, and the
// caller runs the original two-fetch path. Nothing is cached.
function combinedFetch({ run, cwd, branch, readFile }) {
  if (run('git', ['fetch', '--no-tags', 'origin', 'main', `refs/heads/${branch}`], { cwd }).status !== 0) return null;
  const where = run('git', ['rev-parse', '--git-path', 'FETCH_HEAD'], { cwd });
  const path = String(where.stdout ?? '').trim();
  if (where.status !== 0 || !path) return null;
  const lines = String(readFile(resolve(cwd, path), 'utf8')).split('\n').filter(Boolean);
  if (lines.length !== 2) return null;
  const parsed = lines.map(line => /^([a-f0-9]{40})\t\tbranch '(.+)' of [^\t]+$/.exec(line));
  if (!parsed[0] || !parsed[1] || parsed[0][2] !== 'main' || parsed[1][2] !== branch) return null;
  return parsed[1][1];
}
const eligible = pr => pr?.headRefName?.startsWith('lane/') && pr.baseRefName === 'main' && /^[a-f0-9]{40}$/.test(pr.headRefOid ?? '');
export function gitRealFiles({ pr, repo, cwd = process.cwd(), run = gitRun, readFile = readFileSync } = {}) {
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
  let files = null;
  try {
    const remote = run('git', ['remote', 'get-url', 'origin'], { cwd });
    let fetchedHead = null, legacy = false;
    if (remote.status === 0 && repoKeyFromRemoteUrl(remote.stdout) === expected) {
      try { fetchedHead = combinedFetch({ run, cwd, branch: pr.headRefName, readFile }); } catch { fetchedHead = null; }
      // Any failure or unexpected FETCH_HEAD shape: the original two fetches, unchanged.
      legacy = fetchedHead === null && run('git', ['fetch', 'origin', 'main'], { cwd }).status === 0
        && run('git', ['fetch', '--no-tags', 'origin', `refs/heads/${pr.headRefName}`], { cwd }).status === 0;
    }
    if (fetchedHead !== null || legacy) {
      baseOid = readBase();
      if (!baseOid) return null;
      if (legacy) {
        const head = run('git', ['rev-parse', 'FETCH_HEAD'], { cwd });
        fetchedHead = head.status === 0 ? String(head.stdout).trim() : '';
      }
      if (fetchedHead === pr.headRefOid) {
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
