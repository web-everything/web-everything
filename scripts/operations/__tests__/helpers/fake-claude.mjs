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
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// Parse the way a commander-style CLI would: options first, operands wherever they fall. A lone operand
// beginning with '-' is read as an unknown FLAG and rejected — which is exactly the failure the real
// dispatcher refuses a leading-dash brief to avoid, so the refusal can now be proven rather than assumed.
let sessionId = null, name = null, bg = false;
const operands = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--bg') { bg = true; continue; }
  if (a === '--session-id') { sessionId = argv[i += 1]; continue; }
  if (a === '-n' || a === '--name') { name = argv[i += 1]; continue; }
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

if (bg) {
  // THE REAL CLI IGNORES \`--session-id\` on a \`--bg\` spawn and mints its OWN id — confirmed against CLI
  // 2.1.246, three runs, three mismatches, its own stderr warning (#3331 probe). Honouring the passed-in
  // \`sessionId\` here was the exact drift that let dispatch-lane-io.mjs's now-corrected assumption go
  // unnoticed by this suite; the shim must not repeat it, so the real id is always CLI-minted, never the
  // caller's.
  const realId = randomUUID();
  const shortId = realId.slice(0, 8);
  state.sessions.push({ id: shortId, sessionId: realId, name, kind: 'background', state: 'running', cwd: process.cwd() });
  write(state);
  process.stderr.write('warning: --bg manages the session id; ignoring --session-id (use --resume <id> to continue an existing session)\\n');
  // The one line dispatch-lane-io.mjs's \`parseBackgroundedHandle\` reads — shape and separator (U+00B7)
  // matched against a real 2.1.246 spawn, not invented.
  process.stdout.write('backgrounded · ' + shortId + ' · ' + name + '\\n');
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
 * @returns {{
 *   env: Record<string,string>,
 *   lastArgv: () => string[] | null,
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
