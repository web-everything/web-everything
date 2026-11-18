/**
 * @file soak.mjs — #4075 DAEMON SOAK HARNESS (card x0zg44l, epic #3383). The daemons kept breaking live in ways
 * their unit tests never saw (seven breaks on 2026-09-25, every one green in tests). A unit test pins one
 * function; these breaks lived in the SEAMS — a state file one process writes and another process's git status
 * reads, a shim path baked by one checkout and executed from another, a lock one daemon holds while another
 * waits. This harness runs the REAL daemons long enough, in a world real enough, for those seams to show.
 *
 * WHAT IS REAL (all of it reused from the daemon scenario simulator, `we:scripts/conveyor/__tests__/sim/`):
 *   - a throwaway daemon clone of a real local bare git remote (`sim/world.mjs`), with origin/main ADVANCING
 *     between ticks (this file);
 *   - the REAL review daemon and fix-dispatch daemon, imported FROM THE CLONE and wrapped exactly as their own
 *     `main()` wraps them — `withSelfSync(withGithubAppAuth(buildCliDaemonEffects(...)))` (`sim/daemon-host.mjs`) —
 *     so the real rebuild / self-sync / live-smoke-gate code moves the clone every time main moves;
 *   - a fake GitHub with PRs in varied states (`fleet.mjs`), over the real `gh` CLI surface (`helpers/fake-gh.mjs`);
 *   - fake dispatched sessions that run the REAL state writers and sometimes crash, hang, or leave junk
 *     (`behaviours.mjs`).
 *
 * WHAT IT CHECKS: after EVERY daemon tick, the invariants in `invariants.mjs` — clone clean, at most one main
 * move behind, tick bounded, no tickOnce throw, no onTick crash, no stale-refusal streak, owed work dispatched.
 * Every tick prints one report line; every violation is kept (the run does not stop at the first), so one soak
 * shows the whole picture.
 *
 * REGRESSION SCENARIOS: `we:scripts/conveyor/soak/breaks.soak.test.mjs` — one per live break, built on the same
 * {@link runSoak} with a scenario-specific `setup`/`perRound` hook. THE RULE (`we:skills-src/conveyor/SKILL.md`,
 * `we:skills-src/conveyor/fix-agent-brief.md`): every daemon bug fix adds its real-world case here.
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runScenario, scenario } from '../__tests__/sim/scenario.mjs';
import { cloneFacts, checkTick, explainNoDispatch, formatTickLine, DEFAULT_BOUNDS, OWED_KIND_DAEMON, sessionMatches } from './invariants.mjs';
import { seededRandom, stepBehaviours } from './behaviours.mjs';
import { openChurnPr, seedDefaultFleet } from './fleet.mjs';
import { createRoundClock } from './round-clock.mjs';

/** In-process daemon kind → its module in the clone (for the daemon's OWN `hasStaleMainRefusal`). */
const DAEMON_MODULES = Object.freeze({
  review: 'skills-src/conveyor/review-daemon.mjs',
  'fix-dispatch': 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs',
});

function dispatchedPrs(result) {
  const out = new Set();
  for (const d of (Array.isArray(result?.dispatched) ? result.dispatched : [])) {
    const n = Number(d?.prNumber ?? d?.pr ?? d?.number);
    if (Number.isInteger(n)) out.add(n);
  }
  return out;
}

/**
 * Run one soak.
 * @param {object} o
 * @param {string} o.name
 * @param {number} [o.rounds=25] - each round ticks every daemon in `daemons` once (25 rounds × 2 daemons = 50 ticks).
 * @param {string[]} [o.daemons]
 * @param {number} [o.mainEvery=4] - push a commit to origin/main before every Nth round (0 = never).
 * @param {number} [o.seed=1]
 * @param {Partial<typeof DEFAULT_BOUNDS>} [o.bounds]
 * @param {number} [o.lanes=4]
 * @param {Record<string,string>} [o.env] - extra env for every daemon/session in this world.
 * @param {boolean} [o.scorecards=true] - whether review sessions write scorecard rows (see `behaviours.mjs`).
 * @param {boolean} [o.junkInCwd=true] - whether a lane-less session's junk lands in its spawn cwd (the daemon clone).
 * @param {boolean} [o.pinRoundClock=false] - end every round at a fixed virtual instant (see `round-clock.mjs`) instead of
 *   `real elapsed + 3m`, so a slow host cannot shift the soak's time-dependent decisions. The long soak sets it.
 * @param {(w:object, o:{fleet:object[], owed:object[], api:object}) => (object|void)} [o.setup] - runs after the
 *   default fleet is seeded; its return is `ctx`.
 * @param {(w:object, round:number, ctx:object, api:{violation:Function, say:Function, mainMoves:Function,
 *   ticksSoFar:Function}) => (void|Promise<void>)} [o.perRound] - runs at the start of every round (after that
 *   round's main move, if any). `api.violation(invariant, detail)` reports a scenario-specific finding.
 * @param {boolean} [o.fleet=true] - seed the default fleet.
 * @param {number} [o.churnEvery=0] - open one new PR (seeded random state, `fleet.mjs#openChurnPr`) every N rounds.
 * @param {(line:string) => void} [o.log]
 * @returns {Promise<{name:string, ticks:object[], violations:object[], fatal:(string|null), lines:string[], ms:number, ctx:object}>}
 */
