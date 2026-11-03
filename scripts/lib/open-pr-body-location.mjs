import { dirname, join, relative, resolve, sep } from 'node:path';

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
  if (directories.some(segment => /^we-scratch-[a-z0-9-]+-[0-9a-f]{6,}$/.test(segment))) return { ok: true };
  if ([join(home, '.claude'), join(home, 'workspace', '.operations')].some(root => inside(absPath, root))) return { ok: true };
  if (directories.some(segment => /-[0-9a-f]{6,}$/.test(segment))) return { ok: true };
  return shared();
}
