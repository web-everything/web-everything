// Guard: a test that dynamically imports the whole operations registry (run.mjs, ~170 static
// imports) can exceed vitest's 5 s default on a loaded coverage shard (merge-queue flake on
// update-branch.test.mjs). Every such it()/test() block must close with an explicit timeout
// of at least 30 s and carry a comment saying why.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIN_TIMEOUT_MS = 30_000;
const IMPORT_RE = /import\(\s*['"]\.\.\/run\.mjs['"]\s*\)/;

/** Returns one problem string per it()/test() block that imports the registry without a long timeout + comment. */
export function findRegistryImportProblems(source, label) {
  const blocks = source.split(/^[ \t]*(?:it|test)\(/m).slice(1);
  const problems = [];
  let sites = 0;
  for (const block of blocks) {
    if (!IMPORT_RE.test(block)) continue;
    sites += 1;
    const timeout = /\}\s*,\s*([\d_]+)\s*\)/.exec(block);
    const ms = timeout ? Number(timeout[1].replaceAll('_', '')) : 0;
    const title = block.slice(0, 70).split('\n')[0];
    if (ms < MIN_TIMEOUT_MS) problems.push(`${label}: "${title}" imports the registry with timeout ${ms || 'default'} ms (< ${MIN_TIMEOUT_MS})`);
    else if (!/\/\/[^\n]*\bimport/i.test(block)) problems.push(`${label}: "${title}" has no comment explaining the registry-import timeout`);
  }
  return { sites, problems };
}

describe('registry-import-timeout guard', () => {
  it('self-check: flags a missing timeout, a short timeout and a missing comment, and accepts a good block', () => {
    const bad = "it('a', async () => {\n  await import('../run.mjs');\n});\n";
    const short = "it('b', async () => {\n  await import('../run.mjs');\n}, 5_000); // import is slow\n";
    const noComment = "it('c', async () => {\n  await import('../run.mjs');\n}, 60_000);\n";
    const good = "it('d', async () => {\n  await import('../run.mjs');\n}, 60_000); // the first dynamic import of the registry is slow\n";
    expect(findRegistryImportProblems(bad, 'x').problems).toHaveLength(1);
    expect(findRegistryImportProblems(short, 'x').problems).toHaveLength(1);
    expect(findRegistryImportProblems(noComment, 'x').problems).toHaveLength(1);
    expect(findRegistryImportProblems(good, 'x')).toEqual({ sites: 1, problems: [] });
  });

  it('every test that dynamically imports the operations registry declares a timeout of at least 30s', () => {
    let sites = 0;
    const problems = [];
    for (const file of readdirSync(HERE).filter((f) => f.endsWith('.test.mjs') && f !== 'registry-import-timeout.test.mjs')) {
      const r = findRegistryImportProblems(readFileSync(join(HERE, file), 'utf8'), file);
      sites += r.sites;
      problems.push(...r.problems);
    }
    expect(sites).toBeGreaterThanOrEqual(4);
    expect(problems).toEqual([]);
  });
});
