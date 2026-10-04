/**
 * @file scripts/__tests__/vitest-worker-cap.test.mjs
 * @description Host-overload fix (heavy-enforce): every vitest config reads ONE worker ceiling,
 *   `WE_VITEST_MAX_WORKERS`, defaulting to max(1, min(4, floor(cpu count / heavy-admission cap))). Pins the
 *   resolver, its parity with heavy-admission's own cap parsing, and that every config file applies it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveMaxTestWorkers, VITEST_MAX_WORKERS_ENV, DEFAULT_VITEST_MAX_WORKERS } from '../../vitest.shared';
import { resolveCap } from '../readiness/heavy-admission.mjs';

describe('resolveMaxTestWorkers — one configurable vitest worker ceiling', () => {
  it('defaults to a ceiling of 4: 12 or 24 cores, cap 2 -> 4', () => {
    expect(DEFAULT_VITEST_MAX_WORKERS).toBe(4);
    expect(resolveMaxTestWorkers({}, 12)).toBe(4);
    expect(resolveMaxTestWorkers({}, 24)).toBe(4);
  });

  it('follows WE_HEAVY_ADMISSION_CAP: 12 cores, cap 3 -> 4; cap 5 -> 2', () => {
    expect(resolveMaxTestWorkers({ WE_HEAVY_ADMISSION_CAP: '3' }, 12)).toBe(4);
    expect(resolveMaxTestWorkers({ WE_HEAVY_ADMISSION_CAP: '5' }, 12)).toBe(2);
  });

  it('never drops below 1 worker', () => {
    expect(resolveMaxTestWorkers({ WE_HEAVY_ADMISSION_CAP: '8' }, 2)).toBe(1);
    expect(resolveMaxTestWorkers({}, 1)).toBe(1);
    expect(resolveMaxTestWorkers({}, 0)).toBe(1);
  });

  it('an explicit WE_VITEST_MAX_WORKERS wins', () => {
    expect(VITEST_MAX_WORKERS_ENV).toBe('WE_VITEST_MAX_WORKERS');
    expect(resolveMaxTestWorkers({ WE_VITEST_MAX_WORKERS: '6' }, 12)).toBe(6);
    expect(resolveMaxTestWorkers({ WE_VITEST_MAX_WORKERS: '3.9' }, 12)).toBe(3);
  });

  it('ignores an invalid WE_VITEST_MAX_WORKERS and falls back to the default', () => {
    for (const bad of ['0', '-2', '0.9', 'lots', '', 'Infinity', 'NaN']) {
      expect(resolveMaxTestWorkers({ WE_VITEST_MAX_WORKERS: bad }, 12)).toBe(4);
    }
  });

  it('parses the cap exactly like heavy-admission.mjs#resolveCap (no drift)', () => {
    for (const v of [undefined, '', '0', '1', '2', '3', '5', '8', '2.7', 'x', '-1']) {
      const env = v === undefined ? {} : { WE_HEAVY_ADMISSION_CAP: v };
      expect(resolveMaxTestWorkers(env, 24)).toBe(Math.max(1, Math.min(4, Math.floor(24 / resolveCap(env)))));
    }
  });
});

describe('every vitest config applies the shared ceiling', () => {
  const read = (f) => readFileSync(resolve(process.cwd(), f), 'utf8');
  it.each([
    ['vitest.config.ts', 'maxThreads: maxTestWorkers'],
    ['vitest.integration.config.ts', 'maxThreads: maxTestWorkers'],
    ['vitest.maas-conformance.config.ts', 'maxThreads: maxTestWorkers'],
    ['vitest.soak.config.ts', 'maxForks: maxTestWorkers'],
  ])('%s', (file, needle) => {
    const src = read(file);
    expect(src).toContain("from './vitest.shared'");
    expect(src).toContain(needle);
  });

  it('keeps the integration config serial forks pin (a correctness pin, not a speed one)', () => {
    expect(read('vitest.integration.config.ts')).toMatch(/forks:\s*\{\s*singleFork: true/);
  });
});
