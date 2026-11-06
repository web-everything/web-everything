/** R641 setting 3: exemptions affect review care, never human-review permission. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import micromatch from 'micromatch';
import { cascadePolicy, formatCascadeSourcesLine } from './policy-cascade.mjs';

export const DEFAULT_CARE_EXEMPT_PATHS = Object.freeze([
  'scripts/ci/test-timings.json',
  'data/generated/**',
  // Explicit generated output; the rest of src/_data contains authored standards.
  'src/_data/referenceIndex.json',
  '**/fixtures/**',
]);
export const MAX_CARE_EXEMPT_GLOB_LENGTH = 200;
const SETTINGS_FILE =join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'review.json');
const logged = new Set();
const logOnce = message => {
  if (!logged.has(message)) { logged.add(message); console.error(message); }
};

/** Guard, egress and permission machinery always contributes care, including inside fixtures. */
export function isProtectedCarePath(file) {
  // Same normal form as the sensitive-surface classifiers (NFKC, lower case, one slash), so a re-cased or
  // compatibility-spelled guard name cannot pass as unprotected.
  const p = String(file ?? '').normalize('NFKC').replace(/\\/g, '/').toLowerCase().replace(/\/+/g, '/')
    .replace(/^(?:\.?\/)+/, '');
  return /^(scripts|\.github|\.claude)\//.test(p)
    && p.split('/').slice(1).some(segment => /^(guard|egress|permission)/.test(segment));
}

/** Refuse broad, negated, traversing and compound patterns rather than expanding their reach. */
export function validateCareExemptPaths(value, { warn = m => console.warn(m) } = {}) {
  const validGlob = glob => {
    if (typeof glob !== 'string' || !glob.trim() || glob !== glob.trim()) return false;
    if (glob === '**/fixtures/**') return true;
    // Allow-list, not a deny-list: only plain path characters and the `*`/`?` wildcards. Every glob or regex
    // metacharacter that can widen reach (`|` alternation, extglob `+@!`, braces, brackets, `$^`, non-ASCII,
    // whitespace, control and format characters) is refused rather than enumerated (#6433 red team).
    if (!/^[A-Za-z0-9._\-/*?]+$/.test(glob) || glob.startsWith('/')
      || glob.split('/').some(s => s === '..' || s === '.' || !s)) return false;
    // Resource bound: PR authors pick the matched path names, so a pattern with many wildcard runs (`*a*a*a…b`)
    // can backtrack for seconds per path. Bound the length, one wildcard run per segment, three in all.
    const runs = segment => (segment.match(/[*?]+/g) || []).length;
    if (glob.length > MAX_CARE_EXEMPT_GLOB_LENGTH || glob.split('/').some(s => runs(s) > 1) || runs(glob) > 3) return false;
    const wildcard = glob.search(/[*?]/);
    // Count complete literal directories before the first wildcard. Equivalent broad
    // spellings must not evade the scope bound; exact file names remain allowed.
    if (wildcard !== -1 && glob.slice(0, wildcard).split('/').length - 1 <= 1) return false;
    try { micromatch.makeRe(glob); return true; } catch { return false; }
  };
  if (Array.isArray(value) && value.every(validGlob)) return [...value];
  warn('review.careExemptPaths: refused invalid or too-broad glob list; using built-in defaults');
  return [...DEFAULT_CARE_EXEMPT_PATHS];
}

/** Built-in → repo settings → JSON environment. Any invalid layer resets the whole list to built-in. */
export function resolveReviewCareExemptPaths({ env = process.env, file = SETTINGS_FILE,
  readFile = p => readFileSync(p, 'utf8'), log = logOnce } = {}) {
  let tool;
  let invalid = false;
  try { tool = JSON.parse(String(readFile(file)))?.careExemptPaths; }
  catch (error) { if (error?.code !== 'ENOENT') invalid = true; }
  let envValue;
  if (env.WE_REVIEW_CARE_EXEMPT_PATHS !== undefined) {
    try { envValue = JSON.parse(env.WE_REVIEW_CARE_EXEMPT_PATHS); }
    catch { invalid = true; }
  }
  for (const value of [tool, envValue]) {
    if (value === undefined) continue;
    // Validation is atomic: never retain the valid subset of a refused list.
    let refused = false;
    validateCareExemptPaths(value, { warn: () => { refused = true; } });
    invalid ||= refused;
  }
  if (invalid) {
    console.warn('review.careExemptPaths: refused invalid or too-broad setting; using built-in defaults');
    tool = undefined;
    envValue = undefined;
  }
  const result = cascadePolicy('review.careExemptPaths', tool, {
    standard: [...DEFAULT_CARE_EXEMPT_PATHS], platform: null, env,
    envValues: { '': envValue }, log: () => {},
  });
  log(formatCascadeSourcesLine('review.careExemptPaths', result));
  return result;
}

export const matchesCareExemptPath = (file, patterns) => micromatch.isMatch(file, patterns, { dot: true });
