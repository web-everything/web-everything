/**
 * @file fake-claude.mjs — a REAL `claude` executable on `PATH` that costs nothing to run.
 *
 * WHY THIS EXISTS, stated as the hole it closes. The sink's OWN docblock in
 * `we:scripts/operations/dispatch-lane-io.mjs` said it outright, and
 * `we:scripts/operations/__tests__/dispatch-lane-integration.test.mjs` repeated it as current fact:
 *
 *     *"NOT YET PROVEN LIVE. No test starts a `claude` process."*
 *
 * Both lines are rewritten by the same change that adds this file, because this file is what makes them false.
 *
 * Starting an agent is the ONE effect this whole delivery loop is built around, and nothing exercised it.
 * `buildAgentArgv` is pure and asserted, which pins the argv's SPELLING — but the same argument
 * `we:scripts/operations/__tests__/helpers/real-repo.mjs` makes about git applies here: asserting the argv
 * never says whether a CLI ACCEPTS it. That file's line is the general rule, and this is its second instance:
 *
 *     *"A STUB RETURNING `''` CANNOT HAVE CLONE GEOMETRY … asserting the argv only pins today's spelling,
 *      it never says whether the spelling WORKS."*
 *
 * The argv here has a specific reason to be doubted rather than assumed. `dispatch-lane-io.mjs`'s own
 * comment records that the prompt's position was decided WITHOUT a live check — *"untested against the real
 * CLI, and a wrong bet turns into a dispatch with a mangled prompt"* — and worked around by refusing a
 * leading dash. A shim that parses its argv the same way a real CLI would turns that bet into an assertion.
 *
 * WHAT THIS IS NOT. It does not run a model, spend a token, or prove an agent does useful work. It proves
 * the PLUMBING: that the argv parses, that `--bg` returns immediately rather than blocking, that the session
 * id the dispatcher pins is the id the observer later finds, and that a spawn failure surfaces as a failure.
 * The quality of what an agent produces is a different test and a different budget — this is the harness that
 * makes that test a swap of one binding rather than a new build.
 *
 * HOW IT WORKS. `withFakeClaude` writes an executable `claude` into a temp directory and hands back the
 * `PATH` prefix plus readers over what it recorded. Point `PATH` at it and the REAL
 * `defaultSpawnAgent`/`execFileSync` path runs unmodified — no injected spawner, no replaced production
 * path. That is deliberate, and it is the same reasoning `dispatch-lane-io.mjs` gives for separating `exec`
 * from `runNode`: overriding the high seam replaces the code under test, overriding the low one exercises it.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SHIM_PATH, readStoreSnapshot, withStoreLock, readCalls, findSessionIn, killSleeper,
} from './fake-claude-shim.mjs';

/** The shim, as a node script. Kept in one string so the fixture is a single file with nothing to resolve. */
const SHIM = `#!/usr/bin/env node
// A stand-in for the \`claude\` CLI. Records every invocation, emulates the two sub-commands the delivery
// loop actually uses, and exits fast. Written by fake-claude.mjs — see that file for why.
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const LOG = process.env.FAKE_CLAUDE_LOG;
const argv = process.argv.slice(2);

const read = () => { try { return JSON.parse(readFileSync(LOG, 'utf8')); } catch { return { calls: [], sessions: [] }; } };
const write = (s) => writeFileSync(LOG, JSON.stringify(s, null, 2), 'utf8');

const state = read();
state.calls.push({ argv, cwd: process.cwd(), at: state.calls.length });

// \`claude agents --json\` — the liveness listing the observer reads. Only sessions this shim was asked to
// start appear, so a test can assert the spawn->observe round trip rather than a hand-written fixture.
if (argv[0] === 'agents') {
  write(state);
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(state.sessions));
  process.exit(0);
}

// \`claude stop <id>\` — #xu2krte's resume-or-fresh fallback calls this on an accidental fork. Deregisters the
// session (removes it from the listing) the same way the real CLI's own docblock says it does, unlike a bare
// \`kill\` which the dispatch-abort.mjs file header explains at length is NOT equivalent.
if (argv[0] === 'stop') {
  const id = argv[1];
  const before = state.sessions.length;
  state.sessions = state.sessions.filter((s) => s.id !== id && s.sessionId !== id);
  write(state);
  if (state.sessions.length === before) { process.stderr.write('No job matching \\'' + id + '\\'\\n'); process.exit(1); }
  process.stdout.write('stopped ' + id + '\\n');
  process.exit(0);
}

// Parse the way a commander-style CLI would: options first, operands wherever they fall. A lone operand
// beginning with '-' is read as an unknown FLAG and rejected — which is exactly the failure the real
// dispatcher refuses a leading-dash brief to avoid, so the refusal can now be proven rather than assumed.
let sessionId = null, name = null, bg = false, systemPromptFile = null, resumeId = null;
let extraFlagCount = 0;
const operands = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--bg') { bg = true; continue; }
  if (a === '--session-id') { sessionId = argv[i += 1]; continue; }
  if (a === '--resume') { resumeId = argv[i += 1]; continue; }
  if (a === '-n' || a === '--name') { name = argv[i += 1]; extraFlagCount += 1; continue; }
  // #xqyyoje — the dispatched-agent standing-identity flag. Recorded, not read: this shim proves ARGV
  // acceptance (the real CLI's own --help lists this flag), not file contents.
  if (a === '--append-system-prompt-file') { systemPromptFile = argv[i += 1]; extraFlagCount += 1; continue; }
  // #x8mpubm/#x36vidg — \`--settings '{"env":{...}}'\` (gh-App shim PATH, Bash timeouts); a real CLI flag.
  if (a === '--settings') { i += 1; extraFlagCount += 1; continue; }
  // #3730 — the two flags dispatch-task adds. Both are real claude --help options. --permission-mode takes
  // a separate value; --allowedTools is VARIADIC in the real CLI, so the dispatcher passes it as ONE
  // --allowedTools=<list> token (a separate list would swallow the prompt), and only that spelling is accepted
  // here. Recorded through the call log's argv, not interpreted.
  if (a === '--permission-mode') { i += 1; extraFlagCount += 1; continue; }
  if (a.startsWith('--allowedTools=') || a.startsWith('--allowed-tools=')) { extraFlagCount += 1; continue; }
  // #3857 — the model-tier table's chosen (or reasoned-override) model, injected by buildAgentArgv. A real
  // claude --help flag (takes a separate value); recorded through the call log's argv, not interpreted.
  if (a === '--model' || a === '-m' || a === '--effort') { i += 1; extraFlagCount += 1; continue; }
  // PR #7332 — the lean fix/ci-heal session flags (real claude --help options): \`--tools <list>\` takes one
  // value; the other three are bare switches. Recorded through the call log's argv, not interpreted.
  if (a === '--tools') { i += 1; extraFlagCount += 1; continue; }
  // The lane grant: \`--add-dir <dir>\`, one directory per flag as \`buildAgentArgv\` emits it.
  if (a === '--add-dir') { i += 1; extraFlagCount += 1; continue; }
  if (a === '--restricted' || a === '--strict-mcp-config' || a === '--disable-slash-commands') { extraFlagCount += 1; continue; }
  // NO \`--\` END-OF-OPTIONS BRANCH, deliberately. \`buildAgentArgv\` never emits one, so a branch here would
  // model the very escape hatch dispatch-lane-io.mjs says it DECLINED to bet on — a fidelity claim with
  // nothing checking it. The guard it chose instead (refuse a leading-dash brief) is what gets exercised.
  if (a.startsWith('-')) {
    process.stderr.write('error: unknown option ' + a + '\\n');
    write(state); process.exit(2);
  }
  operands.push(a);
}

const prompt = operands.join(' ');
if (!prompt.trim()) { process.stderr.write('error: no prompt\\n'); write(state); process.exit(2); }

if (process.env.FAKE_CLAUDE_FAIL === '1') {
  process.stderr.write('error: simulated spawn failure\\n');
  write(state); process.exit(1);
}

// #xu2krte — \`--resume <id>\`. Models the ONE rule the live build-time probe against the real CLI actually
// found (docs/agent/platform-decisions.md#parked-pr-conflict-dispatched-not-scripted): ANY flag besides
// \`--resume\` itself forks a copy under a FRESH id instead of continuing the named session. (The real CLI's
// OTHER fork trigger — the target session still being "already running" — is not modelled here: this shim's
// sessions never persist across calls the way a real background process does, so there is nothing honest to
// simulate for that half; the flag-based trigger is the deterministic, reproducible one and is what this
// fixture exists to prove the dispatcher's own fork-detection/fallback correctly reacts to.)
if (bg && resumeId) {
  const match = state.sessions.find((s) => s.sessionId === resumeId || s.id === resumeId);
  if (extraFlagCount > 0 || !match) {
    const id = 'forked-' + state.sessions.length;
    state.sessions.push({ id: id.slice(0, 8), sessionId: id, name, systemPromptFile, kind: 'background', state: 'running', cwd: process.cwd() });
    write(state);
    process.stdout.write('note: started a copy\\n');
    process.stdout.write('backgrounded · ' + id.slice(0, 8) + '\\n');
    process.exit(0);
  }
  write(state);
  process.stdout.write('note: woke session ' + match.id + ' with its saved options\\n');
  process.stdout.write('backgrounded · ' + match.id + '\\n');
  process.exit(0);
}

if (bg) {
  // THE REAL CLI IGNORES \`--session-id\` on a \`--bg\` spawn and mints its OWN id — confirmed against CLI
  // 2.1.246, three runs, three mismatches, its own stderr warning (#3331 probe). Honouring the passed-in
  // \`sessionId\` here was the exact drift that let dispatch-lane-io.mjs's now-corrected assumption go
  // unnoticed by this suite; the shim must not repeat it, so the real id is always CLI-minted, never the
  // caller's.
  const realId = randomUUID();
  const shortId = realId.slice(0, 8);
  state.sessions.push({ id: shortId, sessionId: realId, name, systemPromptFile, kind: 'background', state: 'running', cwd: process.cwd() });
  write(state);
  process.stderr.write('warning: --bg manages the session id; ignoring --session-id (use --resume <id> to continue an existing session)\\n');
  // The one line dispatch-lane-io.mjs's \`parseBackgroundedHandle\` reads — shape and separator (U+00B7)
  // matched against a real 2.1.246 spawn, not invented.
  process.stdout.write('backgrounded · ' + shortId + (name ? ' · ' + name : '') + '\\n');
  process.stdout.write('  claude agents             list sessions\\n');
  process.stdout.write('  claude attach ' + shortId + '    open in this terminal\\n');
  process.stdout.write('  claude logs ' + shortId + '      show recent output\\n');
  process.stdout.write('  claude stop ' + shortId + '      stop this session\\n');
  process.exit(0);
}

// FOREGROUND BLOCKS, and that is the whole point of the branch. Without it, "\`--bg\` returns instead of
// blocking" is unfalsifiable: with no slow path anywhere in the shim, no change to production code could ever
// make that assertion fail. \`FAKE_CLAUDE_WORK_MS\` is the session the real CLI would sit in.
const workMs = Number(process.env.FAKE_CLAUDE_WORK_MS || 0);
if (workMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workMs);
write(state);
process.stdout.write('ok\\n');
process.exit(0);
`;

