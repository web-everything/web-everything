
const operatorFixture = await vi.hoisted(async () => {
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { randomUUID } = await import('node:crypto');
  // Imported readers resolve policy before beforeEach installs the per-test store.
  return { file: join(tmpdir(), `missing-operator-${randomUUID()}.json`) };
});
vi.mock('../operator-override-reader.mjs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, readOperatorOverrides: options => {
    const file = options?.file ?? operatorFixture.file;
    if (!file) throw new Error('Test must inject an operator-store file');
    return actual.readOperatorOverrides({ ...options, file });
  } };
});
// Exercise the real reader/cascade with a temporary store via its explicit file seam.
const operatorEnv = file => { operatorFixture.file = file; return {}; };
// Policy cascade (agent-memory 151; card x5wnfcg; operator go 2026-10-10): every delivery setting on main resolves
// standard default → PLATFORM preference → tool/repo override → env through the ONE shared resolver
// (we:scripts/lib/policy-cascade.mjs), and logs the source layer of its effective value.
//
// Table-driven: each row is one main setting, read through its REAL reader. For every row:
//   (a) no tool override + a platform preference  → the reader returns the PLATFORM value;
//   (b) a tool override + a platform preference   → the TOOL value wins.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_ENVS = [
  { VITEST: 'true' },
  { WE_UNDER_TEST: '1' },
  { NODE_ENV: 'test' },
  { VITEST: 'true', WE_UNDER_TEST: '1', NODE_ENV: 'test' },
];

import {
  resolveCascade, cascadePolicy, formatCascadeSourcesLine, logCascadeSources, readPlatformPreferences,
  resetCascadeLogForTest, PLATFORM_PREFERENCES_ENV, POLICY_CASCADE_LOG_ENV,
} from '../policy-cascade.mjs';
import * as operatorStore from '../operator-override-reader.mjs';
import { readBuildQueuePrioritySettings } from '../build-queue.mjs';
import { readOpenPrCapScope } from '../open-pr-cap-scope.mjs';
import { resolveDeliveryCapacity } from '../delivery-capacity.mjs';
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
import { unattendedAcceptPolicy } from '../unattended-review-accept.mjs';
import { resolveReviewCareExemptPaths, DEFAULT_CARE_EXEMPT_PATHS } from '../review-care-exempt-paths.mjs';
import { resolveRedTeamProbes } from '../red-team-gate.mjs';

