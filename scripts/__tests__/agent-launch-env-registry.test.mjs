import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildAgentInvocation } from '../lib/agent-launch.mjs';
import { clearEnv, clearRestrictiveEnv } from './fixtures/agent-launch-env.mjs';
import { resolveTmpLeakPolicy, finishRunTmpRoot } from '../lib/test-tmp-root.mjs';
import { resolveGhCap, resolveHeaderWaitCapMs, retryBackoffMs } from '../lib/gh-throttle.mjs';
import { ghExecOptions, loadGhThrottleSettings } from '../lib/gh-throttle-holders.mjs';
import { scanScope } from '../lib/repo-scan-tests.mjs';
import { scanDiffBranchCoverage } from '../lib/diff-branch-coverage.mjs';
import { resolveSlotSpan } from '../readiness/heavy-admission.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const registry = JSON.parse(readFileSync(join(root, 'scripts/lib/agent-launch-env-registry.json'), 'utf8'));
// Same bounded inventory used to generate the registry. Include literal bracket and optional reads,
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
const hasValueDecision = rule => !/value[\s-]*depend/i.test(rule.why)
  || [rule.restrictiveValues, rule.restrictivePrefixes].some(v => Array.isArray(v) && v.length > 0)
  || Boolean(rule.tighterThan) || rule.relaxOnly === true;
function inventoryNames(result) {
  if (result.error || result.status !== 0) {
    throw Error(`env inventory incomplete; repair read access or split the inventory for human review: ${result.error?.message ?? result.stderr}`);
  }
  const names = namesIn(result.stdout);
  if (!names.length) throw Error('env inventory empty; repair the scan scope before reviewing drift');
  return names;
}

// Pure-Node inventory (no rg: the remote test hosts don't have it). Same scope as the generator: follows
// symlinked skills, skips test/fixture trees, test/spec files and binary files; incomplete reads fail closed.
const SKIP_DIRS = new Set(['__tests__', 'tests', 'fixtures', 'node_modules', '.git']);
const MAX_INVENTORY_FILE_BYTES = 16 * 1024 * 1024;
function scanTree(dirs, scanRoot = root) {
  const seen = new Set(), chunks = [];
  try {
    const walk = dir => {
      const real = realpathSync(dir);
      if (seen.has(real)) return;
      seen.add(real);
      for (const name of readdirSync(dir)) {
        const path = join(dir, name), stat = statSync(path);
        if (stat.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(path); continue; }
        if (!stat.isFile() || /\.(test|spec)\./.test(name)) continue;
        if (stat.size > MAX_INVENTORY_FILE_BYTES) throw Error(`oversized env inventory file: ${path} (${stat.size} bytes; limit ${MAX_INVENTORY_FILE_BYTES})`);
        const text = readFileSync(path, 'utf8');
        if (!text.includes('\0')) chunks.push(text);
      }
    };
    for (const dir of dirs) walk(join(scanRoot, dir));
  } catch (error) { return { status: 2, error }; }
  return { status: 0, stdout: chunks.join('\n') };
}

function validRule(rule) {
  if (!['forward-restrictive', 'forward', 'drop'].includes(rule.class)
    || typeof rule.why !== 'string' || !rule.why.trim()
    || Object.keys(rule).some(k => !['class', 'why', 'value', 'restrictiveValues', 'restrictivePrefixes', 'tighterThan', 'precedence', 'relaxOnly', 'ambientOnly'].includes(k))) return false;
  const predicate = rule.restrictiveValues !== undefined || rule.restrictivePrefixes !== undefined || rule.tighterThan !== undefined;
  const restrictive = rule.class === 'forward-restrictive' || predicate;
  if (predicate && rule.class === 'forward') return false;
  if (rule.value !== undefined && (rule.value !== 'absolute-path' || !restrictive || predicate)) return false;
  if (rule.precedence !== undefined && (!restrictive || !['ambient', 'bag'].includes(rule.precedence))) return false;
  if (rule.ambientOnly !== undefined && (rule.ambientOnly !== true || rule.class !== 'forward-restrictive' || rule.precedence !== 'ambient')) return false;
  if (rule.relaxOnly !== undefined && (rule.relaxOnly !== true || rule.class !== 'drop' || predicate)) return false;
  for (const key of ['restrictiveValues', 'restrictivePrefixes']) {
    const values = rule[key];
    if (values !== undefined && (!Array.isArray(values) || !values.length || new Set(values).size !== values.length
      || !values.every(v => typeof v === 'string' && v && v === v.trim()
        && (key !== 'restrictiveValues' || v === v.toLowerCase())))) return false;
  }
  if (rule.tighterThan !== undefined) {
    const t = rule.tighterThan;
    if (!t || typeof t !== 'object' || Array.isArray(t) || rule.restrictiveValues || rule.restrictivePrefixes
      || Object.keys(t).some(k => !['default', 'unit', 'evidence', 'minimum', 'zeroIsStrict'].includes(k))
      || !Number.isFinite(t.default) || t.default <= 0 || !['count', 'bytes', 'cpus'].includes(t.unit)
      || typeof t.evidence !== 'string' || !/^[\w./-]+:\d+$/.test(t.evidence)
      || (t.zeroIsStrict !== undefined && (t.zeroIsStrict !== true || t.minimum !== undefined))
      || (t.minimum !== undefined && (!Number.isFinite(t.minimum) || t.minimum <= 0 || t.minimum >= t.default))) return false;
  }
  return true;
}
beforeEach(() => clearRestrictiveEnv(registry));
afterEach(() => vi.unstubAllEnvs());

