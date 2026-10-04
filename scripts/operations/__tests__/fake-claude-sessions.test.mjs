/**
 * @file fake-claude-sessions.test.mjs — epic #3383 part 3. Proves `createFakeClaude` (`./helpers/fake-claude.mjs`)
 * and the behaviour engine (`we:scripts/conveyor/__tests__/sim/agent-actions.mjs`) against the REAL production
 * seams, the same standing `dispatch-spawn-live.test.mjs` established for the ORIGINAL `withFakeClaude`: no
 * injected spawner, no re-implemented listing logic — `buildAgentArgv`/`defaultSpawnAgent`/`defaultListAgents`
 * (`we:scripts/operations/dispatch-lane-io.mjs`) and `stopSession` (`we:scripts/operations/dispatch-abort.mjs`)
 * run for real, with `PATH` pointed at this new shim instead of the old inline one.
 *
 * Actions that need the fake GitHub JS API (`postVerdict`, `pushCommit`, …) are exercised elsewhere, once that
 * other worker's `fake-gh.mjs` rewrite lands — this file never imports it, per this lane's own hard rule, and
 * sticks to the actions (`setState`, `exit`, `writeCompletion`) that need only `ctx.claude`/`ctx.simClone`.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';

import { buildAgentArgv, defaultSpawnAgent, defaultListAgents } from '../dispatch-lane-io.mjs';
import { stopSession } from '../dispatch-abort.mjs';
import { createFakeClaude, sessionEnvToken } from './helpers/fake-claude.mjs';
import { tryReadCompletion } from '../completion-store.mjs';
import {
  exit as exitAction, setState as setStateAction, stepSessions,
} from '../../conveyor/__tests__/sim/agent-actions.mjs';
import { createSimClock } from '../../conveyor/__tests__/sim/clock.mjs';

/**
 * A SIGTERM is delivered asynchronously: the sleeper can still answer `kill(pid, 0)` for a few milliseconds
 * after `stop`/`killPid`/`cleanup` return. Asserting death on the very next line was a real race (it failed on
 * CI shard 4 for PR #2623 while passing locally), so poll briefly instead of asserting instantly.
 */
function pidGoneWithin(pid, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    try { process.kill(pid, 0); } catch { return true; }
    if (Date.now() > end) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}

let fake = null;
afterEach(() => { if (fake) fake.cleanup(); fake = null; });

/** The env every case spawns through: the fake's own `PATH` prefix (so `claude` resolves to the shim) plus
 *  the host's, with any per-case override spread last. */
function envFor(instance, extra = {}) {
  return { ...process.env, ...instance.env, ...extra };
}

function bg(num, name, extra = {}) {
  return buildAgentArgv({ sessionId: `sess-${num}`, payload: { num: String(num), sessionSlug: name, prompt: '# brief' }, ...extra });
}

function ctxFor(instance, completionsDir) {
  return {
    claude: instance,
    gh: null,
    repoFor: () => ({ slug: 'web-everything/web-everything', originPath: '' }),
    simClone: process.cwd(),
    env: envFor(instance),
    completionsDir,
    clock: createSimClock(),
  };
}

