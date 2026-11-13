// Policy cascade (agent-memory 151; card x5wnfcg; operator go 2026-10-10): every delivery setting on main resolves
// standard default → PLATFORM preference → tool/repo override → env through the ONE shared resolver
// (we:scripts/lib/policy-cascade.mjs), and logs the source layer of its effective value.
//
// Table-driven: each row is one main setting, read through its REAL reader. For every row:
//   (a) no tool override + a platform preference  → the reader returns the PLATFORM value;
//   (b) a tool override + a platform preference   → the TOOL value wins.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveCascade, cascadePolicy, formatCascadeSourcesLine, logCascadeSources, readPlatformPreferences,
  resetCascadeLogForTest, PLATFORM_PREFERENCES_ENV, POLICY_CASCADE_LOG_ENV,
} from '../policy-cascade.mjs';
import { readBuildQueuePrioritySettings } from '../build-queue.mjs';
import { readOpenPrCapScope } from '../open-pr-cap-scope.mjs';
import { readPrLimitScope } from '../pr-limit.mjs';
import { loadDrainFactsSettings } from '../drain-facts-source.mjs';
import { resolvePrStackSettings } from '../../conveyor/pr-stack.mjs';
import { resolveStackAwareReview } from '../../conveyor/review-stack-base.mjs';
import { readGithubAuthPolicy } from '../github-auth-policy.mjs';
import { resolveRedMainHoldSetting, resolveRedMainMode } from '../red-main-hold.mjs';
import { loadQuietSettings } from '../quiet-hours-io.mjs';
import { loadVerifySettingsFile } from '../verify-settings.mjs';
import { loadRebuildAsJobSettings } from '../daemon-rebuild/rebuild-job.mjs';
import { loadBackgroundBuildSettings } from '../daemon-background-build.mjs';
import { readDeliveryPrioritySettings } from '../../conveyor/delivery-priority-shadow.mjs';
import { resolveHeavyAdmissionCap } from '../dispatch-throttle.mjs';
import { liveReviewRoundBudget } from '../../../skills-src/conveyor/review-daemon.mjs';