describe('D15 slice 1: env may only tighten a safety key', () => {
  const ENV_KEY = 'WE_REVIEW_UNATTENDED_ACCEPT_REQUIRES_CLEAN_REFERRALS';
  const accept = (value) => unattendedAcceptPolicy({ env: { [ENV_KEY]: value, VITEST: 'true' }, tool: {}, platform: {}, log: () => {} });
  it('env may only tighten a safety key: WE_REVIEW_UNATTENDED_ACCEPT_REQUIRES_CLEAN_REFERRALS=off keeps true', () => {
    const r = accept('off');
    expect(r.value.unattendedAcceptRequiresCleanReferrals).toBe(true);
    expect(r.sources.unattendedAcceptRequiresCleanReferrals).toBe('standard');
    expect(r.invalid.some(s => s.startsWith('env.unattendedAcceptRequiresCleanReferrals=false'))).toBe(true);
  });
  it('env value equal to the current value applies', () => {
    const r = accept('on');
    expect(r.value.unattendedAcceptRequiresCleanReferrals).toBe(true);
    expect(r.invalid).toEqual([]);
  });
  it('an invalid env value is refused as before', () => {
    const r = accept('banana');
    expect(r.value.unattendedAcceptRequiresCleanReferrals).toBe(true);
    expect(r.invalid.some(s => s.startsWith('env.'))).toBe(true);
  });
  it('env may only tighten: a care-exempt subset applies and a superset is refused', () => {
    const file = '/nonexistent/care-exempt.json';
    const subset = resolveReviewCareExemptPaths({ env: { WE_REVIEW_CARE_EXEMPT_PATHS: JSON.stringify([DEFAULT_CARE_EXEMPT_PATHS[0]]) }, file, log: () => {} });
    expect(subset.value).toEqual([DEFAULT_CARE_EXEMPT_PATHS[0]]);
    const superset = resolveReviewCareExemptPaths({ env: { WE_REVIEW_CARE_EXEMPT_PATHS: JSON.stringify([...DEFAULT_CARE_EXEMPT_PATHS, 'data/generated/extra/report.json']) }, file, log: () => {} });
    expect(superset.value).toEqual([...DEFAULT_CARE_EXEMPT_PATHS]);
    expect(superset.invalid.length).toBe(1);
  });
  it('env may only tighten red-team probes: skipCardOnly=false applies, recheckReadsRepo=false is refused', () => {
    const r = resolveRedTeamProbes({ env: { WE_RED_TEAM_SKIP_CARD_ONLY: 'off', WE_RED_TEAM_RECHECK_READS_REPO: 'off' } });
    expect(r.value.skipCardOnly).toBe(false);
    expect(r.value.recheckReadsRepo).toBe(true);
    expect(r.invalid.length).toBe(1);
  });
  it('an unclassed env leaf applies as today and is shadow-reported', () => {
    const r = resolveRedTeamProbes({ env: { WE_RED_TEAM_STATUS_LABELS: 'off' } });
    expect(r.value.statusLabels).toBe(false);
    expect(r.shadow).toContain('env.statusLabels');
  });
  it('whole-key env object: the loosening leaf is refused, the tightening leaf is kept', () => {
    const o = resolveCascade({ policy: 'redTeam', standard: { recheckReadsRepo: true, skipCardOnly: true, extra: 1 },
      envValues: { recheckReadsRepo: false, skipCardOnly: false, extra: 2 }, log: () => {} });
    expect(o.value).toEqual({ recheckReadsRepo: true, skipCardOnly: false, extra: 2 });
    expect(o.invalid.length).toBe(1);
  });
  it('an object replacing a classed safety leaf is refused as one value', () => {
    const r = resolveCascade({ policy: 'redTeam', standard: { skipCardOnly: false },
      envValues: { skipCardOnly: { x: 1 } }, log: () => {} });
    expect(r.value.skipCardOnly).toBe(false);
    expect(r.invalid.length).toBe(1);
  });
  it('a malformed env care-exempt list never restores built-in exemptions over tool []', () => {
    const r = resolveReviewCareExemptPaths({ env: { WE_REVIEW_CARE_EXEMPT_PATHS: 'garbage' },
      file: 'x', readFile: () => '{"careExemptPaths":[]}', log: () => {} });
    expect(r.value).toEqual([]);
  });
  it('a type mismatch on a classed leaf counts as loosening', () => {
    const r = resolveCascade({ policy: 'review', standard: { unattendedAcceptRequiresCleanReferrals: true },
      envValues: { unattendedAcceptRequiresCleanReferrals: 'yes' }, log: () => {} });
    expect(r.value.unattendedAcceptRequiresCleanReferrals).toBe(true);
    expect(r.invalid.length).toBe(1);
  });
});

