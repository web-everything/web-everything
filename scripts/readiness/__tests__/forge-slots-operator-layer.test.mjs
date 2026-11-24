// @vitest-environment node
import {afterEach, describe, expect, it} from 'vitest';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {mergeOperatorHosts} from '../forge-slots.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const mjs = join(here, '..', 'forge-slots.mjs');
const repoSettings = join(here, '..', '..', 'settings', 'forge-slots.json');
const scratch = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, {recursive: true, force: true}); });

describe('forge-slots sensitive leaves live in the operator layer', () => {
  it('the repo settings file carries no host names', () => {
    const parsed = JSON.parse(readFileSync(repoSettings, 'utf8'));
    expect(Object.keys(parsed.forgeSlots.hosts)).toEqual([]);
  });
  it('merges operator hosts over the repo settings', () => {
    const merged = mergeOperatorHosts({forgeSlots: {default: 8, hosts: {}}}, {hosts: {alpha: 12}});
    expect(merged.forgeSlots.hosts).toEqual({alpha: 12});
    expect(merged.forgeSlots.default).toBe(8);
  });
  it('absent operator layer leaves the neutral default', () => {
    const s = {forgeSlots: {default: 8, hosts: {}}};
    expect(mergeOperatorHosts(s, undefined)).toEqual(s);
  });
  it('refuses a malformed operator layer instead of falling back silently', () => {
    const s = {forgeSlots: {default: 8, hosts: {}}};
    expect(() => mergeOperatorHosts(s, {hosts: []})).toThrow('forgeSlots operator hosts');
    expect(() => mergeOperatorHosts(s, 'x')).toThrow('forgeSlots operator hosts');
    expect(() => mergeOperatorHosts(s, null)).toThrow('forgeSlots operator hosts');
    expect(() => mergeOperatorHosts({forgeSlots: {default: 8, hosts: []}}, {hosts: {a: 2}})).toThrow('must be an object');
    expect(() => mergeOperatorHosts({forgeSlots: {default: 8, hosts: {b: 0}}}, {hosts: {b: 2}})).toThrow();
  });
  it('CLI resolves a host size from the operator file and the default when absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-op-')); scratch.push(dir);
    const file = join(dir, 'prefs.json');
    writeFileSync(file, JSON.stringify({forgeSlots: {hosts: {alpha: 11}}}));
    const run = (prefs) => spawnSync(process.execPath, [mjs], {
      encoding: 'utf8', timeout: 10000,
      env: {PATH: process.env.PATH, FORGE_HOST: 'alpha', WE_PLATFORM_PREFERENCES_FILE: prefs},
    });
    const withFile = run(file);
    expect(withFile.status, withFile.stderr).toBe(0);
    expect(withFile.stdout).toBe('11\n');
    const without = run(join(dir, 'missing.json'));
    expect(without.stdout).toBe('8\n');
  });
  it('CLI refuses an unreadable operator file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-op-')); scratch.push(dir);
    const file = join(dir, 'prefs.json');
    writeFileSync(file, '{not json');
    const r = spawnSync(process.execPath, [mjs], {
      encoding: 'utf8', timeout: 10000,
      env: {PATH: process.env.PATH, FORGE_HOST: 'alpha', WE_PLATFORM_PREFERENCES_FILE: file},
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('operator layer');
  });
});