const dir = mkdtempSync(join(tmpdir(), 'policy-cascade-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = (data) => { const p = join(dir, `f${n += 1}.json`); writeFileSync(p, JSON.stringify(data)); return p; };
/** A clean env holding only the platform-preference file (no reader env overrides). */
const envWith = (platform) => ({ [PLATFORM_PREFERENCES_ENV]: file(platform) });
const settingsReader = (block) => () => block;

/**
 * Each row: `platform` (the platform-preference file body), `tool` (the tool block, or undefined = no override),
 * `read(env, tool)` (the real reader), and the expected platform / tool values.
 */
const ROWS = [
  { setting: 'buildQueuePriority.mode', platform: { deliveryPriority: { mode: 'enforce' } }, tool: { mode: 'shadow' },
    read: (env, tool) => readBuildQueuePrioritySettings({ env, read: settingsReader({ buildQueuePriority: tool }) }).mode, platformValue: 'enforce', toolValue: 'shadow' },
  { setting: 'buildQueuePriority.requestsFirstInClass', platform: { deliveryPriority: { requestsFirstInClass: false } }, tool: { requestsFirstInClass: true },
    read: (env, tool) => readBuildQueuePrioritySettings({ env, read: settingsReader({ buildQueuePriority: tool }) }).requestsFirstInClass, platformValue: false, toolValue: true },
  { setting: 'openPrCap.excludeCardOnly', platform: { openPrCap: { excludeCardOnly: false } }, tool: { excludeCardOnly: true },
    read: (env, tool) => readOpenPrCapScope({ env, read: settingsReader({ openPrCap: tool }) }).excludeCardOnly, platformValue: false, toolValue: true },
  { setting: 'openPrCap.excludeAccepted', platform: { openPrCap: { excludeAccepted: false } }, tool: { excludeAccepted: true },
    read: (env, tool) => readOpenPrCapScope({ env, read: settingsReader({ openPrCap: tool }) }).excludeAccepted, platformValue: false, toolValue: true },
  { setting: 'prLimit.excludeCardOnly', platform: { prLimit: { excludeCardOnly: false } }, tool: { excludeCardOnly: true },
    read: (env, tool) => readPrLimitScope({ env, read: settingsReader({ prLimit: tool }) }).excludeCardOnly, platformValue: false, toolValue: true },
  { setting: 'drainFactsSource.source', platform: { drainFactsSource: { source: 'github' } }, tool: { source: 'store-first' },
    read: (env, tool) => loadDrainFactsSettings({ env, file: { drainFactsSource: tool } }).source, platformValue: 'github', toolValue: 'store-first' },
  { setting: 'prStack.detect', platform: { prStack: { detect: 'off' } }, tool: { detect: 'on' },
    read: (env, tool) => resolvePrStackSettings(env, { read: settingsReader({ prStack: tool }) }).detect, platformValue: false, toolValue: true },
  { setting: 'prStack.restackMaxRounds', platform: { prStack: { restackMaxRounds: 7 } }, tool: { restackMaxRounds: 2 },
    read: (env, tool) => resolvePrStackSettings(env, { read: settingsReader({ prStack: tool }) }).restackMaxRounds, platformValue: 7, toolValue: 2 },
  { setting: 'stackAwareReview.mode', platform: { stackAwareReview: { mode: 'off' } }, tool: { mode: 'on' },
    read: (env, tool) => resolveStackAwareReview(env, { read: settingsReader({ stackAwareReview: tool }) }), platformValue: false, toolValue: true },
  { setting: 'github.auth', platform: { github: { auth: 'personal' } }, tool: { auth: 'app' },
    read: (env, tool) => readGithubAuthPolicy({ env, read: settingsReader({ github: tool }) }).auth, platformValue: 'personal', toolValue: 'app' },
  { setting: 'redMainHold', platform: { redMainHold: 'off' }, tool: 'on',
    read: (env, tool) => resolveRedMainHoldSetting({ env, file: file(tool === undefined ? {} : { redMainHold: tool }) }).value, platformValue: 'off', toolValue: 'on' },
  { setting: 'redMainMode', platform: { redMainMode: 'quarantine' }, tool: 'stop',
    read: (env, tool) => resolveRedMainMode({ env, file: file(tool === undefined ? {} : { redMainMode: tool }) }).value, platformValue: 'quarantine', toolValue: 'stop' },
  { setting: 'quietHours.start', platform: { quietHours: { start: '21:00' } }, tool: { start: '22:00' },
    read: (env, tool) => loadQuietSettings({ env: { ...env, WE_QUIET_HOURS_SETTINGS: file(tool ?? {}) } }).start, platformValue: '21:00', toolValue: '22:00' },
  { setting: 'verify.selection', platform: { verify: { selection: 'pr' } }, tool: { selection: 'since-last-green' },
    read: (env, tool) => loadVerifySettingsFile(file(tool ?? {}), { env }).selection, platformValue: 'pr', toolValue: 'since-last-green' },
  { setting: 'rebuildAsJob.minIntervalMs', platform: { rebuildAsJob: { minIntervalMs: 1234 } }, tool: { minIntervalMs: 999 },
    read: (env, tool) => loadRebuildAsJobSettings(file(tool === undefined ? {} : { rebuildAsJob: tool }), { env }).minIntervalMs, platformValue: 1234, toolValue: 999 },
  { setting: 'daemonBackgroundBuild.enabled[review-daemon.mjs]', platform: { daemonBackgroundBuild: { enabled: { 'review-daemon.mjs': true } } },
    tool: { enabled: { 'review-daemon.mjs': false } },
    read: (env, tool) => loadBackgroundBuildSettings(file(tool ?? {}), { env }).enabled['review-daemon.mjs'], platformValue: true, toolValue: false },
  { setting: 'deliveryPriority.mode', platform: { deliveryPriority: { mode: 'enforce' } }, tool: { mode: 'shadow' },
    read: (env, tool) => readDeliveryPrioritySettings({ env, readTool: settingsReader({ deliveryPriority: tool }) }).mode, platformValue: 'enforce', toolValue: 'shadow' },
  { setting: 'heavyAdmissionCap', platform: { heavyAdmissionCap: 5 }, tool: 4,
    read: (env, tool) => resolveHeavyAdmissionCap({ env, file: tool === undefined ? {} : { heavyAdmissionCap: tool } }), platformValue: 5, toolValue: 4 },
];

describe('every main delivery setting resolves through the platform preference', () => {
  it.each(ROWS)('$setting: platform preference applies when no tool override exists', ({ platform, read, platformValue }) => {
    expect(read(envWith(platform), undefined)).toEqual(platformValue);
  });
  it.each(ROWS)('$setting: the tool override beats the platform preference', ({ platform, tool, read, toolValue }) => {
    expect(read(envWith(platform), tool)).toEqual(toolValue);
  });
  it.each(ROWS)('$setting: the platform and tool values differ (the row proves something)', ({ platformValue, toolValue }) => {
    expect(platformValue).not.toEqual(toolValue);
  });
});

describe('resolveCascade (pure)', () => {
  it('resolves each leaf standard → platform → tool → env and names the layer', () => {
    const r = resolveCascade({
      standard: { a: 1, b: 1, c: 1, d: 1 }, platform: { b: 2, c: 2, d: 2 }, tool: { c: 3, d: 3 }, envValues: { d: 4 },
    });
    expect(r.value).toEqual({ a: 1, b: 2, c: 3, d: 4 });
    expect(r.sources).toEqual({ a: 'standard', b: 'platform', c: 'tool', d: 'env' });
  });
  it('an invalid value never overrides a lower layer', () => {
    const r = resolveCascade({ standard: { m: 'on' }, platform: { m: 'off' }, tool: { m: 'bogus' }, valid: { m: (v) => ['on', 'off'].includes(v) } });
    expect(r.value).toEqual({ m: 'off' });
    expect(r.sources.m).toBe('platform');
    expect(r.invalid).toEqual(['tool.m="bogus"']);
  });
  it('keeps keys that contain dots intact', () => {
    const r = resolveCascade({ platform: { enabled: { 'a.mjs': true } }, tool: { enabled: { 'b.mjs': false } } });
    expect(r.value).toEqual({ enabled: { 'a.mjs': true, 'b.mjs': false } });
  });
  it('resolves a scalar policy', () => {
    expect(resolveCascade({ standard: 'on', platform: 'off' })).toMatchObject({ value: 'off', sources: { '': 'platform' } });
    expect(resolveCascade({ standard: 'on', platform: 'off', tool: 'on' }).sources).toEqual({ '': 'tool' });
  });
  it('with no platform preference, `layered` is the tool block unchanged (no behaviour change)', () => {
    const tool = { detect: 'on', restackMaxRounds: 3, list: ['x'] };
    expect(cascadePolicy('prStack', tool, { platform: null, env: {} }).layered).toEqual(tool);
    expect(cascadePolicy('prStack', undefined, { platform: null, env: {} }).layered).toBeUndefined();
  });
});

describe('platform preference file', () => {
  it('a missing file is "no preference"; a torn one is skipped and named', () => {
    expect(readPlatformPreferences({ env: { [PLATFORM_PREFERENCES_ENV]: join(dir, 'missing.json') } })).toEqual({ prefs: {}, errors: [] });
    const torn = join(dir, 'torn.json');
    writeFileSync(torn, '{');
    const r = readPlatformPreferences({ env: { [PLATFORM_PREFERENCES_ENV]: torn } });
    expect(r.prefs).toEqual({});
    expect(r.errors).toHaveLength(1);
  });
});

describe('source log', () => {
  beforeEach(() => resetCascadeLogForTest());
  it('names every effective value and its layer', () => {
    const line = formatCascadeSourcesLine('prStack', resolveCascade({ standard: { detect: true, rounds: 3 }, tool: { rounds: 2 } }));
    expect(line).toBe('policy-cascade · prStack: detect=true (standard), rounds=2 (tool)');
  });
  it('logs once per process per distinct line, and again when the value changes', () => {
    const lines = [];
    const env = { [POLICY_CASCADE_LOG_ENV]: '1', [PLATFORM_PREFERENCES_ENV]: file({ prStack: { detect: 'off' } }) };
    cascadePolicy('prStack', undefined, { env, log: (l) => lines.push(l) });
    cascadePolicy('prStack', undefined, { env, log: (l) => lines.push(l) });
    cascadePolicy('prStack', { detect: 'on' }, { env, log: (l) => lines.push(l) });
    expect(lines).toEqual([
      'policy-cascade · prStack: detect="off" (platform)',
      'policy-cascade · prStack: detect="on" (tool)',
    ]);
  });
  it('is silent under test unless enabled', () => {
    const lines = [];
    logCascadeSources('x', { value: 1, sources: { '': 'tool' } }, { env: { VITEST: 'true' }, log: (l) => lines.push(l) });
    expect(lines).toEqual([]);
  });
});

describe('readPlatformPreferences — platform files merge per leaf, not per policy', () => {
  it('an operator build block adding keys keeps the repo platform build leaves it does not set', () => {
    const files = {
      repo: { build: { finalGate: 'related', finalGateStandards: 'selected' }, verify: { shardMinTests: 20 } },
      operator: { build: { priority: ['1'], finalGate: 'full' }, verify: { shardMinTests: 0 } },
    };
    const readFile = (p) => JSON.stringify(/delivery-platform-preferences/.test(p) ? files.repo
      : /platform-preferences\.json$/.test(p) ? files.operator : (() => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); })());
    const { prefs } = readPlatformPreferences({ env: {}, readFile });
    expect(prefs.build).toEqual({ finalGate: 'full', finalGateStandards: 'selected', priority: ['1'] });
    expect(prefs.verify).toEqual({ shardMinTests: 0 });
  });
});


