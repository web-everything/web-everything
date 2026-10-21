/**
 * @file scripts/operations/__tests__/pr-sweep-io-real.test.mjs
 * @description #2949 fidelity qualifier for `pr-sweep-io.mjs`: the two local reads it makes, proven against the
 *   real thing instead of stubs. `ps` is a REAL subprocess whose argv names a review job; the drain-log tail reads a
 *   REAL file written inside a `withRealRepo` fixture (a missing file must throw, a large file must be tailed, the
 *   newest skip-reasons row must win). The GitHub reads are covered by the injected suite in `pr-sweep.test.mjs`.
 */
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parseDrainSkips, parseLiveJobs, tailOf } from '../pr-sweep-io.mjs';
import { withRealRepo } from './helpers/real-repo.mjs';
import { keepAliveScript } from '../../lib/test-keepalive.mjs';

it('parseLiveJobs finds a REAL running review-job process in the real `ps` output', () => {
  const child = spawn(process.execPath, ['-e', keepAliveScript({ maxLifetimeMs: 20_000 }), '--', '/x/scripts/operations/review-job.mjs', 'run', '--pr=7777', '--repo=o/r'], { stdio: 'ignore' });
  try {
    const ps = execFileSync('ps', ['-axo', 'pid,etime,command'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    expect(parseLiveJobs(ps)).toContainEqual({ kind: 'review-job', pr: 7777, repo: 'o/r', source: 'ps' });
  } finally { child.kill(); }
});

it('tailOf reads the end of a REAL log, throws for a missing one, and the newest skip row wins', async () => {
  await withRealRepo(async ({ root }) => {
    const log = join(root, 'daemon.log');
    const filler = 'x'.repeat(200);
    const row = (n) => `merge-ai-prs · skip-reasons: [{"num":${n},"repo":"o/r","kind":"red-team-pending","reason":"r"}]`;
    writeFileSync(log, `${row(1)}\n${Array.from({ length: 50 }, () => filler).join('\n')}\n${row(2)}\n${filler}\n`);
    const tail = tailOf(log, 4096);
    expect(tail.length).toBeLessThanOrEqual(4096);
    expect(parseDrainSkips(tail).rows.map((r) => r.num)).toEqual([2]);
    expect(() => tailOf(join(root, 'absent.log'))).toThrow(/does not exist/);
  });
});