describe('createFakeClaude — spawn/list/stop through the real production seams', () => {
  it('accepts routed effort on a real launch and still rejects invalid flags and effort', () => {
    fake = createFakeClaude();
    const argv = bg(1, 'fix-effort', { table: { model: 'claude-sonnet-5-5', effort: 'high' } });
    expect(argv).toContain('--effort');
    expect(defaultSpawnAgent(argv, { env: envFor(fake) })).toMatch(/backgrounded/);
    expect(fake.sessions()[0].argv).toEqual(argv);
    for (const flags of [['--effort', 'invalid'], ['--not-a-cli-option']]) {
      expect(() => defaultSpawnAgent(['--bg', ...flags, 'brief'], { env: envFor(fake) })).toThrow();
    }
    expect(fake.sessions()).toHaveLength(1);
  });

  it('a real `--bg` dispatch is listed with a genuinely live pid', () => {
    fake = createFakeClaude();
    const stdout = defaultSpawnAgent(bg(1, 'review-501'), { env: envFor(fake) });
    expect(stdout).toMatch(/backgrounded/);

    const listing = defaultListAgents({ env: envFor(fake) });
    expect(listing).toHaveLength(1);
    const [row] = listing;
    expect(row.name).toBe('review-501');
    expect(row.kind).toBe('background');
    expect(row.state).toBe('working');
    expect(typeof row.pid).toBe('number');
    expect(() => process.kill(row.pid, 0)).not.toThrow(); // genuinely alive, not a fabricated number
  });

  it('`dispatch-abort.mjs#stopSession` kills the sleeper and deregisters the session from the default listing, but `--all` still remembers it', () => {
    fake = createFakeClaude();
    defaultSpawnAgent(bg(2, 'review-502'), { env: envFor(fake) });
    const [row] = defaultListAgents({ env: envFor(fake) });

    const env = envFor(fake);
    const res = stopSession({ handle: row.id, exec: (cmd, args, opts) => execFileSync(cmd, args, { ...opts, env }) });
    expect(res).toEqual({ stopped: true, alreadyGone: false, output: expect.stringContaining('stopped') });

    expect(defaultListAgents({ env })).toHaveLength(0);
    const all = defaultListAgents({ env, all: true });
    expect(all).toHaveLength(1);
    expect(all[0].state).toBe('stopped');
    expect(pidGoneWithin(row.pid)).toBe(true);
  });

  it('`killPid` (the JS API) kills the sleeper directly, no `claude stop` involved', () => {
    fake = createFakeClaude();
    defaultSpawnAgent(bg(3, 'review-503'), { env: envFor(fake) });
    const [row] = fake.sessions();
    expect(() => process.kill(row.pid, 0)).not.toThrow();

    fake.killPid(row.id);
    expect(pidGoneWithin(row.pid)).toBe(true);
  });

  it('`--all` vs no-`--all`: multiple sessions, one stopped, one still working', () => {
    fake = createFakeClaude();
    defaultSpawnAgent(bg(41, 'review-541'), { env: envFor(fake) });
    defaultSpawnAgent(bg(42, 'review-542'), { env: envFor(fake) });
    const env = envFor(fake);
    const [first] = defaultListAgents({ env });
    stopSession({ handle: first.id, exec: (cmd, args, opts) => execFileSync(cmd, args, { ...opts, env }) });

    const active = defaultListAgents({ env });
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe('review-542');

    const all = defaultListAgents({ env, all: true });
    expect(all.map((s) => s.name).sort()).toEqual(['review-541', 'review-542']);
  });

  it('records the GH_TOKEN the spawner actually passed, verbatim', () => {
    fake = createFakeClaude();
    execFileSync('claude', bg(7, 'review-507'), { encoding: 'utf8', env: envFor(fake, { GH_TOKEN: 'literal-token' }) });
    const [row] = fake.sessions();
    expect(sessionEnvToken(row)).toBe('literal-token');
  });

  it('the GH_TOKEN is absent when `defaultSpawnAgent`\'s own `sanitizeSpawnEnv` stripped it from an ambient env', () => {
    fake = createFakeClaude();
    // `defaultSpawnAgent` strips GH_TOKEN/GITHUB_TOKEN before the child ever sees them
    // (we:scripts/lib/gh-app-shim.mjs#sanitizeSpawnEnv) — this proves the STRIPPED value never reaches the
    // session, not merely that the shim can record one when handed one directly (the case above).
    defaultSpawnAgent(bg(6, 'review-506'), { env: envFor(fake, { GH_TOKEN: 'ambient-should-be-stripped' }) });
    const [row] = fake.sessions();
    expect(sessionEnvToken(row)).toBeNull();
  });

  describe('faults', () => {
    it('spawn-fails: the dispatch throws, and nothing is registered', () => {
      fake = createFakeClaude();
      fake.fault('spawn-fails');
      expect(() => defaultSpawnAgent(bg(10, 'review-510'), { env: envFor(fake) })).toThrow();
      expect(fake.sessions()).toHaveLength(0);
    });

    it('spawn-hangs: outlasts whatever timeout the real caller sets — the CALLER\'s timeout ends it, not shim cooperation', () => {
      fake = createFakeClaude();
      fake.fault('spawn-hangs');
      const start = Date.now();
      // `opts.timeout` overrides `defaultSpawnAgent`'s internal 60s default (spread order — see that
      // function's own body): a short override here proves the property fast, without waiting a real 60s+.
      expect(() => defaultSpawnAgent(bg(11, 'review-511'), { env: envFor(fake), timeout: 300 })).toThrow();
      expect(Date.now() - start).toBeLessThan(5_000);
    }, 10_000);

    it('list-fails: `agents --json` throws (a non-zero exit)', () => {
      fake = createFakeClaude();
      fake.fault('list-fails');
      expect(() => defaultListAgents({ env: envFor(fake) })).toThrow();
    });

    it('list-empty: `agents --json` reports nothing, even with real sessions registered', () => {
      fake = createFakeClaude();
      defaultSpawnAgent(bg(12, 'review-512'), { env: envFor(fake) });
      fake.fault('list-empty');
      expect(defaultListAgents({ env: envFor(fake) })).toEqual([]);
    });

    it('stop-fails: `stop` always reports "No job matching", mapped by stopSession to alreadyGone (not a throw), and the session is left untouched', () => {
      fake = createFakeClaude();
      defaultSpawnAgent(bg(13, 'review-513'), { env: envFor(fake) });
      const env = envFor(fake);
      const [row] = defaultListAgents({ env });
      fake.fault('stop-fails');

      const res = stopSession({ handle: row.id, exec: (cmd, args, opts) => execFileSync(cmd, args, { ...opts, env }) });
      expect(res.stopped).toBe(true);
      expect(res.alreadyGone).toBe(true);
      expect(defaultListAgents({ env })).toHaveLength(1); // never actually stopped
      expect(() => process.kill(row.pid, 0)).not.toThrow();
    });
  });

  it('cleanup kills every sleeper THIS instance spawned, and only those', () => {
    const local = createFakeClaude();
    for (const n of [21, 22, 23]) {
      defaultSpawnAgent(bg(n, `review-5${n}`), { env: envFor(local) });
    }
    const pids = local.sessions().map((s) => s.pid);
    expect(pids).toHaveLength(3);
    local.cleanup();
    for (const pid of pids) expect(pidGoneWithin(pid)).toBe(true);
  });
});

