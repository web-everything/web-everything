#!/usr/bin/env node
/**
 * @file scripts/operations/worker-wrapper.mjs
 * @description THE UNIFIED WORKER WRAPPER (item 117, slice S3a; decision D7 FINAL, operator 2026-10-08).
 *
 * ONE PATTERN FOR EVERY WORKER (Claude fix / ci-heal / review / build, Codex, agy): run to completion, launched
 * through a DETACHED wrapper like `deliver-item-wrapper.mjs`. This file is that wrapper. It is launcher-agnostic:
 * it owns the process, the clock and the record; it knows the three result channels and nothing about any role.
 *
 *  - EXPLICIT pid and timeout. The wrapper writes its OWN job record (completion record v2, `status:'started'`) as
 *    soon as the child has a pid: `pid`, `timeoutMs`, `deadlineAt`, `headBefore`. A dead wrapper reads as stale
 *    (past `deadlineAt` with no `endedAt`); /sessions and liveness read this one record (D5: the launcher writes
 *    `started`, the agent no longer does).
 *  - STDIN IS CLOSED (`stdio[0]='ignore'`) for every launcher. `codex exec` with a positional prompt and an open
 *    pipe waits forever on stdin (S0 finding; see `codex-delivery-provider.mjs`); closing it costs the others nothing.
 *  - THE RESULT comes from one of three places, never from prose: `claude -p --output-format json --json-schema`
 *    (`structured_output` on stdout), `codex exec --output-schema -o <file>` (the file), `agy --json-schema`
 *    (`result.result.structured_output`). Resume is `-p --resume <id>` with the schema flags again ({@link
 *    withStructuredOutput} adds them to any argv, fresh or resumed).
 *  - FAIL CLOSED. No output, bad JSON, a schema or reader-check failure, a timeout, a reaper kill: the envelope is
 *    `unparseable` / `contract-violation` and routes to a deduped product-fix draft. An operator stop is `aborted`.
 *    While a launcher is still migrating, `legacyRead` may supply the OLD report (section 5 reader order: v1 result,
 *    then the legacy record mapped by the section 4 table, then unparseable).
 *  - THE ENVELOPE is completion record v2, written under the existing completion lock; its `action` is the router's.
 *
 * `runWorker` takes every effect as an injectable (spawn, clock, record store, drafts sink, file reader, head probe),
 * so the tests run it against a fake child. The CLI at the bottom runs a JSON spec detached.
 */
import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { finishEnvelopeRecord, isValidSessionSlug, newEnvelopeRecord, redactFreeText } from './completion-record.mjs';
import { resolveCompletionsDir, tryReadCompletion, withCompletionLock, writeCompletion } from './completion-store.mjs';
import { claudeWorkerResultSchema } from './worker-result.mjs';
import {
  defaultDraftsDir, defaultOperationsDir, envelopeFromLegacy, legacyOutcomeWord, resolvePostmortemMode, routeWorkerResult, settleWorkerResult,
  writeProductFixDraft,
} from './worker-result-router.mjs';
import { sanitizeSpawnEnv } from '../lib/gh-app-shim.mjs';
import { spawnToCompletion } from '../lib/spawn-to-completion.mjs';
import { markWorkerEnv } from './session-role.mjs';

/** The knob. `WE_WORKER_WRAPPER=on` routes a migrated launcher through this wrapper; anything else is the old path, byte for byte. */
export const WORKER_WRAPPER_ENV = 'WE_WORKER_WRAPPER';
export function workerWrapperEnabled(env = process.env) {
  return String(env[WORKER_WRAPPER_ENV] ?? '').toLowerCase() === 'on';
}

/** Default budget when a spec names none (the build path passes its own 60-minute budget). */
export const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
export const MAX_AWAIT_RESUMES = 6;
/** The most a codex `-o` result file may hold: the stdout channel has a max-buffer guard, this one needs its own cap. */
export const RESULT_FILE_MAX_BYTES = 1024 * 1024;

/**
 * Read a result file the CHILD wrote: bounded and never through a symlink. `O_NOFOLLOW` makes the open itself refuse a link (no
 * lstat-then-open race), the fstat refuses anything that is not a regular file or is over the cap, and the read is capped even if
 * the file grows after the fstat. The error names only the refusal, never the file's contents.
 * @param {string} file
 * @param {number} [maxBytes]
 * @returns {string}
 */
