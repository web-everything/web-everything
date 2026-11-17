// @vitest-environment node
// Regression: tests must never reach the host's live operator-override store. vitest.setup.ts redirects
// os.userInfo().homedir to a unique, per-test-file temp home, so the default lookup path is a sandbox path.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { operatorOverridesPath, readOperatorOverrides } from '../operator-override-reader.mjs';

const values = {
  'reviewConcurrency.maxLiveReviewRounds': 8,
  'resourceGate.fixCap.ceiling': 12,
  'redTeamQueue.minConcurrent': 8,
};
const seed = home => {
  mkdirSync(join(home, '.claude'), { recursive: true });
  const file = join(home, '.claude', 'operator-overrides.json');
  writeFileSync(file, JSON.stringify(values));
  return file;
};
let decoyHome;
beforeEach(() => { decoyHome = mkdtempSync(join(tmpdir(), 'override-decoy-host-')); });
afterEach(() => rmSync(decoyHome, { recursive: true, force: true }));

describe('host operator-override store isolation under vitest', () => {
  it('resolves the default store inside a per-file sandbox home, not the account home', () => {
    const path = operatorOverridesPath();
    expect(path.startsWith(join(tmpdir(), 'we-test-home-'))).toBe(true);
    expect(userInfo().homedir).toBe(dirname(dirname(path)));
  });
  it('a host-like store elsewhere (decoy home) is ignored by the default read', () => {
    seed(decoyHome);
    expect(existsSync(operatorOverridesPath())).toBe(false);
    expect(readOperatorOverrides({ log: () => {} })).toEqual({ readable: true, values: {} });
  });
  it('a store at the default lookup path is the sandbox one: it is read, so only this file can populate it', () => {
    const sandboxFile = seed(userInfo().homedir);
    try {
      expect(sandboxFile).toBe(operatorOverridesPath());
      expect(readOperatorOverrides({ log: () => {} })).toEqual({ readable: true, values });
    } finally { rmSync(userInfo().homedir, { recursive: true, force: true }); }
    expect(readOperatorOverrides({ log: () => {} })).toEqual({ readable: true, values: {} });
  });
});
