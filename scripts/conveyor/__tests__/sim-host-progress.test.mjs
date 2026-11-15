// @vitest-environment node
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { tickProgressPath } from '../../lib/daemon-background-build.mjs';

it('the daemon host persists isolated probation evidence and flushes its restart reply before exiting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sim-host-progress-'));
  let child;
  const write = (path, text, options) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, options);
  };
  const entry = 'skills-src/conveyor/review-daemon.mjs';
  const head = 'a'.repeat(40);
  const env = { ...process.env, SIM_DAEMON_KIND: 'review', SIM_CLONE_ROOT: root,
    WE_DAEMON_STATE_DIR: join(root, 'state'), PATH: `${join(root, 'bin')}:${process.env.PATH}` };
  try {
    // Only the host adapter is under test. Fake daemon/auth/self-sync modules keep
    // the child hermetic; its progress store is the real persisted implementation.
    write(entry, 'export const buildCliDaemonEffects = () => ({ tickOnce: async () => ({ ok: true }) });');
    write('scripts/lib/github-app-auth-env.mjs', 'export const withGithubAppAuth = effects => effects;');
    write('scripts/lib/daemon-background-build.mjs',
      `export { makeTickProgressStore } from ${JSON.stringify(new URL('../../lib/daemon-background-build.mjs', import.meta.url).href)};`);
    write('scripts/lib/daemon-self-sync.mjs', `export function withSelfSync(effects, options) {
      let ticks = 0;
      return { tickOnce: async () => {
        if (ticks++ > 0) return options.onRestart({ proof: 'x'.repeat(512 * 1024) });
        const result = await effects.tickOnce();
        options.tickProgress?.markTickDone(Date.now());
        return result;
      } };
    }`);
    // A read-only Git shim supplies HEAD without creating or mutating a repository.
    write('bin/git', `#!/bin/sh\n[ "$1" = rev-parse ] && [ "$2" = HEAD ] || exit 1\nprintf '%s\\n' '${head}'\n`, { mode: 0o755 });
    child = fork(fileURLToPath(new URL('./sim/daemon-host.mjs', import.meta.url)), [], {
      cwd: root, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const waitMessage = () => once(child, 'message', { signal: AbortSignal.timeout(5000) });
    expect((await waitMessage())[0].type).toBe('ready');
    const reply = waitMessage();
    child.send({ type: 'tick' }, () => {});
    expect((await reply)[0]).toMatchObject({ type: 'result', result: { ok: true }, error: null });
    const file = tickProgressPath(root, join(root, entry), env);
    expect(file.startsWith(`${env.WE_DAEMON_STATE_DIR}/`)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ pid: child.pid, head });
    // Force enough IPC backpressure to exercise the send callback before exit.
    const restarted = waitMessage();
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
    const completed = Promise.all([restarted, exited]);
    child.send({ type: 'tick' }, () => {});
    const [[restart], [code]] = await completed;
    expect(restart).toEqual({ type: 'restart', info: { proof: 'x'.repeat(512 * 1024) }, logs: [] });
    expect(code).toBe(0);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
