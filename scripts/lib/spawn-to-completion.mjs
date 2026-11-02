/**
 * @file scripts/lib/spawn-to-completion.mjs
 * @description #3383 mechanical-dispatcher follow-up — the async replacement for the dispatch wrappers'
 * blocking `execFileSync` agent spawn.
 *
 * THE BUG THIS WAS SUPPOSED TO FIX, AND THE HONEST FINDING THAT NARROWED IT. `telemetry-store.mjs
 * #cpuUsageDeltaMs`'s own header (landed alongside the per-process telemetry pass) documented, correctly, that
 * `process.cpuUsage()` sampled around a wrapper's blocking spawn measures the WRAPPER's own CPU time, not the
 * spawned agent's — because every dispatch wrapper spawned its agent via `execFileSync`, and `execFileSync`'s
 * return value carries no child rusage at all. The follow-up brief for this file assumed the fix was
 * `ChildProcess#resourceUsage()` — an async-`spawn()`-only method, read after `'exit'`, giving the real
 * `getrusage(2)` figures for the child. THAT METHOD DOES NOT EXIST. Verified three independent ways before
 * writing a line of the fix: (1) `Object.getOwnPropertyNames(require('node:child_process').ChildProcess
 * .prototype)` on Node v18.2.0 AND v22.1.0 lists exactly `constructor/spawn/kill/[Symbol.dispose]/ref/unref` —
 * no `resourceUsage`; (2) the same absence holds for a `fork()`-created (IPC-channel) subprocess, not just a
 * plain `spawn()`; (3) `@types/node`'s `process.d.ts` declares `resourceUsage(): ResourceUsage` on `process`
 * itself (the CURRENT process) and `child_process.d.ts` declares no such member on `ChildProcess` at all. The
 * brief's premise conflated `process.resourceUsage()` (real, but answers "how much CPU has THIS process used",
 * never a child's) with an imagined per-child equivalent.
 *
 * WHAT THIS MODULE ACTUALLY DOES, GIVEN THAT. It is still a genuine, worthwhile conversion: `execFileSync`
 * blocks the WHOLE Node event loop (not just the calling call stack) for the entire child lifetime, forces the
 * sync exec family's own internal buffering, and gives a caller no way to react to partial output as it
 * arrives; this async, streaming, `child_process.spawn()`-based rewrite fixes all three while preserving
 * `execFileSync`'s observable contract byte-for-byte (see below) — so the wrapper's OWN caller sees no
 * behavior change beyond "await this instead of calling it synchronously". What it does NOT do, contrary to
 * the original ask: give a REAL per-agent CPU number. `resourceUsage` in the shape below is kept ONLY as a
 * forward-compatible, defensive read (`typeof child.resourceUsage === 'function'`) — harmless, and ready to
 * start working for free if some future Node version, or an injected non-standard `spawnFn`, ever supplies a
 * real per-child rusage reading — but on today's real Node it is ALWAYS `null`. `telemetry-store.mjs
 * #resolveTurnCpuAttributes` already treats that honestly: it falls back to the ORIGINAL wrapper-only
 * `process.cpuUsage()` delta, tagged `cpuSource: 'wrapper'`, rather than fabricating a number. The genuinely
 * reliable per-agent-cost signal remains what the prior #3383 landing already built for exactly this reason:
 * `host-process-sample.mjs`'s external, `ps`-based sampling of the live dispatched child from OUTSIDE the
 * wrapper process.
 *
 * THE CONTRACT, REPLICATED FROM `execFileSync` POINT BY POINT (so a caller written against `execFileSync`'s
 * shape needs to change nothing but adding `await`):
 *  - clean exit (code 0) → resolves `{stdout, stderr, resourceUsage}` (strings, decoded per `opts.encoding`,
 *    default `'utf8'` — matching `execFileSync`'s own encoding-driven string return; `resourceUsage` is
 *    `null` in practice — see above).
 *  - non-zero exit → REJECTS an `Error` shaped exactly like `execFileSync`'s own throw: `.status` (the exit
 *    code), `.stdout`, `.stderr` — plus a `.resourceUsage` field, kept for the same forward-compatibility
 *    reason and equally `null` today.
 *  - killed by signal (an external kill, or this module's own `timeout`/`maxBuffer` guards below) → rejects an
 *    `Error` with `.status = null`, `.signal` (the signal name), `.killed = true`, and the SAME
 *    `.stdout`/`.stderr` a partially-drained child leaves behind — the shape `execFileSync` gives a timed-out
 *    call.
 *  - `opts.timeout` (ms) — fires `child.kill(opts.killSignal ?? 'SIGKILL')` exactly like `execFileSync`'s own
 *    `timeout`/`killSignal` pair. `0`/unset disables it, matching `execFileSync`'s own default.
 *  - `opts.maxBuffer` (bytes, default 8MB — same default `execFileSync`'s docs state) is enforced BY HAND here,
 *    because async `spawn()` streams instead of buffering internally the way the sync family does: once either
 *    stream crosses it, the child is killed and the rejection carries whatever was captured up to that point —
 *    the same "your child talked too much" failure `execFileSync` throws, never an unbounded in-memory grow.
 *  - a spawn-level failure (`ENOENT`, a permission error) → rejects the `'error'` event's own `Error` untouched,
 *    the same class of error `execFileSync` throws for the identical condition.
 *
 * @param {string} cmd
 * @param {string[]} argv
 * @param {{encoding?: string, maxBuffer?: number, timeout?: number, killSignal?: string, [k: string]: unknown}} [opts]
 * @param {{spawnFn?: Function}} [io] - injectable ONLY for tests; real callers never pass it.
 * @returns {Promise<{stdout: string, stderr: string, resourceUsage: object|null}>}
 */
