import { describe, it, expect } from 'vitest';
import { isCiReadonlyDryRun } from '../merge-ai-prs.mjs';

describe('CI read-only dry-run authentication', () => {
  it('allows the Actions token for a non-daemon CI dry-run', () => {
    expect(isCiReadonlyDryRun({ GITHUB_ACTIONS: 'true' }, ['node', 'merge-ai-prs.mjs', '--dry-run'])).toBe(true);
  });
  it.each([
    ['daemon dry-run', { GITHUB_ACTIONS: 'true', WE_GH_DAEMON_CALLER: 'drain' }, ['--dry-run']],
    ['live Actions drain', { GITHUB_ACTIONS: 'true' }, []],
    ['launchd dry-run', { WE_GH_DAEMON_CALLER: 'launchd' }, ['--dry-run']],
    ['local dry-run', {}, ['--dry-run']],
    ['launchd-marked Actions dry-run', { GITHUB_ACTIONS: 'true', XPC_SERVICE_NAME: 'com.we.drain' }, ['--dry-run']],
    ['conflicting dry-run spellings', { GITHUB_ACTIONS: 'true' }, ['--dry-run', '--dry-run=']],
    ['negated dry-run', { GITHUB_ACTIONS: 'true' }, ['--dry-run', '--no-dry-run']],
    ['non-Actions dry-run', { GITHUB_ACTIONS: 'false' }, ['--dry-run']],
  ])('retains daemon auth for %s', (_name, env, argv) => {
    expect(isCiReadonlyDryRun(env, argv)).toBe(false);
  });
});
