/** Deterministic two-hour observation of independent loops on one virtual clock. */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function probeCadence(root) {
  const daemon = await import(pathToFileURL(join(root, 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs')).href);
  let time = 0; const pending = [], passes = [];
  const sleep = ms => new Promise(resolve => pending.push({ at: time + ms, resolve }));
  const main = daemon.runDaemonLoop({ tickOnce: async () => {
    if (!daemon.runCiHealLoop) passes.push(time);
    await sleep(40 * 60_000);
  }, sleep, maxTicks: 3 });
  const heal = daemon.runCiHealLoop?.({ passOnce: () => passes.push(time), now: () => time, sleep, maxPasses: 61 });
  // Flush asynchronous wrappers before advancing to the next scheduled wake.
  for (let step = 0; step < 1000; step++) {
    for (let flush = 0; flush < 20; flush++) await Promise.resolve();
    pending.sort((a, b) => a.at - b.at);
    const next = pending.shift();
    if (!next) break;
    time = next.at; next.resolve();
  }
  await Promise.all([main, heal]);
  const gaps = passes.slice(1).map((t, i) => t - passes[i]);
  return { count: passes.length, maxGap: gaps.length ? Math.max(...gaps) : Infinity,
    span: passes.at(-1) - passes[0] };
}
export function cadenceViolations(report) {
  return report.count >= 61 && report.span >= 2 * 60 * 60_000 && report.maxGap <= 120_000
    ? [] : ['ci-heal cadence exceeds 120s during forty-minute main ticks'];
}