describe('agent environment registry drift', () => {
  it('classifies every literal env read under scripts and .claude/skills; unreadable or oversized evidence fails', () => {
    expect(unclassified(inventoryNames(scanTree(['scripts', '.claude/skills'])))).toEqual([]);
  });
  it('refuses failed, oversized and empty scan evidence with an operator-visible fallback', () => {
    for (const result of [{ status: 2, stderr: 'unreadable' },
      { status: null, error: Error('spawnSync rg ENOBUFS'), stdout: 'env.USER' }]) {
      expect(() => inventoryNames(result)).toThrow(/incomplete.*repair.*human review/);
    }
    expect(() => inventoryNames({ status: 0, stdout: '' })).toThrow(/empty.*repair/);
  });
  it('scanTree refuses a file above 16 MiB, names it, and requires repair or human review', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-env-inventory-'));
    try {
      const path = join(dir, 'oversized.mjs');
      writeFileSync(path, Buffer.alloc(MAX_INVENTORY_FILE_BYTES + 1, 'a'));
      const result = scanTree(['.'], dir);
      expect(result.status).toBe(2);
      expect(result.error.message).toContain(path);
      expect(result.error.message).toMatch(/oversized/);
      expect(result).not.toHaveProperty('stdout');
      expect(() => inventoryNames(result)).toThrow(/incomplete.*repair.*human review/);
      writeFileSync(path, 'env.USER;' + ' '.repeat(MAX_INVENTORY_FILE_BYTES - 9));
      expect(inventoryNames(scanTree(['.'], dir))).toEqual(['USER']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('recognizes exact dot, bracket and optional syntax and rejects a newly introduced unknown name', () => {
    expect(namesIn(`process.env.A; process.env['B']; process.env["C"]; env.D; env?.E; env['F']; env?.['G']; process.env [ 'H' ];`))
      .toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
    expect(unclassified(namesIn('env.SEC1_NEW_UNCLASSIFIED_ENV'))).toEqual(['SEC1_NEW_UNCLASSIFIED_ENV']);
  });
  it('uses valid restrictive schemas, validators, and exact or trailing-prefix names', () => {
    for (const [name, rule] of Object.entries(registry)) {
      expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*\*?$/);
      expect(validRule(rule), name).toBe(true);
      expect(hasValueDecision(rule), name).toBe(true);
    }
    expect(registry.LANE_POOL_ROOT).toMatchObject({ value: 'absolute-path', precedence: 'bag' });
    expect(registry.WE_GH_THROTTLE_LOCK_ROOT).toMatchObject({ value: 'absolute-path', precedence: 'ambient' });
    for (const name of ['DIFF_COVERAGE_BASE', 'VERIFY_SCAN_FILES']) {
      expect(registry[name]).toMatchObject({ class: 'forward-restrictive', precedence: 'ambient', ambientOnly: true });
    }
    expect(validRule({ class: 'drop', why: 'limit', tighterThan: { default: 50, unit: 'count', evidence: 'a:1', zeroIsStrict: true } })).toBe(true);
  });
  it('rejects malformed, incomplete, contradictory and unknown restrictive schemas', () => {
    const base = { class: 'forward-restrictive', why: 'identity' };
    for (const invalid of [
      { ...base, precedence: 'caller' }, { ...base, value: 'path' }, { ...base, unknown: true },
      ...[false, 'true', 1, null].map(ambientOnly => ({ ...base, precedence: 'ambient', ambientOnly })),
      { ...base, ambientOnly: true }, { ...base, precedence: 'bag', ambientOnly: true },
      ...['forward', 'drop'].map(cls => ({ ...base, class: cls, precedence: 'ambient', ambientOnly: true })),
      { ...base, restrictivePrefixes: [] }, { ...base, restrictivePrefixes: [''] },
      { ...base, restrictivePrefixes: [' com.we.'] }, { ...base, restrictiveValues: [1] },
      { ...base, restrictiveValues: ['ON'] }, { ...base, relaxOnly: true },
      ...[0, -1, Infinity, '2'].map(n => ({ ...base, tighterThan: { default: n, unit: 'count', evidence: 'a:1' } })),
      ...[{}, { default: 2 }, { default: 2, unit: 'seconds', evidence: 'a:1' },
        { default: 2, unit: 'count', evidence: 'unknown' }, { default: 2, unit: 'count', evidence: 'a:1', extra: true },
        { default: 2, unit: 'count', evidence: 'a:1', minimum: 3 },
        ...[false, 'true', 1, null].map(zeroIsStrict => ({ default: 2, unit: 'count', evidence: 'a:1', zeroIsStrict })),
        { default: 2, unit: 'count', evidence: 'a:1', minimum: 1, zeroIsStrict: true }].map(tighterThan => ({ ...base, tighterThan })),
      { ...base, restrictiveValues: ['1'], tighterThan: { default: 2, unit: 'count', evidence: 'a:1' } },
    ]) expect(validRule(invalid), JSON.stringify(invalid)).toBe(false);
  });
  it('requires an explicit tightening or relax-only decision for every value-dependent reason', () => {
    for (const [name, rule] of Object.entries(registry)) expect(hasValueDecision(rule), name).toBe(true);
    expect(hasValueDecision({ why: 'Value-dependent: 1 enables isolation' })).toBe(false);
    expect(hasValueDecision({ why: 'Value dependence: policy changes', relaxOnly: false })).toBe(false);
    expect(hasValueDecision({ why: 'Value-dependent', restrictiveValues: [] })).toBe(false);
    expect(hasValueDecision({ why: 'Value-dependent', restrictiveValues: ['1'] })).toBe(true);
    expect(hasValueDecision({ why: 'Value-dependent: no value tightens', relaxOnly: true })).toBe(true);
  });
  it('pins container isolation to the exact enabling strings accepted by heavy-admission', () => {
    for (const name of ['WE_HEAVY_ADMISSION_CONTAINER', 'WE_HEAVY_ADMISSION_CONTAINER_NODE_MODULES']) {
      expect(registry[name]).toMatchObject({ class: 'drop', restrictiveValues: ['1'] });
      expect(registry[name].why).toMatch(/scripts\/readiness\/heavy-admission\.mjs:\d+/);
    }
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


// Enumerate every restrictive rule, not just the variables named in an audit finding.
const restrictions = Object.entries(registry).filter(([, r]) => r.class === 'forward-restrictive'
  || r.restrictiveValues || r.restrictivePrefixes || r.tighterThan);
const childEnv = inheritEnv => buildAgentInvocation({ agent: 'claude', cwd: root, print: true, inheritEnv },
  { resolveBinary: () => process.execPath }).options.env;
describe('exhaustive restrictive registry projection', () => {
  it.each([
    ['DIFF_COVERAGE_BASE', 'sec1-nonexistent-coverage-base', 'HEAD'],
    ['VERIFY_SCAN_FILES', '["parent.mjs"]', '["bag.mjs"]'],
    ['WE_DAEMON_OVERLAY_STACK_BASES', '{"topic":"parent"}', '{}'],
    ['FAKE_GH_FIXTURE', 'parent-fixture', 'bag-fixture'],
    ['DELIVERY_SESSION', 'parent-session', 'bag-session'],
    ['WE_DAEMON_VERSIONS_CLONES_ROOT', '/parent/clones', '/bag/clones'],
    ['WE_GUARD_ORIGIN', 'https://example.invalid/parent.git', 'https://example.invalid/bag.git'],
  ])('preserves the parent check/base/scope for %s', (name, parent, bag) => {
    expect(registry[name]).toMatchObject({ class: 'forward-restrictive', precedence: 'ambient' });
    if (registry[name].ambientOnly) expect(childEnv({ [name]: parent })).not.toHaveProperty(name);
    else expect(childEnv({ [name]: parent })[name]).toBe(parent);
    vi.stubEnv(name, parent);
    for (const inheritEnv of [{}, { [name]: '' }, { [name]: bag }]) expect(childEnv(inheritEnv)[name]).toBe(parent);
  });
  it('rejects bag-only empty scan scopes instead of silently skipping default verification', () => {
    for (const ambient of [undefined, '']) {
      if (ambient === undefined) clearEnv('VERIFY_SCAN_FILES');
      else vi.stubEnv('VERIFY_SCAN_FILES', ambient);
      for (const value of ['[]', '["caller-selected.mjs"]']) {
        const env = childEnv({ VERIFY_SCAN_FILES: value });
        expect(env).not.toHaveProperty('VERIFY_SCAN_FILES');
        expect(scanScope(env)).toBe(null);
      }
    }
  });
  it('rejects bag-only HEAD and other comparison-base overrides without ambient evidence', () => {
    for (const ambient of [undefined, '']) {
      if (ambient === undefined) clearEnv('DIFF_COVERAGE_BASE');
      else vi.stubEnv('DIFF_COVERAGE_BASE', ambient);
      for (const value of ['HEAD', 'refs/heads/caller-selected', 'sec1-nonexistent-coverage-base']) {
        expect(childEnv({ DIFF_COVERAGE_BASE: value })).not.toHaveProperty('DIFF_COVERAGE_BASE');
      }
    }
  });
  it('keeps invalid-base coverage failing and the parent scan scope pinned in the actual readers', () => {
    vi.stubEnv('DIFF_COVERAGE_BASE', 'sec1-nonexistent-coverage-base');
    vi.stubEnv('VERIFY_SCAN_FILES', '["parent.mjs"]');
    const env = childEnv({ DIFF_COVERAGE_BASE: 'HEAD', VERIFY_SCAN_FILES: '[]' });
    expect(scanDiffBranchCoverage(root, { base: env.DIFF_COVERAGE_BASE })).toMatchObject({ status: 'fail', base: 'sec1-nonexistent-coverage-base' });
    expect(scanScope(env)).toEqual(new Set(['parent.mjs']));
  });
  it.each(Object.entries(registry).filter(([, r]) => r.class === 'forward-restrictive'
    && !r.value && !r.restrictiveValues && !r.restrictivePrefixes && !r.tighterThan))('%s preserves every nonempty ambient presence marker', (name, rule) => {
    for (const marker of [' ', '\t']) {
      clearEnv(name);
      if (rule.ambientOnly) expect(childEnv({ [name]: marker })).not.toHaveProperty(name);
      else expect(childEnv({ [name]: marker })[name]).toBe(marker);
      vi.stubEnv(name, marker);
      for (const bag of ['', 'bag-marker']) expect(childEnv({ [name]: bag })[name]).toBe(marker);
    }
  });
  it.each(restrictions)('%s cannot be relaxed by the bag', (name, rule) => {
    clearEnv(name);
    const parent = rule.value ? '/parent/shared' : rule.restrictiveValues?.[0]
      ?? (rule.restrictivePrefixes ? rule.restrictivePrefixes[0] + 'parent' : rule.tighterThan
        ? String(rule.tighterThan.minimum ?? (rule.tighterThan.zeroIsStrict ? 0 : rule.tighterThan.default > 1 ? 1 : rule.tighterThan.default)) : 'parent-identity');
    const numeric = rule.tighterThan;
    const hasTightening = !numeric || Number(parent) < numeric.default;
    const relaxing = ['', ' \t\n', 'unknown-relaxation', ...(numeric
      ? [...(numeric.zeroIsStrict ? [] : ['0']), '-1', 'Infinity', 'NaN', 'unlimited', String(numeric.default), String(numeric.default * 2), '1e309', '0x1', '1garbage'] : [])];
    if (hasTightening) {
      if (rule.ambientOnly) expect(childEnv({ [name]: parent }), 'bag-only selector').not.toHaveProperty(name);
      else expect(childEnv({ [name]: parent })[name], 'bag-only restriction').toBe(parent);
      vi.stubEnv(name, parent);
      expect(childEnv({})[name], 'omitted bag restriction').toBe(parent);
      for (const value of (rule.value ? [''] : relaxing)) expect(childEnv({ [name]: value })[name], value).toBe(parent);
      if (rule.value) {
        expect(childEnv({ [name]: '/bag/shared' })[name]).toBe(rule.precedence === 'bag' ? '/bag/shared' : parent);
        for (const bad of ['relative-root', ' ', '\t']) expect(() => childEnv({ [name]: bad })).toThrow(new RegExp(name));
        vi.stubEnv(name, 'relative-parent');
        expect(() => childEnv({ [name]: '/bag/shared' })).toThrow(new RegExp(name));
      } else if (numeric) {
        const other = String(Math.max(Number(parent) * 2, numeric.default / 2));
        if (Number(other) < numeric.default && (numeric.unit !== 'count' || Number.isInteger(Number(other)))) {
          expect(childEnv({ [name]: other })[name]).toBe(parent);
          vi.stubEnv(name, other);
          expect(childEnv({ [name]: parent })[name]).toBe(parent);
        }
      } else {
        const other = rule.restrictiveValues?.at(-1) ?? (rule.restrictivePrefixes ? rule.restrictivePrefixes.at(-1) + 'bag' : 'bag-identity');
        expect(childEnv({ [name]: other })[name]).toBe(parent);
      }
    }
    clearEnv(name);
    // Presence-only identities accept every nonempty marker; predicates reject unknown values.
    for (const value of (numeric || rule.restrictiveValues || rule.restrictivePrefixes ? relaxing : [''])) {
      expect(childEnv({ [name]: value }), value).not.toHaveProperty(name);
    }
  });
  it.each([
    ['WE_GH_THROTTLE_WRITE_BUDGET_PER_MIN', '1', '1'],
    ['WE_GH_THROTTLE_WRITE_BUDGET_PER_MIN', '1.5', '1'],
    ['WE_GH_THROTTLE_CAP', '1.5', '1'],
    ['WE_HEAVY_ADMISSION_CONTAINER_CPUS', '1', '1'],
    ['WE_HEAVY_ADMISSION_CONTAINER_CPUS', '1.5', '1.5'],
    ['WE_HEAVY_ADMISSION_CONTAINER_MEMORY', '512m', '536870912'],
    ['WE_HEAVY_ADMISSION_CONTAINER_MEMORY', '1024k', '1048576'],
    ['WE_HEAVY_ADMISSION_CONTAINER_MEMORY', '1g', '1073741824'],
  ])('keeps the tighter quantity for %s=%s', (name, value, expected) => {
    clearEnv(name);
    expect(childEnv({ [name]: value })[name]).toBe(expected);
    vi.stubEnv(name, value);
    expect(childEnv({ [name]: 'unlimited' })[name]).toBe(expected);
  });
  it.each([['1g', '512m'], ['512m', '1g']])('compares byte quantities across units: parent %s, bag %s', (parent, bag) => {
    vi.stubEnv('WE_HEAVY_ADMISSION_CONTAINER_MEMORY', parent);
    expect(childEnv({ WE_HEAVY_ADMISSION_CONTAINER_MEMORY: bag }).WE_HEAVY_ADMISSION_CONTAINER_MEMORY).toBe('536870912');
  });
  it.each([
    ['WE_GH_THROTTLE_WRITE_BUDGET_PER_MIN', ['0', '0.5']],
    ['WE_HEAVY_ADMISSION_CONTAINER_CPUS', ['0.5', '0', 'unlimited']],
    ['WE_HEAVY_ADMISSION_CONTAINER_MEMORY', ['0', '9'.repeat(400) + 'g']],
    ['WE_GH_CALL_LOG_MAX_BYTES', ['1', '512k']],
  ])('drops invalid %s quantities from both sources', (name, values) => {
    for (const value of values) {
      vi.stubEnv(name, value);
      expect(childEnv({ [name]: value })).not.toHaveProperty(name);
    }
  });
  it.each(Object.entries(registry).filter(([, r]) => r.tighterThan))('%s retains valid ambient limits at or above the code default', (name, rule) => {
    const limit = rule.tighterThan;
    for (const parent of [limit.default, limit.default * 2]) {
      clearEnv(name);
      expect(childEnv({ [name]: String(parent) })).not.toHaveProperty(name);
      vi.stubEnv(name, String(parent));
      for (const bag of ['', 'invalid', String(parent * 2)]) expect(childEnv({ [name]: bag })[name]).toBe(String(parent));
      expect(childEnv({})[name]).toBe(String(parent));
    }
  });
  it.each([
    [undefined, '8', undefined], ['8', undefined, '8'], ['8', '20', '8'],
    ['8', '3', '3'], ['8', '7', '7'], ['8', '8', '8'], ['8', 'invalid', '8'],
    ['invalid', '8', undefined], ['invalid', '3', '3'],
  ])('respects resolved gh cap: ambient %s, bag %s => %s despite tool cap 10', (parent, bag, expected) => {
    if (parent !== undefined) vi.stubEnv('WE_GH_THROTTLE_CAP', parent);
    const env = childEnv(bag === undefined ? {} : { WE_GH_THROTTLE_CAP: bag });
    if (expected === undefined) expect(env).not.toHaveProperty('WE_GH_THROTTLE_CAP');
    else {
      expect(env.WE_GH_THROTTLE_CAP).toBe(expected);
      expect(resolveGhCap(env, { tool: { cap: 10 } })).toBe(Number(expected));
    }
  });
  it('keeps zero leak allowance and fail mode; one leftover still fails in the reader', () => {
    expect(resolveTmpLeakPolicy({}).max).toBe(50);
    expect(registry.WE_TMP_LEAK_MAX.tighterThan).toMatchObject({ default: 50, zeroIsStrict: true });
    expect(childEnv({ WE_TMP_LEAK_MAX: '100' })).not.toHaveProperty('WE_TMP_LEAK_MAX');
    const env = childEnv({ WE_TMP_LEAK_MAX: '0', WE_TMP_LEAK_MODE: 'fail' });
    expect(env.WE_TMP_LEAK_MAX).toBe('0');
    const policy = resolveTmpLeakPolicy(env);
    expect(policy).toMatchObject({ max: 0, mode: 'fail' });
    const dir = mkdtempSync(join(tmpdir(), 'agent-env-leak-'));
    try {
      writeFileSync(join(dir, 'leftover'), '');
      expect(finishRunTmpRoot({ root: dir, policy, log: () => {} })).toMatchObject({ failed: true, exceeded: true, count: 1 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
    vi.stubEnv('WE_TMP_LEAK_MAX', '0');
    expect(childEnv({ WE_TMP_LEAK_MAX: '100' }).WE_TMP_LEAK_MAX).toBe('0');
  });
  it.each(Object.entries(registry).filter(([, r]) => r.tighterThan))('%s accepts zero only when its reader makes zero strict', (name, rule) => {
    const strict = rule.tighterThan.zeroIsStrict === true;
    for (const value of ['0', '0.0']) {
      clearEnv(name);
      const bag = childEnv({ [name]: value });
      vi.stubEnv(name, value);
      const ambient = childEnv({ [name]: 'unlimited' });
      for (const env of [bag, ambient]) {
        if (strict) expect(env[name]).toBe('0');
        else expect(env).not.toHaveProperty(name);
      }
    }
  });
  it('pins the zero-strict sweep to readers: zero wait/backoff and no extra fast slots, never disabled gh caps', () => {
    expect(Object.keys(registry).filter(name => registry[name].tighterThan?.zeroIsStrict).sort()).toEqual([
      'WE_GH_THROTTLE_HEADER_WAIT_CAP_MS', 'WE_GH_THROTTLE_RETRY_CAP_MS', 'WE_HEAVY_ADMISSION_FAST_SLOTS', 'WE_TMP_LEAK_MAX',
    ]);
    expect(resolveHeaderWaitCapMs({ WE_GH_THROTTLE_HEADER_WAIT_CAP_MS: '0' })).toBe(0);
    expect(retryBackoffMs(2, { capMs: Number(childEnv({ WE_GH_THROTTLE_RETRY_CAP_MS: '0' }).WE_GH_THROTTLE_RETRY_CAP_MS) })).toBe(0);
    expect(resolveSlotSpan({ cap: 2, fastSlots: Number(childEnv({ WE_HEAVY_ADMISSION_FAST_SLOTS: '0' }).WE_HEAVY_ADMISSION_FAST_SLOTS) })).toBe(2);
    const policy = loadGhThrottleSettings({ file: {}, env: { WE_GH_THROTTLE_MAX_HOLD_SECONDS: '0', WE_GH_THROTTLE_PER_CALLER_MAX: '0' } }).value;
    expect(policy).toMatchObject({ maxHoldSeconds: 0, perCallerMax: 0 });
    expect(ghExecOptions({}, ['api', 'user'], policy)).not.toHaveProperty('timeout');
  });
});
