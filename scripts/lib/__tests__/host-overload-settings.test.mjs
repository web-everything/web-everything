const operatorFixture = vi.hoisted(() => ({ file: undefined }));
vi.mock('../operator-override-reader.mjs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, readOperatorOverrides: options => {
    const file = options?.file ?? operatorFixture.file;
    if (!file) throw new Error('Test must inject an operator-store file');
    return actual.readOperatorOverrides({ ...options, file });
  } };
});
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveHostOverloadSettings } from '../host-overload-settings.mjs';

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
