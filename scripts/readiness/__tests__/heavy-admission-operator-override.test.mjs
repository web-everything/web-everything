// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAdmissionPolicy, ADMISSION_POLICY_STANDARD, formatAdmissionPolicy } from '../heavy-admission.mjs';

const roots = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'admission-operator-')); roots.push(root);
  mkdirSync(join(root, 'scripts', 'settings'), { recursive: true });
  const platform = join(root, 'platform.json'), file = join(root, 'operator.json');
  writeFileSync(platform, JSON.stringify({ heavyAdmission: { remote: { maxConcurrent: 24 } } }));
  return { file, options: { env: { VITEST: 'true', WE_OPERATOR_OVERRIDE_FILE: file, WE_PLATFORM_PREFERENCES: platform }, repoRoot: root, checkoutRoot: root } };
}
describe('live heavyAdmission.remote.maxConcurrent operator capacity', () => {
  it.each([1, 32])('applies operator boundary %s over platform with logged provenance', value => {
    const { file, options } = fixture();
    writeFileSync(file, JSON.stringify({ 'heavyAdmission.remote.maxConcurrent': value }));
    const policy = loadAdmissionPolicy(options);
    expect(policy.settings.remote.maxConcurrent).toBe(value);
    expect(policy.sources['remote.maxConcurrent']).toBe('operator-db');
    expect(formatAdmissionPolicy(policy)).toContain(`remote.maxConcurrent=${value} (operator-db)`);
  });
  it.each([0, 33])('rejects out-of-range operator value %s', value => {
    const { file, options } = fixture();
    writeFileSync(file, JSON.stringify({ 'heavyAdmission.remote.maxConcurrent': value }));
    expect(loadAdmissionPolicy(options).settings.remote.maxConcurrent).toBe(24);
  });
  it('corrupt store ignores platform raise, logs operator-db-unreadable and rechecks on cache hits', () => {
    const { file, options } = fixture();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(file, JSON.stringify({ 'heavyAdmission.remote.maxConcurrent': 30 }));
    expect(loadAdmissionPolicy(options).settings.remote.maxConcurrent).toBe(30);
    writeFileSync(file, '{');
    const closed = loadAdmissionPolicy(options);
    expect(closed.settings.remote.maxConcurrent).toBe(ADMISSION_POLICY_STANDARD.remote.maxConcurrent);
    expect(closed.sources['remote.maxConcurrent']).toBe('standard');
    expect(log.mock.calls.flat().join(' ')).toContain('operator-db-unreadable');
    unlinkSync(file);
    const missing = loadAdmissionPolicy(options);
    expect(missing.settings.remote.maxConcurrent).toBe(24);
    expect(missing.sources['remote.maxConcurrent']).toBe('platform');
    writeFileSync(file, JSON.stringify({ 'heavyAdmission.remote.maxConcurrent': 12 }));
    expect(loadAdmissionPolicy(options).settings.remote.maxConcurrent).toBe(12);
  });
});
