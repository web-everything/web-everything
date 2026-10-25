/**
 * @file scripts/operations/__tests__/clear-stuck-session-io-real.test.mjs
 * @description THE REAL-MECHANISM half of `clear-stuck-session`'s io shell (#2949's fidelity qualifier) —
 *   {@link ../clear-stuck-session-io.mjs} exercised against a real directory tree, a real `ps aux` shell-out,
 *   and a real reaped pid. Its sibling {@link ../__tests__/clear-stuck-session.test.mjs} drives every
 *   DECISION through injected doubles; those stay, because they pin judgement rather than mechanics. This
 *   file exists because a double has no directory tree and no process table, and this module's whole job —
 *   moving a real job directory aside, and scanning the real process table for a session id — is those two
 *   things.
 *
 * WHAT A DOUBLE CANNOT ANSWER HERE, concretely:
 *   • whether `ps aux`'s real output actually contains a running Claude Code session's full UUID in its
 *     command line (this suite's own live-fire measurement on 2026-09-13 found `--resume=<uuid>`, never the
 *     short id) — `scanPsForSession`'s whole premise;
 *   • whether `renameSync` really moves the directory's OWN CONTENTS, not just an empty shell, into
 *     `<config-dir>/jobs/.cleared/<id>-<ts>/` — and whether a SECOND attempt against an already-moved source
 *     behaves as the idempotent "already gone" case rather than throwing `ENOENT`.
 *
 * No `claude`, no `gh`, no network: the agent listing and the PR fetch stay injected, because a real one
 * would mean listing (or querying) this operator's own live sessions/PRs from a test.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { keepAliveScript } from '../../lib/test-keepalive.mjs';

import { withRealRepo } from './helpers/real-repo.mjs';
import {
  jobsDir, quarantineDir, scanPsForSession, resolvePidAlive, moveJobDirAside,
} from '../clear-stuck-session-io.mjs';

/** A REAL pid that is REALLY dead — see `restart-runner-io-real.test.mjs`'s identical helper for why this
 *  beats a made-up large number (a made-up one can trip a platform `ps` complaint, or coincide with something
 *  real on the machine). */
async function reapedPid() {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise((r) => child.on('exit', r));
  return pid;
}

describe('scanPsForSession — the REAL process table on this platform', () => {
  it('really finds a live child process whose argv carries the marker id as --resume=<id>', async () => {
    // `--resume=<id>` is the real shape (see this scan's own header comment) — a bare marker with no flag no
    // longer matches, by design: that used to be indistinguishable from this OPERATION's own
    // `--session=<id>` invocation, which is the #3383 bug this file's sibling suite fixes.
    const marker = '11112222-3333-4444-5555-666677778888';
    const child = spawn(process.execPath, ['-e', keepAliveScript({ prelude: `/*--resume=${marker}*/`, maxLifetimeMs: 5000 })], { stdio: 'ignore' });
    try {
      // Real `ps aux`, no injected exec — give the OS a moment to make the child visible in the table.
      const seen = await (async () => {
        for (let i = 0; i < 40; i += 1) {
          if (scanPsForSession(marker) === true) return true;
          await new Promise((r) => setTimeout(r, 50));
        }
        return false;
      })();
      expect(seen).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('really reports false for a session id nothing on this machine is running', () => {
    expect(scanPsForSession('no-such-session-11112222-3333-4444-5555-000000000000')).toBe(false);
  });

  it('resolvePidAlive falls back to the real ps scan when the row carries no pid at all — the known-stuck shape', async () => {
    expect(resolvePidAlive({}, { fullSessionId: 'no-such-session-11112222-3333-4444-5555-000000000001' })).toBe(false);
  });

  it('resolvePidAlive honours a real pid via the real kill(pid, 0) probe when one IS present', async () => {
    const dead = await reapedPid();
    const isPidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };
    expect(resolvePidAlive({ pid: process.pid }, { isPidAlive })).toBe(true);
    expect(resolvePidAlive({ pid: dead }, { isPidAlive })).toBe(false);
  });
});

describe('moveJobDirAside — a REAL directory tree, moved and verified for real', () => {
  it('really renames the job directory (contents included) into the real quarantine path', async () => withRealRepo(async ({ root }) => {
    const cfg = join(root, 'claude-config');
    const jobDir = join(jobsDir(cfg), 'realtest01');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(join(jobDir, 'state.json'), JSON.stringify({ state: 'blocked', detail: 'real fixture' }));
    writeFileSync(join(jobDir, 'timeline.jsonl'), '{"event":"spawn"}\n');

    const result = moveJobDirAside({ shortId: 'realtest01', jobDirPath: jobDir }, { cfgDir: cfg, now: () => 1234567890, listAgents: () => [] });

    expect(result.moved).toBe(true);
    expect(existsSync(jobDir)).toBe(false); // really gone from its original path
    expect(result.to).toBe(join(quarantineDir(cfg), 'realtest01-1234567890'));
    expect(existsSync(result.to)).toBe(true);
    // The REAL file contents travelled with the real rename, not just an empty directory.
    expect(JSON.parse(readFileSync(join(result.to, 'state.json'), 'utf8'))).toMatchObject({ state: 'blocked' });
    expect(readFileSync(join(result.to, 'timeline.jsonl'), 'utf8')).toContain('"event":"spawn"');
  }));

  it('a second real attempt against the now-moved source is idempotent, not an ENOENT throw', async () => withRealRepo(async ({ root }) => {
    const cfg = join(root, 'claude-config');
    const jobDir = join(jobsDir(cfg), 'realtest02');
    mkdirSync(jobDir, { recursive: true });

    const first = moveJobDirAside({ shortId: 'realtest02', jobDirPath: jobDir }, { cfgDir: cfg, now: () => 1, listAgents: () => [] });
    expect(first.moved).toBe(true);

    // Replay against the SAME (now-vanished) source path — the real fs call this guards is `renameSync` on a
    // path that no longer exists, which throws ENOENT unless this function's own existence check catches it.
    const second = moveJobDirAside({ shortId: 'realtest02', jobDirPath: jobDir }, { cfgDir: cfg, listAgents: () => [] });
    expect(second).toMatchObject({ moved: false, alreadyGone: true, to: first.to });
  }));
});
