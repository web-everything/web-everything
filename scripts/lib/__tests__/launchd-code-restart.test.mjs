import { describe, it, expect, vi } from 'vitest';
import * as restartModule from '../launchd-code-restart.mjs';

const { restartServicesForClone } = restartModule;
const sampler = 'com.we.resource-sampler';
const writer = 'com.we.writer';
const kick = (label, uid = 501) => ['kickstart', '-k', `gui/${uid}/${label}`];
const lines = o => o.log.mock.calls.flat().join('\n');
function fixture(overrides = {}) {
  return {
    launchctl: vi.fn(() => ({ status: 0 })), uid: () => 501,
    log: vi.fn(), adoptedSha: 'sha-A', restarted: new Map(), platform: null, env: {},
    ...overrides,
  };
}

describe('launchd restart by label (R703)', () => {
  it('exports exactly the stale-service detector and restart API; no reset hook', () => {
    expect(Object.keys(restartModule).sort()).toEqual(['findStaleCodeServices', 'restartServicesForClone']);
  });

  it('the default allowlist restarts only the resource sampler with kickstart -k', async () => {
    const o = fixture();
    expect(await restartServicesForClone(o)).toEqual({
      restarted: [{ label: sampler, reason: 'kickstart -k' }],
      skipped: [], flagged: [], errors: [],
    });
    expect(o.launchctl.mock.calls).toEqual([[kick(sampler)]]);
  });

  it('an explicitly listed label restarts without reading any plist or directory', async () => {
    const forbidden = vi.fn(() => { throw new Error('plist IO forbidden'); });
    const o = fixture({ settings: { allowedLabels: [writer] }, readPlist: forbidden, listPlists: forbidden });
    expect((await restartServicesForClone(o)).restarted).toEqual([{ label: writer, reason: 'kickstart -k' }]);
    expect(o.launchctl.mock.calls).toEqual([[kick(writer)]]);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('refuses every non-allowlisted label, including managed writers and unrelated services', async () => {
    const o = fixture({ settings: { allowedLabels: [writer] } });
    const r = await restartServicesForClone(o);
    expect(o.launchctl.mock.calls).toEqual([[kick(writer)]]);
    expect(r.restarted.map(x => x.label)).toEqual([writer]);
    expect(o.restarted.has(sampler)).toBe(false);
    expect(o.restarted.has('com.webeverything.writer')).toBe(false);
    expect(o.restarted.has('com.apple.unrelated')).toBe(false);
  });

  it('an explicitly empty allowlist restarts nothing', async () => {
    const o = fixture({ settings: { allowedLabels: [] } });
    expect(await restartServicesForClone(o)).toEqual({ restarted: [], skipped: [], flagged: [], errors: [] });
    expect(o.launchctl).not.toHaveBeenCalled();
    expect(o.restarted.size).toBe(0);
  });

  it.each([
    ['wildcard', ['*']], ['namespace glob', ['com.we.*']], ['path', ['com.we/x']],
    ['whitespace', ['com.we x']], ['empty label', ['']], ['not an array', writer],
    ['over 64 labels', Array.from({ length: 65 }, (_, i) => `com.we.s${i}`)],
    ['over 128 characters', [`com.we.${'a'.repeat(125)}`]],
    ['case duplicates', ['com.we.Writer', writer]],
  ])('invalid allowlist (%s) falls back to the standard allowlist without widening it', async (_name, allowedLabels) => {
    const o = fixture({ settings: { allowedLabels } });
    await restartServicesForClone(o);
    expect(o.launchctl.mock.calls).toEqual([[kick(sampler)]]);
  });

  it.each([
    'com.we.dev', 'com.we.vite', 'com.we.storybook', 'com.we.playground', 'com.we.npm-start',
    'com.we.dev-server', 'com.we.my.vite.app', 'com.we.npm-start-x',
  ])('never restarts a dev-server label even when listed: %s', async label => {
    const o = fixture({ settings: { allowedLabels: [label] } });
    expect((await restartServicesForClone(o)).skipped).toContainEqual({ label, reason: 'built-in-never' });
    expect(o.launchctl).not.toHaveBeenCalled();
    expect(o.restarted.size).toBe(0);
  });

  it.each(['com.we.device-x', 'com.we.devops', 'com.we.activite', 'com.we.deviate'])(
    'dev words inside a longer segment do not exclude a listed label: %s', async label => {
      const o = fixture({ settings: { allowedLabels: [label] } });
      expect((await restartServicesForClone(o)).restarted).toEqual([{ label, reason: 'kickstart -k' }]);
      expect(o.launchctl.mock.calls).toEqual([[kick(label)]]);
    });

  it('never restarts selfLabel even when explicitly listed', async () => {
    const o = fixture({ selfLabel: sampler });
    expect((await restartServicesForClone(o)).skipped).toContainEqual({ label: sampler, reason: 'self' });
    expect(o.launchctl).not.toHaveBeenCalled();
    expect(o.restarted.size).toBe(0);
  });

  it.each([
    [{ settings: { enabled: false } }, 'tool'],
    [{ platform: { enabled: false } }, 'platform'],
    [{ platform: { enabled: true }, settings: { enabled: true }, envValues: { enabled: false } }, 'env'],
  ])('disabled policy skips without recording an adoption: %j', async (policy, source) => {
    const o = fixture(policy);
    expect((await restartServicesForClone(o)).skipped).toContainEqual({ label: sampler, reason: 'disabled' });
    expect(o.launchctl).not.toHaveBeenCalled();
    expect(o.restarted.size).toBe(0);
    expect(lines(o)).toContain(`"enabled":"${source}"`);
  });

  it.each(['off', 'OFF', 'FALSE', 'False', ' no ', '0', 'false', 'disabled', 'garbage', '2'])(
    'kill-switch env %j disables restarts, including unrecognised values', async value => {
      const o = fixture({ env: { WE_DAEMON_SERVICE_RESTART_ENABLED: value } });
      expect((await restartServicesForClone(o)).skipped).toContainEqual({ label: sampler, reason: 'disabled' });
      expect(o.launchctl).not.toHaveBeenCalled();
      expect(lines(o)).toContain('"enabled":"env"');
    });

  it.each(['true', 'TRUE', ' On ', 'yes', '1'])('enable env %j overrides disabled tool and platform', async value => {
    const o = fixture({ platform: { enabled: false }, settings: { enabled: false },
      env: { WE_DAEMON_SERVICE_RESTART_ENABLED: value } });
    expect((await restartServicesForClone(o)).restarted).toHaveLength(1);
    expect(o.launchctl.mock.calls).toEqual([[kick(sampler)]]);
    expect(lines(o)).toContain('"enabled":"env"');
  });

  it.each(['', '  '])('blank env %j is unset and preserves the disabled setting', async value => {
    const o = fixture({ settings: { enabled: false }, env: { WE_DAEMON_SERVICE_RESTART_ENABLED: value } });
    expect((await restartServicesForClone(o)).skipped).toContainEqual({ label: sampler, reason: 'disabled' });
    expect(o.launchctl).not.toHaveBeenCalled();
    expect(lines(o)).toContain('"enabled":"tool"');
  });

  it.each([
    [{}, sampler, 'standard'],
    [{ platform: { allowedLabels: [writer] } }, writer, 'platform'],
    [{ platform: { allowedLabels: [sampler] }, settings: { allowedLabels: [writer] } }, writer, 'tool'],
  ])('logs effective policy values and their source: %j', async (policy, label, source) => {
    const o = fixture(policy);
    await restartServicesForClone(o);
    expect(lines(o)).toContain('daemon.serviceRestart');
    expect(lines(o)).toContain(`"allowedLabels":["${label}"]`);
    expect(lines(o)).toContain(`"allowedLabels":"${source}"`);
    expect(lines(o)).toContain('"enabled":true');
    expect(lines(o)).toContain('"enabled":"standard"');
    expect(o.launchctl.mock.calls).toEqual([[kick(label)]]);
  });

  it('unreadable policy fails closed with an error instead of a clean result', async () => {
    const settings = Object.defineProperty({}, 'enabled', { enumerable: true,
      get() { throw new Error('policy unreadable'); } });
    const o = fixture({ settings });
    const r = await restartServicesForClone(o);
    expect(r.errors).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('policy unreadable') }));
    expect(r.restarted).toEqual([]);
    expect(o.launchctl).not.toHaveBeenCalled();
    expect(o.restarted.size).toBe(0);
  });

  it.each([undefined, null, -1, 1.5, '501', NaN, () => { throw new Error('uid unavailable'); }])(
    'unreadable uid %s fails closed', async uid => {
      const o = fixture({ uid: typeof uid === 'function' ? uid : () => uid });
      const r = await restartServicesForClone(o);
      expect(r.errors).toHaveLength(1);
      expect(r.restarted).toEqual([]);
      expect(o.launchctl).not.toHaveBeenCalled();
      expect(o.restarted.size).toBe(0);
    });

  it('accepts an injected numeric uid', async () => {
    const o = fixture({ uid: 502 });
    expect((await restartServicesForClone(o)).errors).toEqual([]);
    expect(o.launchctl.mock.calls).toEqual([[kick(sampler, 502)]]);
  });

  it.each([undefined, null, '', '  ', 0])('unknown adopted sha %j refuses kickstart', async adoptedSha => {
    const o = fixture({ adoptedSha });
    const r = await restartServicesForClone(o);
    expect(r.errors).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('unknown adopted sha') }));
    expect(r.restarted).toEqual([]);
    expect(o.launchctl).not.toHaveBeenCalled();
    expect(o.restarted.size).toBe(0);
  });

  it('same adopted sha twice produces exactly one kickstart', async () => {
    const o = fixture();
    expect((await restartServicesForClone(o)).restarted).toHaveLength(1);
    expect((await restartServicesForClone(o)).skipped).toEqual([{ label: sampler, reason: 'same-adopted-sha' }]);
    expect(o.launchctl.mock.calls).toEqual([[kick(sampler)]]);
  });

  it('a new adopted sha immediately produces a second kickstart', async () => {
    const o = fixture();
    await restartServicesForClone(o);
    expect((await restartServicesForClone({ ...o, adoptedSha: 'sha-B' })).restarted).toHaveLength(1);
    expect((await restartServicesForClone({ ...o, adoptedSha: 'sha-B' })).skipped)
      .toEqual([{ label: sampler, reason: 'same-adopted-sha' }]);
    expect(o.launchctl.mock.calls).toEqual([[kick(sampler)], [kick(sampler)]]);
  });

  it('adoption records are per label: adding a label restarts only that label for the same sha', async () => {
    const o = fixture();
    await restartServicesForClone(o);
    const r = await restartServicesForClone({ ...o, settings: { allowedLabels: [sampler, writer] } });
    expect(r.skipped).toEqual([{ label: sampler, reason: 'same-adopted-sha' }]);
    expect(r.restarted).toEqual([{ label: writer, reason: 'kickstart -k' }]);
    expect(o.launchctl.mock.calls).toEqual([[kick(sampler)], [kick(writer)]]);
  });

  it.each([
    ['throw', () => { throw new Error('launchctl failed'); }],
    ['rejection', () => Promise.reject(new Error('launchctl failed'))],
    ['nonzero status', () => ({ status: 1, stderr: 'denied' })],
    ['nonzero code', () => ({ code: 1, stderr: 'denied' })],
    ['error result', () => ({ error: new Error('launchctl failed') })],
    ['missing result', () => undefined],
    ['empty result', () => ({})],
    ['signal without status', () => ({ status: null, signal: 'SIGTERM' })],
  ])('launchctl %s reports failure without recording sha; the same sha can retry', async (_name, fail) => {
    const o = fixture();
    o.launchctl.mockImplementationOnce(fail);
    const r = await restartServicesForClone(o);
    expect(r.errors).toHaveLength(1);
    expect(r.restarted).toEqual([]);
    expect(o.restarted.has(sampler)).toBe(false);
    expect((await restartServicesForClone(o)).restarted).toEqual([{ label: sampler, reason: 'kickstart -k' }]);
    expect(o.launchctl).toHaveBeenCalledTimes(2);
  });

  it('concurrent calls restart an in-flight label only once, even with separate adoption maps', async () => {
    const o = fixture();
    let finish, markLaunched;
    const launched = new Promise(resolve => { markLaunched = resolve; });
    o.launchctl.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; markLaunched(); }));
    const first = restartServicesForClone(o);
    try {
      await launched;
      const second = await restartServicesForClone({ ...o, restarted: new Map() });
      expect(second.skipped).toContainEqual({ label: sampler, reason: 'restart-in-flight' });
      expect(second.restarted).toEqual([]);
    } finally {
      finish?.({ status: 0 });
      await first;
    }
    expect(o.launchctl).toHaveBeenCalledTimes(1);
    expect((await restartServicesForClone({ ...o, adoptedSha: 'sha-B' })).restarted).toHaveLength(1);
  });

  it('an aborted signal refuses kickstart without recording sha and permits a later retry', async () => {
    const controller = new AbortController();
    controller.abort();
    const o = fixture();
    const r = await restartServicesForClone({ ...o, signal: controller.signal });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].reason).toMatch(/abort|cancel/i);
    expect(r.restarted).toEqual([]);
    expect(o.launchctl).not.toHaveBeenCalled();
    expect(o.restarted.size).toBe(0);
    expect((await restartServicesForClone(o)).restarted).toHaveLength(1);
  });
});

