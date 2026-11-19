/** Layered, read-only stuck-PR evidence, once per repo/PR/head. EVENT ONLY:
 * PR comments notify watchers and retrigger comment/label daemons; the existing
 * daemon event feed is queryable and already carries ready-stuck/needs-you signals.
 * Queue shared via the watcher state directory: the watcher only enqueues;
 * failures never escape into alert delivery or spend its 128-read budget.
 * Only the stall digest drains, detached and best effort on every pass, capped
 * at two entries (two read-only ops each). Per-head dedupe and a three-attempt
 * cap bound total reads. Failed/crashed attempts stay queued
 * and retry after 10 minutes; delivered heads never repeat. Unknown heads re-arm daily.
 * Delivery is exactly-once within the 10-minute claim lease; at-least-once only
 * for a sink hung over 10 minutes. Consumers dedupe by traceKey.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic, withFileLock } from '../lib/atomic-json-file.mjs';
import { appendDaemonEvent, daemonEventsPath } from '../lib/daemon-events.mjs';
import { isUnderTest } from '../lib/under-test.mjs';
import { localDateString } from '../lib/local-date.mjs';

export const TRACE_TRIGGERS = Object.freeze(['ready-stuck', 'pr-no-progress', 'stalled']);
const clean = (value, cap = 240) => {
  const text = (typeof value === 'string' ? value : JSON.stringify(value)) ?? 'unavailable';
  const safe = text.replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, ' ');
  return safe.length > cap ? `${safe.slice(0, cap - 38)}… [bounded; inspect full operation JSON]` : safe;
};
const report = () => { try { console.error('stuck-trace: incomplete evidence/delivery; inspect why and pr-trace manually'); } catch { /* best effort */ } };
function runner(args, env) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  return new Promise((resolve, reject) => execFile(process.execPath,
    ['scripts/operations/run.mjs', ...args], { cwd: root, env, timeout: 58_000, killSignal: 'SIGKILL', maxBuffer: 512 * 1024 },
    (error, stdout) => { if (error) reject(error); else { try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); } } }));
}

const queueFile = stateDir => join(stateDir, 'stuck-trace-queue.json');
const doneFile = (stateDir, key) => join(stateDir, `stuck-trace-done-${createHash('sha256').update(key).digest('hex')}.json`);
function readObject(file) {
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid queue');
  return value;
}
function readQueue(stateDir) {
  const saved = readObject(queueFile(stateDir));
  // Merge historical delivered receipts and interrupted claims without re-arming them.
  for (const [key, receipt] of Object.entries(readObject(join(stateDir, 'stuck-trace.json')))) {
    if (Object.hasOwn(saved, key)) continue;
    const retryable = receipt?.state === 'claimed' && Number.isInteger(receipt.attempts)
      && receipt.attempts >= 1 && Number.isFinite(Date.parse(receipt.at));
    saved[key] = { kind: receipt?.trigger ?? 'stalled', enqueuedAt: receipt?.at,
      attempts: retryable ? receipt.attempts : 3, state: retryable ? 'queued' : 'done',
      ...(retryable ? { attemptedAt: receipt.at } : {}) };
  }
  for (const [key, entry] of Object.entries(saved)) {
    if (entry?.state === 'done') continue;
    try {
      const completion = readObject(doneFile(stateDir, key));
      if (completion.state === 'done') Object.assign(entry, completion);
    } catch { throw Error('invalid completion'); }
  }
  return saved;
}
export function enqueueStuckTrace({ repo, pr, head, kind, stateDir, now = Date.now() } = {}) {
  try {
    if (!TRACE_TRIGGERS.includes(kind)) return { queued: false, skipped: 'trigger' };
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(pr) || pr < 1) throw Error('invalid subject');
    const at = new Date(now).toISOString();
    head = !head || head === 'unknown-head' ? `unknown-head:${localDateString(new Date(now))}` : head;
    const key = `${repo}#${pr}@${head}`;
    mkdirSync(stateDir, { recursive: true });
    return withFileLock(`${queueFile(stateDir)}.lock`, () => {
      const saved = readQueue(stateDir);
      if (Object.hasOwn(saved, key)) return { queued: false, skipped: 'duplicate' };
      writeJsonAtomic(queueFile(stateDir), { ...saved, [key]: { kind, enqueuedAt: at, attempts: 0, state: 'queued' } });
      return { queued: true };
    }, { timeoutMs: 0 });
  } catch { report(); return { queued: false, skipped: 'incomplete' }; }
}

