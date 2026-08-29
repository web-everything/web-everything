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
import { buildAgentArgv, defaultSpawnAgent, defaultListAgents, parseBackgroundedHandle } from '../dispatch-lane-io.mjs';

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
  return defaultSpawnAgent(argv, { env });
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
    expect(seen[seen.indexOf('--session-id') + 1]).toBe('11111111-2222-3333-4444-555555555555');
    expect(seen[seen.indexOf('-n') + 1]).toBe('conveyor-4242');
    // The prompt survives as the trailing operand rather than being eaten as a flag — the thing the sink's
    // own comment says was never checked against a real parser.
    expect(seen[seen.length - 1]).toBe('# Deliver item 4242\n\nDo the thing.');
  });

  it('the spawn-to-observe round trip, through BOTH production seams — #3331: the CLI mints its own id', () => {
    fake = withFakeClaude();
    const env = { ...process.env, ...fake.env };
    const stdout = spawnVia(fake, buildAgentArgv({
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
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

    // #3331 PROVED the id the dispatcher PINS is never the id the CLI actually uses — the fake now mints
    // its own, same as the real CLI does, so this suite cannot silently regress back to the disproven
    // assumption. The tie between the two ends of the chain is `parseBackgroundedHandle(stdout)`: the short
    // id the CLI's own confirmation carries is a prefix of the real listed `sessionId`, and `name` (the `-n`
    // slug the dispatcher chose) is what identifies WHICH session it belongs to.
    const handle = parseBackgroundedHandle(stdout);
    expect(handle).toMatch(/^[0-9a-f]{8}$/);
    const listed = listing.find((s) => s.name === 'conveyor-77');
    expect(listed).toBeDefined();
    expect(listed.sessionId.startsWith(handle)).toBe(true);
    expect(listing.map((s) => s.sessionId)).not.toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
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

  it('`--bg` RETURNS while the same shim, run in the foreground, blocks — the property the dispatch model rests on', () => {
    fake = withFakeClaude();
    // The shim sits in a real 1.5s "session" when it is NOT backgrounded. Without a slow path the assertion
    // below is unfalsifiable — an earlier cut asserted `elapsed < 10_000` against a shim that could not block
    // under any input, so no change to production code could ever have reddened it.
    const work = { FAKE_CLAUDE_WORK_MS: '1500' };

    const fgStart = Date.now();
    spawnVia(fake, ['--session-id', 'fg', '-n', 'fg', '# brief'], work);
    const foreground = Date.now() - fgStart;

    const bgStart = Date.now();
    spawnVia(fake, buildAgentArgv({ sessionId: 'r', payload: { num: '5', prompt: '# brief' } }), work);
    const background = Date.now() - bgStart;

    // COMPARATIVE, not an absolute bound. The property is "one waits for the session and the other does not",
    // and this file already runs beside 37 other suites — an absolute `background < 1_000` is a flake waiting
    // for a loaded machine, and one measured ~0.8s against it. Comparing the two runs of the SAME shim in the
    // SAME process cancels the load out.
    expect(foreground).toBeGreaterThanOrEqual(1_400);
    expect(background).toBeLessThan(foreground / 2);
  });

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