export function readBoundedResultFile(file, maxBytes = RESULT_FILE_MAX_BYTES) {
  // O_NONBLOCK: opening a FIFO the child left at the path would otherwise block this (synchronous) call forever, past every timeout.
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw Object.assign(new Error('result file is not a regular file'), { code: 'EWRAPPER_REFUSED' });
    if (st.size > maxBytes) throw Object.assign(new Error(`result file is over ${maxBytes} bytes`), { code: 'EWRAPPER_REFUSED' });
    const buf = Buffer.alloc(maxBytes + 1);
    let n = 0;
    for (let r; n < buf.length && (r = readSync(fd, buf, n, buf.length - n, null)) > 0;) n += r;
    if (n > maxBytes) throw Object.assign(new Error(`result file is over ${maxBytes} bytes`), { code: 'EWRAPPER_REFUSED' });
    return buf.toString('utf8', 0, n);
  } finally {
    closeSync(fd);
  }
}

// ── argv + prompt helpers (pure) ────────────────────────────────────────────────────────────────────────────────

/** The schema as the one-line JSON the `--json-schema` flag takes. */
export function workerResultSchemaJson() {
  return JSON.stringify(claudeWorkerResultSchema());
}

/**
 * Add the structured-output flags to a `claude` argv whose LAST element is the prompt: `-p` (a resumed argv has
 * none today), `--output-format json` and `--json-schema <schema>`, ahead of the prompt. Works for a fresh and a
 * resumed argv alike, which is the point: resume keeps the schema (D7). Idempotent.
 * @param {string[]} argv
 * @returns {string[]}
 */
export function withStructuredOutput(argv, schemaJson = workerResultSchemaJson()) {
  if (!Array.isArray(argv) || argv.length === 0) throw new TypeError('operations: withStructuredOutput needs a claude argv ending in the prompt');
  if (argv.includes('--json-schema')) return [...argv];
  const prompt = argv.at(-1);
  const rest = argv.slice(0, -1);
  if (!rest.includes('-p') && !rest.includes('--print')) rest.push('-p');
  return [...rest, '--output-format', 'json', '--json-schema', schemaJson, prompt];
}

/** What a wrapped worker is told on top of its brief: finish with the result object, the brief's own reporting stays. */
export const STRUCTURED_OUTPUT_SUFFIX = [
  '',
  '---',
  'End each turn with the StructuredOutput tool and the we.worker-result object (outcome, summary, blocker, findingsAddressed, filesTouched, learning).',
  'Summary: at most 280 characters, one or two sentences. Do not move summary details elsewhere in the object; PR comments and brief reports carry detail.',
  'Each finding note: at most 300 characters.',
  'This is a non-interactive run. Launch every subagent and every command in the FOREGROUND; never use run_in_background.',
  'StructuredOutput must be the very last action of a turn.',
  'When the brief says to end the turn awaiting harness verify, still end that turn with StructuredOutput (outcome "done", short summary).',
  'The harness resumes this same session after the verdict. The last StructuredOutput is the one that counts.',
  'Use outcome "blocked" with a blocker (kind, component, evidence, retryable) when you cannot finish; put a product or tooling bug in blocker.kind "tooling-defect" or "permission-wall", and use "needs-ruling" only for a real taste or policy call with 2 or more options.',
  'Everything else in the brief above (including its report commands) still applies.',
].join('\n');

/** 117 S3b regression 2026-10-08: resume the same print-mode session with all launch flags intact. */
export function resumeArgvFrom(argv, { sessionId, prompt }) {
  const out = argv.slice(0, -1);
  const index = out.indexOf('--session-id');
  if (index < 0) throw new TypeError('operations: resumeArgvFrom needs --session-id');
  out.splice(index, 2, '--resume', sessionId);
  return [...out, `${prompt}${STRUCTURED_OUTPUT_SUFFIX}`];
}

export function resumeRequestPath(specDir, session) {
  if (!isValidSessionSlug(session)) throw new TypeError('operations: invalid resume session slug');
  return join(specDir, `${session}.resume.json`);
}

// ── result extraction per launcher (pure) ───────────────────────────────────────────────────────────────────────

/** Last <=500 chars of text, for the unparseable evidence (the router redacts it). */
const tail = (s) => (typeof s === 'string' ? s.slice(-500) : '');

/**
 * `claude -p --output-format json` stdout -> `{value}` (the structured output) or `{reason, prose}`. Never throws.
 * @returns {{value?: *, reason?: string, prose?: string}}
 */
