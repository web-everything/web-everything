/**
 * The fix daemon's verify-verdict pass — we:backlog/5137-harness-owns-the-verify-wait-not-the-model.md slices 2+3.
 *
 * A fixer used to hold its turn open on `verify-lane.mjs check --wait=540000`, re-running it on every 9-minute
 * timeout (measured: 54 timeouts / ~486 min on 2026-10-05, 15 / ~135 min 12:00–15:30 ET on 2026-10-06). Now it
 * commits, runs `verify-lane.mjs request`, records the wait (`await-verify.mjs mark --ref=… --kind=…`) and ends
 * its turn. This pass, run once per fix-daemon tick, reads every recorded wait and applies a fixed policy:
 *
 *   - verdict still running            → wait (no model turn spent)
 *   - green for EXACTLY the recorded sha, the lane still at that sha, clean, and the verified tree hash equal
 *     to the lane's tree now           → the harness pushes THAT sha (never force) to the recorded `lane/*` ref,
 *                                        then resumes the SAME session to finish its hand-back
 *   - no verdict (absent, infrastructure failure, unproven tree, overdue) → re-request, up to `maxRetries`,
 *                                        then resume with the blocked-on-infra exit
 *   - red only on timeouts the gate already re-ran alone (load-flake), WE only → resume with the load-flake exit
 *                                        (the existing quiet-host reverify pass then owns the saved fix)
 *   - red on attempt `maxReds`         → resume with the gate-red exit (the escalation ladder counts it)
 *   - any other red                    → resume the SAME session with the failing tests attached
 *   - the lane moved / went dirty      → resume: the record no longer describes the lane
 *
 * The gate is never weakened: nothing is pushed unless {@link classifyAwaitVerdict} answers `push`, and the push
 * names the verdict's own sha. Pure core + injectable IO, like we:scripts/conveyor/load-flake-reverify.mjs.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listStoredAwaitVerify, writeStoredAwaitVerify, clearStoredAwaitVerify, clearAwaitVerifyRecord,
  resolveAwaitVerifyTtlMs, AWAIT_VERIFY_REF_RE, AWAIT_VERIFY_KINDS,
} from './await-verify.mjs';
import { readVerifyMarker, verifyGateDecision } from '../lib/lane-verify.mjs';
import { computeWorkingTreeHash } from '../lib/verify-lane-gate.mjs';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Policy limits. `maxReds` counts the record's own `attempt` (the fixer bumps it on each re-mark). */
export const AWAIT_VERIFY_LIMITS = Object.freeze({ maxReds: 3, maxRetries: 2, maxResumeFailures: 3 });
/** Repo keys with a quiet-host reverify worker (mirrors stand-down.mjs#LOAD_FLAKE_REVERIFY_REPOS). */
export const AWAIT_LOAD_FLAKE_REPO_KEYS = Object.freeze(['we']);
const repoKeyOrNull = (slug) => { try { return repoKeyForSlug(slug) ?? null; } catch { return null; } };

const SHA_RE = /^[a-f\d]{40}$/i;
const lower = (s) => String(s ?? '').toLowerCase();

/** Is this a record the pass owns (written by `mark --ref`)? */
export function isHarnessRecord(record) {
  return !!record && record.v === 1 && Number.isInteger(record.pr) && record.pr > 0
    && SHA_RE.test(String(record.sha ?? '')) && typeof record.lane === 'string' && record.lane.startsWith('/')
    && AWAIT_VERIFY_REF_RE.test(String(record.ref ?? '')) && !String(record.ref).includes('..')
    && AWAIT_VERIFY_KINDS.includes(record.kind) && Number.isFinite(Date.parse(record.requestedAt));
}

/**
 * A red the gate itself classified as load-only: every failing file was re-run alone, every retried file failed
 * only on Vitest timeouts, and no failing test sits outside the retried set. Pure.
 */
