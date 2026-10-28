/** Independent behavioral fix-presence probe: a dead owner with unconfirmed group cleanup. */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
const { runPassAsTimedJob } = await import(pathToFileURL(join(root, 'skills-src/conveyor/pass-daemon.mjs')));
const { createJobStore } = await import(pathToFileURL(join(root, 'scripts/lib/daemon-jobs-runtime.mjs')));
const dir = mkdtempSync(join(tmpdir(), 'pass-group-probe-'));
try {
  const store = createJobStore(join(dir, 'jobs'));
  let checked = false;
  const result = await runPassAsTimedJob({
    passName: 'presence-probe', repo: 'fixture/repo', entry: { script: 'unused.mjs' },
  }, {
    root: dir, store, codeSha: 'fixture', snapshot: { materialize() {} },
    readStart: () => 'fixture-start', host: 'fixture-host', probe: () => 'dead',
    reapGroup: () => { checked = true; return false; },
    spawnFn: () => {
      const child = new EventEmitter();
      child.pid = 7000;
      setImmediate(() => { child.emit('exit', 0, null); child.emit('close', 0, null); });
      return child;
    },
    policyOptions: { platform: null, env: {}, tool: { timeoutMs: 1000 } },
    log() {}, alert() {},
  });
  const [record] = store.list().records;
  if (checked && result.outcome === 'quarantined' && record.job.handle && record.job.status === 'running') {
    process.stdout.write('quarantined\n');
  } else process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
