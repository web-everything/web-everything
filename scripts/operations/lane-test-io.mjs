/** @file scripts/operations/lane-test-io.mjs
 * @description Lease a fresh lane and run selected Vitest files through heavy admission. */
import { spawn as spawnChild } from 'node:child_process';
import { constants } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseAcquire, withSignalsDeferred, signalOperation, waitForGroupStop } from '../run-fresh.mjs';
import { LANE_TEST_EFFECT, summarizeVitest } from './lane-test.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LIMIT = 200 * 1024;
const signalCode = signal => 128 + constants.signals[signal];
function bounded(text) {
  const bytes = Buffer.from(text);
  let start = Math.max(0, bytes.length - LIMIT);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}
// This message is emitted by heavy admission itself, only after acquiring a slot.
const receipt = text => /^heavy-command admission: acquired slot-\d+ after waiting \d+ms \(cap=\d+\)\./m.test(text)
  ? true : /^.*heavy-command admission(?: deferred:|-deferred:)/m.test(text) ? false : null;
export async function boundedSpawn(command, args, { cancellation, ...options } = {}) {
  const child = spawnChild(command, args, { ...options, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let output = '';
  let admitted = null;
  let scan = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', b => {
    stdout = bounded(stdout + b);
    output = bounded(output + b);
  });
  child.stderr.on('data', b => {
    scan += b;
    admitted ??= receipt(scan);
    scan = scan.slice(-512);
    output = bounded(output + b);
  });
  if (cancellation) cancellation.child = child;
  try {
    return await new Promise((resolveRun, reject) => {
      child.once('error', reject);
      child.once('close', (status, signal) => resolveRun({ status: signal ? signalCode(signal) : status, signal, stdout, output, admitted }));
      if (cancellation?.signal) signalOperation(child, cancellation.signal);
    });
  } finally {
    if (process.platform !== 'win32' && child.pid) await waitForGroupStop(child.pid);
    if (cancellation) cancellation.child = null;
  }
}
export function createLaneTestSinks({ spawn = boundedSpawn, sleep = (ms, c) => delay(ms, undefined, { signal: c.abort.signal }), root = ROOT, proc = process, log = m => console.error(m) } = {}) {
  return { [LANE_TEST_EFFECT]: async plan => {
    const pool = resolve(root, 'scripts/lane-pool.mjs');
    const session = `${plan.purpose}-${randomUUID()}`;
    let lease;
    let result;
    let cancellationState;
    const code = await withSignalsDeferred(async cancellation => {
      cancellationState = cancellation;
      const call = (cmd, args, cwd = root, env = process.env, cleanup = false) => spawn(cmd, args, { cwd, env, cancellation: cleanup ? undefined : cancellation });
      const checkCancellation = () => {
        if (cancellation.signal) throw new Error('cancelled');
      };
      try {
        const acq = await call(process.execPath, [pool, 'acquire', `--purpose=${plan.purpose}`, `--session=${session}`, '--wait-ms=300000', '--json', `--repo=${root}`]);
        lease = parseAcquire(acq.stdout);
        checkCancellation();
        if (acq.status !== 0 || !lease) throw new Error('refused: could not acquire lane');
        const env = { ...process.env, LANE_SESSION: lease.holder };
        const git = args => {
          checkCancellation();
          return call('git', args, lease.path, env);
        };
        const check = async args => {
          const r = await git(args);
          checkCancellation();
          if (r.status !== 0) throw new Error(`refused: git ${args[0]} failed`);
          return String(r.stdout).trim();
        };
        const isSha = /^[a-f0-9]{40}$/i.test(plan.ref);
        const fetched = await git(['fetch', 'origin', plan.ref]);
        if (isSha) {
          if ((await git(['cat-file', '-e', `${plan.ref}^{commit}`])).status !== 0) await check(['fetch', 'origin', 'main']);
        } else if (fetched.status !== 0) throw new Error(/^[a-f0-9]{7,39}$/i.test(plan.ref) ? 'refused: ref not found; short SHAs require the full 40-character SHA' : 'refused: fetch failed');
        const sha = await check(['rev-parse', '--verify', `${isSha ? plan.ref : 'FETCH_HEAD'}^{commit}`]);
        if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error('refused: invalid resolved sha');
        await check(['reset', '--hard', sha]);
        if (await check(['rev-parse', 'HEAD']) !== sha) throw new Error('refused: HEAD mismatch');
        // Acquire prepared origin/main's dependencies; reconcile only a changed target lockfile.
        const lockDiff = await git(['diff', '--quiet', 'origin/main', sha, '--', 'package-lock.json']);
        checkCancellation();
        if (lockDiff.status !== 0 && lockDiff.status !== 1) throw new Error('refused: lockfile comparison failed');
        if (lockDiff.status === 1) {
          const deps = await call(process.execPath, [resolve(root, 'scripts/lib/lane-pool-deps.mjs')], lease.path, env);
          checkCancellation();
          if (deps.status !== 0) throw new Error('refused: target dependency preparation failed');
        }
        result = { sha, lane: lease.lane, attempts: 0, exitCode: 75, signal: null, admitted: null };
        let output = '';
        while (result.attempts < plan.retries) {
          checkCancellation();
          result.attempts++;
          const r = await call(process.execPath, ['scripts/readiness/heavy-admission.mjs', 'run', '--', 'npx', 'vitest', 'run', ...plan.files], lease.path, env);
          output = bounded(String(r.output ?? `${r.stdout ?? ''}${r.stderr ?? ''}`));
          Object.assign(result, {
            signal: r.signal ?? null,
            exitCode: r.signal ? signalCode(r.signal) : r.status ?? 1,
            admitted: typeof r.admitted === 'boolean' ? r.admitted : null,
            summary: summarizeVitest(output),
            tail: output.trimEnd().split(/\r?\n/).slice(-40).join('\n'),
          });
          if (result.exitCode !== 75 || cancellation.signal) break;
          if (result.attempts < plan.retries) await sleep(plan.retryWaitSec * 1000, cancellation);
        }
        return result.exitCode;
      } catch (error) {
        if (!cancellation.signal) throw error;
        result ??= { sha: null, lane: lease?.lane ?? null, attempts: 0, admitted: null };
        return signalCode(cancellation.signal);
      } finally {
        // --all uses exact session ownership, without the targeted ownerSession fallback.
        const selector = lease ? [`--lane=${lease.lane}`, `--session=${lease.holder}`] : ['--all', `--session=${session}`];
        try {
          const r = await call(process.execPath, [pool, 'release', ...selector, `--repo=${root}`], root, process.env, true);
          if (r.status !== 0) throw new Error(`exit ${r.status}, signal ${r.signal ?? 'none'}`);
          const status = await call(process.execPath, [pool, 'status', ...(lease ? [`--lane=${lease.lane}`] : []), '--json', `--repo=${root}`], root, process.env, true);
          if (status.status !== 0) throw new Error('could not verify release status');
          const rows = JSON.parse(status.stdout).lanes;
          if (!Array.isArray(rows) || rows.some(row => !row || !Object.hasOwn(row, 'lease') || (row.lease !== null && typeof row.lease !== 'object')) || (lease && !rows.some(row => row.lane === lease.lane))) throw new Error('invalid release status');
          const holder = lease?.holder ?? session;
          if (rows.some(row => row.readError || (row.lease && (row.lease.holder === holder || row.lease.session === holder)))) throw new Error('lease remains or status is unreadable');
        } catch (error) {
          const cleanupError = `lane-test release failed (${error.message}); recovery: node scripts/lane-pool.mjs release ${selector.join(' ')} --repo=${root}`;
          if (result) result.cleanupError = cleanupError;
          log(cleanupError);
        }
      }
    }, { proc });
    return { summary: summarizeVitest(''), tail: '', ...result, exitCode: code, signal: cancellationState.signal ?? result?.signal ?? null };
  } };
}
