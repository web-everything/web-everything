/**
 * @file daemon-boot-watchdog-live.test.mjs — #4468 part 2, THE LIVE PROOF the card requires: "live proof via
 * a deliberately broken overlay on a scratch clone". Real everything — a real scratch git clone (never the real
 * repo, never a real running daemon), real `node` child processes (the real {@link defaultSpawn} this module
 * uses in production, not an injected fake), and the real `git reset --hard` revert
 * (`daemon-live-smoke.mjs#rollbackToSha`) — proving the whole crash-loop-then-self-heal arc end to end:
 *
 *   1. Commit A ("good"): the entry stays alive — a supervised start survives and stamps A as boot-confirmed.
 *   2. Commit B ("a deliberately broken overlay"): the entry crashes immediately on every start.
 *   3. Three consecutive supervised starts against B each exit fast and get recorded.
 *   4. The FOURTH start never spawns the broken code again — it reverts the scratch clone `git reset --hard`
 *      back to commit A (the last BOOT-CONFIRMED sha — never merely the last smoke-adopted one) BEFORE trying
 *      to start anything, and clears the attempt history.
 *   5. A subsequent start against the now-reverted clone survives again — the self-heal is real, not asserted.
 *
 * Bounded and fast: the survival window is 1.5s (generous headroom over a real spawn's ~60-80ms exit, so this
 * stays reliable on a loaded host — #4468 review), not the real {@link DEFAULT_SURVIVAL_MS}.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keepAliveScript } from '../test-keepalive.mjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readBootState, runSupervisedStart } from '../daemon-boot-watchdog.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function headSha(cwd) {
  return git(['rev-parse', 'HEAD'], cwd);
}

describe('daemon-boot-watchdog — live scratch-clone proof (real process, real git, never a real daemon)', () => {
  let root; let stateDir; let env;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'daemon-boot-live-clone-'));
    stateDir = mkdtempSync(join(tmpdir(), 'daemon-boot-live-state-'));
    env = { ...process.env, WE_DAEMON_STATE_DIR: stateDir };
    git(['init', '-q'], root);
    git(['config', 'user.email', 'soak@example.invalid'], root);
    git(['config', 'user.name', 'soak'], root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('crash-loops on a broken overlay, then reverts to the last boot-confirmed commit before the next start, then self-heals', async () => {
    // Commit A — "good": stays alive past the survival window.
    writeFileSync(join(root, 'entry.mjs'), `${keepAliveScript()}\n`);
    git(['add', 'entry.mjs'], root);
    git(['commit', '-q', '-m', 'good'], root);
    const shaGood = headSha(root);

    const survive = await runSupervisedStart({ root, entry: 'entry.mjs', env, thresholdMs: 1500, countThreshold: 3 });
    expect(survive.started).toBe(true);
    expect(survive.survived).toBe(true);
    survive.child?.kill?.('SIGKILL');
    expect(readBootState(root, env).bootConfirmed.head).toBe(shaGood);

    // Commit B — "a deliberately broken overlay": crashes immediately, every time.
    writeFileSync(join(root, 'entry.mjs'), "throw new Error('deliberately broken overlay — live #4468 proof');\n");
    git(['add', 'entry.mjs'], root);
    git(['commit', '-q', '-m', 'broken overlay'], root);
    const shaBroken = headSha(root);
    expect(shaBroken).not.toBe(shaGood);

    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- each attempt must observe the previous one's recorded history
      const attempt = await runSupervisedStart({ root, entry: 'entry.mjs', env, thresholdMs: 1500, countThreshold: 3 });
      expect(attempt.started).toBe(true);
      expect(attempt.survived).toBe(false);
    }
    expect(readBootState(root, env).attempts).toHaveLength(3);
    expect(headSha(root)).toBe(shaBroken); // still broken — nothing has reverted it yet

    // The 4th attempt: never spawns the broken code again — reverts FIRST.
    const reverted = await runSupervisedStart({ root, entry: 'entry.mjs', env, thresholdMs: 1500, countThreshold: 3 });
    expect(reverted.started).toBe(false);
    expect(reverted.reverted.ok).toBe(true);
    expect(headSha(root)).toBe(shaGood); // the scratch clone is REALLY back on the last boot-confirmed commit
    expect(readBootState(root, env).attempts).toEqual([]);

    // Self-heal proof: a start against the now-reverted (good) clone survives again.
    const healed = await runSupervisedStart({ root, entry: 'entry.mjs', env, thresholdMs: 1500, countThreshold: 3 });
    expect(healed.started).toBe(true);
    expect(healed.survived).toBe(true);
    healed.child?.kill?.('SIGKILL');
  }, 30_000);
});

// #4468 review — "the CLI main() has no test exercising it" (a real gap: everything above drives
// `runSupervisedStart` in-process). Real `node <this file>.mjs --entry=... --clone=...` invocations, proving
// the CLI wiring itself, not just the function it calls.
describe('daemon-boot-watchdog — CLI (real `node` invocation of main())', () => {
  const CLI = join(process.cwd(), 'scripts/lib/daemon-boot-watchdog.mjs');
  let clone; let stateDir;

  beforeEach(() => {
    clone = mkdtempSync(join(tmpdir(), 'daemon-boot-cli-clone-'));
    stateDir = mkdtempSync(join(tmpdir(), 'daemon-boot-cli-state-'));
  });
  afterEach(() => {
    rmSync(clone, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('usage-errors with exit code 2 and a usage: message when --entry/--clone are missing (#4468 review — pins the ACTUAL exit code and stderr text, not just "something threw")', () => {
    let threw = null;
    try {
      execFileSync(process.execPath, [CLI], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      threw = e;
    }
    expect(threw).not.toBeNull();
    expect(threw.status).toBe(2);
    expect(threw.stderr).toContain('usage:');
  });

  it('runs ONE real supervised start and prints the JSON result on stdout', () => {
    // The CLI's own JSON output never carries a killable child handle (by design — see `main()`'s own
    // `replacer`), so this entry self-exits shortly after clearing the survival window instead of leaking a
    // real detached `node` process past the end of this test.
    writeFileSync(join(clone, 'entry.mjs'), `${keepAliveScript({ postlude: 'setTimeout(() => process.exit(0), 1200);' })}\n`);
    const out = execFileSync(process.execPath, [CLI, '--entry=entry.mjs', `--clone=${clone}`], {
      encoding: 'utf8', env: { ...process.env, WE_DAEMON_STATE_DIR: stateDir, WE_DAEMON_BOOT_SURVIVAL_MS: '300' },
    });
    const result = JSON.parse(out.trim());
    expect(result.started).toBe(true);
    expect(result.survived).toBe(true);
    // The CLI's own default survival window is real (15s) unless overridden — WE_DAEMON_BOOT_SURVIVAL_MS above
    // keeps this test fast without editing `runSupervisedStart`'s call inside `main()`.
  }, 10_000);
});
