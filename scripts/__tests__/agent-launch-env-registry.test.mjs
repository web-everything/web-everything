import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const registry = JSON.parse(readFileSync(join(root, 'scripts/lib/agent-launch-env-registry.json'), 'utf8'));
// Same bounded rg inventory used to generate the registry. Include literal bracket and optional reads,
// prose examples conservatively too; exclude test/spec files and test/fixture directory trees.
const reads = /\b(?:process\.env|env)(?:\??\.([A-Za-z_][A-Za-z0-9_]*)|(?:\?\.)?\s*\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/g;
function namesIn(text) {
  return [...new Set([...text.matchAll(reads)].map(match => match[1] ?? match[2]))].sort();
}
function ruleFor(name) {
  return Object.hasOwn(registry, name) ? registry[name]
    : Object.entries(registry).find(([pattern]) => pattern.endsWith('*') && name.startsWith(pattern.slice(0, -1)))?.[1];
}
const unclassified = names => names.filter(name => !ruleFor(name));
function inventoryNames(result) {
  if (result.error || result.status !== 0) {
    throw Error(`env inventory incomplete; repair rg/read access or split the inventory for human review: ${result.error?.message ?? result.stderr}`);
  }
  const names = namesIn(result.stdout);
  if (!names.length) throw Error('env inventory empty; repair the scan scope before reviewing drift');
  return names;
}

describe('agent environment registry drift', () => {
  it('classifies every literal env read under scripts and .claude/skills; unreadable or oversized evidence fails', () => {
    const result = spawnSync('rg', ['-n', '-o', '--hidden', '--follow',
      '--glob', '!**/{__tests__,tests,fixtures,node_modules,.git}/**', '--glob', '!**/*.{test,spec}.*',
      reads.source, 'scripts/', '.claude/skills/'], { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    expect(unclassified(inventoryNames(result))).toEqual([]);
  });
  it('refuses failed, oversized and empty scan evidence with an operator-visible fallback', () => {
    for (const result of [{ status: 2, stderr: 'unreadable' },
      { status: null, error: Error('spawnSync rg ENOBUFS'), stdout: 'env.USER' }]) {
      expect(() => inventoryNames(result)).toThrow(/incomplete.*repair.*human review/);
    }
    expect(() => inventoryNames({ status: 0, stdout: '' })).toThrow(/empty.*repair/);
  });
  it('recognizes exact dot, bracket and optional syntax and rejects a newly introduced unknown name', () => {
    expect(namesIn(`process.env.A; process.env['B']; process.env["C"]; env.D; env?.E; env['F']; env?.['G']; process.env [ 'H' ];`))
      .toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
    expect(unclassified(namesIn('env.SEC1_NEW_UNCLASSIFIED_ENV'))).toEqual(['SEC1_NEW_UNCLASSIFIED_ENV']);
  });
  it('uses only the three classes, reasons, supported validators and exact or trailing-prefix names', () => {
    for (const [name, rule] of Object.entries(registry)) {
      expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*\*?$/);
      expect(Object.keys(rule).every(key => ['class', 'why', 'value', 'restrictiveValues'].includes(key))).toBe(true);
      // Value-gated vars are 'drop' by default; only their listed tightening values are forwarded.
      if (rule.restrictiveValues !== undefined) {
        expect(rule.class).toBe('drop');
        expect(rule.restrictiveValues.every(v => typeof v === 'string' && v === v.trim().toLowerCase() && v)).toBe(true);
      }
      expect(['forward-restrictive', 'forward', 'drop']).toContain(rule.class);
      expect(typeof rule.why === 'string' && rule.why.trim().length > 0).toBe(true);
      if (rule.value !== undefined) expect(rule.value).toBe('absolute-path');
    }
    expect(registry.LANE_POOL_ROOT.value).toBe('absolute-path');
  });
  it('drops known executable, shell, escape-hatch and credential controls', () => {
    for (const name of ['NODE_OPTIONS', 'BASH_ENV', 'ENV', 'ZDOTDIR', 'PATH', 'HOME', 'DYLD_INSERT_LIBRARIES',
      'LD_PRELOAD', 'WE_ALLOW_REAL_LANE_POOL_IN_TESTS', 'MAIN_PUSH_OK', 'WE_LAND_UNVERIFIED', 'GH_TOKEN']) {
      expect(registry[name].class, name).toBe('drop');
    }
  });
  it('preserves finding-1 identities and drops the value-dependent personal-auth relaxation with its reason', () => {
    for (const name of ['WE_GH_DAEMON_CALLER', 'XPC_SERVICE_NAME', 'GH_CALLER', 'WE_GH_THROTTLE_CALLER',
      'VITEST', 'WE_UNDER_TEST', 'LANE_POOL_ROOT']) expect(registry[name].class, name).toBe('forward-restrictive');
    expect(registry.WE_GH_AUTH_PERSONAL_FALLBACK).toMatchObject({ class: 'drop', restrictiveValues: ['refuse'] });
    expect(registry.WE_GITHUB_AUTH).toMatchObject({ class: 'drop', restrictiveValues: ['app'] });
  });
});
