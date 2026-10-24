/**
 * @file scripts/lib/__tests__/gh-app-shim.throttle-cap.test.mjs
 * @description #4064 — the load-bearing proof that EVERY dispatched session's `gh` call is now paced by
 *   `we:scripts/lib/gh-throttle.mjs`'s own concurrency cap, not just "on the App login": N REAL, concurrently
 *   spawned invocations of the ACTUAL rendered shim script (not a mock) must never run more than `cap` of them
 *   at once, verified from real wall-clock start/end timestamps a fake "real gh" writes to a shared log file —
 *   the same kind of REAL-execution proof `gh-app-shim.test.mjs`'s own `describe('live', ...)` block already
 *   uses for the App-token behavior, applied here to the #4064 concurrency behavior instead.
 *
 *   Isolated from the real, host-shared admission lock exactly like `gh-app-shim.test.mjs` (see that file's
 *   own header for why): `LANE_POOL_ROOT` is pinned to a throwaway tmpdir for this file's own tests.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderGhShimScript } from '../gh-app-shim.mjs';

// A daemon-run verify inherits these markers, which put the shim in refuse mode.
const NOT_A_DAEMON = { WE_GH_DAEMON_CALLER: undefined, XPC_SERVICE_NAME: undefined, WE_GH_AUTH_PERSONAL_FALLBACK: undefined };

let PRE_EXISTING_LANE_POOL_ROOT;
beforeAll(() => {
  PRE_EXISTING_LANE_POOL_ROOT = process.env.LANE_POOL_ROOT;
});
afterAll(() => {
  if (PRE_EXISTING_LANE_POOL_ROOT === undefined) delete process.env.LANE_POOL_ROOT;
  else process.env.LANE_POOL_ROOT = PRE_EXISTING_LANE_POOL_ROOT;
});

/** Spawn `file` async (never blocking the event loop, so N of these can truly run concurrently from this one
 *  test process) and resolve once it exits. */
function spawnAsync(file, args, opts) {
  return new Promise((res, rej) => {
    const child = spawn(file, args, opts);
    let stdout = '';
    child.stdout?.on('data', (d) => { stdout += d.toString('utf8'); });
    child.on('error', rej);
    child.on('close', (code) => res({ code, stdout }));
  });
}

