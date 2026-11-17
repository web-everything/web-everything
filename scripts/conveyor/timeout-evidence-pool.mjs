/** Bounded synchronous child pool for the existing timeout evidence collector. */
import { readFileSync, readSync, writeFileSync, statSync, mkdtempSync, rmSync, openSync, closeSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { URL as NodeURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { readSettings } from '../lib/settings-files.mjs';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { ghThrottleLockRoot, resolveGhCap, acquireGhSlotSync, releaseGhSlotSync } from '../lib/gh-throttle.mjs';
import { randomUUID } from 'node:crypto';

// Unlike runGhSync, this round trip must never fail open. Busy slots also select serial.
export function probeTimeoutEvidenceThrottle(env = process.env) {
  const lockRoot = ghThrottleLockRoot(undefined, env), cap = resolveGhCap(env);
  const owner = `timeout-evidence-probe-${process.pid}-${randomUUID()}`;
  mkdirSync(lockRoot, { recursive: true });
  let acquired, released;
  try {
    acquired = acquireGhSlotSync({ lockRoot, cap, owner, timeoutMs: 0 }).ok === true;
  } finally {
    released = releaseGhSlotSync({ lockRoot, cap, owner }).released === true;
  }
  return acquired && released;
}

const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const validConcurrency = v => Number.isInteger(v) && v >= 1 && v <= 8;
export function resolveTimeoutEvidenceConcurrency({ env = process.env, settings = readSettings(), platform } = {}) {
  const r = cascadePolicy('ci', settings?.ci, {
    standard: { timeoutEvidenceConcurrency: 4 }, platform, env,
    envValues: { timeoutEvidenceConcurrency: env.WE_CI_TIMEOUT_EVIDENCE_CONCURRENCY === undefined
      ? undefined : Number(env.WE_CI_TIMEOUT_EVIDENCE_CONCURRENCY) },
    valid: { timeoutEvidenceConcurrency: validConcurrency },
  });
  return { value: r.value.timeoutEvidenceConcurrency, source: r.sources.timeoutEvidenceConcurrency };
}

// A reaped wrapper may remain a zombie while this synchronous parent blocks its event loop.
// Zombies cannot retain gh descendants; count only executable members of the process group.
function workerGroupAlive(pid) {
  return String(execFileSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024 }))
    .split('\n').some(line => { const [group, state] = line.trim().split(/\s+/); return Number(group) === pid && state && !state.startsWith('Z'); });
}
const WORKER = `
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { probeTimeoutEvidenceThrottle } from ${JSON.stringify(new NodeURL('./timeout-evidence-pool.mjs', import.meta.url).href)};
import { readTimeoutEvidence } from ${JSON.stringify(new NodeURL('./reconcile-pass.mjs', import.meta.url).href)};
const [input, output] = process.argv.slice(1);
let degraded = false;
const stderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...args) => {
  if (/gh-throttle:.*(?:fail-open|running this call ungated)/.test(String(chunk))) {
    degraded = true;
    stderrWrite(chunk, ...args);
    reportFailure(); // Stop inside the warning, before the throttle can run ungated.
  }
  return stderrWrite(chunk, ...args);
};
const failure = () => ({ workerError: true, ...(degraded ? { reason: 'throttle-degraded' } : {}) });
function reportFailure() {
  try {
    writeFileSync(output + '.tmp', JSON.stringify(failure()));
    renameSync(output + '.tmp', output);
  } catch {}
  process.exit(1);
}
try {
  if (probeTimeoutEvidenceThrottle() !== true) { degraded = true; reportFailure(); }
} catch { degraded = true; reportFailure(); }
try {
  const { pr, repo } = JSON.parse(readFileSync(input, 'utf8'));
  const value = readTimeoutEvidence(pr, { repo });
  writeFileSync(output + '.tmp', JSON.stringify(degraded ? failure() : { value }));
  renameSync(output + '.tmp', output);
  process.exit(0);
} catch { reportFailure(); }
`;

// Runs inside the wrapper's detached group, independently of the blocking planner.
const WATCHDOG = `
import { existsSync, readdirSync, rmSync } from 'node:fs';
const [planner, group, folder, expires, output] = process.argv.slice(1);
const tick = () => {
  let orphan = false;
  try { process.kill(Number(planner), 0); } catch (error) { orphan = error.code === 'ESRCH'; }
  if (!orphan && Date.now() < Number(expires) && !existsSync(output + '.done')) return;
  try {
    rmSync(output + '.watchdog', { force: true });
    if (orphan && !readdirSync(folder).some(name => name.endsWith('.watchdog'))) {
      rmSync(folder, { recursive: true, force: true });
    }
  } catch (error) { if (error.code !== 'ENOENT') console.error('timeout-evidence watchdog cleanup:', error.message); }
  finally { process.kill(-Number(group), 'SIGKILL'); }
};
setInterval(tick, 1000);
tick();
`;
const WRAPPER = `
planner=$PPID
trap 'exit 143' TERM; trap 'exit 130' INT; trap 'exit 129' HUP
trap 'code=$?; printf "%s" "$code" > "$7.done"; exec /bin/sleep 180' 0
"$1" --input-type=module -e "$3" "$planner" "$$" "$5" "$4" "$7" &
"$1" --input-type=module -e "$2" "$6" "$7"
`;

