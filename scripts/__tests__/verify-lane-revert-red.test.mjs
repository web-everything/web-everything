/**
 * #5466 — the revert-red wiring INSIDE verify-lane, end to end: a real git checkout, the real verify-lane process, a real
 * vitest run of a real test file. Pins what only the wiring can break: recovery of a killed run's revert BEFORE the gate,
 * the check running after a green gate and before the marker, warn leaving the verdict green, enforce turning it red,
 * and the tree left exactly at the verified commit.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withRealRepo } from '../operations/__tests__/helpers/real-repo.mjs';

const WE = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = 'scripts/x/guard.mjs';
const TEST = 'scripts/x/__tests__/guard.test.mjs';
const BUGGY = 'export const guard = (name) => name.length > 0;\n';
const FIXED = "export const guard = (name) => name.length > 0 && !name.startsWith('.');\n";
const OLD_TEST = "import { it, expect } from 'vitest';\nimport { guard } from '../guard.mjs';\nit('accepts a plain name', () => expect(guard('a')).toBe(true));\n";
const NEW_TEST = `${OLD_TEST}it('refuses a dot name', () => expect(guard('.a')).toBe(false));\nit('weak: a long name is fine', () => expect(guard('abc')).toBe(true));\n`;

function verify(ctx, mode) {
  const r = spawnSync(process.execPath, [join(WE, 'scripts/verify-lane.mjs'), `--repo=${ctx.root}`, `--gate=npx vitest run ${TEST} --run`, '--json'], {
    cwd: ctx.root, encoding: 'utf8', timeout: 180_000,
    env: { ...process.env, WE_VERIFY_REVERT_RED: mode, WE_COORDINATION_ROOT: join(ctx.tmp, 'coord') },
  });
  const last = r.stdout.trim().split('\n').at(-1);
  return { status: r.status, out: JSON.parse(last), stderr: r.stderr };
}

async function withFixLane(fn) {
  return withRealRepo(async (ctx) => {
    symlinkSync(join(WE, 'node_modules'), join(ctx.root, 'node_modules'));
    writeFileSync(join(ctx.root, '.gitignore'), 'node_modules\n');
    ctx.commit({ 'package.json': '{"type":"module"}\n', '.gitignore': 'node_modules\n', [SRC]: BUGGY, [TEST]: OLD_TEST }, 'base');
    const base = ctx.head();
    ctx.commit({ [SRC]: FIXED, [TEST]: NEW_TEST }, 'fix');
    const fix = ctx.head();
    ctx.git(['update-ref', 'refs/remotes/origin/lane/demo', base]);
    writeFileSync(join(ctx.root, '.git', '.fix-await-verify'), JSON.stringify({ v: 1, kind: 'fix', pr: 1, sha: fix, ref: 'lane/demo',
      repo: 'o/n', who: 'test', requestedAt: new Date().toISOString(), attempt: 1 }));
    return fn({ ...ctx, base, fix });
  });
}

describe('verify-lane runs the revert-red check on a fix push', () => {
  it('restores a killed run\'s revert first, stays green in warn, records the weak test, and leaves the tree clean', async () => {
    await withFixLane(async (ctx) => {
      // A previous run was killed mid-revert: the source is reverted and its journal (dead pid) is still there.
      writeFileSync(join(ctx.root, SRC), BUGGY);
      writeFileSync(join(ctx.root, '.git', '.revert-red-pending.json'), JSON.stringify({ head: ctx.fix, pid: 2 ** 22 + 7, host: 'elsewhere',
        files: [{ path: SRC, reverted: createHash('sha256').update(BUGGY).digest('hex') }] }));
      const r = verify(ctx, 'warn');
      expect(r.stderr).toContain('restored a revert a killed run left behind (1 file(s))');
      expect(r.status).toBe(0);
      expect(r.out).toMatchObject({ status: 'green' });
      expect(r.out.revertRed).toMatchObject({ mode: 'warn', status: 'flagged', blocking: false,
        nonDiscriminating: [{ file: TEST, test: 'weak: a long name is fine' }] });
      expect(r.out.revertRed.discriminating).toContainEqual({ file: TEST, test: 'refuses a dot name' });
      const marker = JSON.parse(readFileSync(join(ctx.root, '.git', '.lane-verify'), 'utf8'));
      expect(marker).toMatchObject({ status: 'green', sha: ctx.fix, revertRed: { status: 'flagged' } });
      expect(readFileSync(join(ctx.root, SRC), 'utf8')).toBe(FIXED);
      expect(ctx.git(['status', '--porcelain']).trim()).toBe('');
      expect(existsSync(join(ctx.root, '.git', '.revert-red-pending.json'))).toBe(false);
    });
  }, 240_000);

  it('enforce turns the same result red; off runs nothing', async () => {
    await withFixLane(async (ctx) => {
      const enforce = verify(ctx, 'enforce');
      expect(enforce.status).toBe(2);
      expect(enforce.out).toMatchObject({ status: 'red', revertRed: { blocking: true } });
      const off = verify(ctx, 'off');
      expect(off.status).toBe(0);
      expect(off.out.status).toBe('green');
      expect(off.out.revertRed).toBeUndefined();
      expect(ctx.git(['status', '--porcelain']).trim()).toBe('');
    });
  }, 240_000);
});
