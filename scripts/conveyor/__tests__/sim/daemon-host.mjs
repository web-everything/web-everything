#!/usr/bin/env node
/**
 * @file daemon-host.mjs — epic #3383 part 4 (Daemon hosts). A `child_process.fork`ed child, started with the
 * scenario's world `env` and `cwd` = the sim clone. It never uses the real daemons' own `runDaemonLoop`
 * sleep — the scenario runner (`scenario.mjs`) is the scheduler, driving one tick at a time over IPC.
 *
 * TWO SHAPES OF DAEMON, matched by `process.env.SIM_DAEMON_KIND`:
 *   - IN-PROCESS (`review`, `fix-dispatch`): the daemon module is dynamically imported FROM THE SIM CLONE
 *     (never from this lane), and its exported `buildCliDaemonEffects({owner, log})` is composed exactly the
 *     way each daemon's own `main()` composes it: `withSelfSync(withGithubAppAuth(buildCliDaemonEffects(...)),
 *     {root, onRestart, hasStaleRefusal})`. Every `log.error(...)` call either wrapper (or the daemon's own
 *     `onTick`/`onTickError`) makes is captured into this tick's `logs` array instead of reaching real stderr.
 *   - PASS-SCRIPT (`conflict-watch`, `lane-health`, `merge-sweep`, `lease-reaper`): spawns the real pass CLI as
 *     a child process once per tick, the way `skills-src/conveyor/pass-daemon.mjs#spawnPassOnce` does — but
 *     with stdout/stderr CAPTURED (not inherited) so its output becomes this tick's `logs` too.
 *
 * PROTOCOL (parent -> child): `{type:'tick'}` runs one tick; `{type:'shutdown'}` exits immediately.
 * PROTOCOL (child -> parent): `{type:'ready'}` once, after boot; then, per tick, either
 * `{type:'result', result, error, logs}` or — when the in-process daemon's own self-sync merged new commits
 * and would restart — `{type:'restart', info, logs}`, immediately followed by `process.exit(0)` (the scenario
 * runner lazily respawns this host on ITS next `tick <daemon>`, exactly like launchd's KeepAlive).
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const KIND = process.env.SIM_DAEMON_KIND;
const SIM_CLONE = process.env.SIM_CLONE_ROOT || process.cwd();

/** In-process daemons: repo-relative path to the daemon module (from the SIM CLONE), exporting
 *  `buildCliDaemonEffects` and `hasStaleMainRefusal`, exactly like `review-daemon.mjs`/
 *  `reconcile-fix-dispatch-daemon.mjs`'s own `main()` composes them. */
const IN_PROCESS_DAEMONS = Object.freeze({
  review: 'skills-src/conveyor/review-daemon.mjs',
  'fix-dispatch': 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs',
});

/** Pass-script daemons: the manifest args each one is actually launched with — mirrors
 *  `skills-src/conveyor/daemon-manifest.mjs`'s own WE entries (`conflict-watch`/`lane-health`), plus
 *  `merge-orphan-sweep`'s bare invocation and `lease-reaper`'s own (never in the manifest — mirrored here
 *  from `skills-src/conveyor/runner.mjs`'s `makeCliMechanicalPasses`, the one place that runs it today). */
const WE_SLUG = 'web-everything/web-everything';
const PASS_DAEMONS = Object.freeze({
  'conflict-watch': { script: 'scripts/conveyor/parked-pr-conflict-watch.mjs', args: ['sweep', `--repo=${WE_SLUG}`] },
  'lane-health': { script: 'scripts/conveyor/lane-pool-health-watch.mjs', args: [`--repo=${WE_SLUG}`] },
  'merge-sweep': { script: 'scripts/merge-ai-prs.mjs', args: [] },
  // One pass of the resident `/drain` watch (`merge-ai-prs.mjs --label=ready-to-merge --watch`), minus `--watch`
  // (the scenario runner is the loop). Unlike the bare `merge-sweep`, `--label` turns on the #2421 ci-lifecycle
  // label reconcile (`scripts/lib/reconcile-predicate.mjs#reconcileWouldRunFor`) — soak break
  // `ci-heal-loop-stale-label-review-gate`.
  drain: { script: 'scripts/merge-ai-prs.mjs', args: ['--label=ready-to-merge'] },
  'lease-reaper': { script: 'scripts/conveyor/lease-reaper.mjs', args: [] },
});

function send(msg) {
  if (typeof process.send === 'function') process.send(msg);
}

async function importFromClone(relPath) {
  return import(pathToFileURL(join(SIM_CLONE, relPath)).href);
}

/** JSON round-trip — the daemon's own result must be JSON-safe to cross the IPC boundary anyway; this also
 *  strips anything the daemon accidentally attached that IPC's structured clone would choke on. */
function jsonSafe(value) {
  try { return JSON.parse(JSON.stringify(value ?? null)); } catch { return null; }
}

