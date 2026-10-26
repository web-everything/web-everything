/** Real detached task owner exits after the tick's live probe, before stopHandle observes it. */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobStore, hostName, probeHandle, readProcStart, reapDeadGroup, reattachTick, stopHandle } from '../../../lib/daemon-jobs-runtime.mjs';
import { defineJobKind, kindRegistry, markClaimed, markLaunching } from '../../../lib/daemon-jobs.mjs';
import { enqueueItemTask } from '../../../lib/daemon-item-tasks.mjs';
import { keepAliveScript } from '../../../lib/test-keepalive.mjs';
import { formatJobHandle } from '../../../operations/job-record.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const value = check();
    if (value) return value;
    await sleep(25);
  }
  throw Error('task owner race probe timed out');
}

export default {
  id: 'task-owner-dies-before-stop',
  title: 'task owner death between probe and stop sweeps descendants before releasing the claim',
  card: 'we:backlog/5754 PR 5966',
  fixedBy: { sha: 'pr-5966-owner-stop-race', where: 'lane/5754-part3', paths: ['scripts/lib/daemon-jobs-runtime.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-jobs-runtime.mjs'), 'utf8').includes("liveness === 'dead' || stopped");
  },
  async run() {
    const violations = [];
    const dir = mkdtempSync(join(tmpdir(), 'task-owner-stop-race-'));
    const parent = spawn(process.execPath, ['-e', [
      `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(keepAliveScript())}], { stdio: 'ignore' });`,
      'console.log(child.pid);', keepAliveScript(),
    ].join('\n')], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '', childPid, swept = false, released = false, stopSignals = 0;
    parent.stdout.on('data', data => { output += data; });
    try {
      childPid = Number(await waitFor(() => output.trim()));
      const procStart = await waitFor(() => readProcStart(parent.pid));
      const now = Date.now(), store = createJobStore(dir);
      const kind = defineJobKind({ kind: 'noop', entry: 'job.mjs' });
      const task = enqueueItemTask({ store, kindDef: kind, repo: 'owner/repo', item: 1, seq: 1, codeSha: 's',
        acting: true, resourceKind: 'build', policyOptions: { platform: null, env: {}, tool: { timeoutMs: 1000 } } });
      const handle = formatJobHandle({ host: hostName(), pid: parent.pid, procStart });
      store.update(task.id, r => markClaimed(markLaunching(r, { at: new Date(now - 1000).toISOString() }),
        { handle, host: hostName(), pid: parent.pid, procStart, at: new Date(now).toISOString() }));
      await reattachTick({ store, kinds: kindRegistry([kind]), maxConcurrent: 1, observation: { now },
        probe: probeHandle, launch: () => null,
        stop: async (h, options) => {
          process.kill(parent.pid, 'SIGKILL');
          await waitFor(() => parent.exitCode !== null || parent.signalCode !== null);
          return stopHandle(h, { ...options, kill: (pid, signal) => { stopSignals++; process.kill(pid, signal); } });
        },
        reapGroup: (h, notAfterMs) => reapDeadGroup(h, { notAfterMs, kill: (pid, signal) => {
          process.kill(pid, signal); swept = true;
        } }),
        releaseTaskClaim: () => {
          released = true;
          if (!swept) violations.push({ invariant: 'claim-released-before-group-sweep', detail: 'descendant left running when exclusion was released' });
        },
      });
      if (!released) violations.push({ invariant: 'no-recovery', detail: 'dead task owner was not recovered' });
      if (stopSignals) violations.push({ invariant: 'race-not-exercised', detail: 'stopHandle observed a live owner' });
      if (swept) await waitFor(() => !readProcStart(childPid));
      if (store.read(task.id).job.status !== 'queued') violations.push({ invariant: 'no-requeue', detail: 'task was not requeued' });
    } catch (error) {
      violations.push({ invariant: 'probe-error', detail: error.message });
    } finally {
      for (const pid of [-parent.pid, childPid, parent.pid]) {
        if (!pid) continue;
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      rmSync(dir, { recursive: true, force: true });
    }
    return { violations };
  },
  judge(report) { return report.violations.map(v => `${v.invariant}: ${v.detail}`); },
};