export function extractClaudeResult(stdout) {
  let parsed;
  try { parsed = JSON.parse(String(stdout ?? '')); } catch { return { reason: 'no-structured-output', prose: tail(stdout) }; }
  const res = Array.isArray(parsed) ? [...parsed].reverse().find((m) => m && m.type === 'result') : parsed;
  if (!res || typeof res !== 'object') return { reason: 'no-structured-output', prose: tail(stdout) };
  const prose = tail(typeof res.result === 'string' ? res.result : '');
  if (res.subtype === 'error_max_structured_output_retries') return { reason: 'structured-output-retries-exhausted', prose };
  if (res.structured_output === undefined || res.structured_output === null) return { reason: 'no-structured-output', prose };
  return { value: res.structured_output, prose };
}

/** `agy --json-schema` stdout -> the nested `result.result.structured_output`; an ABSENT key (tools auto-denied) is its own reason. */
export function extractAgyResult(stdout) {
  let parsed;
  try { parsed = JSON.parse(String(stdout ?? '')); } catch { return { reason: 'no-structured-output', prose: tail(stdout) }; }
  const v = parsed?.result?.result?.structured_output;
  return v === undefined ? { reason: 'agy-key-absent', prose: tail(stdout) } : { value: v };
}

// ── the wrapper ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} WorkerSpec
 * @property {string} role               one of the worker-result ROLES
 * @property {'claude-p'|'codex-exec'|'agy'|'claude-bg'} launcher
 * @property {string} session            completion-record session slug
 * @property {string} command            `claude` / `codex` / `agy` (a test passes `process.execPath`)
 * @property {string[]} argv
 * @property {string} [cwd]
 * @property {object} [env]
 * @property {number} [timeoutMs]
 * @property {string} [model]
 * @property {string|number} [pr]
 * @property {string|number} [item]
 * @property {string} [sessionId]
 * @property {string} [specDir]          directory for harness resume requests
 * @property {string} [resultFile]       codex: the `-o` file the result is read from
 * @property {string} [completionsDir]
 * @property {string} [draftsDir]
 * @property {string} [postmortemMode]   off | draft | file (else resolved from env)
 */

/** An operator stop is the WRAPPER being told to stop (TERM/INT/HUP delivered to this process while the child runs). It is NOT inferred
 *  from how the child ended, so a worker that signals ITSELF or `exit 143`s can no longer pick `aborted` (no draft). RESIDUAL: Node cannot
 *  tell who sent a signal, so a worker that deliberately signals its PARENT (`kill -TERM $PPID`, or the process group) is still read as a
 *  stop; closing that needs a stop sentinel the stopper writes, which no stop tooling does yet. The operator's stop must also target the
 *  wrapper pid, not the worker pid in the started record (a worker killed directly is a contract violation). */
export const OPERATOR_STOP_SIGNALS = Object.freeze(['SIGTERM', 'SIGINT', 'SIGHUP']);
/** After a forwarded stop signal, a child that ignores it is SIGKILLed after this long, so the wrapper still writes its record. */
const STOP_GRACE_MS = 5_000;
/** `spawnToCompletion` kills the child itself on a stream overflow and says so in the message (it sets `killed` too). */
const isOverflow = (failure) => /maxBuffer exceeded/.test(String(failure?.message ?? ''));

/**
 * Run ONE worker to completion and leave its v2 record behind. Resolves (never rejects on a worker failure): the
 * envelope IS the failure report. It rejects only on a bad spec or a record that cannot be written.
 *
 * @param {WorkerSpec} spec
 * @param {object} [io]
 * @param {typeof spawnToCompletion} [io.spawnToCompletionFn]
 * @param {typeof spawn} [io.spawnFn]
 * @param {() => string} [io.now]
 * @param {() => number} [io.nowMs]                   wall clock (defaults to parsing io.now)
 * @param {(sessionId: string) => *} [io.awaitingVerify]
 * @param {(ms: number) => Promise<void>} [io.sleep]
 * @param {number} [io.pollMs]
 * @param {number} [io.selfPid]
 * @param {(f: string) => string} [io.readFile]
 * @param {() => string|null} [io.head]               HEAD probe for headBefore / headAfter
 * @param {() => (object|null)} [io.legacyRead]       the old report for a launcher still migrating
 * @param {(failure: Error|null) => boolean} [io.isOperatorStop]  true when the operator stopped the worker (D6: aborted, no job), whatever the child's exit (`failure` is null when it exited 0); default: this wrapper was sent TERM/INT/HUP during the run
 * @param {{on: Function, off: Function}} [io.stopSource]  where the stop signals arrive (default `process`); a test passes an EventEmitter
 * @param {(record: object, dir: string) => *} [io.writeRecord]
 * @param {(action: object, o: {dir: string}) => *} [io.writeDraft]
 * @returns {Promise<{envelope: object, result: object, action: object, legacyRecord: object|null, stdout: string, stderr: string, failure: Error|null, resourceUsage: object|null}>}
 */
