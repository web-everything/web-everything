/**
 * @file scripts/lib/lane-alternates.mjs
 *
 * Make sure a lane clone borrows objects from its pool's reference store. 20 of 90 lanes had no
 * `.git/objects/info/alternates` because `git clone --reference` is fatal for a shallow primary, so
 * `referenceArgs` dropped it and every such lane pulled ~117k objects from GitHub. Adding the alternate after
 * the fact needs no clone flag, works for a shallow primary (verified: a fetch then transfers 0 objects), and
 * never removes an object.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** GitHub renamed/redirected chalbert/web-everything <-> web-everything/web-everything; both are one repo. */
const ORG_ALIASES = new Map([['chalbert', 'web-everything']]);

/** `owner/repo` for ssh/https/scp GitHub-style URLs, lowercased, `.git` stripped, known org redirects folded. PURE. */
export function canonicalRepoSlug(url) {
  if (typeof url !== 'string') return null;
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?\/*$/i.exec(url.trim());
  if (!m) return null;
  const owner = m[2].toLowerCase();
  return `${m[1].toLowerCase()}/${ORG_ALIASES.get(owner) ?? owner}/${m[3].toLowerCase()}`;
}

/** Same repository, tolerating transport (ssh vs https) and the chalbert redirect. Non-URL paths compare resolved. PURE. */
export function sameRepoUrl(a, b) {
  if (!a || !b) return false;
  const sa = canonicalRepoSlug(a), sb = canonicalRepoSlug(b);
  if (sa && sb) return sa.split('/').slice(1).join('/') === sb.split('/').slice(1).join('/');
  return !sa && !sb && resolve(a) === resolve(b);
}

/**
 * Add `<referencePath>/.git/objects` (or `<referencePath>/objects` for a bare store) to the lane's alternates when
 * the lane has none. Returns `{ status: 'present'|'added'|'skipped', reason? }`. Never edits an existing entry and
 * never touches objects. `isGitDir` lets a caller inject the store check.
 */
export function ensureLaneAlternates({ laneDir, referencePath, laneOrigin, referenceOrigin }) {
  const objects = existsSync(join(referencePath, '.git', 'objects')) ? join(referencePath, '.git', 'objects')
    : existsSync(join(referencePath, 'objects')) ? join(referencePath, 'objects') : null;
  if (!objects) return { status: 'skipped', reason: 'reference object store not found' };
  if (resolve(objects).startsWith(resolve(laneDir))) return { status: 'skipped', reason: 'reference is the lane itself' };
  if (laneOrigin && referenceOrigin && !sameRepoUrl(laneOrigin, referenceOrigin)) {
    return { status: 'skipped', reason: 'lane origin differs from the reference origin' };
  }
  const file = join(laneDir, '.git', 'objects', 'info', 'alternates');
  let current = '';
  try { current = readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') return { status: 'skipped', reason: e.message }; }
  const lines = current.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length) return { status: 'present' };
  mkdirSync(join(laneDir, '.git', 'objects', 'info'), { recursive: true });
  writeFileSync(file, `${resolve(objects)}\n`);
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
export function findPrimaryForPool({ workspaceDir, poolName, readOrigin }) {
  if (!workspaceDir || !poolName) return null;
  const found = [];
  let names = [];
  try { names = readdirSync(workspaceDir); } catch { return null; }
  for (const name of names) {
    if (name.startsWith('.') || /^lane-\d+$/.test(name)) continue;
    const dir = join(workspaceDir, name);
    try { if (!statSync(join(dir, '.git')).isDirectory()) continue; } catch { continue; }
    const origin = readOrigin(dir);
    const slug = canonicalRepoSlug(origin);
    if (slug && slug.split('/')[2] === poolName.toLowerCase()) found.push({ path: dir, origin });
  }
  // Daemon clones share the primary's origin; every match names the same repo, so the first (sorted) is as good as any.
  return found.sort((a, b) => a.path.localeCompare(b.path))[0] ?? null;
}
