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
import { resolveTranscriptCheckPolicy } from '../lib/codex-transcript-policy.mjs';
import { fixLoopConfig } from '../conveyor/fix-loop-ledger.mjs';
import { assertMainNotStale } from '../lib/main-staleness.mjs';

// @repo-scanning-test scope=full — complete literal env-read inventory under scripts and symlinked skills.
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const registry = JSON.parse(readFileSync(join(root, 'scripts/lib/agent-launch-env-registry.json'), 'utf8'));
// Same bounded inventory used to generate the registry. Include literal bracket and optional reads,
// prose examples conservatively too; exclude test/spec files and test/fixture directory trees.
// This documents literal reads; computed env[envName] reads can be absent. Unknown ambient
// names still inherit parent parity, while unknown caller-bag names remain excluded.
const reads = /\b(?:process\.env|env)(?:\??\.([A-Za-z_][A-Za-z0-9_]*)|(?:\?\.)?\s*\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/g;
function namesIn(text) {
  return [...new Set([...text.matchAll(reads)].map(match => match[1] ?? match[2]))].sort();
}
function ruleFor(name) {
  return Object.hasOwn(registry, name) ? registry[name]
    : Object.entries(registry).find(([pattern]) => pattern.endsWith('*') && name.startsWith(pattern.slice(0, -1)))?.[1]
      ?? Object.entries(registry).find(([pattern]) => pattern.startsWith('*') && name.endsWith(pattern.slice(1)))?.[1];
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
    || Object.keys(rule).some(k => !['class', 'why', 'value', 'restrictiveValues', 'restrictivePrefixes', 'tighterThan', 'precedence', 'relaxOnly', 'ambientOnly', 'never'].includes(k))) return false;
  const predicate = rule.restrictiveValues !== undefined || rule.restrictivePrefixes !== undefined || rule.tighterThan !== undefined;
  if (rule.never !== undefined && (rule.never !== true || rule.class !== 'drop' || predicate)) return false;
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
  it('uses valid restrictive schemas, validators, and exact, trailing-prefix or leading-suffix names', () => {
    for (const [name, rule] of Object.entries(registry)) {
      expect(name).toMatch(/^(?:[A-Za-z_][A-Za-z0-9_]*\*?|\*[A-Za-z_][A-Za-z0-9_]*)$/);
      expect(validRule(rule), name).toBe(true);
      expect(hasValueDecision(rule), name).toBe(true);
    }
    expect(registry.LANE_POOL_ROOT).toMatchObject({ value: 'absolute-path', precedence: 'bag' });
    expect(registry.WE_GH_THROTTLE_LOCK_ROOT).toMatchObject({ value: 'absolute-path', precedence: 'ambient' });
    for (const name of ['DIFF_COVERAGE_BASE', 'VERIFY_SCAN_FILES', 'GIT_ALLOW_PROTOCOL']) {
      expect(registry[name]).toMatchObject({ class: 'forward-restrictive', precedence: 'ambient', ambientOnly: true });
    }
    expect(validRule({ class: 'drop', why: 'danger', never: true })).toBe(true);
    expect(validRule({ class: 'drop', why: 'limit', tighterThan: { default: 50, unit: 'count', evidence: 'a:1', zeroIsStrict: true } })).toBe(true);
  });
  it('rejects malformed, incomplete, contradictory and unknown restrictive schemas', () => {
    const base = { class: 'forward-restrictive', why: 'identity' };
    for (const invalid of [
      ...[false, 'true', 1, null].map(never => ({ class: 'drop', why: 'danger', never })),
      { ...base, never: true }, { class: 'forward', why: 'neutral', never: true },
      { class: 'drop', why: 'gate', never: true, restrictiveValues: ['1'] },
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
    ['GIT_ALLOW_PROTOCOL', 'https', 'https:ext'],
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
        if (ambient === undefined) expect(env).not.toHaveProperty('VERIFY_SCAN_FILES');
        else expect(env.VERIFY_SCAN_FILES).toBe('');
        expect(scanScope(env)).toBe(null);
      }
    }
  });
  it('rejects bag-only HEAD and other comparison-base overrides without ambient evidence', () => {
    for (const ambient of [undefined, '']) {
      if (ambient === undefined) clearEnv('DIFF_COVERAGE_BASE');
      else vi.stubEnv('DIFF_COVERAGE_BASE', ambient);
      for (const value of ['HEAD', 'refs/heads/caller-selected', 'sec1-nonexistent-coverage-base']) {
        const env = childEnv({ DIFF_COVERAGE_BASE: value });
        if (ambient === undefined) expect(env).not.toHaveProperty('DIFF_COVERAGE_BASE');
        else expect(env.DIFF_COVERAGE_BASE).toBe('');
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
      if (rule.ambientOnly || (numeric && Number(parent) !== 0)) {
        expect(childEnv({ [name]: parent }), 'bag-only selector or positive limit without ambient evidence').not.toHaveProperty(name);
      }
      else expect(childEnv({ [name]: parent })[name], 'bag-only restriction').toBe(parent);
      if (numeric) {
        vi.stubEnv(name, 'invalid');
        expect(childEnv({ [name]: parent })[name], 'invalid ambient survives and cannot authorize a bag limit').toBe('invalid');
      }
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
  ])('requires an ambient ceiling before tightening %s=%s', (name, value, expected) => {
    clearEnv(name);
    expect(childEnv({ [name]: value })).not.toHaveProperty(name);
    vi.stubEnv(name, String(registry[name].tighterThan.default));
    expect(childEnv({ [name]: value })[name]).toBe(expected);
    vi.stubEnv(name, value);
    expect(childEnv({ [name]: 'unlimited' })[name]).toBe(value);
  });
  it.each([['1g', '512m'], ['512m', '1g']])('compares byte quantities across units: parent %s, bag %s', (parent, bag) => {
    vi.stubEnv('WE_HEAVY_ADMISSION_CONTAINER_MEMORY', parent);
    expect(childEnv({ WE_HEAVY_ADMISSION_CONTAINER_MEMORY: bag }).WE_HEAVY_ADMISSION_CONTAINER_MEMORY)
      .toBe(parent === '512m' ? parent : '536870912');
  });
  it.each([
    ['WE_GH_THROTTLE_WRITE_BUDGET_PER_MIN', ['0', '0.5']],
    ['WE_HEAVY_ADMISSION_CONTAINER_CPUS', ['0.5', '0', 'unlimited']],
    ['WE_HEAVY_ADMISSION_CONTAINER_MEMORY', ['0', '9'.repeat(400) + 'g']],
    ['WE_GH_CALL_LOG_MAX_BYTES', ['1', '512k']],
  ])('retains raw ambient %s quantities but rejects them from the bag', (name, values) => {
    for (const value of values) {
      clearEnv(name);
      expect(childEnv({ [name]: value })).not.toHaveProperty(name);
      vi.stubEnv(name, value);
      expect(childEnv({ [name]: value })[name]).toBe(value);
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
    [undefined, '8', undefined], [undefined, '3', undefined], ['8', undefined, '8'], ['8', '20', '8'],
    ['8', '3', '3'], ['8', '7', '7'], ['8', '8', '8'], ['8', 'invalid', '8'],
    ['invalid', '8', 'invalid'], ['invalid', '3', 'invalid'],
  ])('respects resolved gh cap: ambient %s, bag %s => %s despite tool cap 10', (parent, bag, expected) => {
    if (parent === undefined) clearEnv('WE_GH_THROTTLE_CAP');
    else vi.stubEnv('WE_GH_THROTTLE_CAP', parent);
    const env = childEnv(bag === undefined ? {} : { WE_GH_THROTTLE_CAP: bag });
    if (expected === undefined) {
      expect(env).not.toHaveProperty('WE_GH_THROTTLE_CAP');
      expect(resolveGhCap(env, { tool: { cap: 10 } })).toBe(10);
      expect(resolveGhCap(env, { tool: { cap: 1 } })).toBe(1);
    } else {
      expect(env.WE_GH_THROTTLE_CAP).toBe(expected);
      expect(resolveGhCap(env, { tool: { cap: 10 } })).toBe(expected === 'invalid' ? 10 : Number(expected));
    }
  });
  it('pre-review finding: configured gh cap 1 remains 1 with bag cap 3 and no ambient cap', () => {
    clearEnv('WE_GH_THROTTLE_CAP');
    const configured = { tool: { cap: 1 } };
    expect(resolveGhCap({}, configured)).toBe(1);
    const env = childEnv({ WE_GH_THROTTLE_CAP: '3' });
    expect(env).not.toHaveProperty('WE_GH_THROTTLE_CAP');
    expect(resolveGhCap(env, configured)).toBe(1);
  });
  it.each(Object.entries(registry).filter(([, rule]) => rule.tighterThan))(
    '%s rejects positive bag-only limits without assuming the configured ceiling', (name, rule) => {
      clearEnv(name);
      const limit = rule.tighterThan;
      const value = String(Math.max(limit.minimum ?? 1, Math.floor(limit.default / 2)));
      expect(childEnv({ [name]: value })).not.toHaveProperty(name);
    });
  it('finding 1: WE_TMP_LEAK_MAX=0 bag-only keeps zero allowance and fail mode; one leftover fails', () => {
    expect(resolveTmpLeakPolicy({}).max).toBe(50);
    expect(registry.WE_TMP_LEAK_MAX.tighterThan).toMatchObject({ default: 50, zeroIsStrict: true });
    expect(childEnv({ WE_TMP_LEAK_MAX: '100' })).not.toHaveProperty('WE_TMP_LEAK_MAX');
    expect(childEnv({ WE_TMP_LEAK_MAX: '0' }).WE_TMP_LEAK_MAX).toBe('0');
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
      const bagOnly = childEnv({ [name]: value });
      if (strict) expect(bagOnly[name]).toBe('0');
      else expect(bagOnly).not.toHaveProperty(name);
      const parent = String(rule.tighterThan.default);
      vi.stubEnv(name, parent);
      const bag = childEnv({ [name]: value });
      expect(bag[name]).toBe(strict ? '0' : parent);
      vi.stubEnv(name, value);
      const ambient = childEnv({ [name]: 'unlimited' });
      expect(ambient[name]).toBe(value);
    }
  });
  it('pins the zero-strict sweep to readers: zero wait/backoff and no extra fast slots, never disabled gh caps', () => {
    expect(Object.keys(registry).filter(name => registry[name].tighterThan?.zeroIsStrict).sort()).toEqual([
      'WE_GH_THROTTLE_HEADER_WAIT_CAP_MS', 'WE_GH_THROTTLE_RETRY_CAP_MS', 'WE_HEAVY_ADMISSION_FAST_SLOTS', 'WE_TMP_LEAK_MAX',
    ]);
    for (const name of ['WE_GH_THROTTLE_HEADER_WAIT_CAP_MS', 'WE_GH_THROTTLE_RETRY_CAP_MS', 'WE_HEAVY_ADMISSION_FAST_SLOTS']) {
      expect(childEnv({ [name]: '0' })[name]).toBe('0');
      vi.stubEnv(name, String(registry[name].tighterThan.default));
      expect(childEnv({ [name]: '0' })[name]).toBe('0');
    }
    expect(resolveHeaderWaitCapMs(childEnv({ WE_GH_THROTTLE_HEADER_WAIT_CAP_MS: '0' }))).toBe(0);
    expect(retryBackoffMs(2, { capMs: Number(childEnv({ WE_GH_THROTTLE_RETRY_CAP_MS: '0' }).WE_GH_THROTTLE_RETRY_CAP_MS) })).toBe(0);
    expect(resolveSlotSpan({ cap: 2, fastSlots: Number(childEnv({ WE_HEAVY_ADMISSION_FAST_SLOTS: '0' }).WE_HEAVY_ADMISSION_FAST_SLOTS) })).toBe(2);
    const policy = loadGhThrottleSettings({ file: {}, env: { WE_GH_THROTTLE_MAX_HOLD_SECONDS: '0', WE_GH_THROTTLE_PER_CALLER_MAX: '0' } }).value;
    expect(policy).toMatchObject({ maxHoldSeconds: 0, perCallerMax: 0 });
    expect(ghExecOptions({}, ['api', 'user'], policy)).not.toHaveProperty('timeout');
  });
});


const sampleName = pattern => pattern.replace('*', 'SEC1_PROBE');
const neverRules = Object.entries(registry).filter(([, rule]) => rule.never);
const parityRules = Object.entries(registry).filter(([, rule]) => !rule.never
  && !rule.restrictiveValues && !rule.restrictivePrefixes);
// Explicit inventory prevents generic drop reasons from hiding executable redirects.
const executableRedirects = [
  'EDITOR', 'VISUAL', 'PAGER', 'MANPAGER', 'BROWSER', 'LESSOPEN', 'LESSCLOSE', 'SSH_ASKPASS', 'SUDO_ASKPASS',
  'GIT_ASKPASS', 'GIT_EDITOR', 'GIT_EXEC_PATH', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER', 'GIT_PROXY_COMMAND',
  'GIT_SEQUENCE_EDITOR', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_TEMPLATE_DIR', 'WE_GH_THROTTLE_GH_BIN',
];
function executableRedirectDefects(rules) {
  const described = Object.entries(rules).filter(([, rule]) =>
    /^(?:Exec redirect:|Redirects the executed\b)/i.test(rule.why)).map(([name]) => name);
  return [...new Set([...executableRedirects, ...described])].filter(name =>
    !executableRedirects.includes(name) || rules[name]?.class !== 'drop' || rules[name]?.never !== true);
}
describe('parent parity minus never; caller bag stays tighten-only', () => {
  it('requires every inventoried or explicitly described executable redirect to be a never rule', () => {
    expect(executableRedirectDefects(registry)).toEqual([]);
  });
  it('fails the executable-redirect gate on missing, plain-drop, contradictory or uninventoried rules', () => {
    const name = 'WE_GH_THROTTLE_GH_BIN';
    const { [name]: omitted, ...withoutRedirect } = registry;
    expect(executableRedirectDefects(withoutRedirect)).toEqual([name]);
    for (const rule of [
      { class: 'drop', why: 'Caller tuning.' },
      { ...omitted, never: false },
      { ...omitted, class: 'forward', never: true },
    ]) expect(executableRedirectDefects({ ...registry, [name]: rule })).toEqual([name]);
    const newRedirect = 'SEC1_NEW_EXEC_REDIRECT';
    expect(executableRedirectDefects({ ...registry, [newRedirect]: {
      class: 'drop', never: true, why: 'Exec redirect: selects a program.',
    } })).toEqual([newRedirect]);
  });
  it('pre-review finding: WE_GH_THROTTLE_GH_BIN never crosses from ambient, bag or both sources', () => {
    const name = 'WE_GH_THROTTLE_GH_BIN', selected = join(tmpdir(), 'caller-selected-gh');
    expect(registry[name]).toMatchObject({ class: 'drop', never: true });
    for (const source of ['ambient', 'bag', 'both']) {
      clearEnv(name);
      if (source !== 'bag') vi.stubEnv(name, selected);
      const env = childEnv(source === 'ambient' ? undefined : { [name]: selected });
      expect(env, source).not.toHaveProperty(name);
    }
  });
  it.each(parityRules)('ambient parity: %s reaches the child verbatim', (pattern, rule) => {
    const name = sampleName(pattern);
    // Include raw forms that quantity parsing used to change or silently discard.
    for (const value of (rule.value === 'absolute-path' ? ['/parent/isolated'] : [' 1e0 ', '', '0.0', 'invalid'])) {
      vi.stubEnv(name, value);
      for (const bag of [undefined, {}]) expect(childEnv(bag)[name], JSON.stringify({ name, value, bag })).toBe(value);
    }
  });
  it.each(neverRules)('never: %s cannot cross from either source', pattern => {
    const name = sampleName(pattern);
    clearEnv(name);
    for (const value of ['hostile', '', '1']) {
      for (const source of ['bag', 'ambient', 'both']) {
        clearEnv(name);
        if (source !== 'bag') vi.stubEnv(name, value);
        const env = childEnv(source === 'ambient' ? undefined : { [name]: value });
        if (name === 'PATH' || name === 'HOME') expect(env[name]).not.toBe(value);
        else expect(env, `${name} from ${source}`).not.toHaveProperty(name);
      }
    }
  });
  it.each(restrictions)('exact restrictive exception: %s resolves to its own rule', (name, rule) => {
    expect(name).not.toContain('*');
    expect(ruleFor(name)).toBe(rule);
    expect(rule.never).toBeUndefined();
    const value = rule.value ? '/parent/exact' : rule.restrictiveValues?.[0]
      ?? (rule.restrictivePrefixes ? rule.restrictivePrefixes[0] + 'exact'
        : rule.tighterThan ? String(rule.tighterThan.default) : 'parent-exact');
    vi.stubEnv(name, value);
    expect(childEnv({})[name]).toBe(value);
  });
  it('resolves required injection, exec, git, credential and bypass controls to never', () => {
    const names = [
      'NODE_OPTIONS', 'CUSTOM_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
      'NODE_PATH', 'PYTHONPATH', 'PYTHONSTARTUP', 'PERL5OPT', 'PERL5LIB', 'RUBYOPT', 'RUBYLIB',
      'npm_config_script_shell', 'npm_config_node_options', 'NPM_CONFIG_SCRIPT_SHELL', 'NPM_CONFIG_NODE_OPTIONS',
      'BASH_ENV', 'ENV', 'ZDOTDIR', 'SHELL', 'PS4', 'PROMPT_COMMAND', 'IFS', 'BASH_FUNC_hostile%%',
      'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'EDITOR', 'VISUAL', 'PAGER', 'MANPAGER', 'BROWSER',
      'LESSOPEN', 'LESSCLOSE', 'SSH_ASKPASS', 'SUDO_ASKPASS', 'WE_GH_THROTTLE_GH_BIN',
      'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_EXEC_PATH', 'GIT_PROXY_COMMAND', 'GIT_ASKPASS', 'GIT_EXTERNAL_DIFF',
      'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_PAGER', 'GIT_TEMPLATE_DIR', 'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM',
      'GIT_CONFIG_PARAMETERS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_FUTURE_EXEC_REDIRECT',
      'CUSTOM_TOKEN', 'CUSTOM_SECRET', 'CUSTOM_SECRETS', 'CUSTOM_PASSWORD', 'CUSTOM_API_KEY', 'CUSTOM_PRIVATE_KEY',
      'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_CONFIG_FILE', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
      'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'NPM_TOKEN', 'SSH_AUTH_SOCK',
      'WE_ALLOW_FUTURE_BYPASS', 'MAIN_PUSH_OK', 'RAW_PR_CREATE_OK', 'MAIN_SESSION_BUILD_OK',
      'CUSTOM_BREAK_GLASS', 'WE_LAND_UNVERIFIED', 'WE_PR_OPEN_SOAK_PRECHECK', 'WE_SKIP_FUTURE_GUARD',
      'LC_HOSTILE_OPTIONS', 'LC_HOSTILE_TOKEN',
    ];
    for (const name of names) expect(ruleFor(name), name).toMatchObject({ class: 'drop', never: true });
    const bag = Object.fromEntries(names.map(name => [name, 'hostile']));
    for (const [name, value] of Object.entries(bag)) vi.stubEnv(name, value);
    for (const env of [childEnv(), childEnv(bag)]) {
      for (const name of names.filter(n => !['PATH', 'HOME'].includes(n))) expect(env, name).not.toHaveProperty(name);
    }
  });
  it('uses exact rules before prefixes and prefixes before suffixes', () => {
    expect(ruleFor('GIT_NO_REPLACE_OBJECTS')).toBe(registry.GIT_NO_REPLACE_OBJECTS);
    expect(ruleFor('AWS_CUSTOM_OPTIONS')).toBe(registry['AWS_*']);
    expect(ruleFor('WE_ALLOW_CUSTOM_TOKEN')).toBe(registry['WE_ALLOW_*']);
    expect(ruleFor('CUSTOM_OPTIONS')).toBe(registry['*_OPTIONS']);
    expect(ruleFor('SEC1_UNKNOWN')).toBeUndefined();
  });
  it('marks affirmative why-sweep relaxations never without swallowing restrictive or negated reasons', () => {
    for (const [name, rule] of Object.entries(registry)) {
      if (rule.class === 'forward-restrictive' || rule.restrictiveValues || rule.restrictivePrefixes || rule.tighterThan) continue;
      if (rule.relaxOnly || /escape hatch|guard relaxation|adds personal-auth exceptions|skips the gate|bypass child admission/i.test(rule.why)) {
        expect(rule.never, name).toBe(true);
      }
    }
    expect(registry.WE_GH_JSON_RETRIES.never).toBeUndefined();
    expect(registry.WE_DAEMON_VERSIONS_CLONES_ROOT.never).toBeUndefined();
  });
  it('refuses an empty ambient absolute path even when the bag supplies a valid path', () => {
    vi.stubEnv('LANE_POOL_ROOT', '');
    expect(() => childEnv({ LANE_POOL_ROOT: '/bag/pool' })).toThrow(/LANE_POOL_ROOT/);
  });
  it('finding 2: ambient WE_GH_THROTTLE_PER_CALLER_MAX=1e0 stays verbatim and caps the reader at one', () => {
    vi.stubEnv('WE_GH_THROTTLE_PER_CALLER_MAX', '1e0');
    for (const bag of [undefined, {}, { WE_GH_THROTTLE_PER_CALLER_MAX: '2' }, { WE_GH_THROTTLE_PER_CALLER_MAX: '0.5' }]) {
      const env = childEnv(bag);
      expect(env.WE_GH_THROTTLE_PER_CALLER_MAX).toBe('1e0');
      expect(loadGhThrottleSettings({ file: {}, env }).value.perCallerMax).toBe(1);
    }
  });
  it('finding 3: ambient WE_PLATFORM_PREFERENCES_FILE preserves authoritative transcript fail policy', () => {
    const source = join(tmpdir(), 'authoritative-platform-preferences.json');
    vi.stubEnv('WE_PLATFORM_PREFERENCES_FILE', source);
    const readFile = path => JSON.stringify(path === source ? { transcriptCheck: { mode: 'fail' } } : {});
    const parent = resolveTranscriptCheckPolicy({ env: { WE_PLATFORM_PREFERENCES_FILE: source }, tool: {}, readFile });
    expect(parent).toMatchObject({ mode: 'fail', sources: { mode: 'platform' } });
    for (const bag of [undefined, {}, { WE_PLATFORM_PREFERENCES_FILE: '/caller/relaxation.json' }]) {
      const env = childEnv(bag);
      expect(env.WE_PLATFORM_PREFERENCES_FILE).toBe(source);
      expect(resolveTranscriptCheckPolicy({ env, tool: {}, readFile })).toMatchObject({ mode: 'fail', sources: { mode: 'platform' } });
    }
    clearEnv('WE_PLATFORM_PREFERENCES_FILE');
    expect(childEnv({ WE_PLATFORM_PREFERENCES_FILE: source })).not.toHaveProperty('WE_PLATFORM_PREFERENCES_FILE');
  });
  it('finding 4: ambient WE_FIX_LOOP_MAX_SESSIONS=1 retains the one-session repair limit', () => {
    vi.stubEnv('WE_FIX_LOOP_MAX_SESSIONS', '1');
    const readers = { readPlatform: () => ({}), readRepo: () => ({}), readMainRuns: () => [] };
    expect(fixLoopConfig({}, readers).maxSessions).toBe(3);
    for (const bag of [undefined, {}, { WE_FIX_LOOP_MAX_SESSIONS: '3' }]) {
      const env = childEnv(bag);
      expect(env.WE_FIX_LOOP_MAX_SESSIONS).toBe('1');
      expect(fixLoopConfig(env, readers).maxSessions).toBe(1);
    }
  });
  it('finding 5: ambient WE_DAEMON_MANAGED_CLONE=1 keeps stale code behind the smoke-gated rebuild', () => {
    vi.stubEnv('WE_DAEMON_MANAGED_CLONE', '1');
    const env = childEnv({ WE_DAEMON_MANAGED_CLONE: '0' });
    expect(env.WE_DAEMON_MANAGED_CLONE).toBe('1');
    // Run the actual chokepoint with injected stale evidence and no git writes.
    vi.stubEnv('WE_DAEMON_MANAGED_CLONE', env.WE_DAEMON_MANAGED_CLONE);
    expect(() => assertMainNotStale(root, () => ({ action: 'warn', behind: 1, dirty: false }), {
      listBehindFiles: () => ['scripts/changed.mjs'], lastGood: () => null,
      rebuildGrace: () => null, write: () => {},
    })).toThrow(/DAEMON-MANAGED clone: only its gated rebuild moves it/);
  });
  it('finding 6: ambient WE_GUARD_LISTING_MAX_BYTES keeps the smaller listing refusal threshold', () => {
    vi.stubEnv('WE_GUARD_LISTING_MAX_BYTES', '4');
    for (const bag of [undefined, {}, { WE_GUARD_LISTING_MAX_BYTES: '268435456' }]) {
      expect(childEnv(bag).WE_GUARD_LISTING_MAX_BYTES).toBe('4');
    }
  });
});
