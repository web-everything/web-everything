import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileKeys, ruleVersion, resetClosureMemo, openSectionCache, cacheEnabled, gitGrepCached } from '../standards-cache.mjs';

const mk = () => mkdtempSync(join(tmpdir(), 'stdcache-'));

describe('standards-cache', () => {
  beforeEach(() => resetClosureMemo());

  it('same blob gives the same key; edits change it', () => {
    const r = mk();
    const g = (...a) => execFileSync('git', a, { cwd: r });
    g('init', '-q'); writeFileSync(join(r, 'a.txt'), 'x'); writeFileSync(join(r, 'b.txt'), 'x');
    g('add', '.');
    const k = fileKeys(r);
    expect(k.get('a.txt')).toBe(k.get('b.txt'));
    writeFileSync(join(r, 'a.txt'), 'y'); writeFileSync(join(r, 'c.txt'), 'x');
    const k2 = fileKeys(r);
    expect(k2.get('a.txt')).not.toBe(k.get('a.txt'));
    expect(k2.get('c.txt')).toBe(k.get('b.txt'));
    expect(fileKeys(r).get('b.txt')).toBe(k.get('b.txt'));
  });

  it('an edit to an imported helper changes the rule version', () => {
    const d = mk();
    writeFileSync(join(d, 'main.mjs'), "import { h } from './helper.mjs';\n");
    writeFileSync(join(d, 'helper.mjs'), "export const h = 1;\n");
    const v1 = ruleVersion('s', [join(d, 'main.mjs')]);
    expect(ruleVersion('s', [join(d, 'main.mjs')])).toBe(v1);
    expect(ruleVersion('t', [join(d, 'main.mjs')])).not.toBe(v1);
    writeFileSync(join(d, 'helper.mjs'), "export const h = 2;\n");
    resetClosureMemo();
    expect(ruleVersion('s', [join(d, 'main.mjs')])).not.toBe(v1);
  });

  it('an edit to an imported JSON file changes the rule version', () => {
    const d = mk();
    writeFileSync(join(d, 'main.mjs'), "import rules from './rules.json' with { type: 'json' };\n");
    writeFileSync(join(d, 'rules.json'), '{"a":1}');
    const v1 = ruleVersion('s', [join(d, 'main.mjs')]);
    expect(v1).toBeTypeOf('string');
    writeFileSync(join(d, 'rules.json'), '{"a":2}');
    resetClosureMemo();
    expect(ruleVersion('s', [join(d, 'main.mjs')])).not.toBe(v1);
  });

  it('an imported non-file target (directory) means no version, never a silently unhashed dependency', () => {
    const d = mk();
    mkdirSync(join(d, 'data'));
    writeFileSync(join(d, 'main.mjs'), "import x from './data';\n");
    expect(ruleVersion('s', [join(d, 'main.mjs')])).toBeNull();
  });

  it('an unresolvable import means no version (cache off)', () => {
    const d = mk();
    writeFileSync(join(d, 'main.mjs'), "import x from './missing.mjs';\n");
    expect(ruleVersion('s', [join(d, 'main.mjs')])).toBeNull();
  });

  it('prose that mentions an import is not followed; the real check-standards closure resolves', () => {
    const d = mk();
    writeFileSync(join(d, 'main.mjs'), "// see import x from './nope.mjs'\n/* wrapped from './ai-pr-\n authorship.mjs' */\n");
    expect(ruleVersion('s', [join(d, 'main.mjs')])).toBeTypeOf('string');
    expect(ruleVersion('s', ['scripts/check-standards.mjs', 'scripts/check-standards-rules.mjs'])).toBeTypeOf('string');
  });

  it('CI=1 is always a miss, and the setting disables it', () => {
    const dir = mk();
    const on = { WE_STANDARDS_CACHE_DIR: dir };
    const c = openSectionCache({ section: 's', version: 'v', env: on });
    c.record('k', [{ m: 1 }]); c.commit();
    expect(openSectionCache({ section: 's', version: 'v', env: on }).lookup('k')).toEqual([{ m: 1 }]);
    for (const env of [{ ...on, CI: '1' }, { ...on, WE_STANDARDS_CACHE: '0' }]) {
      expect(cacheEnabled(env)).toBe(false);
      expect(openSectionCache({ section: 's', version: 'v', env }).lookup('k')).toBeUndefined();
    }
    const ci = openSectionCache({ section: 's2', version: 'v', env: { ...on, CI: '1' } });
    ci.record('k', []); ci.commit();
    expect(existsSync(join(dir, 'v', 's2.json'))).toBe(false);
  });

  it('a different version misses; a crashed section writes nothing', () => {
    const dir = mk(); const env = { WE_STANDARDS_CACHE_DIR: dir };
    const c = openSectionCache({ section: 's', version: 'v1', env });
    c.record('k', []); c.abort(); c.commit();
    expect(readdirSync(dir)).toEqual([]);
    const d = openSectionCache({ section: 's', version: 'v1', env }); d.record('k', []); d.commit();
    expect(openSectionCache({ section: 's', version: 'v2', env }).lookup('k')).toBeUndefined();
  });
});

describe('gitGrepCached (70c)', () => {
  const setup = () => {
    const r = mk();
    const g = (...a) => execFileSync('git', a, { cwd: r });
    g('init', '-q');
    mkdirSync(join(r, 'skip'));
    writeFileSync(join(r, 'a.txt'), 'x\nhit one\nhit two\n');
    writeFileSync(join(r, 'b:c.txt'), 'hit colon-name\n');
    writeFileSync(join(r, 'skip', 'z.txt'), 'hit skipped\n');
    writeFileSync(join(r, 'n.txt'), 'nothing\n');
    g('add', '.');
    const entry = join(r, 'rule.mjs');
    writeFileSync(entry, 'export const a = 1;\n');
    return { r, entry, cache: mk() };
  };
  const plain = (r) => execFileSync('git', ['grep', '--threads=1', '-nE', 'hit', '--', '.', ':!skip'], { cwd: r, encoding: 'utf8' }).split('\n').filter(Boolean);
  const run = (s, extra = {}, stats = []) => gitGrepCached({
    section: 'g', entries: [s.entry], root: s.r, pattern: 'hit', exclude: (f) => f.startsWith('skip/'),
    getKeys: () => fileKeys(s.r), env: { WE_STANDARDS_CACHE_DIR: s.cache, ...extra }, onStats: (l) => stats.push(l),
  });

  it('cold == warm == plain git grep; an edit re-greps only that file; off/CI return null', () => {
    const s = setup();
    resetClosureMemo();
    const st = [];
    expect(run(s, {}, st)).toEqual(plain(s.r));
    expect(run(s, {}, st)).toEqual(plain(s.r));
    expect(st[0]).toMatch(/0 hit \/ 3 miss/);
    expect(st[1]).toMatch(/3 hit \/ 0 miss/);
    writeFileSync(join(s.r, 'n.txt'), 'hit now\n');
    expect(run(s, {}, st)).toEqual(plain(s.r));
    expect(st[2]).toMatch(/2 hit \/ 1 miss/);
    expect(run(s, { WE_STANDARDS_CACHE: '0' })).toBeNull();
    expect(run(s, { CI: '1' })).toBeNull();
  });

  it('a changed rule module (pattern host) invalidates the cache', () => {
    const s = setup();
    const st = [];
    run(s, {}, st);
    writeFileSync(s.entry, 'export const a = 2;\n');
    resetClosureMemo();
    run(s, {}, st);
    expect(st[1]).toMatch(/0 hit/);
  });
});
