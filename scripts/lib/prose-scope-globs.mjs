/** Shared prose exemptions for scope admission. */
import micromatch from 'micromatch';

export const PROSE_SCOPE_GLOBS = Object.freeze(['backlog/**/*.md', 'docs/**/*.md']);
export function isProseScopeFile(path) {
  return micromatch.isMatch(path.replace(/^[^:]+:/, ''), PROSE_SCOPE_GLOBS, { dot: true });
}