export async function runWorker(spec, io = {}) {
  const { stopSource = process } = io;
  // `live` is false once the child has ended: a stop that lands after that (e.g. during the record write) cannot have aborted the worker,
  // so it must not relabel a genuine crash `aborted`; it is still remembered in `signal` so it can be re-raised below.
  const stop = { requested: false, signal: null, live: true, forward: null };
  // Listen for the stop for the WHOLE run, record write included: with a handler installed Node no longer dies on TERM before the envelope is written.
  const onStop = (sig) => {
    stop.signal ??= sig;
    if (!stop.live) return;
    stop.requested = true;
    stop.forward?.(sig);
  };
  for (const sig of OPERATOR_STOP_SIGNALS) stopSource.on(sig, onStop);
  try {
    return await runWorkerOnce(spec, io, stop);
  } finally {
    for (const sig of OPERATOR_STOP_SIGNALS) stopSource.off(sig, onStop);
    // Our handler swallowed the signal, and runWorker can run in a long-lived process (the in-process build path): once the envelope is
    // written, hand the stop back to the default action so the operator's stop still ends that process (codex-direct-task.mjs does the same).
    const reraise = io.reraise ?? (stopSource === process ? (sig) => process.kill(process.pid, sig) : null);
    if (stop.signal && reraise) reraise(stop.signal);
  }
}

