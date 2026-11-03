import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';

const PURPOSE_TOKEN = /^[a-z0-9][a-z0-9-]*(?![\s\S])/;
const OWNER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9-]*(?![\s\S])/;

export function workerScratchDir(purpose, owner) {
  if (typeof owner !== 'string' || !OWNER_TOKEN.test(owner)) throw new Error('--owner must be an alphanumeric token.');
  if (typeof purpose !== 'string' || !PURPOSE_TOKEN.test(purpose)) throw new Error('--purpose must be a lowercase slug ([a-z0-9][a-z0-9-]*).');
  // Neither token permits underscores, so their boundary cannot be ambiguous.
  const ownerHash = createHash('sha256').update(owner).digest('hex').slice(0, 6);
  return join('/tmp', `we-scratch-${purpose}_${owner.toLowerCase()}-${ownerHash}`);
}

export function isWorkerScratchDir(segment) {
  if (!segment.startsWith('we-scratch-')) return false;
  const tokens = segment.slice('we-scratch-'.length);
  const boundary = tokens.indexOf('_');
  if (boundary !== -1) return PURPOSE_TOKEN.test(tokens.slice(0, boundary)) && OWNER_TOKEN.test(tokens.slice(boundary + 1));
  // Ambiguous legacy hyphen-only names need the same filesystem evidence as any
  // other temporary directory; checkBodyFileLocation handles that fallback.
  return false;
}

const inside = (path, root) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
};

/** Injectable location check; files need not exist. Production resolves filesystem aliases.
 * Generic and legacy scratch directories must be private direct children of tmp.
 * Tracking evidence must be a boolean; unavailable evidence refuses with the scratch fallback.
 */
export function checkBodyFileLocation({ bodyFile, cwd, isTracked, home, tmp, resolvePath = resolve,
  extraPrivateRoots = [], stat = statSync, uid = process.getuid?.() }) {
  const expanded = bodyFile.startsWith('~') ? bodyFile.replace(/^~/, home) : bodyFile;
  // Prefix without normalizing: the filesystem follows symlinks before interpreting '..'.
  const inputPath = isAbsolute(expanded) ? expanded : `${cwd}${sep}${expanded}`;
  let absPath = inputPath;
  const shared = (detail = '') => ({
    ok: false, code: 'body-file-shared-path',
    message: `${absPath}: ${detail}use the brief's per-worker scratch dir for the PR body.`,
  });
  let tracked;
  try { tracked = isTracked(inputPath); }
  catch { return shared('unable to verify Git tracking; '); }
  if (tracked === true) return {
    ok: false, code: 'body-file-tracked',
    message: `${absPath} is tracked: move body to the worker scratch dir and use git rm --cached -- <path> to remove it from the index.`,
  };
  if (tracked !== false) return shared('unable to verify Git tracking; ');
  let lanePath;
  let privateRoots;
  let tempPath;
  try {
    absPath = resolvePath(inputPath);
    lanePath = resolvePath(cwd);
    privateRoots = [join(home, '.claude'), join(home, 'workspace', '.operations'), ...extraPrivateRoots].map(root => resolvePath(root));
    tempPath = tmp && resolvePath(tmp);
  } catch { return shared('unable to resolve body location; '); }
  if (inside(absPath, lanePath)) return { ok: true };
  const directories = dirname(absPath).split(sep);
  if (directories.some(isWorkerScratchDir)) return { ok: true };
  if (privateRoots.some(root => inside(absPath, root))) return { ok: true };
  // mkdtemp creates a uid-owned 0700 directory directly below tmp. A name or
  // random-looking ancestor alone is not evidence of a private directory.
  if (tempPath && inside(absPath, tempPath)) {
    const parts = relative(tempPath, absPath).split(sep);
    if (parts.length > 1) {
      try {
        const info = stat(join(tempPath, parts[0]));
        if (Number.isInteger(uid) && info.isDirectory() && info.uid === uid
          && (info.mode & 0o7777) === 0o700) return { ok: true };
      } catch { return shared('unable to verify private temp directory; '); }
    }
  }
  // card-batch-extract creates a unique body file directly in tmpdir(), without a private directory.
  if (tmp && dirname(absPath) === tempPath
    && /^card-batch-extract-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/.test(basename(absPath))) return { ok: true };
  return shared();
}
