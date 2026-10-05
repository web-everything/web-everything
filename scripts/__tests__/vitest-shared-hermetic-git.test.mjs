import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermeticGitEnv, minimalGitTemplateEnv } from '../../vitest.shared';

describe('hermeticGitEnv', () => {
  it('supplies only a test identity in a global config outside the checkout', () => {
    const env = hermeticGitEnv();
    expect(env).toEqual({
      ...minimalGitTemplateEnv(),
      GIT_CONFIG_GLOBAL: join(tmpdir(), 'we-test-gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
    });
    expect(existsSync(env.GIT_CONFIG_GLOBAL)).toBe(true);
    const config = readFileSync(env.GIT_CONFIG_GLOBAL, 'utf8');
    expect(config).toBe('[user]\n\tname = WE Test\n\temail = test@example.invalid\n');
    expect(config).not.toMatch(/untrackedCache|manyFiles|credential|defaultBranch/i);

    expect(hermeticGitEnv()).toEqual(env);
    expect(readFileSync(env.GIT_CONFIG_GLOBAL, 'utf8')).toBe(config);
  });
});