async function runWorkerOnce(spec, io, stop) {
  for (const k of ['role', 'launcher', 'session', 'command']) if (!spec?.[k]) throw new TypeError(`operations: runWorker needs spec.${k}`);
  const dir = spec.completionsDir ?? resolveCompletionsDir();
  // 117 S3b — a wrapped `--bg` brief (fix / ci-heal / review) still tells its agent to `completion-cli report` into
  // THIS session's completion record. A JSON spec cannot carry a function, so the flag selects that store as the
  // legacy reader (section 5 order) and as the source of the agent's own outcome words (see `preserveLegacyWords`).
  const completionLegacyRead = spec.legacyFromCompletion ? () => { try { return tryReadCompletion(spec.session, dir); } catch { return null; } } : null;
  const {
    spawnToCompletionFn = spawnToCompletion, spawnFn = spawn, now = () => new Date().toISOString(), readFile = readBoundedResultFile,
    head = () => null, legacyRead = completionLegacyRead, isOperatorStop = () => stop.requested, writeRecord = writeCompletion, writeDraft = writeProductFixDraft,
    selfPid = process.pid, pollMs = 15_000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = io;
  const clock = io.nowMs ?? (() => Date.parse(now()));
  const awaitingVerify = io.awaitingVerify ?? (async (sessionId) => {
    if (!sessionId) return null;
    const { readStoredAwaitVerify, awaitVerifyStoreKey, classifyAwaitVerify, resolveAwaitVerifyTtlMs } = await import('../conveyor/await-verify.mjs');
    // `readStoredAwaitVerify` answers null for a missing AND an unreadable/unparseable record. Only a missing one means "not
    // awaiting"; a record that exists but cannot be read is an unknown, reported as `{unreadable}` (never as "finished").
    let text = null;
    let readError = null;
    const record = readStoredAwaitVerify(awaitVerifyStoreKey({ sessionId }), {
      readFileSyncFn: (path, enc) => {
        try { text = readFileSync(path, enc); return text; } catch (e) { if (e?.code !== 'ENOENT') readError = e; throw e; }
      },
    });
    if (!record && (readError || text !== null)) return { unreadable: true };
    const verdict = classifyAwaitVerify({ record, session: { sessionId, name: spec.session }, nowMs: clock(), ttlMs: resolveAwaitVerifyTtlMs() });
    if (verdict.awaiting) return { awaiting: true, record };
    // PR #4462 review: a record that is OURS but past its TTL is a wait that ran out, not "no wait owed"; collapsing it to null let a
    // turn that ended awaiting a verdict finish `done` unverified. A record the classifier cannot trust (torn shape, clock skew, no
    // clock) is an unknown, exactly like an unreadable file. Only "no record" and a record that speaks for another session mean none.
    if (verdict.reason === 'expired') return { expired: true, record };
    if (['malformed', 'future-skew', 'no-signal'].includes(verdict.reason)) return { unreadable: true };
    return null;
  });
  // The codex `-o` file is written by the CHILD, so a relative path means relative to the child's cwd — resolve it once and use it for
  // the pre-run cleanup AND the read. (completionsDir / draftsDir / operationsDir are the WRAPPER's own and stay wrapper-relative.)
  const resultFile = spec.resultFile ? resolve(spec.cwd ?? process.cwd(), spec.resultFile) : null;
  const timeoutMs = Number.isInteger(spec.timeoutMs) && spec.timeoutMs > 0 ? spec.timeoutMs : DEFAULT_TIMEOUT_MS;
  const base = { session: spec.session, role: spec.role, launcher: spec.launcher, model: spec.model ?? null, pr: spec.pr ?? null, item: spec.item ?? null, sessionId: spec.sessionId ?? null, cwd: spec.cwd ?? null };
  const headBefore = head();

  let started = newEnvelopeRecord({ ...base, headBefore, timeoutMs, now });
  const deadlineMs = Date.parse(started.startedAt) + timeoutMs;
  started.deadlineAt = new Date(deadlineMs).toISOString();
  let recordWriteFailure = null; // an infrastructure fault (lock timeout), not a worker failure: runWorker rejects with it
  // The job record: written the moment the child has a pid (the spawn seam below), before it can finish.
  let graceTimer = null;
  const spawnWithPid = (cmd, argv, opts) => {
    const child = spawnFn(cmd, argv, opts);
    // An operator stop is forwarded to the child; one that ignores it is SIGKILLed after a grace, so the wrapper still writes its record.
    // The child's exit ends the window in which a stop can still have stopped it: a TERM that lands after a clean exit (before the spawn
    // promise settles) must not turn a finished result into `aborted`.
    child?.once?.('exit', () => { stop.live = false; });
    stop.forward = (sig) => {
      try { child.kill(sig); } catch { /* already gone */ }
      graceTimer ??= setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, STOP_GRACE_MS);
      graceTimer.unref?.();
    };
    if (stop.requested) stop.forward('SIGTERM'); // the stop landed before the child existed
    if (child?.pid) {
      started = { ...started, pid: child.pid, updatedAt: now() };
      // A failed job-record write must not leave the child running unseen (60-minute budget, still editing the lane).
      try { withCompletionLock(spec.session, () => writeRecord(started, dir), { dir }); } catch (e) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        recordWriteFailure = e;
        throw e;
      }
    }
    return child;
  };

  // A result file left by an earlier attempt must not read as this run's result (codex: a clean exit + a stale `-o` file).
  if (spec.launcher === 'codex-exec' && resultFile) { try { rmSync(resultFile, { force: true }); } catch { /* best effort */ } }

  let stdout = '';
  let stderr = '';
  let failure = null;
  let resourceUsage = null;
  const run = async (argv) => {
    try {
      const out = await spawnToCompletionFn(spec.command, argv, {
        // EVERY launch path gets the same env hygiene (a static GH_TOKEN stripped, the worker marker set), not just the callers that
        // happen to pass a sanitising spawn: the detached CLI and any future launcher inherit it here.
        cwd: spec.cwd, env: markWorkerEnv(sanitizeSpawnEnv(spec.env ?? process.env)), timeout: Math.max(1, deadlineMs - clock()), killSignal: 'SIGKILL',
        stdio: ['ignore', 'pipe', 'pipe'], // stdin closed: codex hangs on an open pipe (S0)
      }, { spawnFn: spawnWithPid });
      stdout = out.stdout; stderr = out.stderr; resourceUsage = out.resourceUsage ?? null;
    } catch (e) {
      failure = e;
      stdout = e?.stdout ?? ''; stderr = e?.stderr ?? ''; resourceUsage = e?.resourceUsage ?? null;
    }
    if (started.pid == null) withCompletionLock(spec.session, () => writeRecord(started, dir), { dir });
  };
  await run(spec.argv ?? []);

  // 117 S3b regression 2026-10-08: an ended print-mode turn leaves the wrapper alive for harness verification.
  // Set while the LAST turn ended awaiting a verdict that never reached this wrapper (see `verifyUnfinishedResult`).
  let unfinishedVerify = null;
  if (spec.launcher === 'claude-p') {
    const requestPath = resumeRequestPath(spec.specDir ?? join(dirname(dir), 'worker-wrapper-specs'), spec.session);
    let resumes = 0;
    let servedAt = null; // the `requestedAt` of the await record the last resume answered: its leftover record is not a new obligation
    const expiredWait = (w) => (w?.expired && w.record?.requestedAt !== servedAt ? { sha: w.record.sha, pr: w.record.pr, ref: w.record.ref } : null);
    while (!failure && !isOperatorStop() && clock() < deadlineMs && resumes < MAX_AWAIT_RESUMES) {
      let awaiting = await awaitingVerify(spec.sessionId);
      if (awaiting?.unreadable) { unfinishedVerify = {}; break; } // cannot tell whether a verdict is owed: not a finished run
      // An already-expired record means the verdict can no longer be delivered (nothing resumes on it): the turn's `done` is unverified.
      if (!awaiting?.awaiting) { unfinishedVerify = expiredWait(awaiting); break; }
      const { sha, pr, ref, requestedAt } = awaiting.record;
      unfinishedVerify = { sha, pr, ref };
      withCompletionLock(spec.session, () => writeRecord({
        ...started, pid: selfPid, updatedAt: now(), awaitingVerify: { sha, pr, ref, requestedAt },
      }, dir), { dir });
      let request = null;
      while (!failure && !isOperatorStop() && clock() < deadlineMs) {
        awaiting = await awaitingVerify(spec.sessionId);
        try {
          request = JSON.parse(readFile(requestPath));
          rmSync(requestPath, { force: true });
          if (request?.v !== 1 || request.sessionId !== spec.sessionId || typeof request.prompt !== 'string') request = null;
        } catch (e) {
          if (e instanceof SyntaxError) rmSync(requestPath, { force: true });
          request = null;
        }
        if (request || !awaiting?.awaiting) break;
        await sleep(Math.min(pollMs, Math.max(0, deadlineMs - clock())));
      }
      if (!request || isOperatorStop() || clock() >= deadlineMs) break;
      resumes += 1;
      servedAt = requestedAt;
      unfinishedVerify = null; // a verdict arrived: the resumed turn is the one that settles it
      await run(resumeArgvFrom(spec.argv, { sessionId: spec.sessionId, prompt: request.prompt }));
    }
    // The loop also ends on the resume cap or the deadline right after a turn that asked to wait again: look once more.
    if (!unfinishedVerify && !failure && !isOperatorStop() && (resumes >= MAX_AWAIT_RESUMES || clock() >= deadlineMs)) {
      const last = await awaitingVerify(spec.sessionId);
      if (last?.awaiting) unfinishedVerify = { sha: last.record.sha, pr: last.record.pr, ref: last.record.ref };
      else if (last?.unreadable) unfinishedVerify = {};
      else unfinishedVerify = expiredWait(last);
    }
  }
  stop.live = false;
  clearTimeout(graceTimer);
  if (recordWriteFailure) throw recordWriteFailure; // the child was killed; the docblock's "cannot be written" rejection

  // 1. the channel for this launcher
  let extracted;
  if (spec.launcher === 'codex-exec') {
    try { extracted = { text: readFile(resultFile), prose: tail(stdout) }; } catch (e) {
      // a file the wrapper REFUSED (link, not a regular file, over the cap) is a contract violation of the channel; anything else (missing, unreadable) is "wrote nothing".
      // The evidence prose is capped at ~200 chars FROM THE HEAD (unparseableOutcome), so the refusal note goes first and only a short stdout tail follows it.
      const refused = e?.code === 'EWRAPPER_REFUSED' || e?.code === 'ELOOP';
      extracted = refused
        ? { reason: 'schema-violation', prose: [`result file refused (${e.code === 'ELOOP' ? 'result file is a symlink' : e.message})`, tail(stdout).slice(-100)].filter(Boolean).join(' | ') }
        : { reason: 'no-structured-output', prose: tail(stdout) };
    }
  } else if (spec.launcher === 'agy') extracted = extractAgyResult(stdout);
  else extracted = extractClaudeResult(stdout);

  // 2. settle: the worker's result, else the legacy record (migration only), else fail closed
  // An operator stop is decided by whether the wrapper was told to stop WHILE the child was live, not by how the child then died: a child
  // that handles the forwarded TERM and exits 0 (a cooperative shutdown) is still stopped work, so `failure` may be null here.
  const aborted = isOperatorStop(failure);
  let legacyRecord = null;
  let settled;
  // FAIL CLOSED: a child that timed out, was signalled or exited non-zero never yields a success envelope, even when
  // it printed (or left, for codex's -o file) a valid-looking result first — the result may be incomplete work.
  const gotResult = !failure && (extracted.value !== undefined || (typeof extracted.text === 'string' && extracted.text.trim() !== ''));
  if (aborted) settled = settleWorkerResult({ role: spec.role, launcher: spec.launcher, aborted: true });
  else if (gotResult) settled = settleWorkerResult({ role: spec.role, launcher: spec.launcher, value: extracted.value, text: extracted.text, prose: extracted.prose });
  else {
    legacyRecord = !failure && legacyRead ? legacyRead() : null;
    if (legacyRecord && legacyRecord.status === 'done') {
      const legacy = envelopeFromLegacy({ session: spec.session, kind: spec.role, ...legacyRecord }, spec.role === 'build' ? 'legacy-delivery-report' : 'legacy-fix-report', { role: spec.role, launcher: spec.launcher });
      settled = { result: legacy.result, parse: legacy.parse, reroute: null, source: legacy.source };
    } else {
      legacyRecord = null;
      // `timeout` only when OUR timeout killed it; an overflow or any other signal is `ended-without-result` (the failure
      // message, kept in the prose below, says which), so the draft signature does not blame a timeout for them.
      const reason = failure ? (failure.killed && !isOverflow(failure) ? 'timeout' : 'ended-without-result') : extracted.reason;
      settled = settleWorkerResult({
        role: spec.role, launcher: spec.launcher, reason, prose: [extracted.prose, failure ? redactFreeText(String(failure.message ?? ''), 300) : ''].filter(Boolean).join(' | '),
      });
    }
  }

  // A wait that ended with no verdict delivered: the awaiting turn's `done` only promised to continue after the harness
  // verified and pushed, and the harness never did. Not a completion (PR #4462 review): a retryable infra block.
  const verifyUnfinished = !aborted && !failure && unfinishedVerify && settled.parse?.ok && settled.result?.outcome === 'done';
  if (verifyUnfinished) settled = { ...settled, result: verifyUnfinishedResult(settled.result, unfinishedVerify), reroute: null };

  // 3. route, write, and make the draft
  const mode = spec.postmortemMode ?? resolvePostmortemMode({ env: process.env, operationsDir: spec.operationsDir ?? defaultOperationsDir() });
  const action = routeWorkerResult(settled.result, { role: spec.role, launcher: spec.launcher, session: spec.session, pr: spec.pr == null ? null : String(spec.pr), item: spec.item == null ? null : String(spec.item), postmortemMode: mode });
  let finished = finishEnvelopeRecord(started, {
    result: settled.result, parse: settled.parse, action, outcome: legacyOutcomeWord(settled.result), reroute: settled.reroute,
    // The wrapper wrote this result itself even when it is a fail-closed or aborted one: `none` is only for a legacy record that never reported.
    headAfter: head(), source: settled.source ?? 'worker-result',
  }, now);
  // (An unfinished wait keeps its own words: an earlier self-reported `done` in the store must not win over the block.)
  if (spec.preserveLegacyWords && !aborted && !verifyUnfinished && legacyRead) finished = preserveLegacyWords(finished, legacyRecord ?? (failure ? null : legacyRead()));
  withCompletionLock(spec.session, () => writeRecord(finished, dir), { dir });
  if (action.type === 'product-fix-draft') {
    // the shared 114 drafts store unless the spec names another; mode `off` writes nothing (the router put the mode on the action)
    try { writeDraft(action, { dir: spec.draftsDir ?? defaultDraftsDir(), now }); } catch { /* the envelope is the record of truth; a draft failure must not lose it */ }
  }
  return { envelope: finished, result: settled.result, action, legacyRecord, stdout, stderr, failure, resourceUsage };
}