async function bootInProcess(modulePath) {
  const daemonModule = await importFromClone(modulePath);
  const { withGithubAppAuth } = await importFromClone('scripts/lib/github-app-auth-env.mjs');
  const { withSelfSync } = await importFromClone('scripts/lib/daemon-self-sync.mjs');

  let logs = [];
  const line = (args) => args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
  const log = {
    error: (...a) => logs.push(line(a)),
    warn: (...a) => logs.push(line(a)),
    info: (...a) => logs.push(line(a)),
    log: (...a) => logs.push(line(a)),
  };

  let restartInfo = null;
  const onRestart = (info) => { restartInfo = info ?? {}; return { simRestart: true }; };

  const effects = withSelfSync(
    withGithubAppAuth(daemonModule.buildCliDaemonEffects({ owner: `sim-${KIND}`, log }), { log }),
    // #4044: `entries` = the daemon's own script, exactly what `process.argv[1]` is in production (here argv[1]
    // is this host), so the restart gate walks the real daemon's import closure.
    // x44lnnt: pin the INLINE rebuild path (`background: null`) — the shipped settings file turns background builds
    // on for the fix-dispatch daemon, which skips the same-tick stale-main restart (I-18) these scenarios assert,
    // and its tick-progress store would write real daemon state. A no-op store keeps the host hermetic.
    {
      root: SIM_CLONE, onRestart, hasStaleRefusal: daemonModule.hasStaleMainRefusal, log, entries: [join(SIM_CLONE, modulePath)],
      background: null,
      tickProgress: { read: () => null, markSeen() {}, markTickDone() {}, alert() {} },
    },
  );

  let tickCount = 0;
  return async function tick() {
    restartInfo = null;
    logs = [];
    let result = null;
    let error = null;
    try {
      result = await effects.tickOnce();
    } catch (e) {
      error = String((e && e.message) || e);
    }
    if (restartInfo) return { restart: true, info: restartInfo, logs };
    // A logging callback throwing must never hide the real tick outcome — but it must never be SWALLOWED either:
    // in production `runDaemonLoop` routes an `onTick` throw into `onTickError`, so a tick whose result shape
    // the daemon's own `onTick` cannot log (live 2026-09-25: a skipped tick crashing on `undefined.map`) is a
    // real, recurring failure. Reported as `onTickError` so the soak harness's no-onTick-crash invariant sees it.
    let onTickError = null;
    try {
      if (error) effects.onTickError?.(new Error(error), tickCount);
      else effects.onTick?.(result, tickCount);
    } catch (e) {
      onTickError = String((e && e.message) || e);
    }
    tickCount += 1;
    return { restart: false, result: jsonSafe(result), error, onTickError, logs };
  };
}

function bootPass({ script, args }) {
  return async function tick() {
    const res = spawnSync(process.execPath, [join(SIM_CLONE, script), ...args], {
      cwd: SIM_CLONE, env: process.env, encoding: 'utf8', timeout: 60_000,
    });
    const logs = [
      ...(res.stdout ? res.stdout.split('\n').filter(Boolean) : []),
      ...(res.stderr ? res.stderr.split('\n').filter(Boolean) : []),
    ];
    return {
      restart: false,
      result: { code: res.status ?? null, signal: res.signal ?? null },
      error: res.error ? String(res.error.message || res.error) : null,
      logs,
    };
  };
}

async function main() {
  if (!KIND) {
    console.error('daemon-host: SIM_DAEMON_KIND is not set');
    process.exitCode = 1;
    return;
  }
  let tick;
  if (Object.prototype.hasOwnProperty.call(IN_PROCESS_DAEMONS, KIND)) {
    tick = await bootInProcess(IN_PROCESS_DAEMONS[KIND]);
  } else if (Object.prototype.hasOwnProperty.call(PASS_DAEMONS, KIND)) {
    tick = bootPass(PASS_DAEMONS[KIND]);
  } else {
    console.error(`daemon-host: unknown SIM_DAEMON_KIND ${JSON.stringify(KIND)}`);
    process.exitCode = 1;
    return;
  }

  process.on('message', async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'shutdown') { process.exit(0); return; }
    if (msg.type !== 'tick') return;
    try {
      globalThis.__simClock?.reload();
      const out = await tick();
      if (out.restart) {
        send({ type: 'restart', info: out.info ?? null, logs: out.logs ?? [] });
        process.exit(0);
        return;
      }
      send({ type: 'result', result: out.result ?? null, error: out.error ?? null, onTickError: out.onTickError ?? null, logs: out.logs ?? [] });
    } catch (e) {
      send({ type: 'result', result: null, error: String((e && e.message) || e), logs: [] });
    }
  });

  send({ type: 'ready' });
}

main().catch((e) => {
  console.error(`daemon-host: fatal: ${String((e && e.message) || e)}`);
  process.exitCode = 1;
});
