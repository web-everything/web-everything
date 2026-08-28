/**
 * @file dispatch-lane.test.mjs — the effect that STARTS rather than completes (#3037, under epic #3029).
 *
 * WHAT THIS FILE IS FOR. #3037's acceptance has two clauses, and the tests are grouped to match them:
 *
 *   1. **A lane is dispatched with the SAME holds and bookkeeping as the current tick.** The proof is
 *      structural, not statistical: the operation reads `decisions.spawnBuilds` and nothing else, `lane` is
 *      not an input field at all, and a `num` the core SUPPRESSED comes back as a non-dispatch carrying the
 *      guard's own reason. There is no path from a caller to a lane the core did not assign.
 *   2. **The launched agent's handle is recorded on the run.** Asserted here at the effect-entry level; the
 *      cross-process half — a second `node` that never saw the dispatch reading the handle off disk — is
 *      `./dispatch-crosses-processes.test.mjs`.
 *
 * NOTHING HERE SPAWNS AN AGENT, and that is the point of the injected `spawnAgent`: the argv is asserted
 * exactly (it is the contract with the `claude` CLI), and no `claude` process is ever started by the suite.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { importGraph } from './import-graph.mjs';
import { releaseSessionForNum } from '../../conveyor/tick-core.mjs';
import { normNum } from '../../conveyor/queue-store.mjs';
import { advance, advanceWhileRunning, runStatus, startRun } from '../engine.mjs';
import { applyPendingEffects, inFlightEntries, isInFlightResult } from '../effect-executor.mjs';
import { observeRun } from '../effect-observer.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { createRegistry } from '../registry.mjs';
import { OPERATIONS, resolveOperation } from '../run.mjs';
import {
  BRIEF_PLACEHOLDERS,
  BRIEF_PLACEHOLDERS_BY_KIND,
  BRIEF_TOKEN_RE,
  CI_HEAL_BRIEF_PLACEHOLDERS,
  DEFAULT_EXPECTED_WITHIN_MINUTES,
  DISPATCH_EFFECT,
  DISPATCH_HOLD_GRACE_MINUTES,
  DISPATCH_LANE_OP,
  DISPATCH_LISTING_GRACE_MINUTES,
  FIX_BRIEF_PLACEHOLDERS,
  ITEM_SCOPED_LAUNCH_KINDS,
  LAUNCH_KINDS,
  PR_REPAIR_LAUNCH_KINDS,
  canonicalPlaceholder,
  dispatchLaneOperation,
  DISPATCH_GUARD_LISTING_GRACE_MINUTES,
  dispatchStillHolds,
  fillBrief,
  sessionSlugFor,
  shapeDispatchRead,
} from '../dispatch-lane.mjs';
import {
  AGENT_ARGS_ENV,
  LISTING_GRACE_MS,
  agentArgsFromEnv,
  assertNotALaneCheckout,
  briefPath,
  buildAgentArgv,
  classifyDispatchPr,
  createDispatchObservers,
  createDispatchSinks,
  REPO_ROOT,
  forwardableBookkeeping,
  inFlightDispatchesFor,
  isPreSpawnRefusal,
  readTick,
  stampLiveness,
} from '../dispatch-lane-io.mjs';

const OPS_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * The cwd a dispatch is legitimately made from — a PRIMARY checkout. Stated explicitly rather than defaulted,
 * because the default (`REPO_ROOT`, resolved by script location) is a lane clone whenever the suite itself runs
 * in one, and the sink refuses to dispatch from a lane.
 */
const PRIMARY = '/primary/webeverything';

/** A brief template with every placeholder the operation fills, and nothing else. */
const BRIEF = [
  '# brief for #{{ITEM_NUM}}',
  'spec: {{ITEM_SPEC_PATH}}',
  'lane: {{LANE}}',
  'session: {{SESSION_SLUG}}',
  'scope: {{SCOPE}}',
].join('\n');

/** One tick read as the io shell returns it — already selected for the asked num. */
function tickRead(overrides = {}) {
  return {
    resolvedNum: '3037',
    launch: { num: '3037', lane: 8 },
    suppressed: null,
    item: { num: '3037', slug: 'declare-dispatch', specPath: 'backlog/3037-declare-dispatch.md', scope: ['we:scripts/operations/'] },
    briefTemplate: BRIEF,
    nextState: { tick: 1, buildGuards: [{ num: '3037', lane: 8, spawnedTick: 0 }, { num: '4000', lane: 9, spawnedTick: 0 }] },
    dispatchedGuard: { num: '3037', lane: 8, spawnedTick: 0 },
    statusLine: 'conveyor · 1 building · 0 preparing',
    notes: [],
    droppedBookkeepingKeys: [],
    inFlightDispatches: { runs: [], unreadable: 0, livenessSource: 'not-needed' },
    bookkeepingSource: 'file',
    // WHEN the read was taken. The double-dispatch guard ages out against this, and the declaration is pure —
    // so the instant arrives as data. `NOW` is 10:00 and every in-flight fixture below is dated relative to it.
    observedAt: NOW,
    ...overrides,
  };
}

/** The instant every aging assertion is read against. */
const NOW = '2026-08-13T10:00:00.000Z';
/**
 * An in-flight dispatch record summary, as `readTick` hands one to the declaration — `live` is the answer
 * `claude agents --json` gave about its handle, stamped on by `stampLiveness`. It defaults to TRUE because
 * that is what an in-flight dispatch normally is: an agent that is still running.
 */
function inFlightRun(over = {}) {
  return {
    runId: 'dispatch-lane-abc', key: 'run-x#2#0', handle: 'sess-1',
    startedAt: '2026-08-13T09:30:00.000Z', expectedBy: '2026-08-13T11:00:00.000Z', live: true, ...over,
  };
}
/** The same row with its session GONE from the listing — what an aged-out record actually looks like. */
function goneRun(over = {}) {
  return inFlightRun({ live: false, ...over });
}
/** An `inFlightDispatches` block as the io shell returns it, liveness read from a real listing. */
function inFlightBlock(runs, over = {}) {
  return { runs, unreadable: 0, livenessSource: 'claude-agents', ...over };
}
/** `at` shifted by minutes, as an ISO string. */
function isoPlus(at, minutes) {
  return new Date(Date.parse(at) + minutes * 60_000).toISOString();
}

/** A registry holding only this operation, built over a stub reader. */
function registryFor(read = tickRead()) {
  const registry = createRegistry();
  const declaration = dispatchLaneOperation({ readTick: () => (typeof read === 'function' ? read() : read) });
  registry.register(declaration);
  return { registry, declaration };
}

/** Drive a run to its first suspend (or completion). */
function runTo(read = tickRead(), input = { num: '3037' }) {
  const { registry } = registryFor(read);
  const run = advanceWhileRunning(startRun({ op: DISPATCH_LANE_OP, id: 'run-dispatch', input, registry }), { registry });
  return { run, registry };
}

// ── 1. the declaration is registered, and it reaches nothing ────────────────────────────────────────────────

describe('the operation is callable at all', () => {
  it('is in the OPERATIONS table — an unregistered declaration is the defect `gate-health` shipped with', () => {
    expect(Object.keys(OPERATIONS)).toContain(DISPATCH_LANE_OP);
    expect(resolveOperation(DISPATCH_LANE_OP).declaration.name).toBe(DISPATCH_LANE_OP);
  });

  it('binds a sink for the one effect type it declares — a dispatch with no sink refuses the whole step', () => {
    expect(Object.keys(resolveOperation(DISPATCH_LANE_OP).sinks)).toEqual([DISPATCH_EFFECT]);
  });

  it('the DECLARATION module reaches nothing that can act — no `node:` specifier, no package', () => {
    // The same technique the engine and the read-only operations use. This operation is NOT read-only (it has
    // an effect step), so the http-adapter suite does not cover it; the property is asserted here instead,
    // because "the spawner lives in the io shell" is otherwise only a claim in a comment.
    expect(importGraph(resolvePath(OPS_DIR, 'dispatch-lane.mjs')).external).toEqual([]);
  });
});

// ── 2. clause 1 — the holds are the tick core's, and a caller cannot reach around them ──────────────────────

