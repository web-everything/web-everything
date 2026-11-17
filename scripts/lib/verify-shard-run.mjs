import * as nodeFs from 'node:fs';
import { spawn as nodeSpawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir as nodeTmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readRemoteReport, shouldConfirmRemoteRed, phaseRunLocation } from './verify-remote-routing.mjs';
import { verificationInfrastructureFailure } from './lane-verify.mjs';
import { boundFailureDetails } from './verify-failures.mjs';
import { SHARD_UNSETTLED_EXIT } from './verify-exit-codes.mjs';
export { SHARD_UNSETTLED_EXIT } from './verify-exit-codes.mjs';
import { startTreeWatchdog } from './tree-watchdog.mjs';
import { cascadePolicy } from './policy-cascade.mjs';
import { routeNeedsGit } from '../readiness/needs-git-route.mjs';
import { acquireSlotBlocking, MAX_RUN_WAIT_MS, releaseOwnedSlot, admissionLockRoot, resolveCap, ADMISSION_HELD_ENV } from '../readiness/heavy-admission.mjs';

const positive = n => Number.isSafeInteger(n) && n > 0;
// Gate arguments use --key=value. Also preserve ordinary two-token Vitest options;
// boolean switches must never consume the following test file.
const booleans = new Set(['--passWithNoTests', '--run', '--watch', '--coverage', '--silent', '--globals', '--isolate', '--no-isolate', '--no-file-parallelism', '--fileParallelism']);
const HEAVY_ADMISSION_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'readiness', 'heavy-admission.mjs');

export function shardRunArgv(files, flags) {
  return ['npx', 'vitest', 'run', ...files, ...flags, '--reporter=json'];
}

export function splitVitestArgs(argv, count) {
  if (!positive(count) || argv.slice(0, 3).join(' ') !== 'npx vitest run') throw Error('expected npx vitest run and a positive shard count');
  const files = [], flags = [];
  for (let i = 3; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) files.push(arg);
    else {
      if (/^--(?:outputFile|reporter)(?:[.=]|$)/.test(arg)) throw Error('report options are owned by verify-shard');
      flags.push(arg);
      if (!arg.includes('=') && !booleans.has(arg)) {
        if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw Error(`missing option value: ${arg}`);
        flags.push(argv[++i]);
      }
    }
  }
  if (!files.length || new Set(files).size !== files.length) throw Error('expected nonempty unique file list');
  const k = Math.min(count, files.length), shards = [];
  let offset = 0;
  for (let i = 0; i < k; i++) {
    const size = Math.floor(files.length / k) + (i < files.length % k ? 1 : 0);
    shards.push(files.slice(offset, offset += size));
  }
  return { shards, flags };
}

function inventoryPath(name, cwd, receiptId) {
  // Rebase only paths belonging to the completed remote run.
  const remote = /^\/srv\/forge-exec\/(?:slot-[1-9]\d*\/)?(r-[a-f0-9]{32})\/work\/(.+)$/.exec(name);
  if (remote && remote[2].split('/').some(part => part === '.' || part === '..')) throw Error('invalid remote inventory path');
  return resolve(cwd, remote && remote[1] === receiptId ? remote[2] : name);
}

export function inventoryVerdict(text, files, cwd = process.cwd(), { receiptId } = {}) {
  try {
    const report = JSON.parse(text);
    if (!Array.isArray(report.testResults)) return 'INVENTORY-INCOMPLETE';
    const results = new Map(report.testResults.map(r => [inventoryPath(r.name, cwd, receiptId), r]));
    const assigned = files.map(f => results.get(resolve(cwd, f)));
    // A suite reported but skipped/pending is not execution evidence.
    if (assigned.some(r => !r || !['passed', 'failed'].includes(r.status)
      || !Array.isArray(r.assertionResults) || !r.assertionResults.some(a => ['passed', 'failed'].includes(a.status)))) return 'INVENTORY-INCOMPLETE';
    return report.success === false || assigned.some(r => r.status !== 'passed'
      || r.assertionResults.some(a => a.status === 'failed')) ? 'FAIL' : 'PASS';
  } catch { return 'INVENTORY-INCOMPLETE'; }
}

