/**
 * @file scripts/__tests__/vitest-worker-cap.test.mjs
 * @description Host-overload fix (heavy-enforce): every vitest config reads ONE worker ceiling,
 *   `WE_VITEST_MAX_WORKERS` (positive finite value, rounded down), otherwise max(1, min(4, floor(cpu count / heavy-admission cap))). Pins the
 *   resolver, its parity with heavy-admission's own cap parsing, and that every config file applies it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import micromatch from 'micromatch';
import unitConfig from '../../vitest.config';
import integrationConfig from '../../vitest.integration.config';
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
    expect(resolveMaxTestWorkers({ CI: 'true', WE_VITEST_MAX_WORKERS: '6' }, 12)).toBe(6);
    expect(resolveMaxTestWorkers({ WE_VITEST_MAX_WORKERS: '6' }, 12)).toBe(6);
    expect(resolveMaxTestWorkers({ WE_VITEST_MAX_WORKERS: '3.9' }, 12)).toBe(3);
  });

  it('ignores an invalid WE_VITEST_MAX_WORKERS and falls back to the default', () => {
    for (const bad of ['0', '-2', '0.9', 'lots', '', 'Infinity', 'NaN']) {
      expect(resolveMaxTestWorkers({ CI: 'true', WE_VITEST_MAX_WORKERS: bad }, 12)).toBe(4);
    }
  });

  it('parses the cap exactly like heavy-admission.mjs#resolveCap (no drift)', () => {
    for (const v of [undefined, '', '0', '1', '2', '3', '5', '8', '2.7', 'x', '-1']) {
      // A private pool (LANE_POOL_ROOT) is where resolveCap still reads this env; on the shared host pool the cap
      // comes from the host-wide heavyAdmission policy instead (admission-no-fail-open).
      const env = v === undefined ? { LANE_POOL_ROOT: '/private-test-pool' } : { LANE_POOL_ROOT: '/private-test-pool', WE_HEAVY_ADMISSION_CAP: v };
      expect(resolveMaxTestWorkers(env, 24)).toBe(Math.max(1, Math.min(4, Math.floor(24 / resolveCap(env)))));
    }
  });
});

describe('ci worker count', () => {
  it.each(['1', '4', '8', ' 6 '])('uses valid CI override %j', (value) => {
    expect(resolveMaxTestWorkers({ CI: 'true', WE_VITEST_MAX_WORKERS: value }, 4)).toBe(Number(value));
  });

  it('uses the cpu/heavy-cap rule in CI without an override', () => {
    expect(resolveMaxTestWorkers({ CI: 'true' }, 4)).toBe(2);
    expect(resolveMaxTestWorkers({ CI: 'true', WE_HEAVY_ADMISSION_CAP: '4' }, 4)).toBe(1);
  });

  it.each([undefined, 'false', '1', 'TRUE', 'true'])('honours local load limiters and elastic grants with CI=%j', (CI) => {
    expect(resolveMaxTestWorkers({ CI, WE_VITEST_MAX_WORKERS: '2' }, 12)).toBe(2);
    expect(resolveMaxTestWorkers({ CI, WE_VITEST_MAX_WORKERS: '24', FORGE_SLOT_CPUS: '24' }, 4)).toBe(24);
  });

  it.each(['', '  ', '0', '-1', '0.9', 'lots', 'Infinity', 'NaN'])('falls back for invalid CI override %j', (value) => {
    expect(resolveMaxTestWorkers({ CI: 'true', WE_VITEST_MAX_WORKERS: value }, 4)).toBe(2);
    expect(resolveMaxTestWorkers({ CI: 'true', WE_VITEST_MAX_WORKERS: value, WE_HEAVY_ADMISSION_CAP: '4' }, 4)).toBe(1);
  });
});

describe('worker override producer contracts', () => {
  it('resolves the actual non-CI Forge elastic slot environment to its granted 24 workers', async () => {
    const { createRunner, digestInput, digestArgv, manifestWire, digestManifest } = await import('../readiness/forge-exec-run.mjs');
    const hash = value => createHash('sha256').update(value).digest('hex');
    const root = await fs.mkdtemp(resolve(tmpdir(), 'vitest-forge-workers-'));
    let runner, prepared;
    const nonce = 'a'.repeat(32), environments = [];
    try {
      await fs.mkdir(resolve(root, 'runs/slot-1'), { recursive: true, mode: 0o710 });
      runner = createRunner({ testRoot: root, testPath: '/usr/bin:/bin', testWorkerExec: async ({ env }) => {
        environments.push(env);
        return { code: 0, stdout: '', stderr: '' };
      } });
      prepared = await runner.prepare({ nonce, slotUnits: 3 });
      const work = resolve(root, 'runs/slot-1', prepared.run, 'work');
      await fs.writeFile(resolve(work, 'package-lock.json'), 'lock');
      const manifest = manifestWire({ entries: [{ path: Buffer.from('package-lock.json'), sha256: hash('lock'), executable: false }], excluded: [] });
      const argv = ['npm', 'run', 'test:unit'];
      const result = await runner.run({ ...prepared, nonce, argv, env: {}, lock: hash('lock'),
        manifest, manifestDigest: digestManifest(manifest), inputDigest: await digestInput(work), argvDigest: digestArgv(argv) });
      expect(result.code).toBe(0);
      expect(environments.length).toBeGreaterThan(0);
      // Dependency installation uses CI=true; the task itself retains the non-CI request.
      expect(environments.some(env => env.CI === undefined)).toBe(true);
      for (const env of environments) {
        expect(env).toMatchObject({ WE_VITEST_MAX_WORKERS: '24', FORGE_SLOT_CPUS: '24' });
        expect(resolveMaxTestWorkers(env, 4)).toBe(24);
      }
    } finally {
      try {
        if (prepared) await runner.finish({ ...prepared, nonce });
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  }, 60_000);

  it('honours the non-CI load limiter forwarded by load-flake reverify', async () => {
    const { scrubVerifyEnv } = await import('../conveyor/load-flake-reverify.mjs');
    const env = scrubVerifyEnv({ WE_VITEST_MAX_WORKERS: '2' });
    expect(env.WE_VITEST_MAX_WORKERS).toBe('2');
    expect(env.CI).toBeUndefined();
    expect(resolveMaxTestWorkers(env, 12)).toBe(2);
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

  it('keeps established-overlay rebuild coverage in the blocking serial integration tier', () => {
    const file = 'scripts/lib/__tests__/daemon-rebuild-keep-established.test.mjs';
    expect(micromatch.isMatch(file, unitConfig.test.exclude)).toBe(true);
    expect(micromatch.isMatch(file, integrationConfig.test.include)).toBe(true);
    expect(micromatch.isMatch(file, integrationConfig.test.exclude ?? [])).toBe(false);
    const pool = integrationConfig.test.poolMatchGlobs.find(([glob]) => micromatch.isMatch(file, glob))?.[1]
      ?? integrationConfig.test.pool;
    expect(pool).toBe('forks');
    expect(integrationConfig.test.poolOptions.forks.singleFork).toBe(true);
  });

  it('keeps skip-unrelated rebuild coverage in the blocking serial integration tier', () => {
    const file = 'scripts/lib/__tests__/daemon-rebuild-skip-unrelated.test.mjs';
    expect(micromatch.isMatch(file, unitConfig.test.exclude)).toBe(true);
    expect(micromatch.isMatch(file, integrationConfig.test.include)).toBe(true);
    expect(micromatch.isMatch(file, integrationConfig.test.exclude ?? [])).toBe(false);
    const pool = integrationConfig.test.poolMatchGlobs.find(([glob]) => micromatch.isMatch(file, glob))?.[1]
      ?? integrationConfig.test.pool;
    expect(pool).toBe('forks');
    expect(integrationConfig.test.poolOptions.forks.singleFork).toBe(true);
  });

  it('keeps fallback rebuild coverage in the blocking serial integration tier', () => {
    const file = 'scripts/lib/__tests__/daemon-rebuild-fallback.test.mjs';
    expect(micromatch.isMatch(file, unitConfig.test.exclude)).toBe(true);
    expect(micromatch.isMatch(file, integrationConfig.test.include)).toBe(true);
    expect(micromatch.isMatch(file, integrationConfig.test.exclude ?? [])).toBe(false);
    const pool = integrationConfig.test.poolMatchGlobs.find(([glob]) => micromatch.isMatch(file, glob))?.[1]
      ?? integrationConfig.test.pool;
    expect(pool).toBe('forks');
    expect(integrationConfig.test.poolOptions.forks.singleFork).toBe(true);
  });

  it('serializes repository-wide scanner parity checks with daemon scenarios', () => {
    const config = integrationConfig.test;
    const poolFor = (file) => config.poolMatchGlobs.find(([glob]) => micromatch.isMatch(file, glob))?.[1] ?? config.pool;
    const scenarios = config.include.filter((file) => /\/sim-scenario.*\.test\.mjs$/.test(file));
    const scanners = config.include.filter((file) => /\/rust-scan-.*-parity\.test\.mjs$/.test(file));
    expect(scenarios.length).toBeGreaterThan(0);
    expect(scanners.length).toBeGreaterThan(0);
    expect(config.poolOptions.forks.singleFork).toBe(true);
    for (const file of [...scenarios, ...scanners]) {
      expect(poolFor(file), file).toBe('forks');
    }
  });

  it('queues Rust repository scans with daemon scenarios in the single fork', () => {
    const files = [
      'scripts/__tests__/rust-scan-stdout-flush-parity.test.mjs',
      'scripts/__tests__/rust-scan-secret-scrub-parity.test.mjs',
      'scripts/__tests__/rust-scan-locus-prefix-parity.test.mjs',
      'scripts/__tests__/rust-scan-citation-check-parity.test.mjs',
      'scripts/conveyor/__tests__/sim-scenario-self-sync-sibling.test.mjs',
    ];
    for (const file of files) {
      expect(integrationConfig.test.include).toContain(file);
      expect(integrationConfig.test.poolMatchGlobs).toContainEqual([file, 'forks']);
    }
    expect(integrationConfig.test.poolOptions.forks.singleFork).toBe(true);
  });
});
