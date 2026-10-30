/** Shared size-policy reader. Planning must not load the dispatch/worker IO graph to read one setting. */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * #3843 (#3801 Fork 4 (b)) — read the checked-in size policy and hand it across as data.
 * A missing, unreadable or non-object setting returns null; validateSizePolicy supplies
 * DEFAULT_SIZE_POLICY field by field, preserving the dispatch IO reader's fallback.
 * @param {{root?: string, readText?: (p: string) => string}} [io]
 * @returns {object|null}
 */
export function defaultReadSizePolicy({ root = REPO_ROOT, readText = (p) => readFileSync(p, 'utf8') } = {}) {
  try {
    const parsed = JSON.parse(String(readText(join(root, 'scripts', 'lib', 'dispatch-size-policy.json'))));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
