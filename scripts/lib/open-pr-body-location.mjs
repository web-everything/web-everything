import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const PURPOSE_TOKEN = /^[a-z0-9][a-z0-9-]*$/;
const OWNER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export function workerScratchDir(purpose, owner) {
  if (typeof owner !== 'string' || !OWNER_TOKEN.test(owner)) throw new Error('--owner must be an alphanumeric token.');
  if (typeof purpose !== 'string' || !PURPOSE_TOKEN.test(purpose)) throw new Error('--purpose must be a lowercase slug ([a-z0-9][a-z0-9-]*).');
  return join('/tmp', `we-scratch-${purpose}-${owner}`);
}

export function isWorkerScratchDir(segment) {
  if (!segment.startsWith('we-scratch-')) return false;
  const tokens = segment.slice('we-scratch-'.length);
  const split = tokens.search(/-[A-Za-z0-9]/);
  return split > 0 && PURPOSE_TOKEN.test(tokens.slice(0, split)) && OWNER_TOKEN.test(tokens.slice(split + 1));
}

const inside = (path, root) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
};

/** Lexical location check; files need not exist. tmp is accepted for caller portability:
 * private directory names are permitted on any volume, not only the system temp volume.
 * Tracking evidence must be a boolean; unavailable evidence refuses with the scratch fallback.
 */
export function checkBodyFileLocation({ bodyFile, cwd, isTracked, home, tmp }) {
  const absPath = resolve(cwd, bodyFile.startsWith('~') ? bodyFile.replace(/^~/, home) : bodyFile);
  const shared = (detail = '') => ({
    ok: false, code: 'body-file-shared-path',
    message: `${absPath}: ${detail}use the brief's per-worker scratch dir for the PR body.`,
  });
  let tracked;
  try { tracked = isTracked(absPath); }
  catch { return shared('unable to verify Git tracking; '); }
  if (tracked === true) return {
    ok: false, code: 'body-file-tracked',
    message: `${absPath} is tracked: move body to the worker scratch dir and use git rm --cached -- <path> to remove it from the index.`,
  };
  if (tracked !== false) return shared('unable to verify Git tracking; ');
  if (inside(absPath, resolve(cwd))) return { ok: true };
  const directories = dirname(absPath).split(sep);
  if (directories.some(isWorkerScratchDir)) return { ok: true };
  if ([join(home, '.claude'), join(home, 'workspace', '.operations')].some(root => inside(absPath, root))) return { ok: true };
  // Node mkdtemp suffixes use mixed-case alphanumerics, not just hexadecimal.
  if (directories.some(segment => /-(?:[A-Za-z0-9]{6}|[0-9a-f]{6,})$/.test(segment))) return { ok: true };
  // card-batch-extract creates a unique body file directly in tmpdir(), without a private directory.
  if (tmp && dirname(absPath) === resolve(tmp)
    && /^card-batch-extract-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/.test(basename(absPath))) return { ok: true };
  return shared();
}
