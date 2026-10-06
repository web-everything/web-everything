// @vitest-environment node
/**
 * perf item C1b — the PR-facts store is a cache for READS; it never decides a merge or a label write.
 * The drain re-reads live state itself before each merge (`#event-driven-land-is-wake-only`), and any read that
 * leads to a label write re-reads live. This pins both: the merge path and the label writer never import pr-facts.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The merge path, plus the label writer (its pre-write read must stay live). */
export const MUST_NOT_IMPORT_PR_FACTS = Object.freeze([
  'scripts/merge-ai-prs.mjs',
  'scripts/lib/pr-merge-gate.mjs',
  'scripts/pr-land.mjs',
  'scripts/review-set-label.mjs',
]);

const IMPORTS_PR_FACTS = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"][^'"]*pr-facts(?:\.mjs)?['"]/;

describe('pr-facts never feeds a merge gate or a label write', () => {
  it.each(MUST_NOT_IMPORT_PR_FACTS)('%s does not import pr-facts', (rel) => {
    const path = join(ROOT, rel);
    expect(existsSync(path), `${rel} moved — update this list, do not drop it`).toBe(true);
    expect(readFileSync(path, 'utf8')).not.toMatch(IMPORTS_PR_FACTS);
  });

  it('the pattern catches every import form', () => {
    for (const s of ["import { readPrFacts } from './lib/pr-facts.mjs';", "await import('../lib/pr-facts.mjs')",
      "const m = require('./pr-facts')", "import x from \"./pr-facts.mjs\""]) expect(s).toMatch(IMPORTS_PR_FACTS);
    expect("import { x } from './pr-facts-merge-gate.mjs'").not.toMatch(IMPORTS_PR_FACTS);
  });
});