export function isLoadFlakeRed(marker) {
  const retried = Array.isArray(marker?.retriedFailures) ? marker.retriedFailures : [];
  if (!retried.length || !retried.every((f) => f?.kind === 'timeout' && typeof f.file === 'string')) return false;
  const files = new Set(retried.map((f) => f.file));
  const tests = Array.isArray(marker?.failureDetails?.tests) ? marker.failureDetails.tests : [];
  return tests.every((t) => files.has(t?.file));
}

/**
 * The one decision for one record. Pure.
 * @param {{record:object, marker:object|null, lane:{head:string|null, dirty:boolean, treeHash:string|null}|null,
 *   nowMs:number, ttlMs:number, limits?:object}} input
 * @returns {{action:'skip'|'wait'|'push'|'rerequest'|'resume', reason:string, resume?:string}}
 */
export function classifyAwaitVerdict({ record, marker, lane, nowMs, ttlMs, limits = AWAIT_VERIFY_LIMITS }) {
  if (!isHarnessRecord(record)) return { action: 'skip', reason: 'not-harness-record' };
  if (record.pendingResume?.kind) return { action: 'resume', reason: 'pending-resume', resume: record.pendingResume.kind };
  if (!lane || !lane.head) return { action: 'resume', reason: 'lane-unreadable', resume: 'void' };
  if (lower(lane.head) !== lower(record.sha)) return { action: 'resume', reason: 'lane-moved', resume: 'void' };
  if (lane.dirty) return { action: 'resume', reason: 'lane-dirty', resume: 'void' };
  const rerequest = (reason) => ((record.retries ?? 0) >= limits.maxRetries
    ? { action: 'resume', reason: `${reason}; retries exhausted`, resume: 'infra' }
    : { action: 'rerequest', reason });
  // Exact-sha only: no `laneRelevantChangeSince`, so a verdict recorded for any other sha never counts here.
  const v = verifyGateDecision({ record: marker, headSha: lower(record.sha), nowMs, requireVerified: true });
  if (v.status === 'green') {
    if (lower(marker?.sha) !== lower(record.sha)) return rerequest('green-for-other-sha');
    if (!marker?.treeHash || !lane.treeHash || marker.treeHash !== lane.treeHash) return rerequest('tree-unproven');
    return { action: 'push', reason: 'green' };
  }
  if (v.status === 'running') {
    const age = nowMs - Date.parse(record.requestedAt);
    return age > ttlMs ? rerequest('verify-overdue') : { action: 'wait', reason: 'running' };
  }
  if (v.status === 'red') {
    if (AWAIT_LOAD_FLAKE_REPO_KEYS.includes(repoKeyOrNull(record.repo)) && isLoadFlakeRed(marker)) return { action: 'resume', reason: 'red-load-flake', resume: 'load-flake' };
    if ((record.attempt ?? 1) >= limits.maxReds) return { action: 'resume', reason: `red on attempt ${record.attempt}`, resume: 'escalate' };
    return { action: 'resume', reason: 'red', resume: 'red' };
  }
  return rerequest(v.status || 'no-verdict'); // absent / corrupt / infrastructure-failure
}

const brief = (record) => (record.kind === 'ci-heal' ? 'CI-heal brief' : 'fix brief');
const failureLines = (marker) => {
  const tests = Array.isArray(marker?.failureDetails?.tests) ? marker.failureDetails.tests.slice(0, 15) : [];
  const lines = tests.map((t) => `- ${t.file} > ${t.name}`);
  const summary = String(marker?.failureDetails?.summary ?? '').slice(0, 2500);
  return `${lines.join('\n') || '- (no per-test detail recorded)'}${summary ? `\n\nSummary:\n${summary}` : ''}`;
};

/**
 * The message the resumed session receives. Pure. Every variant names the sha, the attempt, and the exact next
 * step in the session's own brief, and repeats the one invariant: the session never pushes `{{LANE_REF}}` itself.
 */
