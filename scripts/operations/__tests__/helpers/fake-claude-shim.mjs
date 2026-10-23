#!/usr/bin/env node
/**
 * @file fake-claude-shim.mjs — epic #3383 part 3 (fake agent sessions). THE STATE MACHINE, as real importable
 * code, not a string embedded in `fake-claude.mjs` (contrast the ORIGINAL `withFakeClaude`'s inline `SHIM`
 * template literal, kept untouched below it in `fake-claude.mjs` — this file is a second, separate shim for
 * the simulator, following `scripts/review-corpus/__tests__/helpers/git-replay.mjs`'s own precedent: one
 * `.mjs` file that is BOTH a normal ES module (exported, unit-testable functions) AND a CLI entry point
 * (the `IS_CLI` guard at the bottom), wrapped by a tiny `#!/bin/sh` `claude` bin that `exec`s
 * `node <this file's abs path> "$@"`.
 *
 * ============================================================================================================
 * THE LISTING CONTRACT, DERIVED FROM THE REAL CONSUMERS (read, not guessed — file:line evidence in each case):
 * ============================================================================================================
 *
 * `claude agents --json` (NO `--all`) vs `claude agents --json --all`:
 *   - `we:scripts/operations/dispatch-lane-io.mjs#defaultListAgents` (line ~1873) takes an `all` flag,
 *     defaulted `false`, and its own docblock (line ~1869) says: *"`all` defaults to `false` — every existing
 *     caller keeps today's active-sessions-only behavior unchanged; pass `all: true` ONLY from a caller whose
 *     job requires seeing completed sessions too."* So NO-`--all` = active sessions only; `--all` = active +
 *     terminal (done/failed/stopped).
 *   - `we:scripts/conveyor/reconcile-fix-dispatch.mjs` (line ~372) confirms the other direction: a session
 *     must be *"LISTED in `claude agents --json --all` before ever recommending a resume attempt. A session
 *     that has fully exited (and been reaped, e.g. by `we:scripts/conveyor/session-reaper.mjs`) is not a
 *     resume candidate at all."* So `--all` genuinely keeps a session around after it finishes — this shim
 *     therefore never deletes a `done`/`failed`/`stopped` row from the store, only from the no-`--all` view.
 *
 * FIELDS ON A ROW (`we:scripts/conveyor/reconcile-pass.mjs` line ~18-22, `reconcile-core.mjs` bindAgents/
 * isAwaitingPermission/assessLiveness line ~300-503, `dispatch-lane-io.mjs`'s `listedSessionIds` line ~480):
 *   `id` (short handle, ONLY on `kind:'background'` rows — measured 259/259 vs 0/4 `kind:'interactive'`),
 *   `sessionId` (the one field on every row), `name`, `kind` ('background'|'interactive'), `state`
 *   ('working'|'blocked'|'done'|... — `we:scripts/conveyor/session-reaper.mjs` calls `working`/`blocked` the
 *   non-terminal axis and `done`/`failed` terminal), `status`+`waitingFor` (the permission-wait axis —
 *   `reconcile-core.mjs#isAwaitingPermission`, `status:'waiting'` + `waitingFor` naming a permission prompt),
 *   `cwd`, `startedAt`, `pid` (present on ~13/17 measured rows; ABSENT is not evidence of death per
 *   `assessLiveness`'s own doc). `pidAlive` and `laneHeadOid` are NOT part of the CLI's own listing — they are
 *   stamped on AFTER the fact by `reconcile-pass.mjs` (`process.kill(pid,0)` / `git rev-parse HEAD`), so this
 *   shim does not emit them; a real pid (this shim always mints one — see below) makes the caller's own
 *   `process.kill(pid,0)` probe work for real.
 *
 * `claude stop <id>` (`we:scripts/operations/dispatch-abort.mjs#stopSession`, line ~72): matches by the SHORT
 * id or the full `sessionId` (both run through `normalizeHandle` — trim + lowercase, both sides — line ~476).
 * An unknown/already-gone id is NOT an error case for the real CLI: it exits 1 with `No job matching '<id>'…`
 * on stderr (matched by `/No job matching/i` against the FULL stderr text, not just the first line — line
 * ~81-84), and `stopSession` maps that to `{stopped:true, alreadyGone:true}` rather than throwing.
 *
 * `--resume <id>` (`we:scripts/operations/dispatch-lane-io.mjs#buildAgentArgv`, line ~1140-1151, and its own
 * live-probe citation `docs/agent/platform-decisions.md#parked-pr-conflict-dispatched-not-scripted`): a bare
 * `claude --bg --resume <id>` genuinely resumes; ANY other flag alongside `--resume` makes the real CLI fork
 * a copy under a FRESH id instead. This shim reproduces exactly that flag-based trigger (see
 * `we:scripts/operations/__tests__/helpers/fake-claude.mjs`'s OWN `SHIM` — the original inline shim — for the
 * precedent this mirrors; that file's docblock explains why the OTHER real trigger, "target still running",
 * has nothing honest to simulate here).
 *
 * `--append-system-prompt-file` and `--settings '{"env":{...}}'` are REAL CLI flags this repo's own dispatcher
 * emits (`buildAgentArgv`, same file, line ~1188-1201) — recorded on the session (`systemPromptFile`,
 * `env.settingsEnv`), not interpreted.
 *
 * ============================================================================================================
 * THE TRANSCRIPT PATH, MEASURED (not the design brief's simplified "cwd with / replaced by -" — the real rule
 * replaces EVERY non-alphanumeric character, not just `/`; both `we:scripts/pr-status.mjs#projectDirName`,
 * line ~407, and `we:scripts/readiness/conveyor-state.mjs#recentTranscripts`, line ~738-754, agree):
 *   `~/.claude/projects/<cwd with every non-alphanumeric char replaced by '-'>/<sessionId>.jsonl`
 * e.g. `/Users/x/workspace/.lanes/web-everything/lane-1` → `-Users-x-workspace--lanes-web-everything-lane-1`
 * (the doubled dash is the literal `/` before `.lanes` PLUS the `.` of `.lanes`, each contributing one `-`).
 * This shim writes under `FAKE_CLAUDE_HOME` (never the real `~`), one JSONL line per `--bg` registration, so a
 * scenario's `clock.touch(transcriptPath(...))` has a real file to stamp and a hung-session check has a real
 * mtime to read.
 *
 * ============================================================================================================
 * STORE DISCIPLINE — same family as `fake-gh.mjs`'s: NDJSON append-only for the call log (never a
 * read-modify-write of the whole log under concurrency), tmp+rename for the session/fault store, and NEVER
 * `process.exit()` immediately after a `process.stdout.write()` (the 8KB-pipe lesson) — every exit path below
 * either returns normally (short output, small `agents --json` listings never approach that threshold in this
 * shim's own test corpus) or sets `process.exitCode` rather than calling `process.exit()` at all. UNLIKE
 * `fake-gh.mjs`'s log, the SESSION STORE genuinely needs read-modify-write (register a session, stop it, fault
 * it) from possibly-concurrent shim invocations, so it is additionally guarded by an atomic `mkdir` lock (a
 * lock *directory*, since `mkdir` is the one filesystem op every POSIX platform makes atomically exclusive).
 */

