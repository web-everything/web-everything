/**
 * The deps-install job runs from a code snapshot with no installed packages, so a top-level package import anywhere
 * in its static import chain kills it at start (markdown-it via the supersede rule blocked the drain, PR 7380).
 * Only non-indented loads are judged: indented lazy loads inside function bodies run later and are allowed.
 */
import { readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const ENTRY = 'scripts/lib/daemon-rebuild/deps-job.mjs';
const FIX_SHA = '186ce82511';

const isPackage = name => !name.startsWith('.') && !name.startsWith('node:') && !isBuiltin(name);

// Walk static imports/re-exports and non-indented require/import() calls from `entry`; list each package chain.
export function packageChains(entry, read) {
  const seen = new Set();
  const found = [];
  const walk = (path, chain) => {
    if (seen.has(path)) return;
    seen.add(path);
    const text = read(path).replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '));
    const specs = [];
    for (const m of text.matchAll(/^(?:import|export)\b[^;'"`=(]*?\bfrom\s*(['"])([^'"]+)\1/gm)) specs.push(m[2]);
    for (const m of text.matchAll(/^import\s*(['"])([^'"]+)\1/gm)) specs.push(m[2]);
    for (const line of text.split('\n').filter(l => /^\S/.test(l) && !l.startsWith('//'))) {
      for (const m of line.matchAll(/\b(?:require|import)\s*\(\s*(['"])([^'"]+)\1/g)) specs.push(m[2]);
    }
    for (const name of specs) {
      if (name.startsWith('.')) walk(posix.normalize(posix.join(posix.dirname(path), name)), [...chain, path]);
      else if (isPackage(name)) found.push([...chain, path, name].join(' -> '));
    }
  };
  walk(entry, []);
  return found;
}

export function probe(checkout) {
  return { violations: packageChains(ENTRY, path => readFileSync(join(checkout, path), 'utf8')) };
}

// Fix presence is decided by git ancestry of the fixing commit, never by the import walk the break judges.
function fixPresent(checkout) {
  return spawnSync('git', ['merge-base', '--is-ancestor', FIX_SHA, 'HEAD'], { cwd: checkout }).status === 0;
}

export default {
  id: 'deps-job-builtins-only-import-chain',
  title: 'deps job static import chain uses only node built-ins (top-level loads only; indented lazy loads allowed)',
  card: 'PR #7380 deps-install bootstrap',
  fixedBy: { sha: FIX_SHA, where: 'lane/deps-install-bootstrap', paths: [ENTRY] },
  fixPresent,
  run: () => probe(root),
  judge: report => report.violations,
};
