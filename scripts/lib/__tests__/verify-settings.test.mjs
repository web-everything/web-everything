import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILT_IN_VERIFY_SETTINGS, defaultVerifySettingsPath, validateVerifySettings,
  loadVerifySettingsFile, resolveVerifySettings } from '../verify-settings.mjs';
import { verifyRelatedMode, verifyTestTimeoutFactor, verifyStandardsPolicy, verifyPhaseAdmissionEnabled,
  verifyFastTargets, resolveDefaultGate, phaseAdmissionKind, buildVerifyPhases, formatVerifyPhases } from '../verify-lane-gate.mjs';

const allSources = source => Object.fromEntries(Object.keys(BUILT_IN_VERIFY_SETTINGS).map(key => [key, source]));
const custom = { relatedMode: 'import-only', testTimeoutFactor: 4, standards: 'ci-only', phaseAdmission: false, fastTargets: 2,
  matchRequestVariants: false, supersede: 'never', restartInFlight: 'kill', runAllPhases: false, isolatedRetry: 'off', relatedMaxTests: 12, relatedDepth: 3, alwaysRunTests: ['a/b.test.mjs'] };
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function file(contents) {
  const root = mkdtempSync(join(tmpdir(), 'verify-settings-'));
  roots.push(root);
  const path = join(root, 'settings.json');
  if (contents !== undefined) writeFileSync(path, contents);
  return path;
}

