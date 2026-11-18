import { describe, it, expect, vi } from 'vitest';
import { readSettings, readDeclaredSettings, FEATURE_FILE_RE } from '../settings-files.mjs';
import { loadDeliveryRoutes, modeForKind, briefModeText } from '../delivery-routes.mjs';
import { finishBriefMode } from '../../operations/brief-mode.mjs';
import { OPERATIONS, resolveOperation } from '../../operations/run.mjs';
import { parseOperationArgv, runOperationCli } from '../../operations/cli-adapter.mjs';
import { createMemoryRunStore } from '../../operations/run-store.mjs';

const cfg = loadDeliveryRoutes(readSettings);

describe('delivery routes', () => {
  it('loads through the injected shared settings reader, with feature-file provenance', () => {
    const read = vi.fn(() => ({ ...cfg, unrelated: true }));
    expect(loadDeliveryRoutes(read)).toEqual(cfg);
    expect(read).toHaveBeenCalledOnce();
    expect('delivery-routes.json').toMatch(FEATURE_FILE_RE);
    expect(readDeclaredSettings().owners['routes.daemon-tooling']).toBe('settings/delivery-routes.json');
  });

  it('preserves every other historical route', () => {
    expect(cfg.routes).toEqual({
      forge: 'debug', 'red-main': 'debug', incident: 'debug-to-merge', 'delivery-blocker': 'debug-to-merge',
      investigation: 'debug', 'daemon-tooling': 'fast', 'ops-script': 'fast', settings: 'fast', cards: 'fast',
      deflake: 'fast', 'pr-delivery': 'fast', product: 'full', standard: 'full', workflow: 'full', 'security-boundary': 'full',
    });
  });

  it.each(Object.keys(cfg.routes))('%s maps to exactly one existing mode, including when degraded', kind => {
    for (const daemonDegraded of [false, true]) {
      const mode = modeForKind(cfg, kind, { daemonDegraded });
      expect(typeof mode).toBe('string');
      expect(Object.hasOwn(cfg.modes, mode)).toBe(true);
      expect(cfg.modes[mode].trim().length).toBeGreaterThan(0);
    }
  });

  it('every referenced normal or degraded mode exists', () => {
    for (const mode of [...Object.values(cfg.routes), ...Object.values(cfg.daemonDegradedModes)]) {
      expect(Object.hasOwn(cfg.modes, mode)).toBe(true);
    }
  });

  it('daemon-tooling uses fast by default and debug-to-merge only with explicit degradation', () => {
    expect(modeForKind(cfg, 'daemon-tooling')).toBe('fast');
    expect(modeForKind(cfg, 'daemon-tooling', { daemonDegraded: false })).toBe('fast');
    expect(modeForKind(cfg, 'daemon-tooling', { daemonDegraded: true })).toBe('debug-to-merge');
    expect(modeForKind(cfg, 'daemon-tooling', { daemonDegraded: 'false' })).toBe('fast');
    expect(cfg.daemonDegradedModes).toEqual({ 'daemon-tooling': 'debug-to-merge' });
    expect(modeForKind(cfg, 'ops-script', { daemonDegraded: true })).toBe('fast');
  });

  it.each(['delivery-blocker', 'incident'])('%s always uses debug-to-merge', kind => {
    expect(modeForKind(cfg, kind)).toBe('debug-to-merge');
  });

  it.each(['unknown', 'toString', '__proto__', '', undefined])('unknown kind %s fails closed', kind => {
    expect(() => modeForKind(cfg, kind)).toThrow(/Unknown delivery kind/);
  });

  it.each([
    null, {}, { ...cfg, routes: {} }, { ...cfg, modes: [] }, { ...cfg, daemonDegradedModes: undefined },
    { ...cfg, routes: { product: ['full', 'fast'] } }, { ...cfg, routes: { product: 'missing' } },
    { ...cfg, modes: { ...cfg.modes, full: '' } },
    { ...cfg, daemonDegradedModes: { unknown: 'fast' } },
    { ...cfg, daemonDegradedModes: { 'daemon-tooling': 'missing' } },
  ])('incomplete or invalid routing refuses dispatch', value => {
    expect(() => loadDeliveryRoutes(() => value)).toThrow();
  });

  it('missing or unreadable settings refuse dispatch', () => {
    expect(() => loadDeliveryRoutes()).toThrow(/readSettings reader/);
    expect(() => loadDeliveryRoutes(() => { throw new Error('unreadable'); })).toThrow('unreadable');
  });

  it('brief text contains the Mode line and precisely the selected rules', () => {
    expect(briefModeText(cfg, 'daemon-tooling')).toBe(`Mode: fast\n${cfg.modes.fast}`);
    expect(briefModeText(cfg, 'daemon-tooling', { daemonDegraded: true }))
      .toBe(`Mode: debug-to-merge\n${cfg.modes['debug-to-merge']}`);
  });

  it('registered operation declares both flags and prints the collected rules', () => {
    const operation = OPERATIONS['brief-mode']();
    const parsed = parseOperationArgv(operation.declaration, ['--kind=daemon-tooling', '--daemon-degraded']);
    expect(parsed.ok).toBe(true);
    expect(parsed.input).toEqual({ kind: 'daemon-tooling', 'daemon-degraded': true });
    const verdict = operation.declaration.steps.find(({ name }) => name === 'read').step.fn({ input: parsed.input });
    expect(operation.finish({ run: { verdict }, code: 0, json: false }).lines)
      .toEqual(['Mode: debug-to-merge', cfg.modes['debug-to-merge']]);
    expect(operation.sinks).toEqual({});
    expect(finishBriefMode({ run: {}, code: 1, lines: ['failed'] })).toEqual({ code: 1, lines: ['failed'] });
    expect(finishBriefMode({ run: { verdict }, code: 0, lines: ['json'], json: true }))
      .toEqual({ code: 0, lines: ['json'] });
  });

  it('brief-mode CLI adapter prints Mode and rules, and refuses unknown or missing kinds', async () => {
    const invoke = async argv => {
      const operation = resolveOperation('brief-mode');
      const result = await runOperationCli({ ...operation, argv, store: createMemoryRunStore(), newRunId: () => 'brief-test' });
      return operation.finish({ ...result, json: false });
    };
    expect(await invoke(['--kind=daemon-tooling'])).toEqual({ code: 0, lines: ['Mode: fast', cfg.modes.fast] });
    expect(await invoke(['--kind=daemon-tooling', '--daemon-degraded']))
      .toEqual({ code: 0, lines: ['Mode: debug-to-merge', cfg.modes['debug-to-merge']] });
    expect((await invoke(['--kind=unknown'])).code).not.toBe(0);
    expect((await invoke([])).code).not.toBe(0);
  });
});
