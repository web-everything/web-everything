/**
 * @file real-repo-fixture-config.test.mjs - the fixture repos switch off background git housekeeping in their OWN
 *   config, so un-injected git run by the code under test cannot detach a `gc --auto` that outlives the test and
 *   races the fixture's recursive cleanup (ENOTEMPTY on `.git/objects`, main @ b751cfac0).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { withRealRepo, withBareOrigin } from './helpers/real-repo.mjs';

// Plain `git`, NOT the helper's `git()`: that one injects `-c gc.auto=0` on every call and would mask a missing setting.
const configValue = (cwd, key) => execFileSync('git', ['config', '--local', '--get', key], { cwd, encoding: 'utf8' }).trim();

describe('fixture repos disable background housekeeping in their own config', () => {
  it('withRealRepo', async () => {
    await withRealRepo((ctx) => {
      expect(configValue(ctx.root, 'gc.auto')).toBe('0');
      expect(configValue(ctx.root, 'maintenance.auto')).toBe('false');
    });
  });

  it('withBareOrigin: both the bare origin and the clone', async () => {
    await withBareOrigin((ctx) => {
      for (const cwd of [ctx.origin, ctx.clone]) {
        expect(configValue(cwd, 'gc.auto')).toBe('0');
        expect(configValue(cwd, 'maintenance.auto')).toBe('false');
      }
    });
  });
});