describe('the lane comes from the tick core or nowhere', () => {
  it('does not declare a `lane` input — a caller cannot ask for one', () => {
    const { declaration } = registryFor();
    expect(Object.keys(declaration.input).sort()).toEqual(['bookkeepingFile', 'expectedWithinMinutes', 'num']);
    expect(declaration.input.num.type).toBe('string'); // an id may be a `xNNNNNN` hash, never only a number
    expect(declaration.input.expectedWithinMinutes.default).toBe(DEFAULT_EXPECTED_WITHIN_MINUTES);
  });

  it('dispatches the lane the core assigned', () => {
    const { run } = runTo(tickRead({ launch: { num: '3037', lane: 12 } }));
    expect(run.verdict).toMatchObject({ dispatching: true, lane: 12, sessionSlug: 'conveyor-3037' });
    expect(run.effects).toHaveLength(1);
    expect(run.effects[0].payload.lane).toBe(12);
  });

  it('a num SUPPRESSED by the in-flight guard is a non-dispatch carrying the guard\'s reason, not a launch', () => {
    const { run, registry } = runTo(tickRead({ launch: null, suppressed: { num: '3037', lane: 8, by: 'lane' } }));
    expect(run.verdict.dispatching).toBe(false);
    expect(run.verdict.reason).toMatch(/in-flight build guard/);
    expect(run.verdict.reason).toMatch(/lane 8 is held/);
    // ZERO effects → the run COMPLETES rather than parking. A tick where every item is held must not leave a
    // suspended record behind for the waker to poll forever.
    expect(run.effects).toEqual([]);
    expect(runStatus(run, { registry })).toBe('complete');
  });

  it('a num the core never cleared says so plainly', () => {
    const { run } = runTo(tickRead({ launch: null }));
    expect(run.verdict.dispatching).toBe(false);
    expect(run.verdict.reason).toMatch(/not in `decisions\.spawnBuilds`/);
  });

  it('records THIS dispatch\'s guard separately from the whole tick\'s, which describes work it did not do', () => {
    const { run } = runTo();
    // `planTick` records a guard per PLANNED spawn — here two, for #3037 and a sibling #4000 on lane 9. This
    // operation started one agent, so only one guard is earned. A caller that carried `tickNextState` forward
    // would hold #4000's lane for the whole TTL against a dispatch that never happened.
    expect(run.findings.read.dispatchedGuard).toEqual({ num: '3037', lane: 8, spawnedTick: 0 });
    expect(run.findings.read.tickNextState.buildGuards).toHaveLength(2);
    expect(run.findings.read.nextState).toBeUndefined(); // the name that invited the mistake is gone
    expect(run.verdict.guardsFrom).toBe('file');
  });

  it('reports a guard-LESS read on the verdict rather than passing it off as a guarded one', () => {
    const { run } = runTo(tickRead({ bookkeepingSource: 'none' }));
    expect(run.verdict.guardsFrom).toBe('none');
  });

  it('reports which of the caller\'s OWN settings the read did not honour, on the verdict', () => {
    // Dropping `config` is not purely conservative — a caller running a LONGER `buildTtlTicks` silently gets
    // the shipped default — so the drop has to be visible where the decision is read, not only in a comment.
    const { run } = runTo(tickRead({ droppedBookkeepingKeys: ['config', 'signals'] }));
    expect(run.verdict.droppedBookkeeping).toEqual(['config', 'signals']);
  });

  it('REFUSES a second dispatch while one of its own is still in flight for the item', () => {
    // The tick core's build guard lives in the caller's session bookkeeping, which defaults to empty here, and
    // the LANE is leased by the agent seconds after it starts — so two back-to-back invocations would get the
    // same cleared row and put two agents in one clone. The run store is what remembers the first one.
    const { run, registry } = runTo(tickRead({
      inFlightDispatches: inFlightBlock([inFlightRun()]),
    }));
    expect(run.verdict.dispatching).toBe(false);
    expect(run.verdict.reason).toMatch(/already has a dispatch in flight/);
    expect(run.verdict.reason).toMatch(/dispatch-lane-abc/);
    expect(run.effects).toEqual([]);
    expect(runStatus(run, { registry })).toBe('complete');
    // …and it wins over a launch the core cleared, which is the whole point: the core cannot see this.
    expect(run.findings.read.lane).toBeNull();
    // The hold NAMES the way out, because there is one now — a hold whose only remedy is hand-written node is
    // how one completed dispatch used to lock an item out for the life of the runs directory.
    expect(run.verdict.reason).toMatch(/wake\.mjs --resolve=/);
  });

  // ── PR #1211: F1 (round 1) and G1 (round 2) — TWO OPPOSITE FAILURES, and both must stay fixed ──────────────
  //
  // ROUND 1, F1: the observer can never answer `succeeded`, `unresolved` writes nothing, and run records are
  // never pruned. Composed with a guard that held on ANY in-flight record, that made this operation single-use
  // per item — the conveyor's own loop (dispatch → PR → review bounces → re-dispatch) could never run.
  //
  // ROUND 2, G1: the fix released the hold on WALL CLOCK ALONE. The same record, at the same instant, was
  // reported `still running` by the waker and dispatched past by the guard — and the scenario that produces a
  // long-lived agent holding no lease is the likeliest first-run failure (a background session stalled on a
  // permission prompt): alive, no lane leased, nothing claimed, so a second agent starts on the same lane under
  // the same session slug. The tests below are the two halves. Neither may be traded away for the other.

  it('G1: a record whose session `claude agents` STILL LISTS holds at ANY age — the clock cannot release a live agent', () => {
    // THE REVIEW'S OWN REPRODUCTION, to the minute: started 121 minutes ago with a 90-minute deadline, so it
    // is 31 minutes past `expectedBy + DISPATCH_HOLD_GRACE_MINUTES` — the exact point the clock-only guard
    // dispatched while the waker printed `still running` for the same handle in the same instant.
    const startedAt = isoPlus(NOW, -121);
    const stalled = inFlightRun({ runId: 'run-live-demo', startedAt, expectedBy: isoPlus(startedAt, 90), live: true });
    const { run, registry } = runTo(tickRead({ inFlightDispatches: inFlightBlock([stalled]) }));

    expect(run.verdict.dispatching).toBe(false);
    expect(run.effects).toEqual([]);
    expect(runStatus(run, { registry })).toBe('complete');
    expect(run.verdict.agedOutDispatches).toEqual([]);
    // …and the operator's line says WHICH fact holds it, because "inside its window" and "its session is
    // listed" call for different actions.
    expect(run.verdict.reason).toMatch(/STILL LISTED by `claude agents`/);
    expect(run.verdict.reason).toMatch(/sess-1/);
    // The function itself, at eighty times the age: there is no instant at which a listed session releases.
    expect(dispatchStillHolds(stalled, isoPlus(NOW, 10_000))).toBe(true);
  });

  it('G1/F1 together: a record whose session is GONE still ages out — in MINUTES, and the lockout stays fixed', () => {
    // The trap the round-2 fix fell into, closed in the opposite direction: making the guard ask about liveness
    // must not restore the permanent per-item lockout. A handle the listing does not carry describes an agent
    // that finished or died, and neither can collide with a fresh one in a lane.
    const gone = goneRun({ startedAt: isoPlus(NOW, -10) });
    const { run } = runTo(tickRead({ inFlightDispatches: inFlightBlock([gone]) }));
    expect(run.verdict.dispatching).toBe(true);
    expect(run.effects).toHaveLength(1);
    // …and it is not silent about what it went past: the record is still `in-flight` on disk.
    expect(run.verdict.agedOutDispatches).toEqual(['dispatch-lane-abc']);
    expect(run.verdict.reason).toMatch(/aged-out in-flight dispatch record/);
    // It does NOT wait out the 90-minute estimate first — that agent is gone, and the clock was only ever the
    // backstop for a record nothing could be observed about.
    expect(dispatchStillHolds(gone, NOW)).toBe(false);
  });

  it('G1: ABSENT but too YOUNG to be listed still holds — `--bg` returns before the session is visible', () => {
    // The listing grace IS the spawn→claim window the whole guard exists for, so "not in the listing" must not
    // mean "gone" inside it. Written with the LITERAL as well as the constant.
    //
    // WHICH WINDOW, corrected by #3353's hardening 5. This used to age against the OBSERVER's two minutes,
    // because both readers shared one constant. They no longer do: the guard reads its own, larger
    // `DISPATCH_GUARD_LISTING_GRACE_MINUTES`, on the grounds that the observer's wrong answer writes nothing
    // while the guard's starts a SECOND agent in an occupied lane clone. The property under test is unchanged
    // — absent-and-young holds, absent-and-old does not — only the width of "young".
    const started = isoPlus(NOW, -1); // one minute old, and not in the listing
    const young = goneRun({ startedAt: started, expectedBy: isoPlus(started, 90) });
    expect(DISPATCH_LISTING_GRACE_MINUTES).toBe(2);
    expect(DISPATCH_GUARD_LISTING_GRACE_MINUTES).toBe(10);
    expect(dispatchStillHolds(young, NOW)).toBe(true);
    expect(dispatchStillHolds(young, isoPlus(started, 9.5))).toBe(true);
    expect(dispatchStillHolds(young, isoPlus(started, 10.5))).toBe(false);
    // The observer's two minutes no longer release it — the exact assertion that reddens if the two constants
    // are ever collapsed back into one.
    expect(dispatchStillHolds(young, isoPlus(started, 2.5))).toBe(true);
    // …and an absent handle whose `startedAt` cannot be read cannot be told from a just-started one → holds.
    expect(dispatchStillHolds(goneRun({ startedAt: null }), NOW)).toBe(true);
  });

  it('G1: with the listing UNREADABLE the clock backstop still applies — and the verdict says the guard was weak', () => {
    // A `claude` that is missing or wedged means the system has NO liveness signal, so the `running` answer the
    // clock used to contradict cannot be the one being contradicted. The clock is sound exactly here — but a
    // caller must be able to see that this release was decided without liveness.
    const unknown = {
      runId: 'no-liveness', key: 'k', handle: 'sess-1',
      startedAt: isoPlus(NOW, -200), expectedBy: isoPlus(NOW, -60), live: null,
    };
    const { run } = runTo(tickRead({ inFlightDispatches: { runs: [unknown], unreadable: 0, livenessSource: 'unreadable' } }));
    expect(run.verdict.dispatching).toBe(true);
    expect(run.verdict.agedOutDispatches).toEqual(['no-liveness']);
    expect(run.verdict.dispatchLiveness).toBe('unreadable');
    // …and a hold decided the same way says so rather than claiming a listing it never read.
    const held = runTo(tickRead({
      inFlightDispatches: { runs: [{ ...unknown, expectedBy: isoPlus(NOW, 60) }], unreadable: 0, livenessSource: 'unreadable' },
    })).run;
    expect(held.verdict.dispatching).toBe(false);
    expect(held.verdict.reason).toMatch(/nothing could establish whether its agent is alive/);
    expect(held.verdict.dispatchLiveness).toBe('unreadable');
    // A guard that DID read the listing reports the strong source, and one with nothing to ask about says so.
    expect(runTo(tickRead({ inFlightDispatches: inFlightBlock([goneRun({ startedAt: isoPlus(NOW, -10) })]) })).run.verdict.dispatchLiveness)
      .toBe('claude-agents');
    expect(runTo().run.verdict.dispatchLiveness).toBe('not-needed');
  });

  it('the CLOCK BACKSTOP boundary, pinned with LITERALS and not only with the constants (round 2, G5)', () => {
    // The backstop governs an entry whose liveness is UNKNOWN, and only that. THE VALUES ARE ASSERTED, not
    // just the shape: the round-2 boundary tests were written as `isoPlus(NOW, DISPATCH_HOLD_GRACE_MINUTES ± 1)`,
    // so every assertion stayed true for ANY margin and `30 → 0` survived with the whole suite green. A margin
    // asserted only against itself is a margin the next refactor deletes for free.
    expect(DISPATCH_HOLD_GRACE_MINUTES).toBe(30);
    expect(DEFAULT_EXPECTED_WITHIN_MINUTES).toBe(90);
    const entry = { expectedBy: NOW, startedAt: isoPlus(NOW, -90) }; // no `live` → the backstop
    expect(dispatchStillHolds(entry, isoPlus(NOW, 29))).toBe(true);
    expect(dispatchStillHolds(entry, isoPlus(NOW, 31))).toBe(false);
    // …and at a ZEROED margin the 29-minute case flips, which is what makes this an assertion about the VALUE
    // rather than a restatement of the code.
    expect(dispatchStillHolds(entry, isoPlus(NOW, 29), { graceMinutes: 0 })).toBe(false);
    // A handle-less INDETERMINATE entry never got an `expectedBy`; its deadline is reconstructed from
    // `startedAt` and the same estimate, so it ages out too rather than holding the item forever.
    const noDeadline = { expectedBy: null, startedAt: NOW };
    expect(dispatchStillHolds(noDeadline, isoPlus(NOW, 90 + 30 - 1))).toBe(true);
    expect(dispatchStillHolds(noDeadline, isoPlus(NOW, 90 + 30 + 1))).toBe(false);
    // FAIL-CLOSED on a date it cannot read: a wrong "aged out" is two agents in one clone, a wrong "still
    // holding" is a refusal an operator can see.
    expect(dispatchStillHolds({ expectedBy: null, startedAt: null }, NOW)).toBe(true);
    expect(dispatchStillHolds(entry, 'not a date')).toBe(true);
  });

  it('holds on the LIVE record even when a gone sibling exists — the question is asked per record, not per item', () => {
    const { run, registry } = runTo(tickRead({
      inFlightDispatches: inFlightBlock([
        goneRun({ runId: 'stale-1', startedAt: isoPlus(NOW, -120) }),
        inFlightRun({ runId: 'live-1' }),
      ]),
    }));
    expect(run.verdict.dispatching).toBe(false);
    expect(run.verdict.reason).toMatch(/live-1/);
    expect(run.verdict.reason).not.toMatch(/stale-1/);
    expect(run.verdict.agedOutDispatches).toEqual(['stale-1']);
    expect(runStatus(run, { registry })).toBe('complete');
  });

  // ── PR #1211 review, F4 — a claim wider than the code: the partial-guard count was read and dropped ────────

  it('SURFACES a partial double-dispatch guard on the verdict — an unreadable run record is not a clean zero', () => {
    // `inFlightDispatchesFor` skips a corrupt record rather than wedging every dispatch. That trade is only
    // acceptable if the caller can SEE it, and the guard's failure mode (two agents in one lane clone) is the
    // last thing that should degrade silently.
    const { run } = runTo(tickRead({ inFlightDispatches: { runs: [], unreadable: 2, livenessSource: 'not-needed' } }));
    expect(run.verdict.dispatching).toBe(true);
    expect(run.verdict.unreadableRunRecords).toBe(2);
    // …and on a HOLD too, which is the exit that used to drop it as well.
    const held = runTo(tickRead({ inFlightDispatches: inFlightBlock([inFlightRun()], { unreadable: 3 }) })).run;
    expect(held.verdict.dispatching).toBe(false);
    expect(held.verdict.unreadableRunRecords).toBe(3);
    // A complete guard says so with a number, not with an absent field.
    expect(runTo().run.verdict.unreadableRunRecords).toBe(0);
  });

  it('refuses a cleared item the core assigned no lane, rather than dispatching without one', () => {
    expect(() => runTo(tickRead({ launch: { num: '3037', lane: null } }))).toThrow(/assigned it no lane/);
  });

  it('refuses an unscoped item — an empty scope declares a lane that owns no paths', () => {
    const read = tickRead();
    expect(() => shapeDispatchRead({ ...read, item: { ...read.item, scope: [] } }, { num: '3037' }))
      .toThrow(/no `scope:`/);
  });

  it('refuses when no backlog file resolved — the brief needs the spec path', () => {
    expect(() => shapeDispatchRead({ ...tickRead(), item: null }, { num: '3037' })).toThrow(/no backlog file resolved/);
  });

  it('refuses a reader that answers with something other than a tick read', () => {
    expect(() => shapeDispatchRead(null, { num: '3037' })).toThrow(/not a tick read/);
    expect(() => shapeDispatchRead({ resolvedNum: '' }, { num: '3037' })).toThrow(/could not resolve/);
  });
});

