/** #3383 — The worker marker: set at every claude spawn, inherited by descendants, fails closed. */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WORKER_MARKER_ENV, markWorkerEnv, classifySession, workerMarkerSettingsEnv } from '../session-role.mjs';
import { buildAgentArgv } from '../dispatch-lane-io.mjs';
import { buildInvestigatorArgv } from '../explore-io.mjs';
import { defaultSpawnAgent, spawnAgentToCompletion } from '../dispatch-lane-io.mjs';
import { defaultSpawnDetached } from '../detached-dispatch.mjs';

const ROOT = process.cwd(); // vitest runs from the repo root
const ROLE_URL = pathToFileURL(join(ROOT, 'scripts', 'operations', 'session-role.mjs')).href;

describe('classifySession', () => {
  it('an unmarked environment is an orchestrator', () => {
    expect(classifySession({})).toMatchObject({ role: 'orchestrator' });
    expect(classifySession({ PATH: '/bin' }).role).toBe('orchestrator');
  });
  it('WE_CONVEYOR_WORKER=1 is a worker', () => {
    expect(classifySession({ [WORKER_MARKER_ENV]: '1' })).toMatchObject({ role: 'worker' });
  });
  it.each(['0', '', 'true', 'yes', ' 1', '2'])('an unrecognised marker value %j fails closed as unknown', (value) => {
    expect(classifySession({ [WORKER_MARKER_ENV]: value }).role).toBe('unknown');
  });
  it('no readable environment fails closed', () => {
    expect(classifySession(null).role).toBe('unknown');
    expect(classifySession(undefined).role).toBe('orchestrator'); // default param = process.env of THIS process
  });
});

describe('markWorkerEnv', () => {
  it('returns a marked copy and never mutates its input', () => {
    const env = { A: '1' };
    const marked = markWorkerEnv(env);
    expect(marked).toEqual({ A: '1', [WORKER_MARKER_ENV]: '1' });
    expect(env).toEqual({ A: '1' });
    expect(classifySession(marked).role).toBe('worker');
  });
  it('overwrites a half-cleared marker rather than trusting it', () => {
    expect(classifySession(markWorkerEnv({ [WORKER_MARKER_ENV]: '0' })).role).toBe('worker');
  });
  it('a real child of a worker stays a worker, and so does its own child (env is inherited)', () => {
    const grandchild = `process.stdout.write(String(process.env.${WORKER_MARKER_ENV}))`;
    const child = `import(${JSON.stringify(ROLE_URL)}).then(({ classifySession }) => {
      const { execFileSync } = require('node:child_process');
      process.stdout.write(classifySession(process.env).role + ':' + execFileSync(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { encoding: 'utf8' }));
    })`;
    const out = execFileSync(process.execPath, ['--no-warnings', '-e', child], { encoding: 'utf8', env: markWorkerEnv({ PATH: process.env.PATH }) });
    expect(out).toBe('worker:1');
  });
});

