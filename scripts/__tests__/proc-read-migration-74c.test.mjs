/**
 * @file proc-read-migration-74c.test.mjs — the #74c migrated gh/git readers (#4079): a >1 MiB read
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
  dir = mkdtempSync(join(tmpdir(), 'proc-read-74c-'));
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
const cli = (script, args) => spawnSync(process.execPath, [join(root, script), ...args], { encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 });

describe('#74c migrated readers: oversize completes, failure is never empty', () => {
  it('branch-sync gitRun', async () => {
    const { gitRun } = await import('../conveyor/branch-sync.mjs');
    fake({ out: 'x', pad: true });
    const ok = gitRun(['status'], root);
    expect(ok.ok).toBe(true);
    expect(ok.stdout.length).toBeGreaterThan(BIG);
    fake({ fail: true });
    expect(gitRun(['status'], root).ok).toBe(false);
  });

  it('rearm-review resolveLocalRefSha', async () => {
    const { resolveLocalRefSha } = await import('../conveyor/rearm-review.mjs');
    fake({ out: 'ABCDEF1234567\n', pad: true });
    expect(resolveLocalRefSha('main')).toBe('abcdef1234567');
    fake({ fail: true });
    expect(resolveLocalRefSha('main')).toBeNull();
  });

  it('infra-blocked originSlugOf', async () => {
    const { originSlugOf } = await import('../conveyor/infra-blocked.mjs');
    fake({ out: 'git@github.com:acme/widgets.git\n', pad: true });
    expect(originSlugOf(root)).toMatch(/acme\/widgets/i);
    fake({ fail: true });
    expect(originSlugOf(root)).toBeNull();
  });

  it('lease-reaper laneBranchItemNum', async () => {
    const { laneBranchItemNum } = await import('../conveyor/lease-reaper.mjs');
    fake({ out: 'lane/123-thing\n', pad: true });
    expect(laneBranchItemNum(root)).toBe(laneBranchItemNum(root, { git: () => 'lane/123-thing' }));
    fake({ fail: true });
    expect(laneBranchItemNum(root)).toBeNull();
  });

  it('review-ci-gate-io: oversize head read works; failed read refuses (unreadable-ci)', async () => {
    const { readReviewHead, readReviewCiGate } = await import('../lib/review-ci-gate-io.mjs');
    fake({ out: '{"headRefOid":"abc123"}', pad: true });
    expect(readReviewHead({ repo: 'a/b', pr: 1 })).toBe('abc123');
    fake({ fail: true });
    const gate = readReviewCiGate({ repo: 'a/b', pr: 1 });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe('unreadable-ci');
  });

  it.each([
    ['scripts/conveyor/advisory-fix-mark.mjs'],
    ['scripts/conveyor/conflict-fix-mark.mjs'],
  ])('%s: oversize gh output succeeds (stdout not captured); gh failure exits non-zero', (script) => {
    fake({ out: 'ok', pad: true });
    const ok = cli(script, ['5']);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('"commented":true');
    fake({ fail: true });
    expect(cli(script, ['5']).status).not.toBe(0);
  });

  it('stand-down: gh failure is a failure, oversize output is not', () => {
    fake({ out: 'ok', pad: true });
    const ok = cli('scripts/conveyor/stand-down.mjs', ['5', '--reason=gate-red', '--detail=x']);
    expect(ok.stderr).not.toMatch(/could not post stand-down comment/);
    fake({ fail: true });
    expect(cli('scripts/conveyor/stand-down.mjs', ['5', '--reason=gate-red', '--detail=x']).stderr).toMatch(/could not post stand-down comment/);
  });

  it('check-review-gate: a failed, empty, or oversize-but-valid read never reads as "no hold" unless the labels parse', () => {
    fake({ out: '{"labels":[]}', pad: true });
    expect(cli('scripts/check-review-gate.mjs', ['--pr=5']).status).toBe(0);
    fake({ out: '' });
    expect(cli('scripts/check-review-gate.mjs', ['--pr=5']).status).not.toBe(0);
    fake({ fail: true });
    expect(cli('scripts/check-review-gate.mjs', ['--pr=5']).status).not.toBe(0);
  });
});

describe('#74c migrated modules stay on the safe helper', () => {
  const MIGRATED = [
    'scripts/apply-review-request.mjs', 'scripts/check-review-gate.mjs', 'scripts/review-runner.mjs',
    'scripts/conveyor/canary.mjs', 'scripts/conveyor/ci-heal-mark.mjs', 'scripts/conveyor/lease-reaper.mjs',
    'scripts/conveyor/pr-watch.mjs', 'scripts/conveyor/rearm-review.mjs', 'scripts/conveyor/verify-dispatch.mjs',
    'scripts/lib/review-ci-gate-io.mjs',
  ];
  // Watchdog-graph modules cannot import proc-read (driver-watchdog.test pins that graph): explicit maxBuffer.
  // Write-only gh calls never capture stdout.
  const BOUNDED_INLINE = [
    'scripts/conveyor/branch-sync.mjs', 'scripts/conveyor/infra-blocked.mjs', 'scripts/conveyor/stand-down.mjs',
    'scripts/conveyor/advisory-fix-mark.mjs', 'scripts/conveyor/conflict-fix-mark.mjs',
  ];
  it.each([...MIGRATED, ...BOUNDED_INLINE])('%s has no unbounded capturing call and is out of the baseline', (file) => {
    const src = readFileSync(join(root, file), 'utf8');
    expect(findUnboundedExecReads(src)).toEqual([]);
    expect(baseline[file]).toBeUndefined();
    if (MIGRATED.includes(file)) expect(src).toMatch(/proc-read\.mjs/);
    expect(typeof countDefaultSeamParams(src)).toBe('number');
  });
});