// ── 3. the brief is FILLED, and a half-filled one never leaves the building ─────────────────────────────────

describe('filling the delivery brief', () => {
  const VALUES = { ITEM_NUM: '3037', ITEM_SPEC_PATH: 'backlog/3037-x.md', LANE: 8, SESSION_SLUG: 'conveyor-3037', SCOPE: 'we:a,we:b' };

  it('substitutes all five placeholders and leaves the prose alone', () => {
    const { prompt, unknownTokens } = fillBrief(BRIEF, VALUES);
    expect(prompt).toContain('# brief for #3037');
    expect(prompt).toContain('lane: 8');
    expect(prompt).toContain('scope: we:a,we:b');
    expect(prompt).not.toMatch(/\{\{/);
    expect(unknownTokens).toEqual([]);
  });

  it('FILLS THE REAL BRIEF ON DISK — the one file the whole operation depends on', () => {
    // THE TEST THIS FILE SHIPPED WITHOUT, and the defect it would have caught immediately: every other test
    // uses a synthetic five-token template, so a leftover-token REFUSAL that fired on the real brief's own
    // prose (`{{PLACEHOLDERS}}` / `{{LIKE_THIS}}`, both documentation) passed 40 green tests while making
    // every real dispatch throw. A stub template cannot stand in for the contract with a real file.
    const { prompt, unknownTokens } = fillBrief(readFileSync(briefPath(), 'utf8'), VALUES);
    expect(prompt).toContain('--lane=8');
    expect(prompt).toContain('--session=conveyor-3037');
    expect(prompt).toContain('--scope=we:a,we:b');
    expect(prompt).toContain('backlog/3037-x.md');
    // Not one of the five remains; the two the template talks ABOUT are reported, never fatal.
    for (const name of ['ITEM_NUM', 'ITEM_SPEC_PATH', 'LANE', 'SESSION_SLUG', 'SCOPE']) {
      expect(prompt).not.toContain(`{{${name}}}`);
    }
    expect(unknownTokens).toEqual(['{{LIKE_THIS}}', '{{PLACEHOLDERS}}']);
  });

  it('REPORTS an unknown token instead of refusing — the cost of a stray token is one confusing line', () => {
    const { prompt, unknownTokens } = fillBrief(`${BRIEF}\nmodel: {{MODEL}}`, VALUES);
    expect(unknownTokens).toEqual(['{{MODEL}}']);
    expect(prompt).toContain('model: {{MODEL}}');
  });

  it('cannot re-expand a token that arrived inside a VALUE', () => {
    // The allowlist has no `{` or `}`, so a value can never carry a token in the first place. The one-pass
    // substitution is the second line of defence and is deliberately NOT asserted here: with braces forbidden
    // there is no input that distinguishes one pass from a substitute-per-placeholder loop, and an assertion
    // that passes under both would be decorative. This is the reachable half.
    expect(() => fillBrief(BRIEF, { ...VALUES, ITEM_SPEC_PATH: 'backlog/{{SCOPE}}.md' })).toThrow(/cannot carry/);
  });

  it('refuses a value carrying shell metacharacters — the brief pastes SCOPE unquoted into a command', () => {
    expect(() => fillBrief(BRIEF, { ...VALUES, SCOPE: 'we:a;rm -rf /' })).toThrow(/cannot carry\s+safely/);
    expect(() => fillBrief(BRIEF, { ...VALUES, SCOPE: 'we:a`whoami`' })).toThrow(/cannot carry/);
    expect(() => fillBrief(BRIEF, { ...VALUES, ITEM_NUM: '3037\nrm -rf /' })).toThrow(/cannot carry/);
  });

  it('refuses an empty template and a blank value rather than dispatching a hollow brief', () => {
    expect(() => fillBrief('   ', {})).toThrow(/template is empty/);
    // ASSERT THE DISTINCT MESSAGE, not the token (PR #1211 review, F7). The first cut matched `/{{ITEM_NUM}}/`,
    // which the ALLOWLIST refusal's message also contains — so deleting the missing/blank branch entirely left
    // this green on the wrong error. The gap that hid behind it is real: `undefined` stringifies to the word
    // `'undefined'`, which PASSES `BRIEF_VALUE_RE`, so without this branch a missing value fills the brief with
    // the literal text `undefined` and nothing complains.
    expect(() => fillBrief(BRIEF, { ...VALUES, ITEM_NUM: '' })).toThrow(/no value for the brief placeholder \{\{ITEM_NUM\}\}/);
    expect(() => fillBrief(BRIEF, { ...VALUES, LANE: undefined })).toThrow(/no value for the brief placeholder \{\{LANE\}\}/);
    expect(() => fillBrief(BRIEF, { ...VALUES, SCOPE: null })).toThrow(/no value for the brief placeholder \{\{SCOPE\}\}/);
    expect(() => fillBrief(BRIEF, { ...VALUES, SESSION_SLUG: '   ' })).toThrow(/no value for the brief placeholder/);
    // …and the two refusals stay distinguishable, which is what the weak assertion could not tell.
    expect(() => fillBrief(BRIEF, { ...VALUES, SCOPE: 'we:a;rm -rf /' })).toThrow(/cannot carry/);
  });

  // ── PR #1211 review, F3 / F7 — the PROPERTY, not the input that happened to fail ───────────────────────────
  //
  // THE PROPERTY: no placeholder of this operation's own may reach a dispatched agent unsubstituted, in ANY
  // spelling — and the refusal must NAME which one. The round-1 fix (report leftovers instead of refusing) was
  // over-broad: its scan matched only `{{EXACT_UPPER}}`, so a near-miss was neither substituted nor reported,
  // and the regression test written for it was shaped to the one input that had failed.

  it('REFUSES every near-miss spelling of every placeholder, and names the one it meant', () => {
    // Table-driven over all five names × the spellings a human typo actually produces. Any one of these
    // reaching an agent is the failure: `export LANE_SESSION={{ SESSION_SLUG }}` leases under a bogus session
    // name that `pr-watch --release-session conveyor-<num>` never releases — a stranded lease.
    //
    // THE SPACE AND THE DOT ARE HERE BECAUSE ROUND 2 FOUND THEM (G4). The claim said "in any spelling" while
    // the scan's character class was `[A-Za-z0-9_-]`, so `{{ITEM NUM}}` and `{{ITEM.NUM}}` — an underscore
    // typed as a space, or as a dot — matched NOTHING: not substituted, not refused, and not even reported as
    // an unknown token. They reached the agent verbatim and invisibly, which is exactly the failure the round-1
    // fix was written to prevent.
    const variant = (name) => [
      `{{ ${name} }}`,
      `{{${name.toLowerCase()}}}`,
      `{{${name.replace(/_/g, '-')}}}`,
      `{{${name.replace(/_/g, ' ')}}}`,
      `{{${name.replace(/_/g, '.')}}}`,
      `{{  ${name}}}`,
    ]
      // A name with no underscore (`LANE`, `SCOPE`) separator-swaps to ITSELF — the correct spelling, not a typo.
      .filter((t) => t !== `{{${name}}}`);
    for (const name of BRIEF_PLACEHOLDERS) {
      for (const token of variant(name)) {
        const template = `${BRIEF}\ntypo: ${token}`;
        expect(() => fillBrief(template, VALUES), `${token} must be refused`).toThrow(/MISSPELLED placeholder/);
        // NAMES WHICH ONE — matched on the `(meaning …)` clause, not anywhere in the message: the refusal also
        // lists all five correct spellings, so a laxer pattern would pass for the wrong placeholder.
        expect(() => fillBrief(template, VALUES), `${token} must name {{${name}}}`).toThrow(new RegExp(`meaning \\{\\{${name}\\}\\}`));
      }
    }
    // The canonicalizer that decides "is this a misspelling OF one of ours" is the whole discrimination.
    expect(canonicalPlaceholder(' item-num ')).toBe('ITEM_NUM');
    expect(canonicalPlaceholder('Item.Num')).toBe('ITEM_NUM');
    expect(canonicalPlaceholder('SESSION SLUG')).toBe('SESSION_SLUG');
    expect(canonicalPlaceholder('LIKE_THIS')).toBeNull();
  });

  it('G4: the three spellings the round-2 review proved INVISIBLE are refused, one character at a time', () => {
    // Named separately from the table above because these are the exact strings the review ran, and each of
    // them previously came back `FILLED … unknownTokens: []` — the worst of the three possible outcomes.
    for (const token of ['{{ITEM NUM}}', '{{ITEM.NUM}}', '{{SESSION SLUG}}']) {
      expect(() => fillBrief(`${BRIEF}\nexport LANE_SESSION=${token}`, VALUES), `${token} must be refused`)
        .toThrow(/MISSPELLED placeholder/);
    }
    // And the DETECTION half of the property, directly: the scan sees any token that carries no brace.
    expect([...'a {{ITEM NUM}} b {{ITEM.NUM}} c'.matchAll(BRIEF_TOKEN_RE)].map((m) => m[1]))
      .toEqual(['ITEM NUM', 'ITEM.NUM']);
    // A NEWLINE INSIDE THE NAME is the one thing the class excludes, deliberately: a token's name never spans
    // lines, and admitting it would let one unclosed `{{` swallow a paragraph of the brief's prose as a single
    // bogus token. (Surrounding whitespace may still be a newline — that is a typo'd placeholder, not prose.)
    expect([...'{{ITEM\nNUM}}'.matchAll(BRIEF_TOKEN_RE)]).toEqual([]);
    expect([...'{{ a }} text {{ b }}'.matchAll(BRIEF_TOKEN_RE)].map((m) => m[1])).toEqual(['a', 'b']);
  });

  it('a token naming NOTHING we fill is still only reported — the round-1 fix is not undone', () => {
    // The correction must not re-break what it corrects: the real brief's own prose carries two tokens that
    // name no placeholder, and refusing those refused EVERY dispatch of EVERY item.
    const { prompt, unknownTokens } = fillBrief(`${BRIEF}\nmodel: {{ MODEL }}\nsee {{LIKE_THIS}}`, VALUES);
    expect(unknownTokens).toEqual(['{{ MODEL }}', '{{LIKE_THIS}}']);
    expect(prompt).toContain('model: {{ MODEL }}');
  });

  it('THE REAL BRIEF: mangling any one of its five tokens is refused, and a filled one carries none of them', () => {
    // The property asserted against the file on disk, one mutation at a time — this is the shape the round-1
    // regression test should have had. Its `toEqual` on `unknownTokens` passed with `{{SESSION_SLUG}}` typo'd
    // to `{{ SESSION_SLUG }}`, because the typo produced no unknown token at all.
    const real = readFileSync(briefPath(), 'utf8');
    for (const name of BRIEF_PLACEHOLDERS) {
      expect(real, `the brief must actually use {{${name}}}`).toContain(`{{${name}}}`);
      const typod = real.replace(`{{${name}}}`, `{{ ${name} }}`);
      expect(() => fillBrief(typod, VALUES), `a typo'd {{${name}}} must not reach an agent`).toThrow(/MISSPELLED placeholder/);
    }
    // …including the spellings round 1's narrower scan could not see at all (round 2, G4).
    for (const name of BRIEF_PLACEHOLDERS) {
      for (const sep of [' ', '.']) {
        const mangled = real.replace(`{{${name}}}`, `{{${name.replace(/_/g, sep)}}}`);
        if (mangled === real) continue; // `LANE` / `SCOPE` have no underscore to mangle
        expect(() => fillBrief(mangled, VALUES), `{{${name.replace(/_/g, sep)}}} must not reach an agent`)
          .toThrow(/MISSPELLED placeholder/);
      }
    }
    // And the clean fill leaves NO token of ours behind, in any spelling THE SCAN ITSELF admits — read through
    // the exported regex, so widening the scan automatically widens this check rather than leaving it behind.
    const { prompt } = fillBrief(real, VALUES);
    for (const [, name] of prompt.matchAll(BRIEF_TOKEN_RE)) {
      expect(canonicalPlaceholder(name), `${name} survived the fill`).toBeNull();
    }
  });

  it('the session slug agrees with the tick core\'s OWN releaseSessionForNum, imported not retyped — for ALL THREE kinds', () => {
    // The first cut of this test hand-typed `'conveyor-3037'` on both sides while claiming to guard agreement
    // with the core — two literals cannot diverge, so it guarded nothing. The real risk is that the merge
    // watcher releases a session slug the agent never leased, and the lease strands.
    for (const num of ['3037', 'x0t9923', '42']) {
      expect(sessionSlugFor(num)).toBe(releaseSessionForNum(num, new Map()));
    }
    // #3165 — THE SAME AGREEMENT FOR THE PREPARE KINDS, which is where it newly matters: a prepare dispatched
    // under `conveyor-<num>` arms a watcher that releases `prepare-<num>`, a session nobody ever acquired, and
    // the real lease strands with nothing pointing at it.
    //
    // NOTE THE SECOND ARGUMENT'S SHAPE, because getting it wrong is a test that passes while proving nothing:
    // `releaseSessionForNum` takes a **Map of num → kind** and does `prepareKindByNum instanceof Map`. Handing
    // it the bare kind STRING yields `undefined`, falls through to `conveyor-<num>` — and would then only
    // agree with the hardcoded slug this card exists to remove.
    for (const num of ['3037', 'x0t9923', '42']) {
      for (const kind of ['prepare', 'prepare-decision']) {
        expect(sessionSlugFor(num, kind), `${kind} #${num}`).toBe(releaseSessionForNum(num, new Map([[num, kind]])));
      }
    }
    // …and the two prepare kinds are DISTINCT slugs, not one aliased onto the other — `prepare-decision-<num>`
    // must not be read as `prepare-` plus a `decision-<num>` id.
    expect(sessionSlugFor('3037', 'prepare')).not.toBe(sessionSlugFor('3037', 'prepare-decision'));
    // THE RESIDUAL, pinned rather than papered over: the dispatcher slugs the NORMALIZED id while `armWatchers`
    // slugs the PR row's RAW one, so a zero-padded spelling would diverge. No id in this repo is padded (the
    // backlog numbers items plainly), which is why this is a pin and not a fix — but if one ever is, the lease
    // this dispatch takes is not the one the watcher releases.
    expect(sessionSlugFor(normNum('0042'))).not.toBe(releaseSessionForNum('0042', new Map()));
  });

  it('the filled brief rides the effect payload, so the record says what was dispatched', () => {
    const { run } = runTo();
    expect(run.effects[0].payload.prompt).toContain('lane: 8');
    expect(run.effects[0].payload.prompt).toContain('session: conveyor-3037');
    expect(run.effects[0].payload.prompt).toContain('scope: we:scripts/operations/');
  });
});

// ── 4. clause 2 — the effect STARTS work, and the handle is recorded ────────────────────────────────────────

describe('the declared effect is a dispatch', () => {
  it('declares exactly one effect, `dispatch: true` and NOT idempotent', () => {
    const { run, registry } = runTo();
    expect(runStatus(run, { registry })).toBe('awaiting-effect');
    expect(run.effects).toHaveLength(1);
    expect(run.effects[0]).toMatchObject({ type: DISPATCH_EFFECT, dispatch: true, idempotent: false, status: 'declared' });
  });

  it('records the handle and the deadline the sink reports, and STAYS suspended', async () => {
    const { run, registry } = runTo();
    const store = createMemoryRunStore();
    const sinks = createDispatchSinks({
      root: PRIMARY,
      spawnAgent: () => '',
      mintSessionId: () => '11111111-2222-3333-4444-555555555555',
      now: () => new Date('2026-08-13T10:00:00.000Z'),
    });
    const outcome = await applyPendingEffects(run, { sinks, store });
    const entry = outcome.run.effects[0];
    expect(entry.status).toBe('in-flight');
    expect(entry.handle).toBe('11111111-2222-3333-4444-555555555555');
    expect(entry.expectedBy).toBe('2026-08-13T11:30:00.000Z'); // 90 minutes, the declared default
    expect(entry.startedAt).toBeTruthy();
    expect(outcome.inFlight).toEqual([entry.key]);
    // The run does NOT advance past a step whose work is still going.
    expect(advance(outcome.run, { registry })).toEqual(outcome.run);
    // `running` vs `overdue` is read against an injected instant — inside the deadline it is healthy work.
    expect(inFlightEntries(outcome.run, '2026-08-13T10:30:00.000Z').running.map((e) => e.key)).toEqual([entry.key]);
    expect(inFlightEntries(outcome.run, '2026-08-13T12:00:00.000Z').overdue.map((e) => e.key)).toEqual([entry.key]);
  });

  it('a REPLAY does not start a second agent on the same lane', async () => {
    const { run } = runTo();
    const store = createMemoryRunStore();
    let spawns = 0;
    const sinks = createDispatchSinks({ root: PRIMARY, spawnAgent: () => { spawns += 1; return ''; }, mintSessionId: () => 'sess-a1' });
    const first = await applyPendingEffects(run, { sinks, store });
    const second = await applyPendingEffects(first.run, { sinks, store });
    expect(spawns).toBe(1);
    expect(second.inFlight).toEqual([first.run.effects[0].key]);
    expect(second.run.effects[0].handle).toBe('sess-a1');
  });

  it('honours a caller\'s own expectedWithinMinutes', async () => {
    const { run } = runTo(tickRead(), { num: '3037', expectedWithinMinutes: 15 });
    const store = createMemoryRunStore();
    const sinks = createDispatchSinks({
      root: PRIMARY, spawnAgent: () => '', mintSessionId: () => 'sess-b2', now: () => new Date('2026-08-13T10:00:00.000Z'),
    });
    const outcome = await applyPendingEffects(run, { sinks, store });
    expect(outcome.run.effects[0].expectedBy).toBe('2026-08-13T10:15:00.000Z');
  });
});

// ── 5. the sink's argv IS the contract with the CLI ─────────────────────────────────────────────────────────

describe('what the sink actually runs', () => {
  const payload = { num: '3037', sessionSlug: 'conveyor-3037', prompt: '# build #3037' };

  it('pins the handle with --session-id instead of racing to discover it', () => {
    expect(buildAgentArgv({ sessionId: 'sess-c3', payload })).toEqual([
      '--bg', '--session-id', 'sess-c3', '-n', 'conveyor-3037', '# build #3037',
    ]);
  });

  it('REFUSES a brief beginning with a dash — position alone does not stop a parser reading it as a flag', () => {
    expect(() => buildAgentArgv({ sessionId: 'sess-c3', payload: { ...payload, prompt: '--bare and hostile' } }))
      .toThrow(/begins with `-`/);
  });

  it('forwards the operator\'s extra flags ahead of the prompt', () => {
    const argv = buildAgentArgv({ sessionId: 'sess-c3', payload, extraArgs: ['--model', 'sonnet'] });
    expect(argv[argv.length - 1]).toBe(payload.prompt);
    expect(argv.slice(-3, -1)).toEqual(['--model', 'sonnet']);
  });

  it('bakes in no permission flag — widening every agent is the operator\'s call, not this file\'s', () => {
    expect(buildAgentArgv({ sessionId: 'sess-c3', payload }).join(' ')).not.toMatch(/permission|dangerous/i);
    expect(agentArgsFromEnv({})).toEqual([]);
  });

  it('but the knob is REACHABLE from the environment, and a malformed one is refused not ignored', () => {
    expect(agentArgsFromEnv({ [AGENT_ARGS_ENV]: '["--permission-mode","acceptEdits"]' }))
      .toEqual(['--permission-mode', 'acceptEdits']);
    // Silently ignoring this is how an operator believes a flag is set that never was.
    expect(() => agentArgsFromEnv({ [AGENT_ARGS_ENV]: '--permission-mode acceptEdits' })).toThrow(/JSON array/);
    expect(() => agentArgsFromEnv({ [AGENT_ARGS_ENV]: '[1,2]' })).toThrow(/JSON array/);
  });

  it('refuses to dispatch from inside a lane clone — the agent\'s first act is to acquire a lane', async () => {
    expect(() => assertNotALaneCheckout('/x/.lanes/web-everything/lane-8')).toThrow(/refusing to start/);
    expect(() => assertNotALaneCheckout('/x/workspace/webeverything')).not.toThrow();
    // …and it is `notApplied`, so the entry is `failed` (retriable) rather than an unknown outcome.
    const { run } = runTo();
    const store = createMemoryRunStore();
    const sinks = createDispatchSinks({ root: '/x/.lanes/web-everything/lane-8', spawnAgent: () => '' });
    const outcome = await applyPendingEffects(run, { sinks, store });
    expect(outcome.run.effects[0].status).toBe('failed');
  });

  it('refuses an empty prompt', () => {
    expect(() => buildAgentArgv({ sessionId: 'sess-c3', payload: { prompt: '  ' } })).toThrow(/empty prompt/);
  });

  it('a missing binary PROVES nothing started → `failed`, which is retried', async () => {
    const { run } = runTo();
    const store = createMemoryRunStore();
    const sinks = createDispatchSinks({
      root: PRIMARY,
      spawnAgent: () => { throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }); },
    });
    const outcome = await applyPendingEffects(run, { sinks, store });
    expect(isPreSpawnRefusal({ code: 'ENOENT' })).toBe(true);
    expect(outcome.run.effects[0].status).toBe('failed');
  });

  it('any OTHER failure is INDETERMINATE — in-flight with no handle, refused on replay', async () => {
    const { run } = runTo();
    const store = createMemoryRunStore();
    const sinks = createDispatchSinks({ root: PRIMARY, spawnAgent: () => { throw new Error('exit 1'); } });
    const outcome = await applyPendingEffects(run, { sinks, store });
    expect(outcome.run.effects[0]).toMatchObject({ status: 'in-flight', handle: null });
    // Reported as `unknown`, never `running` — and the replay guard refuses it rather than double-dispatching.
    expect(inFlightEntries(outcome.run).unknown).toHaveLength(1);
    await expect(applyPendingEffects(outcome.run, { sinks, store })).rejects.toThrow(/NO handle/);
  });

  it('the sink returns a real in-flight marker, not a look-alike', async () => {
    const sinks = createDispatchSinks({ root: PRIMARY, spawnAgent: () => '', mintSessionId: () => 'sess-d4' });
    expect(isInFlightResult(await sinks[DISPATCH_EFFECT]({ prompt: 'p', sessionSlug: 's', num: '1' }))).toBe(true);
  });
});