describe('every claude spawn site sets the marker', () => {
  it('defaultSpawnAgent (claude --bg) passes a marked env, keeping the caller\'s other keys', () => {
    let seen;
    defaultSpawnAgent(['--bg', 'x'], { env: { KEEP: 'me' } }, { exec: (_cmd, _argv, opts) => { seen = opts; return ''; } });
    expect(seen.env).toEqual({ KEEP: 'me', [WORKER_MARKER_ENV]: '1' });
    defaultSpawnAgent(['--bg', 'x'], {}, { exec: (_c, _a, opts) => { seen = opts; return ''; } });
    expect(classifySession(seen.env).role).toBe('worker');
    expect(seen.env.PATH).toBe(process.env.PATH);
  });
  it('spawnAgentToCompletion (blocking wrapper agent) passes a marked env', async () => {
    let seen;
    const spawnFn = (_cmd, _argv, opts) => {
      seen = opts;
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
      queueMicrotask(() => {
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      });
      return child;
    };
    await spawnAgentToCompletion(['-p', 'x'], {}, { spawnFn });
    expect(classifySession(seen.env).role).toBe('worker');
  });
  it('defaultSpawnDetached (the node wrapper that runs the agent) passes a marked env', () => {
    let seen;
    defaultSpawnDetached(['wrapper.mjs'], { cwd: '/x', logPath: '/x/log' }, {
      spawn: (_cmd, _argv, opts) => { seen = opts; return { unref() {} }; }, ensureDir: () => {}, openLog: () => 3,
    });
    expect(classifySession(seen.env).role).toBe('worker');
  });
  // #landing-freeze-2779 — live incident regression guard: a detached wrapper (ci-heal-run.mjs et al) used to
  // inherit `process.env` VERBATIM, so a static, daemon-minted `GH_TOKEN` rode along unsanitized for as long as
  // the wrapper (and whatever it later spawned) lived — routinely longer than the token's own ~1h life. See
  // `detached-dispatch.mjs#defaultSpawnDetached`'s own docblock for the full mechanism and incident.
  describe('defaultSpawnDetached never carries a static GH_TOKEN/GITHUB_TOKEN, and forwards the gh-shim settingsEnv (#landing-freeze-2779)', () => {
    it('strips a static GH_TOKEN/GITHUB_TOKEN inherited from process.env', () => {
      const savedGh = process.env.GH_TOKEN;
      const savedGithub = process.env.GITHUB_TOKEN;
      process.env.GH_TOKEN = 'stale-static-token';
      process.env.GITHUB_TOKEN = 'stale-static-token-2';
      let seen;
      try {
        defaultSpawnDetached(['wrapper.mjs'], { cwd: '/x', logPath: '/x/log' }, {
          spawn: (_cmd, _argv, opts) => { seen = opts; return { unref() {} }; }, ensureDir: () => {}, openLog: () => 3,
        });
      } finally {
        if (savedGh === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = savedGh;
        if (savedGithub === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = savedGithub;
      }
      expect(seen.env.GH_TOKEN).toBeUndefined();
      expect(seen.env.GITHUB_TOKEN).toBeUndefined();
    });
    it('merges the caller\'s settingsEnv (the gh-shim PATH override) on top of the sanitized env', () => {
      let seen;
      defaultSpawnDetached(['wrapper.mjs'], { cwd: '/x', logPath: '/x/log', settingsEnv: { PATH: '/shim:/usr/bin' } }, {
        spawn: (_cmd, _argv, opts) => { seen = opts; return { unref() {} }; }, ensureDir: () => {}, openLog: () => 3,
      });
      expect(seen.env.PATH).toBe('/shim:/usr/bin');
      expect(classifySession(seen.env).role).toBe('worker');
    });
    it('no settingsEnv (the default) keeps the marked, sanitized env — byte-identical to before but for the strip', () => {
      let seen;
      defaultSpawnDetached(['wrapper.mjs'], { cwd: '/x', logPath: '/x/log' }, {
        spawn: (_cmd, _argv, opts) => { seen = opts; return { unref() {} }; }, ensureDir: () => {}, openLog: () => 3,
      });
      expect(seen.env.PATH).toBe(process.env.PATH);
    });
  });
  it('the other claude spawn sources route through markWorkerEnv (regression guard for a new site)', () => {
    // #3902 port note — `scripts/lib/judge-spawn.mjs` (a JUROR spawn, not a delivery/dispatch worker) is
    // deliberately EXCLUDED from this list: `scripts/lib/__tests__/judge-spawn.test.mjs` and
    // `scripts/lib/__tests__/judge-panel.test.mjs` already pin the OPPOSITE invariant on main today (a
    // juror's env is forwarded byte-identical, no marker added — `toEqual({ A: '1' })` with no
    // `WE_CONVEYOR_WORKER`). Whether a juror should also count as a "worker" for the tick-once guard is a
    // real, undecided design question (a juror never runs the mechanical lifecycle commands the guard exists
    // to deny), not something this faithful-port slice may decide by editing an unrelated file's env shape
    // out from under its own already-green pinned tests. File a follow-up if that marking is ever wanted.
    for (const file of ['scripts/operations/deliver-item-wrapper.mjs', 'scripts/operator/dispatch.mjs',
      'scripts/operations/dispatch-lane-io.mjs', 'scripts/operations/detached-dispatch.mjs']) {
      expect(readFileSync(join(ROOT, file), 'utf8'), file).toMatch(/markWorkerEnv\(/);
    }
  });
});

// xgqz204 — `claude --bg` drops the spawner's ambient env (measured live 2026-09-25), so the `env` a spawn site
// passes never reaches a `--bg` session. The marker must ride `--settings '{"env":...}'`, which does.
describe('workerMarkerSettingsEnv — the marker every `claude --bg` spawn carries in --settings', () => {
  it('adds the marker to null / a caller env, never mutating the input, and always wins over a stray value', () => {
    expect(workerMarkerSettingsEnv(null)).toEqual({ [WORKER_MARKER_ENV]: '1' });
    const input = { PATH: '/p', [WORKER_MARKER_ENV]: '0' };
    expect(workerMarkerSettingsEnv(input)).toEqual({ PATH: '/p', [WORKER_MARKER_ENV]: '1' });
    expect(input[WORKER_MARKER_ENV]).toBe('0');
    expect(classifySession(workerMarkerSettingsEnv()).role).toBe('worker');
  });
  const settingsEnvOf = (argv) => JSON.parse(argv[argv.indexOf('--settings') + 1]).env;
  it('every fresh --bg dispatch argv carries it (build/fix/ci-heal/review/stuck-inspect all use buildAgentArgv)', () => {
    expect(settingsEnvOf(buildAgentArgv({ sessionId: 's', payload: { prompt: 'p', sessionSlug: 'review-1' } })))
      .toEqual({ [WORKER_MARKER_ENV]: '1' });
  });
  it('an explore panelist argv carries it too', () => {
    expect(settingsEnvOf(buildInvestigatorArgv({ sessionId: 'u', runId: 'r1', payload: { panelist: 'p1' }, prompt: 'go' })))
      .toEqual({ [WORKER_MARKER_ENV]: '1' });
  });
});
