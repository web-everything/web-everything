/**
 * @file scripts/lib/__tests__/static-selection-edges.test.mjs
 * @description Tier-1 proof of the SHADOW-ONLY static selection edges (AO S1, #7121 rescope). The new module only
 *   informs a `shadow` field; it never changes `mode`, `tests` or `complete`, and related-test-selection.mjs stays
 *   byte-identical to main (negative tests per merge-path-checklist lines 2 and 7).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';import { stripComments, staticEdgesOf, shadowSelection, MAX_INPUT_BYTES } from '../static-selection-edges.mjs';
import { resolvedImportsOf } from '../related-test-selection.mjs';
import { selectTests, SELECTION_FLAG } from '../../readiness/test-selection.mjs';

const FILES = new Set(['scripts/lib/x.mjs', 'scripts/lib/a.mjs', 'scripts/lib/b.mjs', 'scripts/cli/run.mjs']);

describe('static-selection-edges: edges', () => {
  it('finds an import edge behind a multi-line comment between from and the specifier', () => {
    const text = 'import {x} from /* multi\nline */ "./x.mjs";';
    expect(staticEdgesOf('scripts/lib/a.mjs', text, FILES).edges).toEqual(['scripts/lib/x.mjs']);
  });
  it('ignores an import that only appears inside a comment', () => {
    const text = '// import "./x.mjs"\n/* import "./b.mjs" */\n';
    expect(staticEdgesOf('scripts/lib/a.mjs', text, FILES).edges).toEqual([]);
  });
  it('does not treat comment markers inside strings/templates as comments', () => {
    expect(stripComments('const u = "http://x"; import "./x.mjs";')).toContain('import "./x.mjs"');
    expect(stripComments('const t = `/* ${1} */`; // gone\nok')).toContain('/* ${1} */');
    expect(stripComments('a // gone\nb')).not.toContain('gone');
  });
  it('adds spawn and read edges to repo files named by string literals', () => {
    const text = "execFileSync('node', ['scripts/cli/run.mjs']); readFileSync('scripts/lib/b.mjs');";
    const { edges } = staticEdgesOf('scripts/lib/a.mjs', text, FILES);
    expect(edges).toContain('scripts/cli/run.mjs');
    expect(edges).toContain('scripts/lib/b.mjs');
  });
  it('adds alias edges from a supplied alias map', () => {
    const text = 'import y from "@lib/x.mjs";';
    const r = staticEdgesOf('scripts/cli/run.mjs', text, FILES, { aliases: { '@lib/': 'scripts/lib/' } });
    expect(r.edges).toEqual(['scripts/lib/x.mjs']);
  });
});

describe('static-selection-edges: bounds', () => {
  it('scans a 1 MB adversarial input in under 200 ms (linear) and marks it partial (over the cap)', () => {
    const evil = 'import ' + ' '.repeat(1024 * 1024) + 'from';
    const t = Date.now();
    const r = staticEdgesOf('scripts/lib/a.mjs', evil, FILES);
    expect(Date.now() - t).toBeLessThan(200);
    expect(r.partial).toBe(true);
  });
  it('a 400 KB adversarial input under the cap is also linear', () => {
    const evil = '/*'.repeat(100000) + "'".repeat(100000) + 'from '.repeat(20000);
    const t = Date.now();
    const r = staticEdgesOf('scripts/lib/a.mjs', evil, FILES);
    expect(Date.now() - t).toBeLessThan(200);
    expect(r.partial).toBe(false);
  });
  it('cap is 512 KB', () => expect(MAX_INPUT_BYTES).toBe(512 * 1024));
  it('an unreadable file marks the shadow partial', () => {
    const r = shadowSelection({
      changedFiles: ['scripts/lib/x.mjs'],
      files: ['scripts/lib/x.mjs', 'scripts/lib/a.mjs'],
      readFile: () => { throw new Error('ENOENT'); },
    });
    expect(r.partial).toBe(true);
  });
  it('shadowSelection selects tests through static edges', () => {
    const contents = { 'scripts/lib/__tests__/a.test.mjs': 'import /* c\n */ "../x.mjs"', 'scripts/lib/x.mjs': '' };
    const r = shadowSelection({
      changedFiles: ['scripts/lib/x.mjs'],
      files: Object.keys(contents),
      readFile: (f) => contents[f],
    });
    expect(r.tests).toEqual(['scripts/lib/__tests__/a.test.mjs']);
    expect(r.partial).toBe(false);
  });
});

describe('shadow never changes the decision (checklist 7)', () => {
  const runGit = (args) => (args[0] === 'merge-base' ? 'abc\n' : 'scripts/lib/x.mjs\ndocs/a.md\n');
  for (const flag of ['1', '0']) {
    it(`selectTests mode/tests/complete identical with shadow on and off (flag=${flag})`, () => {
      const env = { [SELECTION_FLAG]: flag };
      const off = selectTests({ runGit, env });
      const on = selectTests({ runGit, env, shadow: () => ({ tests: ['t.test.mjs'], partial: false }) });
      expect(on.shadow).toEqual({ tests: ['t.test.mjs'], partial: false });
      const { shadow, ...rest } = on;
      expect(rest).toEqual(off);
      expect('shadow' in off).toBe(false);
    });
  }
  it('a throwing shadow is swallowed into a partial shadow and changes nothing', () => {
    const off = selectTests({ runGit, env: {} });
    const on = selectTests({ runGit, env: {}, shadow: () => { throw new Error('boom'); } });
    expect(on.shadow.partial).toBe(true);
    const { shadow, ...rest } = on;
    expect(rest).toEqual(off);
  });
});

describe('related-test-selection stays byte-identical to main (checklist 2)', () => {
  it('file bytes equal origin/main', () => {
    // sha256 of the file on main at the time this change was written (pinned: no live git access in tests).
    const here = readFileSync('scripts/lib/related-test-selection.mjs', 'utf8');
    expect(createHash('sha256').update(here).digest('hex')).toBe('2ffa9cc250e7a89624dfa0152e41d73d8d38ccce3c96070012cf1aa194c2c0f3');
  });
  it('resolvedImportsOf snapshot: unchanged behaviour on main regex', () => {
    const files = new Set(['a/x.mjs', 'a/y.mjs', 'a/z.mjs']);
    const text = 'import a from "./x.mjs"; const m = await import("./y.mjs"); import "./z.mjs"; import {q} from /* c\n */ "./x.mjs"';
    expect(resolvedImportsOf('a/t.test.mjs', text, files).sort()).toEqual(['a/x.mjs', 'a/y.mjs', 'a/z.mjs']);
    // main's regex does not see the commented gap form:
    expect(resolvedImportsOf('a/t.test.mjs', 'import {q} from /* c\n */ "./x.mjs"', files)).toEqual([]);
  });
});
