/**
 * @file bounded-child-tree-kill.test.mjs — killProcessTree / descendantPids (verify-admission, 2026-10-20): verify-lane's
 * per-phase timeout must kill the whole gate tree (shell → npm exec → vitest → esbuild), not just the shell.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { descendantPids, killProcessTree } from '../bounded-child.mjs';

describe('descendantPids', () => {
  it('returns every descendant, deepest first, excluding the root and unrelated processes', () => {
    const ps = ['1 0', '10 1', '11 10', '12 11', '13 10', '20 1', ' 14   12 ', 'junk', '15 15'].join('\n');
    expect(descendantPids(10, ps)).toEqual([14, 12, 11, 13]);
    expect(descendantPids(99, ps)).toEqual([]);
  });
});

describe('killProcessTree', () => {
  it('signals descendants before the root, and tolerates already-dead pids', () => {
    const sent = [];
    const kill = (pid, sig) => { if (pid === 11) throw new Error('ESRCH'); sent.push([pid, sig]); };
    expect(killProcessTree(10, 'SIGKILL', { listProcesses: () => '10 1\n11 10\n12 11\n', kill })).toEqual([12, 10]);
    expect(sent).toEqual([[12, 'SIGKILL'], [10, 'SIGKILL']]);
    expect(killProcessTree(0)).toEqual([]);
  });

  it('kills a real grandchild that a plain child.kill() would orphan', async () => {
    const child = spawn('sh', ['-c', 'sleep 60 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const grandchild = await new Promise((r) => child.stdout.once('data', (d) => r(Number(String(d).trim()))));
    const closed = new Promise((r) => child.once('close', r));
    killProcessTree(child.pid, 'SIGKILL');
    await closed;
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(grandchild, 0)).toThrow();
  });
});
