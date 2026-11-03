import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { statSync } from 'node:fs';

const PURPOSE_TOKEN = /^[a-z0-9][a-z0-9-]*(?![\s\S])/;
const OWNER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9-]*(?![\s\S])/;

export function workerScratchDir(purpose, owner) {
  if (typeof owner !== 'string' || !OWNER_TOKEN.test(owner)) throw new Error('--owner must be an alphanumeric token.');
  if (typeof purpose !== 'string' || !PURPOSE_TOKEN.test(purpose)) throw new Error('--purpose must be a lowercase slug ([a-z0-9][a-z0-9-]*).');
  // Hex preserves every owner byte even on case-insensitive filesystems. Neither
  // component permits underscores, so purpose/owner boundaries stay unambiguous.
  const prefix = `we-scratch-${purpose}_`;
  if (prefix.length + owner.length * 2 > 255) throw new Error('Scratch directory name exceeds 255 bytes; use a shorter --purpose or --owner.');
  return join('/tmp', `${prefix}${Buffer.from(owner, 'utf8').toString('hex')}`);
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
 * All scratch directories require private filesystem evidence, regardless of name.
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
  let scratchTempPath;
  try {
    absPath = resolvePath(inputPath);
    lanePath = resolvePath(cwd);
    privateRoots = [join(home, '.claude'), join(home, 'workspace', '.operations'), ...extraPrivateRoots].map(root => resolvePath(root));
    tempPath = tmp && resolvePath(tmp);
    // Briefs use /tmp, which differs from tmpdir() on macOS; resolve its alias too.
    scratchTempPath = resolvePath('/tmp');
  } catch { return shared('unable to resolve body location; '); }
  if (inside(absPath, lanePath)) return { ok: true };
  if (privateRoots.some(root => inside(absPath, root))) return { ok: true };
  // mkdtemp creates a uid-owned 0700 directory directly below tmp. A name or
  // random-looking ancestor alone is not evidence of a private directory.
  for (const [root, scratchOnly] of [[tempPath, false], [scratchTempPath, true]]) {
    if (!root || !inside(absPath, root)) continue;
    const parts = relative(root, absPath).split(sep);
    if (parts.length > 1 && (!scratchOnly || isWorkerScratchDir(parts[0]))) {
      try {
        const info = stat(join(root, parts[0]));
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