export function buildAwaitVerifyResumePrompt({ kind, record, marker = null, detail = '' }) {
  const head = `[harness verify verdict — #5137] PR #${record.pr} (${record.repo}), sha ${record.sha}, attempt ${record.attempt ?? 1}.`;
  const next = `Re-mark with --attempt=${(record.attempt ?? 1) + 1} after committing and re-requesting, then end your turn again.`;
  switch (kind) {
    case 'green':
      return `${head}\n\nVerify is GREEN for exactly this sha and the harness has PUSHED it to ${record.ref}${detail ? ` (${detail})` : ''}. Do not push ${record.ref} again. Continue your ${brief(record)} from the step after the push: post the before/after evidence comment (cite this green verdict), then the hand-back and the closing completion report + fix-end.`;
    case 'push-rejected':
      return `${head}\n\nVerify is GREEN, but the harness could NOT push ${record.sha} to ${record.ref}: ${detail}. Follow your ${brief(record)}'s "push rejected because the branch moved" path (save to the alt branch, record the pause, fix-end). Never force-push.`;
    case 'red':
      return `${head}\n\nVerify is RED for this sha. Failing tests:\n${failureLines(marker)}\n\nRepair the failure in your lane (same scope rules), commit, run \`verify-lane.mjs request\`, then ${next.charAt(0).toLowerCase()}${next.slice(1)} If the red is only timeouts that pass alone under host load, take the brief's load-flake exit instead.`;
    case 'load-flake':
      return `${head}\n\nVerify is RED only on timeouts the gate already re-ran alone (load-flake):\n${failureLines(marker)}\n\nTake your ${brief(record)}'s load-flake exit with --alt-sha=${record.sha} (push this sha to the alt branch named there, never to ${record.ref}), then report blocked-on-load-flake and fix-end. The quiet-host reverify pass retries it.`;
    case 'escalate':
      return `${head}\n\nVerify is RED again (attempt ${record.attempt}; limit ${AWAIT_VERIFY_LIMITS.maxReds}). Do not attempt another repair. Take your ${brief(record)}'s gate-red exit (stand-down --reason=gate-red with the failing check below, completion report, fix-end).\n\n${failureLines(marker)}`;
    case 'infra':
      return `${head}\n\nThe verify gate produced no verdict after ${record.retries ?? 0} harness re-requests (${detail || 'no verdict'}). Do not re-request. Take your ${brief(record)}'s blocked-on-infra exit with that evidence, then fix-end.`;
    case 'void':
      return `${head}\n\nYour lane ${record.lane} no longer matches the recorded wait (${detail || 'HEAD moved or the tree is dirty'}), so the harness will not push it. Make sure the repair is committed in that lane, run \`verify-lane.mjs request\`, mark again, and end your turn.`;
    default:
      return `${head}\n\nThe harness could not act on your recorded verify wait (${kind}: ${detail}). Re-check the lane, request verify, mark again, and end your turn.`;
  }
}

/** Find the session row a record speaks for: session id first, else the newest row with its `who` name. Pure. */
export function findAwaitSession(record, rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (record.sessionId) {
    const hit = list.find((r) => r?.sessionId === record.sessionId);
    if (hit) return hit;
  }
  return list.filter((r) => r?.name === record.who).sort((a, b) => (b?.startedAt ?? 0) - (a?.startedAt ?? 0))[0] ?? null;
}

const BUSY = new Set(['working', 'running', 'busy', 'starting']);
/**
 * Is the session mid-turn? A live background session whose turn ENDED lists as `state:'working', status:'idle'`
 * (found live 2026-10-07 on fix-4151: the pass pushed its green, then deferred the resume forever as "busy").
 * `status` is the turn signal when present; `state` only for rows without one. Pure.
 */
