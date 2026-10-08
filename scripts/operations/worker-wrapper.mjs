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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { finishEnvelopeRecord, isValidSessionSlug, newEnvelopeRecord, redactFreeText } from './completion-record.mjs';
import { resolveCompletionsDir, withCompletionLock, writeCompletion } from './completion-store.mjs';
import { WORKER_RESULT_SCHEMA } from './worker-result.mjs';
import {
  defaultDraftsDir, defaultOperationsDir, envelopeFromLegacy, legacyOutcomeWord, resolvePostmortemMode, routeWorkerResult, settleWorkerResult,
  writeProductFixDraft,
} from './worker-result-router.mjs';
import { spawnToCompletion } from '../lib/spawn-to-completion.mjs';

/** The knob. `WE_WORKER_WRAPPER=on` routes a migrated launcher through this wrapper; anything else is the old path, byte for byte. */
export const WORKER_WRAPPER_ENV = 'WE_WORKER_WRAPPER';
export function workerWrapperEnabled(env = process.env) {
  return String(env[WORKER_WRAPPER_ENV] ?? '').toLowerCase() === 'on';
}

/** Default budget when a spec names none (the build path passes its own 60-minute budget). */
export const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

// ── argv + prompt helpers (pure) ────────────────────────────────────────────────────────────────────────────────

/** The schema as the one-line JSON the `--json-schema` flag takes. */
export function workerResultSchemaJson() {
  return JSON.stringify(WORKER_RESULT_SCHEMA);
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
  'Final step: end by calling the StructuredOutput tool once with the we.worker-result object (outcome, summary, blocker, findingsAddressed, filesTouched, learning).',
  'Use outcome "blocked" with a blocker (kind, component, evidence, retryable) when you cannot finish; put a product or tooling bug in blocker.kind "tooling-defect" or "permission-wall", and use "needs-ruling" only for a real taste or policy call with 2 or more options.',
  'Everything else in the brief above (including its report commands) still applies.',
].join('\n');

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
 * @property {string} [resultFile]       codex: the `-o` file the result is read from
 * @property {string} [completionsDir]
 * @property {string} [draftsDir]
 * @property {string} [postmortemMode]   off | draft | file (else resolved from env)
 */

const OPERATOR_STOP_SIGNALS = Object.freeze(['SIGTERM', 'SIGINT', 'SIGHUP']);
/** `spawnToCompletion` kills the child itself on a stream overflow and says so in the message (it sets `killed` too). */
const isOverflow = (failure) => /maxBuffer exceeded/.test(String(failure?.message ?? ''));
/** A signal that did not come from OUR timeout or buffer guard (`killed` false): someone outside stopped the worker. */
const isExternalStop = (failure) => !!failure && !failure.killed && OPERATOR_STOP_SIGNALS.includes(failure.signal);

/**
 * Run ONE worker to completion and leave its v2 record behind. Resolves (never rejects on a worker failure): the
 * envelope IS the failure report. It rejects only on a bad spec or a record that cannot be written.
 *
 * @param {WorkerSpec} spec
 * @param {object} [io]
 * @param {typeof spawnToCompletion} [io.spawnToCompletionFn]
 * @param {typeof spawn} [io.spawnFn]
 * @param {() => string} [io.now]
 * @param {(f: string) => string} [io.readFile]
 * @param {() => string|null} [io.head]               HEAD probe for headBefore / headAfter
 * @param {() => (object|null)} [io.legacyRead]       the old report for a launcher still migrating
 * @param {(failure: Error) => boolean} [io.isOperatorStop]  true when the operator stopped the worker (D6: aborted, no job); default: an EXTERNAL TERM/INT/HUP
 * @param {(record: object, dir: string) => *} [io.writeRecord]
 * @param {(action: object, o: {dir: string}) => *} [io.writeDraft]
 * @returns {Promise<{envelope: object, result: object, action: object, legacyRecord: object|null, stdout: string, stderr: string}>}
 */