import { execFileSync } from 'node:child_process';
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { keepAliveAnchorPid, killKeepAlive, spawnKeepAlive } from '../../../lib/test-keepalive.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SHIM_PATH = resolve(HERE, 'fake-claude-shim.mjs');

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// THE STORE — sessions + faults, locked; the call log — NDJSON, append-only, unlocked (each append is one
// atomic O_APPEND write, exactly `fake-gh.mjs`'s own reasoning: a single small write to an append-mode fd
// cannot interleave with another process's).
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The states a session can be in. `working`/`blocked` are live; the rest are terminal. */
export const LIVE_STATES = new Set(['working', 'blocked']);

export function defaultStore() {
  return { sessions: [], pids: [], faults: {} };
}

function lockDirFor(storePath) {
  return `${storePath}.lock`;
}

/**
 * Acquire an exclusive `mkdir`-based lock on `storePath`, read-modify-write it, and release the lock —
 * whatever `fn` returns is this function's return value. Retries `mkdir` on `EEXIST` with a short
 * `Atomics.wait` backoff (synchronous, so this works from a plain CLI script with no event loop to wait on);
 * throws after ~5s so a genuinely wedged lock (a crashed holder that never cleaned up) fails loud rather than
 * hanging every subsequent shim call forever.
 * @param {string} storePath
 * @param {(store: object) => any} fn
 * @returns {any}
 */
