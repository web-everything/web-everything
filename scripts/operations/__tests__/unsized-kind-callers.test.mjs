/**
 * @file unsized-kind-callers.test.mjs — source-level guard for #x0h3pe4.
 *
 * Every non-test caller of `file-item`/`fileCard` that hands in `kind: 'task'|'feature'` must NOT also hand in a
 * `size`: `planScaffold` refuses it, and a detached filing child fails only in its own log (the auto-filed
 * prepare-failure card silently stopped being filed). Source-level, because those callers mock the filer in
 * their own tests. It reads ~1200 source files, so it is deferred from the verify scanner step (CI runs it).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('never-sized kinds are never filed with a size (#x0h3pe4)', () => {
  it('no non-test caller pairs kind task/feature with a size', () => {
    const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const offenders = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p); continue; }
        if (!/\.(mjs|cjs|js)$/.test(e.name) || /\.test\./.test(e.name)) continue;
        const src = readFileSync(p, 'utf8');
        if (/kind:\s*['"](task|feature)['"][^}]{0,300}?\bsize\s*:/.test(src)) offenders.push(p);
        if (/\bsize\s*:[^}]{0,300}?kind:\s*['"](task|feature)['"]/.test(src)) offenders.push(p);
      }
    };
    walk(scriptsDir);
    expect(offenders).toEqual([]);
  }, 60_000); // ~1200 files read synchronously: the 5s default flakes on a loaded host
});
