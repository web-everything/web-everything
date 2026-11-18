#!/usr/bin/env node
/**
 * Host gate for a daemon command, wrapped from the outside (no daemon edit):
 *
 *   node scripts/operations/daemon-host-gate.mjs -- <daemon command> [args...]
 *
 * Stays in standby (one fresh owner read per 60 s, alive so launchd KeepAlive
 * does not respawn it) until the owner record names THIS host, then runs the
 * command with inherited stdio, forwards signals, and exits with its code.
 * Fail closed: unset, unreadable, rate-limited or invalid owner = standby.
 *
 * The CLI always reads ownership from the shared GitHub daemon-host-owner branch.
 * Any non-active poll also revokes a running daemon immediately.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setTimeout as timerSleep } from 'node:timers/promises';
import { getThisHost, resolveHostRole } from '../lib/daemon-host-guard.mjs';

export const POLL_MS = 60_000;
const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];
const SIGNUM = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9, SIGQUIT: 3 };
const GROUP_PROBE_MS = 100;
const GROUP_DEATH_TIMEOUT_MS = 30_000;
export function parseGateArgs(argv) {
  const at = argv.indexOf('--');
  if (at === -1) return null;
  const [cmd, ...args] = argv.slice(at + 1);
  return cmd ? { cmd, args } : null;
}

const describeOwner = (reason) => {
  if (reason === 'owner-unset') return 'unset';
  if (reason === 'owner-is-other-host') return 'other';
  if (reason === 'fresh-owner-is-this-host') return 'self';
  return 'unreadable';
};

function startChild({ cmd, args }, { spawn, killGroup, processSignals, sleep, killGraceMs, log }) {
  let child;
  let finish;
  let ended = false;
  let stopping = false;
  let cleanupFailed = false;
  const grace = new AbortController();
  const done = new Promise((resolve) => { finish = resolve; });
  const stop = (sig) => {
    if (!ended && child?.pid) {
      try { killGroup(child.pid, sig); } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }
  };
  const handlers = SIGNALS.map((sig) => {
    const fn = () => {
      const first = !stopping;
      stopping = true;
      stop(sig);
      if (first && !ended) {
        void sleep(killGraceMs, { signal: grace.signal }).then(() => {
          stop('SIGKILL'); // done still waits for the child's exit event.
        }, (error) => { if (error?.name !== 'AbortError') stop('SIGKILL'); });
      }
    };
    processSignals.on(sig, fn);
    return [sig, fn];
  });
  const onExit = () => stop('SIGKILL');
  processSignals.on('exit', onExit);
  const confirmGroupDeath = async () => {
    if (!child?.pid) return true;
    for (let waited = 0; ; waited += GROUP_PROBE_MS) {
      try { killGroup(child.pid, 0); } catch (error) {
        if (error?.code === 'ESRCH') return true;
        log(`host-gate: process group ${child.pid} death probe failed (${error?.code ?? 'unknown'}); exiting 1, operator cleanup required`);
        return false;
      }
      if (waited >= GROUP_DEATH_TIMEOUT_MS) {
        log(`host-gate: process group ${child.pid} still alive after ${GROUP_DEATH_TIMEOUT_MS} ms; exiting 1, operator cleanup required`);
        return false;
      }
      await sleep(GROUP_PROBE_MS);
    }
  };
  const end = (code) => {
    if (ended) return;
    // The leader can exit before workers (including on a natural exit). Do not
    // cancel escalation and release the gate while its process group can run.
    stop('SIGKILL');
    ended = true;
    grace.abort();
    for (const [sig, fn] of handlers) processSignals.removeListener(sig, fn);
    processSignals.removeListener('exit', onExit);
    void confirmGroupDeath().then((dead) => {
      cleanupFailed = !dead;
      finish(dead ? code : 1);
    }, () => {
      cleanupFailed = true;
      log(`host-gate: process group death confirmation failed; exiting 1, operator cleanup required`);
      finish(1);
    });
  };
  try {
    child = spawn(cmd, args, { stdio: 'inherit', detached: true });
    // A failed spawn has no exit event; errors on a live child must not release it.
    child.on('error', () => { if (!child.pid) end(127); });
    child.on('exit', (code, signal) => end(signal ? 128 + (SIGNUM[signal] ?? 15) : (code ?? 1)));
  } catch { end(127); }
  return { done, stop, get cleanupFailed() { return cleanupFailed; } };
}

async function pollRole(thisHost, source) {
  const result = await resolveHostRole({ thisHost, source });
  return { active: result.role === 'active', owner: describeOwner(result.reason) };
}

/** Watch a running child; returns its exit code, or null when the owner revoked it. */
async function watchChild(child, ctx) {
  const { thisHost, source, watchSleep, sleep, killGraceMs, log } = ctx;
  let revoked = false;
  while (!revoked) {
    const winner = await Promise.race([
      child.done.then((code) => ({ code })),
      watchSleep(POLL_MS).then(() => null),
    ]);
    if (winner) return winner.code;
    const now = await pollRole(thisHost, source);
    if (now.active) continue;
    const owner = now.owner;
    revoked = true;
    log(`host-gate: owner=${owner} self=${thisHost}; stopping daemon, back to standby`);
  }
  child.stop('SIGTERM');
  const exited = await Promise.race([child.done.then(() => true), sleep(killGraceMs).then(() => false)]);
  if (!exited) child.stop('SIGKILL');
  const code = await child.done;
  return child.cleanupFailed ? code : null;
}