// ── 6. the observer answers liveness, and refuses to invent an outcome ──────────────────────────────────────

describe('observing a dispatched agent', () => {
  const entry = { key: 'k', type: DISPATCH_EFFECT, handle: 'sess-live', startedAt: '2026-08-13T10:00:00.000Z' };
  const later = () => new Date('2026-08-13T11:00:00.000Z');

  it('a listed session is `running`', async () => {
    const observers = createDispatchObservers({ listAgents: () => [{ sessionId: 'sess-live', kind: 'background' }], now: later });
    expect(await observers[DISPATCH_EFFECT](entry, { handle: 'sess-live' })).toMatchObject({ status: 'running' });
  });

  it('a session that is GONE is `unresolved` — never `succeeded`, because liveness is not an outcome', async () => {
    const observers = createDispatchObservers({ listAgents: () => [{ sessionId: 'someone-else' }], now: later });
    const answer = await observers[DISPATCH_EFFECT](entry, { handle: 'sess-live' });
    expect(answer.status).toBe('unresolved');
    expect(answer.error).toMatch(/liveness and not outcome/);
  });

  it('a session too young to be listed yet is still `running` — `--bg` returns before the listing settles', async () => {
    const observers = createDispatchObservers({
      listAgents: () => [],
      now: () => new Date(Date.parse(entry.startedAt) + LISTING_GRACE_MS - 1000),
    });
    expect(await observers[DISPATCH_EFFECT](entry, { handle: 'sess-live' })).toMatchObject({ status: 'running' });
  });

  it('an `unresolved` answer WRITES NOTHING — the entry stays in-flight and is reported for a person', async () => {
    const run = {
      v: 1, id: 'run-obs', op: DISPATCH_LANE_OP, input: {}, cursor: 2, findings: {}, verdict: null, pending: null,
      effects: [{
        key: 'run-obs#2#0', stepIndex: 2, step: 'dispatch', index: 0, type: DISPATCH_EFFECT,
        payload: {}, idempotent: false, dispatch: true, status: 'in-flight', handle: 'sess-live',
        startedAt: '2026-08-13T10:00:00.000Z', expectedBy: null, result: null, error: null,
      }],
    };
    const observers = createDispatchObservers({ listAgents: () => [], now: later });
    const out = await observeRun(run, { observers, now: later() });
    expect(out.resolved).toEqual([]);
    expect(out.unresolved).toHaveLength(1);
    expect(out.run.effects[0].status).toBe('in-flight');
  });

  it('reads the session list ONCE per pass, however many entries it is asked about', async () => {
    // The read sits synchronously inside a waker pass that touches every parked run; one subprocess per entry
    // would multiply a slow `claude` by the size of the store.
    let calls = 0;
    const observers = createDispatchObservers({ listAgents: () => { calls += 1; return [{ sessionId: 'sess-live' }]; }, now: later });
    await observers[DISPATCH_EFFECT](entry, { handle: 'sess-live' });
    await observers[DISPATCH_EFFECT](entry, { handle: 'sess-live' });
    expect(calls).toBe(1);
  });

  it('does NOT memoize a failed read — a transient fault must not poison the rest of the pass', async () => {
    let calls = 0;
    const observers = createDispatchObservers({
      listAgents: () => { calls += 1; if (calls === 1) throw new Error('claude timed out'); return [{ sessionId: 'sess-live' }]; },
      now: later,
    });
    await expect(observers[DISPATCH_EFFECT](entry, { handle: 'sess-live' })).rejects.toThrow(/timed out/);
    expect(await observers[DISPATCH_EFFECT](entry, { handle: 'sess-live' })).toMatchObject({ status: 'running' });
  });

  it('refuses a listing that is not an array rather than reading it as "gone"', async () => {
    const observers = createDispatchObservers({ listAgents: () => ({}), now: later });
    await expect(observers[DISPATCH_EFFECT](entry, { handle: 'sess-live' })).rejects.toThrow(/did not return an array/);
  });

  it('an entry with NO item id never reaches the PR axis — no `gh` is shelled for something it cannot look up', async () => {
    // Every case above rides this: their fixture carries no payload, so the whole PR axis is skipped and the
    // liveness behaviour they assert is the whole behaviour. If that stopped being true they would be
    // exercising a different code path than the one they name.
    const observers = createDispatchObservers({
      listAgents: () => [{ sessionId: 'sess-live' }],
      listPrs: () => { throw new Error('must not be read'); },
      now: later,
    });
    expect(await observers[DISPATCH_EFFECT](entry, { handle: 'sess-live' })).toMatchObject({ status: 'running' });
  });
});

