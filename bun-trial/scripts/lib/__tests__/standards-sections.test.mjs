// #70d — scoped check:standards runs only the sections whose declared inputs a touched file matches.
// Invariant under test: a section whose inputs include a touched file is NEVER skipped; one whose inputs
// match nothing touched IS skipped (and recorded); an unscoped run never skips anything.
import { describe, it, test, expect } from 'bun:test';
const __ORIG_URL = new URL('../../../../scripts/lib/__tests__/standards-sections.test.mjs', import.meta.url).href;
const __ORIG_FILE = new URL(__ORIG_URL).pathname;
const __ORIG_DIR = new URL('.', __ORIG_URL).pathname.replace(/\/$/, '');
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSectionGate, globToRegExp, matchesAny, SECTION_INPUTS, ALWAYS_TRIGGERS, SKIP_REASON,
} from '../../../../scripts/lib/standards-sections.mjs';
import { importClosure } from '../../../../scripts/lib/standards-cache.mjs';

const ROOT = resolve(dirname(fileURLToPath(__ORIG_URL)), '..', '..', '..');
const CHECK = join(ROOT, 'scripts', 'check-standards.mjs');

/** A concrete path that matches `glob` (replace each wildcard with a literal segment). */
const sampleFor = (glob) => glob.replace(/\*\*\//g, 'a/b/').replace(/\*\*/g, 'a/b.mjs').replace(/\*/g, 'x').replace(/\?/g, 'q');

describe('globToRegExp / matchesAny', () => {
  it('`**` crosses directories, `*` does not', () => {
    expect(globToRegExp('scripts/**').test('scripts/a/b/c.mjs')).toBe(true);
    expect(globToRegExp('scripts/**/*.mjs').test('scripts/x.mjs')).toBe(true);
    expect(globToRegExp('scripts/**/*.mjs').test('scripts/a/b/x.mjs')).toBe(true);
    expect(globToRegExp('scripts/**/*.mjs').test('scripts/a/x.cjs')).toBe(false);
    expect(globToRegExp('scripts/*.mjs').test('scripts/a/x.mjs')).toBe(false);
    expect(globToRegExp('**/package.json').test('package.json')).toBe(true);
    expect(globToRegExp('**/package.json').test('blocks/x/package.json')).toBe(true);
    expect(globToRegExp('backlog/**').test('backlogx/a.md')).toBe(false);
  });
  it('regex metacharacters in a glob are literal', () => {
    expect(matchesAny('scripts/lib/invariant-catalogue.json', ['scripts/lib/invariant-catalogue.json'])).toBe(true);
    expect(matchesAny('scripts/lib/invariant-catalogueXjson', ['scripts/lib/invariant-catalogue.json'])).toBe(false);
  });
});

describe('createSectionGate', () => {
  it('unscoped: every section runs and nothing is recorded', () => {
    const gate = createSectionGate({ scoped: false, touched: ['backlog/1-a.md'] });
    for (const id of Object.keys(SECTION_INPUTS)) expect(gate.shouldRun(id)).toBe(true);
    expect(gate.skipped).toEqual([]);
  });

  it('a section not in the registry always runs', () => {
    const gate = createSectionGate({ scoped: true, touched: ['backlog/1-a.md'] });
    expect(gate.shouldRun('not-a-declared-section')).toBe(true);
  });

  it('touching an ALWAYS_TRIGGERS file runs every section', () => {
    for (const t of ALWAYS_TRIGGERS) {
      const gate = createSectionGate({ scoped: true, touched: [t] });
      for (const id of Object.keys(SECTION_INPUTS)) expect(gate.shouldRun(id)).toBe(true);
    }
  });

  // The core safety property, over the REAL registry: every declared glob, and every file in every declared
  // impl closure, keeps its section running when touched.
  it.each(Object.entries(SECTION_INPUTS))('%s: a touched input is never skipped', (id, decl) => {
    for (const g of decl.globs) {
      const gate = createSectionGate({ scoped: true, touched: [sampleFor(g)], root: ROOT });
      expect(gate.shouldRun(id), `${id} via ${sampleFor(g)}`).toBe(true);
    }
    for (const entry of decl.impl) {
      for (const abs of importClosure(join(ROOT, entry)).keys()) {
        const rel = abs.slice(ROOT.length + 1);
        const gate = createSectionGate({ scoped: true, touched: [rel], root: ROOT });
        expect(gate.shouldRun(id), `${id} via impl ${rel}`).toBe(true);
      }
    }
  });

  it('an untouched section is skipped and recorded; a touched one is not', () => {
    const gate = createSectionGate({ scoped: true, touched: ['backlog/9999-x.md'], root: ROOT });
    expect(gate.shouldRun('14')).toBe(false);
    expect(gate.shouldRun('9a-rules')).toBe(true);
    expect(gate.skipped).toEqual(['14']);
  });

  it('dynamic inputs keep a section running; a throwing reader or closure fails toward running', () => {
    const inputs = { s: { globs: ['nothing/**'], impl: [] } };
    expect(createSectionGate({ scoped: true, touched: ['a/b.mjs'], inputs }).shouldRun('s', { dynamicInputs: () => ['a/b.mjs'] })).toBe(true);
    expect(createSectionGate({ scoped: true, touched: ['a/b.mjs'], inputs }).shouldRun('s', { dynamicInputs: () => { throw new Error('x'); } })).toBe(true);
    const bad = { s: { globs: ['nothing/**'], impl: ['scripts/lib/x.mjs'] } };
    expect(createSectionGate({ scoped: true, touched: ['a/b.mjs'], inputs: bad, closure: () => { throw new Error('unresolved'); } }).shouldRun('s')).toBe(true);
    expect(createSectionGate({ scoped: true, touched: ['a/b.mjs'], inputs }).shouldRun('s')).toBe(false);
  });
});

describe('check-standards.mjs wiring', () => {
  it('every gated section id is declared, and every declared id is gated', () => {
    const src = readFileSync(CHECK, 'utf8');
    const used = new Set([...src.matchAll(/sectionGate\.shouldRun\('([^']+)'/g)].map((m) => m[1]));
    expect([...used].sort()).toEqual(Object.keys(SECTION_INPUTS).sort());
  });

  // Real runs of the real gate on the real repo (slow: each is a full scoped check:standards).
  const run = (args) => JSON.parse(execFileSync(process.execPath, [CHECK, ...args, '--json'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  }));
  const card = `backlog/${readdirSync(join(ROOT, 'backlog')).filter((f) => f.endsWith('.md')).sort()[0]}`;

  it('backlog-only diff: code-tree sections are skipped and recorded; backlog-reading ones run', () => {
    const j = run(['--local', `--files=${card}`]);
    const skipped = j.summary.skippedSections;
    for (const id of ['14', '15b', '18', '19', '9c', '6d-ter-tree-scans']) expect(skipped[id]).toBe(SKIP_REASON);
    for (const id of ['9a-rules', '9a-prime', '9a-prime-ii']) expect(skipped[id]).toBeUndefined();
  }, 180_000);

  it('touching an enum-totality input runs section 14 (never skipped)', () => {
    const j = run(['--local', '--files=scripts/lib/verdict-totality.mjs']);
    expect(j.summary.skippedSections['14']).toBeUndefined();
    expect(j.summary.skippedSections['9a-rules']).toBe(SKIP_REASON);
  }, 180_000);
});