// Retry evidence is bounded; if the retained tail cannot rule out delivery,
// leave the entry queued and report manual inspection rather than risk a duplicate.
function wasDelivered(traceKey, env, read = readSync) {
  let fd;
  try {
    fd = openSync(daemonEventsPath({ env }), 'r');
    const size = fstatSync(fd).size, start = Math.max(0, size - 256 * 1024);
    const buffer = Buffer.alloc(size - start);
    if (read(fd, buffer, 0, buffer.length, start) !== buffer.length) throw Error('incomplete event tail');
    const lines = buffer.toString('utf8').split('\n');
    if (start) lines.shift(); // The first record may begin outside the retained tail.
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event?.kind === 'stuck-trace' && event.detail?.traceKey === traceKey) return true;
    }
    if (start) throw Error('delivery history exceeds tail; inspect manually');
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

export async function drainStuckTraces({ stateDir, max = 2, now = Date.now(), run,
  emit = appendDaemonEvent, env = process.env, readHistory = readSync } = {}) {
  if (!run && (isUnderTest(env) || isUnderTest())) return { processed: 0 };
  let processed = 0;
  try {
    if (!Number.isInteger(max) || max < 0 || max > 2) throw Error('invalid drain cap');
    const at = new Date(now).toISOString(), stamp = Date.parse(at), file = queueFile(stateDir);
    const claims = withFileLock(`${file}.lock`, () => {
      const saved = readQueue(stateDir);
      const selected = Object.entries(saved).filter(([, e]) => e?.state === 'queued'
        && TRACE_TRIGGERS.includes(e.kind) && Number.isFinite(Date.parse(e.enqueuedAt))
        && Number.isInteger(e.attempts) && e.attempts >= 0 && e.attempts < 3
        // Refuse retries within the claim lease, including pre-claimedAt persisted entries.
        && (e.attempts === 0 || (Number.isFinite(Date.parse(e.claimedAt ?? e.attemptedAt))
          && stamp - Date.parse(e.claimedAt ?? e.attemptedAt) >= 600_000)))
        .sort((a, b) => Date.parse(a[1].enqueuedAt) - Date.parse(b[1].enqueuedAt)).slice(0, max);
      for (const [, e] of selected) { e.attempts++; e.attemptedAt = at; e.claimedAt = at; }
      writeJsonAtomic(file, saved); // Merge legacy completions; persist attempts BEFORE IO, including crashes.
      return selected;
    }, { timeoutMs: 0 });
    for (const [key, claim] of claims) {
      processed++;
      const subject = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)@(.+)$/.exec(key);
      if (!subject) { report(); continue; }
      const [, repo, pr, head] = subject;
      let delivered = false;
      if (claim.attempts > 1) {
        try { delivered = wasDelivered(key, env, readHistory); }
        catch { report(); continue; }
      }
      const result = delivered ? { posted: true }
        : await traceStuckPr({ repo, pr: Number(pr), head, kind: claim.kind, attempts: claim.attempts, run, emit, env });
      if (!result.posted && result.skipped !== 'superseded') continue;
      const completion = { state: 'done', ...(result.skipped === 'superseded' ? { reason: 'superseded' } : {}) };
      try {
        withFileLock(`${file}.lock`, () => {
          const saved = readQueue(stateDir);
          if (saved[key]?.attemptedAt === claim.attemptedAt && saved[key]?.attempts === claim.attempts)
            writeJsonAtomic(file, { ...saved, [key]: { ...claim, ...completion } });
        }, { timeoutMs: 0 });
      } catch {
        // Preserve delivery or supersession without the contended queue lock.
        // readQueue merges this subject-specific marker before selecting retries.
        writeJsonAtomic(doneFile(stateDir, key), completion);
      }
    }
  } catch { report(); }
  return { processed };
}

