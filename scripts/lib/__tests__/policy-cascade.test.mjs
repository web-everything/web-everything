// Policy cascade (agent-memory 151; card x5wnfcg; operator go 2026-10-10): every delivery setting on main resolves
// standard default → PLATFORM preference → tool/repo override → env through the ONE shared resolver
// (we:scripts/lib/policy-cascade.mjs), and logs the source layer of its effective value.
//
// Table-driven: each row is one main setting, read through its REAL reader. For every row:
//   (a) no tool override + a platform preference  → the reader returns the PLATFORM value;
//   (b) a tool override + a platform preference   → the TOOL value wins.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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
