import { describe, it, expect } from 'vitest';
import { readJobFailures } from '../red-main-quarantine-io.mjs';
import { readJobLog } from '../../conveyor/main-ci-red-probe.mjs';

// 2026-11-22: gh refuses a log containing terminal escape sequences unless --allow-escape-sequences is passed, so every
// soak-shard log read threw and the red-main safety net never named the failing test.
const LOG = [
  '2026-11-22T23:25:07.4285701Z \u001b[33m❯\u001b[39m scripts/conveyor/soak/daemon-soak.soak.test.mjs',
  '2026-11-22T23:25:07.6212213Z \u001b[2m Test Files \u001b[22m \u001b[1m\u001b[31m1 failed\u001b[39m\u001b[22m\u001b[90m (1)\u001b[39m',
  '2026-11-22T23:25:07.6221119Z \u001b[31m\u001b[1m\u001b[7m FAIL \u001b[27m\u001b[22m\u001b[39m scripts/conveyor/soak/daemon-soak.soak.test.mjs\u001b[2m > \u001b[22m50 real daemon ticks',
  '2026-11-22T23:25:07.6237099Z \u001b[31mError\u001b[22m: Test timed out in 1020000ms.',
].join('\n');
const strictGh = (command, args) => {
  if (!args.includes('--allow-escape-sequences')) throw new Error('the response contains terminal escape sequences; pass --allow-escape-sequences');
  return LOG;
};

describe('red-main CI log reads pass --allow-escape-sequences', () => {
  it('names the timed-out soak test (quarantine safety net read)', () => {
    const r = readJobFailures(1, { exec: strictGh, repoSlug: 'o/r' });
    expect(r.complete).toBe(true);
    expect(r.files).toEqual(['scripts/conveyor/soak/daemon-soak.soak.test.mjs']);
  });
  it('reads the log text (main-ci-red probe)', () => {
    expect(readJobLog(1, { exec: strictGh, repoSlug: 'o/r' })).toContain('Test timed out');
  });
});