describe('the rendered shim script — every real `gh` call is paced by gh-throttle.mjs\'s concurrency cap (#4064)', () => {
  it(`N concurrently-spawned REAL shim invocations never exceed the configured cap running at once`, async () => {
    const N = 6;
    const CAP = 2;
    const SLEEP_MS = 200;

    const dir = mkdtempSync(join(tmpdir(), 'we-gh-shim-cap-'));
    const isolatedLockRoot = mkdtempSync(join(tmpdir(), 'we-gh-shim-cap-lock-'));
    const logPath = join(dir, 'events.jsonl');
    writeFileSync(logPath, '', 'utf8');

    // The fake "real gh": records a start event, busy-sleeps SLEEP_MS (a real, observable hold time), records
    // an end event, then exits 0 — exactly the shape needed to reconstruct "how many were in flight at once"
    // from real wall-clock timestamps after the fact.
    const realGh = join(dir, 'real-gh');
    writeFileSync(
      realGh,
      '#!/usr/bin/env node\n'
        + 'const fs = require("fs");\n'
        + 'const logPath = process.env.WE_TEST_LOG;\n'
        + 'const idx = process.env.WE_TEST_IDX;\n'
        + 'fs.appendFileSync(logPath, JSON.stringify({ idx, event: "start", ts: Date.now() }) + "\\n");\n'
        + `const end = Date.now() + ${SLEEP_MS};\n`
        + 'while (Date.now() < end) { /* busy-sleep — a real held slot, not a mock */ }\n'
        + 'fs.appendFileSync(logPath, JSON.stringify({ idx, event: "end", ts: Date.now() }) + "\\n");\n'
        + 'console.log(JSON.stringify({ ok: true, idx }));\n',
      'utf8',
    );
    chmodSync(realGh, 0o755);

    const cachePath = join(dir, 'cache.json'); // never written — every call takes the no-cached-token fallback
    const shimPath = join(dir, 'gh');
    writeFileSync(shimPath, renderGhShimScript({ realGhPath: realGh, cachePath }), 'utf8');
    chmodSync(shimPath, 0o755);

    const startedAt = Date.now();
    const calls = Array.from({ length: N }, (_, i) => spawnAsync(shimPath, ['api', 'ping'], {
      env: {
        ...process.env, ...NOT_A_DAEMON, GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
        LANE_POOL_ROOT: isolatedLockRoot, WE_GH_THROTTLE_CAP: String(CAP),
        WE_TEST_LOG: logPath, WE_TEST_IDX: String(i),
      },
    }));
    const results = await Promise.all(calls);
    const wallMs = Date.now() - startedAt;

    try {
      // Every call succeeded — throttling paces calls, it never drops or corrupts one.
      for (const r of results) {
        expect(r.code).toBe(0);
        expect(JSON.parse(r.stdout).ok).toBe(true);
      }

      const events = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(events.length).toBe(N * 2); // one start + one end per call, none lost

      // Reconstruct max concurrent overlap from the real start/end timestamps.
      const sorted = [...events].sort((a, b) => a.ts - b.ts || (a.event === 'end' ? -1 : 1));
      let inFlight = 0;
      let maxInFlight = 0;
      for (const e of sorted) {
        if (e.event === 'start') { inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); }
        else inFlight -= 1;
      }
      expect(maxInFlight).toBeLessThanOrEqual(CAP); // THE cap-holding proof

      // Paced, not instant: with CAP=2 and N=6 calls each holding SLEEP_MS, at least ceil(N/CAP) batches must
      // have run serially — a generous lower bound (half the theoretical minimum) that only an UNTHROTTLED
      // (all-at-once) run could fail.
      const minExpectedMs = Math.ceil(N / CAP) * SLEEP_MS * 0.5;
      expect(wallMs).toBeGreaterThanOrEqual(minExpectedMs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(isolatedLockRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('the 401 fallback (PR #2600) still works when routed through the throttled call (#4064 never breaks it)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-gh-shim-cap-fallback-'));
    const isolatedLockRoot = mkdtempSync(join(tmpdir(), 'we-gh-shim-cap-fallback-lock-'));
    const realGh = join(dir, 'real-gh');
    writeFileSync(
      realGh,
      '#!/usr/bin/env node\n'
        + 'if (process.env.GH_TOKEN) { process.stderr.write("HTTP 401: Bad credentials\\n"); process.exit(1); }\n'
        + 'console.log(JSON.stringify({ ok: true, ghToken: process.env.GH_TOKEN || null }));\n',
    );
    chmodSync(realGh, 0o755);
    const cachePath = join(dir, 'cache.json');
    writeFileSync(cachePath, JSON.stringify({ v: 2, token: 'ghs_rejected_but_fresh', expiresAt: new Date(Date.now() + 55 * 60 * 1000).toISOString() }), 'utf8');
    const shimPath = join(dir, 'gh');
    writeFileSync(shimPath, renderGhShimScript({ realGhPath: realGh, cachePath }), 'utf8');
    chmodSync(shimPath, 0o755);

    try {
      const { code, stdout } = await spawnAsync(shimPath, ['pr', 'view', '2582'], {
        env: { ...process.env, ...NOT_A_DAEMON, GH_TOKEN: undefined, LANE_POOL_ROOT: isolatedLockRoot },
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.ghToken).toBeFalsy(); // fell back to no-token auth, exactly as PR #2600 established
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(isolatedLockRoot, { recursive: true, force: true });
    }
  }, 15_000);
});
