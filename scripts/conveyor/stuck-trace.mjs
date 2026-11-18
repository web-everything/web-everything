/** Layered, read-only stuck-PR evidence, once per repo/PR/head. EVENT ONLY:
 * PR comments notify watchers and retrigger comment/label daemons; the existing
 * daemon event feed is queryable and already carries ready-stuck/needs-you signals.
 * Receipts precede IO: failed delivery/crashes retry after 10 minutes, at most 3 attempts.
 * No retries within a call; successfully delivered notes never repeat.
 * Share stateDir between callers that must share receipts. Unknown heads re-arm daily.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic, withFileLock } from '../lib/atomic-json-file.mjs';
import { appendDaemonEvent } from '../lib/daemon-events.mjs';
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

export async function traceStuckPr({ repo, pr, head, kind, stateDir, now = Date.now(), run,
  emit = appendDaemonEvent, env = process.env } = {}) {
  try {
    if (!TRACE_TRIGGERS.includes(kind)) return { posted: false, skipped: 'trigger' };
    if (!run && (isUnderTest(env) || isUnderTest())) return { posted: false, skipped: 'under-test' };
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(pr) || pr < 1) throw Error('invalid subject');
    const day = localDateString(new Date(now));
    head = !head || head === 'unknown-head' ? `unknown-head:${day}` : head;
    const key = `${repo}#${pr}@${head}`;
    mkdirSync(stateDir, { recursive: true });
    const file = join(stateDir, 'stuck-trace.json');
    const doneFile = join(stateDir, `stuck-trace-done-${createHash('sha256').update(key).digest('hex')}.json`);
    const claimed = withFileLock(`${file}.lock`, () => {
      // A successful sink may have finalized outside the contended shared lock.
      try {
        if (JSON.parse(readFileSync(doneFile, 'utf8'))?.state !== 'done') throw Error('invalid completion');
        return false;
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      let saved = {};
      try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw Error('invalid receipts');
      const previous = saved[key];
      // Legacy receipts already suppressed delivery; retain that deduplication.
      if (Object.hasOwn(saved, key) && (previous?.state !== 'claimed'
        || !Number.isInteger(previous.attempts) || previous.attempts < 1 || previous.attempts >= 3
        || !Number.isFinite(Date.parse(previous.at))
        || new Date(now).getTime() - Date.parse(previous.at) <= 10 * 60_000)) return false;
      const claim = { state: 'claimed', at: new Date(now).toISOString(), attempts: (previous?.attempts ?? 0) + 1 };
      writeJsonAtomic(file, { ...saved, [key]: claim });
      return claim;
    }, { timeoutMs: 0 });
    if (!claimed) return { posted: false, skipped: 'duplicate' };
    // Both layers share one wall-clock budget, including a misbehaving injected runner.
    let timer;
    const evidence = Promise.all(['why', 'pr-trace'].map(async op => {
      try {
        const result = await (run ?? (args => runner(args, env)))([op, `--pr=${pr}`, `--repo=${repo}`, '--json']);
        if (result?.verdict && typeof result.verdict === 'object' && !Array.isArray(result.verdict)) return result.verdict;
        const field = op === 'pr-trace' ? 'likelyBlocker' : 'owner';
        if (!result || Array.isArray(result) || typeof result[field] !== 'string') throw Error('missing verdict');
        return result;
      } catch { report(); return null; }
    }));
    let why, trace;
    try {
      [why, trace] = await Promise.race([evidence, new Promise(resolve => {
        timer = setTimeout(() => resolve([null, null]), 59_000);
      })]);
    } finally { clearTimeout(timer); }
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
      ? 'INCOMPLETE trace: evidence unavailable or incomplete; inspect manually\n' : '';
    const note = status + fields.map(([name, value]) => `${name}: ${clean(value, name === 'daemon logs + times' ? 700 : 130)}`).join('\n');
    const bounded = Buffer.byteLength(note) > 2900
      ? `${Buffer.from(note).subarray(0, 2800).toString('utf8')}\n[bounded; inspect full why/pr-trace JSON manually]` : note;
    // Bound the event sink too; a slow filesystem must not wedge the watch pass.
    try {
      const delivered = await Promise.race([
        Promise.resolve().then(() => emit({ kind: 'stuck-trace', repo, pr,
          detail: { head: clean(head), trigger: kind, headline, owner, waitingFor, note: bounded } }, { env })),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); }),
      ]);
      if (delivered === false) throw Error('delivery failed');
    } finally { clearTimeout(timer); }
    try {
      withFileLock(`${file}.lock`, () => {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        // Only finalize our own claim; preserve receipts written by other subjects.
        if (saved[key]?.state === 'claimed' && saved[key].at === claimed.at && saved[key].attempts === claimed.attempts) {
          writeJsonAtomic(file, { ...saved, [key]: { ...claimed, state: 'done' } });
        }
      }, { timeoutMs: 0 });
    } catch {
      // Delivery succeeded. Persist a subject-specific completion without the
      // shared lock, so contention cannot make a later daemon repeat the note.
      writeJsonAtomic(doneFile, { state: 'done' });
    }
    return { posted: true };
  } catch { report(); return { posted: false, skipped: 'incomplete' }; }
}