export async function runWorker(spec, io = {}) {
  const {
    spawnToCompletionFn = spawnToCompletion, spawnFn = spawn, now = () => new Date().toISOString(), readFile = (f) => readFileSync(f, 'utf8'),
    head = () => null, legacyRead = null, isOperatorStop = isExternalStop, writeRecord = writeCompletion, writeDraft = writeProductFixDraft,
  } = io;
  for (const k of ['role', 'launcher', 'session', 'command']) if (!spec?.[k]) throw new TypeError(`operations: runWorker needs spec.${k}`);
  const timeoutMs = Number.isInteger(spec.timeoutMs) && spec.timeoutMs > 0 ? spec.timeoutMs : DEFAULT_TIMEOUT_MS;
  const dir = spec.completionsDir ?? resolveCompletionsDir();
  const base = { session: spec.session, role: spec.role, launcher: spec.launcher, model: spec.model ?? null, pr: spec.pr ?? null, item: spec.item ?? null, sessionId: spec.sessionId ?? null };
  const headBefore = head();

  let started = newEnvelopeRecord({ ...base, headBefore, timeoutMs, now });
  // The job record: written the moment the child has a pid (the spawn seam below), before it can finish.
  const spawnWithPid = (cmd, argv, opts) => {
    const child = spawnFn(cmd, argv, opts);
    if (child?.pid) {
      started = newEnvelopeRecord({ ...base, headBefore, pid: child.pid, timeoutMs, now });
      // A failed job-record write must not leave the child running unseen (60-minute budget, still editing the lane).
      try { withCompletionLock(spec.session, () => writeRecord(started, dir), { dir }); } catch (e) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        throw e;
      }
    }
    return child;
  };

  // A result file left by an earlier attempt must not read as this run's result (codex: a clean exit + a stale `-o` file).
  if (spec.launcher === 'codex-exec' && spec.resultFile) { try { rmSync(spec.resultFile, { force: true }); } catch { /* best effort */ } }

  let stdout = '';
  let stderr = '';
  let failure = null;
  try {
    const out = await spawnToCompletionFn(spec.command, spec.argv ?? [], {
      cwd: spec.cwd, env: spec.env ?? process.env, timeout: timeoutMs, killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'], // stdin closed: codex hangs on an open pipe (S0)
    }, { spawnFn: spawnWithPid });
    stdout = out.stdout; stderr = out.stderr;
  } catch (e) {
    failure = e;
    stdout = e?.stdout ?? ''; stderr = e?.stderr ?? '';
  }
  // If the injected spawn never reported a pid (a fake child), still leave a started record behind.
  if (started.pid == null) withCompletionLock(spec.session, () => writeRecord(started, dir), { dir });

  // 1. the channel for this launcher
  let extracted;
  if (spec.launcher === 'codex-exec') {
    try { extracted = { text: readFile(spec.resultFile), prose: tail(stdout) }; } catch { extracted = { reason: 'no-structured-output', prose: tail(stdout) }; }
  } else if (spec.launcher === 'agy') extracted = extractAgyResult(stdout);
  else extracted = extractClaudeResult(stdout);

  // 2. settle: the worker's result, else the legacy record (migration only), else fail closed
  const aborted = failure && isOperatorStop(failure);
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

  // 3. route, write, and make the draft
  const mode = spec.postmortemMode ?? resolvePostmortemMode({ env: process.env, operationsDir: spec.operationsDir ?? defaultOperationsDir() });
  const action = routeWorkerResult(settled.result, { role: spec.role, launcher: spec.launcher, session: spec.session, pr: spec.pr == null ? null : String(spec.pr), item: spec.item == null ? null : String(spec.item), postmortemMode: mode });
  const finished = finishEnvelopeRecord(started, {
    result: settled.result, parse: settled.parse, action, outcome: legacyOutcomeWord(settled.result), reroute: settled.reroute,
    headAfter: head(), source: settled.source ?? (gotResult ? 'worker-result' : 'none'),
  }, now);
  withCompletionLock(spec.session, () => writeRecord(finished, dir), { dir });
  if (action.type === 'product-fix-draft') {
    // the shared 114 drafts store unless the spec names another; mode `off` writes nothing (the router put the mode on the action)
    try { writeDraft(action, { dir: spec.draftsDir ?? defaultDraftsDir(), now }); } catch { /* the envelope is the record of truth; a draft failure must not lose it */ }
  }
  return { envelope: finished, result: settled.result, action, legacyRecord, stdout, stderr };
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
  // instead. Owner-only permissions; the child deletes it once read.
  const { env: _env, ...safe } = spec;
  writeFileSync(specFile, `${JSON.stringify(safe)}\n`, { mode: 0o600 });
  const child = spawnFn(nodePath, [entry, `--spec=${specFile}`], { detached: true, stdio: 'ignore', env: spec.env ?? process.env });
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

