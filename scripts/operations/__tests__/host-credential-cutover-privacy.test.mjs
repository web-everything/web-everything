// Raw imports are test inputs; every filesystem read below uses an injected temp root.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import inventoryTestSource from './host-credential-cutover-inventory.test.mjs?raw';
import privacyPolicySource from '../../settings/privacy-terms-allowlist.json?raw';
import { loadAllowlist, scanText } from '../../lib/privacy-terms.mjs';

const fixturePath = 'scripts/operations/__tests__/host-credential-cutover-inventory.test.mjs';
let root;

async function readFixture({ root }) {
  const file = join(root, fixturePath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, inventoryTestSource);
  const policyFile = join(root, 'privacy-policy.json');
  await writeFile(policyFile, privacyPolicySource);
  return {
    text: await readFile(file, 'utf8'),
    allowlist: loadAllowlist(await readFile(policyFile, 'utf8')),
  };
}

async function createFixtureRoot({ temporaryDirectory = tmpdir } = {}) {
  return mkdtemp(join(temporaryDirectory(), 'hca-privacy-'));
}

beforeEach(async () => { root = await createFixtureRoot(); });
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('R972 inventory fixture privacy', () => {
  it('creates and scans a fixture with TMPDIR unset using the injected OS temp directory', async () => {
    vi.stubEnv('TMPDIR', undefined);
    delete process.env.TMPDIR;
    expect(process.env.TMPDIR).toBeUndefined();
    const temporaryDirectory = vi.fn(() => root);
    const created = createFixtureRoot({ temporaryDirectory });
    await expect(created).resolves.toEqual(expect.any(String));
    const childRoot = await created;
    expect(dirname(childRoot)).toBe(root);
    expect(temporaryDirectory).toHaveBeenCalledOnce();
    const { text, allowlist } = await readFixture({ root: childRoot });
    expect(scanText(text, { path: fixturePath, allowlist })
      .filter(hit => hit.pattern === 'account-id')).toEqual([]);
  });

  it('allows synthetic App IDs only through the exact-context fixture policy', async () => {
    const { text, allowlist } = await readFixture({ root });
    const path = fixturePath;
    const findings = scanText(text, { path }).filter(hit => hit.pattern === 'account-id');
    expect(findings.length).toBeGreaterThan(0);
    expect(scanText(text, { path, allowlist }).filter(hit => hit.pattern === 'account-id')).toEqual([]);
    for (const hit of findings) {
      const line = text.split('\n')[hit.line - 1];
      expect(scanText(line, { path, allowlist })).toEqual([]);
      expect(scanText(line.replace(/\b2\b/, '3'), { path, allowlist })
        .some(finding => finding.pattern === 'account-id')).toBe(true);
      expect(scanText(`${line} // changed context`, { path, allowlist })
        .some(finding => finding.pattern === 'account-id')).toBe(true);
      expect(scanText(line, { path: 'scripts/operations/__tests__/other.test.mjs', allowlist })
        .some(finding => finding.pattern === 'account-id')).toBe(true);
    }
  });
});