/**
 * The result of a wrapped turn that ended awaiting harness verification when the wait itself then ran out (the await
 * record expired or was cleared with no resume request, the wall deadline passed, or the resume cap was spent). The
 * awaiting turn was told to end with outcome `done`, but nothing was verified or pushed, so it is `blocked` /
 * `infra-transient` (retryable: reconcile re-dispatches after the cool-off). The turn's own summary stays as evidence. PURE.
 * @param {object} result the validated worker result of the last turn
 * @param {{sha?: string, pr?: *, ref?: string}} wait the await record the wrapper was waiting on
 */
export function verifyUnfinishedResult(result, wait = {}) {
  const sha = typeof wait.sha === 'string' ? wait.sha.slice(0, 12) : 'unknown';
  // The wrapper cannot know whether the harness pushed (a verdict may land just as the wait ends): the retry re-reads the PR.
  const text = `The turn ended awaiting harness verification of ${sha}${wait.ref ? ` for ${wait.ref}` : ''}, and no verdict was applied by the wrapper `
    + `before the wait ran out (record expired, cleared or unreadable, deadline, or resume cap). Last summary: ${result.summary}`;
  return {
    ...result,
    outcome: 'blocked',
    summary: 'Verification wait ended with no verdict applied (retryable).',
    blocker: {
      kind: 'infra-transient', component: 'verify-wait', evidence: { text: text.slice(0, 2000), refs: [] },
      proposedFix: null, ruling: null, deniedCommand: null, retryable: true,
    },
  };
}

