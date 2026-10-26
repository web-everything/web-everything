/** A real surviving descendant with injected process timestamps reproduces offline recovery's stale cutoff. */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobStore, hostName, reapDeadGroup, reattachTick } from '../../../lib/daemon-jobs-runtime.mjs';
import { defineJobKind, kindRegistry, markClaimed, markLaunching } from '../../../lib/daemon-jobs.mjs';
import { enqueueItemTask } from '../../../lib/daemon-item-tasks.mjs';
import { keepAliveScript } from '../../../lib/test-keepalive.mjs';
import { formatJobHandle } from '../../../operations/job-record.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function waitFor(check) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(25);
  }
  throw Error('descendant cleanup probe timed out');
}

export default {
  id: 'task-descendant-cleanup-refused',
  title: 'refused descendant cleanup retains task exclusion and slot until the group disappears',
  card: 'we:backlog/5754 PR 5966',
  fixedBy: { sha: 'pr-5966-cleanup-confirmation', where: 'lane/5754-part3', paths: ['scripts/lib/daemon-jobs-runtime.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-jobs-runtime.mjs'), 'utf8').includes('confirmTaskGroupGone');
  },
  async run() {
    const violations = [], observations = [];
    const dir = mkdtempSync(join(tmpdir(), 'task-cleanup-refused-'));
    const parent = spawn(process.execPath, ['-e', [
      `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(keepAliveScript())}], { stdio: 'ignore' });`,
      'console.log(child.pid); child.unref();',
    ].join('\n')], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '', childPid;
    parent.stdout.on('data', data => { output += data; });
    try {
      await waitFor(() => output.trim() && parent.exitCode !== null);
      childPid = Number(output.trim());
      const now = Date.now(), heartbeat = now - 300000, started = heartbeat - 60000;
      const procStart = new Date(started).toUTCString(), store = createJobStore(dir);
      const kind = defineJobKind({ kind: 'noop', entry: 'job.mjs' });
      const enqueue = item => enqueueItemTask({ store, kindDef: kind, repo: 'owner/repo', item, seq: 1, codeSha: 's',
        acting: true, resourceKind: 'build', policyOptions: { platform: null, env: {}, tool: { timeoutMs: 600000 } } });
      const task = enqueue(1);
      enqueue(2);
      const handle = formatJobHandle({ host: hostName(), pid: parent.pid, procStart });
      store.update(task.id, r => markClaimed(markLaunching(r, { at: new Date(started).toISOString() }),
        { handle, host: hostName(), pid: parent.pid, procStart, at: new Date(heartbeat).toISOString() }));
      let released = 0, launched = 0;
      const tick = () => reattachTick({ store, kinds: kindRegistry([kind]), maxConcurrent: 1, observation: { now },
        probe: () => 'dead', launch: () => { launched++; return null; },
        reapGroup: (h, notAfterMs, options) => reapDeadGroup(h, { ...options, notAfterMs,
          readStart: () => null, bootTime: () => started - 60000,
          groupStarts: () => alive(childPid) ? [heartbeat + 120000] : [] }),
        releaseTaskClaim: () => { released++; },
      });
      await tick();
      const observed = { descendantAlive: alive(childPid), released, launched, status: store.read(task.id).job.status };
      observations.push(observed);
      if (!observed.descendantAlive) violations.push({ invariant: 'cutoff-refusal-not-exercised', detail: 'late descendant was killed' });
      if (released || launched || observed.status !== 'running') violations.push({ invariant: 'exclusion-released-with-live-descendant', detail: JSON.stringify(observed) });
      process.kill(-parent.pid, 'SIGKILL');
      await waitFor(() => !alive(-parent.pid));
      await tick();
      if (released !== 1 || store.read(task.id).job.status !== 'queued') violations.push({ invariant: 'recovery-after-cleanup', detail: 'confirmed empty group did not recover exactly once' });
    } catch (error) {
      violations.push({ invariant: 'probe-error', detail: error.message });
    } finally {
      for (const pid of [-parent.pid, childPid, parent.pid]) {
        if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      rmSync(dir, { recursive: true, force: true });
    }
    return { violations, observations };
  },
  judge(report) { return report.violations.map(v => `${v.invariant}: ${v.detail}`); },
};
