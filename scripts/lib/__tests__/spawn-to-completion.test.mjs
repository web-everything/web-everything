/**
 * @file spawn-to-completion.test.mjs — contract coverage for `scripts/lib/spawn-to-completion.mjs`, the async
 * `child_process.spawn()`-based replacement for the dispatch wrappers' old blocking `execFileSync` agent spawn
 * (#3383 mechanical-dispatcher follow-up).
 *
 * DELIBERATELY REAL PROCESSES, not a mocked `child_process.spawn`. Every test below spawns a REAL `node`
 * subprocess (`process.execPath -e '<script>'`), so the assertions are grounded in what the real Node
 * child_process API actually returns, not in an assumption about its shape.
 *
 * ON `resourceUsage` SPECIFICALLY: this module's own header documents a finding worth restating here, since it
 * is exactly the kind of thing a REAL-process test (rather than a fake spawn) catches. `ChildProcess` has NO
 * `resourceUsage()` method in real Node (verified against v18.2.0 and v22.1.0, and against `@types/node`'s own
 * `child_process.d.ts`, which declares no such member) — only `process.resourceUsage()` (the CURRENT process)
 * is real. So every test below asserts `resourceUsage` is `null` for a genuine spawned child, on purpose: that
 * IS the correct, honest behavior, not a bug to fix.
 */
import { describe, it, expect } from 'vitest';
import { spawnToCompletion } from '../spawn-to-completion.mjs';
import { keepAliveScript } from '../test-keepalive.mjs';

const NODE = process.execPath;

describe('spawnToCompletion — success path', () => {
  it('resolves {stdout, stderr, resourceUsage} for a clean exit — resourceUsage is honestly null (see file header)', async () => {
    const script = `
      process.stdout.write('hello-stdout');
      process.stderr.write('hello-stderr');
      process.exit(0);
    `;
    const result = await spawnToCompletion(NODE, ['-e', script], { encoding: 'utf8' });
    expect(result.stdout).toBe('hello-stdout');
    expect(result.stderr).toBe('hello-stderr');
    // A REAL child_process.spawn() ChildProcess has no resourceUsage() method — see this file's own header.
    expect(result.resourceUsage).toBeNull();
  }, 10_000);
});

describe('spawnToCompletion — non-zero exit (the execFileSync error contract)', () => {
  it('rejects an Error shaped like execFileSync\'s own throw: .status, .stdout, .stderr', async () => {
    const script = `
      process.stdout.write('partial output');
      process.stderr.write('the failure reason');
      process.exit(7);
    `;
    let caught;
    try {
      await spawnToCompletion(NODE, ['-e', script], { encoding: 'utf8' });
    } catch (e) { caught = e; }
    expect(caught).toBeTruthy();
    expect(caught.status).toBe(7);
    expect(caught.stdout).toBe('partial output');
    expect(caught.stderr).toBe('the failure reason');
    expect(caught.resourceUsage).toBeNull(); // honest — see file header.
    expect(caught.signal).toBeFalsy();
  }, 10_000);
});

describe('spawnToCompletion — timeout/killSignal (the execFileSync timeout contract)', () => {
  it('kills a wedged child after `timeout` ms and rejects with .signal/.killed set, same as a timed-out '
    + 'execFileSync call', async () => {
    // Never exits on its own — proves the timeout, not a lucky race.
    const script = keepAliveScript();
    let caught;
    try {
      await spawnToCompletion(NODE, ['-e', script], { encoding: 'utf8', timeout: 150, killSignal: 'SIGKILL' });
    } catch (e) { caught = e; }
    expect(caught).toBeTruthy();
    expect(caught.status).toBeNull();
    expect(caught.signal).toBe('SIGKILL');
    expect(caught.killed).toBe(true);
  }, 10_000);
});

describe('spawnToCompletion — maxBuffer (enforced by hand, since async spawn streams instead of buffering '
  + 'internally the way execFileSync does)', () => {
  it('kills the child and rejects once either stream crosses maxBuffer, carrying whatever was captured so far', async () => {
    const script = `
      // Write well past a tiny maxBuffer, in a loop so the overflow is detected mid-stream, not at exit.
      for (let i = 0; i < 200; i++) { process.stdout.write('x'.repeat(1024)); }
      setTimeout(() => process.exit(0), 500); // would otherwise exit cleanly — the kill must pre-empt this.
    `;
    let caught;
    try {
      await spawnToCompletion(NODE, ['-e', script], { encoding: 'utf8', maxBuffer: 1024 });
    } catch (e) { caught = e; }
    expect(caught).toBeTruthy();
    expect(caught.killed).toBe(true);
    expect(caught.message).toMatch(/maxBuffer exceeded/);
  }, 10_000);
});

describe('spawnToCompletion — spawn-level failure (ENOENT etc.)', () => {
  it('rejects the raw `error` event untouched when the child never starts at all', async () => {
    let caught;
    try {
      await spawnToCompletion('this-binary-does-not-exist-3383', ['x']);
    } catch (e) { caught = e; }
    expect(caught).toBeTruthy();
    expect(caught.code).toBe('ENOENT');
  });
});
