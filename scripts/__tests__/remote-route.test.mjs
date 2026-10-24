// Test-first contract: static imports intentionally fail until the module exists.
import { describe, expect, it } from 'vitest';
import { decideRoute, resolveRouteSettings, formatRouteLog } from '../lib/remote-route.mjs';

const local = {
  projectedWaitMinutes: 1, heavyWaitMinutes: 1, load1: 2, loadCap: 36,
  thresholdMinutes: 10, remoteReady: true, mode: 'lane-check',
};

describe('decideRoute', () => {
  it('keeps tiny runs local and explains why', () => {
    expect(decideRoute(local)).toEqual({ path: 'local', reason: 'tiny runs are faster locally' });
  });

  it('routes remotely when projected wait exceeds the threshold', () => {
    expect(decideRoute({ ...local, projectedWaitMinutes: 10.01 })).toEqual({
      path: 'remote', reason: expect.stringMatching(/wait|threshold/i),
    });
  });

  it('routes remotely when load exceeds its cap even with a tiny wait', () => {
    expect(decideRoute({ ...local, load1: 36.01 })).toEqual({
      path: 'remote', reason: expect.stringMatching(/load/i),
    });
  });

  it('uses strict greater-than for both boundaries', () => {
    expect(decideRoute({ ...local, projectedWaitMinutes: 10, load1: 36 }).path).toBe('local');
  });

  it('uses heavy wait instead of projected wait for full mode', () => {
    expect(decideRoute({ ...local, mode: 'full', heavyWaitMinutes: 11 }).path).toBe('remote');
    expect(decideRoute({ ...local, mode: 'full', projectedWaitMinutes: 99 }).path).toBe('local');
    expect(decideRoute({ ...local, mode: 'full', heavyWaitMinutes: 10 }).path).toBe('local');
  });

  it.each(['lane-check', 'targeted'])('uses projected wait in %s mode', (mode) => {
    expect(decideRoute({ ...local, mode, projectedWaitMinutes: 11 }).path).toBe('remote');
    expect(decideRoute({ ...local, mode, heavyWaitMinutes: 99 }).path).toBe('local');
  });

  it('fails closed when remoteReady is false, even under high wait and load', () => {
    const decision = decideRoute({ ...local, remoteReady: false, projectedWaitMinutes: 99, load1: 99 });
    expect(decision.path).toBe('local');
    expect(decision.reason).toMatch(/not ready|unavailable|not pushed|dirty|gh|ref/i);
  });

  // Boolean readiness cannot carry a particular failed prerequisite. The structured
  // form preserves the caller's diagnosis without rerunning git/gh in this pure helper.
  it.each([
    'HEAD not pushed', 'working tree dirty', 'no gh executable', 'targeted-with-no-ref',
  ])('preserves the remote readiness blocker: %s', (reason) => {
    const decision = decideRoute({ ...local, remoteReady: { ready: false, reason },
      projectedWaitMinutes: 99, load1: 99 });
    expect(decision).toEqual({ path: 'local', reason: expect.stringContaining(reason) });
  });

  it('refuses targeted-with-no-ref even if the caller reports readiness', () => {
    const decision = decideRoute({ ...local, mode: 'targeted-with-no-ref', projectedWaitMinutes: 99 });
    expect(decision.path).toBe('local');
    expect(decision.reason).toMatch(/ref/i);
  });

  for (const field of ['projectedWaitMinutes', 'heavyWaitMinutes', 'load1', 'loadCap', 'thresholdMinutes']) {
    it.each([NaN, Infinity, -Infinity, -1, undefined, null, '11', 'bad'])
      (`fails closed to local for invalid ${field}=%s despite another remote trigger`, (value) => {
        const decision = decideRoute({ ...local, mode: 'full', projectedWaitMinutes: 99,
          heavyWaitMinutes: 99, load1: 99, [field]: value });
        expect(decision.path).toBe('local');
        expect(decision.reason).toMatch(/invalid|finite|missing|unavailable/i);
      });
  }

  it.each([undefined, null, 'true', {}])('fails closed for unknown readiness %s', (remoteReady) => {
    expect(decideRoute({ ...local, remoteReady, load1: 99 }).path).toBe('local');
  });

  it('fails closed for an unknown mode', () => {
    expect(decideRoute({ ...local, mode: 'mystery', load1: 99 }).path).toBe('local');
  });
});

