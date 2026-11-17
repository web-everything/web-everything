/**
 * @file dispatch-spawn-live.test.mjs — the first test that STARTS A PROCESS to dispatch an agent.
 *
 * The sink's own docblock in `we:scripts/operations/dispatch-lane-io.mjs` said it, and
 * `./dispatch-lane-integration.test.mjs` repeated it as current fact: *"NOT YET PROVEN LIVE. No test starts a
 * `claude` process."* Everything about the one effect the delivery loop exists to perform was asserted against
 * stubs. Both of those lines are rewritten by the same change that adds this file — it is what makes them
 * false, so leaving them would leave the repo asserting the opposite of its own suite.
 *
 * WHAT A STUB COULD NOT ANSWER, and it is not the spelling of the argv — `buildAgentArgv` is pure, exported
 * and already asserted. It is whether a CLI ACCEPTS that spelling. `dispatch-lane-io.mjs`'s own comment
 * records the doubt: the prompt's position was reasoned about and never checked, *"untested against the real
 * CLI, and a wrong bet turns into a dispatch with a mangled prompt"*. A shim that parses argv the way a
 * commander-style CLI does converts that bet into an assertion.
 *
 * WHAT IT REMAINS HONEST ABOUT. The parser doing the accepting and the rejecting is a shim added alongside
 * these tests, so the fidelity claim is "modelled on a commander-style CLI", not "verified against the real
 * one". That is the same standing this repo already accepts for `real-repo.mjs`'s git geometry, and it is
 * strictly more than a stub returning a canned value could give. The real CLI stays unasserted until a live
 * run — which is a change of binding here, not a new harness.
 *
 * These tests run the REAL `defaultSpawnAgent` and the REAL `defaultListAgents` through the REAL
 * `execFileSync` with `PATH` pointed at the fake — no injected spawner. Overriding the high seam would replace
 * the code under test; this exercises it, the same reasoning the sink gives for separating `exec` from
 * `runNode`.
 *
 * COSTS NOTHING. No model runs, no token is spent.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { withFakeClaude } from './helpers/fake-claude.mjs';
import { buildAgentArgv, defaultSpawnAgent, defaultListAgents, parseBackgroundedId } from '../dispatch-lane-io.mjs';

/**
 * Spawn through the REAL default path, with the fake first on PATH.
 *
 * `assertWins` runs FIRST, every time. It DOES fire: the last case in this file calls `spawnVia` with a
 * `PATH` that overrides `fake.env`, and the guard stops it before a process starts.
 *
 * That correction is the point. Round 3 added that case and left this docblock reading *"Every case here
 * passes `fake.env` today, so it never fires"* — which the same edit had just made false, since `extraEnv`
 * spreads AFTER `fake.env` below. The failure the guard prevents is live either way: a case that omits the
 * override reaches whatever `claude` the host has, and for a `--bg` argv on a machine with the real CLI
 * installed that is a real background agent launched by a test file whose headline promise is that no model
 * runs. Enforced rather than conventional.
 */
function spawnVia(fake, argv, extraEnv = {}) {
  const env = { ...process.env, ...fake.env, ...extraEnv };
  fake.assertWins(env);
  return defaultSpawnAgent(argv, { mode: 'ordinary', launchGuard: null, env });
}

let fake = null;
afterEach(() => { if (fake) fake.cleanup(); fake = null; });

