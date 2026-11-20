/** Loaded Forge can publish its confirmed result a minute after the client timeout. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');

// Run in a subprocess so the behavioral fix probe is synchronous for the shared break registry,
// and its virtual timers cannot affect another scenario. No source-text/version heuristic.
export function probeTimeoutCancelWait(root = REPO_ROOT, waitMs) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { runTimeoutCancelWaitCase } from ${JSON.stringify(import.meta.url)};
    console.log(JSON.stringify(await runTimeoutCancelWaitCase(${JSON.stringify(root)}, ${JSON.stringify(waitMs)})));
  `], {encoding:'utf8', timeout:10000, maxBuffer:65536});
  if (child.error || child.status !== 0) return {violations:['timeout probe failed'], detail:child.error?.message ?? child.stderr};
  try { return JSON.parse(child.stdout); }
  catch { return {violations:['timeout probe returned unreadable evidence']}; }
}

export async function runTimeoutCancelWaitCase(root, waitMs) {
  const { mock } = await import('node:test');
  const { runWithRemoteDecision, resolveAdmissionPolicy } = await import(pathToFileURL(join(root,'scripts/readiness/heavy-admission.mjs')));
  const { easternTimestamp } = await import(pathToFileURL(join(root,'scripts/readiness/forge-exec-run.mjs')));
  const scratch = mkdtempSync(join(process.env.TMPDIR, 'soak-forge-cancel-wait-'));
  const turn = () => new Promise(setImmediate);
  const run = 'r-' + 'd'.repeat(32), code = 7;
  let dispatched, aborted = false;
  const ready = new Promise(resolve => { dispatched = resolve; });
  mock.timers.enable({apis:['Date','setTimeout'], now:Date.now()});
  try {
    const pending = runWithRemoteDecision({
      argv:['npx','vitest','run','fixture.test.mjs'], cwd:scratch, lockRoot:join(scratch,'heavy'),
      env:waitMs === undefined ? {} : {WE_HEAVY_TIMEOUT_CANCEL_WAIT_MS:String(waitMs)}, timeoutMs:20,
      policy:resolveAdmissionPolicy({platform:{remote:{enabled:true,mode:'always',maxConcurrent:1}}}),
      hostOverloaded:() => false, loadPerCore:() => 0, log:() => {},
      readTelemetry:async () => ({sampledAtET:easternTimestamp(Date.now()),cores:8,loadPerCore:0.1,
        memFreePct:90,activeRuns:0,recent:[]}),
      remoteExec:({onRun,signal}) => new Promise(resolve => {
        onRun(run);
        signal.addEventListener('abort', () => {
          aborted = true;
          setTimeout(() => resolve({mode:'remote',code,run}), 60000);
        }, {once:true});
        dispatched();
      }),
    });
    // Admission has finished all async setup before advancing the run timeout.
    await ready;
    await turn();
    mock.timers.tick(20);
    await turn();
    const marker = join(scratch,'remote','slot-0.unconfirmed');
    const heldDuringCancel = existsSync(marker) && existsSync(marker+'.run');
    mock.timers.tick(60000);
    await turn();
    const result = await pending;
    const violations = [];
    if (!aborted || !heldDuringCancel) violations.push('timeout did not retain the in-flight slot');
    if (result.exitCode !== code || result.remoteResult?.run !== run) violations.push('late confirmed result lost: '+JSON.stringify(result));
    if (existsSync(marker) || existsSync(marker+'.run')) violations.push('confirmed execution still holds its slot');
    return {violations,exitCode:result.exitCode,heldDuringCancel};
  } finally {
    mock.timers.reset();
    rmSync(scratch,{recursive:true,force:true});
  }
}

export default {
  id:'forge-timeout-cancel-wait-too-short',
  title:'a Forge result confirmed 60 seconds after timeout releases the slot and returns its exit code',
  card:'Forge exit 124 / unconfirmed slots, 2026-11-18',
  fixedBy:{sha:'HEAD',where:'working tree',paths:['scripts/readiness/heavy-admission.mjs']},
  fixPresent(root) { return probeTimeoutCancelWait(root).violations.length === 0; },
  async run() { return probeTimeoutCancelWait(); },
  judge:report => report.violations,
};
