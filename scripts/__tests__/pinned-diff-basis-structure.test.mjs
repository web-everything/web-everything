import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findUnpinnedDiffReads } from '../lib/pinned-diff-basis-structure.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const helpers = new Set(['lib/pinned-diff-basis.mjs', 'lib/pinned-diff-basis-structure.mjs',
  'lib/hardened-git-diff.mjs', 'lib/net-diff-display.mjs']);
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ['__tests__', 'node_modules'].includes(entry.name) ? [] : sources(path);
    return entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs') && !helpers.has(relative(root, path)) ? [path] : [];
  });
}
describe('pinned diff structural contract', () => {
  it('flags synthetic ref-string evidence and display readers', () => {
    for (const source of ["computeNetDiffText({exec, rev: 'main'})", "computeNetDiffSignals({exec, rev})",
      "resolveNetDiffBasis({exec, rev: head})", "exec('git', ['diff', 'origin/main', head])",
      "exec('git', ['log', '-p', 'origin/main...HEAD'])", 'computeNetDiffTextForDisplay({exec, rev})']) {
      expect(findUnpinnedDiffReads(source), source).not.toEqual([]);
    }
    expect(findUnpinnedDiffReads('computeNetDiffText({exec, basis})')).toEqual([]);
    expect(findUnpinnedDiffReads("exec('git', ['diff', basis.mergeBaseSha, basis.headSha])")).toEqual([]);
  });
  it('every scripts module supplies pinned evidence', () => {
    const failures = sources(root).flatMap(file => findUnpinnedDiffReads(readFileSync(file, 'utf8'), relative(root, file)));
    expect(failures).toEqual([]);
  });
});
