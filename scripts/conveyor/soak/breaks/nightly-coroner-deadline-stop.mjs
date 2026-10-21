/** PR #5487: a deadline stop must end the extractor subprocess and release the lane, not only kill the job pid. */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { keepAliveScript } from '../../../lib/test-keepalive.mjs';
import { createJobStore, enqueueJob, reattachTick, JOB_ID_ENV, JOB_ATTEMPT_ENV } from '../../../lib/daemon-jobs-runtime.mjs';
import { markLaunching } from '../../../lib/daemon-jobs.mjs';
import { HEALTH_NIGHTLY_CORONER_KIND, HEALTH_WATCH_JOB_KINDS } from '../../../../skills-src/conveyor/daemon-manifest.mjs';

const SOURCE = 'scripts/conveyor/nightly-coroner-job.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export default {
  id: 'nightly-coroner-deadline-stop',
  title: 'a deadline stop ends the running extractor and releases the nightly coroner lane',
  card: 'PR #5487',
  fixedBy: { sha: 'HEAD', where: 'lane/coroner-job-fix', paths: [SOURCE, 'scripts/lib/daemon-jobs-runtime.mjs', 'scripts/lib/daemon-jobs.mjs', 'skills-src/conveyor/daemon-manifest.mjs'] },
  fixPresent(root) { return readFileSync(join(root, SOURCE), 'utf8').includes('runNightlyCoronerEntry'); },
  async run({ log } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'soak-coroner-deadline-'));
    const violations = [];
    const pids = [];
    try {
      const lane = { lane: 7, holder: 'soak', path: join(root, 'lane') };
      mkdirSync(join(lane.path, 'scripts/operations'), { recursive: true });
      const pidFile = join(root, 'extractor.pid'), released = join(root, 'released');
      writeFileSync(join(lane.path, 'scripts/operations/coroner-extract.mjs'),
        `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n${keepAliveScript()}\n`);
      const input = { night: '2026-10-16', until: '2026-10-17T02:17:00.000Z', dir: join(root, 'state'), sourceRoot: root };
      const io = { home: join(root, 'handoff'), statusFeed: join(root, 'feed.jsonl'), lane, released };
      // The job child as the daemon launches it: detached, running the job's own entry (or, before the fix, the
      // bare runJob + extract it used to run), with only the lane pool replaced by files this scenario can read.
      const child = join(root, 'child.mjs');
      writeFileSync(child, [
        `import { writeFileSync } from 'node:fs';`,
        `const m = await import(${JSON.stringify(pathToFileURL(join(ROOT, SOURCE)).href)});`,
        `const rt = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'scripts/lib/daemon-jobs-runtime.mjs')).href)});`,
        `const o = ${JSON.stringify(io)};`,
        `const io = { home: o.home, statusFeed: o.statusFeed, acquire: async () => o.lane, release: async () => writeFileSync(o.released, '1'), sweep: async () => {} };`,
        `if (m.runNightlyCoronerEntry) await m.runNightlyCoronerEntry({ io });`,
        `else await rt.runJob({ steps: [{ name: 'nightly-coroner', run: ({ input }) => m.extractNightlyCoroner(input, io) }] });`,
      ].join('\n'));
      const store = createJobStore(join(root, 'jobs'));
      mkdirSync(store.dir, { recursive: true });
      const id = 'nightly-coroner-2026-10-16';
      enqueueJob({ store, id, kindDef: HEALTH_NIGHTLY_CORONER_KIND, codeSha: 'soak', input, now: Date.now() });
      const rec = store.update(id, (r) => markLaunching(r, { at: new Date().toISOString() }));
      const proc = spawn(process.execPath, [child], { cwd: ROOT, detached: true, stdio: 'ignore',
        env: { ...process.env, [JOB_ID_ENV]: id, [JOB_ATTEMPT_ENV]: String(rec.job.attempts), OPERATION_RUNS_DIR: store.dir } });
      proc.unref();
      pids.push(proc.pid);
      let extractor = 0;
      for (let i = 0; i < 400 && !(extractor && store.read(id)?.job.handle); i++) {
        await sleep(25);
        extractor = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) || 0 : 0;
      }
      if (!extractor) return { violations: ['extractor never started'] };
      pids.push(extractor);
      const out = await reattachTick({ store, kinds: HEALTH_WATCH_JOB_KINDS, maxConcurrent: 1, deadlineAt: () => 0,
        observation: { now: Date.now(), slept: false, gapMs: 0 }, launch: () => null });
      for (let i = 0; i < 40 && alive(extractor); i++) await sleep(25);
      if (alive(extractor)) violations.push('extractor subprocess outlived the deadline stop');
      if (!existsSync(released)) violations.push('lane never released after the deadline stop');
      if (store.read(id).job.status !== 'failed') violations.push(`job left ${store.read(id).job.status}, not failed`);
      log?.(`deadline stop: ${JSON.stringify(out.actions)}; ${violations.length} violations`);
      return { violations };
    } finally {
      for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
      rmSync(root, { recursive: true, force: true });
    }
  },
  judge(report) { return report.violations; },
};
