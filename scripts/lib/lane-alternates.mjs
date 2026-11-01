/**
 * @file scripts/lib/lane-alternates.mjs
 *
 * Make sure a lane clone borrows objects from its pool's reference store. 20 of 90 lanes had no
 * `.git/objects/info/alternates` because `git clone --reference` is fatal for a shallow primary, so
 * `referenceArgs` dropped it and every such lane pulled ~117k objects from GitHub. Adding the alternate after
 * the fact needs no clone flag, works for a shallow primary (verified: a fetch then transfers 0 objects), and
 * never removes an object.
 */
import { constants as FS, closeSync, existsSync, lstatSync, openSync, writeSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';

/** GitHub redirects chalbert/web-everything to web-everything/web-everything; that ONE pair is the same repo. */
const REPO_ALIASES = new Map([['chalbert/web-everything', 'web-everything/web-everything']]);

/** `host/owner/repo` for ssh/https/scp URLs, lowercased, `.git` stripped, the known redirect folded. PURE. */
export function canonicalRepoSlug(url) {
  if (typeof url !== 'string') return null;
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?\/*$/i.exec(url.trim());
  if (!m) return null;
  const ownerRepo = `${m[2].toLowerCase()}/${m[3].toLowerCase()}`;
  return `${m[1].toLowerCase()}/${REPO_ALIASES.get(ownerRepo) ?? ownerRepo}`;
}

/** Same host+repository, tolerating transport (ssh vs https) and the chalbert redirect. Non-URL paths compare resolved. PURE. */
export function sameRepoUrl(a, b) {
  if (!a || !b) return false;
  const sa = canonicalRepoSlug(a), sb = canonicalRepoSlug(b);
  if (sa && sb) return sa === sb;
  return !sa && !sb && resolve(a) === resolve(b);
}

/**
 * Add `<referencePath>/.git/objects` (or `<referencePath>/objects` for a bare store) to the lane's alternates when
 * the lane has none. Returns `{ status: 'present'|'added'|'skipped', reason? }`. Never edits an existing entry and
 * never touches objects. `isGitDir` lets a caller inject the store check.
 */
export function ensureLaneAlternates({ laneDir, referencePath, laneOrigin, referenceOrigin }) {
  const objectsCandidate = existsSync(join(referencePath, '.git', 'objects')) ? join(referencePath, '.git', 'objects')
    : existsSync(join(referencePath, 'objects')) ? join(referencePath, 'objects') : null;
  if (!objectsCandidate) return { status: 'skipped', reason: 'reference object store not found' };
  // Real paths only: a symlinked reference or `.git/objects` must not smuggle a lane into the trusted store.
  let objects, realLane;
  try { objects = realpathSync(objectsCandidate); realLane = realpathSync(laneDir); } catch { return { status: 'skipped', reason: 'unresolvable path' }; }
  if (/\/\.lanes\//.test(`${objects}/`) || objects.startsWith(`${realLane}/`) || basename(objects) !== 'objects') return { status: 'skipped', reason: 'reference is a lane' };
  if (laneOrigin && referenceOrigin && !sameRepoUrl(laneOrigin, referenceOrigin)) {
    return { status: 'skipped', reason: 'lane origin differs from the reference origin' };
  }
  const infoDir = join(laneDir, '.git', 'objects', 'info');
  const file = join(infoDir, 'alternates');
  // Lane-controlled paths: never write through a symlink, never follow one out of the lane.
  const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
  if ([laneDir, join(laneDir, '.git'), join(laneDir, '.git', 'objects'), infoDir, file].some(isLink)) return { status: 'skipped', reason: 'symlink in lane object store path' };
  let current = '';
  try { current = readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') return { status: 'skipped', reason: e.message }; }
  if (current.split('\n').some((l) => l.trim())) return { status: 'present' };
  mkdirSync(infoDir, { recursive: true });
  let realInfo;
  try { realInfo = realpathSync(infoDir); } catch { return { status: 'skipped', reason: 'unresolvable path' }; }
  // Every ancestor is resolved: the write goes to a symlink-free absolute path that must sit inside the lane's own object store.
  if (realInfo !== join(realLane, '.git', 'objects', 'info')) return { status: 'skipped', reason: 'symlink in lane object store path' };
  // No truncation and no symlink following: create exclusively, or open an existing EMPTY file with O_NOFOLLOW.
  const realFile = join(realInfo, 'alternates');
  const flags = FS.O_WRONLY | FS.O_NOFOLLOW | (existsSync(file) ? 0 : FS.O_CREAT | FS.O_EXCL);
  let fd;
  try { fd = openSync(realFile, flags, 0o644); } catch (e) { return { status: 'skipped', reason: e.code || e.message }; }
  try {
    if (existsSync(file) && readFileSync(file, 'utf8').trim()) return { status: 'present' };
    writeSync(fd, `${objects}\n`);
  } finally { closeSync(fd); }
  return { status: 'added' };
}

/** `<pool>` for a path inside `<root>/.lanes/<pool>/lane-N`, else null. PURE. */
export function poolNameFromLanePath(path) {
  const m = /\/\.lanes\/([^/]+)\/lane-\d+(?:\/|$)/.exec(path || '');
  return m ? m[1] : null;
}

/**
 * Trusted origin for a release/gc run FROM INSIDE a lane: the non-lane checkout in the workspace (a real `.git`
 * directory, never a lane-controlled path) whose origin repo name is the pool name. The chalbert redirect and the
 * org URL are one repo. `readOrigin(dir)` is injected; returns `{ path, origin }` or null.
 */
export function findPrimaryForPool({ workspaceDir, poolName, readOrigin, expectedOwners = ['web-everything', 'chalbert'] }) {
  if (!workspaceDir || !poolName) return null;
  const found = [];
  let names = [];
  try { names = readdirSync(workspaceDir); } catch { return null; }
  for (const name of names) {
    if (name.startsWith('.') || /^lane-\d+$/.test(name)) continue;
    const dir = join(workspaceDir, name);
    try {
      // A real directory with a real .git directory; a symlink (to a lane, say) is never a primary.
      if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory() || !lstatSync(join(dir, '.git')).isDirectory()) continue;
      if (realpathSync(dir) !== join(realpathSync(workspaceDir), name) || /\/\.lanes\//.test(realpathSync(dir))) continue;
      // A linked worktree or redirected git dir (commondir) shares another repository's ownership; only a self-owned primary counts.
      if (existsSync(join(dir, '.git', 'commondir')) || existsSync(join(dir, '.git', 'gitdir'))) continue;
    } catch { continue; }
    const origin = readOrigin(dir);
    const slug = canonicalRepoSlug(origin);
    const [host, owner, repo] = slug ? slug.split('/') : [];
    if (host === 'github.com' && repo === poolName.toLowerCase() && expectedOwners.includes(owner)) found.push({ path: dir, origin });
  }
  // Daemon clones share the primary's origin; every match names the same repo, so the first (sorted) is as good as any.
  return found.sort((a, b) => a.path.localeCompare(b.path))[0] ?? null;
}