/**
 * Stand up a fake `claude` on disk.
 *
 * The returned surface is exactly what a consumer uses and no more. Two rounds of review were needed to make
 * that sentence true: the first cut also handed back `pathPrefix`, `dir` and `sessions()`; the cut that
 * removed them kept `calls()`, which nothing imported either — so the sentence certifying the dead surface
 * gone was itself an instance of the dead surface. `lastArgv` is the only reader anything uses.
 *
 * `assertWins` is the one member with no failure of its own in production use, and it is here on purpose:
 * this fixture exists to be extended, and a call that forgets `env` reaches whatever `claude` the HOST has.
 * On a machine with the real CLI installed, a `--bg` argv then launches a real background agent, against a
 * file whose headline promise is that no model runs. Its refusal IS exercised — see the case that calls it
 * without the override, which pins both not-the-fake outcomes: a different binary, and none at all.
 *
 * `sessions()` was removed in an earlier cut as unread dead surface and is re-added here, for real use this
 * time: `#xu2krte`'s resume-or-fresh integration test needs to read back what the shim's `agents --json`
 * listing would report (id/sessionId pairs) WITHOUT shelling a second `exec` call just to get JSON it already
 * has on disk in `state.sessions`.
 * @returns {{
 *   env: Record<string,string>,
 *   lastArgv: () => string[] | null,
 *   sessions: () => Array<object>,
 *   assertWins: (env: Record<string,string>) => void,
 *   cleanup: () => void,
 * }}
 */
