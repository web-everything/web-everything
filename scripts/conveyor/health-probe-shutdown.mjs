import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

/** Read the job's own group, excluding its leader. Unreadable evidence throws. */
function groupChildren() {
  const output = execFileSync('ps', ['-A', '-o', 'pid=,pgid='], {
    detached: true, encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024,
  });
  return output.trim().split('\n').flatMap((line) => {
    const [pid, pgid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(pgid)) throw new Error('unreadable probe process group');
    return pgid === process.pid && pid !== process.pid ? [pid] : [];
  });
}

/** Keep the leader alive while stopped CLIs are reaped, even if its worker finishes first. */
export function installProbeShutdown() {
  let shutdown;
  const killGroup = () => {
    try { process.kill(-process.pid, 'SIGKILL'); } catch { process.kill(process.pid, 'SIGKILL'); }
  };
  const stop = () => {
    if (shutdown) return; // includes our own forwarded SIGTERM
    // Defer execution until shutdown is assigned, before forwarding a signal to ourselves.
    shutdown = Promise.resolve().then(async () => {
      const watchdog = setTimeout(killGroup, 3000);
      try {
        try { process.kill(-process.pid, 'SIGTERM'); } catch { /* leader-only fallback below */ }
        await delay(1000);
        // Kill descendants first: killing their parent simultaneously prevents synchronous reaping.
        for (const pid of groupChildren()) {
          try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        const deadline = Date.now() + 1000;
        while (groupChildren().length) {
          if (Date.now() >= deadline) throw new Error('probe process group did not drain');
          await delay(25);
        }
        clearTimeout(watchdog);
        // Group is drained. A leader that exits on its own (worker done) keeps its clean exit; one whose worker
        // is still running is ended after a short grace, as the old handler did. unref: never holds the exit.
        setTimeout(killGroup, 2000).unref();
      } catch (error) {
        console.error(`health-gh-probe shutdown: ${error.message}; forcing group shutdown`);
        killGroup();
      }
    });
  };
  process.on('SIGTERM', stop);
  return async () => {
    await shutdown;
    process.removeListener('SIGTERM', stop);
  };
}
