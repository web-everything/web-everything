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
import * as nodeFs from 'node:fs';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  if (!cmd) return null;
  const named = argv.slice(0, at).find((word) => word.startsWith('--daemon='));
  const daemon = named ? named.slice('--daemon='.length) : '';
  return daemon ? { cmd, args, daemon } : { cmd, args };
}

/**
 * Cleanup identity: explicit gate name, else script/command basename plus daemon role arguments.
 * Node option operands are not scripts. Unknown Node syntax requires an explicit gate name.
 */
export function daemonIdentity(parsed) {
  if (parsed.daemon) return parsed.daemon;
  let scriptIndex = -1;
  if (/^node(?:js|\.exe)?$/.test(basename(parsed.cmd))) {
    // Keep arity explicit: silently skipping an unknown flag could select its value as the script.
    const takesValue = new Set([
      '--import', '--require', '-r', '--loader', '--experimental-loader',
      '--experimental-default-type', '--experimental-policy', '--conditions', '-C',
      '--icu-data-dir', '--openssl-config', '--redirect-warnings', '--diagnostic-dir',
      '--title', '--unhandled-rejections', '--dns-result-order', '--disable-proto',
      '--disable-warning', '--max-old-space-size', '--max-semi-space-size', '--stack-trace-limit',
      '--stack-size', '--max-http-header-size', '--inspect-port', '--debug-port',
      '--inspect-publish-uid', '--heapsnapshot-signal', '--heapsnapshot-near-heap-limit',
      '--cpu-prof-dir', '--cpu-prof-name', '--cpu-prof-interval',
      '--heap-prof-dir', '--heap-prof-name', '--heap-prof-interval',
      '--report-dir', '--report-directory', '--report-filename', '--report-signal',
      '--trace-event-categories', '--trace-event-file-pattern', '--tls-cipher-list', '--tls-keylog',
    ]);
    const flags = new Set([
      '--no-warnings', '--no-deprecation', '--trace-warnings', '--trace-deprecation',
      '--throw-deprecation', '--pending-deprecation', '--enable-source-maps', '--no-enable-source-maps',
      '--preserve-symlinks', '--preserve-symlinks-main', '--inspect', '--inspect-brk', '--inspect-wait',
      '--experimental-vm-modules', '--experimental-wasm-modules', '--experimental-network-imports',
      '--experimental-import-meta-resolve', '--experimental-detect-module', '--experimental-require-module',
      '--no-experimental-fetch', '--no-experimental-require-module', '--no-addons',
      '--abort-on-uncaught-exception', '--trace-uncaught', '--trace-sync-io', '--trace-exit',
      '--use-openssl-ca', '--use-bundled-ca', '--openssl-legacy-provider', '--openssl-shared-config',
      '--enable-fips', '--force-fips', '--zero-fill-buffers', '--jitless', '--prof', '--cpu-prof', '--heap-prof',
    ]);
    for (let i = 0; i < parsed.args.length; i += 1) {
      const word = parsed.args[i];
      if (word === '--') { scriptIndex = i + 1; break; }
      if (!word.startsWith('-')) { scriptIndex = i; break; }
      const equal = word.indexOf('=');
      const option = equal === -1 ? word : word.slice(0, equal);
      if (!takesValue.has(option) && !flags.has(option)) {
        throw new Error('cannot infer daemon script from Node options; set gate --daemon=<name>');
      }
      if (takesValue.has(option)) {
        const value = equal === -1 ? parsed.args[++i] : word.slice(equal + 1);
        if (!value || value.startsWith('-')) throw new Error('missing Node option operand');
      }
    }
    const script = parsed.args[scriptIndex];
    if (!script || script === '-' || script === 'inspect' || script.startsWith('-')) {
      throw new Error('cannot infer daemon script; set gate --daemon=<name>');
    }
  } else {
    // Preserve support for non-Node commands/interpreters.
    scriptIndex = parsed.args.findIndex((word) => !word.startsWith('-') && /\.(?:[cm]?js|ts)$/.test(word));
  }
  const name = basename(scriptIndex < 0 ? parsed.cmd : parsed.args[scriptIndex]);
  const roles = parsed.args.slice(scriptIndex + 1)
    .filter((word) => /^--(?:pass|daemon)=/.test(word))
    .map((word) => encodeURIComponent(word.slice(word.indexOf('=') + 1)));
  // Escape separators only when composing a role key; keep existing unqualified marker keys intact.
  return roles.length ? [encodeURIComponent(name), ...roles].join('#') : name;
}

const describeOwner = (reason) => {
  if (reason === 'owner-unset') return 'unset';
  if (reason === 'owner-is-other-host') return 'other';
  if (reason === 'fresh-owner-is-this-host') return 'self';
  return 'unreadable';
};

// Stable across wrapper restarts, checkouts and flag changes: one marker and lock per daemon identity.
function defaultMarkerPath(parsed) {
  const key = createHash('sha256').update(JSON.stringify([daemonIdentity(parsed)])).digest('hex');
  return join(homedir(), '.web-everything', 'daemon-host-gate', `${key}.json`);
}