export function withStoreLock(storePath, fn) {
  const lockDir = lockDirFor(storePath);
  const deadline = Date.now() + 5_000;
  let acquired = false;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir);
      acquired = true;
      break;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  if (!acquired) throw new Error(`fake-claude: timed out acquiring the session-store lock at ${lockDir}`);
  try {
    let store = defaultStore();
    if (existsSync(storePath)) {
      try { store = JSON.parse(readFileSync(storePath, 'utf8')); } catch { store = defaultStore(); }
    }
    store.sessions ??= [];
    store.pids ??= [];
    store.faults ??= {};
    const result = fn(store);
    const tmp = `${storePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(store), 'utf8');
    renameSync(tmp, storePath);
    return result;
  } finally {
    try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Read-only snapshot of the store — no lock needed for a single read (a torn read would only ever show a
 *  fully-written prior version, since writes are tmp+rename). */
export function readStoreSnapshot(storePath) {
  if (!existsSync(storePath)) return defaultStore();
  try {
    const store = JSON.parse(readFileSync(storePath, 'utf8'));
    store.sessions ??= [];
    store.pids ??= [];
    store.faults ??= {};
    return store;
  } catch {
    return defaultStore();
  }
}

export function appendCall(callsPath, record) {
  if (!callsPath) return;
  try { appendFileSync(callsPath, `${JSON.stringify(record)}\n`); } catch { /* best effort */ }
}

export function readCalls(callsPath) {
  try {
    return readFileSync(callsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** The `~/.claude/projects/` directory-name transform, matching `we:scripts/pr-status.mjs#projectDirName`
 *  exactly: every non-alphanumeric character becomes `-`. */
export function projectDirName(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

/** The transcript path this shim writes to and a scenario's clock touches. `home` is the fake `HOME`
 *  (`FAKE_CLAUDE_HOME`), never the real one. */
export function transcriptPath({ home, cwd, sessionId }) {
  return join(home, '.claude', 'projects', projectDirName(cwd), `${sessionId}.jsonl`);
}

function writeTranscriptLine({ home, cwd, sessionId, prompt }) {
  if (!home) return null;
  const dir = join(home, '.claude', 'projects', projectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const path = transcriptPath({ home, cwd, sessionId });
  const line = JSON.stringify({
    type: 'user',
    sessionId,
    message: { role: 'user', content: String(prompt ?? '') },
    timestamp: new Date().toISOString(), // sim-clock-aware IF the preload is loaded in this process
  });
  appendFileSync(path, `${line}\n`);
  return path;
}

/** An 8-hex-char short id, the same shape the real CLI's own `backgrounded · <id>` line prints
 *  (`dispatch-lane-io.mjs`'s own measured example: `fe8b4df8`). */
export function shortId() {
  return randomBytes(4).toString('hex');
}

/** A uuid-shaped full session id — the real CLI's own `sessionId` shape. */
export function fullSessionId() {
  return randomUUID();
}

/** Spawn the REAL, detached sleeper process this session's `pid` names — see the file header on why a pid
 *  must be genuinely alive rather than a made-up number: every consumer's own liveness probe is a real
 *  `process.kill(pid, 0)`, and a fabricated pid could collide with an unrelated real process. */
export function spawnSleeper() {
  // It must outlive this (short-lived) CLI on purpose, so it is untracked — bounded instead by its anchor
  // (the test runner via WE_KEEPALIVE_ANCHOR_PID; else, as a CLI, whoever ran `claude`) and a max lifetime.
  const anchorPid = keepAliveAnchorPid(process.env, IS_CLI ? process.ppid : process.pid);
  const child = spawnKeepAlive({ anchorPid, detached: true, unref: true, track: false });
  return child.pid;
}

export function killSleeper(pid) {
  if (!Number.isInteger(pid)) return;
  killKeepAlive(pid);
}

/** Find a session by short `id`, full `sessionId`, or exact `name` — case-insensitive/trimmed on the id axes,
 *  exact on `name` (mirrors `dispatch-lane-io.mjs#normalizeHandle`'s own reasoning: both sides of an id
 *  comparison are normalized the same way). */
export function findSessionIn(store, handle) {
  const norm = String(handle ?? '').trim().toLowerCase();
  return (store.sessions || []).find((s) => (
    String(s.id ?? '').toLowerCase() === norm
    || String(s.sessionId ?? '').toLowerCase() === norm
    || s.name === handle
  )) ?? null;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// ARGV PARSING — commander-shaped, same reasoning as the original `fake-claude.mjs` SHIM: options anywhere,
// operands wherever they fall, a leading-dash operand read as an unknown flag (so a caller's own "refuse a
// brief that begins with `-`" guard is exercised against a parser that behaves like the real one, not assumed
// safe against one that doesn't).
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function parseBgArgv(argv) {
  let bg = false;
  let name = null;
  let settingsRaw = null;
  let systemPromptFile = null;
  let resumeId = null;
  let model = null;
  let effort = null;
  const disallowedTools = [];
  const operands = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--bg') { bg = true; continue; }
    if (a === '-n' || a === '--name') { name = argv[i += 1]; continue; }
    if (a === '--settings') { settingsRaw = argv[i += 1]; continue; }
    if (a === '--append-system-prompt-file') { systemPromptFile = argv[i += 1]; continue; }
    if (a === '--resume') { resumeId = argv[i += 1]; continue; }
    if (a === '--disallowedTools') { disallowedTools.push(...String(argv[i += 1] ?? '').split(',').filter(Boolean)); continue; }
    if (a.startsWith('--disallowedTools=')) { disallowedTools.push(...a.slice('--disallowedTools='.length).split(',').filter(Boolean)); continue; }
    // #3857 / risk-based review tier — `buildAgentArgv` injects the table's `--model <id>`; a real CLI flag.
    if (a === '--model' || a === '-m') { model = argv[i += 1]; continue; }
    if (a.startsWith('--model=')) { model = a.slice('--model='.length); continue; }
    if (a === '--effort') { effort = argv[i += 1]; continue; }
    if (a.startsWith('--effort=')) { effort = a.slice('--effort='.length); continue; }
    if (a.startsWith('-')) return { error: `unknown option ${a}` };
    operands.push(a);
  }
  if (effort !== null && !['low', 'medium', 'high', 'max'].includes(effort)) return { error: `invalid effort ${effort}` };
  return { bg, name, settingsRaw, systemPromptFile, resumeId, model, effort, disallowedTools, prompt: operands.join(' ') };
}

function parseSettingsEnv(settingsRaw) {
  if (!settingsRaw) return null;
  try {
    const parsed = JSON.parse(settingsRaw);
    return parsed?.env ?? null;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// THE CLI ITSELF
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function writeLine(fd, text) {
  try { process[fd === 1 ? 'stdout' : 'stderr'].write(text); } catch { /* best effort */ }
}

export function main(argv, env) {
  const storePath = env.FAKE_CLAUDE_STORE;
  const callsPath = env.FAKE_CLAUDE_CALLS;
  const home = env.FAKE_CLAUDE_HOME || null;
  if (!storePath) {
    writeLine(2, 'fake-claude-shim: FAKE_CLAUDE_STORE is not set\n');
    process.exitCode = 1;
    return;
  }
  appendCall(callsPath, { argv, cwd: process.cwd(), at: Date.now() });

  // ── `agents --json [--all]` ──────────────────────────────────────────────────────────────────────────
  if (argv[0] === 'agents') {
    const faults = readStoreSnapshot(storePath).faults;
    if (faults['list-fails']) {
      writeLine(2, 'fake-claude: command not found (simulated ENOENT)\n');
      process.exitCode = 127;
      return;
    }
    if (faults['list-empty']) {
      if (argv.includes('--json')) process.stdout.write('[]');
      return;
    }
    const all = argv.includes('--all');
    const store = readStoreSnapshot(storePath);
    const rows = all ? store.sessions : store.sessions.filter((s) => LIVE_STATES.has(s.state));
    if (argv.includes('--json')) process.stdout.write(JSON.stringify(rows));
    return;
  }

  // ── `auth status --json` ────────────────────────────────────────────────────────────────────────────
  // Card x5kagse (epic #4075/#3383) — `we:scripts/conveyor/claude-auth-health.mjs#probeClaudeLoggedIn`'s own
  // cheap probe, faked exactly like every other axis in this shim via the SAME `store.faults` toggle
  // (`w.claude.fault('auth-expired', true/false)`, no new API): `faults['auth-expired']` true → `loggedIn:
  // false` (login still broken); unset/false → `loggedIn: true` (the shim's own default "everything's fine"
  // baseline, matching every other command's fault-free default).
  if (argv[0] === 'auth' && argv[1] === 'status') {
    const faults = readStoreSnapshot(storePath).faults;
    process.stdout.write(JSON.stringify({ loggedIn: !faults['auth-expired'] }));
    return;
  }

  // ── `stop <id>` ──────────────────────────────────────────────────────────────────────────────────────
  if (argv[0] === 'stop') {
    const id = argv[1];
    const faults = readStoreSnapshot(storePath).faults;
    if (faults['stop-fails']) {
      writeLine(2, `No job matching '${id}'\n`);
      process.exitCode = 1;
      return;
    }
    const found = withStoreLock(storePath, (store) => {
      const session = findSessionIn(store, id);
      if (!session) return false;
      session.state = 'stopped';
      if (session.pid) killSleeper(session.pid);
      return true;
    });
    if (!found) {
      writeLine(2, `No job matching '${id}'\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`stopped ${id}\n`);
    return;
  }

  // ── everything else is a `--bg` (or foreground / resume) dispatch ───────────────────────────────────
  const parsed = parseBgArgv(argv);
  if (parsed.error) {
    writeLine(2, `error: ${parsed.error}\n`);
    process.exitCode = 2;
    return;
  }
  if (!parsed.prompt || !parsed.prompt.trim()) {
    writeLine(2, 'error: no prompt\n');
    process.exitCode = 2;
    return;
  }

  const faultsNow = readStoreSnapshot(storePath).faults;

  if (faultsNow['spawn-fails']) {
    writeLine(2, 'error: simulated spawn failure\n');
    process.exitCode = 1;
    return;
  }
  if (faultsNow['spawn-hangs']) {
    // Sleep well past `we:scripts/operations/dispatch-lane-io.mjs#SPAWN_TIMEOUT_MS` (60_000ms) so the REAL
    // caller's own `execFileSync(..., { timeout, killSignal: 'SIGKILL' })` is what ends this process — proving
    // the caller's timeout, not this shim's cooperation, is what bounds a wedged spawn.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 65_000);
    return;
  }

  if (!parsed.bg) {
    // Foreground path — kept for parity with the ORIGINAL shim's own foreground branch (judge-spawn callers
    // rely on `-p` blocking); nothing in this simulator dispatches foreground, so this is a thin passthrough.
    process.stdout.write('ok\n');
    return;
  }

  const cwd = process.cwd();

  if (parsed.resumeId) {
    const extraFlagCount = [parsed.name, parsed.settingsRaw, parsed.systemPromptFile, parsed.model, parsed.effort, parsed.disallowedTools.length ? 1 : null]
      .filter((x) => x !== null && x !== undefined).length;
    const existing = readStoreSnapshot(storePath);
    const match = findSessionIn(existing, parsed.resumeId);
    if (extraFlagCount > 0 || !match) {
      // The real CLI's OTHER fork trigger (`we:scripts/operations/__tests__/helpers/fake-claude.mjs`'s own
      // docblock) — any flag besides `--resume`, or no session to resume — forks a fresh copy.
      const id = shortId();
      const sessionId = fullSessionId();
      const pid = spawnSleeper();
      const startedAt = new Date().toISOString();
      const session = {
        id, sessionId, name: parsed.name, kind: 'background', state: 'working', status: null, waitingFor: null,
        cwd, pid, startedAt,
        env: { GH_TOKEN: env.GH_TOKEN ?? null, settingsEnv: parseSettingsEnv(parsed.settingsRaw), PATH: (env.PATH || '').split(':')[0] || null },
        argv, prompt: parsed.prompt, systemPromptFile: parsed.systemPromptFile,
      };
      withStoreLock(storePath, (store) => { store.sessions.push(session); store.pids.push(pid); });
      writeTranscriptLine({ home, cwd, sessionId, prompt: parsed.prompt });
      process.stdout.write('note: started a copy\n');
      process.stdout.write(`backgrounded · ${id}\n`);
      return;
    }
    process.stdout.write(`note: woke session ${match.id} with its saved options\n`);
    process.stdout.write(`backgrounded · ${match.id}\n`);
    return;
  }

  const id = shortId();
  const sessionId = fullSessionId();
  const pid = spawnSleeper();
  const startedAt = new Date().toISOString();
  const session = {
    id,
    sessionId,
    name: parsed.name,
    kind: 'background',
    state: 'working',
    status: null,
    waitingFor: null,
    cwd,
    pid,
    startedAt,
    env: {
      GH_TOKEN: env.GH_TOKEN ?? null,
      settingsEnv: parseSettingsEnv(parsed.settingsRaw),
      PATH: (env.PATH || '').split(':')[0] || null,
    },
    argv,
    prompt: parsed.prompt,
    systemPromptFile: parsed.systemPromptFile,
  };
  withStoreLock(storePath, (store) => {
    store.sessions.push(session);
    store.pids.push(pid);
  });
  writeTranscriptLine({ home, cwd, sessionId, prompt: parsed.prompt });

  process.stdout.write(`backgrounded · ${id}${parsed.name ? ` · ${parsed.name}` : ''}\n`);
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (IS_CLI) {
  main(process.argv.slice(2), process.env);
}