describe('verify settings', () => {
  it('resolves the running module settings path and applies the shipped file with an empty env', () => {
    const shippedAlwaysRun = JSON.parse(readFileSync(defaultVerifySettingsPath(), 'utf8')).alwaysRunTests;
    // #99 — the declared always-run guard set is non-empty and every file in it exists in this checkout.
    expect(shippedAlwaysRun.length).toBeGreaterThan(0);
    for (const f of shippedAlwaysRun) expect(existsSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../..', f)), f).toBe(true);
    expect(defaultVerifySettingsPath()).toBe(resolve(dirname(fileURLToPath(import.meta.url)), '../../verify-settings.json'));
    expect(resolveVerifySettings({ fileConfig: loadVerifySettingsFile(defaultVerifySettingsPath()), env: {} }))
      .toEqual({ values: { ...BUILT_IN_VERIFY_SETTINGS, relatedMode: 'import-only', standards: 'auto', relatedMaxTests: 40, relatedDepth: 2, alwaysRunTests: shippedAlwaysRun }, sources: allSources('file') });
    expect(verifyRelatedMode({})).toBe('import-only');
  });

  it('defaults the shipped standards policy to auto with no env, and env always still forces it', () => {
    const fileConfig = loadVerifySettingsFile(defaultVerifySettingsPath());
    expect(resolveVerifySettings({ fileConfig, env: {} }).values.standards).toBe('auto');
    expect(verifyStandardsPolicy({})).toBe('auto');
    const forced = resolveVerifySettings({ fileConfig, env: { WE_VERIFY_STANDARDS: 'always' } });
    expect(forced.values.standards).toBe('always');
    expect(forced.sources.standards).toBe('env');
    expect(verifyStandardsPolicy({ WE_VERIFY_STANDARDS: 'always' })).toBe('always');
  });

  it('lets valid environment values override every key independently', () => {
    const env = { WE_VERIFY_RELATED: 'all', WE_VERIFY_TEST_TIMEOUT_FACTOR: '2.5', WE_VERIFY_STANDARDS: 'auto',
      WE_VERIFY_PHASE_ADMISSION: '1', WE_VERIFY_FAST_TARGETS: '0', WE_VERIFY_MATCH_REQUEST_VARIANTS: '1',
      WE_VERIFY_SUPERSEDE: 'any', WE_VERIFY_RESTART_IN_FLIGHT: 'adopt', WE_VERIFY_RUN_ALL_PHASES: '1',
      WE_VERIFY_ISOLATED_RETRY: 'timeouts', WE_VERIFY_RELATED_MAX_TESTS: '5', WE_VERIFY_RELATED_DEPTH: '1', WE_VERIFY_ALWAYS_RUN_TESTS: 'x/y.test.mjs, z.test.mjs' };
    const values = { relatedMode: 'all', testTimeoutFactor: 2.5, standards: 'auto', phaseAdmission: true, fastTargets: 0,
      matchRequestVariants: true, supersede: 'any', restartInFlight: 'adopt', runAllPhases: true, isolatedRetry: 'timeouts', relatedMaxTests: 5, relatedDepth: 1, alwaysRunTests: ['x/y.test.mjs', 'z.test.mjs'] };
    expect(resolveVerifySettings({ fileConfig: custom, env })).toEqual({ values, sources: allSources('env') });
    expect(resolveVerifySettings({ fileConfig: custom, env: { WE_VERIFY_RELATED: 'all' } }))
      .toEqual({ values: { ...custom, relatedMode: 'all' }, sources: { ...allSources('file'), relatedMode: 'env' } });
    expect(verifyPhaseAdmissionEnabled({ WE_VERIFY_PHASE_ADMISSION: '0' }, BUILT_IN_VERIFY_SETTINGS)).toBe(false);
  });

  it('75b/75c: ships the tightening defaults (run every phase; isolated retry of untouched files only)', () => {
    expect(BUILT_IN_VERIFY_SETTINGS).toMatchObject({ runAllPhases: true, isolatedRetry: 'untouched' });
    const shipped = resolveVerifySettings({ fileConfig: loadVerifySettingsFile(defaultVerifySettingsPath()), env: {} }).values;
    expect(shipped).toMatchObject({ runAllPhases: true, isolatedRetry: 'untouched' });
    expect(resolveVerifySettings({ fileConfig: null, env: { WE_VERIFY_RUN_ALL_PHASES: '0', WE_VERIFY_ISOLATED_RETRY: 'off' } }).values)
      .toMatchObject({ runAllPhases: false, isolatedRetry: 'off' });
  });

  it('uses built-ins for unreadable files, malformed JSON and invalid top-level shapes', () => {
    for (const contents of [undefined, '{bad', 'null', '[]', 'false', '"settings"']) {
      const loaded = loadVerifySettingsFile(file(contents));
      expect(loaded).toEqual(BUILT_IN_VERIFY_SETTINGS);
      expect(resolveVerifySettings({ fileConfig: loaded, env: {} }))
        .toEqual({ values: BUILT_IN_VERIFY_SETTINGS, sources: allSources('default') });
    }
  });

  it('falls back per invalid file key while preserving valid file values and provenance', () => {
    const loaded = loadVerifySettingsFile(file(JSON.stringify({ ...custom, relatedMode: 'bad', fastTargets: -1 })));
    expect(loaded).toEqual({ ...custom, relatedMode: 'all', fastTargets: 5 });
    expect(resolveVerifySettings({ fileConfig: loaded, env: {} }).sources)
      .toEqual({ ...allSources('file'), relatedMode: 'default', fastTargets: 'default' });
    for (const [key, badValues] of Object.entries({
      relatedMode: ['bad', null, 1], testTimeoutFactor: [0, -1, 0.5, Infinity, NaN, '3', true],
      standards: ['bad', false], phaseAdmission: ['0', 0, null], fastTargets: [-1, 2.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '5'],
      matchRequestVariants: ['1', 1, null], supersede: ['bad', true], restartInFlight: ['bad', false],
      runAllPhases: ['1', 0, null], isolatedRetry: ['all', true, null],
    })) {
      for (const bad of badValues) {
        const config = validateVerifySettings({ ...custom, [key]: bad });
        expect(config[key]).toBe(BUILT_IN_VERIFY_SETTINGS[key]);
        expect(resolveVerifySettings({ fileConfig: config }).sources[key]).toBe('default');
      }
    }
  });

  it('ignores invalid env values, falling back to file then built-ins', () => {
    const env = { WE_VERIFY_RELATED: 'bad', WE_VERIFY_TEST_TIMEOUT_FACTOR: 'Infinity', WE_VERIFY_STANDARDS: '',
      WE_VERIFY_PHASE_ADMISSION: 'false', WE_VERIFY_FAST_TARGETS: '2.5', WE_VERIFY_MATCH_REQUEST_VARIANTS: 'yes',
      WE_VERIFY_SUPERSEDE: 'always', WE_VERIFY_RESTART_IN_FLIGHT: 'drain', WE_VERIFY_RUN_ALL_PHASES: 'yes',
      WE_VERIFY_ISOLATED_RETRY: 'always' };
    expect(resolveVerifySettings({ fileConfig: custom, env })).toEqual({ values: custom, sources: allSources('file') });
    expect(resolveVerifySettings({ fileConfig: null, env })).toEqual({ values: BUILT_IN_VERIFY_SETTINGS, sources: allSources('default') });
    for (const bad of ['', ' ', '-1', 'NaN']) {
      expect(resolveVerifySettings({ fileConfig: custom, env: { WE_VERIFY_FAST_TARGETS: bad, WE_VERIFY_TEST_TIMEOUT_FACTOR: bad } }).values).toEqual(custom);
    }
  });

  it('threads file settings through helpers, admission routing and gate telemetry', () => {
    expect(verifyRelatedMode({}, custom)).toBe('import-only');
    expect(verifyTestTimeoutFactor({}, custom)).toBe(4);
    expect(verifyStandardsPolicy({}, custom)).toBe('ci-only');
    expect(verifyPhaseAdmissionEnabled({}, custom)).toBe(false);
    expect(verifyFastTargets({}, custom)).toBe(2);
    const args = { phase: 'vitest', decision: { targets: ['a', 'b', 'c'] }, env: {}, fileConfig: custom };
    expect(phaseAdmissionKind(args).kind).toBe('other');
    expect(phaseAdmissionKind({ ...args, env: { WE_VERIFY_FAST_TARGETS: '3' } }).kind).toBe('files');
    const runGit = args => args[0] === 'merge-base' ? 'base' : args[0] === 'diff' && !args.includes('--diff-filter=D') ? 'scripts/example.mjs' : '';
    const { decision, command } = resolveDefaultGate({ runGit, env: {}, fileConfig: custom });
    expect(command).toContain('--testTimeout=20000');
    expect(command).not.toContain('check:standards');
    expect(decision.settingsSource).toEqual(allSources('file'));
    const phases = buildVerifyPhases({ decision });
    expect(phases.settingsSource).toEqual(decision.settingsSource);
    expect(formatVerifyPhases(phases)).toContain('settingsSource=');
    const blocked = resolveDefaultGate({ runGit: () => { throw Error('unreadable diff'); }, env: {}, fileConfig: null });
    expect(blocked.decision.mode).toBe('blocked');
    expect(blocked.decision.settingsSource).toEqual(allSources('default'));
  });
});

// #5128 — the bounded graph is opt-in by default, enabled by the host settings file.
describe('#5128 — related selection settings', () => {
  it('defaults to off and depth two, with a shipped limit of forty', () => {
    expect(resolveVerifySettings({ fileConfig: null, env: {} }).values)
      .toMatchObject({ relatedMaxTests: 0, relatedDepth: 2 });
    expect(loadVerifySettingsFile(defaultVerifySettingsPath()))
      .toMatchObject({ relatedMaxTests: 40, relatedDepth: 2 });
  });

  it('accepts file values and environment overrides including a zero limit', () => {
    const fileConfig = { relatedMaxTests: 8, relatedDepth: 4 };
    expect(resolveVerifySettings({ fileConfig, env: {} })).toMatchObject({
      values: fileConfig, sources: { relatedMaxTests: 'file', relatedDepth: 'file' },
    });
    expect(resolveVerifySettings({ fileConfig, env: { WE_VERIFY_RELATED_MAX_TESTS: '0', WE_VERIFY_RELATED_DEPTH: '1' } }))
      .toMatchObject({ values: { relatedMaxTests: 0, relatedDepth: 1 },
        sources: { relatedMaxTests: 'env', relatedDepth: 'env' } });
  });

  it.each([
    ['relatedMaxTests', 'WE_VERIFY_RELATED_MAX_TESTS', 0, [-1, 1.5]],
    ['relatedDepth', 'WE_VERIFY_RELATED_DEPTH', 2, [-1, 0, 1.5]],
  ])('keeps fallbacks for invalid %s values', (key, envKey, fallback, invalid) => {
    for (const value of invalid) {
      expect(validateVerifySettings({ [key]: value })[key]).toBe(fallback);
      expect(resolveVerifySettings({ fileConfig: { [key]: value }, env: {} }))
        .toMatchObject({ values: { [key]: fallback }, sources: { [key]: 'default' } });
      expect(resolveVerifySettings({ fileConfig: { [key]: 9 }, env: { [envKey]: String(value) } }))
        .toMatchObject({ values: { [key]: 9 }, sources: { [key]: 'file' } });
      expect(resolveVerifySettings({ fileConfig: null, env: { [envKey]: String(value) } }))
        .toMatchObject({ values: { [key]: fallback }, sources: { [key]: 'default' } });
    }
  });
});

describe('alwaysRunTests setting (#99)', () => {
  it('rejects unsafe entries per key and an empty-but-set env switches the set off', () => {
    for (const bad of ['a.test.mjs', ['/abs.test.mjs'], ['../x.test.mjs'], [1], ['a b.test.mjs']]) {
      expect(resolveVerifySettings({ fileConfig: { alwaysRunTests: bad }, env: {} }).values.alwaysRunTests).toEqual([]);
    }
    expect(resolveVerifySettings({ fileConfig: { alwaysRunTests: ['a.test.mjs'] }, env: { WE_VERIFY_ALWAYS_RUN_TESTS: '' } }).values.alwaysRunTests).toEqual([]);
  });
});