/** The v1 words a wrapped agent may have reported itself (its brief still says to), carried over verbatim. */
export const LEGACY_WORD_FIELDS = Object.freeze(['outcome', 'verdict', 'label', 'runId', 'denied', 'cause']);

/**
 * 117 S3b — KEEP THE READERS' WORDS. `markSelfReportedDone` and the reaper branch on the agent's OWN outcome word
 * (`healed`, `needs-human`, `blocked-on-permission` + `denied`, `blocked-on-infra` + `cause`, ...). The worker
 * result is the new truth (`result` / `action`), but `legacyOutcomeWord` is coarser than those words, so when the
 * agent DID report `done` itself, its words win on the envelope's legacy fields: existing readers behave exactly as
 * before the launch moved. PURE. A record that is not a finished report (missing, `started`) changes nothing.
 * @param {object} envelope a finished v2 record
 * @param {object|null} legacy the session's record as the agent left it
 */
export function preserveLegacyWords(envelope, legacy) {
  if (!legacy || legacy.status !== 'done' || typeof legacy.outcome !== 'string' || !legacy.outcome) return envelope;
  const out = { ...envelope };
  for (const k of LEGACY_WORD_FIELDS) if (legacy[k] !== undefined && legacy[k] !== null) out[k] = legacy[k];
  return out;
}

