// @vitest-environment node
import { it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialContentFinding, designTokenSecretFinding, classifyManifestPath, manifestEntry } from '../forge-exec-manifest.mjs';
import { scanBundleRange, planBundle } from '../remote-git-bundle.mjs';
import { resolveAdmissionPolicy, formatAdmissionPolicy } from '../heavy-admission.mjs';

const value = 'aB3dE5fG7hJ9kL2mN4pQ6rS8';
const path = Buffer.from('tokens.txt');
const exact = [
  ['pem-header', '-----' + 'BEGIN CERTIFICATE-----'],
  ['private-key', 'PRIVATE' + ' KEY'],
  ['aws-access-key', 'AK' + 'IA' + 'A'.repeat(16)],
  ['github-token', 'gh' + 'p_' + 'A'.repeat(30)],
  ['sk-token', 's' + 'k-' + 'A'.repeat(20)],
  ['slack-token', 'xo' + 'xb-' + 'A'.repeat(12)],
];
it.each([
  ['previousPathKey', `previousPathKey: "${value}"`, false],
  ['key', JSON.stringify({ key: value }), true],
  ['nested-key', JSON.stringify({ key: { [value]: 'safe' } }), true],
])('warns and continues for high-entropy-%s; legacy defaults refuse', (field, text, json) => {
  const scan = options => json ? designTokenSecretFinding(Buffer.from(text), options) : credentialContentFinding(path, Buffer.from(text), options);
  const onWarn = vi.fn();
  expect(scan({ heuristic: 'warn', onWarn })).toBeNull();
  expect(onWarn).toHaveBeenCalledWith(`high-entropy-${field}`);
  expect(scan({ heuristic: 'refuse' })).toBe(`high-entropy-${field}`);
  expect(scan()).toBe(`high-entropy-${field}`);
});
it.each(exact)('still refuses exact %s in warn mode', (rule, token) => {
  expect(credentialContentFinding(path, Buffer.from(`previousPathKey: "${value}"\n${token}`), { heuristic: 'warn' })).toBe(rule);
  // Escaped JSON forces the exact hit to be discovered after the heuristic.
  const escaped = [...token].map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  const onWarn = vi.fn();
  expect(designTokenSecretFinding(Buffer.from(`{"key":"${value}","later":"${escaped}"}`), { heuristic: 'warn', onWarn })).toBe(rule);
  expect(onWarn).toHaveBeenCalledWith('high-entropy-key');
});
it('continues to secret assignments and retains malformed/encoding/untracked refusals', () => {
  expect(credentialContentFinding(path, Buffer.from(`previousPathKey: "${value}"\npassword: real`), { heuristic: 'warn' })).toBe('secret-assignment-password');
  for (const [text, rule] of [['{', 'unparseable-json'], ['[]', 'non-object-json']])
    expect(designTokenSecretFinding(Buffer.from(text), { heuristic: 'warn' })).toBe(rule);
  expect(credentialContentFinding(path, Buffer.from([255]), { heuristic: 'warn' })).toBe('unsupported-text-encoding');
  expect(() => manifestEntry(path, Buffer.from('safe'), false, false, { heuristic: 'warn' })).toThrow(/untracked/);
});
it.each(['.env', 'id_rsa', 'x.pem'])('keeps filename %s excluded', name => {
  expect(classifyManifestPath(Buffer.from(name))).toMatchObject({ excluded: true, credentialSource: false });
});
it('resolves and logs the setting with provenance and rejects invalid values', () => {
  expect(resolveAdmissionPolicy({ platform: {} }).settings.remote.credentialScan.heuristic).toBe('warn');
  const policy = resolveAdmissionPolicy({ platform: { remote: { credentialScan: { heuristic: 'refuse' } } } });
  expect(policy.settings.remote.credentialScan.heuristic).toBe('refuse');
  expect(formatAdmissionPolicy(policy)).toContain('remote.credentialScan.heuristic=refuse (platform)');
  expect(resolveAdmissionPolicy({ platform: { remote: { credentialScan: { heuristic: 'skip' } } } }).settings.remote.credentialScan.heuristic).toBe('warn');
});
it('scans real bundle blobs, messages and commit objects with the same warning policy', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'r653-'));
  const exec = async ({ file, args, input }) => {
    const result = spawnSync(file, args, { cwd, input, maxBuffer: 4 * 1024 * 1024 });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  try {
    git('init', '-b', 'main');
    writeFileSync(join(cwd, 'data.txt'), `previousPathKey: "${value}"`);
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', 'commit', '-m', `previousPathKey: "${value}"`);
    const head = git('rev-parse', 'HEAD'), onWarn = vi.fn();
    expect(await scanBundleRange({ cwd, head, exec, heuristic: 'warn', onWarn })).toBeNull();
    for (const file of ['data.txt', 'commit-message', 'commit-object'])
      expect(onWarn).toHaveBeenCalledWith(file, 'high-entropy-previousPathKey');
    expect(await scanBundleRange({ cwd, head, exec, heuristic: 'refuse' })).toMatchObject({ finding: 'high-entropy-previousPathKey' });
    expect(await planBundle({ cwd, head, exec, directory: cwd, heuristic: 'warn', onWarn })).toMatchObject({ mode: 'full' });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