async function traceStuckPr({ repo, pr, head, kind, attempts, run, emit, env }) {
  try {
    // Both layers share one wall-clock budget, including a misbehaving injected runner.
    let timer;
    const evidence = Promise.all(['why', 'pr-trace'].map(async op => {
      try {
        const result = await (run ?? (args => runner(args, env)))([op, `--pr=${pr}`, `--repo=${repo}`, '--json']);
        const verdict = result && Object.hasOwn(result, 'verdict') ? result.verdict : result;
        const field = op === 'pr-trace' ? 'likelyBlocker' : 'owner';
        if (!verdict || Array.isArray(verdict) || typeof verdict[field] !== 'string'
          || (op === 'why' && !Array.isArray(verdict.sections))) { report(); return null; }
        return verdict;
      } catch { report(); return null; }
    }));
    let why, trace;
    try {
      [why, trace] = await Promise.race([evidence, new Promise(resolve => {
        timer = setTimeout(() => resolve([null, null]), 59_000);
      })]);
    } finally { clearTimeout(timer); }
    // A queued head can move while awaiting either operation; stale evidence emits nothing.
    let headMismatch = false;
    if (/^[a-f0-9]{40}$/i.test(head)) {
      if ([trace?.head, why?.head].some(
        live => typeof live === 'string' && /^[a-f0-9]{40}$/i.test(live) && live.toLowerCase() !== head.toLowerCase()))
        return { posted: false, skipped: 'superseded' };
      if (typeof why?.head !== 'string' || why.head.toLowerCase() !== head.toLowerCase()) why = null;
      if (typeof trace?.head !== 'string' || trace.head.toLowerCase() !== head.toLowerCase()) trace = null;
    } else if (![why?.head, trace?.head].every(live => typeof live === 'string' && /^[a-f0-9]{40}$/i.test(live))
      || why.head.toLowerCase() !== trace.head.toLowerCase()) {
      headMismatch = true;
      why = trace = null;
    }
    // Retry failed reads without delivering a note that would then be repeated.
    // On the final attempt, deliver one INCOMPLETE note even if a layer is missing.
    if ((why === null || trace === null) && attempts < 3) { report(); return { posted: false, skipped: 'incomplete' }; }
    const section = name => why?.sections?.find(s => s.name === name)?.lines;
    const headline = clean(trace?.likelyBlocker ?? 'unavailable root cause; inspect why/pr-trace manually');
    const owner = clean(why?.owner), waitingFor = clean(why?.waitingFor);
    const gapsBlock = typeof why?.screen === 'string' && /(?:^|\n)gaps\r?(?:\n|$)/.test(why.screen);
    const gaps = gapsBlock ? why.screen.split(/(?:^|\n)gaps\r?(?:\n|$)/)[1].split(/\r?\n/).filter(line => /^\s+\S/.test(line)) : [];
    const fields = [
      ...(gapsBlock ? [['why gaps', gaps]] : []),
      ['root cause', headline], ['owner', owner], ['waitingFor', waitingFor], ['suggestedOp', why?.suggestedOp ?? 'unavailable / none suggested'],
      ['stage', section('state')], ['labels', trace?.labels], ['checks', section('checks')], ['ci (pending)', trace?.ci],
      ['holds', section('holds')], ['queue', trace?.queue ?? section('queue')], ['label conflicts', trace?.conflicts], ['looping', trace?.looping],
      ['daemon logs + times', trace?.latest && Object.entries(trace.latest).slice(0, 12).map(([name, line]) =>
        `${clean(name, 80)} (${clean(trace.latestAtET?.[name], 80)}): ${clean(line, 160)}`)],
      ['unavailable evidence', trace?.unavailable], ['incomplete evidence', trace?.incomplete],
    ];
    const status = !why || !trace || gapsBlock || trace?.unavailable?.length || trace?.incomplete?.length
      ? `INCOMPLETE trace: ${headMismatch ? 'head mismatch; ' : ''}evidence unavailable or incomplete; inspect manually\n` : '';
    const note = status + fields.map(([name, value]) => `${name}: ${clean(value, name === 'daemon logs + times' ? 700 : 130)}`).join('\n');
    const bounded = Buffer.byteLength(note) > 2900
      ? `${Buffer.from(note).subarray(0, 2800).toString('utf8')}\n[bounded; inspect full why/pr-trace JSON manually]` : note;
    // Await the append: a pending sink retains its claim until the lease expires.
    const delivered = await emit({ kind: 'stuck-trace', repo, pr,
      detail: { traceKey: `${repo}#${pr}@${head}`, head: clean(head), trigger: kind, headline, owner, waitingFor, note: bounded } }, { env });
    if (delivered === false) throw Error('delivery failed');
    return { posted: true };
  } catch { report(); return { posted: false, skipped: 'incomplete' }; }
}