describe('operator-only findingClasses', () => {
  it('ignores repo and legacy copies with warnings and accepts the operator file', () => {
    const warnings = [];
    const r = readPlatformPreferences({ env: {}, warn: m => warnings.push(m), readFile: path =>
      JSON.stringify({ findingClasses: { 'theoretical-race': path.includes('.claude') ? 'fix-now' : 'defer-card' } }) });
    expect(r.prefs.findingClasses).toEqual({ 'theoretical-race': 'fix-now' });
    expect(warnings.filter(m => m.includes('findingClasses'))).toHaveLength(2);
  });
  it('ignores tool and env values in both the named and nested cascade', () => {
    const policy = { 'theoretical-race': 'defer-card', allowSecurityDefer: true };
    expect(cascadePolicy('findingClasses', policy, { platform: {}, envValues: policy, env: {} }).value).toEqual({});
    expect(resolveCascade({ standard: {}, tool: { findingClasses: policy }, envValues: { findingClasses: policy } }).value).toEqual({});
    expect(resolveCascade({ standard: {}, envValues: { '': { findingClasses: policy } } }).value).toEqual({});
  });
});

it('cardNumbering reports independent source layers and ignores invalid env values', async () => {
  const { resolveCardNumbering } = await import('../policy-cascade.mjs');
  const logs = [];
  const result = resolveCardNumbering({ tool: { mode: 'rename-before-enqueue' }, platform: { ledgerAuth: 'signed' },
    env: { WE_CARD_NUMBERING_MODE: 'ledger-only', WE_CARD_LEDGER_AUTH: 'invalid', WE_POLICY_CASCADE_LOG: '1' }, log: l => logs.push(l) });
  expect(result.value).toMatchObject({ mode: 'ledger-only', ledgerAuth: 'signed' });
  expect(result.sources).toMatchObject({ mode: 'env', ledgerAuth: 'platform' });
  expect(result.invalid).toEqual([expect.stringContaining('invalid')]);
  expect(logs.join(' ')).toContain('ledgerAuth="signed" (platform)');
});