// ── 6b. #x9ylkp7 — the PR axis, the ONLY one that can reach `succeeded` ──────────────────────────────────────
//
// `claude agents --json` reports LIVENESS, so section 6's observer could answer `running` or `unresolved` and
// nothing else: a finished build was re-reported on every waker pass and, past `STUCK_ESCALATION_HOURS`, made
// the waker exit non-zero forever until a person closed it out. The completion signal exists elsewhere — the
// agent's PR — and this is the axis that reads it. ONE classification resolves: `merged`.

describe('observing a dispatched agent — the PR axis', () => {
  const STARTED = '2026-08-13T10:00:00.000Z';
  const later = () => new Date('2026-08-13T11:00:00.000Z');
  /** An in-flight entry that CARRIES an item id, which is what makes the PR axis reachable at all. */
  const entryFor = (num = '3095', startedAt = STARTED) => ({
    key: 'k', type: DISPATCH_EFFECT, handle: 'sess-live', startedAt, payload: { num, lane: 3 },
  });
  const pr = (over = {}) => ({ number: 1247, headRefName: 'lane/3095-give-the-observer-a-signal', state: 'OPEN', mergedAt: null, labels: [], ...over });
  const merged = (mergedAt = '2026-08-13T10:45:00.000Z') => pr({ state: 'MERGED', mergedAt });
  /** No live session — so anything but the PR axis lands on today's `unresolved`. */
  const observe = (listPrs, { listAgents = () => [] } = {}) => createDispatchObservers({ listAgents, listPrs, now: later });

  it('a MERGED PR resolves the entry `succeeded`, and names the evidence it resolved on', async () => {
    const answer = await observe(() => [merged()])[DISPATCH_EFFECT](entryFor(), { handle: 'sess-live' });
    expect(answer.status).toBe('succeeded');
    // `observeRun` REFUSES a `succeeded` carrying an error, so the absence of one is part of the contract.
    expect(answer.error ?? null).toBe(null);
    expect(answer.result).toMatchObject({ resolvedBy: 'pr-merged', pr: 1247, mergedAt: '2026-08-13T10:45:00.000Z' });
  });

  it('and the run RECORDS `applied`, so the waker stops re-reporting it on the next pass', async () => {
    // The whole point of the item: `unresolved` writes nothing, so a finished dispatch was re-reported every
    // pass forever. This is the end-to-end proof that it now writes — through the real `observeRun`.
    const run = {
      v: 1, id: 'run-pr', op: DISPATCH_LANE_OP, input: {}, cursor: 2, findings: {}, verdict: null, pending: null,
      effects: [{
        key: 'run-pr#2#0', stepIndex: 2, step: 'dispatch', index: 0, type: DISPATCH_EFFECT,
        payload: { num: '3095' }, idempotent: false, dispatch: true, status: 'in-flight', handle: 'sess-live',
        startedAt: STARTED, expectedBy: null, result: null, error: null,
      }],
    };
    const out = await observeRun(run, { observers: observe(() => [merged()]), now: later() });
    expect(out.unresolved).toEqual([]);
    expect(out.resolved).toEqual([{ key: 'run-pr#2#0', type: DISPATCH_EFFECT, status: 'succeeded', recordedAs: 'applied' }]);
    expect(out.run.effects[0].status).toBe('applied');
    // …and a SECOND pass over the written record finds nothing in flight at all — the re-report is gone.
    const again = await observeRun(out.run, { observers: observe(() => [merged()]), now: later() });
    expect(again.resolved).toEqual([]);
    expect(again.unresolved).toEqual([]);
    expect(again.stillRunning).toEqual([]);
  });

  it('the PR axis runs FIRST — a merged PR resolves even while the session is still listed', async () => {
    // The agent's last act is `pr-land`; it exits some seconds later. Ordering liveness first would report a
    // finished build `running` for as long as the session lingered, i.e. the axis would never fire in the
    // common case.
    const observers = observe(() => [merged()], { listAgents: () => [{ sessionId: 'sess-live', kind: 'background' }] });
    expect(await observers[DISPATCH_EFFECT](entryFor(), { handle: 'sess-live' })).toMatchObject({ status: 'succeeded' });
  });

  it('a CLOSED-unmerged PR is terminal but is NOT success — `unresolved`, and it writes nothing', async () => {
    const answer = await observe(() => [pr({ state: 'CLOSED' })])[DISPATCH_EFFECT](entryFor(), { handle: 'sess-live' });
    expect(answer.status).toBe('unresolved');
    expect(answer.error).toMatch(/CLOSED UNMERGED/);
  });

  it('a PARKED PR is mid-review, not an outcome — `unresolved`', async () => {
    const answer = await observe(() => [pr({ labels: [{ name: 'review:pending' }] })])[DISPATCH_EFFECT](entryFor(), { handle: 'sess-live' });
    expect(answer.status).toBe('unresolved');
    expect(answer.error).toMatch(/PARKED for review/);
  });

  it('neither ambiguous case WRITES — the entry stays in-flight and is reported for a person', async () => {
    for (const p of [pr({ state: 'CLOSED' }), pr({ labels: [{ name: 'review:changes' }] })]) {
      const run = {
        v: 1, id: 'run-amb', op: DISPATCH_LANE_OP, input: {}, cursor: 2, findings: {}, verdict: null, pending: null,
        effects: [{
          key: 'run-amb#2#0', stepIndex: 2, step: 'dispatch', index: 0, type: DISPATCH_EFFECT,
          payload: { num: '3095' }, idempotent: false, dispatch: true, status: 'in-flight', handle: 'sess-live',
          startedAt: STARTED, expectedBy: null, result: null, error: null,
        }],
      };
      const out = await observeRun(run, { observers: observe(() => [p]), now: later() });
      expect(out.resolved).toEqual([]);
      expect(out.unresolved).toHaveLength(1);
      expect(out.run.effects[0].status).toBe('in-flight');
    }
  });

  it('a PREVIOUS attempt\'s merged PR resolves NOTHING — the stale guard, which is the cost of id-matching', async () => {
    // Re-dispatch of one item is a designed path. A predecessor's PR matches the new entry's item id just as
    // well as its own would, and resolving on it would mark a build that has barely begun `applied`.
    const answer = await observe(() => [merged('2026-08-13T09:00:00.000Z')])[DISPATCH_EFFECT](entryFor(), { handle: 'sess-live' });
    expect(answer.status).toBe('unresolved');
    expect(answer.error).toMatch(/PREVIOUS attempt/);
  });

  it('a merge at exactly `startedAt` counts as this attempt\'s — the boundary is inclusive', async () => {
    const answer = await observe(() => [merged(STARTED)])[DISPATCH_EFFECT](entryFor(), { handle: 'sess-live' });
    expect(answer.status).toBe('succeeded');
  });

  it('an entry with NO usable `startedAt` fails CLOSED — nothing can be attributed, so nothing resolves', async () => {
    for (const startedAt of [null, 'not-a-date']) {
      const answer = await observe(() => [merged()])[DISPATCH_EFFECT](entryFor('3095', startedAt), { handle: 'sess-live' });
      expect(answer.status).toBe('unresolved');
    }
  });

  it('NO PR YET behaves exactly as today — the liveness axis answers, both ways', async () => {
    // The dominant case for most of a build's life, and an EMPTY listing is deliberately indistinguishable
    // from "no PR yet": both mean fall through, neither means failure.
    const live = observe(() => [], { listAgents: () => [{ sessionId: 'sess-live' }] });
    expect(await live[DISPATCH_EFFECT](entryFor(), { handle: 'sess-live' })).toMatchObject({ status: 'running' });
    const gone = observe(() => []);
    const answer = await gone[DISPATCH_EFFECT](entryFor(), { handle: 'sess-live' });
    expect(answer.status).toBe('unresolved');
    expect(answer.error).toMatch(/liveness and not outcome/);
  });

  it('a PR belonging to ANOTHER item is not this entry\'s — matched by item id, never by proximity', async () => {
    const others = () => [merged(), pr({ number: 9, headRefName: 'lane/9999-someone-else', state: 'MERGED', mergedAt: '2026-08-13T10:50:00.000Z' })];
    const answer = await observe(others)[DISPATCH_EFFECT](entryFor('9999'), { handle: 'sess-live' });
    expect(answer.status).toBe('succeeded');
    expect(answer.result.pr).toBe(9);
    // …and an item with no PR of its own is not resolved by anybody else's.
    expect(await observe(others)[DISPATCH_EFFECT](entryFor('4242'), { handle: 'sess-live' })).toMatchObject({ status: 'unresolved' });
  });

  it('a `bornAs`-HASH item resolves too — `pr-land` accepts `lane/xNNNNNN-*` and dispatch ids can be hashes', async () => {
    // The brief documents `{{ITEM_NUM}}` as "the backlog item number (or `xNNNNNN` hash)". Before the shared
    // matcher was widened, every hash-identified build was unresolvable by construction.
    const hashPr = pr({ number: 77, headRefName: 'lane/x9ylkp7-completion-signal', state: 'MERGED', mergedAt: '2026-08-13T10:30:00.000Z' });
    const answer = await observe(() => [hashPr])[DISPATCH_EFFECT](entryFor('x9ylkp7'), { handle: 'sess-live' });
    expect(answer).toMatchObject({ status: 'succeeded', result: { pr: 77 } });
  });

  it('a `gh` READ THAT FAILS degrades the axis to OFF and falls through to liveness — it never throws', async () => {
    // Fail-SAFE, in the one direction that matters: the cost is a completed build still needing a person (the
    // status quo), never a running build resolved on no evidence. The lease reaper makes the same trade.
    const observers = observe(() => { throw new Error('gh: not authenticated'); }, { listAgents: () => [{ sessionId: 'sess-live' }] });
    expect(await observers[DISPATCH_EFFECT](entryFor(), { handle: 'sess-live' })).toMatchObject({ status: 'running' });
  });

  it('a `gh` answer that is not an array is no verdict either — junk resolves nothing', async () => {
    const observers = observe(() => ({ message: 'Not Found' }), { listAgents: () => [{ sessionId: 'sess-live' }] });
    expect(await observers[DISPATCH_EFFECT](entryFor(), { handle: 'sess-live' })).toMatchObject({ status: 'running' });
  });

  it('reads the PR list ONCE per pass, however many entries it is asked about', async () => {
    // Same rule as the agent listing: one bounded subprocess per PASS, not one per in-flight entry.
    let calls = 0;
    const observers = observe(() => { calls += 1; return []; }, { listAgents: () => [{ sessionId: 'sess-live' }] });
    await observers[DISPATCH_EFFECT](entryFor(), { handle: 'sess-live' });
    await observers[DISPATCH_EFFECT](entryFor('4242'), { handle: 'sess-live' });
    expect(calls).toBe(1);
  });
});