export function isSessionBusy(session) {
  const status = String(session?.status ?? '').toLowerCase();
  if (status) return status !== 'idle';
  return BUSY.has(String(session?.state ?? '').toLowerCase());
}

/**
 * Apply the policy to every stored record once. Every effect is an injected port, so the whole pass replays
 * offline (see the test's fix-4115 replay).
 * @returns {Promise<{rows:object[]}>}
 */
export async function runAwaitVerifyPass({
  io, nowMs = Date.now(), ttlMs = resolveAwaitVerifyTtlMs(), limits = AWAIT_VERIFY_LIMITS, allowResume = true,
} = {}) {
  const rows = [];
  for (const { key, record: stored } of io.listRecords()) {
    let record = stored;
    const row = { key, pr: record?.pr ?? null, repo: record?.repo ?? null, sha: record?.sha ?? null };
    try {
      const lane = isHarnessRecord(record) && !record.pendingResume ? io.laneState(record.lane) : null;
      const marker = lane ? io.readMarker(record.lane) : null;
      const d = classifyAwaitVerdict({ record, marker, lane: record.pendingResume ? { head: record.sha } : lane, nowMs, ttlMs, limits });
      Object.assign(row, { action: d.action, reason: d.reason });
      if (d.action === 'skip' || d.action === 'wait') { rows.push(row); continue; }
      if (d.action === 'rerequest') {
        const r = io.rerequest(record.lane);
        record = { ...record, retries: (record.retries ?? 0) + 1, requestedAt: new Date(nowMs).toISOString(), lastRetry: d.reason };
        io.writeRecord(record);
        row.result = r?.status ?? (r?.ok ? 'requested' : 'request-failed');
        rows.push(row); continue;
      }
      let pending = record.pendingResume ?? null;
      if (d.action === 'push') {
        const pushed = io.push({ lane: record.lane, sha: record.sha, ref: record.ref, repo: record.repo, who: record.who, sessionId: record.sessionId });
        if (!pushed?.ok && pushed?.transient && (record.retries ?? 0) < limits.maxRetries) {
          // A network/auth hiccup is not a moved branch: retry the same push next tick.
          io.writeRecord({ ...record, retries: (record.retries ?? 0) + 1, lastRetry: `push: ${pushed.reason}` });
          row.result = `push-retry (${pushed.reason})`;
          rows.push(row); continue;
        }
        pending = pushed?.ok
          ? { kind: 'green', detail: `pushed at ${new Date(nowMs).toISOString()}` }
          : { kind: 'push-rejected', detail: pushed?.reason ?? 'push failed' };
        row.result = pushed?.ok ? 'pushed' : 'push-rejected';
      } else if (!pending) {
        pending = { kind: d.resume, detail: d.reason };
      }
      if (!record.pendingResume) {
        // Keep the marker's failure detail on the record: the next tick may need to re-send this message.
        record = { ...record, pendingResume: { ...pending, ...(marker ? { marker: { failureDetails: marker.failureDetails ?? null } } : {}) } };
        io.writeRecord(record);
      }
      if (!allowResume) { row.result = row.result ?? 'resume-paused'; rows.push(row); continue; }
      const session = findAwaitSession(record, io.listSessions());
      if (!session) {
        io.clearRecord(key, record);
        row.result = `${row.result ? `${row.result}; ` : ''}session-gone`;
        rows.push(row); continue;
      }
      if (isSessionBusy(session)) { row.result = row.result ?? 'session-busy'; rows.push(row); continue; }
      const prompt = buildAwaitVerifyResumePrompt({
        kind: record.pendingResume.kind, record, marker: record.pendingResume.marker ?? marker, detail: record.pendingResume.detail,
      });
      const resumed = io.resume({ session, prompt });
      if (resumed?.resumed) {
        io.clearRecord(key, record);
        row.result = `${row.result ? `${row.result}; ` : ''}resumed:${record.pendingResume.kind}`;
      } else {
        const failures = (record.resumeFailures ?? 0) + 1;
        if (failures >= limits.maxResumeFailures) {
          io.clearRecord(key, record);
          row.result = `${row.result ? `${row.result}; ` : ''}resume-exhausted`;
        } else {
          io.writeRecord({ ...record, resumeFailures: failures });
          row.result = `${row.result ? `${row.result}; ` : ''}resume-failed (${resumed?.reason ?? 'unconfirmed'})`;
        }
      }
    } catch (error) {
      row.action = row.action ?? 'error';
      row.result = `error: ${String(error?.message ?? error).split('\n')[0]}`;
    }
    rows.push(row);
  }
  return { rows };
}

