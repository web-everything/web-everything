/** @file exec-output-guard.test.mjs — captured-output baseline ratchet (#74a). */
/** @repo-scanning-test scope=files — see scripts/lib/repo-scan-tests.mjs. */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readGit } from '../proc-read.mjs';
import { scanRoot, scanScope } from '../repo-scan-tests.mjs';
import { findUnboundedExecReads, countDefaultSeamParams, checkBaseline, isExecReadSource } from '../exec-output-guard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const baseline = JSON.parse(readFileSync(join(ROOT, 'scripts/exec-output-baseline.json'), 'utf8'));

function trackedSourceFiles() {
  const scope = scanScope();
  if (scope) return [...scope].filter(isExecReadSource).filter((f) => existsSync(join(scanRoot(ROOT), f)));
  return readGit(['ls-files', '-z', 'scripts', 'skills-src'], { cwd: ROOT }).split('\0').filter(isExecReadSource);
}

describe('captured process output detector', () => {
  it.each([
    "execFileSync('gh', ['api'], { encoding: 'utf8' })",
    "spawnSync('git', ['log'], { stdio: ['ignore', 'pipe', 'ignore'] })",
    "execSync('git log')",
    'execSync(`gh api ${endpoint}`)',
    "execFileSync('git', ['maxBuffer', 'stdio: inherit'], { nested: { maxBuffer: 42 } })",
  ])('flags %s', (src) => {
    expect(findUnboundedExecReads(`// intro\n${src};`)).toEqual([{ line: 2, call: src }]);
  });

  it.each([
    "execFileSync('gh', [], { encoding: 'utf8', maxBuffer: LIMIT })",
    "spawnSync('git', [], { maxBuffer })",
    "execFileSync('gh', [], { stdio: 'inherit' })",
    "execSync('git log', { stdio: 'ignore' })",
    "spawnSync('git', [], { stdio: ['pipe', 'inherit', 'pipe'] })",
    "execFileSync('gh', [], { stdio: ['pipe', 'ignore', 'pipe'] })",
    "// execFileSync('gh', [])\n/* execSync('git log') */",
    "readGh(['api']); execRead('git', ['log']);",
    'const example = "execSync(\'git log\')";',
    "execFileSync('node', []); execSync('git-lfs status');",
  ])('ignores %s', (src) => {
    expect(findUnboundedExecReads(src)).toEqual([]);
  });

  it('balances nested argv expressions and strips comments before checking options', () => {
    const src = "execFileSync(/* why */ 'gh', args.map((a) => f(a, ')')), { /* maxBuffer: 10 */ encoding: 'utf8' })";
    expect(findUnboundedExecReads(src)).toHaveLength(1);
    expect(findUnboundedExecReads(src.replace("encoding: 'utf8'", 'maxBuffer: size(1, 2)'))).toEqual([]);
  });

  it('counts default seams without counting comments, strings or longer identifiers', () => {
    expect(countDefaultSeamParams(`function f({ exec = execFileSync } = {}) {}\nconst g = (exec = execFileSync) => 1;
      // exec = execFileSync
      const copy = execFileSync, other = 1;
      const s = 'exec = execFileSync'; function h(exec = execFileSyncThrottled) {}`)).toBe(2);
  });

  it('ratchets per file, including new and removed files', () => {
    expect(checkBaseline({ old: 3, added: 1, lower: 1 }, { old: 2, lower: 2, removed: 1 })).toEqual({
      regressions: [{ file: 'added', count: 1, allowed: 0 }, { file: 'old', count: 3, allowed: 2 }],
      improvements: [{ file: 'lower', count: 1, allowed: 2 }, { file: 'removed', count: 0, allowed: 1 }],
    });
  });

  it('scans only production JS sources in scripts and skills-src', () => {
    for (const file of ['scripts/a.mjs', 'skills-src/x/a.js']) expect(isExecReadSource(file)).toBe(true);
    for (const file of ['src/a.js', 'scripts/a.ts', 'scripts/a.test.mjs', 'scripts/__tests__/a.mjs',
      'scripts/__fixtures__/a.js', 'scripts/node_modules/a.js', 'scripts/lib/proc-read.mjs', 'scripts/lib/exec-output-guard.mjs']) {
      expect(isExecReadSource(file), file).toBe(false);
    }
  });
});

describe('tracked-source output ratchet', () => {
  it('has no per-file regressions and the baseline equals a fresh scan', () => {
    const counts = {};
    let seams = 0;
    for (const file of trackedSourceFiles()) {
      const content = readFileSync(join(scanRoot(ROOT), file), 'utf8');
      const count = findUnboundedExecReads(content).length;
      if (count) counts[file] = count;
      seams += countDefaultSeamParams(content);
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.warn(`exec-output guard${scanScope() ? ' (scoped)' : ''}: ${total} remaining capturing sites; ${seams} = execFileSync default seams (warning only)`);
    expect(checkBaseline(counts, baseline).regressions).toEqual([]);
    // A scoped run judges only the supplied paths. Rule/data changes select a full run.
    if (!scanScope()) {
      expect(counts, 'Regenerate with node scripts/lib/exec-output-guard.mjs --write-baseline after improvements').toEqual(baseline);
      const largest = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      expect(largest[0]).toBe('scripts/lane-resume.mjs');
    }
  });
});