describe('classifyDispatchPr — the PR axis\'s pure core', () => {
  const STARTED = '2026-08-13T10:00:00.000Z';
  const ref = (headRefName, over = {}) => ({ number: 1, headRefName, state: 'OPEN', mergedAt: null, labels: [], ...over });

  it('the whole classification table, and only `merged` is a resolution', () => {
    const at = (prs) => classifyDispatchPr({ num: '3095', startedAt: STARTED, prs }).verdict;
    expect(at([ref('lane/3095-x', { state: 'MERGED', mergedAt: '2026-08-13T10:30:00.000Z' })])).toBe('merged');
    expect(at([ref('lane/3095-x', { state: 'CLOSED' })])).toBe('closed');
    expect(at([ref('lane/3095-x', { labels: [{ name: 'review:pending' }] })])).toBe('parked');
    expect(at([ref('lane/3095-x')])).toBe('pending');
    expect(at([ref('lane/3095-x', { state: 'MERGED', mergedAt: '2026-08-13T09:00:00.000Z' })])).toBe('stale');
  });

  it('OPEN WINS over an ambiguous terminal — an abandoned PR must not give up on a live one', () => {
    // The same safety `prStatesFromList` applies from the other side (the #2267 data-loss case): among the
    // PRs that survive the stale filter, `merged` resolves, then `pending` keeps waiting, and only then do the
    // ambiguous terminals speak.
    const prs = [ref('lane/3095-abandoned', { state: 'CLOSED' }), ref('lane/3095-current')];
    expect(classifyDispatchPr({ num: '3095', startedAt: STARTED, prs }).verdict).toBe('pending');
    const withMerge = [...prs, ref('lane/3095-landed', { number: 5, state: 'MERGED', mergedAt: '2026-08-13T10:30:00.000Z' })];
    expect(classifyDispatchPr({ num: '3095', startedAt: STARTED, prs: withMerge })).toMatchObject({ verdict: 'merged', pr: { number: 5 } });
  });

  it('no id, no listing, or an unreadable listing → `pending`, which is the word for "this axis has nothing to say"', () => {
    expect(classifyDispatchPr({ num: '', startedAt: STARTED, prs: [ref('lane/3095-x')] }).verdict).toBe('pending');
    expect(classifyDispatchPr({ num: '3095', startedAt: STARTED, prs: null }).verdict).toBe('pending');
    expect(classifyDispatchPr({ num: '3095', startedAt: STARTED, prs: { nope: 1 } }).verdict).toBe('pending');
    expect(classifyDispatchPr({}).verdict).toBe('pending');
  });

  it('normalizes the id the way every other conveyor reader does — `#3095` and `3095` are one item', () => {
    const prs = [ref('lane/3095-x', { state: 'MERGED', mergedAt: '2026-08-13T10:30:00.000Z' })];
    for (const num of ['3095', '#3095', 3095, ' 03095 ']) {
      expect(classifyDispatchPr({ num, startedAt: STARTED, prs }).verdict).toBe('merged');
    }
  });

  it('a `merged` PR with no PARSEABLE merge instant is not attributable — it fails closed, like a missing start', () => {
    const prs = [ref('lane/3095-x', { state: 'MERGED', mergedAt: null })];
    expect(classifyDispatchPr({ num: '3095', startedAt: STARTED, prs }).verdict).toBe('stale');
  });

  it('a head ref that encodes no item is ignored rather than guessed at', () => {
    for (const bad of ['main', 'feature/3095-thing', 'lane/build-3095', null]) {
      expect(classifyDispatchPr({ num: '3095', startedAt: STARTED, prs: [ref(bad, { state: 'MERGED', mergedAt: '2026-08-13T10:30:00.000Z' })] }).verdict).toBe('pending');
    }
  });
});

// ── 7. the reader shells the tick core, and nothing else ────────────────────────────────────────────────────

describe('the tick reader', () => {
  const TICK = {
    decisions: {
      spawnBuilds: [{ num: 3037, lane: 8 }, { num: 42, lane: 9 }],
      suppressedBuilds: [{ num: '0042', lane: 3, by: 'num' }],
      statusLine: 'conveyor · 2 building',
      notes: [{ kind: 'build-ttl', text: '⚠ #99 never claimed' }],
    },
    nextState: { tick: 4 },
  };
  const bindings = {
    runNode: () => JSON.stringify(TICK),
    readText: () => BRIEF,
    loadItems: () => [{ num: '3037', slug: 'declare-dispatch', scope: ['we:scripts/operations/'] }],
    // EVERY process boundary is injected here, including the liveness listing the guard now consults — a test
    // that left this one real would shell `claude` whenever the ambient run store happened to hold an
    // in-flight dispatch.
    listAgents: () => [],
  };

  it('selects this item\'s launch with the tick\'s OWN normalizer, so `#042` and `42` are one item', () => {
    const out = readTick({ num: '#42', ...bindings });
    expect(out.resolvedNum).toBe('42');
    expect(out.launch).toEqual({ num: 42, lane: 9 });
    // …and the same normalizer finds the suppression row spelled with a padded id.
    expect(readTick({ num: '42', ...bindings, runNode: () => JSON.stringify({ decisions: { suppressedBuilds: TICK.decisions.suppressedBuilds } }) }).suppressed)
      .toEqual({ num: '0042', lane: 3, by: 'num' });
  });

  it('reports `bookkeepingSource: none` when no bookkeeping file is named, and pipes `{}` to the core', () => {
    let piped = null;
    const out = readTick({ num: '3037', ...bindings, runNode: (_argv, opts) => { piped = opts.input; return JSON.stringify(TICK); } });
    expect(piped).toBe('{}');
    expect(out.bookkeepingSource).toBe('none');
  });

  it('pipes the caller\'s live bookkeeping to the core when one is named', () => {
    let piped = null;
    const out = readTick({
      num: '3037', ...bindings, bookkeepingFile: '/tmp/bk.json',
      readText: (p) => (p === '/tmp/bk.json' ? '{"bookkeeping":{"tick":3}}' : BRIEF),
      runNode: (_argv, opts) => { piped = opts.input; return JSON.stringify(TICK); },
    });
    expect(piped).toBe('{"bookkeeping":{"tick":3}}');
    expect(out.bookkeepingSource).toBe('file');
    expect(out.nextState).toEqual({ tick: 4 });
  });

  it('DROPS the policy knobs a bookkeeping file can smuggle — config and signals never reach the core', () => {
    // `tick-core`'s shell reads `config` (buildTtlTicks, fixRetryCap, …) and `signals.returnedBuildNums`
    // (which retires live build guards) off the same STDIN. Forwarding the file verbatim would let whoever
    // writes it dial the very holds this operation exists to inherit: `{"config":{"buildTtlTicks":0}}` retires
    // every build guard on the spot and clears a lane that already has an agent on it.
    const forwarded = forwardableBookkeeping('{"bookkeeping":{"tick":3},"config":{"buildTtlTicks":0},"signals":{"returnedBuildNums":["3037"]}}');
    expect(JSON.parse(forwarded.stdin)).toEqual({ bookkeeping: { tick: 3 } });
    expect(forwarded.dropped.sort()).toEqual(['config', 'signals']);
  });

  it('accepts a BARE bookkeeping map too — `nextState` is exactly that shape', () => {
    const forwarded = forwardableBookkeeping('{"tick":3,"buildGuards":[]}');
    expect(JSON.parse(forwarded.stdin)).toEqual({ bookkeeping: { tick: 3, buildGuards: [] } });
    expect(forwarded.dropped).toEqual([]);
  });

  it('refuses an unreadable bookkeeping file rather than dispatching guard-less while claiming otherwise', () => {
    expect(() => forwardableBookkeeping('not json')).toThrow(/not parseable JSON/);
    expect(() => forwardableBookkeeping('[]')).toThrow(/must hold a JSON object/);
  });

  it('does not claim to have dropped what it actually forwarded — a malformed wrapper is a bare map', () => {
    // `{"bookkeeping": 3}` is not a wrapper, so the whole object IS the map and `config` was NOT dropped.
    // Deriving the report independently of the branch made it say otherwise.
    const forwarded = forwardableBookkeeping('{"bookkeeping":3,"config":{"buildTtlTicks":0}}');
    expect(forwarded.dropped).toEqual([]);
    expect(JSON.parse(forwarded.stdin).bookkeeping.config).toEqual({ buildTtlTicks: 0 });
  });

  it('STAMPS the instant the read was taken — the pure half ages its guard against this and has no clock', () => {
    // Without it nothing ever ages out and one completed dispatch locks its item out forever (review F1). The
    // declaration is pure by construction, so the clock can only arrive as data on the read.
    const out = readTick({ num: '3037', ...bindings, now: () => new Date('2026-08-13T10:00:00.000Z') });
    expect(out.observedAt).toBe('2026-08-13T10:00:00.000Z');
    // …and the DEFAULT is the real clock, not a null that would silently disable the aging in production.
    const live = Date.parse(readTick({ num: '3037', ...bindings }).observedAt);
    expect(Math.abs(live - Date.now())).toBeLessThan(60_000);
  });

  it('finds this operation\'s own in-flight dispatches in the run store, and survives one corrupt record', () => {
    const record = (id, num, status) => ({
      id,
      effects: [{
        key: `${id}#2#0`, type: DISPATCH_EFFECT, status, handle: 'sess-x',
        startedAt: '2026-08-13T09:00:00.000Z', expectedBy: '2026-08-13T10:30:00.000Z', payload: { num },
      }],
    });
    const store = {
      list: () => ['a', 'b', 'c', 'd'],
      read: (id) => {
        if (id === 'a') return record('a', 3037, 'in-flight');
        if (id === 'b') return record('b', '0042', 'in-flight'); // a different item, padded spelling
        if (id === 'c') return record('c', 3037, 'applied'); // settled — not in flight
        throw new Error('refusing to read run d — corrupt');
      },
    };
    const out = inFlightDispatchesFor('3037', { store });
    expect(out.runs.map((r) => r.runId)).toEqual(['a']);
    // THE DEADLINE RIDES EACH ROW. It is what `dispatchStillHolds` ages against; dropped, every hold falls back
    // to `startedAt` + the 90-minute estimate and outlives its real window by an hour and a half.
    expect(out.runs[0]).toMatchObject({ startedAt: '2026-08-13T09:00:00.000Z', expectedBy: '2026-08-13T10:30:00.000Z' });
    // Fail-soft per record: one corrupt file must not wedge every dispatch, but the caller is told the guard
    // was partial rather than being handed a confident empty answer.
    expect(out.unreadable).toBe(1);
  });

  // ── PR #1211 round 2, G1 — the guard's PRIMARY axis is liveness, and this is where the answer is read ──────

  it('G1: STAMPS each in-flight record with whether `claude agents` still lists its handle', () => {
    const rows = [
      { runId: 'a', handle: 'sess-live' },
      { runId: 'b', handle: 'sess-gone' },
      { runId: 'c', handle: null }, // INDETERMINATE — no handle exists to ask about
    ];
    const out = stampLiveness({ runs: rows, unreadable: 1 }, { listAgents: () => [{ sessionId: 'sess-live' }] });
    expect(out.runs.map((r) => r.live)).toEqual([true, false, null]);
    expect(out.livenessSource).toBe('claude-agents');
    // The partial-guard count is carried through rather than reset by the pass that adds liveness.
    expect(out.unreadable).toBe(1);
  });

  it('G1: a listing that CANNOT be read degrades to the clock backstop and SAYS SO — it never claims "gone"', () => {
    // Reporting `live: false` here would be the G1 hole again wearing a different hat: an unreadable listing is
    // not evidence a session ended. It has to read as UNKNOWN, and the weaker guard has to be visible.
    const rows = [{ runId: 'a', handle: 'sess-live' }];
    for (const listAgents of [() => { throw new Error('spawnSync claude ETIMEDOUT'); }, () => ({}), undefined]) {
      const out = stampLiveness({ runs: rows, unreadable: 0 }, { listAgents });
      expect(out.runs[0].live).toBeNull();
      expect(out.livenessSource).toBe('unreadable');
    }
  });

  it('G1: asks NOTHING when nothing is in flight — the common path spawns no subprocess', () => {
    let calls = 0;
    const out = stampLiveness({ runs: [], unreadable: 0 }, { listAgents: () => { calls += 1; return []; } });
    expect(calls).toBe(0);
    expect(out.livenessSource).toBe('not-needed');
  });

  it('G1: the READ wires the liveness answer onto the rows the declaration ages against', () => {
    // The seam that matters: `dispatchStillHolds` is pure, so a `live` field that never got stamped would
    // silently put every hold back on the clock — the exact defect round 2 found, one level up.
    const out = readTick({
      num: '3037',
      ...bindings,
      listInFlightDispatches: () => ({ runs: [{ runId: 'a', handle: 'sess-live' }, { runId: 'b', handle: 'sess-x' }], unreadable: 0 }),
      listAgents: () => [{ sessionId: 'sess-live' }],
    });
    expect(out.inFlightDispatches.runs.map((r) => r.live)).toEqual([true, false]);
    expect(out.inFlightDispatches.livenessSource).toBe('claude-agents');
  });

  it('resolves the item\'s spec path and repo-qualified scope from the canonical loader', () => {
    expect(readTick({ num: '3037', ...bindings }).item).toEqual({
      num: '3037', slug: 'declare-dispatch', specPath: 'backlog/3037-declare-dispatch.md', scope: ['we:scripts/operations/'],
    });
  });

  it('a tick that cannot be read is a refusal, never an empty plan that would look like "nothing to dispatch"', () => {
    expect(() => readTick({ num: '3037', ...bindings, runNode: () => { throw new Error('conveyor-state failed'); } }))
      .toThrow(/could not read the conveyor tick/);
  });

  it('refuses an id that normalizes to nothing', () => {
    expect(() => readTick({ num: '  ', ...bindings })).toThrow(/must be an item id/);
  });
});


