import { openSync, readSync, closeSync, lstatSync, readFileSync, mkdirSync, realpathSync, readdirSync, renameSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cascadePolicy } from '../policy-cascade.mjs';
import { resolveCoordinationRoot } from '../../operations/coordination-root.mjs';
import { completionPath, listCompletionSessions, tryReadCompletion, resolveCompletionsDir } from '../../operations/completion-store.mjs';
import { reserve, readLockEntry, releaseLockDirIf } from '../../readiness/file-locks.mjs';
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
  let lockRoot, lockOwner, locked = false;
  try {
    const setting = resolveFlowShadow(env, { tool, readSetting });
    note(`flow-v0 shadow settings ${JSON.stringify(setting)}`);
    if (!setting.enabled) return;
    const configured = resolve(file ?? setting.file);
    // Hex encoding is injective and keeps untrusted repository names out of paths.
    const logPath = join(dirname(configured), `${basename(configured).replace(/[^A-Za-z0-9_-]/g, '-').replace(/-jsonl$/, '')}-${Buffer.from(String(repo)).toString('hex')}-${pr}.jsonl`);
    const sessions = listCompletionSessions(completionsDir);
    const completion = session && tryReadCompletion(session, completionsDir);
    if (!repo || !/^[^/#]+\/[^/#]+$/.test(repo) || !/^[1-9][0-9]*$/.test(String(pr)) || !completion || !(completion.role === 'review' || (completion.role === undefined && completion.kind === 'review')) || completion.status !== 'done' || String(completion.pr) !== String(pr)) throw Error('required repo/PR/done review completion absent; skipped');
    const head = classified?.head, netDiff = classified?.netDiff;
    if (!/^[a-f0-9]{40}$/.test(head ?? '') || !/^[a-f0-9]{64}$/.test(netDiff ?? '')) throw Error('required classified head/netDiff absent or invalid; skipped (no hashes invented)');
    // Reject lexical paths, symlinks, and hard-link aliases before opening or locking.
    let logStat;
    const checkPath = path => {
      let info;
      try { info = stat(path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (info && !info.isFile()) throw Error('shadow log is not a regular file; skipped');
      for (const name of sessions) {
        const completion = completionPath(name, completionsDir), cs = lstatSync(completion);
        if (resolve(completion) === path || (info && cs.dev === info.dev && cs.ino === info.ino)) throw Error('shadow log aliases a completion record; skipped');
      }
      return info;
    };
    checkPath(configured);
    logStat = checkPath(logPath);
    mkdirSync(dirname(logPath), { recursive: true });
    // Resolve parent aliases so two configured spellings still share a lock.
    lockRoot = join(realpathSync(dirname(logPath)), '.flow-v0-shadow-locks');
    const resource = realpathSync(dirname(logPath)) + '/' + logPath.split('/').pop();
    lockRoot = join(lockRoot, createHash('sha256').update(resource).digest('hex'));
    const stamp = now();
    const lockTime = Date.now(); // Lease age must use wall time, independently of evidence timestamps.
    lockOwner = `${process.pid}:${lockTime}:${Math.random()}`;
    locked = reserve(lockRoot, 'append', lockOwner, lockTime, new Date(lockTime).toISOString()).ok;
    if (!locked) throw Error('shadow log busy; skipped; operator may retry observation');
    logStat = checkPath(logPath); // Recheck size after acquiring the shared lock.
    const archives = readdirSync(dirname(logPath)).filter(n => n.startsWith(basename(logPath) + '.') && /^\d+$/.test(n.slice(basename(logPath).length + 1)))
      .sort((a, b) => Number(a.split('.').pop()) - Number(b.split('.').pop()));
    let rows = [];
    for (const [i, name] of archives.entries()) if (Number(name.split('.').pop()) !== i + 1) throw Error('archive sequence incomplete; operator must inspect log');
    for (const path of [...archives.map(n => join(dirname(logPath), n)), logPath]) {
      checkPath(path);
      try { rows.push(...readBounded(path, { open, read, close, stat }).split('\n').filter(line => line.trim()).map(line => JSON.parse(line))); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    const records = rows.filter(r => r.subject?.[0]?.name === `${repo}#${pr}`);
    const seq = records.length + 1;
    if (records.some((r, i) => r.predicate?.seq !== i + 1)) throw Error('duplicate or noncontiguous sequence; operator must inspect log; skipped');
    const input = pathToFileURL(completionPath(session, completionsDir)).href;
    if (records.some(r => r.predicate.inputs.includes(input) && r.predicate.runId === (classified?.runId ?? 'unknown') && r.predicate.completionAt === completion.endedAt)) throw Error('completion already observed; skipped');
    const flow = engine.load(definition);
    const outcome = completion.outcome === 'auto-cleared' && completion.verdict === 'converged' ? 'accept' : completion.outcome === 'bounced' ? 'continue' : 'unknown';
    const attempt = Number.isSafeInteger(classified?.attempt) && classified.attempt >= 1 ? classified.attempt : 1;
    const projection = { flowDigest: flow.digest, seq: records.length, records, event: 'done', outcome, parts: { Subject: `${repo}#${pr}`, Visit: `${seq}.${attempt}` }, attempt };
    const ctx = { repo, pr, head, netDiff, round: classified?.round ?? 'unknown', runId: classified?.runId ?? 'unknown', seq, at: stamp, executorCommit: executorCommit(), inputs: [input] };
    const steps = engine.plan(flow, projection);
    const actualOutcome = classified?.outcome === 'auto-cleared' && classified.loopOutcome === 'converged' ? 'accept' : classified?.outcome === 'bounced' ? 'continue' : null;
    // The declared Visit key part carries this visit's attempt (the review subset permits one).
    const actual = { from: 'judge-convergence', event: 'done', guard: 'convergence', outcome: actualOutcome,
      route: actualOutcome ? 'advance' : null, to: actualOutcome === 'accept' ? 'accepted' : actualOutcome === 'continue' ? 'judge-convergence' : null,
      key: `review:${encodeURIComponent(`${repo}#${pr}`)}:${seq}.${attempt}` };
    // Exactly seven fields. `attempt` is folded into the key (`<seq>.<attempt>`) for every value on both sides and is
    // never a field, so an attempt mismatch reads as disagree through the key; any other extra field also differs.
    const fullStep = ({ attempt: _folded, ...rest }) => rest;
    const planned = steps.map(fullStep);
    const agreement = steps.length === 1 && comparePlans(planned[0], actual).equal;
    note(`flow-v0 shadow ${canonicalJSON({ repo, pr, seq, steps: planned, actual, agreement })}`);
    if (!agreement) {
      const findings = logPath + '.findings.jsonl';
      checkPath(findings);
      appendFileSync(findings, canonicalJSON({ repo, pr, seq, planned: canonicalJSON(planned.length === 1 ? planned[0] : planned), actual: canonicalJSON(actual) }) + '\n');
      note('flow-v0 shadow disagreement; operator review required; no gate decision changed');
    }
    for (const step of steps) {
      const record = engine.transitionRecord(flow, step, ctx);
      Object.assign(record.predicate, { round: ctx.round, runId: ctx.runId, completionAt: completion.endedAt, agreement });
      const rowBytes = Buffer.byteLength(JSON.stringify(record) + '\n');
      if (rowBytes > LIMIT) throw Error('shadow row exceeds 256 KiB; operator must inspect evidence');
      if (logStat && logStat.size + rowBytes > LIMIT) {
        renameSync(logPath, `${logPath}.${archives.length + 1}`);
        logStat = undefined;
        note('flow-v0 shadow rotated; prior evidence retained in numbered archive');
      }
      if (!await engine.appendTransition(logPath, record)) note('flow-v0 shadow append failed; operator must inspect review-loop log');
    }
  } catch (e) { note(`flow-v0 shadow failed; operator must inspect evidence: ${String(e?.message ?? e)}`); }
  finally { if (locked) { try { const held = readLockEntry(lockRoot, 'append'); if (held?.owner === lockOwner) releaseLockDirIf(lockRoot, 'append', held); } catch { /* best effort */ } } }
}