describe('findStaleCodeServices reports older running code without restarting', () => {
  const cloneRoot = 'fixtures/adopted-clone';
  const adoptedAt = 1_000_000;
  function staleFixture(overrides = {}) {
    return fixture({
      cloneRoot, now: () => adoptedAt + 120_001,
      readProcessStartMs: vi.fn(() => adoptedAt - 1),
      readAdoptedAtMs: vi.fn(() => adoptedAt), onFreshService: vi.fn(),
      ps: vi.fn(() => { throw new Error('unexpected host process read'); }),
      ...overrides,
    });
  }
  async function inspect(o) {
    const flags = await restartModule.findStaleCodeServices(o);
    expect(o.launchctl).not.toHaveBeenCalled();
    expect(o.ps).not.toHaveBeenCalled();
    return flags;
  }

  it('flags a process started before clone adoption after the default 120000 ms grace', async () => {
    const o = staleFixture();
    expect(await inspect(o)).toEqual([expect.objectContaining({ label: sampler, reason: 'stale-code' })]);
    expect(o.readAdoptedAtMs).toHaveBeenCalledWith(cloneRoot);
    expect(o.onFreshService).not.toHaveBeenCalled();
  });

  it.each([0, 119_999, 120_000])('stale process at adoption age %i ms stays quiet, including the grace boundary', async age => {
    const o = staleFixture({ now: () => adoptedAt + age });
    expect(await inspect(o)).toEqual([]);
    expect(o.onFreshService).not.toHaveBeenCalled();
  });

  it.each([[500, 500, false], [500, 501, true], [0, 1, true], [300_000, 120_001, false]])(
    'honours explicit graceMs=%i at age=%i (flag=%s)', async (graceMs, age, flagged) => {
      const o = staleFixture({ graceMs, now: () => adoptedAt + age });
      expect(await inspect(o)).toEqual(flagged
        ? [expect.objectContaining({ label: sampler, reason: 'stale-code' })] : []);
      expect(o.onFreshService).not.toHaveBeenCalled();
    });

  it.each([adoptedAt, adoptedAt + 1])('reports explicit fresh evidence for process start %i at or after adoption', async start => {
    const o = staleFixture({ readProcessStartMs: vi.fn(() => start), now: () => adoptedAt });
    expect(await inspect(o)).toEqual([]);
    expect(o.onFreshService.mock.calls).toEqual([[{ label: sampler }]]);
  });

  it('reports a service that is not running as fresh evidence', async () => {
    const o = staleFixture({ readProcessStartMs: vi.fn(() => null) });
    expect(await inspect(o)).toEqual([]);
    expect(o.onFreshService.mock.calls).toEqual([[{ label: sampler }]]);
  });

  it('inspects exactly the allowlisted labels and never discovers unrelated services', async () => {
    const o = staleFixture({ settings: { allowedLabels: [writer] } });
    expect(await inspect(o)).toEqual([expect.objectContaining({ label: writer, reason: 'stale-code' })]);
    expect(o.readProcessStartMs.mock.calls.map(([label]) => label)).toEqual([writer]);
    expect(o.onFreshService).not.toHaveBeenCalled();
  });

  it.each([
    ['empty allowlist', { settings: { allowedLabels: [] } }],
    ['listed dev-server', { settings: { allowedLabels: ['com.we.dev-server'] } }],
    ['self label', { selfLabel: sampler }],
    ['disabled policy', { settings: { enabled: false } }],
  ])('skips %s without inspection, flags, or fresh evidence', async (_name, overrides) => {
    const o = staleFixture(overrides);
    expect(await inspect(o)).toEqual([]);
    expect(o.readProcessStartMs).not.toHaveBeenCalled();
    expect(o.onFreshService).not.toHaveBeenCalled();
  });

  it.each([
    [{ platform: { allowedLabels: [writer] } }, writer, 'platform'],
    [{ platform: { allowedLabels: [sampler] }, settings: { allowedLabels: [writer] } }, writer, 'tool'],
  ])('shares restart policy precedence and logs provenance: %j', async (policy, label, source) => {
    const o = staleFixture(policy);
    expect(await inspect(o)).toEqual([expect.objectContaining({ label, reason: 'stale-code' })]);
    expect(lines(o)).toContain('daemon.serviceRestart');
    expect(lines(o)).toContain(`"allowedLabels":"${source}"`);
  });

  it('environment policy overrides enabled tool and platform policy', async () => {
    const o = staleFixture({ platform: { enabled: true }, settings: { enabled: true }, envValues: { enabled: false } });
    expect(await inspect(o)).toEqual([]);
    expect(o.readProcessStartMs).not.toHaveBeenCalled();
    expect(o.onFreshService).not.toHaveBeenCalled();
    expect(lines(o)).toContain('"enabled":"env"');
  });

  it('an oversized allowlist uses the standard fallback without inspecting extra labels', async () => {
    const o = staleFixture({ settings: { allowedLabels: Array.from({ length: 65 }, (_, i) => `com.we.s${i}`) } });
    expect(await inspect(o)).toEqual([expect.objectContaining({ label: sampler, reason: 'stale-code' })]);
    expect(o.readProcessStartMs.mock.calls.map(([label]) => label)).toEqual([sampler]);
  });

  it.each([
    ['throws', () => { throw new Error('process unreadable'); }],
    ['returns NaN', () => NaN],
  ])('fails closed with process-unreadable when the process reader %s', async (_name, read) => {
    const o = staleFixture({ readProcessStartMs: vi.fn(read) });
    expect(await inspect(o)).toEqual([expect.objectContaining({ label: sampler, reason: 'process-unreadable' })]);
    expect(o.onFreshService).not.toHaveBeenCalled();
  });

  it('fails closed with adoption-unreadable for NaN adoption evidence', async () => {
    const o = staleFixture({ readAdoptedAtMs: vi.fn(() => NaN) });
    expect(await inspect(o)).toEqual([expect.objectContaining({ label: sampler, reason: 'adoption-unreadable' })]);
    expect(o.onFreshService).not.toHaveBeenCalled();
  });

  it('makes no stale or fresh claim when the clone has adopted nothing', async () => {
    const o = staleFixture({ readAdoptedAtMs: vi.fn(() => null) });
    expect(await inspect(o)).toEqual([]);
    expect(o.onFreshService).not.toHaveBeenCalled();
  });

  it('unreadable policy produces one policy-unreadable flag and no fresh evidence', async () => {
    const settings = Object.defineProperty({}, 'enabled', { enumerable: true,
      get() { throw new Error('policy unreadable'); } });
    const o = staleFixture({ settings });
    expect(await inspect(o)).toEqual([expect.objectContaining({ label: null, reason: 'policy-unreadable' })]);
    expect(o.readProcessStartMs).not.toHaveBeenCalled();
    expect(o.onFreshService).not.toHaveBeenCalled();
  });
});