function cleanupMarker(markerPath, fs, killGroup) {
  return {
    lock() {
      fs.mkdirSync(dirname(markerPath), { recursive: true });
      // Hold through reservation, spawning and cleanup. Never reclaim a lock
      // automatically: a crashed holder needs operator inspection, not a race.
      fs.mkdirSync(`${markerPath}.lock`, { mode: 0o700 });
    },
    unlock() { fs.rmdirSync(`${markerPath}.lock`); },
    check() {
      let raw;
      try { raw = fs.readFileSync(markerPath, 'utf8'); }
      catch (error) { if (error?.code === 'ENOENT') return; throw error; }
      const marker = JSON.parse(raw);
      if (!Number.isSafeInteger(marker?.pgid) || marker.pgid <= 0
          || !Number.isSafeInteger(marker.time) || marker.time < 0) {
        throw new Error('invalid or incomplete cleanup marker');
      }
      try { killGroup(marker.pgid, 0); }
      catch (error) {
        if (error?.code !== 'ESRCH') throw error;
        fs.unlinkSync(markerPath);
        return;
      }
      throw new Error(`process group ${marker.pgid} from ${marker.time} is not confirmed dead`);
    },
    claim() {
      fs.mkdirSync(dirname(markerPath), { recursive: true });
      // Reserve before spawning: failed writes/crashes must leave blocking evidence.
      fs.writeFileSync(markerPath, JSON.stringify({ pgid: null, time: Date.now() }), { flag: 'wx', mode: 0o600 });
    },
    track(pgid) {
      fs.writeFileSync(markerPath, JSON.stringify({ pgid, time: Date.now() }));
    },
    clear() { fs.unlinkSync(markerPath); },
  };
}

function startChild({ cmd, args }, { spawn, killGroup, processSignals, sleep, killGraceMs, log, marker }) {
  let child;
  let finish;
  let ended = false;
  let stopping = false;
  let cleanupFailed = false;
  let revoking = false; // set by the wrapper before it stops the child for revocation
  let completedCode = null; // the command's own exit code, recorded when it ends without a wrapper stop
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
    // Record completion before anything else (including any later ownership read) can discard it.
    if (!revoking && !stopping) completedCode = code;
    // The leader can exit before workers (including on a natural exit). Do not
    // cancel escalation and release the gate while its process group can run.
    stop('SIGKILL');
    ended = true;
    grace.abort();
    for (const [sig, fn] of handlers) processSignals.removeListener(sig, fn);
    processSignals.removeListener('exit', onExit);
    void confirmGroupDeath().then((dead) => {
      if (dead) marker.clear();
      cleanupFailed = !dead;
      finish(dead ? code : 1);
    }).catch(() => {
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
    if (child.pid) marker.track(child.pid);
  } catch { end(127); }
  return {
    done, stop,
    revoke() { revoking = true; },
    get completedCode() { return completedCode; },
    get cleanupFailed() { return cleanupFailed; },
  };
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
    // The command may have completed while the ownership read was in flight (or the read failed afterwards):
    // report its recorded exit code and never run it again.
    if (child.completedCode !== null) return await child.done;
    if (now.active) continue;
    const owner = now.owner;
    child.revoke();
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
 * The persistent marker blocks restarts until ESRCH; invalid/unreadable state
 * requires operator inspection of the marker and process group before removal.
 * A sibling .lock directory serializes wrappers for their entire lifetime;
 * an abandoned lock also requires operator inspection before removal.
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
    markerPath: suppliedMarkerPath,
    markerFs = nodeFs,
  } = deps;
  let markerPath;
  try { markerPath = suppliedMarkerPath ?? defaultMarkerPath(parsed); }
  catch (error) {
    log(`host-gate: ${error.message}; refusing to spawn`);
    return 1;
  }
  const marker = cleanupMarker(markerPath, markerFs, killGroup);
  try { marker.lock(); }
  catch (error) {
    log(`host-gate: cleanup lock ${markerPath}.lock: ${error.message}; refusing to spawn, operator cleanup required`);
    return 1;
  }
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
    try { marker.check(); }
    catch (error) {
      log(`host-gate: cleanup marker ${markerPath}: ${error.message}; refusing to spawn, operator cleanup required`);
      return 1;
    }
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
      try { marker.claim(); }
      catch (error) {
        log(`host-gate: cannot reserve cleanup marker ${markerPath}: ${error.message}; refusing to spawn, operator cleanup required`);
        return 1;
      }
      const child = startChild(parsed, { spawn, killGroup, processSignals, sleep, killGraceMs, log, marker });
      const code = await watchChild(child, { thisHost, source, watchSleep, sleep, killGraceMs, log });
      // Revocation discards the exit code, but must not discard wrapper shutdown.
      if (shutdownCode !== null) return await child.done;
      if (code !== null) return code;
    }
    return shutdownCode ?? 75;
  } finally {
    for (const [sig, fn] of handlers) processSignals.removeListener(sig, fn);
    try { marker.unlock(); }
    catch (error) {
      log(`host-gate: cannot release cleanup lock ${markerPath}.lock: ${error.message}; exiting 1, operator cleanup required`);
      return 1;
    }
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
  // Match the resolved AND the unresolved form: with --preserve-symlinks-main the module URL keeps the symlink
  // path while argv[1] may resolve (or the reverse). Comparing real paths of both sides covers every mix, so a
  // symlinked entrypoint always runs main instead of silently exiting 0.
  if (importUrl === pathToFileURL(argv1).href) return true;
  try {
    const real = realpath(argv1);
    if (importUrl === pathToFileURL(real).href) return true;
    return realpath(fileURLToPath(importUrl)) === real;
  } catch { return false; }
}

if (isEntrypoint(import.meta.url, process.argv[1])) main();
