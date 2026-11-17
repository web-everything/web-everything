/** Bounded synchronous child pool for the existing timeout evidence collector. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, readSync, writeFileSync, statSync, mkdtempSync, rmSync, openSync, closeSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { readSettings } from '../lib/settings-files.mjs';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { ghThrottleLockRoot, resolveGhCap, acquireGhSlotSync, releaseGhSlotSync, deriveGhCaller } from '../lib/gh-throttle.mjs';
import { randomUUID } from 'node:crypto';

// Unlike runGhSync, machinery errors must never fail open. Busy slots are healthy.
export function probeTimeoutEvidenceThrottle(env = process.env, { acquire = acquireGhSlotSync, release = releaseGhSlotSync } = {}) {
  const lockRoot = ghThrottleLockRoot(undefined, env), cap = resolveGhCap(env);
  const owner = `timeout-evidence-probe-${process.pid}-${randomUUID()}`;
  mkdirSync(lockRoot, { recursive: true });
  let acquired, released;
  try {
    const result = acquire({ lockRoot, cap, owner, timeoutMs: 0 });
    acquired = result.ok === true;
    if (result.error) return false;
  } finally {
    if (acquired) released = release({ lockRoot, cap, owner }).released === true;
  }
  return !acquired || released;
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
// Spawned by path: rebuild's collectRunClosure tracks it; each child loads fresh disk code.
const WORKER = fileURLToPath(new NodeURL('./timeout-evidence-worker.mjs', import.meta.url));

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
"$1" "$2" "$6" "$7"
`;

/** No pipes: the parent blocks without servicing Node's stream/event loop. Undefined slots fall back serially. */
export function runTimeoutEvidencePool(prs, { repo, concurrency = 4, deadlineMs = 180_000,
  task, probe = probeTimeoutEvidenceThrottle, launch = spawn, remove = rmSync, env = process.env, groupAlive = workerGroupAlive, now = Date.now, pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
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
          writeFileSync(input, JSON.stringify({ pr: prs[index], repo, task }));
          stdout = openSync(join(folder, `${index}.stdout`), 'w');
          stderr = openSync(join(folder, `${index}.stderr`), 'w');
          stderrPaths.push(join(folder, `${index}.stderr`));
          writeFileSync(output + '.watchdog', '');
          const child = launch('/bin/sh', ['-c', WRAPPER, 'timeout-worker', process.execPath, WORKER, WATCHDOG, String(expires), folder, input, output], {
            detached: true, env: { ...env, GH_CALLER: deriveGhCaller({}, env) }, // workers share the planner's caller identity and its per-caller throttle allowance
            stdio: ['ignore', stdout, stderr],
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
              const value = task ? row.value : row.value ?? row;
              if (task ? !row.workerError && Object.hasOwn(row, 'value') : typeof value?.eligible === 'boolean') {
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

/** Ordered read-only jobs using the same throttle, process cleanup and conservative setting as timeouts.
 * Missing/failed slots are always read serially; cleanup failure still aborts before starting more IO.
 */
export function pooledReadMap(rows, { read, task, env = process.env, poolRunner = runTimeoutEvidencePool,
  concurrency, log = console.error } = {}) {
  if (!rows.length) return [];
  const setting = resolveTimeoutEvidenceConcurrency({ env });
  const bound = validConcurrency(concurrency) ? concurrency : setting.value;
  try { log(`planner-evidence: ci.timeoutEvidenceConcurrency=${bound} source=${validConcurrency(concurrency) ? 'injected' : setting.source}`); } catch {}
  if (rows.length === 1) return rows.map(read); // A single job cannot benefit from a child pool.
  let results;
  try { results = poolRunner(rows, { concurrency: bound, env, task }); }
  catch (error) { if (error.code === 'TIMEOUT_EVIDENCE_CLEANUP_FAILED') throw error; }
  return rows.map((row, i) => {
    if (results?.[i] != null) return results[i];
    try { log(`planner-evidence: serial-fallback reader=${task?.exportName ?? 'injected'} index=${i}`); } catch {}
    return read(row);
  });
}

/** Tick-owned memo. Never cache absent identity or expose mutable evidence to another phase. */
export function evidenceMemoKey(repo, pr) {
  try {
    if (!repo || !pr?.number) return null;
    const identity = [pr.headRefOid, pr.baseRefName, pr.baseRefOid];
    // Additional diff identifiers are optional, but must be readable when supplied.
    for (const field of ['baseRefSha', 'mergeBase']) {
      if (field in pr) identity.push([field, pr[field]]);
    }
    if (identity.some(value => {
      const id = Array.isArray(value) ? value[1] : value;
      return typeof id !== 'string' || !id.trim();
    })) return null;
    return JSON.stringify([repo, pr.number, identity, pr.statusCheckRollup ?? []]);
  }
  catch { return null; }
}
export function memoEvidence(memo, key, read) {
  if (!memo || !key) return read();
  try { if (memo.has(key)) { const hit = structuredClone(memo.get(key)); if (hit !== undefined) return hit; } } catch { return read(); }
  const value = read();
  try { memo.set(key, structuredClone(value)); } catch { /* Memo failure only costs a read. */ }
  return value;
}

// Async scope covers nested planners (including orphan redispatch) without changing dispatcher identity.
const tickEvidence = new AsyncLocalStorage();
export const withTickEvidence = (memo, run) => tickEvidence.run(memo, run);
export const currentTickEvidence = () => tickEvidence.getStore();
