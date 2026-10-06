/**
 * @file scripts/lib/__tests__/daemon-clone-layout.test.mjs
 * @description Card 89 S1 — version folders share clone identity; existing paths retain their keys.
 * Real symlinks and overlay state live only under a temporary workspace.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { canonicalCloneRoot, CLONES_DIR_NAME, logicalCloneRoot } from '../daemon-clone-layout.mjs';
import { cloneKey, readOverlayState, writeOverlays } from '../daemon-overlays.mjs';
import { cloneKeyOf } from '../daemon-last-good.mjs';
import { cloneLockKey } from '../daemon-clone-lock.mjs';
import { workspaceOf } from '../automation-home.mjs';
import { workspaceFor } from '../lane-pool-paths.mjs';
import { lockIdFor } from '../../readiness/file-locks.mjs';
import {
  BUILT_IN_DAEMON_VERSIONS_SETTINGS, isVersionedClone, loadDaemonVersionsSettingsFile,
  resolveDaemonVersionsSettings, validateDaemonVersionsSettings,
} from '../daemon-versions-settings.mjs';

let ws;
beforeEach(() => { ws = realpathSync(mkdtempSync(join(tmpdir(), 'we-clone-layout-'))); });
afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

// Pre-S1 formulas: independent fixtures for preserving today's byte-for-byte identities.
function oldCanonical(root) {
  try { return realpathSync(root); } catch { return resolve(root); }
}
const oldHash = root => createHash('sha256').update(oldCanonical(root)).digest('hex').slice(0, 16);
const oldLock = root => lockIdFor(oldCanonical(root));
function oldWorkspaceOf(root) {
  const path = resolve(String(root));
  const i = path.indexOf(`${sep}.lanes${sep}`);
  return i >= 0 ? path.slice(0, i) : dirname(path);
}
function oldWorkspaceFor(path) {
  const s = String(path || '');
  const laneIndex = s.indexOf(`${sep}.lanes${sep}`);
  const operationsMarker = `${sep}.operations`;
  const operationsIndex = s.indexOf(`${operationsMarker}${sep}`);
  const operationsStart = operationsIndex >= 0 ? operationsIndex
    : s.endsWith(operationsMarker) ? s.length - operationsMarker.length : -1;
  const i = laneIndex < 0 ? operationsStart
    : operationsStart < 0 ? laneIndex : Math.min(laneIndex, operationsStart);
  return i >= 0 ? s.slice(0, i) : dirname(s);
}
const lookups = root => [cloneKey(root), cloneKeyOf(root), cloneLockKey(root), workspaceOf(root), workspaceFor(root)];

describe('daemon clone layout', () => {
  it('maps version/current/previous paths and a real two-hop symlink to the plain clone identity', () => {
    const plain = join(ws, 'wev-x');
    const expected = lookups(plain);
    expect(expected).toEqual([oldHash(plain), oldHash(plain), oldLock(plain), ws, ws]);
    const container = join(ws, CLONES_DIR_NAME, 'wev-x');
    const version = join(container, 'versions', 'v1');
    mkdirSync(join(version, 'scripts'), { recursive: true });
    writeFileSync(join(version, 'scripts/a.mjs'), '');
    symlinkSync('versions/v1', join(container, 'current'));
    symlinkSync('versions/v1', join(container, 'previous'));
    symlinkSync(join(container, 'current'), plain);
    for (const root of [version, join(version, 'scripts/a.mjs'), join(container, 'current'),
      join(container, 'current/scripts/a.mjs'), join(container, 'previous/scripts/a.mjs'), plain]) {
      expect(canonicalCloneRoot(root)).toBe(plain);
      expect(lookups(root)).toEqual(expected);
    }
    const env = { WE_DAEMON_OVERLAY_DIR: join(ws, 'overlay-state') };
    writeOverlays(version, [], { env });
    expect(readOverlayState(plain, { env }).clone).toBe(plain);
  });

  it('uses the outermost marker and matches only complete directory names', () => {
    expect(CLONES_DIR_NAME).toBe('.daemon-clones');
    expect(logicalCloneRoot(join(ws, '.daemon-clones/wev-x/versions/v1/.daemon-clones/inner/current')))
      .toBe(join(ws, 'wev-x'));
    expect(workspaceFor(join(ws, '.daemon-clones/wev-x/versions/v1/.lanes/we/lane-1'))).toBe(ws);
    for (const suffix of ['.daemon-clones', '.daemon-clones-extra/wev-x/current', 'plain/current']) {
      const path = join(ws, suffix);
      expect(logicalCloneRoot(path)).toBe(resolve(path));
    }
    expect(logicalCloneRoot('/.daemon-clones/wev-x/current')).toBe('/wev-x');
  });

  it('preserves old formulas for plain clones, lanes, primary checkouts and ordinary symlinks', () => {
    const plain = join(ws, 'plain');
    mkdirSync(plain);
    symlinkSync(plain, join(ws, 'alias'));
    for (const root of [plain, join(ws, 'missing'), join(ws, 'alias'),
      join(ws, '.lanes/web-everything/lane-7'), join(ws, 'web-everything'),
      join(ws, '.operations/run'), '.', 'relative-clone']) {
      expect(logicalCloneRoot(root)).toBe(resolve(root));
      expect(canonicalCloneRoot(root)).toBe(oldCanonical(root));
      expect(lookups(root)).toEqual([oldHash(root), oldHash(root), oldLock(root), oldWorkspaceOf(root), oldWorkspaceFor(root)]);
    }
  });
});

describe('dormant daemon version settings', () => {
  it('ships the built-in defaults with every clone disabled', () => {
    const config = loadDaemonVersionsSettingsFile();
    expect(config).toEqual(BUILT_IN_DAEMON_VERSIONS_SETTINGS);
    expect(config.enabled).toEqual({});
    for (const name of ['wev-x', 'wev-review-daemon', 'toString', '__proto__']) {
      expect(isVersionedClone(name)).toBe(false);
      expect(isVersionedClone(name, config)).toBe(false);
    }
    expect(loadDaemonVersionsSettingsFile(join(ws, 'missing.json'))).toEqual(config);
    const file = join(ws, 'settings.json');
    writeFileSync(file, '{broken');
    expect(loadDaemonVersionsSettingsFile(file)).toEqual(config);
    expect(isVersionedClone('wev-x', { enabled: { 'wev-x': 'true' } })).toBe(false);
  });

  it.each([
    ['enabled', true], ['enabled', []], ['enabled', { 'wev-x': 'true' }],
    ['enabled', { '../bad': true }], ['clonesRoot', ''], ['clonesRoot', 12],
    ['keep', 0], ['keep', 1.5], ['retainMinAgeMs', -1], ['nodeModules', 'bad'],
    ['nodeModulesStore', false], ['carryPaths', ['../escape']], ['carryPaths', 'target'],
    ['statePaths', ['/absolute']], ['statePaths', [12]], ['carryUntracked', 'true'],
    ['pickup', 'bad'], ['updater', 'bad'], ['probationMs', Infinity],
    ['autoRollback', 1], ['restartJitterMs', -1], ['requestPollMs', 0],
  ])('rejects invalid %s = %j', (key, value) => {
    expect(validateDaemonVersionsSettings({ [key]: value })).toEqual(BUILT_IN_DAEMON_VERSIONS_SETTINGS);
  });

  it('loads valid file values and applies per-key environment overrides', () => {
    const file = join(ws, 'settings.json');
    writeFileSync(file, JSON.stringify({ keep: 4, enabled: { 'wev-x': true, 'wev-y': false } }));
    const fileConfig = loadDaemonVersionsSettingsFile(file);
    expect(isVersionedClone('wev-x', fileConfig)).toBe(true);
    expect(isVersionedClone('wev-y', fileConfig)).toBe(false);
    expect(isVersionedClone('absent', fileConfig)).toBe(false);
    const env = {
      WE_DAEMON_VERSIONS_ENABLED: '{"wev-y":true}', WE_DAEMON_VERSIONS_KEEP: '5',
      WE_DAEMON_VERSIONS_CLONES_ROOT: '/custom/clones', WE_DAEMON_VERSIONS_RETAIN_MIN_AGE_MS: '0',
      WE_DAEMON_VERSIONS_NODE_MODULES: 'store-link', WE_DAEMON_VERSIONS_NODE_MODULES_STORE: '/store',
      WE_DAEMON_VERSIONS_CARRY_PATHS: '["target"]', WE_DAEMON_VERSIONS_STATE_PATHS: '[]',
      WE_DAEMON_VERSIONS_CARRY_UNTRACKED: '0', WE_DAEMON_VERSIONS_PICKUP: 'per-tick',
      WE_DAEMON_VERSIONS_UPDATER: 'in-tick', WE_DAEMON_VERSIONS_PROBATION_MS: '100',
      WE_DAEMON_VERSIONS_AUTO_ROLLBACK: 'false', WE_DAEMON_VERSIONS_RESTART_JITTER_MS: '0',
      WE_DAEMON_VERSIONS_REQUEST_POLL_MS: '1000',
    };
    const { values, sources } = resolveDaemonVersionsSettings({ fileConfig, env });
    expect(values).toEqual({ enabled: { 'wev-y': true }, keep: 5, clonesRoot: '/custom/clones',
      retainMinAgeMs: 0, nodeModules: 'store-link', nodeModulesStore: '/store', carryPaths: ['target'],
      statePaths: [], carryUntracked: false, pickup: 'per-tick', updater: 'in-tick', probationMs: 100,
      autoRollback: false, restartJitterMs: 0, requestPollMs: 1000 });
    expect(Object.values(sources).every(source => source === 'env')).toBe(true);
    const rejected = resolveDaemonVersionsSettings({ fileConfig, env: {
      WE_DAEMON_VERSIONS_KEEP: '-1', WE_DAEMON_VERSIONS_ENABLED: '{broken',
      WE_DAEMON_VERSIONS_CARRY_UNTRACKED: 'yes', WE_DAEMON_VERSIONS_STATE_PATHS: '["../escape"]',
    } });
    expect(rejected.values).toEqual(fileConfig);
    expect(rejected.sources.keep).toBe('file');
    expect(rejected.sources.probationMs).toBe('default');
    expect(resolveDaemonVersionsSettings().values).toEqual(BUILT_IN_DAEMON_VERSIONS_SETTINGS);
  });
});
