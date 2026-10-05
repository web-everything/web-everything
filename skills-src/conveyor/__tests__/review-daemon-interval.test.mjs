import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, resolveReviewIntervalMs, buildCliDaemonEffects,
} from '../review-daemon.mjs';

describe('resolveReviewIntervalMs', () => {
  it('defaults to 120000 when neither source is set', () => {
    expect(DEFAULT_INTERVAL_MS).toBe(120_000);
    expect(resolveReviewIntervalMs({ env: {}, argv: [] })).toBe(120_000);
  });

  it('uses the environment value', () => {
    expect(resolveReviewIntervalMs({
      env: { WE_REVIEW_DAEMON_INTERVAL_MS: '45000' }, argv: [],
    })).toBe(45_000);
  });

  it.each([['--interval-ms=30000'], ['--interval-ms', '30000']])(
    'prefers the flag over the environment: %s', (...argv) => {
      expect(resolveReviewIntervalMs({
        env: { WE_REVIEW_DAEMON_INTERVAL_MS: '45000' }, argv,
      })).toBe(30_000);
    },
  );

  it.each(['junk', '0', '-1', '', '   ', 'Infinity', 'NaN'])(
    'ignores invalid environment value %j', (value) => {
      expect(resolveReviewIntervalMs({
        env: { WE_REVIEW_DAEMON_INTERVAL_MS: value }, argv: [],
      })).toBe(DEFAULT_INTERVAL_MS);
    },
  );

  it.each(['junk', '0', '-1', '', '   ', 'Infinity', 'NaN'])(
    'falls back to the environment for invalid flag value %j', (value) => {
      for (const argv of [[`--interval-ms=${value}`], ['--interval-ms', value]]) {
        expect(resolveReviewIntervalMs({
          env: { WE_REVIEW_DAEMON_INTERVAL_MS: '45000' }, argv,
        })).toBe(45_000);
      }
    },
  );

  it('ignores a flag with no value', () => {
    expect(resolveReviewIntervalMs({ env: {}, argv: ['--interval-ms'] })).toBe(DEFAULT_INTERVAL_MS);
  });

  it('floors valid environment and flag values to 10000', () => {
    expect(MIN_INTERVAL_MS).toBe(10_000);
    expect(resolveReviewIntervalMs({
      env: { WE_REVIEW_DAEMON_INTERVAL_MS: '1' }, argv: [],
    })).toBe(MIN_INTERVAL_MS);
    expect(resolveReviewIntervalMs({
      env: { WE_REVIEW_DAEMON_INTERVAL_MS: '45000' }, argv: ['--interval-ms=1'],
    })).toBe(MIN_INTERVAL_MS);
  });
});

describe('buildCliDaemonEffects interval', () => {
  it('preserves the supplied interval', () => {
    expect(buildCliDaemonEffects({ owner: 'x', intervalMs: 30000 }).intervalMs).toBe(30000);
  });
});