/** No pipes: the parent blocks without servicing Node's stream/event loop. Undefined slots fall back serially. */
export function runTimeoutEvidencePool(prs, { repo, concurrency = 4, deadlineMs = 180_000,
  probe = probeTimeoutEvidenceThrottle, launch = spawn, remove = rmSync, env = process.env, groupAlive = workerGroupAlive, now = Date.now, pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
} = {}) {
  const results = new Array(prs.length), active = new Map(), stderrPaths = [];
  const limit = Math.min(validConcurrency(concurrency) ? concurrency : 1, resolveGhCap(env));
  if (limit === 1) return results;
  try {
    if (probe(env) !== true) throw new Error('unusable throttle');
  } catch {
    console.error('timeout-evidence: throttle probe failed, serial');
    return results; // The caller's existing concurrency-1 reader fills every missing slot.
  }
  let folder;
  const kill = child => {
    if (!Number.isInteger(child?.pid) || child.pid <= 0) return;
    try {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error; }
      const until = Date.now() + 2000;
      while (groupAlive(child.pid)) {
        if (Date.now() >= until) throw new Error('worker process group is still alive');
        pause(10);
      }
    } catch (cause) {
      throw Object.assign(new Error('timeout-evidence worker group cleanup failed; operator cleanup required', { cause }),
        { code: 'TIMEOUT_EVIDENCE_CLEANUP_FAILED' });
    }
  };
  try {
    folder = mkdtempSync(join(tmpdir(), 'timeout-evidence-'));
    const deadline = now() + deadlineMs;
    const expires = Date.now() + Math.max(0, deadlineMs) + 5000;
    let next = 0, degraded = false;
    const inspect = () => {
      for (const entry of active.values()) {
        const { output, stderrPath } = entry;
        // Read only new stderr, retaining overlap for a warning split across writes.
        const size = statSync(stderrPath).size;
        if (size > MAX_RESULT_BYTES) { degraded = true; return; }
        if (size > (entry.stderrOffset ?? 0)) {
          const fd = openSync(stderrPath, 'r');
          try {
            const start = Math.max(0, (entry.stderrOffset ?? 0) - 256), bytes = Buffer.alloc(size - start);
            readSync(fd, bytes, 0, bytes.length, start);
            if (/gh-throttle:.*(?:fail-open|running this call ungated)/.test(bytes.toString('utf8'))) degraded = true;
            entry.stderrOffset = size;
          } finally { closeSync(fd); }
        }
        if (existsSync(output) && statSync(output).size <= MAX_RESULT_BYTES) {
          try {
            const row = JSON.parse(readFileSync(output, 'utf8'));
            if (row.workerError && row.reason === 'throttle-degraded') degraded = true;
          } catch { /* Incomplete output remains a serial-fallback slot. */ }
        }
        if (degraded) return;
      }
    };
    while ((!degraded && next < prs.length || active.size) && now() < deadline) {
      while (!degraded && next < prs.length && active.size < limit && now() < deadline) {
        inspect();
        if (degraded) break;
        const index = next++, input = join(folder, `${index}.input.json`), output = join(folder, `${index}.result.json`);
        let stdout, stderr;
        try {
          writeFileSync(input, JSON.stringify({ pr: prs[index], repo }));
          stdout = openSync(join(folder, `${index}.stdout`), 'w');
          stderr = openSync(join(folder, `${index}.stderr`), 'w');
          stderrPaths.push(join(folder, `${index}.stderr`));
          writeFileSync(output + '.watchdog', '');
          const child = launch('/bin/sh', ['-c', WRAPPER, 'timeout-worker', process.execPath, WORKER, WATCHDOG, String(expires), folder, input, output], {
            detached: true, env, stdio: ['ignore', stdout, stderr],
          });
          child.on('error', () => {});
          if (child.pid) active.set(index, { child, output, stderrPath: join(folder, `${index}.stderr`) });
          else rmSync(output + '.watchdog', { force: true });
        } catch { rmSync(output + '.watchdog', { force: true }); /* This slot falls back to the in-process reader. */ }
        finally { if (stdout !== undefined) closeSync(stdout); if (stderr !== undefined) closeSync(stderr); }
      }
      inspect();
      if (degraded) break; // finally kills and verifies every active group before serial reads.
      for (const [index, { child, output }] of active) {
        if (existsSync(output) || existsSync(output + '.done')) {
          try {
            if (statSync(output).size <= MAX_RESULT_BYTES) {
              const row = JSON.parse(readFileSync(output, 'utf8'));
              if (row.workerError && row.reason === 'throttle-degraded') degraded = true;
              const value = row.value ?? row;
              if (typeof value?.eligible === 'boolean') {
                results[index] = value;
              }
            }
          } catch { /* Invalid output falls back serially. */ }
          kill(child);
          rmSync(output + '.watchdog', { force: true });
          active.delete(index);
        }
      }
      if (active.size) pause(20);
    }
  } catch { /* Unavailable worker infrastructure falls back serially. */ }
  finally {
    let cleanupError;
    try {
      for (const { child } of active.values()) {
        try { kill(child); } catch (error) { cleanupError ??= error; }
      }
      if (cleanupError) throw cleanupError;
    } finally {
      if (folder) {
        for (const path of stderrPaths) {
          let fd;
          try {
            fd = openSync(path, 'r');
            const size = statSync(path).size, tail = Buffer.alloc(Math.min(size, 4096));
            const bytes = readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length));
            if (bytes) console.error('timeout-evidence worker stderr:', stripVTControlCharacters(tail.subarray(0, bytes).toString('utf8')).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''));
          } catch (error) { console.error(`timeout-evidence worker stderr: read failed: ${error.message}`); }
          finally { if (fd !== undefined) closeSync(fd); }
        }
        try { remove(folder, { recursive: true, force: true }); }
        catch (error) { console.error(`timeout-evidence: temp dir cleanup failed: ${error.message}`); }
      }
    }
  }
  return results;
}