/**
 * Resolves to the daemon's exit code, or 75 after maxPolls standby polls (tests only).
 * While the child runs the owner is re-read every poll: any non-active result
 * (other, unset, unreadable or invalid input) immediately stops the daemon process group
 * (SIGTERM, then SIGKILL after killGraceMs) and returns the gate to standby.
 * A leader exit also kills any remaining group members before releasing the gate.
 * Release requires ESRCH from a group probe; unconfirmed death exits 1 after 30 s.
 */
export async function runGate(parsed, deps = {}) {
  const {
    thisHost = getThisHost(),
    log = (line) => console.log(line),
    sleep = (ms, { signal } = {}) => timerSleep(ms, undefined, { signal }),
    watchSleep = sleep,
    source,
    spawn = nodeSpawn,
    killGroup = (pid, signal) => process.kill(-pid, signal),
    processSignals = process,
    maxPolls = Infinity,
    killGraceMs = 30_000,
  } = deps;
  let shutdownCode = null;
  const shutdown = new AbortController();
  const handlers = SIGNALS.map((sig) => {
    const fn = () => {
      shutdownCode ??= 128 + SIGNUM[sig];
      shutdown.abort();
    };
    processSignals.on(sig, fn);
    return [sig, fn];
  });
  try {
    for (let poll = 0; poll < maxPolls; poll += 1) {
      if (shutdownCode !== null) return shutdownCode;
      const { active, owner } = await pollRole(thisHost, source);
      if (shutdownCode !== null) return shutdownCode;
      if (!active) {
        log(`host-gate: standby owner=${owner} self=${thisHost}`);
        if (shutdownCode !== null) return shutdownCode;
        try { await sleep(POLL_MS, { signal: shutdown.signal }); }
        catch (error) { if (shutdownCode === null) throw error; }
        continue;
      }
      log(`host-gate: active owner=${owner} self=${thisHost}`);
      if (shutdownCode !== null) return shutdownCode;
      const child = startChild(parsed, { spawn, killGroup, processSignals, sleep, killGraceMs, log });
      const code = await watchChild(child, { thisHost, source, watchSleep, sleep, killGraceMs, log });
      // Revocation discards the exit code, but must not discard wrapper shutdown.
      if (shutdownCode !== null) return await child.done;
      if (code !== null) return code;
    }
    return shutdownCode ?? 75;
  } finally {
    for (const [sig, fn] of handlers) processSignals.removeListener(sig, fn);
  }
}

async function main() {
  const parsed = parseGateArgs(process.argv.slice(2));
  if (!parsed) {
    console.error('usage: daemon-host-gate.mjs -- <command> [args...]');
    process.exit(2);
  }
  process.exit(await runGate(parsed));
}

/** Symlinked paths (macOS /tmp -> /private/tmp) must still count as the entrypoint. */
export function isEntrypoint(importUrl, argv1, realpath = realpathSync) {
  if (!argv1) return false;
  try { return importUrl === pathToFileURL(realpath(argv1)).href; } catch { return importUrl === pathToFileURL(argv1).href; }
}

if (isEntrypoint(import.meta.url, process.argv[1])) main();