// ── 8. #3165 — a PLANNED PREPARE is DISPATCHED, not merely surfaced ─────────────────────────────────────────
//
// THE DEFECT THIS SECTION PINS. `planTick` returns three launch lists; the operation launched one. So an item
// the planner put in `spawnPrepareScope` — the operator sees it every tick as `⚠ N auto-preparing scope: #NNN`
// — came back from `dispatch-lane --num=<it>` as "not in `decisions.spawnBuilds`", forever. The spawner was
// called ZERO times, which is why every case below counts the calls rather than inspecting a verdict: the
// verdict was always honest about not dispatching. Nothing was dispatched.
//
// EVERY CASE HERE GOES THROUGH THE REAL `readTick` AND THE REAL BRIEFS ON DISK. A stub read that hands the
// declaration a `launchKind` proves only that the declaration honours one; the whole gap was in the shell,
// between the core's three lists and the one the reader looked at. Only the spawner is stubbed.

describe('#3165: the planner\'s prepare lists reach the spawner', () => {
  /** A tick as the core returns one, with the asked item in exactly ONE of the three launch lists. */
  function tickWith(list, row) {
    return {
      decisions: {
        spawnBuilds: [], spawnPrepareScope: [], spawnPrepareDecision: [],
        suppressedBuilds: [], statusLine: 'conveyor · 1 preparing', notes: [],
        [list]: [row],
      },
      // The guards the core recorded for the SAME plan. Both prepare kinds live in ONE `prepareGuards` list
      // keyed by `kind`, and a sibling rides along so "picked the matching one" is a real assertion.
      nextState: {
        tick: 4,
        buildGuards: [{ num: '3037', lane: 8, spawnedTick: 3 }],
        prepareGuards: [
          { num: '3150', kind: 'prepare', lane: 5, spawnedTick: 3, sawPr: false },
          { num: '3150', kind: 'prepare-decision', lane: 6, spawnedTick: 3, sawPr: false },
          { num: '9999', kind: 'prepare', lane: 7, spawnedTick: 3, sawPr: false },
        ],
      },
    };
  }

  /** An UNSCOPED held item — no `scope:` frontmatter at all, which is exactly why a prepare is planned for it. */
  const UNSCOPED = { num: '3150', slug: 'an-unscoped-held-item' };
  const SPEC_PATH = 'backlog/3150-an-unscoped-held-item.md';
  /** A scoped item, for the build case. */
  const SCOPED = { num: '3037', slug: 'declare-dispatch', scope: ['we:scripts/operations/'] };

  /**
   * ONE WHOLE DISPATCH — the real `readTick`, the real declaration, the real sink, the real brief files, and a
   * STUB SPAWNER that records what it was handed and starts nothing.
   *
   * Every process boundary except the spawner is injected: `runNode` returns the given tick instead of running
   * the core, `loadItems` returns the given item instead of loading the backlog, and the two listings are
   * stubbed so no ambient run record can make this shell `claude`. `readText` is the REAL `readFileSync`, so
   * the brief under assertion is the one that ships.
   */
  async function dispatchThrough({ num, tick, items }) {
    const spawned = [];
    const registry = createRegistry();
    registry.register(dispatchLaneOperation({
      readTick: (asked) => readTick({
        ...asked,
        runNode: () => JSON.stringify(tick),
        readText: (path) => readFileSync(path, 'utf8'),
        loadItems: () => items,
        listInFlightDispatches: () => ({ runs: [], unreadable: 0 }),
        listAgents: () => [],
      }),
    }));
    const run = advanceWhileRunning(startRun({ op: DISPATCH_LANE_OP, id: `run-${num}`, input: { num }, registry }), { registry });
    // A NON-DISPATCH declares ZERO effects and the run COMPLETES — there is nothing to apply, and asking the
    // executor to apply nothing is itself an error. So the spawner stays untouched and the count stays 0,
    // which is the honest reading of "nothing was started".
    if (!run.effects.length) return { run, spawned };
    const outcome = await applyPendingEffects(run, {
      sinks: createDispatchSinks({
        root: PRIMARY,
        spawnAgent: (argv, opts) => { spawned.push({ argv, opts }); return ''; },
        mintSessionId: () => 'sess-3165',
        now: () => new Date(NOW),
      }),
      store: createMemoryRunStore(),
    });
    return { run: outcome.run, spawned };
  }

  /** The brief a kind SHOULD produce, filled from the file on disk — byte-exact, so it cannot drift. */
  function expectedPrompt(kind, values) {
    return fillBrief(readFileSync(briefPath(REPO_ROOT, kind), 'utf8'), values).prompt;
  }

  // ── criterion 1 ──────────────────────────────────────────────────────────────────────────────────────────
  it('a `spawnPrepareScope` entry SPAWNS ONCE, with the scope-prep brief — it spawned zero times before', async () => {
    const { run, spawned } = await dispatchThrough({
      num: '3150', tick: tickWith('spawnPrepareScope', { num: '3150', lane: 5 }), items: [UNSCOPED],
    });
    // THE WHOLE DEFECT, in one number.
    expect(spawned).toHaveLength(1);
    expect(run.verdict).toMatchObject({ dispatching: true, launchKind: 'prepare', lane: 5, sessionSlug: 'prepare-3150' });
    // …and it is the SCOPE-PREP mandate, byte-for-byte the file on disk with this item's five values in it —
    // not the 39 KB delivery brief, which would tell it to build an item whose scope nobody has written.
    const prompt = spawned[0].argv[spawned[0].argv.length - 1];
    expect(prompt).toBe(expectedPrompt('prepare', {
      ITEM_NUM: '3150', ITEM_SPEC_PATH: SPEC_PATH, LANE: 5, SESSION_SLUG: 'prepare-3150', SCOPE: `we:${SPEC_PATH}`,
    }));
    expect(prompt).toContain('--purpose=conveyor-prepare-scope');
    // criterion 5 (guard half) — the guard stamped is the PREPARE one for this num AND this kind, out of a
    // `prepareGuards` list holding a second kind for the same num and a sibling item.
    expect(run.findings.read.dispatchedGuard).toEqual({ num: '3150', kind: 'prepare', lane: 5, spawnedTick: 3, sawPr: false });
  });

  // ── criterion 2 ──────────────────────────────────────────────────────────────────────────────────────────
  it('a `spawnPrepareDecision` entry SPAWNS ONCE, with the decision-prep brief', async () => {
    // `spawnPrepareDecision` is the planner's PUBLIC key (`tick-core.mjs` §planTick's return). `decisionSpawns`
    // is `planPrepareSpawns`'s internal local and appears nowhere on `decisions` — searching for it is how the
    // consumers of these lists got missed in the first place.
    const { run, spawned } = await dispatchThrough({
      num: '3150', tick: tickWith('spawnPrepareDecision', { num: '3150', lane: 6 }), items: [UNSCOPED],
    });
    expect(spawned).toHaveLength(1);
    expect(run.verdict).toMatchObject({ dispatching: true, launchKind: 'prepare-decision', lane: 6, sessionSlug: 'prepare-decision-3150' });
    const prompt = spawned[0].argv[spawned[0].argv.length - 1];
    expect(prompt).toBe(expectedPrompt('prepare-decision', {
      ITEM_NUM: '3150', ITEM_SPEC_PATH: SPEC_PATH, LANE: 6, SESSION_SLUG: 'prepare-decision-3150', SCOPE: `we:${SPEC_PATH}`,
    }));
    expect(prompt).toContain('--purpose=conveyor-prepare-decision');
    expect(run.findings.read.dispatchedGuard).toEqual({ num: '3150', kind: 'prepare-decision', lane: 6, spawnedTick: 3, sawPr: false });
  });

  // ── criterion 3 ──────────────────────────────────────────────────────────────────────────────────────────
  it('a BUILD is byte-identical to before — the same brief, the same slug, the same argv', async () => {
    // The additive claim, TESTED rather than asserted in a comment. If any of these three moved, every caller
    // that predates #3165 changed behaviour, and the card's "it can land before anything that depends on it"
    // stops being true.
    const { run, spawned } = await dispatchThrough({
      num: '3037', tick: tickWith('spawnBuilds', { num: '3037', lane: 8 }), items: [SCOPED],
    });
    expect(spawned).toHaveLength(1);
    expect(run.verdict).toMatchObject({ dispatching: true, launchKind: 'build', lane: 8, sessionSlug: 'conveyor-3037' });
    expect(run.verdict.reason).toBe('cleared for build on lane 8');
    expect(briefPath(REPO_ROOT)).toBe(briefPath(REPO_ROOT, 'build'));
    expect(briefPath(REPO_ROOT)).toMatch(/skills-src\/conveyor\/delivery-agent-brief\.md$/);
    // THE ARGV IS THE CONTRACT, and it is pinned whole — the prompt is the delivery brief filled with the
    // item's OWN `scope:` frontmatter, not the one-file prepare scope.
    expect(spawned[0].argv).toEqual([
      '--bg', '--session-id', 'sess-3165', '-n', 'conveyor-3037',
      expectedPrompt('build', {
        ITEM_NUM: '3037', ITEM_SPEC_PATH: 'backlog/3037-declare-dispatch.md', LANE: 8,
        SESSION_SLUG: 'conveyor-3037', SCOPE: 'we:scripts/operations/',
      }),
    ]);
    expect(run.findings.read.scope).toEqual(['we:scripts/operations/']);
  });

  // ── criterion 4 ──────────────────────────────────────────────────────────────────────────────────────────
  it('an UNKNOWN kind THROWS on both halves — it never falls back to the delivery brief', () => {
    // The silent fallback is the failure being guarded: a scope-prep agent handed the delivery mandate is told
    // to BUILD an item whose scope is precisely what it was dispatched to write. It would acquire a lane, read
    // an empty scope, and improvise.
    for (const bogus of ['prepare-scope', 'Prepare', 'delivery', '', 'toString', '__proto__']) {
      expect(() => briefPath(REPO_ROOT, bogus), `briefPath(${JSON.stringify(bogus)})`).toThrow(/no agent brief for kind/);
    }
    // …and the pure half refuses a reader that hands it one, rather than shaping a read around it.
    expect(() => shapeDispatchRead(tickRead({ launchKind: 'prepare-scope' }), { num: '3037' }))
      .toThrow(/unknown `launchKind`/);
    // The five that ARE wired all resolve, and to five DISTINCT files — one map entry pointing at the wrong
    // brief is the same failure with a quieter face.
    const paths = LAUNCH_KINDS.map((k) => briefPath(REPO_ROOT, k));
    expect(new Set(paths).size).toBe(5);
    for (const path of paths) expect(readFileSync(path, 'utf8').trim()).not.toBe('');
  });

  // ── criterion 5 ──────────────────────────────────────────────────────────────────────────────────────────
  it('an item with NO `scope:` dispatches as a prepare, and declares the ONE-FILE lane scope `we:<specPath>`', async () => {
    // THE CASE A NAIVE CHANGE FAILS HARDEST. `dispatch-lane.mjs`'s unscoped refusal sits directly in the path,
    // and it is BUILD-ONLY for a reason one word obscured: it tests the backlog item's `scope:` FRONTMATTER —
    // the very thing a prepare-scope agent is dispatched to write. A prepare never needs it. The lane-lease
    // `--scope` is a different value from a different source: the item's own backlog file, per
    // `we:skills-src/conveyor/SKILL.md:272` and the `acquire` both prepare briefs already run.
    expect(UNSCOPED.scope).toBeUndefined();
    const { run, spawned } = await dispatchThrough({
      num: '3150', tick: tickWith('spawnPrepareScope', { num: '3150', lane: 5 }), items: [UNSCOPED],
    });
    expect(spawned).toHaveLength(1);
    expect(run.findings.read.scope).toEqual([`we:${SPEC_PATH}`]);
    expect(run.effects[0].payload.scope).toEqual([`we:${SPEC_PATH}`]);
    // ONE file — a prepare lane that declared a directory would stop being "disjoint by construction".
    expect(run.effects[0].payload.scope).toHaveLength(1);
    // …while the build path keeps the refusal, unweakened: an unscoped item routed as a BUILD still throws.
    expect(() => shapeDispatchRead(
      tickRead({ launchKind: 'build', item: { num: '3150', slug: 'x', specPath: SPEC_PATH, scope: [] } }),
      { num: '3150' },
    )).toThrow(/never launches an unscoped item to build/);
  });

  it('the whole plan is not dispatched — ONE call starts ONE agent, never the tick\'s other planned prepares', async () => {
    // The tick plans every prepare it can; this operation executes exactly one of them. A loop here would put a
    // second scheduler in front of the one that already decides multiplicity.
    const tick = tickWith('spawnPrepareScope', { num: '3150', lane: 5 });
    tick.decisions.spawnPrepareScope.push({ num: '9999', lane: 7 });
    const { spawned } = await dispatchThrough({ num: '3150', tick, items: [UNSCOPED, { num: '9999', slug: 'other' }] });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].argv[4]).toBe('prepare-3150');
  });

  it('a num in NO list still says so, and now names all three', async () => {
    const { run, spawned } = await dispatchThrough({
      num: '3150', tick: tickWith('spawnBuilds', { num: '3037', lane: 8 }), items: [UNSCOPED],
    });
    expect(spawned).toEqual([]);
    expect(run.verdict.dispatching).toBe(false);
    expect(run.verdict.reason).toMatch(/spawnPrepareScope/);
    expect(run.verdict.reason).toMatch(/spawnPrepareDecision/);
    // …and it reports WHICH agent was asked for, so a run record of a declined prepare is not mistakable for a
    // declined build.
    expect(run.verdict.launchKind).toBe('build');
  });
});