import { spawn } from 'node:child_process';

export function spawnToCompletion(cmd, argv, opts = {}, { spawnFn = spawn } = {}) {
  const {
    encoding = 'utf8', maxBuffer = 8 * 1024 * 1024, timeout = 0, killSignal = 'SIGKILL', ...spawnOpts
  } = opts;

  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    try {
      child = spawnFn(cmd, argv, spawnOpts);
    } catch (e) {
      reject(e);
      return;
    }

    let stdoutChunks = [];
    let stderrChunks = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let overBuffer = false;
    let timedOut = false;
    let exited = false;
    let timer = null;

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    const killChild = (signal) => { try { child.kill(signal); } catch { /* already gone */ } };
    // A descendant can retain the pipes after the direct child exits. Preserve
    // the timeout/output bounds while waiting for close to drain ordinary output.
    const boundDrain = () => {
      if (!exited) return;
      child.stdout?.destroy(); child.stderr?.destroy();
    };

    if (timeout > 0) {
      timer = setTimeout(() => { timedOut = true; killChild(killSignal); boundDrain(); }, timeout);
      if (typeof timer.unref === 'function') timer.unref();
    }

    child.stdout?.on('data', (chunk) => {
      stdoutLen += chunk.length;
      if (stdoutLen > maxBuffer) { overBuffer = true; killChild(killSignal); boundDrain(); return; }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderrLen += chunk.length;
      if (stderrLen > maxBuffer) { overBuffer = true; killChild(killSignal); boundDrain(); return; }
      stderrChunks.push(chunk);
    });

    // The child never started at all (ENOENT, EACCES, …) — no `resourceUsage` exists to report, and this is
    // exactly the class of error `execFileSync` throws untouched for the same condition.
    child.on('error', (err) => { finish(() => reject(err)); });

    child.on('exit', () => {
      exited = true;
      if (timedOut || overBuffer) boundDrain();
    });
    // exit can arrive before the last stdout/stderr data; close follows both pipes.
    child.on('close', (code, signal) => {
      finish(() => {
        const stdout = Buffer.concat(stdoutChunks).toString(encoding);
        const stderr = Buffer.concat(stderrChunks).toString(encoding);
        let resourceUsage = null;
        try { resourceUsage = typeof child.resourceUsage === 'function' ? child.resourceUsage() : null; } catch { resourceUsage = null; }

        if (signal || overBuffer || timedOut) {
          const e = new Error(
            `spawnToCompletion: ${cmd} exited via signal ${signal || killSignal}`
            + `${overBuffer ? ' (maxBuffer exceeded)' : ''}`,
          );
          e.status = null;
          e.signal = signal || killSignal;
          e.killed = timedOut || overBuffer;
          e.stdout = stdout;
          e.stderr = stderr;
          e.resourceUsage = resourceUsage;
          reject(e);
          return;
        }
        if (code !== 0) {
          const e = new Error(`spawnToCompletion: ${cmd} exited with status ${code}`);
          e.status = code;
          e.stdout = stdout;
          e.stderr = stderr;
          e.resourceUsage = resourceUsage;
          reject(e);
          return;
        }
        resolve({ stdout, stderr, resourceUsage });
      });
    });
  });
}
