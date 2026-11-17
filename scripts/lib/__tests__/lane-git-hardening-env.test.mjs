import { describe, expect, it } from 'vitest';
import { laneGitHardeningEnv } from '../lane-git-hardening.mjs';

describe('laneGitHardeningEnv replacement-object isolation', () => {
  it.each([undefined, { credentialPins: false }])('disables replacement objects with options %j', options => {
    expect(laneGitHardeningEnv({}, options).GIT_NO_REPLACE_OBJECTS).toBe('1');
  });

  it.each([undefined, { credentialPins: false }])('overrides inherited replacement-object settings with options %j', options => {
    const inherited = { GIT_NO_REPLACE_OBJECTS: '0' };
    expect(laneGitHardeningEnv(inherited, options).GIT_NO_REPLACE_OBJECTS).toBe('1');
    expect(inherited.GIT_NO_REPLACE_OBJECTS).toBe('0');
  });
});
