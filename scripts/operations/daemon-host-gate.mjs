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
 * Test-only override: WE_DAEMON_HOST_OWNER_FILE=<file> (plus WE_DAEMON_HOST_GATE_TEST_ONLY=1,
 * else the wrapper refuses to start) reads the owner from a
 * local file instead of the shared daemon-host-owner branch (the real cache
 * is never written by this wrapper).
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setTimeout as timerSleep } from 'node:timers/promises';
import { getThisHost, resolveHostRole, readOwnerRemote } from '../lib/daemon-host-guard.mjs';

export const POLL_MS = 60_000;
const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];
const SIGNUM = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9, SIGQUIT: 3 };
const validHost = (v) => typeof v === 'string' && v.length <= 253 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v);

export function parseGateArgs(argv) {
  const at = argv.indexOf('--');
  if (at === -1) return null;
  const [cmd, ...args] = argv.slice(at + 1);
  return cmd ? { cmd, args } : null;
}

/** Test-only owner source: a local file holding the owner host name. */
export function makeFileOwnerReader(path, { readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  return async () => {
    try {
      const owner = String(readFile(path)).trim();
      if (!owner) return { status: 'unset' };
      if (!validHost(owner)) return { status: 'error', error: 'invalid owner host' };
      return { status: 'ok', owner };
    } catch (error) {
      return { status: 'error', error: String(error?.message ?? error) };
    }
  };
}

const describeOwner = (r) => {
  if (r?.status === 'unset') return 'unset';
  if (r?.status === 'ok' && validHost(r.owner)) return r.owner;
  return 'unreadable';
};

function startChild({ cmd, args }, { spawn, processSignals, sleep, killGraceMs }) {
  let child;
  let finish;
  let ended = false;
  let stopping = false;
  const grace = new AbortController();
  const done = new Promise((resolve) => { finish = resolve; });
  const stop = (sig) => {
    if (!ended) { try { child?.kill(sig); } catch { /* child already gone */ } }
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
  const end = (code) => {
    if (ended) return;
    ended = true;
    grace.abort();
    for (const [sig, fn] of handlers) processSignals.removeListener(sig, fn);
    processSignals.removeListener('exit', onExit);
    finish(code);
  };
  try {
    child = spawn(cmd, args, { stdio: 'inherit' });
    // A failed spawn has no exit event; errors on a live child must not release it.
    child.on('error', () => { if (!child.pid) end(127); });
    child.on('exit', (code, signal) => end(signal ? 128 + (SIGNUM[signal] ?? 15) : (code ?? 1)));
  } catch { end(127); }
  return { done, stop };
}

export const UNREADABLE_LIMIT_MS = 600_000;

async function pollRole(thisHost, readRemote) {
  let last = null;
  let role = { role: 'standby' };
  try {
    role = await resolveHostRole({
      thisHost, atStart: true,
      readCache: () => { throw new Error('gate never trusts the cache'); },
      writeCache: () => {},
      readRemote: async () => { last = await readRemote(); return last; },
    });
  } catch { role = { role: 'standby' }; }
  return { active: role?.role === 'active' && validHost(thisHost), last };
}

/** Watch a running child; returns its exit code, or null when the owner revoked it. */
async function watchChild(child, ctx) {
  const { thisHost, readRemote, watchSleep, sleep, killGraceMs, log, now: clock } = ctx;
  let lastGoodAt = clock();
  let revoked = false;
  while (!revoked) {
    const winner = await Promise.race([
      child.done.then((code) => ({ code })),
      watchSleep(POLL_MS).then(() => null),
    ]);
    if (winner) return winner.code;
    const now = await pollRole(thisHost, readRemote);
    if (now.active) { lastGoodAt = clock(); continue; }
    const owner = describeOwner(now.last);
    if (owner === 'unreadable' && clock() - lastGoodAt < UNREADABLE_LIMIT_MS) continue;
    revoked = true;
    log(`host-gate: owner=${owner} self=${thisHost}; stopping daemon, back to standby`);
  }
  child.stop('SIGTERM');
  const exited = await Promise.race([child.done.then(() => true), sleep(killGraceMs).then(() => false)]);
  if (!exited) { child.stop('SIGKILL'); await child.done; }
  return null;
}

/**
 * Resolves to the daemon's exit code, or 75 after maxPolls standby polls (tests only).
 * While the child runs the owner is re-read every poll: a definitive other/unset owner,
 * or 600 s (wall clock) without a good read, stops the child (SIGTERM,
 * then SIGKILL after killGraceMs) and returns the gate to standby.
 */
export async function runGate(parsed, deps = {}) {
  const {
    thisHost = getThisHost(),
    log = (line) => console.log(line),
    sleep = (ms, { signal } = {}) => timerSleep(ms, undefined, { signal }),
    watchSleep = sleep,
    readRemote = readOwnerRemote,
    spawn = nodeSpawn,
    processSignals = process,
    maxPolls = Infinity,
    killGraceMs = 30_000,
    now = Date.now,
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
      const { active, last } = await pollRole(thisHost, readRemote);
      if (shutdownCode !== null) return shutdownCode;
      if (!active) {
        log(`host-gate: standby owner=${describeOwner(last)} self=${thisHost}`);
        if (shutdownCode !== null) return shutdownCode;
        try { await sleep(POLL_MS, { signal: shutdown.signal }); }
        catch (error) { if (shutdownCode === null) throw error; }
        continue;
      }
      log(`host-gate: active owner=${describeOwner(last)} self=${thisHost}`);
      if (shutdownCode !== null) return shutdownCode;
      const child = startChild(parsed, { spawn, processSignals, sleep, killGraceMs });
      const code = await watchChild(child, { thisHost, readRemote, watchSleep, sleep, killGraceMs, log, now });
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
  const file = process.env.WE_DAEMON_HOST_OWNER_FILE;
  if (file && process.env.WE_DAEMON_HOST_GATE_TEST_ONLY !== '1') {
    console.error('host-gate: WE_DAEMON_HOST_OWNER_FILE needs WE_DAEMON_HOST_GATE_TEST_ONLY=1; refusing to start');
    process.exit(2);
  }
  const deps = file ? { readRemote: makeFileOwnerReader(file) } : {};
  process.exit(await runGate(parsed, deps));
}

/** Symlinked paths (macOS /tmp -> /private/tmp) must still count as the entrypoint. */
export function isEntrypoint(importUrl, argv1, realpath = realpathSync) {
  if (!argv1) return false;
  try { return importUrl === pathToFileURL(realpath(argv1)).href; } catch { return importUrl === pathToFileURL(argv1).href; }
}

if (isEntrypoint(import.meta.url, process.argv[1])) main();