describe('operator-db capacity layer above environment (R907/R915)', () => {
  const valid = { maxLiveReviewRounds: v => Number.isInteger(v) && v >= 1 && v <= 8 };
  const layers = { standard: { maxLiveReviewRounds: 1 }, platform: { maxLiveReviewRounds: 2 },
    tool: { maxLiveReviewRounds: 3 }, envValues: { maxLiveReviewRounds: 4 }, valid };

  it('operator override beats env, tool, platform and standard and prints operator-db', () => {
    const r = resolveCascade({ ...layers, operatorOverride: { maxLiveReviewRounds: 5 } });
    expect(r.value).toEqual({ maxLiveReviewRounds: 5 });
    expect(r.sources.maxLiveReviewRounds).toBe('operator-db');
    expect(formatCascadeSourcesLine('reviewConcurrency', r)).toContain('maxLiveReviewRounds=5 (operator-db)');
  });
  it('invalid operator override falls back to env and is listed in invalid', () => {
    const r = resolveCascade({ ...layers, operatorOverride: { maxLiveReviewRounds: 'bad' } });
    expect(r.value.maxLiveReviewRounds).toBe(4);
    expect(r.sources.maxLiveReviewRounds).toBe('env');
    expect(r.invalid).toContain('operator-db.maxLiveReviewRounds="bad"');
  });
  it('no operator layer preserves the full existing result', () => {
    expect(resolveCascade(layers)).toEqual(resolveCascade({ ...layers, operatorOverride: {} }));
    expect(resolveCascade(layers).value.maxLiveReviewRounds).toBe(4);
  });
  it.each([{ fixCap: { floor: 7 } }, { 'fixCap.floor': 7 }])('accepts nested or dotted override maps: %j', operatorOverride => {
    const r = resolveCascade({ standard: { fixCap: { floor: 2, ceiling: 10 } }, operatorOverride });
    expect(r.value).toEqual({ fixCap: { floor: 7, ceiling: 10 } });
    expect(r.sources['fixCap.floor']).toBe('operator-db');
    expect(r.sources['fixCap.ceiling']).toBe('standard');
  });
  it('cascadePolicy supports an explicit operator layer seam and logs its provenance', () => {
    resetCascadeLogForTest(); const lines = [];
    const r = cascadePolicy('reviewConcurrency', layers.tool, { ...layers, platform: layers.platform,
      operatorOverride: { maxLiveReviewRounds: 6 }, env: { WE_POLICY_CASCADE_LOG: '1' }, log: line => lines.push(line) });
    expect(r.value.maxLiveReviewRounds).toBe(6);
    expect(lines.join(' ')).toContain('maxLiveReviewRounds=6 (operator-db)');
  });
  it('reads the file every call and filters by the exact policy prefix', () => {
    const path = file({ 'reviewConcurrency.maxLiveReviewRounds': 7, 'host.maxReviewDispatchPerTick': 8 });
    const options = { standard: layers.standard, platform: null, env: { WE_OPERATOR_OVERRIDE_FILE: path }, valid };
    expect(cascadePolicy('reviewConcurrency', {}, options).value).toEqual({ maxLiveReviewRounds: 7 });
    writeFileSync(path, JSON.stringify({ 'reviewConcurrency.maxLiveReviewRounds': 5 }));
    expect(cascadePolicy('reviewConcurrency', {}, options).value).toEqual({ maxLiveReviewRounds: 5 });
    expect(cascadePolicy('review', {}, options).value).toEqual({ maxLiveReviewRounds: 1 });
  });
  it('does not read the real host operator file under test without a seam or explicit file env', async () => {
    const read = vi.fn(() => { throw new Error('unexpected host operator file read'); });
    vi.resetModules();
    vi.doMock('../operator-override-store.mjs', async importOriginal => ({ ...await importOriginal(), readOperatorOverrides: read }));
    try {
      const { cascadePolicy: isolated } = await import('../policy-cascade.mjs');
      expect(isolated('reviewConcurrency', {}, { standard: layers.standard, platform: null, env: { VITEST: 'true' } }).value)
        .toEqual(layers.standard);
      expect(read).not.toHaveBeenCalled();
    } finally { vi.doUnmock('../operator-override-store.mjs'); vi.resetModules(); }
  });
  it('review daemon liveReviewRoundBudget reports the real operator-db cap without a daemon edit', () => {
    const r = liveReviewRoundBudget({ env: { WE_OPERATOR_OVERRIDE_FILE: file({ 'reviewConcurrency.maxLiveReviewRounds': 7 }),
      WE_REVIEW_MAX_LIVE_ROUNDS: '2' }, listCommands: () => '', toolPath: file({ maxLiveReviewRounds: 3 }) });
    expect(r).toMatchObject({ max: 7, live: 0, left: 7 });
    expect(r.reason).toContain('maxLiveReviewRounds=7 (operator-db)');
  }, 30_000);
});