// ── #3383: fix / ci-heal launch kinds — mechanizing SKILL.md §3c's manual "you EXECUTE" step ──────────────────

const FIX_BRIEF = [
  '# fix brief for #{{ITEM_NUM}}',
  'pr: {{PR_NUM}}',
  'ref: {{LANE_REF}}',
  'lane: {{LANE}}',
  'session: {{SESSION_SLUG}}',
  'scope: {{SCOPE}}',
].join('\n');

const CI_HEAL_BRIEF = `${FIX_BRIEF}\nreason: {{REASON}}`;

/** A `readTick`-shaped raw read for a `fix`/`ci-heal` launch — mirrors `tickRead()` above, but with a `pr` on
 * the launch row (never `itemSpecPath`-shaped) and the io-fetched `prHeadRef` alongside it. */
function tickReadFor(kind, overrides = {}) {
  const launch = { num: '3037', lane: 8, pr: 701, ...(kind === 'ci-heal' ? { reason: 'red-ci' } : {}), ...overrides.launch };
  return tickRead({
    launchKind: kind,
    launch,
    briefTemplate: kind === 'ci-heal' ? CI_HEAL_BRIEF : FIX_BRIEF,
    prHeadRef: 'lane/3037-declare-dispatch',
    dispatchedGuard: { num: '3037', pr: 701, lane: 8, spawnedTick: 0 },
    ...overrides,
    launch,
  });
}

describe('#3383 — sessionSlugFor / fillBrief / BRIEF_PLACEHOLDERS_BY_KIND widen for fix/ci-heal', () => {
  it('sessionSlugFor mints fix-<num> and ci-heal-<num>, distinct from every other kind', () => {
    expect(sessionSlugFor('701', 'fix')).toBe('fix-701');
    expect(sessionSlugFor('701', 'ci-heal')).toBe('ci-heal-701');
    expect(new Set(['build', 'prepare', 'prepare-decision', 'fix', 'ci-heal'].map((k) => sessionSlugFor('701', k))).size).toBe(5);
  });

  it('BRIEF_PLACEHOLDERS_BY_KIND: fix has no ITEM_SPEC_PATH, gains PR_NUM + LANE_REF; ci-heal adds REASON on top', () => {
    expect(BRIEF_PLACEHOLDERS_BY_KIND.fix).toEqual(FIX_BRIEF_PLACEHOLDERS);
    expect(FIX_BRIEF_PLACEHOLDERS).not.toContain('ITEM_SPEC_PATH');
    expect(FIX_BRIEF_PLACEHOLDERS).toEqual(expect.arrayContaining(['PR_NUM', 'LANE_REF']));
    expect(BRIEF_PLACEHOLDERS_BY_KIND['ci-heal']).toEqual(CI_HEAL_BRIEF_PLACEHOLDERS);
    expect(CI_HEAL_BRIEF_PLACEHOLDERS).toEqual([...FIX_BRIEF_PLACEHOLDERS, 'REASON']);
    expect(BRIEF_PLACEHOLDERS_BY_KIND.build).toBe(BRIEF_PLACEHOLDERS);
  });

  it('fillBrief with an explicit placeholder list fills a fix-shaped brief and ignores an unsupplied ITEM_SPEC_PATH', () => {
    const { prompt, unknownTokens } = fillBrief(FIX_BRIEF, {
      ITEM_NUM: '3037', PR_NUM: '701', LANE_REF: 'lane/3037-x', LANE: '8', SESSION_SLUG: 'fix-3037', SCOPE: 'we:scripts/',
    }, FIX_BRIEF_PLACEHOLDERS);
    expect(prompt).toContain('pr: 701');
    expect(prompt).toContain('ref: lane/3037-x');
    expect(unknownTokens).toEqual([]);
  });

  it('fillBrief still refuses a fix fill missing PR_NUM, even though the DEFAULT (build) placeholder list never asked for it', () => {
    expect(() => fillBrief(FIX_BRIEF, {
      ITEM_NUM: '3037', LANE_REF: 'lane/3037-x', LANE: '8', SESSION_SLUG: 'fix-3037', SCOPE: 'we:scripts/',
    }, FIX_BRIEF_PLACEHOLDERS)).toThrow(/no value for the brief placeholder \{\{PR_NUM\}\}/);
  });
});

describe('#3383 — shapeDispatchRead dispatches a fix/ci-heal exactly as it dispatches a build', () => {
  it('a fix launch: PR_NUM/LANE_REF fill from launch.pr/raw.prHeadRef, scope is the ITEM\'s own (build-shaped, not we:<specPath>)', () => {
    const v = shapeDispatchRead(tickReadFor('fix'), { num: '3037' });
    expect(v.dispatching).toBe(true);
    expect(v.launchKind).toBe('fix');
    expect(v.pr).toBe(701);
    expect(v.prHeadRef).toBe('lane/3037-declare-dispatch');
    expect(v.sessionSlug).toBe('fix-3037');
    expect(v.scope).toEqual(['we:scripts/operations/']); // the ITEM's own scope: frontmatter — see tickRead()
    expect(v.prompt).toContain('pr: 701');
    expect(v.prompt).toContain('ref: lane/3037-declare-dispatch');
    expect(v.prompt).toContain('session: fix-3037');
  });

  it('a ci-heal launch: REASON fills from launch.reason too, and PR_NUM/LANE_REF work the same as fix', () => {
    const v = shapeDispatchRead(tickReadFor('ci-heal', { launch: { reason: 'behind' } }), { num: '3037' });
    expect(v.dispatching).toBe(true);
    expect(v.launchKind).toBe('ci-heal');
    expect(v.sessionSlug).toBe('ci-heal-3037');
    expect(v.prompt).toContain('reason: behind');
  });

  it('build/prepare kinds are untouched: `pr` and `prHeadRef` are null on their verdict', () => {
    const v = shapeDispatchRead(tickRead(), { num: '3037' });
    expect(v.dispatching).toBe(true);
    expect(v.launchKind).toBe('build');
    expect(v.pr).toBeNull();
    expect(v.prHeadRef).toBeNull();
  });

  it('a fix/ci-heal launch with no `pr` on the row REFUSES rather than dispatching without one', () => {
    expect(() => shapeDispatchRead(tickReadFor('fix', { launch: { pr: undefined } }), { num: '3037' }))
      .toThrow(/named no PR/);
  });

  it('a fix/ci-heal launch with no `raw.prHeadRef` REFUSES — the brief cannot reconstitute onto nothing', () => {
    expect(() => shapeDispatchRead(tickReadFor('fix', { prHeadRef: null }), { num: '3037' }))
      .toThrow(/no head ref resolved/);
  });

  it('a ci-heal launch with no `launch.reason` REFUSES — the durable comment needs to say why it fired', () => {
    expect(() => shapeDispatchRead(tickReadFor('ci-heal', { launch: { reason: undefined } }), { num: '3037' }))
      .toThrow(/named no reason/);
  });

  it('a fix/ci-heal item with no `scope:` REFUSES exactly like an unscoped build does', () => {
    const raw = tickReadFor('fix', { item: { num: '3037', slug: 'x', specPath: 'backlog/3037-x.md', scope: [] } });
    expect(() => shapeDispatchRead(raw, { num: '3037' })).toThrow(/no `scope:`/);
  });
});

describe('#3383 — ITEM_SCOPED_LAUNCH_KINDS / PR_REPAIR_LAUNCH_KINDS are the exact, disjoint-by-role partitions LAUNCH_KINDS implies', () => {
  it('every LAUNCH_KIND is scoped by the item OR by its own spec path — never neither, never both', () => {
    for (const kind of LAUNCH_KINDS) {
      const itemScoped = ITEM_SCOPED_LAUNCH_KINDS.includes(kind);
      const specScoped = kind === 'prepare' || kind === 'prepare-decision';
      expect(itemScoped || specScoped).toBe(true);
      expect(itemScoped && specScoped).toBe(false);
    }
  });

  it('PR_REPAIR_LAUNCH_KINDS is exactly {fix, ci-heal} — the two kinds that reconstitute from an existing PR ref', () => {
    expect([...PR_REPAIR_LAUNCH_KINDS].sort()).toEqual(['ci-heal', 'fix']);
  });
});
