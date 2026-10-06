// Perf 70b: cached and uncached check:standards must report identical findings.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { scanFilesCached, fileKeys } from '../standards-cache.mjs';
import { scanRepoLocusPrefixes, scanHarnessScaffolding } from '../../check-standards-rules.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scripts = join(here, '..', '..');
const entries = [join(scripts, 'check-standards.mjs'), join(scripts, 'check-standards-rules.mjs')];

function fixture() {
  const r = mkdtempSync(join(tmpdir(), 'csparity-'));
  const g = (...a) => execFileSync('git', a, { cwd: r });
  g('init', '-q'); mkdirSync(join(r, 'backlog'));
  writeFileSync(join(r, 'backlog', 'a.md'), 'see scripts/foo.mjs here\n');
  writeFileSync(join(r, 'backlog', 'b.md'), 'clean file\n');
  writeFileSync(join(r, 'backlog', 'c.md'), 'pasted <system-reminder>\nx\n</system-reminder>\n');
  g('add', '.');
  return { r, cache: mkdtempSync(join(tmpdir(), 'cscache-')) };
}
const run = (r, cache, scan, section, extra = {}) => {
  const files = ['backlog/a.md', 'backlog/b.md', 'backlog/c.md'];
  let stat = '';
  const out = scanFilesCached({
    section, entries, files, scan, load: (f) => readFileSync(join(r, f), 'utf8'),
    getKeys: () => fileKeys(r), env: { WE_STANDARDS_CACHE_DIR: cache, ...extra }, onStats: (l) => { stat = l; },
  });
  return { out: JSON.stringify(out), stat };
};

describe.each([['6f', scanRepoLocusPrefixes], ['6f-i-b', scanHarnessScaffolding]])('cache parity %s', (section, scan) => {
  it('cold == warm == uncached; one edit re-scans only that file and shows its new finding', () => {
    const { r, cache } = fixture();
    const uncached = run(r, cache, scan, section, { WE_STANDARDS_CACHE: '0' }).out;
    const cold = run(r, cache, scan, section);
    const warm = run(r, cache, scan, section);
    expect(cold.stat).toMatch(/0 hit \/ 3 miss/);
    expect(warm.stat).toMatch(/3 hit \/ 0 miss/);
    expect(cold.out).toBe(uncached);
    expect(warm.out).toBe(uncached);
    writeFileSync(join(r, 'backlog', 'b.md'), 'now scripts/bar.mjs and <system-reminder>\nx\n</system-reminder>\n');
    const edited = run(r, cache, scan, section);
    const editedUncached = run(r, cache, scan, section, { WE_STANDARDS_CACHE: '0' }).out;
    expect(edited.stat).toMatch(/2 hit \/ 1 miss/);
    expect(edited.out).toBe(editedUncached);
    expect(edited.out).toContain('backlog/b.md');
    expect(edited.out).not.toBe(uncached);
  });

  it('CI never uses the cache', () => {
    const { r, cache } = fixture();
    run(r, cache, scan, section);
    const ci = run(r, cache, scan, section, { CI: '1' });
    expect(ci.stat).toBe('');
  });
});