// ── detached launch + CLI ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Launch a spec through THIS file as a detached node process (`unref`ed; survives its parent). The spec is written
 * to `<specDir>/<session>.spec.json` first; the child reads it, runs {@link runWorker}, and exits. `wrapperPid` is the
 * wrapper process; the v2 record's `pid` is the WORKER child the wrapper then spawns (a different process).
 * @returns {{wrapperPid: number, specFile: string}}
 */
export function launchDetached(spec, { specDir, spawnFn = spawn, nodePath = process.execPath, entry = fileURLToPath(import.meta.url) } = {}) {
  if (!specDir) throw new TypeError('operations: launchDetached needs specDir');
  if (!isValidSessionSlug(spec?.session)) throw new TypeError(`operations: launchDetached: invalid session slug ${JSON.stringify(spec?.session)}`);
  mkdirSync(specDir, { recursive: true, mode: 0o700 });
  const specFile = join(specDir, `${spec.session}.spec.json`);
  // The spec file never carries `env` (it can hold tokens): the detached child inherits the launcher's environment
  // instead, with a static GH_TOKEN stripped and the worker marker set (the worker it spawns is sanitised again in runWorker).
  // Owner-only permissions; the child deletes it once read.
  const { env: _env, ...safe } = spec;
  writeFileSync(specFile, `${JSON.stringify({ ...safe, specDir })}\n`, { mode: 0o600 });
  const child = spawnFn(nodePath, [entry, `--spec=${specFile}`], { detached: true, stdio: 'ignore', env: markWorkerEnv(sanitizeSpawnEnv(spec.env ?? process.env)) });
  child.unref?.();
  return { wrapperPid: child.pid, specFile };
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--spec='));
  if (!arg) { process.stderr.write('usage: worker-wrapper.mjs --spec=<file.json>\n'); process.exitCode = 2; } else {
    try {
      const specFile = arg.slice('--spec='.length);
      const spec = JSON.parse(readFileSync(specFile, 'utf8'));
      if (spec.deleteSpec !== false) { try { rmSync(specFile, { force: true }); } catch { /* best effort */ } }
      const { envelope } = await runWorker(spec);
      process.stdout.write(`${JSON.stringify({ session: envelope.session, outcome: envelope.outcome, action: envelope.action?.type, parse: envelope.parse })}\n`);
    } catch (e) {
      process.stderr.write(`error: ${String(e?.message ?? e)}\n`);
      process.exitCode = 1;
    }
  }
}
