import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { emptyCwdsArgs } from './fixtures/empty-lane-cwds.mjs';

it('empty-cwd loader preserves liveness exports and only replaces the cwd probe', () => {
  const moduleUrl = new URL('../lib/lane-lease-liveness.mjs', import.meta.url).href;
  const source = `
    import assert from 'node:assert/strict';
    import * as fixture from ${JSON.stringify(moduleUrl)};
    import * as actual from ${JSON.stringify(moduleUrl + '?actual')};
    assert.deepEqual(Object.keys(fixture), Object.keys(actual));
    for (const name of Object.keys(actual)) {
      if (name !== 'staleTakeoverHasLiveProcesses') assert.equal(fixture[name], actual[name], name);
    }
    // The loader must override the cwd probe even when the caller supplies one.
    assert.equal(fixture.staleTakeoverHasLiveProcesses('/fixture', {
      readCwds: () => { throw new Error('must use empty cwd evidence'); },
    }), false);
    // Preserve the real PID/dirty safety decisions, including unreadable evidence.
    assert.deepEqual(fixture.laneReclaimDecision({ pidAlive: true, dirty: false }), { safe: false, reason: 'stale-but-live' });
    assert.deepEqual(fixture.laneReclaimDecision({ pidAlive: false, dirty: null }), { safe: false, reason: 'stale-but-dirty' });
  `;
  const child = spawnSync(process.execPath, [...emptyCwdsArgs, '--input-type=module', '-e', source], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
});