describe('resolveRouteSettings', () => {
  // `source` is a per-setting map. cascadeDefaults carries effective values and
  // their provenance from the shared standard → platform → tool cascade.
  it('reports standard defaults and a source for every setting', () => {
    expect(resolveRouteSettings({}, {})).toEqual({
      thresholdMinutes: 10, loadCap: 36, enabled: true,
      source: { thresholdMinutes: 'standard', loadCap: 'standard', enabled: 'standard' },
    });
  });

  it.each(['platform', 'tool'])('preserves values and provenance from the %s layer', (layer) => {
    const cascade = { thresholdMinutes: 15, loadCap: 24, enabled: false,
      source: { thresholdMinutes: layer, loadCap: layer, enabled: layer } };
    expect(resolveRouteSettings({}, cascade)).toEqual(cascade);
  });

  it('applies environment overrides independently and records their sources', () => {
    const cascade = { thresholdMinutes: 15, loadCap: 24, enabled: true,
      source: { thresholdMinutes: 'tool', loadCap: 'platform', enabled: 'standard' } };
    expect(resolveRouteSettings({ WE_REMOTE_ROUTE_THRESHOLD_MINUTES: '2.5',
      WE_REMOTE_ROUTE_LOAD_CAP: '12', WE_REMOTE_ROUTE: 'off' }, cascade)).toEqual({
      thresholdMinutes: 2.5, loadCap: 12, enabled: false,
      source: { thresholdMinutes: 'environment', loadCap: 'environment', enabled: 'environment' },
    });
    expect(resolveRouteSettings({ WE_REMOTE_ROUTE_LOAD_CAP: '12' }, cascade)).toEqual({
      ...cascade, loadCap: 12, source: { ...cascade.source, loadCap: 'environment' },
    });
  });

  it.each(['NaN', 'Infinity', '-1', '12oops', '1e999'])
    ('falls back visibly to standard bounds for invalid env values %s', (value) => {
      const settings = resolveRouteSettings({ WE_REMOTE_ROUTE_THRESHOLD_MINUTES: value,
        WE_REMOTE_ROUTE_LOAD_CAP: value }, {});
      expect(settings.thresholdMinutes).toBe(10);
      expect(settings.loadCap).toBe(36);
      expect(settings.source.thresholdMinutes).toMatch(/standard|fallback/i);
      expect(settings.source.loadCap).toMatch(/standard|fallback/i);
    });

  it('treats empty environment values as unset', () => {
    expect(resolveRouteSettings({ WE_REMOTE_ROUTE_THRESHOLD_MINUTES: '', WE_REMOTE_ROUTE_LOAD_CAP: '',
      WE_REMOTE_ROUTE: '' }, {})).toEqual(resolveRouteSettings({}, {}));
  });
});

describe('formatRouteLog', () => {
  it.each(['local', 'remote'])('logs %s, its reason, effective settings and each source on one line', (path) => {
    const settings = { thresholdMinutes: 10, loadCap: 36, enabled: true,
      source: { thresholdMinutes: 'standard', loadCap: 'tool', enabled: 'environment' } };
    const log = formatRouteLog({ path, reason: 'observed routing reason' }, settings);
    expect(typeof log).toBe('string');
    for (const text of [path, 'observed routing reason', '10', '36', 'true', 'standard', 'tool', 'environment']) {
      expect(log).toContain(text);
    }
    expect(log).not.toMatch(/[\r\n]/);
  });

  it('strips terminal controls and line breaks from diagnostic text', () => {
    const log = formatRouteLog({ path: 'local', reason: 'dirty\nHEAD\r\u001b[31m' }, resolveRouteSettings({}, {}));
    expect(log).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(log).toMatch(/dirty/);
  });
});