export async function runSoak({
  name, rounds = 25, daemons = ['review', 'fix-dispatch'], mainEvery = 4, seed = 1, bounds: boundsIn = {},
  lanes = 4, env = {}, scorecards = true, junkInCwd = true, setup, perRound, fleet = true, churnEvery = 0, pinRoundClock = false,
  log = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  const bounds = { ...DEFAULT_BOUNDS, ...boundsIn };
  const startedAt = Date.now();
  const lines = [];
  const say = (line) => { lines.push(line); log(line); };
  const ticks = [];
  const violations = [];
  const mainMoves = [];
  const tickIndex = Object.fromEntries(daemons.map((d) => [d, 0]));
  const staleStreak = Object.fromEntries(daemons.map((d) => [d, 0]));
  const plans = new Map();
  let owed = [];
  let ctx = {};
  let fatal = null;
  const staleFns = {};
  let churnCount = 0;
  const churnRand = seededRandom(seed * 7919);
  // A scenario hook's own finding (e.g. a lane acquire that blew its bound) is reported on the NEXT tick line,
  // alongside the built-in invariants, so the per-tick report stays the one place every violation shows.
  const pendingHookViolations = [];
  const hookApi = {
    violation: (invariant, detail) => pendingHookViolations.push({ invariant, detail: String(detail) }),
    say: (line) => say(line),
    mainMoves: () => mainMoves.slice(),
    ticksSoFar: () => ticks.length,
    /** Declare new owed work (a PR opened mid-soak): its grace window starts at the owning daemon's NEXT tick. */
    owe: (pr, kind, note = '') => {
      owed.push({ pr, kind, note, dispatched: false, sinceTick: tickIndex[OWED_KIND_DAEMON[kind]] ?? 0 });
    },
    /** Push a commit to origin/main and track it for the behind/lag invariants (never `w.git.commitToMain` directly). */
    moveMain: (w, files, message) => {
      const sha = w.git.commitToMain('we', files, message);
      mainMoves.push({ sha, atTick: ticks.length });
      return sha;
    },
  };

  async function staleFn(w, daemon) {
    if (!(daemon in staleFns)) {
      try {
        const mod = await import(pathToFileURL(join(w.simCloneRoot, DAEMON_MODULES[daemon])).href);
        staleFns[daemon] = typeof mod.hasStaleMainRefusal === 'function' ? mod.hasStaleMainRefusal : () => false;
      } catch { staleFns[daemon] = () => false; }
    }
    return staleFns[daemon];
  }

  function afterTick(daemon, round) {
    return async (w, api) => {
      const entry = [...api.trace].reverse().find((t) => t.daemon === daemon && !t.killed) ?? {};
      const index = tickIndex[daemon];
      const facts = cloneFacts({ clone: w.simCloneRoot, mainMoves });
      const totalTicks = ticks.length;
      const isStale = !entry.restart && entry.result ? !!(await staleFn(w, daemon))(entry.result) : false;
      staleStreak[daemon] = isStale ? staleStreak[daemon] + 1 : 0;

      // Owed work: mark anything this tick dispatched (by result, or by a live/finished session the fake claude
      // recorded), then check what is still owed.
      const sessions = w.claude.sessions();
      const fromResult = dispatchedPrs(entry.result);
      for (const o of owed) {
        if (o.dispatched || OWED_KIND_DAEMON[o.kind] !== daemon) continue;
        if (fromResult.has(o.pr) || sessions.some((s) => sessionMatches(s.name, o.kind, o.pr))) {
          o.dispatched = true;
          o.dispatchedAtTick = index;
        }
      }
      const stillOwed = owed.filter((o) => !o.dispatched && OWED_KIND_DAEMON[o.kind] === daemon)
        .map((o) => ({ ...o, why: explainNoDispatch(entry, o.pr) }));
      const v = [
        ...checkTick({ daemon, index, entry, facts, stale: isStale, staleStreak: staleStreak[daemon], owed: stillOwed, bounds, totalTicks }),
        ...pendingHookViolations.splice(0),
      ];
      for (const x of v) violations.push({ round, daemon, tick: index, ...x });
      ticks.push({ round, daemon, index, restart: !!entry.restart, error: entry.error ?? null, onTickError: entry.onTickError ?? null,
        ms: entry.ms ?? null, dirty: facts.dirty, behind: facts.behind, stale: isStale, violations: v, logs: entry.logs ?? [] });
      say(formatTickLine({ round, daemon, index, entry, facts, stale: isStale, violations: v }));
      tickIndex[daemon] += 1;
    };
  }

  const play = [];
  // `pinRoundClock`: round 0 is timed from the first play step; see `round-clock.mjs`.
  let roundClock = null;
  play.push((w) => { roundClock = pinRoundClock ? createRoundClock(w.clock) : null; roundClock?.begin(); });
  for (let round = 0; round < rounds; round += 1) {
    if (mainEvery > 0 && round > 0 && round % mainEvery === 0) {
      play.push((w) => {
        const n = mainMoves.length + 1;
        // Alternate a docs-only move with a code-path move: both are real main movement a managed clone must
        // follow; the code-path one is what `main-staleness.mjs` counts as stale.
        const file = n % 2 ? `soak/main-move-${n}.md` : `scripts/conveyor/soak/fixtures/main-move-${n}.mjs`;
        const content = n % 2 ? `# main move ${n}\n` : `export const MAIN_MOVE = ${n};\n`;
        const sha = hookApi.moveMain(w, { [file]: content }, `soak: main move ${n}`);
        say(`r${String(round).padStart(2, '0')} main moved -> ${sha.slice(0, 9)} (${file}); ${mainMoves.length} move(s) so far`);
      });
    }
    if (churnEvery > 0 && round > 0 && round % churnEvery === 0) {
      play.push((w) => {
        const opened = openChurnPr(w, { n: churnCount += 1, rand: churnRand, api: hookApi });
        say(`r${String(round).padStart(2, '0')} new PR #${opened.pr} (${opened.key})${opened.owes ? ` owes ${opened.owes}` : ''}`);
      });
    }
    if (perRound) play.push((w) => perRound(w, round, ctx, hookApi));
    for (const daemon of daemons) {
      play.push(`tick ${daemon}`);
      play.push(afterTick(daemon, round));
    }
    play.push(async (w) => {
      const stepped = await stepBehaviours({
        claude: w.claude, gh: w.gh.raw, simClone: w.simCloneRoot, env: w.env, completionsDir: w.completionsDir,
        clock: w.clock, repoFor: () => w.repos.we,
      }, { seed, plans, scorecards, junkInCwd });
      if (stepped.length) {
        say(`r${String(round).padStart(2, '0')} sessions   ${stepped.map((s) => `${s.session}:${s.kind}${s.error ? `(failed: ${s.error})` : ''}`).join(' ')}`);
      }
      if (roundClock) roundClock.endRound();
      else w.clock.advance('3m');
    });
  }

  const def = scenario(name, {
    repos: ['we'],
    lanes,
    setup(w) {
      Object.assign(w.env, { WE_CI_HEAL_DISPATCH_MODE: 'agent' }, env);
      const seeded = fleet ? seedDefaultFleet(w) : [];
      owed = seeded.filter((p) => p.owes).map((p) => ({ pr: p.pr, kind: p.owes, sinceTick: 0, dispatched: false, note: p.note }));
      ctx = (setup ? setup(w, { fleet: seeded, owed, api: hookApi }) : null) ?? {};
      ctx.fleet = seeded;
      say(`soak "${name}": ${rounds} rounds x ${daemons.join('+')}, main moves every ${mainEvery || 'never'} rounds, seed ${seed}; fleet: ${seeded.map((p) => `#${p.pr} ${p.key}${p.owes ? `(owes ${p.owes})` : ''}`).join(', ') || 'none'}`);
      return ctx;
    },
    play,
  });

  try {
    await runScenario(def, { timeoutMs: bounds.tickBoundMs });
  } catch (e) {
    // Keep the first few lines: an isolation-check failure names the touched real paths on the lines after its
    // headline, and they are the whole diagnosis (locally, a concurrently running REAL daemon fleet can trip it).
    fatal = String((e && e.message) || e).split('\n').slice(0, 5).join(' | ');
    const invariant = /timed out/.test(fatal) ? 'bounded' : /ISOLATION CHECK FAILED/.test(fatal) ? 'isolation' : 'crash';
    violations.push({ round: null, daemon: null, tick: null, invariant, detail: fatal });
    say(`FATAL [${invariant}] ${fatal}`);
  }
  // A hook finding with no later tick to ride on (a daemon-less scenario that drives the code directly, or one
  // raised in the last round) is still a finding — never let it vanish into a false GREEN (PR #2731 review).
  for (const x of pendingHookViolations.splice(0)) {
    violations.push({ round: null, daemon: null, tick: null, ...x });
    say(`hook [${x.invariant}] ${x.detail}`);
  }
  const ms = Date.now() - startedAt;
  const byInv = {};
  for (const v of violations) byInv[v.invariant] = (byInv[v.invariant] ?? 0) + 1;
  say(`soak "${name}": ${ticks.length} ticks checked in ${(ms / 1000).toFixed(1)}s — ${violations.length ? `${violations.length} violation(s): ${JSON.stringify(byInv)}` : 'every invariant held after every tick'}`);
  return { name, ticks, violations, fatal, lines, ms, ctx, mainMoves };
}
