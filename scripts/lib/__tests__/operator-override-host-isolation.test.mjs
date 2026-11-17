// @vitest-environment node
// Regression: tests must never read the host's live operator-override store (vitest.setup.ts redirects userInfo().homedir).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { operatorOverridesPath, readOperatorOverrides } from '../operator-override-reader.mjs';

const values = {
  'reviewConcurrency.maxLiveReviewRounds': 8,
  'resourceGate.fixCap.ceiling': 12,
  'redTeamQueue.minConcurrent': 8,
};
let fakeHome;
beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'override-host-isolation-'));
  mkdirSync(join(fakeHome, '.claude'));
  writeFileSync(join(fakeHome, '.claude', 'operator-overrides.json'), JSON.stringify(values));
});
afterEach(() => rmSync(fakeHome, { recursive: true, force: true }));

describe('host operator-override store isolation under vitest', () => {
  it('resolves the default store outside any real account home', () => {
    expect(operatorOverridesPath().startsWith(tmpdir())).toBe(true);
    expect(userInfo().homedir.startsWith(tmpdir())).toBe(true);
  });
  it('default read ignores a populated host-like store and returns empty values', () => {
    expect(readOperatorOverrides({ log: () => {} })).toEqual({ readable: true, values: {} });
  });
  it('an explicit file still reads the populated store', () => {
    const file = join(fakeHome, '.claude', 'operator-overrides.json');
    expect(readOperatorOverrides({ file })).toEqual({ readable: true, values });
  });
});
