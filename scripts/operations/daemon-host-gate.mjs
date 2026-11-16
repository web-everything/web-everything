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
 * Test-only override: WE_DAEMON_HOST_OWNER_FILE=<file> reads the owner from a
 * local file instead of the shared daemon-host-owner branch (the real cache
 * is never written by this wrapper).
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
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

function runChild({ cmd, args }, { spawn, processSignals }) {
  return new Promise((resolve) => {
    let child;
    const handlers = SIGNALS.map((sig) => {
      const fn = () => { try { child?.kill(sig); } catch { /* child already gone */ } };
      processSignals.on(sig, fn);
      return [sig, fn];
    });
    const done = (code) => {
      for (const [sig, fn] of handlers) processSignals.removeListener(sig, fn);
      resolve(code);
    };
    try {
      child = spawn(cmd, args, { stdio: 'inherit' });
    } catch { done(127); return; }
    child.on('error', () => done(127));
    child.on('exit', (code, signal) => {
      if (signal) done(128 + (SIGNUM[signal] ?? 15));
      else done(code ?? 1);
    });
  });
}

/** Resolves to the daemon's exit code, or 75 after maxPolls standby polls (tests only). */
export async function runGate(parsed, deps = {}) {
  const {
    thisHost = getThisHost(),
    log = (line) => console.log(line),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    readRemote = readOwnerRemote,
    spawn = nodeSpawn,
    processSignals = process,
    maxPolls = Infinity,
  } = deps;
  for (let poll = 0; poll < maxPolls; poll += 1) {
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
    if (role?.role === 'active' && validHost(thisHost)) {
      log(`host-gate: active owner=${describeOwner(last)} self=${thisHost}`);
      return runChild(parsed, { spawn, processSignals });
    }
    log(`host-gate: standby owner=${describeOwner(last)} self=${thisHost}`);
    await sleep(POLL_MS);
  }
  return 75;
}

async function main() {
  const parsed = parseGateArgs(process.argv.slice(2));
  if (!parsed) {
    console.error('usage: daemon-host-gate.mjs -- <command> [args...]');
    process.exit(2);
  }
  const file = process.env.WE_DAEMON_HOST_OWNER_FILE;
  const deps = file ? { readRemote: makeFileOwnerReader(file) } : {};
  process.exit(await runGate(parsed, deps));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
