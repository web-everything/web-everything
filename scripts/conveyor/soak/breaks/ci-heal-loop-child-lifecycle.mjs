/**
 * PR #7248: replay the ci-heal child's operator setting and error/retry lifecycle.
 * A daemon tick can start a replacement before an earlier error's retry timer fires;
 * that timer must not strand a second child. Use production setting resolution,
 * controller, spawn gate and supervisor, with only child processes and time simulated.
 * No Git metadata, host stores, authentication or network access is needed.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SUPERVISOR = 'scripts/conveyor/await-verify-loop.mjs';
const LOOP = 'scripts/conveyor/ci-heal-loop.mjs';

/** Independent behavioral presence probe; all external supervisor ports are inert. */
function singleChildProbe(root) {
  try {
    const source = readFileSync(join(root, SUPERVISOR), 'utf8');
    const declaration = source.match(/export function superviseAwaitVerifyLoop\([^]*?\n\}/)?.[0];
    if (!declaration) return false;
    const supervise = runInNewContext(`(${declaration.replace(/^export /, '')})`, {});
    let attempts = 0;
    let retry;
    const supervisor = supervise({
      spawnLoop: () => {
        if (++attempts === 1) throw new Error('EAGAIN');
        return { on() {}, kill() {} };
      },
      log: { error() {} }, now: () => 0,
      setTimer: fn => { retry = fn; return { unref() {} }; },
    });
    supervisor.start();
    const replacement = supervisor.start();
    retry();
    return attempts === 2 && supervisor.current() === replacement;
  } catch { return false; }
}

export default {
  id: 'ci-heal-loop-child-lifecycle',
  title: 'ci-heal setting changes and delayed error retries keep a single supervised child',
  card: 'we:PR#7248 (async fixer C2)',
  fixedBy: {
    sha: 'e63e8c561a', where: 'lane/async-c2-ci-heal-wire', paths: [SUPERVISOR],
  },
  fixPresent: singleChildProbe,
  // The optional supervisor port supports replaying the historical declaration offline.
  async run({ root = ROOT, supervise, log } = {}) {
    const { createCiHealLoopController, resolveCiHealLoop, spawnCiHealLoop } =
      await import(pathToFileURL(join(root, LOOP)).href);
    supervise ??= (await import(pathToFileURL(join(root, SUPERVISOR)).href)).superviseAwaitVerifyLoop;
    const violations = [], children = [], timers = [], lines = [];
    let enabled = false, nowMs = 100_000;
    const check = (ok, detail) => { if (!ok) violations.push({ invariant: 'child-lifecycle', detail }); };
    const settings = () => ({ env: {}, settings: {}, readOverride: () => ({ ok: true, value: enabled ? 'on' : 'off' }) });
    const supervisor = supervise({
      now: () => nowMs, minGapMs: 60_000, log: { error: line => lines.push(line) },
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
      spawnLoop: () => spawnCiHealLoop({
        ...settings(), parentPid: 7, log: line => lines.push(line),
        spawnFn: (_exe, args) => {
          check(args.includes('--parent-pid=7'), 'spawn lost the parent PID');
          const child = new EventEmitter();
          child.signals = [];
          child.kill = signal => { child.signals.push(signal); };
          children.push(child);
          return child;
        },
      }),
    });
    const controller = createCiHealLoopController({
      supervisor, resolve: () => resolveCiHealLoop(settings()), log: line => lines.push(line),
    });
    try {
      controller.tick();
      check(children.length === 0, 'off spawned a child');
      enabled = true;
      controller.tick(); controller.tick();
      check(children.length === 1, 'repeated on ticks did not keep one child');
      const first = children[0];
      nowMs += 10_000;
      first.emit('error', new Error('EAGAIN'));
      first.emit('exit', 1);
      check(supervisor.current() === null, 'failed child still suppresses inline fallback');
      check(timers.length === 1 && timers[0].ms === 50_000, 'error plus exit did not arm one rate-limited retry');

      // The next daemon tick wins the race with the delayed retry.
      controller.tick();
      const replacement = supervisor.current();
      check(children.length === 2 && replacement !== first, 'next tick did not replace the failed child');
      nowMs += 50_000;
      timers.shift()?.fn();
      check(children.length === 2 && supervisor.current() === replacement, 'stale retry spawned a second live child');

      enabled = false;
      controller.tick(); controller.tick();
      check(replacement.signals.join(',') === 'SIGTERM', 'off did not stop the replacement exactly once');
      check(supervisor.current() === null, 'off did not restore inline fallback');
      replacement.emit('exit', 0);
      check(timers.length === 0, 'clean setting-off exit armed a restart');

      enabled = true;
      controller.tick();
      const recovered = supervisor.current();
      check(children.length === 3 && recovered !== replacement, 'on did not resume supervision after off');
      recovered.emit('error', new Error('EAGAIN'));
      enabled = false;
      controller.tick();
      timers.shift()?.fn();
      check(children.length === 3 && supervisor.current() === null, 'pending retry ignored the off spawn gate');

      enabled = true;
      controller.tick();
      const finalChild = supervisor.current();
      finalChild.emit('error', new Error('EAGAIN'));
      supervisor.stop();
      timers.shift()?.fn();
      check(children.length === 4, 'shutdown allowed a pending timer to respawn');
      check(lines.includes('ci-heal-loop: ciHeal.loop=off source=override')
        && lines.includes('ci-heal-loop: ciHeal.loop=on source=override'), 'setting provenance was not logged');
    } catch (error) {
      violations.push({ invariant: 'crash', detail: String(error?.stack ?? error) });
    } finally {
      supervisor.stop();
    }
    log?.(`ci-heal lifecycle: ${children.length} children, ${violations.length} violations`);
    return { violations };
  },
  judge: report => report.violations.map(v => `[${v.invariant}] ${v.detail}`),
};
