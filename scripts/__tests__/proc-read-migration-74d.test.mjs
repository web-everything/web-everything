/**
 * @file proc-read-migration-74d.test.mjs — the #74d migrated gh/git readers (#4079): a >1 MiB read
 * completes (the old default 1 MiB buffer threw ENOBUFS) and a failed read is unknown/skip, never empty.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countDefaultSeamParams, findUnboundedExecReads } from '../lib/exec-output-guard.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const baseline = JSON.parse(readFileSync(join(root, 'scripts/exec-output-baseline.json'), 'utf8'));
const BIG = 2 * 1024 * 1024;
let dir;
let savedPath;
let savedMode;
let savedOut;

// FAKE_OUT is the stdout line; FAKE_PAD appends BIG bytes of whitespace; FAKE_FAIL exits 1.
const shim = `#!/bin/sh
[ -n "$FAKE_FAIL" ] && { echo boom >&2; exit 1; }
printf '%s' "$FAKE_OUT"
[ -n "$FAKE_PAD" ] && head -c ${BIG} /dev/zero | tr '\\0' ' '
exit 0
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'proc-read-74d-'));
  for (const name of ['gh', 'git']) { writeFileSync(join(dir, name), shim); chmodSync(join(dir, name), 0o755); }
  savedPath = process.env.PATH;
  process.env.PATH = `${dir}:${savedPath}`;
  savedMode = process.env.FAKE_FAIL;
  savedOut = process.env.FAKE_OUT;
});
afterAll(() => {
  process.env.PATH = savedPath;
  for (const k of ['FAKE_FAIL', 'FAKE_OUT', 'FAKE_PAD']) delete process.env[k];
  rmSync(dir, { recursive: true, force: true });
});

const fake = ({ out = '', pad = false, fail = false }) => {
  process.env.FAKE_OUT = out;
  if (pad) process.env.FAKE_PAD = '1'; else delete process.env.FAKE_PAD;
  if (fail) process.env.FAKE_FAIL = '1'; else delete process.env.FAKE_FAIL;
};

describe('#74d migrated readers: oversize completes, failure is never empty', () => {
  it('prep-staleness: oversize diff completes; failed git is unchecked (unknown), never "not stale"', async () => {
    const { checkPrepStaleness } = await import('../readiness/prep-staleness.mjs');
    fake({ out: 'a.txt\n', pad: true });
    const ok = checkPrepStaleness({ scope: ['we:a.txt'], preparedAgainstSha: 'abc123', cwd: root });
    expect(ok.checked).toBe(true);
    expect(ok.changedFiles).toEqual(['a.txt']);
    fake({ fail: true });
    const bad = checkPrepStaleness({ scope: ['we:a.txt'], preparedAgainstSha: 'abc123', cwd: root });
    expect(bad.checked).toBe(false);
    expect(bad.stale).toBeUndefined();
  });

  it('lane-litter cleanLaneLitter: failed status read is skipped, never "clean"', async () => {
    const { cleanLaneLitter } = await import('../lib/lane-litter.mjs');
    fake({ fail: true });
    expect(cleanLaneLitter(root).skipped).toBe(true);
  });

  it('required-status-checks: oversize valid JSON parses; failure throws, never []', async () => {
    const { defaultReadRequiredStatusChecks } = await import('../lib/required-status-checks.mjs');
    fake({ out: '["test"]', pad: true });
    expect(defaultReadRequiredStatusChecks({ repo: 'a/b' })).toEqual(['test']);
    fake({ fail: true });
    expect(() => defaultReadRequiredStatusChecks({ repo: 'a/b' })).toThrow();
  });

  it('open-pr-items ghRun and main-staleness gitRun: oversize succeeds, failure is non-zero', async () => {
    const { ghRun } = await import('../lib/open-pr-items.mjs');
    const { gitRun } = await import('../lib/main-staleness.mjs');
    for (const run of [(a) => ghRun(a), (a) => gitRun(a, { cwd: root })]) {
      fake({ out: 'x', pad: true });
      const ok = run(['status']);
      expect(ok.status).toBe(0);
      expect(ok.stdout.length).toBeGreaterThan(BIG);
      fake({ fail: true });
      expect(run(['status']).status).not.toBe(0);
    }
  });

  it('health-watch probeLaneVerifyMarkers: missing pool is tolerated (never throws)', async () => {
    const { probeLaneVerifyMarkers } = await import('../conveyor/health-watch.mjs');
    fake({ fail: true });
    expect(() => probeLaneVerifyMarkers({ poolRoot: join(dir, 'none') })).not.toThrow();
  });
});

describe('#74d migrated modules stay on the safe helper', () => {
  const MIGRATED = [
    'scripts/lane-pool.mjs', 'scripts/conveyor/health-watch.mjs', 'scripts/readiness/prep-staleness.mjs',
    'scripts/readiness/scope-lease-collect.mjs', 'scripts/lib/pool-leftovers.mjs', 'scripts/lib/lane-litter.mjs',
    'scripts/lib/required-status-checks.mjs',
  ];
  const BOUNDED_INLINE = ['scripts/lib/open-pr-items.mjs', 'scripts/lib/main-staleness.mjs'];
  it.each([...MIGRATED, ...BOUNDED_INLINE])('%s has no unbounded capturing call and is out of the baseline', (file) => {
    const src = readFileSync(join(root, file), 'utf8');
    expect(findUnboundedExecReads(src)).toEqual([]);
    expect(baseline[file]).toBeUndefined();
    if (MIGRATED.includes(file)) expect(src).toMatch(/proc-read\.mjs/);
    expect(typeof countDefaultSeamParams(src)).toBe('number');
  });
});
