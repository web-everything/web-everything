const operatorFixture = vi.hoisted(() => ({ file: undefined }));
vi.mock('../operator-override-reader.mjs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, readOperatorOverrides: options => {
    const file = options?.file ?? operatorFixture.file;
    if (!file) throw new Error('Test must inject an operator-store file');
    return actual.readOperatorOverrides({ ...options, file });
  } };
});
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveHostOverloadSettings, loadHostOverloadSettings, boundedText } from '../host-overload-settings.mjs';

let operatorRoot;
beforeEach(() => {
  operatorRoot = mkdtempSync(join(tmpdir(), 'host-overload-operator-'));
  operatorFixture.file = join(operatorRoot, 'missing-operator-overrides.json');
});
afterEach(() => rmSync(operatorRoot, { recursive: true, force: true }));

describe('R559 snapshot maximum freshness policy', () => {
  it('defaults to 20000ms and logs standard provenance', () => {
    const log = vi.fn();
    const r = resolveHostOverloadSettings({ env: {}, log });
    expect(r.settings.host.capacity.snapshotMaxFreshMs).toBe(20000);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('host.capacity.snapshotMaxFreshMs=20000 (standard)'));
  });
  it('resolves standard → platform → tool → environment with provenance', () => {
    const platform = { host: { capacity: { snapshotMaxFreshMs: 15000 } } };
    const tool = { host: { capacity: { snapshotMaxFreshMs: 12000 } } };
    for (const [options, value, source] of [
      [{ platform }, 15000, 'platform'], [{ platform, tool }, 12000, 'tool'],
      [{ platform, tool, env: { WE_HOST_CAPACITY_SNAPSHOT_MAX_FRESH_MS: '9000' } }, 9000, 'env'],
    ]) {
      const log = vi.fn();
      const r = resolveHostOverloadSettings({ env: {}, ...options, log });
      expect(r.settings.host.capacity.snapshotMaxFreshMs).toBe(value);
      expect(r.sources['host.capacity.snapshotMaxFreshMs']).toBe(source);
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`host.capacity.snapshotMaxFreshMs=${value} (${source})`));
    }
  });
  it.each([0, -1, Infinity, NaN, 'bad', {}, null])('rejects invalid bounds in every policy layer: %s', (value) => {
    for (const layer of ['platform', 'tool', 'env']) {
      const options = layer === 'env' ? { env: { WE_HOST_CAPACITY_SNAPSHOT_MAX_FRESH_MS: String(value) } }
        : { [layer]: { host: { capacity: { snapshotMaxFreshMs: value } } } };
      expect(() => resolveHostOverloadSettings({ env: {}, ...options, log: () => {} })).toThrow('invalid policy');
    }
  });
});

/** Platform preference size is independent of the boundedText default used by host-load. */
describe('platform preference read bounds', () => {
  const load = (body, extra = {}) => {
    const path = join(operatorRoot, 'platform.json');
    writeFileSync(path, body);
    return loadHostOverloadSettings({
      env: { WE_PLATFORM_PREFERENCES_FILE: path, WE_PLATFORM_PREFERENCES: path, ...extra },
      toolPath: join(operatorRoot, 'missing-tool.json'), log: () => {},
    });
  };
  it('reads unrelated legacy waivers above 256 KiB under the 2 MiB default', () => {
    const body = JSON.stringify({ prototypeLoad: { ruledWeakened: ['x'.repeat(300 * 1024)] }, host: { maxLoadPerCore: 3 } });
    expect(load(body).settings.host.maxLoadPerCore).toBe(3);
    expect(() => boundedText(join(operatorRoot, 'platform.json'))).toThrow('bounded read exceeded');
  });
  it('names the file, actual bytes, limit and operator fallback beyond the default', () => {
    const body = JSON.stringify({ unrelated: 'x'.repeat(2 * 1024 * 1024) });
    expect(() => load(body)).toThrow(`platform-preferences too large (${Buffer.byteLength(body)} > 2097152 bytes): ${join(operatorRoot, 'platform.json')}`);
    expect(() => load(body)).toThrow('raise WE_HOST_OVERLOAD_PREFS_MAX_BYTES and retry');
    expect(load(body, { WE_HOST_OVERLOAD_PREFS_MAX_BYTES: String(3 * 1024 * 1024) }).settings).toBeDefined();
  });
  it('honors a smaller environment limit and rejects invalid limits', () => {
    expect(() => load(' '.repeat(128), { WE_HOST_OVERLOAD_PREFS_MAX_BYTES: '64' })).toThrow('platform-preferences too large (128 > 64 bytes)');
    expect(() => load('{}', { WE_HOST_OVERLOAD_PREFS_MAX_BYTES: 'bad' })).toThrow('invalid WE_HOST_OVERLOAD_PREFS_MAX_BYTES');
  });
});
