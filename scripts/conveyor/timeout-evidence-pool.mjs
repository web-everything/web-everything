/** Bounded synchronous child pool for the existing timeout evidence collector. */
import { readFileSync, writeFileSync, statSync, mkdtempSync, rmSync, openSync, closeSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { URL as NodeURL } from 'node:url';
import { readSettings } from '../lib/settings-files.mjs';
import { cascadePolicy } from '../lib/policy-cascade.mjs';

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
import { readTimeoutEvidence } from ${JSON.stringify(new NodeURL('./reconcile-pass.mjs', import.meta.url).href)};
const [input, output] = process.argv.slice(1);
try {
  const { pr, repo } = JSON.parse(readFileSync(input, 'utf8'));
  writeFileSync(output + '.tmp', JSON.stringify({ value: readTimeoutEvidence(pr, { repo }) }));
  renameSync(output + '.tmp', output);
  process.exit(0);
} catch {
  try {
    writeFileSync(output + '.tmp', JSON.stringify({ workerError: true }));
    renameSync(output + '.tmp', output);
  } catch {}
  process.exit(1);
}
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
  launch = spawn, remove = rmSync, env = process.env, groupAlive = workerGroupAlive, now = Date.now, pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
} = {}) {
  const results = new Array(prs.length), active = new Map();
  const limit = validConcurrency(concurrency) ? concurrency : 1;
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
    let next = 0;
    while ((next < prs.length || active.size) && now() < deadline) {
      while (next < prs.length && active.size < limit && now() < deadline) {
        const index = next++, input = join(folder, `${index}.input.json`), output = join(folder, `${index}.result.json`);
        let stdout, stderr;
        try {
          writeFileSync(input, JSON.stringify({ pr: prs[index], repo }));
          stdout = openSync(join(folder, `${index}.stdout`), 'w');
          stderr = openSync(join(folder, `${index}.stderr`), 'w');
          writeFileSync(output + '.watchdog', '');
          const child = launch('/bin/sh', ['-c', WRAPPER, 'timeout-worker', process.execPath, WORKER, WATCHDOG, String(expires), folder, input, output], {
            detached: true, env, stdio: ['ignore', stdout, stderr],
          });
          child.on('error', () => {});
          if (child.pid) active.set(index, { child, output });
          else rmSync(output + '.watchdog', { force: true });
        } catch { rmSync(output + '.watchdog', { force: true }); /* This slot falls back to the in-process reader. */ }
        finally { if (stdout !== undefined) closeSync(stdout); if (stderr !== undefined) closeSync(stderr); }
      }
      for (const [index, { child, output }] of active) {
        if (existsSync(output) || existsSync(output + '.done')) {
          try {
            if (statSync(output).size <= MAX_RESULT_BYTES) {
              const row = JSON.parse(readFileSync(output, 'utf8'));
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
        try { remove(folder, { recursive: true, force: true }); }
        catch (error) { console.error(`timeout-evidence: temp dir cleanup failed: ${error.message}`); }
      }
    }
  }
  return results;
}
