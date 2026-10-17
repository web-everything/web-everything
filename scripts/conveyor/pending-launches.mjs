/**
 * @file scripts/conveyor/pending-launches.mjs
 * @description 78b — non-blocking builder/prepare launches. A launch spawns `run.mjs dispatch-lane` DETACHED, records
 *   `{num, kind, attempt, pid, startedAt, outFile}` and returns at once; a LATER tick settles it. The daemon keeps the
 *   item's claim while a launch is pending and only releases it when the launch is settled as a failure.
 *
 *   Settle rules (pure over injected `isPidAlive`/`kill`/`now`):
 *   - pid alive, younger than the timeout  → `pending`
 *   - pid alive, older than the timeout    → kill it, failure `launch-timeout`
 *   - pid dead, output file has content    → the caller's `readOutcome(text)` decides (launched / refused / failed)
 *   - pid dead, no output                  → failure `launch-died`
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactSpawnText } from '../lib/describe-spawn-failure.mjs';

export const LAUNCH_TIMEOUT_MS = 15 * 60_000;
export const PENDING_LAUNCHES_DIRNAME = 'build-dispatch-launches';

const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
const recordPath = (root, id) => join(root, `${id}.pending.json`);

/** Spawn `node <argv>` detached, stdout/stderr to files, and persist the pending record. Never waits. */
export function startDetachedLaunch({ root, num, kind, base = null, attempt = new Date().toISOString(), argv, env, cwd, workDir, spawn = nodeSpawn, now = Date.now }) {
  mkdirSync(root, { recursive: true });
  const id = `${safe(num)}-${safe(kind)}-${safe(attempt)}`;
  const outFile = join(root, `${id}.out`);
  const errFile = join(root, `${id}.err`);
  const out = openSync(outFile, 'w');
  const err = openSync(errFile, 'w');
  let child;
  try {
    child = spawn('node', argv, { cwd, env, detached: true, stdio: ['ignore', out, err] });
    child.unref?.();
  } finally { closeSync(out); closeSync(err); }
  const record = { id, num: String(num), kind, base, attempt, pid: child?.pid ?? null, startedAt: new Date(now()).toISOString(), outFile, errFile, workDir: workDir ?? null };
  writeFileSync(recordPath(root, id), JSON.stringify(record), { mode: 0o600 });
  return record;
}

export function listPendingLaunches(root) {
  let names = [];
  try { names = readdirSync(root).filter((n) => n.endsWith('.pending.json')); } catch { return []; }
  const rows = [];
  for (const n of names) { try { rows.push(JSON.parse(readFileSync(join(root, n), 'utf8'))); } catch { /* torn record: ignored */ } }
  return rows;
}

const read = (p) => { try { return existsSync(p) ? readFileSync(p, 'utf8') : ''; } catch { return ''; } };
// Scrub the complete diagnostic before flattening/cutting can hide a credential's prefix.
const excerpt = (path, cap) => {
  let text = read(path);
  // An envelope escapes quotes inside error strings. Scrub decoded leaves before re-encoding,
  // or a quoted env credential can survive in the excerpt after the parser already scrubbed it.
  try { text = JSON.stringify(JSON.parse(text), (_key, value) => typeof value === 'string' ? redactSpawnText(value) : value); }
  catch {
    // Partial envelopes and JSON followed by extra log lines cannot be decoded safely. Do not
    // re-publish escaped or truncated credentials through the diagnostic fallback.
    if (/^\s*[\[{]/.test(text) || text.includes('\\"')) text = '<unparseable structured diagnostic>';
  }
  return redactSpawnText(text).replace(/\s+/g, ' ').trim().slice(0, cap);
};

/**
 * Settle every pending launch. Returns `{pending: record[], settled: [{record, outcome}]}`. `outcome` is the
 * `readOutcome` result shape (`{dispatching, reason, ...}`); settled records and their files are removed.
 */
export function settleLaunches({ root, readOutcome, isPidAlive, kill = (pid) => process.kill(pid, 'SIGTERM'), now = Date.now, timeoutMs = LAUNCH_TIMEOUT_MS }) {
  const pending = [];
  const settled = [];
  for (const record of listPendingLaunches(root)) {
    const alive = record.pid != null && isPidAlive(record.pid);
    const age = now() - Date.parse(record.startedAt);
    let outcome = null;
    if (alive && !(age > timeoutMs)) { pending.push(record); continue; }
    if (alive) {
      try { kill(record.pid); } catch { /* already gone */ }
      outcome = { dispatching: false, reason: `launch-timeout: dispatch-lane still running after ${Math.round(timeoutMs / 60_000)} minutes; killed` };
    } else {
      const text = read(record.outFile);
      outcome = text.trim()
        ? readOutcome(text)
        : { dispatching: false, reason: `launch-died: dispatch-lane exited with no output (${excerpt(record.errFile, 300) || 'no stderr'})` };
    }
    // Keep a bounded excerpt of what the child actually printed, so an unexplained failure is diagnosable.
    if (!outcome.dispatching) outcome = { ...outcome, reason: `${redactSpawnText(outcome.reason ?? 'not dispatched')} [stdout: ${excerpt(record.outFile, 300) || 'empty'}] [stderr: ${excerpt(record.errFile, 200) || 'empty'}]` };
    settled.push({ record, outcome });
    for (const p of [record.outFile, record.errFile, recordPath(root, record.id)]) { try { rmSync(p, { force: true }); } catch { /* best effort */ } }
    if (record.workDir) { try { rmSync(record.workDir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
  return { pending, settled };
}
