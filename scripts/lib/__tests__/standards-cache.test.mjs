import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileKeys, ruleVersion, resetClosureMemo, openSectionCache, cacheEnabled } from '../standards-cache.mjs';

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

  it('an unresolvable import means no version (cache off)', () => {
    const d = mk();
    writeFileSync(join(d, 'main.mjs'), "import x from './missing.mjs';\n");
    expect(ruleVersion('s', [join(d, 'main.mjs')])).toBeNull();
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