/** One log line per acted-on record (waits are summarized, not listed). */
export function formatAwaitVerifyLines(result) {
  const rows = result?.rows ?? [];
  const waiting = rows.filter((r) => r.action === 'wait').length;
  const lines = rows.filter((r) => r.action !== 'wait' && r.action !== 'skip')
    .map((r) => `await-verify: ${r.repo} PR #${r.pr} @ ${String(r.sha ?? '').slice(0, 8)} — ${r.action} (${r.reason})${r.result ? ` → ${r.result}` : ''}`);
  if (waiting) lines.push(`await-verify: ${waiting} session(s) awaiting a verdict`);
  return lines;
}

/**
 * The lane's tree hash exactly as `verify-lane.mjs` records it: its `git` helper TRIMS every output, and the hash
 * covers the raw diff text, so an untrimmed read never matches (found live 2026-10-07 on the first edge record:
 * every green came back `tree-unproven`).
 */
export function laneTreeHash(lane, { exec = execFileSync, env = process.env } = {}) {
  const runGit = (args) => String(exec('git', args, { cwd: lane, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env })).trim();
  return computeWorkingTreeHash({ runGit, fileMode: (f) => lstatSync(join(lane, f)).mode });
}

// ── IO shell ───────────────────────────────────────────────────────────────────────────────────────────────
const pidAlive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Real ports. `deps` lets the daemon reuse its own `claude` spawn/list/stop seams. */
export async function defaultAwaitVerifyIo({ weRoot = ROOT, exec = execFileSync, env = process.env, ports = {} } = {}) {
  const io = { ...(await import('../operations/dispatch-lane-io.mjs')), ...(ports.io ?? {}) };
  const stopSession = ports.stopSession ?? (await import('../operations/dispatch-abort.mjs')).stopSession;
  const { pushRefusal } = await import('./fix-procedure.mjs');
  const git = (lane, args, opts = {}) => String(exec('git', ['-C', lane, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, ...opts }));
  return {
    listRecords: () => listStoredAwaitVerify(),
    writeRecord: (record) => writeStoredAwaitVerify(record),
    clearRecord: (key, record) => {
      clearStoredAwaitVerify(key);
      if (record?.lane) clearAwaitVerifyRecord(record.lane);
    },
    laneState: (lane) => {
      try {
        const head = git(lane, ['rev-parse', 'HEAD']).trim();
        const dirty = git(lane, ['status', '--porcelain', '--untracked-files=all']).trim().length > 0;
        const treeHash = dirty ? null : laneTreeHash(lane, { exec, env });
        return { head, dirty, treeHash };
      } catch { return null; }
    },
    readMarker: (lane) => {
      try { return readVerifyMarker(git(lane, ['rev-parse', '--absolute-git-dir']).trim()); } catch { return null; }
    },
    rerequest: (lane) => {
      try {
        const out = String(exec(process.execPath, [join(weRoot, 'scripts', 'verify-lane.mjs'), 'request', '--json', `--repo=${lane}`],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, timeout: 120_000 }));
        return { ok: true, ...JSON.parse(out.trim().split('\n').pop() || '{}') };
      } catch (e) {
        try { return { ok: false, ...JSON.parse(String(e?.stdout ?? '').trim().split('\n').pop()) }; } catch { return { ok: false, status: 'request-failed' }; }
      }
    },
    push: ({ lane, sha, ref, repo, who, sessionId }) => {
      const refusal = pushRefusal({ repo, branch: ref, sessionId, who });
      if (refusal?.refused) return { ok: false, reason: refusal.message };
      try {
        // Hooks stay on (guard-git-push refuses main); never --force, so a moved branch is rejected, not overwritten.
        git(lane, ['push', 'origin', `${sha}:refs/heads/${ref}`], { timeout: 180_000 });
      } catch (e) {
        const reason = String(e?.stderr ?? e?.message ?? e).trim().split('\n').slice(-2).join(' ').slice(0, 300);
        return { ok: false, reason, transient: !/rejected|non-fast-forward|fetch first|stale info|hook declined|protected/i.test(reason) };
      }
      try {
        const remote = git(lane, ['ls-remote', 'origin', `refs/heads/${ref}`]).split(/\s/)[0];
        if (lower(remote) !== lower(sha)) return { ok: false, reason: `remote ${ref} is ${remote.slice(0, 8) || 'missing'} after push` };
      } catch { /* the push itself succeeded; a failed read-back is not a rejection */ }
      return { ok: true };
    },
    listSessions: () => io.defaultListAgents({ all: true, env }),
    resume: ({ session, prompt }) => {
      // A background session whose turn ended is still a live process, and `--bg --resume` on a live session
      // "starts a copy" instead of continuing it (found live 2026-10-07: two forked copies, no resume). Stop the
      // idle process first; `--resume` then wakes the SAME id with its saved options (-n, --model, permissions).
      // The pass never gets here for a busy session (BUSY above), so this never interrupts a working turn.
      if (String(session.state ?? '').toLowerCase() !== 'stopped') {
        // `claude stop` takes the SHORT job id; a full session uuid answers "No job matching" (read as already
        // gone) and leaves the process running, so the resume forked again (found live 2026-10-07, fix-4151).
        const handle = session.id || String(session.sessionId).slice(0, 8);
        try { stopSession({ handle }); } catch (e) { return { resumed: false, reason: `stop-before-resume: ${String(e?.message ?? e).split('\n')[0]}` }; }
        for (let i = 0; i < 20 && pidAlive(session.pid); i += 1) sleepSync(500);
        if (pidAlive(session.pid)) return { resumed: false, reason: 'stop-before-resume: process still alive' };
        sleepSync(1_000);
      }
      const argv = io.buildAgentArgv({ payload: { prompt }, resumeSessionId: session.sessionId });
      let stdout = '';
      try { stdout = String(io.defaultSpawnAgent(argv, { cwd: session.cwd }) ?? ''); } catch (e) { return { resumed: false, reason: String(e?.message ?? e).split('\n')[0] }; }
      const printedId = io.parseBackgroundedId(stdout);
      let outcome = { resumed: false };
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        outcome = io.resumeSucceeded({ printedId, requestedSessionId: session.sessionId, agentsAfter: io.defaultListAgents({ all: true, env }) });
        if (outcome.resumed || attempt === 3) break;
        sleepSync(2_000);
      }
      if (!outcome.resumed && printedId) { try { stopSession({ handle: printedId }); } catch { /* best-effort: never the target */ } }
      return { resumed: !!outcome.resumed, reason: outcome.resumed ? null : (printedId ? 'forked-copy-stopped' : 'no-backgrounded-id') };
    },
  };
}

/** The daemon's entry: real IO, one pass. Never throws. */
export async function runAwaitVerifyPassDefault({ allowResume = true } = {}) {
  try {
    return await runAwaitVerifyPass({ io: await defaultAwaitVerifyIo(), allowResume });
  } catch (error) {
    return { rows: [{ action: 'error', result: `error: ${String(error?.message ?? error).split('\n')[0]}` }] };
  }
}
