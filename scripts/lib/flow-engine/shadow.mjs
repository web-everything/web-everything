import { openSync, readSync, closeSync, lstatSync, readFileSync, mkdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cascadePolicy } from '../policy-cascade.mjs';
import { resolveCoordinationRoot } from '../../operations/coordination-root.mjs';
import { completionPath, listCompletionSessions, tryReadCompletion, resolveCompletionsDir } from '../../operations/completion-store.mjs';
import { reserve, releaseLockDir } from '../../readiness/file-locks.mjs';
import definition from './review-definition.mjs';
import { load, plan, transitionRecord, appendTransition, canonicalJSON } from './index.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export function resolveFlowShadow(env = process.env, { tool, readSetting = readFileSync } = {}) {
  if (tool === undefined) {
    try {
      tool = JSON.parse(readSetting(join(ROOT, 'scripts/settings/review-flow-shadow.json'), 'utf8'))?.reviewLoop?.flowShadow;
      if (typeof tool?.enabled !== 'boolean' || (tool.file != null && (typeof tool.file !== 'string' || !tool.file.trim()))) throw Error('invalid shadow setting');
    } catch { tool = { enabled: false }; }
  }
  const r = cascadePolicy('reviewLoop.flowShadow', tool, {
    env, standard: { enabled: true, file: null },
    envValues: { file: env.WE_FLOW_V0_SHADOW_FILE || undefined },
    valid: { enabled: v => typeof v === 'boolean', file: v => v === null || (typeof v === 'string' && v.trim().length > 0) },
  });
  return { enabled: r.value.enabled, file: r.value.file ?? join(resolveCoordinationRoot({ env }), 'flow-v0-shadow.jsonl'), sources: r.sources };
}
const LIMIT = 262144;
function readBounded(file, { open, read, close, stat }) {
  // lstat first: a FIFO/device/symlink would block or escape; refuse before any open.
  if (!stat(file).isFile()) throw Error('shadow log is not a regular file; skipped');
  const fd = open(file, 'r');
  try {
    const buffer = Buffer.alloc(LIMIT + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = read(fd, buffer, size, buffer.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size > LIMIT) throw Error('shadow log exceeds 256 KiB; operator must archive the log before retrying');
    return buffer.toString('utf8', 0, size);
  } finally { close(fd); }
}

export function comparePlans(left, right) {
  const equal = canonicalJSON(left) === canonicalJSON(right);
  return { equal, blocksRetirement: !equal, finding: equal ? null : 'FlowEngine/v0 plan disagreement' };
}

// No production decisions depend on this observer. Evidence and replay are read under
// one cross-checkout log lock; contention skips rather than blocking the review tick.
export async function shadowReviewStep({ repo, pr, classified, session, completionsDir = resolveCompletionsDir() }, {
  env = process.env, tool, readSetting, file, stat = lstatSync, open = openSync, read = readSync, close = closeSync,
  engine = { load, plan, transitionRecord, appendTransition },
  executorCommit = () => env.WE_FLOW_V0_EXECUTOR_COMMIT || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: 2000, maxBuffer: 1024 }).trim(),
  now = () => new Date().toISOString(), log = message => console.error(message),
} = {}) {
  const note = message => { try { log(message.replace(/[\x00-\x1f\x7f]/g, ' ')); } catch { /* diagnostic only */ } };
  let lockRoot, locked = false;
  try {
    const setting = resolveFlowShadow(env, { tool, readSetting });
    note(`flow-v0 shadow settings ${JSON.stringify(setting)}`);
    if (!setting.enabled) return;
    const logPath = resolve(file ?? setting.file);
    const sessions = listCompletionSessions(completionsDir);
    const completion = session && tryReadCompletion(session, completionsDir);
    if (!repo || !/^[^/#]+\/[^/#]+$/.test(repo) || !/^[1-9][0-9]*$/.test(String(pr)) || !completion || !(completion.role === 'review' || (completion.role === undefined && completion.kind === 'review')) || completion.status !== 'done' || String(completion.pr) !== String(pr)) throw Error('required repo/PR/done review completion absent; skipped');
    const head = classified?.head, netDiff = classified?.netDiff;
    if (!/^[a-f0-9]{40}$/.test(head ?? '') || !/^[a-f0-9]{64}$/.test(netDiff ?? '')) throw Error('required classified head/netDiff absent or invalid; skipped (no hashes invented)');
    // Reject lexical paths, symlinks, and hard-link aliases before opening or locking.
    let logStat;
    try { logStat = stat(logPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (logStat && !logStat.isFile()) throw Error('shadow log is not a regular file; skipped');
    for (const name of sessions) {
      const path = completionPath(name, completionsDir), cs = lstatSync(path);
      if (resolve(path) === logPath || (logStat && cs.dev === logStat.dev && cs.ino === logStat.ino)) throw Error('shadow log aliases a completion record; skipped');
    }
    mkdirSync(dirname(logPath), { recursive: true });
    // Resolve parent aliases so two configured spellings still share a lock.
    lockRoot = join(realpathSync(dirname(logPath)), '.flow-v0-shadow-locks');
    const resource = realpathSync(dirname(logPath)) + '/' + logPath.split('/').pop();
    lockRoot = join(lockRoot, createHash('sha256').update(resource).digest('hex'));
    const stamp = now();
    const lockTime = Date.now(); // Lease age must use wall time, independently of evidence timestamps.
    locked = reserve(lockRoot, 'append', `${process.pid}:${lockTime}:${Math.random()}`, lockTime, new Date(lockTime).toISOString()).ok;
    if (!locked) throw Error('shadow log busy; skipped; operator may retry observation');
    let rows = [];
    try { rows = readBounded(logPath, { open, read, close, stat }).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const records = rows.filter(r => r.subject?.[0]?.name === `${repo}#${pr}`);
    const seq = records.length + 1;
    if (records.some((r, i) => r.predicate?.seq !== i + 1)) throw Error('duplicate or noncontiguous sequence; operator must inspect log; skipped');
    const input = pathToFileURL(completionPath(session, completionsDir)).href;
    if (records.some(r => r.predicate.inputs.includes(input) && r.predicate.runId === (classified?.runId ?? 'unknown') && r.predicate.completionAt === completion.endedAt)) throw Error('completion already observed; skipped');
    const flow = engine.load(definition);
    const outcome = completion.outcome === 'auto-cleared' && completion.verdict === 'converged' ? 'accept' : completion.outcome === 'bounced' ? 'continue' : 'unknown';
    const projection = { flowDigest: flow.digest, seq: records.length, records, event: 'done', outcome, parts: { Subject: `${repo}#${pr}`, Visit: seq } };
    const ctx = { repo, pr, head, netDiff, round: classified?.round ?? 'unknown', runId: classified?.runId ?? 'unknown', seq, at: stamp, executorCommit: executorCommit(), inputs: [input] };
    const steps = engine.plan(flow, projection);
    const actualOutcome = classified?.outcome === 'auto-cleared' && classified.loopOutcome === 'converged' ? 'accept' : classified?.outcome === 'bounced' ? 'continue' : null;
    const actual = actualOutcome ? { from: 'judge-convergence', guard: 'convergence', outcome: actualOutcome, route: 'advance', to: actualOutcome === 'accept' ? 'accepted' : 'judge-convergence' } : null;
    const agreement = steps.length === 1 && actual !== null && Object.entries(actual).every(([k, v]) => steps[0][k] === v);
    note(`flow-v0 shadow ${canonicalJSON({ repo, pr, seq, steps, actual: classified, agreement })}`);
    if (!agreement) note('flow-v0 shadow disagreement; operator review required; no gate decision changed');
    for (const step of steps) {
      const record = engine.transitionRecord(flow, step, ctx);
      Object.assign(record.predicate, { round: ctx.round, runId: ctx.runId, completionAt: completion.endedAt });
      if (!await engine.appendTransition(logPath, record)) note('flow-v0 shadow append failed; operator must inspect review-loop log');
    }
  } catch (e) { note(`flow-v0 shadow failed; operator must inspect evidence: ${String(e?.message ?? e)}`); }
  finally { if (locked) { try { releaseLockDir(lockRoot, 'append'); } catch { /* best effort */ } } }
}