it('unreadable operator layer ignores platform, tool and env capacity raises in both cascade results', () => {
  const path = file({}); writeFileSync(path, '{');
  const log = vi.fn();
  const r = cascadePolicy('reviewConcurrency', { maxLiveReviewRounds: 7 }, {
    standard: { maxLiveReviewRounds: 1 }, platform: { maxLiveReviewRounds: 8 },
    envValues: { maxLiveReviewRounds: 6 }, env: { WE_OPERATOR_OVERRIDE_FILE: path }, log });
  expect(r.value.maxLiveReviewRounds).toBe(1);
  expect(r.layered.maxLiveReviewRounds).toBe(1);
  expect(r.sources.maxLiveReviewRounds).toBe('standard');
  expect(log.mock.calls.flat().join(' ')).toContain('operator-db-unreadable');
  const pure = resolveCascade({ standard: { maxLiveReviewRounds: 1 }, platform: { maxLiveReviewRounds: 8 },
    envValues: { maxLiveReviewRounds: 6 }, operatorOverride: null, log });
  expect(pure.value.maxLiveReviewRounds).toBe(1);
  writeFileSync(path, '{}');
  expect(cascadePolicy('reviewConcurrency', {}, { standard: { maxLiveReviewRounds: 1 },
    platform: { maxLiveReviewRounds: 8 }, env: { WE_OPERATOR_OVERRIDE_FILE: path } }).value.maxLiveReviewRounds).toBe(8);
});