export function withFakeClaude() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  const bin = join(dir, 'claude');
  const log = join(dir, 'calls.json');
  writeFileSync(bin, SHIM, 'utf8');
  chmodSync(bin, 0o755);
  writeFileSync(log, JSON.stringify({ calls: [], sessions: [] }), 'utf8');

  const read = () => (existsSync(log) ? JSON.parse(readFileSync(log, 'utf8')) : { calls: [], sessions: [] });

  return {
    env: { PATH: `${dir}:${process.env.PATH}`, FAKE_CLAUDE_LOG: log },
    lastArgv: () => {
      const c = read().calls;
      return c.length ? c[c.length - 1].argv : null;
    },
    sessions: () => read().sessions,
    /**
     * Refuse to proceed unless THIS `claude` is the one the given env would run. Resolved the way the OS
     * resolves it, not by inspecting the `PATH` string — a check that only read `PATH` would agree with
     * itself while the child ran something else.
     *
     * NOT-FOUND IS A RESOLUTION, and getting that wrong made this guard host-dependent. `command -v` exits
     * NON-ZERO when nothing is found, so an unguarded `execFileSync` throws `Command failed: sh -c command -v
     * claude` before any comparison happens. Round 3 shipped exactly that, and the case written to exercise
     * the guard then passed here — where a real `claude` is installed — and failed on CI, where none is. The
     * `catch` normalises not-found to `''` so the one comparison below owns every outcome, and so the
     * `(nothing)` arm of the message below is reachable instead of dead.
     */
    assertWins: (env) => {
      let resolved = '';
      try {
        resolved = execFileSync('sh', ['-c', 'command -v claude'], {
          encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch { /* nothing on this PATH — `resolved` stays '' and the comparison below rejects it */ }
      if (resolved !== bin) {
        throw new Error(`fake-claude: the fake did not win PATH — \`claude\` resolves to ${resolved || '(nothing)'}, not ${bin}. Refusing to spawn: this would reach the real CLI.`);
      }
    },
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
// PART 3 of the daemon scenario simulator (epic #3383, `reports/2026-09-24-daemon-scenario-simulator.md`):
// `createFakeClaude` — a SECOND, separate fake `claude`, alongside `withFakeClaude` above (untouched — every
// existing caller, `dispatch-lane-integration`/`dispatch-spawn-live`/`parked-pr-conflict-dispatch-integration`,
// keeps using it exactly as before). This one backs a whole SCENARIO: sessions carry real pids, real
// transcripts, and a scriptable per-session behaviour queue a scenario's runner steps one action per tick
// (`we:scripts/conveyor/__tests__/sim/agent-actions.mjs#stepSessions`). The state machine itself lives in
// `./fake-claude-shim.mjs` — see that file's own header for the listing contract derived from the real
// consumers and the transcript-path derivation measured against `pr-status.mjs`/`conveyor-state.mjs`.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * A glob with `*` wildcards only (no `?`, no character classes — every pattern this simulator writes,
 * `review-*`/`fix-*`/an exact name, needs nothing richer). `*` matches greedily across the WHOLE remaining
 * string, same as shell globbing over a single path segment.
 * @param {string} pattern
 * @param {string} value
 * @returns {boolean}
 */
function matchGlob(pattern, value) {
  const escaped = String(pattern).split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`).test(String(value ?? ''));
}

/**
 * Stand up the scenario-grade fake `claude` — a real executable on `PATH`, backed by a locked JSON session
 * store (`./fake-claude-shim.mjs#withStoreLock`) and an NDJSON call log, plus an in-process behaviour-script
 * registry (`script()`) that `agent-actions.mjs#stepSessions` drains one action per live session per call.
 *
 * `root`/`home`/`storeFile` are all optional so a scenario's `world.mjs` (part 1) can nest this inside its own
 * scenario-root temp dir; omitted, each mints its own throwaway temp dir — good enough for a standalone test
 * of this file.
 *
 * @param {{root?: string, home?: string, storeFile?: string}} [o]
 * @returns {{
 *   env: Record<string,string>,
 *   sessions: () => object[],
 *   session: (nameOrId: string) => object|null,
 *   setState: (id: string, state: string, extra?: object) => void,
 *   killPid: (id: string) => void,
 *   fault: (name: string, value?: boolean) => void,
 *   script: (pattern: string, actions: Array<{kind:string, run:Function}>) => void,
 *   takeNextAction: (name: string) => {kind:string, run:Function}|null,
 *   calls: () => object[],
 *   cleanup: () => void,
 * }}
 */
export function createFakeClaude({ root, home, storeFile } = {}) {
  const dir = root ?? mkdtempSync(join(tmpdir(), 'fake-claude-sessions-'));
  mkdirSync(dir, { recursive: true });
  const homeDir = home ?? join(dir, 'home');
  mkdirSync(homeDir, { recursive: true });
  const store = storeFile ?? join(dir, 'store.json');
  const calls = join(dir, 'calls.ndjson');
  const bin = join(dir, 'claude');

  writeFileSync(store, JSON.stringify({ sessions: [], pids: [], faults: {} }), 'utf8');
  writeFileSync(calls, '', 'utf8');
  // `#!/bin/sh exec node <shim> "$@"` — same wrapper shape as `git-replay.mjs`'s own precedent, so the state
  // machine is a real, separately-runnable/importable `.mjs` file rather than a string template.
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(SHIM_PATH)} "$@"\n`, 'utf8');
  chmodSync(bin, 0o755);

  /** In-process only — a behaviour script is a queue of ALREADY-CONSTRUCTED action objects (the caller built
   *  them via `w.act.postVerdict({...})` etc before handing them to `script()`), so there is nothing here to
   *  serialize to the on-disk store; only the session LISTING crosses the process boundary. */
  const scripts = []; // [{ pattern, queue: [...actions] }]

  return {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      FAKE_CLAUDE_STORE: store,
      FAKE_CLAUDE_CALLS: calls,
      FAKE_CLAUDE_HOME: homeDir,
    },
    sessions: () => readStoreSnapshot(store).sessions,
    session: (nameOrId) => findSessionIn(readStoreSnapshot(store), nameOrId),
    setState: (id, state, extra = {}) => withStoreLock(store, (s) => {
      const session = findSessionIn(s, id);
      if (!session) throw new Error(`fake-claude: setState — no session matching ${JSON.stringify(id)}`);
      session.state = state;
      Object.assign(session, extra);
    }),
    killPid: (id) => withStoreLock(store, (s) => {
      const session = findSessionIn(s, id);
      if (session?.pid) killSleeper(session.pid);
    }),
    fault: (name, value = true) => withStoreLock(store, (s) => { s.faults[name] = value; }),
    /** Attach a behaviour script: every LIVE session whose `name` matches `pattern` (glob, `*` wildcards) pops
     *  one action off this queue per `stepSessions` call, in order, until exhausted. First-registered pattern
     *  wins when more than one would match a given name. */
    script: (pattern, actions) => { scripts.push({ pattern, queue: [...actions] }); },
    /** `agent-actions.mjs#stepSessions`'s own seam: the next queued action for a session NAME, or `null` when
     *  nothing is scripted for it (a session with no script simply never advances on its own). */
    takeNextAction: (name) => {
      for (const entry of scripts) {
        if (matchGlob(entry.pattern, name) && entry.queue.length) return entry.queue.shift();
      }
      return null;
    },
    calls: () => readCalls(calls),
    /** Kill ONLY the sleeper pids this instance itself recorded (`store.pids` — appended on every session
     *  register, never pruned by `stop`/`setState`, so a session mutated after the fact is still found), then
     *  remove the scratch dir. Never a blanket process kill — see the file header's hard rules. */
    cleanup: () => {
      const snapshot = readStoreSnapshot(store);
      for (const pid of snapshot.pids || []) killSleeper(pid);
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

/** The `GH_TOKEN` a dispatched session's spawn env carried, recorded verbatim by the shim (`fake-claude-shim.mjs`
 *  reads `env.GH_TOKEN` at `--bg` time) — `null` when the spawner stripped it (`sanitizeSpawnEnv`,
 *  `we:scripts/lib/gh-app-shim.mjs`). The one assert helper `agent-actions.mjs#inheritStaleToken`'s own docblock
 *  promises: "assert helpers `sessionEnvToken(session)`". */
export function sessionEnvToken(session) {
  return session?.env?.GH_TOKEN ?? null;
}
