// R1100 hot-patch live-proof red canary: passes on a developer host; under GitHub Actions it waits about twelve
// minutes (so the shard stays in progress while a hot patch is requested) and then fails.
import { test } from 'vitest';
import assert from 'node:assert/strict';

test('red canary: must not run under GitHub Actions', async () => {
  if (process.env.GITHUB_ACTIONS === 'true') await new Promise(resolve => setTimeout(resolve, 720000));
  assert.notEqual(process.env.GITHUB_ACTIONS, 'true');
}, 900000);