describe('dispatching an agent, against a real process', () => {
  it('the argv the dispatcher builds is ACCEPTED by a CLI that parses like the real one', () => {
    fake = withFakeClaude();
    const argv = buildAgentArgv({
      sessionId: '11111111-2222-3333-4444-555555555555',
      payload: { num: '4242', sessionSlug: 'conveyor-4242', prompt: '# Deliver item 4242\n\nDo the thing.' },
    });

    expect(() => spawnVia(fake, argv)).not.toThrow();

    const seen = fake.lastArgv();
    expect(seen).toContain('--bg');
    // #3331 — `--session-id` IS NOT SENT. `claude --bg` discards it (the shim now models that, and says so on
    // stderr exactly as 2.1.269 does), so passing it only encoded a false premise about who owns the id.
    expect(seen).not.toContain('--session-id');
    expect(seen).not.toContain('11111111-2222-3333-4444-555555555555');
    expect(seen[seen.indexOf('-n') + 1]).toBe('conveyor-4242');
    // The prompt survives as the trailing operand rather than being eaten as a flag — the thing the sink's
    // own comment says was never checked against a real parser.
    expect(seen[seen.length - 1]).toBe('# Deliver item 4242\n\nDo the thing.');
  });

  it('#xqyyoje — --append-system-prompt-file is ACCEPTED alongside the rest, prompt still the trailing operand', () => {
    fake = withFakeClaude();
    const argv = buildAgentArgv({
      sessionId: '22222222-3333-4444-5555-666666666666',
      payload: { num: '4242', sessionSlug: 'conveyor-4242', prompt: '# Deliver item 4242\n\nDo the thing.' },
      systemPromptFile: '/repo/skills-src/conveyor/dispatched-agent-system-prompt.md',
    });

    expect(() => spawnVia(fake, argv)).not.toThrow();

    const seen = fake.lastArgv();
    expect(seen[seen.indexOf('--append-system-prompt-file') + 1]).toBe('/repo/skills-src/conveyor/dispatched-agent-system-prompt.md');
    expect(seen[seen.length - 1]).toBe('# Deliver item 4242\n\nDo the thing.');
  });

  it('the spawn-to-observe round trip, through BOTH production seams', () => {
    fake = withFakeClaude();
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const env = { ...process.env, ...fake.env };
    const stdout = spawnVia(fake, buildAgentArgv({
      sessionId,
      payload: { num: '77', sessionSlug: 'conveyor-77', prompt: '# brief' },
    }));

    // PRODUCTION'S OBSERVER, not a re-implementation of it. An earlier cut hand-rolled
    // `execFileSync('claude', ['agents','--json'])` here and its comment claimed that was "exactly as
    // production does it" — it was not: `defaultListAgents` also sets `stdio`, `maxBuffer`, `timeout`,
    // `killSignal` and an empty-listing fallback, none of which were exercised. It was hand-rolled because
    // `defaultListAgents` COULD NOT be pointed at the fake: its `env` fed only `listTimeoutMs` and never
    // reached the child, so it returned this machine's real sessions. That one-line passthrough is part of
    // this change, and this case is what holds it.
    const listing = defaultListAgents({ env });

    // Both ends of the chain were previously modelled. This is the one assertion that ties them — and since
    // #3331 it ties the RIGHT two ends. It used to read "the id the dispatcher pinned is the id the liveness
    // listing reports back", which was true only because the shim honoured `--session-id`; the real CLI never
    // did. The chain that actually exists: the id `--bg` PRINTS is the id the listing carries, and it is what
    // `parseBackgroundedId` (production's own parser, not a re-implementation) recovers.
    const printed = parseBackgroundedId(stdout);
    expect(printed).toBeTruthy();
    expect(listing.map((s) => s.id)).toContain(printed);
    expect(listing.find((s) => s.id === printed).name).toBe('conveyor-77');
    // …and the MINTED id reaches nothing, which is the defect this pins against regression.
    expect(listing.map((s) => s.sessionId)).not.toContain(sessionId);
  });

  it('a leading-dash brief is refused by the dispatcher — and the parser proves the refusal is load-bearing', () => {
    fake = withFakeClaude();

    // The hazard's real shape: ONE argv element that happens to begin with a dash. Not a token like
    // `--not-a-real-flag` that is unambiguously a flag — a brief.
    const hazard = '--help me, my first heading starts with a dash';

    expect(() => buildAgentArgv({
      sessionId: 'x', payload: { num: '1', prompt: hazard },
    })).toThrow(/begins with/);

    // Hand-built argv, bypassing the guard, to show what it prevents. Without this half the guard's value is
    // asserted rather than demonstrated: the parser really does read that element as an unknown option and
    // reject the whole invocation, so the dispatch would have failed rather than arriving mangled.
    expect(() => spawnVia(fake, ['--bg', '--session-id', 'z', '-n', 'n', hazard])).toThrow();
    expect(fake.lastArgv()).toContain(hazard);
  });

  it('a spawn failure surfaces as a throw rather than a silent non-dispatch', () => {
    fake = withFakeClaude();
    const argv = buildAgentArgv({ sessionId: 'q', payload: { num: '9', prompt: '# brief' } });
    expect(() => spawnVia(fake, argv, { FAKE_CLAUDE_FAIL: '1' })).toThrow();
  });

  /**
   * RAISED from a 1_500ms session and a RATIO assertion (2026-08-29), after the ratio blew up under load
   * with no defect in the code it was testing. The property under test is "the foreground spawn pays
   * WORK_MS of real blocking; the background one does not" — not any particular absolute wall time, since
   * this file (like `wake-cli.test.mjs` before it) spawns real `node` child processes and machine
   * contention can inflate raw spawn/startup overhead in both calls. The PRIOR fix for that ("comparative,
   * not absolute" — `background < foreground / 2`) does not actually cancel that overhead out: it stays
   * inside both terms of the ratio. Once startup overhead (forking node, loading the shim, writing its log)
   * grew large enough under contention to rival WORK_MS itself, `foreground / 2` shrank towards `background`
   * and the assertion went red on a perfectly healthy run — the same shape of flake `execFileSync`'s own
   * `ETIMEDOUT` produced when a spawn simply took too long to start.
   *
   * SUBTRACTING the two elapsed times instead cancels the shared overhead exactly (both spawns pay ~the same
   * fork/startup cost), leaving only the one thing that differs between them: WORK_MS of real blocking on
   * the foreground side. The margin below only has to absorb scheduling jitter BETWEEN the two otherwise-
   * identical spawns, so it does not need to grow just because the machine is slower overall — and this file
   * is now routed to its own single `forks` process (vitest.config.ts) specifically to shrink that jitter.
   */
  it('`--bg` RETURNS while the same shim, run in the foreground, blocks — the property the dispatch model rests on', () => {
    fake = withFakeClaude();
    const WORK_MS = 3_000;
    const work = { FAKE_CLAUDE_WORK_MS: String(WORK_MS) };

    const fgStart = Date.now();
    spawnVia(fake, ['--session-id', 'fg', '-n', 'fg', '# brief'], work);
    const foreground = Date.now() - fgStart;

    const bgStart = Date.now();
    spawnVia(fake, buildAgentArgv({ sessionId: 'r', payload: { num: '5', prompt: '# brief' } }), work);
    const background = Date.now() - bgStart;

    // Foreground genuinely blocked for ~WORK_MS — this direction only grows under load, never shrinks, so a
    // small fixed tolerance is safe regardless of machine contention.
    expect(foreground).toBeGreaterThanOrEqual(WORK_MS - 200);
    // The DIFFERENCE isolates the blocking WORK_MS from the shared spawn overhead — see the block comment
    // above for why this replaced a ratio. Half of WORK_MS is margin for jitter between the two spawns.
    expect(foreground - background).toBeGreaterThanOrEqual(WORK_MS / 2);
  }, 30_000);

  /**
   * `assertWins` is the guard on every other case in this file, and a guard nothing exercises is a comment.
   * This is what it prevents: an env WITHOUT the fake's `PATH` does not resolve the fake, and a `--bg` argv
   * would then reach whatever `claude` the host has — on a machine with the real CLI installed, a real
   * background agent launched from a test file whose headline promise is that no model runs.
   *
   * BOTH not-the-fake OUTCOMES MUST REACH THE SAME MESSAGE, and this case is worthless unless they do. Round
   * 3's cut only handled "resolves to some other binary": `command -v` exits non-zero when nothing is found,
   * so on CI — which installs no `claude` — this case failed with `Command failed: sh -c command -v claude`
   * instead of the guard's message, while passing on a dev box where the real CLI happens to be installed.
   * The regex below is therefore the whole assertion, not a convenience: it is what distinguishes the guard
   * refusing from the resolution merely erroring.
   *
   * DO NOT run the "delete `fake.assertWins(env)` from `spawnVia`" mutation on a host that HAS a real
   * `claude`. Without the guard, the last expectation below dispatches a `--bg` argv on the host's own
   * `PATH` — which is the exact hazard the guard exists to prevent. Mutate it only where `command -v claude`
   * finds nothing.
   */
  it('refuses to spawn when the fake did NOT win PATH, rather than reaching the real CLI', () => {
    fake = withFakeClaude();

    // The GUARD ITSELF, on an env without the fake's PATH. Passes whether the host resolves a real `claude`
    // (dev box) or nothing at all (CI) — the two arms that used to diverge.
    expect(() => fake.assertWins({ ...process.env })).toThrow(/did not win PATH/);
    // The not-found arm PINNED, independent of the host: a PATH that cannot contain a `claude` at all.
    expect(() => fake.assertWins({ PATH: '/nonexistent-for-fake-claude' })).toThrow(/did not win PATH/);
    // …and it passes for the env every other case uses, so it is not simply always-throwing.
    expect(() => fake.assertWins({ ...process.env, ...fake.env })).not.toThrow();

    // THE CALL SITE, which is the half a test of the function alone leaves uncovered — deleting
    // `fake.assertWins(env)` from `spawnVia` would otherwise redden nothing. The message must be the
    // GUARD'S, not a spawn failure: the point is that it stops BEFORE the process starts.
    const argv = buildAgentArgv({ sessionId: 's', payload: { num: '3', prompt: '# brief' } });
    expect(() => spawnVia(fake, argv, { PATH: process.env.PATH })).toThrow(/did not win PATH/);
  });
});