describe('scripted actions — writeCompletion / exit / setState, through the real completion-store', () => {
  it('exit({writeCompletion:false}) leaves no completion record; exit({writeCompletion:true}) writes one readable by tryReadCompletion', async () => {
    fake = createFakeClaude();
    defaultSpawnAgent(bg(8, 'fix-508'), { env: envFor(fake) });
    const completionsDir = mkdtempSync(join(tmpdir(), 'fake-claude-completions-'));
    try {
      const ctx = ctxFor(fake, completionsDir);
      const session = fake.session('fix-508');
      expect(session).toBeTruthy();

      await exitAction({ state: 'done', writeCompletion: false }).run(ctx, session);
      expect(tryReadCompletion('fix-508', completionsDir)).toBeNull();
      expect(fake.session('fix-508').state).toBe('done');
      expect(pidGoneWithin(session.pid)).toBe(true);

      defaultSpawnAgent(bg(18, 'fix-518'), { env: envFor(fake) });
      const session2 = fake.session('fix-518');
      await exitAction({ state: 'done', writeCompletion: true, outcome: 'resolved' }).run(ctx, session2);
      const record = tryReadCompletion('fix-518', completionsDir);
      expect(record).toBeTruthy();
      expect(record.status).toBe('done');
      expect(record.outcome).toBe('resolved');
      expect(record.session).toBe('fix-518');
    } finally {
      rmSync(completionsDir, { recursive: true, force: true });
    }
  });

  it('setState updates the listing, and stepSessions pops exactly one scripted action per session per call', async () => {
    fake = createFakeClaude();
    defaultSpawnAgent(bg(10, 'fix-610'), { env: envFor(fake) });
    const completionsDir = mkdtempSync(join(tmpdir(), 'fake-claude-completions-'));
    try {
      const ctx = ctxFor(fake, completionsDir);
      fake.script('fix-*', [setStateAction('blocked'), exitAction({ state: 'done', writeCompletion: false })]);

      let stepped = await stepSessions(ctx);
      expect(stepped).toEqual([{ session: 'fix-610', kind: 'setState' }]);
      expect(fake.session('fix-610').state).toBe('blocked');

      stepped = await stepSessions(ctx);
      expect(stepped).toEqual([{ session: 'fix-610', kind: 'exit' }]);
      expect(fake.session('fix-610').state).toBe('done');

      // Queue exhausted AND the session is now terminal (not 'working'/'blocked') — nothing left to step.
      stepped = await stepSessions(ctx);
      expect(stepped).toEqual([]);
    } finally {
      rmSync(completionsDir, { recursive: true, force: true });
    }
  });

  it('an unscripted session is left alone by stepSessions', async () => {
    fake = createFakeClaude();
    defaultSpawnAgent(bg(11, 'review-711'), { env: envFor(fake) });
    const completionsDir = mkdtempSync(join(tmpdir(), 'fake-claude-completions-'));
    try {
      const ctx = ctxFor(fake, completionsDir);
      const stepped = await stepSessions(ctx);
      expect(stepped).toEqual([]);
      expect(fake.session('review-711').state).toBe('working');
    } finally {
      rmSync(completionsDir, { recursive: true, force: true });
    }
  });
});
