// R1100 hot-patch live-proof red canary: passes on a developer host, fails only in GitHub Actions (the slow test job).
import { test } from 'vitest';
import assert from 'node:assert/strict';

test('red canary: must not run under GitHub Actions', () => {
  assert.notEqual(process.env.GITHUB_ACTIONS, 'true');
});