beforeEach(() => { operatorFixture.file = join(dir, 'missing-operator-overrides.json'); });
const dir = mkdtempSync(join(tmpdir(), 'policy-cascade-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = (data) => { const p = join(dir, `f${n += 1}.json`); writeFileSync(p, JSON.stringify(data)); return p; };
/** A clean env holding only the platform-preference file (no reader env overrides). */
const envWith = (platform) => ({ [PLATFORM_PREFERENCES_ENV]: file(platform) });
const settingsReader = (block) => () => block;

describe('R907 test flags never bypass operator-store reads', () => {
  it.each(TEST_ENVS)('applies a restrictive injected store with env %j', flags => {
    operatorEnv(file({ 'reviewConcurrency.maxLiveReviewRounds': 1 }));
    const r = cascadePolicy('reviewConcurrency', { maxLiveReviewRounds: 7 }, {
      standard: { maxLiveReviewRounds: 3 }, platform: { maxLiveReviewRounds: 8 },
      envValues: { maxLiveReviewRounds: 6 }, env: flags,
    });
    expect(r.value.maxLiveReviewRounds).toBe(1);
    expect(r.layered.maxLiveReviewRounds).toBe(1);
    expect(r.sources.maxLiveReviewRounds).toBe('operator-db');
  });

  it.each(TEST_ENVS)('fails closed for a malformed injected store with env %j', flags => {
    const path = file({}); writeFileSync(path, '{'); operatorEnv(path);
    const log = vi.fn();
    const r = cascadePolicy('reviewConcurrency', { maxLiveReviewRounds: 7 }, {
      standard: { maxLiveReviewRounds: 3 }, platform: { maxLiveReviewRounds: 8 },
      envValues: { maxLiveReviewRounds: 6 }, env: flags, log,
    });
    expect(r.value.maxLiveReviewRounds).toBe(3);
    expect(r.layered.maxLiveReviewRounds).toBe(3);
    expect(r.sources.maxLiveReviewRounds).toBe('standard');
    expect(log.mock.calls.flat().join(' ')).toContain('operator-db-unreadable');
  });

  it.each([
    'policy-cascade.mjs', 'host-overload-settings.mjs', 'resource-gate.mjs',
    'red-team-dispatch-queue.mjs', 'operator-override-store.mjs',
  ])('guards %s against test-flag bypasses in the operator-store read path', name => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', name), 'utf8');
    // Grep-style guard against direct flag checks in every participating reader.
    expect(source).not.toMatch(/\b(?:WE_UNDER_TEST|VITEST)\b/);
    if (name === 'policy-cascade.mjs') {
      // Logging may use isUnderTest; operator reads must never call that helper.
      const readPath = source.match(/export function readOperatorPolicy\([\s\S]*?\n\}/)?.[0];
      expect(readPath).toBeDefined();
      expect(readPath).not.toMatch(/\b(?:isUnderTest|NODE_ENV)\b/);
    }
  });
});

/**
 * Each row: `platform` (the platform-preference file body), `tool` (the tool block, or undefined = no override),
 * `read(env, tool)` (the real reader), and the expected platform / tool values.
 */
const ROWS = [
  ...[
    ['mode', { mode: 'units' }, { mode: 'count' }, 'units', 'count'],
    ['population', { population: 'builder' }, { population: 'all' }, 'builder', 'all'],
    ['openPrCap', { openPrCap: 24 }, { openPrCap: 12 }, 24, 12],
    ['unitCap', { unitCap: 40 }, { unitCap: 20 }, 40, 20],
    ['weights.cards', { weights: { cards: 0.75 } }, { weights: { cards: 0.25 } }, 0.75, 0.25],
    ['sizeLines.S', { sizeLines: { S: 180 } }, { sizeLines: { S: 120 } }, 180, 120],
    ['acceptedWeight', { acceptedWeight: 0.5 }, { acceptedWeight: 0 }, 0.5, 0],
    ['heldCap', { heldCap: 6 }, { heldCap: 3 }, 6, 3],
    ['idleMinPct', { idleMinPct: 20 }, { idleMinPct: 10 }, 20, 10],
    ['memMinGb', { memMinGb: 6 }, { memMinGb: 3 }, 6, 3],
    ['maxStartsPerCheck', { maxStartsPerCheck: 6 }, { maxStartsPerCheck: 2 }, 6, 2],
  ].map(([leaf, platform, tool, platformValue, toolValue]) => ({
    setting: `deliveryCapacity.${leaf}`, platform: { deliveryCapacity: platform }, tool,
    read: (env, tool) => leaf.split('.').reduce((value, key) => value[key],
      resolveDeliveryCapacity({ env, read: settingsReader({ deliveryCapacity: tool }) }).value),
    platformValue, toolValue,
  })),
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
  it('invalid operator override fails closed instead of accepting a looser env cap', () => {
    const r = resolveCascade({ ...layers, operatorOverride: { maxLiveReviewRounds: 'bad' } });
    expect(r.value.maxLiveReviewRounds).toBe(1);
    expect(r.sources.maxLiveReviewRounds).toBe('standard');
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
    const options = { standard: layers.standard, platform: null, env: { ...operatorEnv(path) }, valid };
    expect(cascadePolicy('reviewConcurrency', {}, options).value).toEqual({ maxLiveReviewRounds: 7 });
    writeFileSync(path, JSON.stringify({ 'reviewConcurrency.maxLiveReviewRounds': 5 }));
    expect(cascadePolicy('reviewConcurrency', {}, options).value).toEqual({ maxLiveReviewRounds: 5 });
    expect(cascadePolicy('review', {}, options).value).toEqual({ maxLiveReviewRounds: 1 });
  });
  it('isolates the operator reader with a missing temporary file instead of test flags', () => {
    const read = vi.spyOn(operatorStore, 'readOperatorOverrides');
    try {
      expect(cascadePolicy('reviewConcurrency', {}, {
        standard: layers.standard, platform: null, env: { VITEST: 'true', WE_UNDER_TEST: '1' },
      }).value).toEqual(layers.standard);
      expect(read).toHaveBeenCalled();
      expect(operatorFixture.file).toBe(join(dir, 'missing-operator-overrides.json'));
    } finally { read.mockRestore(); }
  });
  it('review daemon liveReviewRoundBudget reports the real operator-db cap without a daemon edit', () => {
    const r = liveReviewRoundBudget({ env: { ...operatorEnv(file({ 'reviewConcurrency.maxLiveReviewRounds': 7 })),
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
    envValues: { maxLiveReviewRounds: 6 }, env: { ...operatorEnv(path) }, log });
  expect(r.value.maxLiveReviewRounds).toBe(1);
  expect(r.layered.maxLiveReviewRounds).toBe(1);
  expect(r.sources.maxLiveReviewRounds).toBe('standard');
  expect(log.mock.calls.flat().join(' ')).toContain('operator-db-unreadable');
  const pure = resolveCascade({ standard: { maxLiveReviewRounds: 1 }, platform: { maxLiveReviewRounds: 8 },
    envValues: { maxLiveReviewRounds: 6 }, operatorOverride: null, log });
  expect(pure.value.maxLiveReviewRounds).toBe(1);
  writeFileSync(path, '{}');
  expect(cascadePolicy('reviewConcurrency', {}, { standard: { maxLiveReviewRounds: 1 },
    platform: { maxLiveReviewRounds: 8 }, env: { ...operatorEnv(path) } }).value.maxLiveReviewRounds).toBe(8);
});


it.each([null, 8, 1])('unreadable operator store keeps review concurrency finite and preserves stricter configured %j', configured => {
  const path = file({}); writeFileSync(path, '{');
  const log = vi.fn();
  const r = cascadePolicy('reviewConcurrency', { maxLiveReviewRounds: configured }, {
    standard: { maxLiveReviewRounds: null }, platform: null,
    env: { ...operatorEnv(path) }, log });
  const expected = configured === 1 ? 1 : 3;
  expect(r.value.maxLiveReviewRounds).toBe(expected);
  expect(r.layered.maxLiveReviewRounds).toBe(expected);
  expect(log.mock.calls.flat().join(' ')).toContain('operator-db-unreadable reviewConcurrency.maxLiveReviewRounds');
});

it('unreadable operator layer preserves nested and flat stricter thresholds and caps', () => {
  for (const standard of [{ fixCap: { floor: 2, ceiling: 6, raiseMinMemFreePct: 40 } },
    { 'fixCap.floor': 2, 'fixCap.ceiling': 6, 'fixCap.raiseMinMemFreePct': 40 }]) {
    const flat = Object.hasOwn(standard, 'fixCap.floor');
    const tool = flat ? { 'fixCap.floor': 1, 'fixCap.ceiling': 1, 'fixCap.raiseMinMemFreePct': 60 }
      : { fixCap: { floor: 1, ceiling: 1, raiseMinMemFreePct: 60 } };
    const r = resolveCascade({ standard, tool, operatorOverride: null, log: () => {} });
    expect(r.leafValues).toMatchObject({ 'fixCap.floor': 1, 'fixCap.ceiling': 1, 'fixCap.raiseMinMemFreePct': 60 });
  }
});


it('review daemon budget never returns uncapped concurrency on corrupt operator evidence', () => {
  const path = file({}); writeFileSync(path, '{');
  const r = liveReviewRoundBudget({ env: { ...operatorEnv(path) },
    listCommands: () => '', toolPath: file({}) });
  expect(r).toMatchObject({ max: 3, live: 0, left: 3 });
  expect(r.reason).toContain('maxLiveReviewRounds=3');
});


describe('R907 malformed review capacity evidence', () => {
  it('accepts an operator live-review cap of 16 with operator provenance', () => {
    operatorEnv(file({ 'reviewConcurrency.maxLiveReviewRounds': 16 }));
    const budget = liveReviewRoundBudget({ env: { WE_REVIEW_MAX_LIVE_ROUNDS: '8' },
      listCommands: () => '', toolPath: file({ maxLiveReviewRounds: 8 }) });
    expect(budget).toMatchObject({ max: 16, live: 0, left: 16 });
    expect(budget.reason).toContain('maxLiveReviewRounds=16 (operator-db)');
  });

  it.each([
    ['wrong type', 'reviewConcurrency.maxLiveReviewRounds', '1'],
    ['above hard cap', 'reviewConcurrency.maxLiveReviewRounds', 17],
    ['below hard floor', 'reviewConcurrency.maxLiveReviewRounds', 0],
    ['unknown key', 'reviewConcurrency.unknown', 1],
    ['non-allowlisted guard', 'reviewConcurrency.enabled', false],
  ])('%s fails closed for both cascade results and daemon budget', (_label, key, value) => {
    const path = file({ [key]: value });
    operatorEnv(path);
    const log = vi.fn();
    for (const configured of [8, 1, null]) {
      const r = cascadePolicy('reviewConcurrency', { maxLiveReviewRounds: configured }, {
        standard: { maxLiveReviewRounds: 3 }, platform: null, env: {}, log,
      });
      const expected = configured === 1 ? 1 : 3;
      expect(r.value.maxLiveReviewRounds).toBe(expected);
      expect(r.layered.maxLiveReviewRounds).toBe(expected);
    }
    const budget = liveReviewRoundBudget({ env: { WE_REVIEW_MAX_LIVE_ROUNDS: '8' },
      listCommands: () => '', toolPath: file({ maxLiveReviewRounds: 8 }) });
    expect(budget).toMatchObject({ max: 3, live: 0, left: 3 });
    expect(log.mock.calls.flat().join(' ')).toMatch(/operator-db-(unreadable|invalid)/);
  });
  it('R907 ignores a caller-supplied env store path without a file seam', () => {
    const path = file({ 'reviewConcurrency.maxLiveReviewRounds': 8 });
    expect(cascadePolicy('reviewConcurrency', {}, {
      standard: { maxLiveReviewRounds: 3 }, platform: null,
      env: { VITEST: 'true', WE_OPERATOR_OVERRIDE_FILE: path },
    }).value.maxLiveReviewRounds).toBe(3);
  });
});


describe('SD15 owner layers', () => {
  const quiet = () => {};
  const safety = { policy: 'ciUnitRerun', standard: { maxFiles: 9 }, log: quiet };
  it('an unclassified safety leaf cannot be loosened through the environment', () => {
    const r = resolveCascade({ policy: 'futureGate', standard: { required: true }, safetyLeaves: ['required'],
      envValues: { required: false }, log: quiet });
    expect(r.value.required).toBe(true);
    expect(r.sources.required).toBe('standard');
    expect(r.invalid.join(' ')).toMatch(/unclassified.*repair/);
  });
  it('company org team repo sources remain distinct', () => {
    const r = resolveCascade({ standard: {}, company: { a: 1 }, org: { b: 2 }, team: { c: 3 }, repo: { d: 4 } });
    expect(r.value).toEqual({ a: 1, b: 2, c: 3, d: 4 });
    expect(r.sources).toEqual({ a: 'company', b: 'org', c: 'team', d: 'repo' });
  });
  it('nine conflicting owner layers resolve in declared precedence order', () => {
    const names = ['standard', 'platform', 'company', 'org', 'team', 'repo', 'tool', 'env', 'operator'];
    const values = [1, 2, 3, 4, 5, 6, 8, 7, 9];
    const confirmations = {};
    for (let i = 1; i < names.length; i++) confirmations[names[i]] = { maxFiles: names.slice(0, i) };
    for (let highest = 8; highest >= 0; highest--) {
      const layers = Object.fromEntries(names.slice(0, highest + 1).map((name, i) =>
        [name === 'env' ? 'envValues' : name, { maxFiles: values[i] }]));
      const r = resolveCascade({ ...layers, policy: 'ciUnitRerun', confirmations, log: quiet });
      expect(r.value.maxFiles).toBe(values[highest]);
      expect(r.sources.maxFiles).toBe(names[highest]);
      expect(formatCascadeSourcesLine('ciUnitRerun', r)).toContain(`maxFiles=${values[highest]} (${names[highest]})`);
    }
  });
  it('missing owner confirmation refuses', () => {
    const r = resolveCascade({ ...safety, company: { maxFiles: 2 }, org: { maxFiles: 3 }, team: { maxFiles: 4 },
      confirmations: { org: { maxFiles: ['company'] }, team: { maxFiles: ['org'] } } });
    expect(r.value.maxFiles).toBe(3);
    expect(r.sources.maxFiles).toBe('org');
    expect(r.invalid.join(' ')).toMatch(/team.*company.*confirmation/);
  });
  it('checks every lower owner even when the immediate value is looser', () => {
    const r = resolveCascade({ ...safety, company: { maxFiles: 2 }, org: { maxFiles: 5 }, team: { maxFiles: 4 },
      confirmations: { org: { maxFiles: ['company'] } } });
    expect(r.value.maxFiles).toBe(5);
    expect(r.invalid.join(' ')).toMatch(/team.*company.*confirmation/);
  });
  it('type mismatch refuses and valid tightening still applies', () => {
    const r = resolveCascade({ ...safety, company: { maxFiles: 4 }, envValues: { maxFiles: '3' } });
    expect(r.value.maxFiles).toBe(4);
    expect(r.invalid).toHaveLength(1);
    expect(resolveCascade({ ...safety, company: { maxFiles: 4 }, envValues: { maxFiles: 3 } }).sources.maxFiles).toBe('env');
  });
  it('env redirect cannot supply operator-only keys', () => {
    const path = file({ findingClasses: { probe: 'allow' }, routingOverrides: { probe: 1 } });
    const warn = vi.fn();
    const r = readPlatformPreferences({ env: { [PLATFORM_PREFERENCES_ENV]: path }, readFile: readFileSync, warn,
      operatorPath: join(dir, 'trusted-operator.json') });
    expect(r.prefs).toEqual({});
    expect(warn).toHaveBeenCalledTimes(2);
  });
  it.each(['platform', 'company', 'org', 'team', 'repo', 'tool', 'operator'])(
    'malformed owner layer refuses safety resolution instead of falling through: %s', layer => {
      const path = file({}); writeFileSync(path, '{');
      const r = cascadePolicy('ciUnitRerun', {}, { ...safety, platform: {}, env: {}, operatorOverride: {},
        ownerFiles: { [layer]: path }, readFile: readFileSync, operatorPath: join(dir, 'operator.json') });
      expect(r.value.maxFiles).toBeUndefined();
      expect(r.sources.maxFiles).toBe(`unresolved:${layer}`);
      expect(r.invalid.join(' ')).toMatch(new RegExp(`${layer}.*repair`));
      expect(r.layered?.maxFiles).toBeUndefined();
    });
  it('old five-layer fixture migrates explicitly', () => {
    const persisted = JSON.parse('{"standard":{"limit":1},"platform":{"limit":2},"tool":{"limit":3},"envValues":{"limit":4},"operatorOverride":{"maxLiveReviewRounds":5}}');
    const r = resolveCascade({ ...persisted, capacityLeaves: ['maxLiveReviewRounds'] });
    expect(r.value).toEqual({ limit: 4, maxLiveReviewRounds: 5 });
    expect(r.sources).toEqual({ limit: 'env', maxLiveReviewRounds: 'operator-db' });
  });
  it('real reader resolves frozen owner files and emits daemon provenance', () => {
    const ownerFiles = Object.freeze({ company: file({ ciUnitRerun: { maxFiles: 6 } }), team: file({ ciUnitRerun: { maxFiles: 4 } }) });
    const lines = [];
    const r = cascadePolicy('ciUnitRerun', {}, { ...safety, platform: {}, ownerFiles, readFile: readFileSync,
      operatorOverride: {}, envValues: { maxFiles: 5 }, env: { WE_POLICY_CASCADE_LOG: '1' }, log: line => lines.push(line) });
    expect(r.value.maxFiles).toBe(4);
    expect(r.sources.maxFiles).toBe('team');
    expect(lines.join(' ')).toMatch(/maxFiles=4 \(team\).*env.maxFiles=5/);
  });
});


describe('SD15 personal preferences provenance', () => {
  it('personal values stay distinct from platform defaults and win over tool values', () => {
    const platformPath = file({ ui: { colour: 'platform', density: 'compact' } });
    const operatorPath = file({ ui: { colour: 'personal' } });
    const r = cascadePolicy('ui', { colour: 'tool' }, { standard: {}, env: {}, readFile: readFileSync,
      platformPaths: [platformPath], operatorPath, operatorOverride: {}, log: () => {} });
    expect(r.value).toEqual({ colour: 'personal', density: 'compact' });
    expect(r.sources).toEqual({ colour: 'operator', density: 'platform' });
  });
  it('an env-selected safety file has env trust and cannot loosen the standard', () => {
    const path = file({ ciUnitRerun: { maxFiles: 10 } });
    const r = cascadePolicy('ciUnitRerun', {}, { standard: { maxFiles: 2 },
      env: { [PLATFORM_PREFERENCES_ENV]: path }, readFile: readFileSync,
      operatorPath: join(dir, 'operator.json'), operatorOverride: {}, log: () => {} });
    expect(r.value.maxFiles).toBe(2);
    expect(r.sources.maxFiles).toBe('standard');
    expect(r.invalid.join(' ')).toMatch(/env.maxFiles=10/);
  });
  it('an unclassified safety value without a default remains unresolved with repair provenance', () => {
    const r = resolveCascade({ policy: 'futureGate', safetyLeaves: ['required'], envValues: { required: false }, log: () => {} });
    expect(r.value?.required).toBeUndefined();
    expect(r.invalid.join(' ')).toMatch(/unclassified.*repair/);
  });
});


it('operator loosening requires the affected env owner confirmation', () => {
  const r = resolveCascade({ policy: 'ciUnitRerun', standard: { maxFiles: 9 },
    envValues: { maxFiles: 2 }, operator: { maxFiles: 3 }, confirmations: {}, log: () => {} });
  expect(r.value.maxFiles).toBe(2);
  expect(r.sources.maxFiles).toBe('env');
  expect(r.invalid.join(' ')).toMatch(/operator.*env.*confirmation/);
});

it('confirmations cannot authorize an incomparable safety value', () => {
  const r = resolveCascade({ policy: 'ciUnitRerun', standard: { maxFiles: 9 }, company: { maxFiles: 'bad' },
    confirmations: { company: { maxFiles: ['standard'] } }, log: () => {} });
  expect(r.value.maxFiles).toBe(9);
  expect(r.invalid.join(' ')).toMatch(/company.*incomparable.*repair/);
});


it.each([
  ['scalar', true, false, '', true, { '': 'standard' }],
  ['object', { required: true }, { required: false }, 'required', { required: true }, { required: 'standard' }],
])('an env-selected %s reader-declared safety value preserves the standard value and source',
  (_shape, standard, redirected, leaf, expected, sources) => {
    const path = file({ futureGate: redirected });
    const r = cascadePolicy('futureGate', undefined, { standard, safetyLeaves: [leaf],
      env: { [PLATFORM_PREFERENCES_ENV]: path }, readFile: readFileSync,
      operatorPath: join(dir, 'operator.json'), operatorOverride: {}, log: () => {} });
    expect(r.value).toEqual(expected);
    expect(r.sources).toEqual(sources);
    expect(r.platform).toEqual(leaf === '' ? undefined : {});
    expect(r.invalid.join(' ')).toMatch(/unclassified safety; repair direction/);
  });


describe('SD15 audit safety regressions', () => {
  const quiet = () => {};
  it('refuses replacing or erasing ancestors of declared safety leaves', () => {
    for (const replacement of [false, null, {}, { other: true }]) {
      for (const layer of ['company', 'tool', 'operator', 'envValues']) {
        const r = resolveCascade({ policy: 'futureGate', standard: { guard: { required: true } },
          safetyLeaves: ['guard.required'], [layer]: { guard: replacement }, log: quiet });
        expect(r.value.guard.required).toBe(true);
        if (!replacement || layer === 'envValues') expect(r.invalid.join(' ')).toMatch(/ancestor.*safety/);
      }
    }
  });
  it('broken layer evidence preserves stricter effective booleans and numeric limits', () => {
    for (const [leaf, baseline, tighter] of [['enabled', true, false], ['maxFiles', 9, 2]]) {
      const r = resolveCascade({ policy: 'ciUnitRerun', standard: { [leaf]: baseline }, company: { [leaf]: tighter },
        layerErrors: { team: 'incomplete evidence' }, log: quiet });
      expect(r.value[leaf]).toBe(tighter);
      expect(r.sources[leaf]).toBe('unresolved:team');
      expect(r.invalid.join(' ')).toMatch(/team.*repair layer/);
    }
  });
  it('personal preferences cannot weaken an env-set gate with unknown safety direction', () => {
    const r = resolveCascade({ policy: 'build', standard: { finalGate: 'related' },
      envValues: { finalGate: 'full' }, operator: { finalGate: 'none' }, log: quiet });
    expect(r.value.finalGate).toBe('full');
    expect(r.sources.finalGate).toBe('env');
    expect(r.invalid.join(' ')).toMatch(/operator.finalGate.*env.*repair/);
  });
  it('broken or partial layer evidence retains the standard referral guard', () => {
    for (const layer of ['platform', 'company', 'org', 'team', 'repo', 'tool', 'operator']) {
      const r = resolveCascade({ policy: 'review', standard: { unattendedAcceptRequiresCleanReferrals: true },
        company: { unattendedAcceptRequiresCleanReferrals: false }, confirmations: { company: { unattendedAcceptRequiresCleanReferrals: ['standard'] } },
        layerErrors: { [layer]: 'incomplete evidence' }, log: quiet });
      expect(r.value.unattendedAcceptRequiresCleanReferrals).toBe(true);
      expect(r.sources.unattendedAcceptRequiresCleanReferrals).toBe(`unresolved:${layer}`);
      expect(r.invalid.join(' ')).toMatch(/repair layer/);
    }
  });
  it('owner files cannot confer operator-only policy authority', () => {
    for (const policy of ['findingClasses', 'routingOverrides']) {
      for (const layer of ['company', 'org', 'team', 'repo']) {
        const path = file({ [policy]: { probe: 'allow' } });
        const r = cascadePolicy(policy, undefined, { standard: {}, platform: {}, env: {}, operatorOverride: {},
          ownerFiles: { [layer]: path }, readFile: readFileSync, log: quiet });
        expect(r.value).toEqual({});
        expect(r.layered).toEqual({});
        expect(r.invalid.join(' ')).toMatch(/operator-only/);
      }
    }
  });
  it('layered retains the same standard safety baseline as value', () => {
    const r = cascadePolicy('ciUnitRerun', {}, { standard: { maxFiles: 2 }, company: { maxFiles: 10 },
      platform: {}, env: {}, operatorOverride: {}, log: quiet });
    expect(r.value.maxFiles).toBe(2);
    expect(r.layered.maxFiles).toBe(2);
  });
  it('declared safety activates owner checks without explicit owner blocks', () => {
    const r = resolveCascade({ policy: 'futureGate', standard: { required: true }, safetyLeaves: ['required'],
      tool: { required: false }, log: quiet });
    expect(r.value.required).toBe(true);
    expect(r.sources.required).toBe('standard');
    expect(r.invalid.join(' ')).toMatch(/tool.required.*unclassified.*repair/);
  });
  it('owner safety checks reject object replacement at every depth without a validator', () => {
    for (const replacement of [{ bypass: true }, {}, { nested: { bypass: true } }]) {
      for (const policy of ['ciUnitRerun', 'futureGate']) {
        const r = resolveCascade({ policy, standard: { enabled: false }, company: { enabled: replacement },
          ...(policy === 'futureGate' ? { safetyLeaves: ['enabled'] } : {}), log: quiet });
        expect(r.value.enabled).toBe(false);
        expect(r.sources.enabled).toBe('standard');
        expect(r.invalid.join(' ')).toMatch(/company.enabled.*(incomparable|unclassified).*repair/);
      }
    }
  });
  it('personal capacity preferences only tighten environment limits', () => {
    for (const preference of [3, 1]) {
      const operatorPath = file({ reviewConcurrency: { maxLiveReviewRounds: preference } });
      const r = cascadePolicy('reviewConcurrency', {}, { standard: { maxLiveReviewRounds: 3 }, envValues: { maxLiveReviewRounds: 1 },
        env: {}, platformPaths: [], operatorPath, readFile: readFileSync, operatorOverride: {}, log: quiet });
      expect(r.value.maxLiveReviewRounds).toBe(1);
      expect(r.sources.maxLiveReviewRounds).toBe(preference === 1 ? 'operator' : 'env');
      if (preference > 1) expect(r.invalid.join(' ')).toMatch(/operator.*capacity.*tighten/);
    }
  });
});