export const SHARD_REPORT_MAX_BYTES = 8 * 1024 * 1024;
// Vitest's JSON reporter prints one JSON line. npm/install chatter may precede
// it; missing, oversized or ambiguous inventory remains incomplete evidence.
export function streamedInventory(stdout) {
  if (Buffer.byteLength(stdout) > SHARD_REPORT_MAX_BYTES) return null;
  const reports = [];
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    try { if (Array.isArray(JSON.parse(line).testResults)) reports.push(line); } catch { return null; }
  }
  return reports.length === 1 ? reports[0] : null;
}

// Streams output without retaining an unbounded child buffer. A partial line is
// bounded too, so even a child printing without newlines remains observable.
export function executeShard({ command, args, env, cwd, timeoutMs, prefix, log, report }, {
  spawn = nodeSpawn, startWatchdog = startTreeWatchdog,
} = {}) {
  return new Promise(resolveResult => {
    let child, watchdog, settled = false, bytes = 0, overflow = false;
    const chunks = [];
    const finish = async result => {
      if (settled) return;
      settled = true;
      const timedOut = result.timedOut || watchdog?.fired();
      if (timedOut) await watchdog?.settled();
      await watchdog?.stop();
      resolveResult({ ...(timedOut ? { exitCode: 124, timedOut: true } : result),
        ...(report ? { reportText: overflow ? null : streamedInventory(Buffer.concat(chunks).toString('utf8')) } : {}) });
    };
    try {
      const marker = `WE_VERIFY_SHARD_RUN=${randomUUID()}`;
      child = spawn(command, args, { cwd, env: { ...(env ?? process.env), WE_VERIFY_SHARD_RUN: marker.split('=')[1] },
        detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.on('data', chunk => {
        if (!report || overflow) return;
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > SHARD_REPORT_MAX_BYTES) {
          overflow = true; chunks.length = 0;
          log(`${prefix}inventory capture exceeded ${SHARD_REPORT_MAX_BYTES} bytes; rerun the affected selection\n`);
        }
        else chunks.push(buffer);
      });
      for (const stream of [child.stdout, child.stderr]) {
        let pending = '';
        stream?.on('data', chunk => {
          pending += String(chunk).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
          while (pending.includes('\n') || pending.length >= 8192) {
            const end = pending.includes('\n') ? Math.min(pending.indexOf('\n') + 1, 8192) : 8192;
            log(`${prefix}${pending.slice(0, end).replace(/\n$/, '')}\n`); pending = pending.slice(end);
          }
        });
        stream?.on('end', () => { if (pending) log(`${prefix}${pending}\n`); });
      }
      child.once('error', () => finish({ exitCode: 1 }));
      child.once('close', (exitCode, signal) => finish({ exitCode, signal }));
      // The child inherits the supervisor's group (including SIGKILL). The
      // separate watchdog thread can kill only this shard even if output blocks
      // the wrapper's event loop. Its unique marker also catches escaped workers.
      if (Number.isInteger(child.pid)) watchdog = startWatchdog({ pid: child.pid, timeoutMs,
        kill: { marker, outputFds: [child.stdout?._handle?.fd, child.stderr?._handle?.fd].filter(Number.isInteger) },
        onFire: () => finish({ exitCode: 124, timedOut: true }) });
    } catch { finish({ exitCode: 1 }); }
  });
}

async function acquireLocalDefault({ cwd, env, remainingMs }) {
  const options = { lockRoot: admissionLockRoot(cwd, env), cap: resolveCap(env, cwd), owner: cwd };
  const acquired = await acquireSlotBlocking({ ...options, env, kind: 'vitest', ceilingMs: remainingMs,
    canDefer: true, waitMs: remainingMs, log: m => process.stderr.write(m) });
  return { ...acquired, options };
}

// Which of `files` does vitest's own config discover? (null = unknown: keep every file, fail closed.)
// A selected path the config excludes (e.g. a trial directory) can never execute under ANY run, local or CI; it is
// named loudly and dropped instead of turning every run red, while every runnable file still has to run and pass.
const VITEST_SELECT_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'readiness', 'forge-vitest-select.mjs');
const canonical = p => { try { return nodeFs.realpathSync(p); } catch { return resolve(p); } };
function discoverDefault({ files, cwd }) {
  try {
    const out = execFileSync(process.execPath, [VITEST_SELECT_SCRIPT, JSON.stringify({ options: { watch: false, run: true }, filters: files })],
      { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const found = JSON.parse(out);
    return Array.isArray(found) ? new Set(found.map(f => canonical(String(f)))) : null;
  } catch { return null; }
}

export const LOCAL_SHARD_WAIT_STANDARD_MS = 15 * 60_000;
/** verify.localShardWaitMs: how long a shard that must run LOCALLY may wait for host load / a slot (standard → platform → env). */
export function resolveLocalShardWait(env = process.env) {
  const raw = env?.WE_VERIFY_LOCAL_SHARD_WAIT_MS;
  const valid = v => Number.isSafeInteger(v) && v >= 1 && v <= MAX_RUN_WAIT_MS;
  const c = cascadePolicy('verify', undefined, { env, standard: { localShardWaitMs: LOCAL_SHARD_WAIT_STANDARD_MS },
    envValues: { localShardWaitMs: raw != null && /^\d+$/.test(String(raw).trim()) ? Number(raw) : undefined },
    valid: { localShardWaitMs: valid }, log: () => {} });
  const ms = c.value?.localShardWaitMs;
  return valid(ms) ? { ms, source: c.sources?.localShardWaitMs ?? 'standard' } : { ms: LOCAL_SHARD_WAIT_STANDARD_MS, source: 'standard' };
}
const needsGitDefault = ({ argv, cwd }) => { try { return routeNeedsGit({ argv, cwd }).local === true; } catch { return false; } };

export async function runShards({ argv, shards: count, parallel, budgetMs }, deps = {}) {
  const { fs = nodeFs, now = Date.now, tmpdir = nodeTmpdir, log = s => process.stdout.write(s),
    env = process.env, cwd = process.cwd(), execute = executeShard,
    discover = discoverDefault, needsGit = needsGitDefault, acquireLocal = acquireLocalDefault, releaseLocal = slot => releaseOwnedSlot(slot.options) } = deps;
  let directory;
  try {
    if (!positive(parallel) || !Number.isSafeInteger(budgetMs) || budgetMs < 0) throw Error('invalid parallelism or budget');
    const planned = splitVitestArgs(argv, 1).shards.flat();
    const found = planned.length ? discover({ files: planned, cwd }) : null;
    let excluded = found ? planned.filter(f => !found.has(canonical(resolve(cwd, f)))) : [];
    // Discovery that rejects EVERY selected file is more likely a path/config mismatch than a fully excluded selection:
    // keep them all so any file that really cannot run shows up as incomplete inventory instead of a vacuous green.
    if (excluded.length === planned.length) excluded = [];
    if (excluded.length) {
      log(`verify-shards: NOTE ${excluded.length} selected file(s) are excluded by the vitest config (never runnable here or in CI), not run: ${excluded.join(' ')}\n`);
      argv = argv.filter(a => !excluded.includes(a));
    }
    const { shards, flags } = splitVitestArgs(argv, Math.max(1, Math.min(count, planned.length - excluded.length)));
    const localWait = resolveLocalShardWait(env);
    log(`verify-shards: verify.localShardWaitMs=${localWait.ms} (${localWait.source})\n`);
    const deadline = now() + budgetMs, results = new Array(shards.length);
    directory = fs.mkdtempSync(join(tmpdir(), 'verify-shards-'));
    let next = 0, infraExit = 0, stopLaunching = false, failureBeforeInfra = false;
    // The slot helpers identify holders by process. Serialize confirmation in
    // this process so one confirmation cannot release another's slot.
    let localTail = Promise.resolve();
    const remaining = () => Math.max(0, deadline - now());
    async function worker() {
      while (next < shards.length && !stopLaunching) {
        const index = next++, files = shards[index], started = now();
        const remoteReport = join(directory, `${index}.remote.jsonl`);
        // `npx vitest` / `npm run` put node_modules/.bin on PATH for the shell; a bare node child does not.
        const childEnv = { ...env, WE_VERIFY_REMOTE_REPORT: remoteReport, PATH: `${join(cwd, 'node_modules', '.bin')}:${env.PATH ?? ''}` };
        delete childEnv[ADMISSION_HELD_ENV];
        let lastResult = null, observedFailure = false, loadDeferred = false;
        let observedUnsettledExit = false, retryReportsPassed = true;
        async function attempt(local, attemptFiles = files, retry = '') {
          if (!remaining()) return 'NOT-RUN';
          const report = join(directory, `${index}.${retry}${local ? 'local' : 'initial'}.json`);
          // Preserve the npx command class through admission. JSON travels on
          // stdout through the existing SSH stream; no remote file is left behind
          // for finish() to delete before the inventory can be retrieved.
          const args = shardRunArgv(attemptFiles, flags);
          const attemptRemoteReport = retry ? join(directory, `${index}.${retry}remote.jsonl`) : remoteReport;
          const attemptEnv = { ...childEnv, WE_VERIFY_REMOTE_REPORT: attemptRemoteReport };
          // A shard that must run here (needs-git) cannot go to Forge, so it queues for host load / a slot instead of
          // deferring at once. Bounded by the verify budget; a shard still without a slot then exits 75 as before.
          const mustRunLocal = !local && needsGit({ argv: args, cwd });
          // The watchdog (timeoutMs) is the whole remaining budget, so a wait equal to it would let the watchdog fire as
          // admission gives up (exit 124 instead of 75). Spend at most half the remaining budget queueing, leaving the
          // other half as headroom for the deferral to return 75 (or for the shard to run once admitted).
          const waitMs = mustRunLocal ? Math.max(1, Math.min(localWait.ms, Math.floor(remaining() / 2))) : 0;
          const result = await execute({ command: local ? 'npx' : 'node',
            args: local ? args.slice(1) : [HEAVY_ADMISSION_SCRIPT, 'run', ...(mustRunLocal ? [`--wait-ms=${waitMs}`] : []), '--', ...args],
            files: attemptFiles, report, remoteReport: attemptRemoteReport, cwd, env: local ? { ...attemptEnv, [ADMISSION_HELD_ENV]: '1' } : attemptEnv,
            timeoutMs: remaining(), prefix: `[verify-shard ${index + 1}/${shards.length}] `, log });
          lastResult = result;
          // Passing split inventory cannot explain an earlier admission/child exit 75.
          observedUnsettledExit ||= result.exitCode === SHARD_UNSETTLED_EXIT;
          // A waited deferral ran nothing: splitting the shard cannot help and would only queue for another full wait,
          // spending the verify budget until the shard reports 124 instead of the contractual 75.
          if (waitMs > 0 && result.exitCode === SHARD_UNSETTLED_EXIT) loadDeferred = true;
          if (waitMs > 0 && result.exitCode === SHARD_UNSETTLED_EXIT) log(`verify-shard ${index + 1}/${shards.length}: host-load deferral (waited up to ${Math.round(waitMs / 1000)}s for a local slot)\n`);
          if (result.timedOut || result.exitCode === 124) return 'TIMEOUT';
          if (verificationInfrastructureFailure(result) && result.exitCode !== SHARD_UNSETTLED_EXIT) {
            infraExit ||= result.signal ? 137 : result.exitCode;
            failureBeforeInfra ||= observedFailure;
            if (observedFailure) log(`verify-shard ${index + 1}/${shards.length}: retry infrastructure failure; retaining observed test failure\n`);
            return 'FAIL';
          }
          let inventory, reportText;
          try {
            reportText = Object.hasOwn(result, 'reportText') ? result.reportText : fs.readFileSync(report, 'utf8');
            const location = local ? {} : phaseRunLocation(readRemoteReport(attemptRemoteReport, (path, encoding) => fs.readFileSync(path, encoding)));
            inventory = inventoryVerdict(reportText, attemptFiles, cwd, location);
          }
          catch { inventory = 'INVENTORY-INCOMPLETE'; }
          // Retain real failures from every attempt, including complete remote
          // inventory followed by an incomplete local confirmation.
          observedFailure ||= inventory === 'FAIL';
          // Preserve nonzero evidence even when the remote inventory is complete
          // and passing: a later incomplete confirmation must not forget this exit.
          observedFailure ||= result.exitCode !== 0 && result.exitCode !== SHARD_UNSETTLED_EXIT;
          try {
            const report = JSON.parse(reportText);
            if (retry) retryReportsPassed &&= Array.isArray(report?.testResults) && report.testResults.length > 0
              && report.testResults.every(r => Array.isArray(r?.assertionResults) && r.assertionResults.length > 0
                && r.assertionResults.every(a => a?.status === 'passed'));
            const reportFailed = report?.success === false || report?.numRuntimeErrors > 0
              || report?.numFailedTestSuites > 0 || report?.numFailedTests > 0
              || (Array.isArray(report?.testResults) && report.testResults.some(r => r?.status === 'failed'
                || (Array.isArray(r?.assertionResults) && r.assertionResults.some(a => a?.status === 'failed'))));
            observedFailure ||= reportFailed;
            // A complete inventory cannot pass this attempt's failure evidence.
            if (reportFailed && inventory === 'PASS') inventory = 'FAIL';
            if (reportFailed) {
              // Re-emit bounded identities outside the JSON/prefixed child output so
              // verify-lane's failure collector retains them even if a retry dies.
              const details = boundFailureDetails({ tests: (report?.testResults ?? []).flatMap(r => {
                const failed = (r?.assertionResults ?? []).filter(a => a?.status === 'failed');
                return failed.length ? failed.map(a => ({ file: r.name, name: a.fullName ?? a.title ?? null }))
                  : r?.status === 'failed' ? [{ file: r.name, name: null }] : [];
              }), summary: reportText, truncated: false });
              const clean = text => String(text).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');
              for (const test of details.tests) log(`FAIL ${clean(test.file)}${test.name ? ` > ${clean(test.name)}` : ''}\n`);
              log(`verify-shard ${index + 1}/${shards.length}: observed failure ${clean(details.summary)}\n`);
            }
          } catch {
            if (retry) retryReportsPassed = false;
            /* Unparseable reports contain no observed test failure. */
          }
          if (inventory === 'INVENTORY-INCOMPLETE') return inventory;
          return result.exitCode === 0 && !result.signal && inventory === 'PASS' ? 'PASS' : 'FAIL';
        }
        let status;
        try {
          status = await attempt(false);
          const initiallyIncomplete = status === 'INVENTORY-INCOMPLETE';
          let ranOn = { location: 'unknown' };
          try {
            ranOn = phaseRunLocation(readRemoteReport(remoteReport, (path, encoding) => fs.readFileSync(path, encoding)), { remoteAttempt: true });
          } catch { /* Unknown location cannot authorize replacing a red verdict. */ }
          // Same predicate verify-lane uses: needs a REPORTED remote failure, and a signal, timeout or infrastructure exit
          // (e.g. 137) is never replaced by a local pass.
          if (['FAIL', 'INVENTORY-INCOMPLETE'].includes(status) && lastResult
            && !(lastResult.exitCode === SHARD_UNSETTLED_EXIT && observedFailure)
            && shouldConfirmRemoteRed({ plan: { takeLocalSlot: false }, exitCode: lastResult.exitCode, signal: lastResult.signal,
              timedOut: lastResult.timedOut, ranOn })) {
            log(`verify-shard ${index + 1}/${shards.length}: remote red; confirming locally\n`);
            if (!remaining()) status = 'NOT-RUN';
            else {
              const previous = localTail;
              let unlock;
              localTail = new Promise(resolve => { unlock = resolve; });
              await previous;
              try {
                if (!remaining()) status = 'NOT-RUN';
                else {
                  const slot = await acquireLocal({ cwd, env: childEnv, remainingMs: remaining() });
                  try { status = slot.ok ? await attempt(true) : remaining() ? 'FAIL' : 'NOT-RUN'; }
                  finally { if (slot.ok) releaseLocal(slot); }
                }
              } finally { unlock(); }
            }
          }
          if (status === 'INVENTORY-INCOMPLETE' && loadDeferred) {
            log(`verify-shard ${index + 1}/${shards.length}: host-load deferral; not splitting (no inventory to recover)\n`);
            status = observedFailure ? 'FAIL' : 'UNSETTLED';
          } else if (status === 'INVENTORY-INCOMPLETE') {
            log(`verify-shard ${index + 1}/${shards.length}: INVENTORY-INCOMPLETE; retrying once in ${Math.min(2, files.length)} part(s)\n`);
            const middle = Math.ceil(files.length / 2);
            const halves = files.length === 1 ? [files] : [files.slice(0, middle), files.slice(middle)];
            const retried = [];
            const retriedFiles = new Set();
            // One split level only; green requires complete, strictly passed evidence for the whole shard.
            for (const [half, selected] of halves.entries()) {
              const verdict = await attempt(false, selected, `retry-${half + 1}.`);
              retried.push(verdict);
              for (const file of selected) retriedFiles.add(file);
              // A deferred half already spent its wait; the other half would queue for a second full wait.
              if (infraExit || loadDeferred || !['PASS', 'INVENTORY-INCOMPLETE'].includes(verdict)) break;
            }
            const completePass = retried.length === halves.length && retried.every(r => r === 'PASS')
              && !observedFailure && !infraExit && !loadDeferred && !observedUnsettledExit && retryReportsPassed
              && retriedFiles.size === files.length && files.every(file => retriedFiles.has(file));
            status = retried.find(r => ['TIMEOUT', 'NOT-RUN', 'FAIL'].includes(r))
              ?? (observedFailure ? 'FAIL' : completePass ? 'PASS' : 'UNSETTLED');
          }
          // Ordinary complete remote reds remain clearable by local confirmation.
          // Incomplete shards retain their failure evidence even if confirmation passes.
          if (initiallyIncomplete && observedFailure && status === 'PASS') status = 'FAIL';
        } catch (error) { status = 'FAIL'; log(`verify-shard error: ${String(error.message).replace(/[\x00-\x1f\x7f]/g, '')}\n`); }
        // A killed/infrastructure shard must reach the caller as such (its guard refuses to run later phases on it).
        if (status !== 'PASS' && lastResult && lastResult.exitCode !== SHARD_UNSETTLED_EXIT && verificationInfrastructureFailure({ exitCode: lastResult.exitCode, signal: lastResult.signal })) infraExit ||= lastResult.signal ? 137 : lastResult.exitCode;
        if (status === 'TIMEOUT' || infraExit) stopLaunching = true;
        results[index] = status;
        log(`verify-shard ${index + 1}/${shards.length}: ${status} (${files.length} files, ${now() - started} ms)\n`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(parallel, shards.length) }, worker));
    for (let i = 0; i < shards.length; i++) if (results[i] === undefined) { results[i] = 'NOT-RUN'; log(`verify-shard ${i + 1}/${shards.length}: NOT-RUN (stopped after an infrastructure failure or timeout)\n`); }
    if (results.every(r => r === 'PASS')) {
      log(`verify-shards: GREEN (all ${shards.length} shards, ${shards.flat().length} files executed and passed)\n`);
      return 0;
    }
    if (!infraExit && !results.some(r => ['FAIL', 'TIMEOUT', 'NOT-RUN'].includes(r)) && results.includes('UNSETTLED')) {
      log(`verify-shards: UNSETTLED (${results.map((r, i) => `${i + 1}:${r}`).join(', ')}; incomplete inventory after one split retry; retry or wait)\n`);
      return SHARD_UNSETTLED_EXIT;
    }
    log(`verify-shards: RED (${results.map((r, i) => `${i + 1}:${r}`).join(', ')}; inspect shard output and rerun the affected selection)\n`);
    // A later infrastructure exit cannot replace an already observed test verdict
    // and cause verify-lane to discard its recorded failure details.
    if (failureBeforeInfra) return 1;
    if (infraExit > 0 && infraExit < 256 && infraExit !== 124) return infraExit;
    return results.some(r => ['TIMEOUT', 'NOT-RUN'].includes(r)) ? 124 : 1;
  } catch (error) {
    log(`verify-shards: RED (internal error: ${String(error.message).replace(/[\x00-\x1f\x7f]/g, '')})\n`);
    return 1;
  } finally {
    if (directory) { try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* verdict already recorded */ } }
  }
}

export function parseShardCli(args) {
  const separator = args.indexOf('--');
  if (separator !== 3) throw Error('usage: --shards=K --parallel=P --budget-ms=M -- npx vitest run <files> <flags>');
  const options = {};
  for (const arg of args.slice(0, separator)) {
    const match = /^--(shards|parallel|budget-ms)=(\d+)$/.exec(arg);
    if (!match || Object.hasOwn(options, match[1])) throw Error('invalid shard option');
    options[match[1]] = Number(match[2]);
  }
  return { shards: options.shards, parallel: options.parallel, budgetMs: options['budget-ms'], argv: args.slice(separator + 1) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await runShards(parseShardCli(process.argv.slice(2))); }
  catch (error) { process.stderr.write(`verify-shards: RED (${error.message})\n`); process.exitCode = 1; }
}
