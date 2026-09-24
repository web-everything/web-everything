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

import { describe, it, expect, vi } from 'vitest';
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
  BRIEF_VALUE_RE,
  BRIEF_REQUIRED_BY_KIND,
  BRIEF_TOKEN_RE,
  DEFAULT_EXPECTED_WITHIN_MINUTES,
  DISPATCH_EFFECT,
  DISPATCH_HOLD_GRACE_MINUTES,
  DISPATCH_LANE_OP,
  DISPATCH_LISTING_GRACE_MINUTES,
  LAUNCH_KINDS,
  OPTIONAL_BRIEF_PLACEHOLDERS,
  attemptTagFor,
  canonicalPlaceholder,
  dispatchLaneOperation,
  DISPATCH_GUARD_LISTING_GRACE_MINUTES,
  dispatchStillHolds,
  fillBrief,
  REPO_AWARE_VALUE_PATTERNS,
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
  defaultClaudeProvider,
  DISPATCHED_AGENT_SYSTEM_PROMPT_FILE,
  REPO_ROOT,
  defaultLaneRefForPr,
  forwardableBookkeeping,
  inFlightDispatchesFor,
  isPreSpawnRefusal,
  readTick,
  stampLiveness,
  // #3457/#3460 — the already-done ground-truth check.
  ALREADY_DONE_JSON_FIELDS,
  ALREADY_DONE_SEARCH_LIMIT,
  defaultCheckAlreadyDone,
  filterAlreadyDoneCandidates,
  NON_IMPLEMENTING_REF_RE,
  // #3462 — the manual dispatch path's `blockedBy` awareness.
  findItem,
  // #xu2krte — resume-or-fresh dispatch.
  parseBackgroundedId,
  resumeSucceeded,
  // #3637 — the POC delivery target.
  resolveDeliveryBase,
  // #x8mpubm follow-up — the spawn-env credential hygiene.
  defaultSpawnAgent,
} from '../dispatch-lane-io.mjs';
// #3960 — the repo-aware brief quintet.
import { briefTokensForRepo } from '../../lib/repo-profile.mjs';

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
  const VALUES = { ITEM_NUM: '3037', ITEM_SPEC_PATH: 'backlog/3037-x.md', LANE: 8, SESSION_SLUG: 'conveyor-3037', SCOPE: 'we:a,we:b', DELIVERY_BASE: 'main' };

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
    // Not one of the five remains, and neither does #3110's `{{ATTEMPT_TAG}}` — it is a REQUIRED-BUT-OPTIONAL
    // name for a `build` fill (`BRIEF_REQUIRED_BY_KIND.build`), so with no value supplied it substitutes as
    // `''` (a legitimate first-attempt blank), never left as a literal token or reported as unknown. Only the
    // ones the template talks ABOUT (doc prose, not real placeholders) are reported, never fatal.
    for (const name of ['ITEM_NUM', 'ITEM_SPEC_PATH', 'LANE', 'SESSION_SLUG', 'SCOPE', 'ATTEMPT_TAG']) {
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
    //
    // `BRIEF_REQUIRED_BY_KIND.build`, NOT the full `BRIEF_PLACEHOLDERS` (#3332 widened the latter to also cover
    // `PR_NUM`/`LANE_REF`/`REASON`, none of which the DELIVERY brief this test reads ever carries) — this test
    // is specifically about the build brief's own five, same as before #3332.
    const real = readFileSync(briefPath(), 'utf8');
    for (const name of BRIEF_REQUIRED_BY_KIND.build) {
      expect(real, `the brief must actually use {{${name}}}`).toContain(`{{${name}}}`);
      const typod = real.replace(`{{${name}}}`, `{{ ${name} }}`);
      expect(() => fillBrief(typod, VALUES), `a typo'd {{${name}}} must not reach an agent`).toThrow(/MISSPELLED placeholder/);
    }
    // …including the spellings round 1's narrower scan could not see at all (round 2, G4).
    for (const name of BRIEF_REQUIRED_BY_KIND.build) {
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

  it('#x8mpubm — resolveSettingsEnv is called once per dispatch and its result reaches the real argv via --settings', async () => {
    const { run } = runTo();
    const store = createMemoryRunStore();
    let seenArgv = null;
    const resolveSettingsEnv = vi.fn(() => ({ PATH: '/shim:/usr/bin' }));
    const sinks = createDispatchSinks({
      root: PRIMARY,
      spawnAgent: (argv) => { seenArgv = argv; return ''; },
      mintSessionId: () => 'sess-shim',
      resolveSettingsEnv,
    });
    await applyPendingEffects(run, { sinks, store });
    expect(resolveSettingsEnv).toHaveBeenCalledTimes(1);
    // #x8mpubm follow-up — called WITH the dispatch's own root, so the durable settings.local.json delivery
    // path (gh-app-shim.mjs#ensureSettingsFileEnv) knows which checkout to write into.
    expect(resolveSettingsEnv).toHaveBeenCalledWith(PRIMARY);
    expect(seenArgv).toContain('--settings');
    expect(seenArgv[seenArgv.indexOf('--settings') + 1]).toBe(JSON.stringify({ env: { PATH: '/shim:/usr/bin' } }));
  });

  it('#x8mpubm — resolveSettingsEnv returning null (the real default, unconfigured host) emits no --settings at all', async () => {
    const { run } = runTo();
    const store = createMemoryRunStore();
    let seenArgv = null;
    const sinks = createDispatchSinks({
      root: PRIMARY,
      spawnAgent: (argv) => { seenArgv = argv; return ''; },
      mintSessionId: () => 'sess-noshim',
      resolveSettingsEnv: () => null,
    });
    await applyPendingEffects(run, { sinks, store });
    expect(seenArgv).not.toContain('--settings');
  });

  it('#x8mpubm follow-up — defaultSpawnAgent strips GH_TOKEN/GITHUB_TOKEN from the exec env, never lets them leak into the claude front-end invocation', () => {
    let seenOpts = null;
    const exec = (cmd, args, opts) => { seenOpts = opts; return ''; };
    const priorEnv = process.env;
    try {
      process.env = { ...priorEnv, GH_TOKEN: 'ghs_daemon_own_token', GITHUB_TOKEN: 'also_should_go', OTHER_VAR: 'kept' };
      defaultSpawnAgent(['--bg'], {}, { exec });
    } finally {
      process.env = priorEnv;
    }
    expect(seenOpts.env).toBeDefined();
    expect(seenOpts.env.GH_TOKEN).toBeUndefined();
    expect(seenOpts.env.GITHUB_TOKEN).toBeUndefined();
    expect(seenOpts.env.OTHER_VAR).toBe('kept'); // everything else still passes through
  });

  it('PR #2600 review:changes — a caller-supplied opts.env is SANITIZED too, never allowed to replace the stripped env', () => {
    // The exact shape `deliver-item-wrapper.mjs` passes: `env: { ...process.env, ...deliveryEnv }`.
    let seenOpts = null;
    const exec = (cmd, args, opts) => { seenOpts = opts; return ''; };
    defaultSpawnAgent(['--bg'], { env: { GH_TOKEN: 'ghs_daemon_own_token', GITHUB_TOKEN: 'x', DELIVERY_VAR: 'kept' } }, { exec });
    expect(seenOpts.env.GH_TOKEN).toBeUndefined();
    expect(seenOpts.env.GITHUB_TOKEN).toBeUndefined();
    expect(seenOpts.env.DELIVERY_VAR).toBe('kept'); // the caller's own env is still what the child gets
  });

  it('#x8mpubm follow-up — an explicit opts.cwd from the caller is preserved alongside the stripped env', () => {
    let seenOpts = null;
    const exec = (cmd, args, opts) => { seenOpts = opts; return ''; };
    defaultSpawnAgent(['--bg'], { cwd: '/some/lane' }, { exec });
    expect(seenOpts.cwd).toBe('/some/lane');
  });
});

// ── 5. the sink's argv IS the contract with the CLI ─────────────────────────────────────────────────────────

describe('what the sink actually runs', () => {
  const payload = { num: '3037', sessionSlug: 'conveyor-3037', prompt: '# build #3037' };

  it('#3331 — does NOT pass --session-id, because `claude --bg` discards it', () => {
    // This assertion is INVERTED from what it said before #3331 ("pins the handle with --session-id instead of
    // racing to discover it"). The real CLI answers `warning: --bg manages the session id; ignoring
    // --session-id` and assigns its own — measured 3/3 at 2.1.246 by #3331's probe, 2/2 at 2.1.269 with the
    // real dispatch argv. Passing it bought nothing and encoded a false premise the rest of the file read as
    // fact; the handle now comes from the id the CLI prints (`parseBackgroundedId`).
    const argv = buildAgentArgv({ sessionId: 'sess-c3', payload });
    expect(argv).toEqual(['--bg', '-n', 'conveyor-3037', '# build #3037']);
    expect(argv).not.toContain('--session-id');
    expect(argv).not.toContain('sess-c3');
  });

  it('#xqyyoje — appends --append-system-prompt-file only when the caller passes one, ahead of extraArgs', () => {
    expect(buildAgentArgv({ sessionId: 'sess-c3', payload })).not.toContain('--append-system-prompt-file');
    const argv = buildAgentArgv({ sessionId: 'sess-c3', payload, systemPromptFile: '/path/to/identity.md', extraArgs: ['--model', 'sonnet'] });
    expect(argv).toEqual([
      '--bg', '-n', 'conveyor-3037',
      '--append-system-prompt-file', '/path/to/identity.md',
      '--model', 'sonnet', '# build #3037',
    ]);
  });

  it('#x8mpubm — settingsEnv folds into --settings \'{"env":...}\', ahead of systemPromptFile/extraArgs', () => {
    expect(buildAgentArgv({ sessionId: 'sess-c3', payload })).not.toContain('--settings');
    const argv = buildAgentArgv({
      sessionId: 'sess-c3', payload, settingsEnv: { PATH: '/shim:/usr/bin' },
      systemPromptFile: '/path/to/identity.md', extraArgs: ['--model', 'sonnet'],
    });
    expect(argv).toEqual([
      '--bg', '-n', 'conveyor-3037',
      '--settings', JSON.stringify({ env: { PATH: '/shim:/usr/bin' } }),
      '--append-system-prompt-file', '/path/to/identity.md',
      '--model', 'sonnet', '# build #3037',
    ]);
  });

  it('#x8mpubm — an empty settingsEnv object emits no --settings at all, same as null/omitted', () => {
    expect(buildAgentArgv({ sessionId: 'sess-c3', payload, settingsEnv: {} })).not.toContain('--settings');
    expect(buildAgentArgv({ sessionId: 'sess-c3', payload, settingsEnv: null })).not.toContain('--settings');
  });

  it('#xu2krte — resumeSessionId emits a BARE `--bg --resume <id> <prompt>`, no -n/systemPromptFile/extraArgs', () => {
    // The live build-time probe (docs/agent/platform-decisions.md#parked-pr-conflict-dispatched-not-scripted)
    // found any OTHER flag alongside `--resume` makes the CLI fork a copy instead of continuing the named
    // session — so this branch must emit nothing else, even when the caller supplies extras.
    const argv = buildAgentArgv({
      sessionId: 'sess-unused', payload, resumeSessionId: 'cand-1111-2222-3333-444444444444',
      systemPromptFile: '/path/to/identity.md', extraArgs: ['--model', 'sonnet'],
    });
    expect(argv).toEqual(['--bg', '--resume', 'cand-1111-2222-3333-444444444444', payload.prompt]);
  });

  it('#x8mpubm — settingsEnv is NEVER emitted on the resume branch either, same reasoning as extraArgs above', () => {
    const argv = buildAgentArgv({
      sessionId: 'sess-unused', payload, resumeSessionId: 'cand-1111-2222-3333-444444444444',
      settingsEnv: { PATH: '/shim:/usr/bin' },
    });
    expect(argv).toEqual(['--bg', '--resume', 'cand-1111-2222-3333-444444444444', payload.prompt]);
  });

  it('#xu2krte — resumeSessionId still refuses an empty/dash-leading prompt, same as a fresh dispatch', () => {
    expect(() => buildAgentArgv({ payload: { prompt: '  ' }, resumeSessionId: 'x' })).toThrow(/empty prompt/);
    expect(() => buildAgentArgv({ payload: { prompt: '--hostile' }, resumeSessionId: 'x' })).toThrow(/begins with `-`/);
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

// #3579 — the provider port between "an item is ready to dispatch" and any one CLI's argv/output.
describe('the provider port — #3579', () => {
  it('accepts a hand-written PORT-shaped fake (not a CLI-argv-shaped spawnAgent) and is driven the same way', async () => {
    const requests = [];
    const sinks = createDispatchSinks({
      root: PRIMARY,
      mintSessionId: () => 'sess-port-1',
      now: () => new Date('2026-08-13T10:00:00.000Z'),
      // A fake with NO argv/opts shape at all — just the port contract: a request in, a handle out.
      provider: (request) => {
        requests.push(request);
        return 'provider-handle-1';
      },
    });
    const result = await sinks[DISPATCH_EFFECT]({ prompt: '# build #1', sessionSlug: 'conveyor-1', num: '1' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      sessionId: 'sess-port-1', cwd: PRIMARY, prompt: '# build #1', sessionSlug: 'conveyor-1', num: '1',
    });
    // …driven the same way the real spawner is: its RETURNED handle becomes the in-flight marker's handle.
    expect(result).toMatchObject({ handle: 'provider-handle-1' });
    expect(isInFlightResult(result)).toBe(true);
  });

  it('defaultClaudeProvider is ONE implementation of the port, composing buildAgentArgv + spawnAgent', () => {
    const spawned = [];
    const handle = defaultClaudeProvider(
      { sessionId: 'sess-c9', cwd: PRIMARY, prompt: '# build #9', sessionSlug: 'conveyor-9', num: '9', extraArgs: ['--model', 'sonnet'] },
      { spawnAgent: (argv, opts) => { spawned.push({ argv, opts }); return ''; } },
    );
    expect(handle).toBe('sess-c9');
    expect(spawned).toEqual([{
      argv: buildAgentArgv({
        sessionId: 'sess-c9',
        payload: { prompt: '# build #9', sessionSlug: 'conveyor-9', num: '9' },
        extraArgs: ['--model', 'sonnet'],
      }),
      opts: { cwd: PRIMARY },
    }]);
  });

  it('a plain spawnAgent (the old CLI-argv-shaped stub) still drives the DEFAULT provider unmodified', async () => {
    const spawned = [];
    const sinks = createDispatchSinks({
      root: PRIMARY,
      spawnAgent: (argv, opts) => { spawned.push({ argv, opts }); return ''; },
      mintSessionId: () => 'sess-legacy',
    });
    const result = await sinks[DISPATCH_EFFECT]({ prompt: '# build #legacy', sessionSlug: 'conveyor-legacy', num: 'legacy' });
    expect(spawned).toHaveLength(1);
    expect(result).toMatchObject({ handle: 'sess-legacy' });
  });

  // #3579 review — a validation refusal from `buildAgentArgv` now runs INSIDE the provider call (moved there so
  // the port can compose it). The only thing preserving the pre-#3579 "clean failed, not indeterminate" shape
  // is the `if (e && e.notApplied) throw e;` rethrow, and that guarantee was stated only in a comment — prove it
  // end to end through the real sink + the DEFAULT provider, not just by unit-testing buildAgentArgv in isolation.
  it('an empty-prompt refusal from buildAgentArgv, reached via the DEFAULT provider, still rejects CLEAN — not indeterminate', async () => {
    const spawnAgent = () => { throw new Error('must not spawn — refused before any process could exist'); };
    const sinks = createDispatchSinks({ root: PRIMARY, spawnAgent, mintSessionId: () => 'sess-empty' });
    // `notApplied: true` (retriable), NOT a bare/UNKNOWN error — the empty-prompt guard already proved nothing
    // started, and moving `buildAgentArgv` inside the provider call must not blur that into "indeterminate".
    await expect(sinks[DISPATCH_EFFECT]({ prompt: '  ', sessionSlug: 's', num: '1' }))
      .rejects.toMatchObject({ notApplied: true, message: expect.stringContaining('empty prompt') });
  });

  it('a provider returning no handle (null/undefined) falls back to the minted sessionId, exactly like the default', async () => {
    const sinks = createDispatchSinks({
      root: PRIMARY, mintSessionId: () => 'sess-no-handle', provider: () => undefined,
    });
    const result = await sinks[DISPATCH_EFFECT]({ prompt: '# build #x', sessionSlug: 'conveyor-x', num: 'x' });
    expect(result).toMatchObject({ handle: 'sess-no-handle' });
  });

  // #3579 review (correctness + standards-conformance, twice) — `defaultClaudeProvider` forwards a NARROWED
  // `{prompt, sessionSlug, num}` object to `buildAgentArgv` instead of the caller's whole `payload`. Prove that
  // is lossless by construction, not by assertion: the argv `defaultClaudeProvider` produces from a request
  // built off a payload carrying EXTRA fields is byte-identical to calling `buildAgentArgv` with that whole
  // payload directly — because `buildAgentArgv` itself reads only `.prompt`/`.sessionSlug`/`.num` off `payload`.
  it('the narrowed request `defaultClaudeProvider` builds is lossless — identical argv to a full-payload buildAgentArgv call', () => {
    const richPayload = {
      prompt: '# build #42', sessionSlug: 'conveyor-42', num: '42',
      // fields buildAgentArgv does NOT read — present to prove they were never needed, not silently dropped.
      expectedWithinMinutes: 90, scope: ['we:scripts/foo.mjs'], unrelatedField: 'ignored-by-buildAgentArgv',
    };
    const directArgv = buildAgentArgv({ sessionId: 'sess-parity', payload: richPayload, extraArgs: ['--model', 'sonnet'] });
    const spawned = [];
    defaultClaudeProvider(
      {
        sessionId: 'sess-parity', cwd: PRIMARY, prompt: richPayload.prompt, sessionSlug: richPayload.sessionSlug,
        num: richPayload.num, extraArgs: ['--model', 'sonnet'],
      },
      { spawnAgent: (argv) => { spawned.push(argv); return ''; } },
    );
    expect(spawned[0]).toEqual(directArgv);
  });
});

// #xu2krte — reading the CLI's own report of a resume-or-fork outcome, exactly as observed in the live probe.
describe('parseBackgroundedId / resumeSucceeded — #xu2krte', () => {
  it('parseBackgroundedId reads the id off both observed stdout shapes', () => {
    expect(parseBackgroundedId('backgrounded · 76f44314\n  claude agents ...')).toBe('76f44314');
    expect(parseBackgroundedId('backgrounded · 368b7010 · probe-resume-1-r\n  claude agents ...')).toBe('368b7010');
  });

  it('parseBackgroundedId returns null on unrecognized text, never throws', () => {
    expect(parseBackgroundedId('')).toBeNull();
    expect(parseBackgroundedId('some unrelated error output')).toBeNull();
    expect(parseBackgroundedId(undefined)).toBeNull();
  });

  it('resumeSucceeded: true when a fresh listing confirms the printed id resolves to the REQUESTED sessionId', () => {
    const outcome = resumeSucceeded({
      printedId: '76f44314',
      requestedSessionId: '76f44314-45cb-4e70-9fa6-eff7872ed491',
      agentsAfter: [{ id: '76f44314', sessionId: '76f44314-45cb-4e70-9fa6-eff7872ed491' }],
    });
    expect(outcome).toEqual({ resumed: true, actualSessionId: '76f44314-45cb-4e70-9fa6-eff7872ed491', actualShortId: '76f44314' });
  });

  it('resumeSucceeded: false when the printed id resolves to a DIFFERENT sessionId — a forked copy', () => {
    const outcome = resumeSucceeded({
      printedId: '368b7010',
      requestedSessionId: '76f44314-45cb-4e70-9fa6-eff7872ed491',
      agentsAfter: [{ id: '368b7010', sessionId: '368b7010-8710-473e-9252-05c9d9f1c7dd' }],
    });
    expect(outcome.resumed).toBe(false);
    expect(outcome.actualSessionId).toBe('368b7010-8710-473e-9252-05c9d9f1c7dd');
  });

  it('resumeSucceeded: false, with no actualSessionId, when the printed id is not in the listing at all', () => {
    expect(resumeSucceeded({ printedId: 'ffffffff', requestedSessionId: 'x', agentsAfter: [] }))
      .toEqual({ resumed: false, actualSessionId: null, actualShortId: 'ffffffff' });
  });

  it('resumeSucceeded: unknown-outcome shape (no printedId at all) reads as not-resumed, not a throw', () => {
    expect(resumeSucceeded({ printedId: null, requestedSessionId: 'x', agentsAfter: [] }))
      .toEqual({ resumed: false, actualSessionId: null, actualShortId: null });
  });

  it('DELIBERATELY NOT a string-prefix comparison — a row whose `id` looks like a prefix but is a DIFFERENT actual field never matches by accident', () => {
    // Matching must go through a real listing row, keyed on `id` exactly, never `sessionId.split('-')[0]`.
    const outcome = resumeSucceeded({
      printedId: '76f44314',
      requestedSessionId: '76f44314-0000-0000-0000-000000000000',
      agentsAfter: [{ id: '76f44314', sessionId: 'some-totally-different-uuid' }],
    });
    expect(outcome.resumed).toBe(false);
    expect(outcome.actualSessionId).toBe('some-totally-different-uuid');
  });

  // #3541 — follow-up from PR #1966's independent review: harden against a post-resume listing row that omits
  // `id` (documented as absent from `interactive` rows, never yet observed on a `background` one — see this
  // function's own docblock). TWO positive fallbacks were tried and both were found unsafe by independent
  // review (the second backed by a live measurement showing listing propagation lag of 26+ seconds — far past
  // any retry budget `dispatchFix` can afford). The landed answer: no positive fallback — a missing `id` keeps
  // resolving `resumed:false`, exactly the pre-#3541 behavior, plus a NEVER-verdict-affecting `anomaly`
  // diagnostic so the never-yet-observed shape is at least visible on the record.
  describe('resumeSucceeded — a MISSING `id` on the post-resume row resolves `false`, with an anomaly diagnostic (#3541)', () => {
    const REQUESTED = '76f44314-45cb-4e70-9fa6-eff7872ed491';

    it('resumed stays false when the requested session IS still listed but its row carries no `id` — the exact card scenario, supplied directly', () => {
      const agentsAfter = [{ sessionId: REQUESTED, kind: 'background', name: 'conveyor-3438' }];
      const outcome = resumeSucceeded({ printedId: '76f44314', requestedSessionId: REQUESTED, agentsAfter });
      expect(outcome).toEqual({
        resumed: false, actualSessionId: null, actualShortId: '76f44314',
        anomaly: 'requested-session-listed-without-id',
      });
    });

    it('no anomaly is reported when the requested session is not listed at all — that is an ordinary "not found", not the missing-`id` shape', () => {
      const outcome = resumeSucceeded({ printedId: '76f44314', requestedSessionId: REQUESTED, agentsAfter: [] });
      expect(outcome).toEqual({ resumed: false, actualSessionId: null, actualShortId: '76f44314' });
      expect(outcome.anomaly).toBeUndefined();
    });

    it('no anomaly is reported when a DIFFERENT session is listed without `id` — the diagnostic is keyed to the REQUESTED session specifically', () => {
      const agentsAfter = [{ sessionId: 'some-other-session-id', kind: 'background' }];
      const outcome = resumeSucceeded({ printedId: '76f44314', requestedSessionId: REQUESTED, agentsAfter });
      expect(outcome.anomaly).toBeUndefined();
    });

    it('the REJECTED naive fallback still does not work — the requested session merely being listed proves nothing about resume vs. fork, with or without `id`', () => {
      // The item's own origin story: the pre-resume session stays listed under EITHER outcome, so "is it still
      // listed" can never disambiguate — restated here for the missing-`id` shape specifically.
      const agentsAfter = [
        { sessionId: REQUESTED, kind: 'background' }, // the untouched original — stays listed under EITHER outcome
        { id: 'forkedid', sessionId: 'a-brand-new-session-id', kind: 'background' }, // the actual fork
      ];
      const outcome = resumeSucceeded({ printedId: '76f44314', requestedSessionId: REQUESTED, agentsAfter });
      expect(outcome.resumed).toBe(false);
    });

    it('a fork whose row has NOT propagated into the listing at all is still safely read as not-resumed — no fixed retry budget is trusted to prove its absence (#3541 rounds 1-2, both rejected)', () => {
      // Looks EXACTLY like a clean resume by every field a sessionId-absence check could examine — this is
      // precisely the shape that made two successive positive fallbacks unsafe. The landed function does not
      // attempt to read it as a resume at all.
      const agentsAfter = [{ sessionId: REQUESTED, kind: 'background' }];
      const outcome = resumeSucceeded({ printedId: '76f44314', requestedSessionId: REQUESTED, agentsAfter });
      expect(outcome.resumed).toBe(false);
      expect(outcome.anomaly).toBe('requested-session-listed-without-id');
    });
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

  // #3110 — the exact scenario the item was filed against: item 100 dispatched twice. Entry A (first attempt,
  // tag `''`) starts at T1 and never produces its own PR. Entry B, a later retry (tag `'b'`), starts at
  // T2 > T1 and its PR merges at T3 > T2 > T1. Before this fix, A's own classify call saw B's merged PR (same
  // item number, merged after A's own startedAt) and wrongly resolved `merged` off it.
  describe('the attempt-tag axis (#3110) — a later retry\'s PR must never resolve an earlier, unrelated entry', () => {
    const T1 = '2026-08-13T10:00:00.000Z';
    const T3 = '2026-08-13T11:00:00.000Z'; // > T2 > T1, whatever T2 (entry B's own start) actually was

    it('entry A (attempt \'\') does NOT resolve merged off entry B\'s (attempt \'b\') later PR', () => {
      const prs = [ref('lane/3095b-b-slug', { state: 'MERGED', mergedAt: T3 })];
      // Old, tag-blind behaviour: this WOULD have been `merged` (T3 >= T1). #3110's fix excludes it outright —
      // the PR structurally belongs to a different attempt, not merely "a PR that happens to be too recent".
      expect(classifyDispatchPr({ num: '3095', startedAt: T1, prs, attempt: '' })).toMatchObject({ verdict: 'pending', pr: null });
    });

    it('entry B (attempt \'b\') DOES resolve merged off its own PR', () => {
      const prs = [ref('lane/3095b-b-slug', { state: 'MERGED', mergedAt: T3 })];
      expect(classifyDispatchPr({ num: '3095', startedAt: T1, prs, attempt: 'b' })).toMatchObject({ verdict: 'merged' });
    });

    it('symmetric: an EARLIER attempt\'s PR must never resolve a LATER entry either (both directions closed)', () => {
      // Entry A's own PR merges (correctly, for A) — entry B (the later retry) must not see it as its own.
      const prs = [ref('lane/3095-a-slug', { state: 'MERGED', mergedAt: T3 })];
      expect(classifyDispatchPr({ num: '3095', startedAt: T1, prs, attempt: 'b' })).toMatchObject({ verdict: 'pending', pr: null });
    });

    it('a candidate with NO resolvable tag (a legacy ref) is left to the timing filter alone', () => {
      // Neither side ever carried a letter before #3110 shipped — must keep resolving exactly as before.
      const prs = [ref('lane/3095-legacy-slug', { state: 'MERGED', mergedAt: T3 })];
      expect(classifyDispatchPr({ num: '3095', startedAt: T1, prs, attempt: '' })).toMatchObject({ verdict: 'merged' });
    });

    it('omitting `attempt` entirely degrades to today\'s tag-blind behaviour — the misattribution still happens', () => {
      // Documents the residual: a caller that never threads `attempt` through gets no protection. This is the
      // exact pre-#3110 shape, pinned so the default stays deliberate, not accidental.
      const prs = [ref('lane/3095b-b-slug', { state: 'MERGED', mergedAt: T3 })];
      expect(classifyDispatchPr({ num: '3095', startedAt: T1, prs })).toMatchObject({ verdict: 'merged' });
    });

    it('two attempts\' OWN PRs both open at once — each entry resolves only its own', () => {
      const prs = [
        ref('lane/3095-a-slug', { number: 1 }),
        ref('lane/3095b-b-slug', { number: 2 }),
      ];
      expect(classifyDispatchPr({ num: '3095', startedAt: T1, prs, attempt: '' })).toMatchObject({ verdict: 'pending', pr: { number: 1 } });
      expect(classifyDispatchPr({ num: '3095', startedAt: T1, prs, attempt: 'b' })).toMatchObject({ verdict: 'pending', pr: { number: 2 } });
    });
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

  it('resolves the item\'s spec path, repo-qualified scope and open blockers from the canonical loader', () => {
    expect(readTick({ num: '3037', ...bindings }).item).toEqual({
      num: '3037', slug: 'declare-dispatch', specPath: 'backlog/3037-declare-dispatch.md', scope: ['we:scripts/operations/'], openBlockers: [],
      // #3637 — an item with no `deliveryTarget:` resolves to the default target, `main`.
      deliveryTarget: null, deliveryBase: 'main', status: null, deliveryAgent: null,
    });
  });

  it('a tick that cannot be read is a refusal, never an empty plan that would look like "nothing to dispatch"', () => {
    expect(() => readTick({ num: '3037', ...bindings, runNode: () => { throw new Error('conveyor-state failed'); } }))
      .toThrow(/could not read the conveyor tick/);
  });

  it('refuses an id that normalizes to nothing', () => {
    expect(() => readTick({ num: '  ', ...bindings })).toThrow(/must be an item id/);
  });

  // ── #3332 — the LANE REF lookup: lazy, argv-pinned, and NEVER shelled for build/prepare ────────────────────

  it('#3332: `defaultLaneRefForPr` shells `gh pr view <pr> --json headRefName` — argv AND opts pinned', () => {
    const calls = [];
    const exec = (file, argv, opts) => { calls.push({ file, argv, opts }); return JSON.stringify({ headRefName: 'lane/2608-declare-dispatch' }); };
    const ref = defaultLaneRefForPr(701, { exec, env: {} });
    expect(ref).toBe('lane/2608-declare-dispatch');
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('gh');
    // THE WHOLE ARGV, one assertion — same discipline `defaultListPrs`'s own pinning test uses (a rename or a
    // dropped flag reddens exactly here).
    expect(calls[0].argv).toEqual(['pr', 'view', '701', '--json', 'headRefName']);
    expect(calls[0].opts).toMatchObject({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], killSignal: 'SIGKILL' });
    expect(calls[0].opts.timeout).toBeGreaterThan(0);
  });

  it('#3332: an absent or blank `headRefName` reads as `null`, never as an empty string', () => {
    expect(defaultLaneRefForPr(701, { exec: () => JSON.stringify({}), env: {} })).toBeNull();
    expect(defaultLaneRefForPr(701, { exec: () => JSON.stringify({ headRefName: '   ' }), env: {} })).toBeNull();
  });

  it('#3332: a `gh`/JSON failure THROWS rather than being swallowed — a dispatch with no LANE_REF must not proceed silently', () => {
    expect(() => defaultLaneRefForPr(701, { exec: () => { throw new Error('gh: not authenticated'); }, env: {} }))
      .toThrow(/not authenticated/);
    expect(() => defaultLaneRefForPr(701, { exec: () => 'not json', env: {} })).toThrow();
  });

  it('#3332: `readTick` calls the LANE REF reader ONLY for a fix/ci-heal launch that carries a `pr` — never for build or prepare', () => {
    let calls = 0;
    const laneRefForPr = (pr) => { calls += 1; return `lane/${pr}-x`; };

    // A BUILD launch — no PR to look a ref up for, and no subprocess paid for one it will never use.
    const buildTick = { decisions: { spawnBuilds: [{ num: 3037, lane: 8 }] }, nextState: { tick: 4 } };
    const buildOut = readTick({ num: '3037', ...bindings, runNode: () => JSON.stringify(buildTick), laneRefForPr });
    expect(calls).toBe(0);
    expect(buildOut.laneRef).toBeNull();

    // A FIX launch — looked up, and the row's OWN `pr` (not the item num) is what reaches the reader.
    const fixTick = { decisions: { spawnFixes: [{ pr: 701, num: 3037, lane: 5 }] }, nextState: { tick: 4 } };
    const fixOut = readTick({ num: '3037', ...bindings, runNode: () => JSON.stringify(fixTick), laneRefForPr });
    expect(calls).toBe(1);
    expect(fixOut.laneRef).toBe('lane/701-x');
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
        // #3457/#3460 — stubbed so this suite never shells the real `gh` (readTick calls it lazily whenever a
        // launch clears, and every test here clears one).
        checkAlreadyDone: () => ({ done: false, pr: null, checked: false }),
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

  /** The brief a kind SHOULD produce, filled from the file on disk — byte-exact, so it cannot drift. Passes
   *  the KIND'S OWN required set (not `fillBrief`'s build-shaped default), so a name only one kind's brief
   *  carries — `DELIVERY_BASE` since #3637 — is never demanded of a kind that has no such token. */
  function expectedPrompt(kind, values) {
    return fillBrief(readFileSync(briefPath(REPO_ROOT, kind), 'utf8'), values, BRIEF_REQUIRED_BY_KIND[kind]).prompt;
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

  // ── criterion 2b (#3567) ────────────────────────────────────────────────────────────────────────────────
  it('a `spawnInvestigations` entry SPAWNS ONCE, with the investigation brief', async () => {
    const { run, spawned } = await dispatchThrough({
      num: '3150', tick: tickWith('spawnInvestigations', { num: '3150', lane: 9 }), items: [UNSCOPED],
    });
    expect(spawned).toHaveLength(1);
    expect(run.verdict).toMatchObject({ dispatching: true, launchKind: 'investigate', lane: 9, sessionSlug: 'investigate-3150' });
    const prompt = spawned[0].argv[spawned[0].argv.length - 1];
    expect(prompt).toBe(expectedPrompt('investigate', {
      ITEM_NUM: '3150', ITEM_SPEC_PATH: SPEC_PATH, LANE: 9, SESSION_SLUG: 'investigate-3150', SCOPE: `we:${SPEC_PATH}`,
    }));
    expect(prompt).toContain('--purpose=conveyor-investigate');
    expect(run.findings.read.dispatchedGuard).toBeNull();
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
    // item's OWN `scope:` frontmatter, not the one-file prepare scope. `--append-system-prompt-file` (#xqyyoje)
    // is the sink's own standing-identity flag, always present on a real dispatch — see
    // `DISPATCHED_AGENT_SYSTEM_PROMPT_FILE`.
    expect(spawned[0].argv).toEqual([
      '--bg', '-n', 'conveyor-3037',
      '--append-system-prompt-file', DISPATCHED_AGENT_SYSTEM_PROMPT_FILE,
      expectedPrompt('build', {
        ITEM_NUM: '3037', ITEM_SPEC_PATH: 'backlog/3037-declare-dispatch.md', LANE: 8,
        SESSION_SLUG: 'conveyor-3037', SCOPE: 'we:scripts/operations/', DELIVERY_BASE: 'main',
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
    // The six that ARE wired all resolve, and to six DISTINCT files (#3332 grew this from three to five,
    // #3567 to six) — one map entry pointing at the wrong brief is the same failure with a quieter face.
    const paths = LAUNCH_KINDS.map((k) => briefPath(REPO_ROOT, k));
    expect(new Set(paths).size).toBe(6);
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
    )).toThrow(/never launches an item with no `scope:` for build, fix or CI-heal work/);
  });

  it('the whole plan is not dispatched — ONE call starts ONE agent, never the tick\'s other planned prepares', async () => {
    // The tick plans every prepare it can; this operation executes exactly one of them. A loop here would put a
    // second scheduler in front of the one that already decides multiplicity.
    const tick = tickWith('spawnPrepareScope', { num: '3150', lane: 5 });
    tick.decisions.spawnPrepareScope.push({ num: '9999', lane: 7 });
    const { spawned } = await dispatchThrough({ num: '3150', tick, items: [UNSCOPED, { num: '9999', slug: 'other' }] });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].argv[2]).toBe('prepare-3150');
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


// ── 9. #3332 — the planner's FIX and CI-HEAL lists reach the spawner too ───────────────────────────────────
//
// THE DEFECT THIS SECTION PINS, the sibling of #3165's own. `planTick` returns FIVE launch lists; #3165 wired
// three (`'build' | 'prepare' | 'prepare-decision'`, stated explicitly at its own `:68`/`:131` and confirmed by
// `grep -c 'spawnFixes\|spawnCiHeals\|ciHeal\|CI-heal'` over its card returning 0). An item the planner put in
// `spawnFixes` or `spawnCiHeals` — the two kinds a `review:changes` bounce or a red/BEHIND PR need to ever get
// auto-repaired — reached `briefPath` and THREW, because it took a kind `BRIEF_BY_KIND` did not carry. This
// section proves both kinds now reach the spawner, filled with the tokens their own briefs (not the five the
// first three kinds share) actually declare.
//
// EVERY CASE HERE GOES THROUGH THE REAL `readTick` AND THE REAL BRIEFS ON DISK, same discipline as #3165's own
// block — only the spawner and the PR→ref lookup (`laneRefForPr`, which would otherwise shell `gh pr view`)
// are stubbed.

describe('#3332: the planner\'s fix and CI-heal lists reach the spawner', () => {
  /** A tick as the core returns one, with the asked item/PR in exactly ONE of the five launch lists. */
  function tickWith(list, row) {
    return {
      decisions: {
        spawnBuilds: [], spawnPrepareScope: [], spawnPrepareDecision: [], spawnFixes: [], spawnCiHeals: [],
        suppressedBuilds: [], statusLine: 'conveyor · 1 fixing', notes: [],
        [list]: [row],
      },
      // `fixGuards`/`ciHealGuards` are SEPARATE FLAT LISTS (#3332), unlike `prepareGuards` — neither needs a
      // `kind` filter to disambiguate, so a SIBLING PR for the SAME item rides along here to prove the match
      // picked the row for THIS pr and not merely the first one in the list.
      nextState: {
        tick: 6,
        buildGuards: [],
        prepareGuards: [],
        // The DISPATCHED PR's own guard entry is listed SECOND, not first — so a match that (wrongly) picked
        // whichever row came first in the array would grab the SIBLING PR's guard instead, and the assertion
        // below on `run.findings.read.dispatchedGuard` would fail. That is what makes this fixture prove the
        // `pr`-filtered match in `dispatch-lane-io.mjs`'s `dispatchedGuard` selection, rather than merely
        // exercising a shape that would pass by luck of ordering.
        fixGuards: [
          { pr: 900, num: '2608', lane: 9, spawnedTick: 5 },
          { pr: 701, num: '2608', lane: 5, spawnedTick: 5 },
        ],
        ciHealGuards: [
          { pr: 950, num: '2638', lane: 10, spawnedTick: 5 },
          { pr: 743, num: '2638', lane: 6, spawnedTick: 5 },
        ],
      },
    };
  }

  /** A scoped item (already built once — its `scope:` frontmatter is exactly what a fix/ci-heal repairs). */
  const SCOPED = { num: '2608', slug: 'fix-target-item', scope: ['we:scripts/operations/'] };
  const CI_SCOPED = { num: '2638', slug: 'ci-heal-target-item', scope: ['we:scripts/operations/'] };
  /** The fake `{{LANE_REF}}` `laneRefForPr` hands back, standing in for a real `gh pr view`. */
  const FAKE_LANE_REF = 'lane/2608-declare-dispatch';

  /**
   * ONE WHOLE DISPATCH — the real `readTick`, the real declaration, the real sink, the real brief files, and a
   * STUB SPAWNER, same shape as #3165's own `dispatchThrough`. The ONE addition: `laneRefForPr` is stubbed too,
   * so a fix/ci-heal read never shells `gh pr view` in this suite.
   */
  async function dispatchThrough({ num, tick, items, laneRef = FAKE_LANE_REF }) {
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
        laneRefForPr: () => laneRef,
        // #3457/#3460 — same stub as the earlier `dispatchThrough` above, and for the same reason.
        checkAlreadyDone: () => ({ done: false, pr: null, checked: false }),
      }),
    }));
    const run = advanceWhileRunning(startRun({ op: DISPATCH_LANE_OP, id: `run-${num}`, input: { num }, registry }), { registry });
    if (!run.effects.length) return { run, spawned };
    const outcome = await applyPendingEffects(run, {
      sinks: createDispatchSinks({
        root: PRIMARY,
        spawnAgent: (argv, opts) => { spawned.push({ argv, opts }); return ''; },
        mintSessionId: () => 'sess-3332',
        now: () => new Date(NOW),
      }),
      store: createMemoryRunStore(),
    });
    return { run: outcome.run, spawned };
  }

  /** The brief a kind SHOULD produce, filled from the file on disk — byte-exact, so it cannot drift. `fix`/
   *  `ci-heal` need `REPO_AWARE_VALUE_PATTERNS` (#3960: `GATE_COMMAND`/`ATTRIBUTION` legitimately carry a space). */
  function expectedPrompt(kind, values) {
    return fillBrief(
      readFileSync(briefPath(REPO_ROOT, kind), 'utf8'), values, BRIEF_REQUIRED_BY_KIND[kind],
      undefined, kind === 'fix' || kind === 'ci-heal' ? REPO_AWARE_VALUE_PATTERNS : undefined,
    ).prompt;
  }

  // #3960 — the repo-aware quintet `readTick` resolves for `we` via the REAL `briefTokensForRepo` (this suite's
  // own checkout, exactly like every other real-brief-file assertion below). Pinned here once so both `it`s
  // below build their expected `values` from the SAME source `shapeDispatchRead` actually reads (`raw.repoTokens`),
  // rather than a second, possibly-drifting hardcoded copy.
  const WE_TOKENS = (itemNum) => briefTokensForRepo('we', { itemNum });

  // ── criterion 1 ──────────────────────────────────────────────────────────────────────────────────────────
  it('a `spawnFixes` entry SPAWNS ONCE, with the fix-agent brief — filled and byte-exact, zero {{…}} residue', async () => {
    const { run, spawned } = await dispatchThrough({
      num: '2608', tick: tickWith('spawnFixes', { pr: 701, num: '2608', lane: 5 }), items: [SCOPED],
    });
    expect(spawned).toHaveLength(1);
    expect(run.verdict).toMatchObject({ dispatching: true, launchKind: 'fix', lane: 5, sessionSlug: 'fix-701' });
    const prompt = spawned[0].argv[spawned[0].argv.length - 1];
    expect(prompt).toBe(expectedPrompt('fix', {
      ITEM_NUM: '2608', PR_NUM: 701, LANE_REF: FAKE_LANE_REF, LANE: 5, SESSION_SLUG: 'fix-701', SCOPE: 'we:scripts/operations/',
      ...WE_TOKENS('2608'),
    }));
    // NONE OF THE ELEVEN REQUIRED TOKENS REMAIN (#3332's original six, plus #3960's REPO/LANE_REPO/GATE_COMMAND/
    // WE_ROOT/ATTRIBUTION) — the exact failure #3332's card names: an unfilled token is reported, never fatal, so
    // a fix agent dispatched before this landed would have received the literal string `{{PR_NUM}}`. (The brief's
    // OWN prose still carries `{{PLACEHOLDERS}}`/`{{LIKE_THIS}}` — documentation, reported below, same as the
    // delivery brief's #3165 test.)
    for (const name of BRIEF_REQUIRED_BY_KIND.fix) expect(prompt).not.toContain(`{{${name}}}`);
    // The io shell's `raw.repoTokens` (this suite's own real checkout) reached the brief — `{{ATTRIBUTION}}`
    // reproduces the pre-#3960 hardcoded `WE #{{ITEM_NUM}}` literal exactly.
    expect(prompt).toContain('"WE #2608: address review:changes on PR #701');
    expect(prompt).toContain(`node "${REPO_ROOT}/scripts/lane-pool.mjs" acquire --repo=.`);
    expect(run.findings.read.briefUnknownTokens).toEqual(['{{LIKE_THIS}}', '{{PLACEHOLDERS}}']);
    // criterion 5 (guard half) — picked out of a `fixGuards` list holding a SIBLING PR for the same item, not
    // merely the first entry.
    expect(run.findings.read.dispatchedGuard).toEqual({ pr: 701, num: '2608', lane: 5, spawnedTick: 5 });
  });

  // ── criterion 2 ──────────────────────────────────────────────────────────────────────────────────────────
  it.each(['red-ci', 'behind'])('a `spawnCiHeals` entry (reason=%s) SPAWNS ONCE, with the CI-heal brief', async (reason) => {
    const { run, spawned } = await dispatchThrough({
      num: '2638', tick: tickWith('spawnCiHeals', { pr: 743, num: '2638', lane: 6, reason }), items: [CI_SCOPED],
    });
    expect(spawned).toHaveLength(1);
    expect(run.verdict).toMatchObject({ dispatching: true, launchKind: 'ci-heal', lane: 6, sessionSlug: 'ci-heal-743' });
    const prompt = spawned[0].argv[spawned[0].argv.length - 1];
    expect(prompt).toBe(expectedPrompt('ci-heal', {
      ITEM_NUM: '2638', PR_NUM: 743, LANE_REF: FAKE_LANE_REF, LANE: 6, SESSION_SLUG: 'ci-heal-743',
      SCOPE: 'we:scripts/operations/', REASON: reason,
      ...WE_TOKENS('2638'),
    }));
    for (const name of BRIEF_REQUIRED_BY_KIND['ci-heal']) expect(prompt).not.toContain(`{{${name}}}`);
    expect(prompt).toContain('"WE #2638: CI-heal PR #743');
    expect(run.findings.read.briefUnknownTokens).toEqual(['{{LIKE_THIS}}', '{{PLACEHOLDERS}}']);
    expect(run.findings.read.dispatchedGuard).toEqual({ pr: 743, num: '2638', lane: 6, spawnedTick: 5 });
  });

  // ── criterion 3 ──────────────────────────────────────────────────────────────────────────────────────────
  it('the fix/ci-heal session slug is DISTINCT from the build slug for the same item num — it is keyed on the PR', () => {
    expect(sessionSlugFor('3037', 'fix', 701)).toBe('fix-701');
    expect(sessionSlugFor('3037', 'ci-heal', 743)).toBe('ci-heal-743');
    expect(sessionSlugFor('3037', 'build')).toBe('conveyor-3037');
    expect(sessionSlugFor('3037', 'fix', 701)).not.toBe(sessionSlugFor('3037', 'build'));
    // …and it is keyed on the PR, not the item — two fix rounds for the SAME item that opened two DIFFERENT
    // PRs get two DIFFERENT slugs, never a collision.
    expect(sessionSlugFor('3037', 'fix', 701)).not.toBe(sessionSlugFor('3037', 'fix', 900));
  });

  // ── criterion 4 ──────────────────────────────────────────────────────────────────────────────────────────
  it('`pr` (and `reason` for CI-heal) reach `run.effects[0].payload`', async () => {
    const fix = await dispatchThrough({
      num: '2608', tick: tickWith('spawnFixes', { pr: 701, num: '2608', lane: 5 }), items: [SCOPED],
    });
    expect(fix.run.effects[0].payload.pr).toBe(701);
    expect(fix.run.effects[0].payload.reason).toBeNull();

    const ciHeal = await dispatchThrough({
      num: '2638', tick: tickWith('spawnCiHeals', { pr: 743, num: '2638', lane: 6, reason: 'red-ci' }), items: [CI_SCOPED],
    });
    expect(ciHeal.run.effects[0].payload.pr).toBe(743);
    expect(ciHeal.run.effects[0].payload.reason).toBe('red-ci');

    // …and a BUILD's payload still carries both as `null` — the field exists on every payload shape, not only
    // the two new ones.
    const build = await dispatchThrough({
      num: '3037', tick: tickWith('spawnBuilds', { num: '3037', lane: 8 }), items: [{ num: '3037', slug: 'declare-dispatch', scope: ['we:scripts/operations/'] }],
    });
    expect(build.run.effects[0].payload.pr).toBeNull();
    expect(build.run.effects[0].payload.reason).toBeNull();
  });

  it('an UNSCOPED item still refuses a fix dispatch — the refusal is not build-exclusive (#3332\'s open question, settled)', () => {
    expect(() => shapeDispatchRead(
      {
        resolvedNum: '2608', launch: { pr: 701, num: '2608', lane: 5 }, launchKind: 'fix', suppressed: null,
        item: { num: '2608', slug: 'x', specPath: 'backlog/2608-x.md', scope: [] },
        briefTemplate: readFileSync(briefPath(REPO_ROOT, 'fix'), 'utf8'), nextState: {}, statusLine: '', notes: [],
        droppedBookkeepingKeys: [], inFlightDispatches: { runs: [], unreadable: 0, livenessSource: 'not-needed' },
        bookkeepingSource: 'file', observedAt: NOW, laneRef: FAKE_LANE_REF,
      },
      { num: '2608' },
    )).toThrow(/never launches an item with no `scope:` for build, fix or CI-heal work/);
  });

  it('a num in NO list still says so, and now names all five', async () => {
    const { run, spawned } = await dispatchThrough({
      num: '2608', tick: tickWith('spawnBuilds', { num: '3037', lane: 8 }), items: [SCOPED],
    });
    expect(spawned).toEqual([]);
    expect(run.verdict.dispatching).toBe(false);
    expect(run.verdict.reason).toMatch(/spawnFixes/);
    expect(run.verdict.reason).toMatch(/spawnCiHeals/);
  });
});

// #3960 (multi-repo slice 4) — the fix/ci-heal briefs fill REPO/LANE_REPO/GATE_COMMAND/WE_ROOT/ATTRIBUTION
// from `briefTokensForRepo`. These tests fill the REAL brief files (never a synthetic stub) so a future edit to
// either brief that drops the `{{WE_ROOT}}` qualifier or re-hardcodes `check:standards` is caught here.
describe('#3960: the fix/ci-heal briefs fill repo-aware, and reproduce WE\'s pre-#3960 literal exactly', () => {
  const FIX_BRIEF = readFileSync(briefPath(REPO_ROOT, 'fix'), 'utf8');
  const CI_HEAL_BRIEF = readFileSync(briefPath(REPO_ROOT, 'ci-heal'), 'utf8');
  const BASE_FIX_VALUES = {
    ITEM_NUM: '2608', PR_NUM: 701, LANE_REF: 'lane/2608-x', LANE: 5, SESSION_SLUG: 'fix-701', SCOPE: 'we:scripts/operations/',
  };
  const BASE_CI_HEAL_VALUES = {
    ITEM_NUM: '2638', PR_NUM: 743, LANE_REF: 'lane/2638-x', LANE: 6, SESSION_SLUG: 'ci-heal-743',
    SCOPE: 'we:scripts/operations/', REASON: 'red-ci',
  };
  const WE_PACKAGE_JSON = JSON.stringify({ scripts: { 'test:unit': 'vitest run', 'check:standards': 'node scripts/check-standards.mjs' } });
  const PLATEAU_PACKAGE_JSON = JSON.stringify({ scripts: { test: 'vitest run' } });

  it('for WE, {{ATTRIBUTION}}/{{GATE_COMMAND}} reproduce the pre-#3960 hardcoded literal exactly (fix brief)', () => {
    const tokens = briefTokensForRepo('we', { itemNum: '2608', checkoutExists: () => true, readPackageJson: () => WE_PACKAGE_JSON });
    const { prompt } = fillBrief(FIX_BRIEF, { ...BASE_FIX_VALUES, ...tokens }, BRIEF_REQUIRED_BY_KIND.fix, undefined, REPO_AWARE_VALUE_PATTERNS);
    // The exact literal `fix-agent-brief.md` hardcoded before #3960 (`"WE #{{ITEM_NUM}}: address …"`).
    expect(prompt).toContain('printf \'%s\\n\' "WE #2608: address review:changes on PR #701 — <one-line what you fixed>"');
    expect(prompt).toContain('npm run test:unit && npm run check:standards');
    expect(prompt).toContain(`node "${tokens.WE_ROOT}/scripts/lane-pool.mjs" acquire --repo=. --lane=5`);
    expect(prompt).toContain('gh pr view 701 --json title,body,comments --repo chalbert/web-everything');
  });

  it('for WE, the ci-heal brief\'s {{ATTRIBUTION}} reproduces the pre-#3960 hardcoded literal exactly', () => {
    const tokens = briefTokensForRepo('we', { itemNum: '2638', checkoutExists: () => true, readPackageJson: () => WE_PACKAGE_JSON });
    const { prompt } = fillBrief(CI_HEAL_BRIEF, { ...BASE_CI_HEAL_VALUES, ...tokens }, BRIEF_REQUIRED_BY_KIND['ci-heal'], undefined, REPO_AWARE_VALUE_PATTERNS);
    expect(prompt).toContain('printf \'%s\\n\' "WE #2638: CI-heal PR #743 — rebase onto main + repair the failing check"');
    expect(prompt).toContain('npm run test:unit && npm run check:standards');
  });

  it('for plateau-app, every tool call is qualified with the WE checkout root, never the plateau checkout', () => {
    const tokens = briefTokensForRepo('plateau-app', {
      itemNum: '2608', home: '/home/test', checkoutExists: () => true, readPackageJson: () => PLATEAU_PACKAGE_JSON,
    });
    expect(tokens.REPO).toBe('chalbert/plateau-app');
    expect(tokens.LANE_REPO).toBe('/home/test/workspace/plateau-app');
    expect(tokens.GATE_COMMAND).toBe('npm test');
    const { prompt, unknownTokens } = fillBrief(FIX_BRIEF, { ...BASE_FIX_VALUES, ...tokens }, BRIEF_REQUIRED_BY_KIND.fix, undefined, REPO_AWARE_VALUE_PATTERNS);
    for (const name of BRIEF_REQUIRED_BY_KIND.fix) expect(prompt).not.toContain(`{{${name}}}`);
    expect(unknownTokens).toEqual(['{{LIKE_THIS}}', '{{PLACEHOLDERS}}']);
    // Every tool this brief runs is qualified with WE_ROOT — the tools live only there, never in the plateau
    // checkout `{{LANE_REPO}}` names.
    expect(prompt).toContain(`node "${tokens.WE_ROOT}/scripts/lane-pool.mjs" acquire --repo=/home/test/workspace/plateau-app`);
    expect(prompt).toContain(`node "${tokens.WE_ROOT}/scripts/conveyor/rearm-review.mjs" 701 --repo=chalbert/plateau-app`);
    expect(prompt).toContain(`node "${tokens.WE_ROOT}/scripts/operations/completion-cli.mjs" report --repo=chalbert/plateau-app`);
    expect(prompt).not.toContain('node "/home/test/workspace/plateau-app/scripts');
    // The plateau gate runs, not WE's hardcoded `check:standards`.
    expect(prompt).toContain('npm test          # this repo\'s own gate');
    expect(prompt).toContain('printf \'%s\\n\' "PLATEAU #2608: address review:changes on PR #701 — <one-line what you fixed>"');
  });
});

// ── #3457/#3460 — the ALREADY-DONE ground-truth check, at both chokepoints ratified by #3457 ────────────────

describe('filterAlreadyDoneCandidates — PURE: which gh pr list rows are real "already done" evidence', () => {
  const merged = (title, headRefName, over = {}) => ({
    number: 1, title, headRefName, url: `https://github.com/x/y/pull/${over.number ?? 1}`,
    mergedAt: '2026-09-01T16:44:28Z', state: 'MERGED', ...over,
  });

  it('the REAL #3434 shape: a genuine implementation PR, title AND ref both name the item', () => {
    // Reproduces the exact live evidence #3457's own card cites: `gh pr list --search "3434 in:title" --state
    // merged` returning PR #1768, titled "…verdict (#3434)", ref `lane/3434-mechanical-accept`.
    const prs = [merged('review-loop-policy: mechanical acceptance from a clean independent verdict (#3434)', 'lane/3434-mechanical-accept', { number: 1768 })];
    const out = filterAlreadyDoneCandidates(prs, '3434');
    expect(out).toHaveLength(1);
    expect(out[0].number).toBe(1768);
  });

  it('the REAL #3433 shape too — same query, a different real merged PR', () => {
    const prs = [merged('WE #3433: bake a Bash disallowedTools deny list into every dispatched review session', 'lane/3433-review-dispatch-disallowed-tools', { number: 1829 })];
    expect(filterAlreadyDoneCandidates(prs, '3433')).toHaveLength(1);
  });

  it('EXCLUDES a prepare-scope authoring PR — the false positive this check\'s own authoring found live against #3435', () => {
    // `gh pr list --search "3435 in:title" --state merged` (measured 2026-09-03) really does return this PR
    // alongside the true implementation. Every scoped build item has one of these merged BEFORE its own build
    // even starts, so counting it as "done" would refuse the very first real build attempt of nearly any item.
    const scopePr = merged('WE #3435: author scope: for #3435', 'lane/3435-scope-3dfab284', { number: 1780 });
    const realPr = merged('WE #3435: mechanically reap/stop finished `claude agents` background sessions', 'lane/3435-session-reaper', { number: 1861 });
    const out = filterAlreadyDoneCandidates([scopePr, realPr], '3435');
    expect(out.map((p) => p.number)).toEqual([1861]); // only the real implementation survives
  });

  it('EXCLUDES a prepare-decision authoring PR the same way', () => {
    const prepPr = merged('WE #3457: author decision forks for #3457', 'lane/3457-prepare-3dfab284', { number: 9001 });
    expect(filterAlreadyDoneCandidates([prepPr], '3457')).toEqual([]);
  });

  it('a WORD-BOUNDARY title match — item "343" must not match a PR title mentioning "3435"', () => {
    const pr = merged('WE #3435: mechanically reap/stop finished sessions', 'lane/3435-session-reaper');
    expect(filterAlreadyDoneCandidates([pr], '343')).toEqual([]);
  });

  it('excludes a non-merged row even if it slipped past the caller\'s own `--state merged` filter', () => {
    const pr = merged('WE #3037: x', 'lane/3037-x', { state: 'OPEN' });
    expect(filterAlreadyDoneCandidates([pr], '3037')).toEqual([]);
  });

  it('sorts MOST RECENTLY MERGED first', () => {
    const older = merged('WE #3037: first', 'lane/3037-first', { number: 1, mergedAt: '2026-08-01T00:00:00Z' });
    const newer = merged('WE #3037: second', 'lane/3037-second', { number: 2, mergedAt: '2026-08-02T00:00:00Z' });
    expect(filterAlreadyDoneCandidates([older, newer], '3037').map((p) => p.number)).toEqual([2, 1]);
  });

  it('empty/malformed input never throws', () => {
    expect(filterAlreadyDoneCandidates(null, '3037')).toEqual([]);
    expect(filterAlreadyDoneCandidates([], '3037')).toEqual([]);
    expect(filterAlreadyDoneCandidates([{}], '')).toEqual([]);
    expect(filterAlreadyDoneCandidates([{}], 'not-a-number')).toEqual([]);
  });

  it('NON_IMPLEMENTING_REF_RE matches both authoring shapes and no others', () => {
    expect(NON_IMPLEMENTING_REF_RE.test('lane/3435-scope-abcd')).toBe(true);
    expect(NON_IMPLEMENTING_REF_RE.test('lane/3457-prepare-abcd')).toBe(true);
    expect(NON_IMPLEMENTING_REF_RE.test('lane/3037-my-scoped-fix')).toBe(false); // "scoped" ≠ "scope-"
    expect(NON_IMPLEMENTING_REF_RE.test('lane/3037b-slug')).toBe(false); // a real retry-tagged build ref
  });

  // #3473 — the real live false positive this check's own docblock now cites: #3096's dispatch-time
  // already-done hold, fed by two merged PRs that both title-boundary-match "3096" but whose real diffs are
  // pure backlog housekeeping (all-.md). Reproduces both exact shapes.
  it('#3473 — EXCLUDES PR #1599\'s exact shape (all-.md diff, real body says "No code behaviour changes")', () => {
    const pr = merged(
      '#3096: reconcile the three-way dispatch duplicate — #3096 survives, #3147 + #3239 collapse',
      'lane/reconcile-3147-3096-3239',
      {
        number: 1599,
        body: 'No code behaviour changes — this is a backlog reconciliation plus one in-code comment repoint.',
        files: [
          { path: 'backlog/3096-route-the-conveyor-s-build-dispatch-through-the-declared-dis.md' },
          { path: 'backlog/3147-x.md' },
          { path: 'backlog/3239-x.md' },
          { path: 'skills-src/conveyor/SKILL.md' },
        ],
      },
    );
    expect(filterAlreadyDoneCandidates([pr], '3096')).toEqual([]);
  });

  it('#3473 — EXCLUDES PR #1613\'s exact shape (all-.md diff, real body says "No code changes — two backlog files")', () => {
    const pr = merged(
      'WE #3096: split along its two scope entries — skill rewiring vs liveness hardening',
      'lane/split-3096',
      {
        number: 1613,
        body: 'No code changes — two backlog files.',
        files: [
          { path: 'backlog/3096-route-the-conveyor-s-build-dispatch-through-the-declared-dis.md' },
          { path: 'backlog/3096b-x.md' },
        ],
      },
    );
    expect(filterAlreadyDoneCandidates([pr], '3096')).toEqual([]);
  });

  it('#3473 guard 4 does NOT over-fire on a real implementation that happens to also touch a doc file', () => {
    const pr = merged('WE #3096: route the conveyor\'s build dispatch through the declared dispatcher', 'lane/3096-route-dispatch', {
      number: 2001,
      files: [{ path: 'scripts/readiness/dispatch-plan.mjs' }, { path: 'backlog/3096-x.md' }],
    });
    expect(filterAlreadyDoneCandidates([pr], '3096')).toHaveLength(1);
  });

  it('#3473 guard 5 — a "does not resolve #NNN" body disclaimer excludes the PR, scoped to that exact id', () => {
    const pr = merged('WE #3443: readiness/computeFreeSlots excludes dirty (orphaned) unleased lanes', 'lane/3443-computefreeslots-excludes-dirty-lanes', {
      number: 1866,
      body: 'Graduates origin/lane/mechanical-dispatcher onto main, as one small piece of the ongoing graduation tracked by #3443 — this PR does not resolve #3443, it lands one increment of it.',
    });
    expect(filterAlreadyDoneCandidates([pr], '3443')).toEqual([]);
  });

  it('#3473 guard 5 is scoped to THIS num — a disclaimer for a different id does not suppress a real match', () => {
    const pr = merged('WE #3435: mechanically reap/stop finished sessions (this PR does not resolve #9999)', 'lane/3435-session-reaper', { number: 1861 });
    expect(filterAlreadyDoneCandidates([pr], '3435')).toHaveLength(1);
  });

  it('#3473 — both new filters are no-ops when `files`/`body` are absent from the row (existing fixtures without them stay green)', () => {
    const pr = merged('WE #3037: x', 'lane/3037-x');
    expect(filterAlreadyDoneCandidates([pr], '3037')).toHaveLength(1);
  });

  it('#3473 guard 6 — PR #1599\'s REAL (stale) gh files list (17 files, 3 real .mjs, verified live 2026-09-04) defeats guard 4, but the blanket "no code changes" body disclaimer still excludes it', () => {
    // `gh pr view 1599 --json files` genuinely returns 17 files including three real .mjs changes, even
    // though the PR's TRUE merge-commit diff (`git show 90fe066f6 --stat`) is 4 files, all markdown — a
    // GitHub files-API staleness quirk on this long-lived branch. Guard 4 (all-.md changed files) cannot
    // exclude this PR from the real data; guard 6 (the PR's own "No code behaviour changes" opening line) does.
    const pr = merged(
      '#3096: reconcile the three-way dispatch duplicate — #3096 survives, #3147 + #3239 collapse',
      'lane/reconcile-3147-3096-3239',
      {
        number: 1599,
        body: 'No code behaviour changes — this is a backlog reconciliation plus one in-code comment repoint.',
        files: [
          { path: 'backlog/3096-route-the-conveyor-s-build-dispatch-through-the-declared-dis.md' },
          { path: 'backlog/3147-x.md' },
          { path: 'backlog/3239-x.md' },
          { path: 'docs/agent/platform-decisions.md' },
          { path: 'scripts/lib/jury-core.mjs' },
          { path: 'scripts/lib/jury-ledger.mjs' },
          { path: 'scripts/workflows/review-parked-prs.mjs' },
          { path: 'skills-src/conveyor/SKILL.md' },
        ],
      },
    );
    expect(filterAlreadyDoneCandidates([pr], '3096')).toEqual([]);
  });

  it('#3473 guard 6 — end-to-end proof: BOTH real #3096 PRs (#1599 via the blanket disclaimer, #1613 via the all-markdown files) are excluded together, leaving no already-done evidence', () => {
    const pr1599 = merged(
      '#3096: reconcile the three-way dispatch duplicate — #3096 survives, #3147 + #3239 collapse',
      'lane/reconcile-3147-3096-3239',
      {
        number: 1599,
        mergedAt: '2026-08-26T21:37:29Z',
        body: 'No code behaviour changes — this is a backlog reconciliation plus one in-code comment repoint.',
        files: [
          { path: 'backlog/3096-route-the-conveyor-s-build-dispatch-through-the-declared-dis.md' },
          { path: 'scripts/lib/jury-core.mjs' },
        ],
      },
    );
    const pr1613 = merged(
      'WE #3096: split along its two scope entries — skill rewiring vs liveness hardening',
      'lane/split-3096',
      {
        number: 1613,
        mergedAt: '2026-08-26T23:55:38Z',
        body: 'Splits #3096 along its two scope: entries. No code changes — two backlog files.',
        files: [
          { path: 'backlog/3096-route-the-conveyor-s-build-dispatch-through-the-declared-dis.md' },
          { path: 'backlog/x3gvcun-x.md' },
        ],
      },
    );
    expect(filterAlreadyDoneCandidates([pr1599, pr1613], '3096')).toEqual([]);
  });

  it('#3473 guard 6 does not over-fire on a real delivery body that happens to mention "no code" in an unrelated sense', () => {
    const pr = merged('WE #3435: mechanically reap/stop finished sessions', 'lane/3435-session-reaper', {
      number: 1861,
      body: 'This fix requires no code review sign-off beyond CI, and lands the feature end to end.',
    });
    expect(filterAlreadyDoneCandidates([pr], '3435')).toHaveLength(1);
  });
});

describe('defaultCheckAlreadyDone — the gh call itself: argv, timeout, and fail-soft', () => {
  it('shells the exact ratified query shape: search "<NNN> in:title", state merged, bounded limit + json fields', () => {
    let seenArgv = null;
    let seenOpts = null;
    const exec = (cmd, argv, opts) => { seenArgv = [cmd, ...argv]; seenOpts = opts; return '[]'; };
    defaultCheckAlreadyDone('3435', { exec });
    expect(seenArgv).toEqual([
      'gh', 'pr', 'list', '--search', '3435 in:title', '--state', 'merged',
      '--limit', String(ALREADY_DONE_SEARCH_LIMIT), '--json', ALREADY_DONE_JSON_FIELDS,
    ]);
    expect(seenOpts.timeout).toBeGreaterThan(0); // reuses prListTimeoutMs — never unbounded by accident
    expect(seenOpts.killSignal).toBe('SIGKILL');
  });

  it('a real merged match returns done:true with the most-recent PR as evidence', () => {
    const prs = [{ number: 1768, title: 'x (#3434)', headRefName: 'lane/3434-x', url: 'https://x/1768', mergedAt: '2026-09-01T00:00:00Z', state: 'MERGED' }];
    const out = defaultCheckAlreadyDone('3434', { exec: () => JSON.stringify(prs) });
    expect(out).toEqual({ done: true, pr: prs[0], checked: true });
  });

  it('no match → done:false, checked:true (a real read that found nothing)', () => {
    const out = defaultCheckAlreadyDone('3434', { exec: () => '[]' });
    expect(out).toEqual({ done: false, pr: null, checked: true });
  });

  it('FAIL-SOFT: a gh failure (auth, rate-limit, network) degrades to not-done, not a throw', () => {
    const out = defaultCheckAlreadyDone('3434', { exec: () => { throw new Error('gh: command not found'); } });
    expect(out).toEqual({ done: false, pr: null, checked: false });
  });

  it('unparseable output degrades the same way, never crashes the caller', () => {
    expect(defaultCheckAlreadyDone('3434', { exec: () => 'not json' })).toEqual({ done: false, pr: null, checked: false });
  });

  it('a blank/missing num is refused cheaply — no gh call at all', () => {
    let called = false;
    expect(defaultCheckAlreadyDone('', { exec: () => { called = true; return '[]'; } }))
      .toEqual({ done: false, pr: null, checked: false });
    expect(called).toBe(false);
  });
});

describe('readTick — the ground-truth check is LAZY: one gh call per dispatch ATTEMPT, never when nothing is cleared', () => {
  const TICK = { decisions: { spawnBuilds: [{ num: 3037, lane: 8 }] }, nextState: { tick: 1 } };
  const bindings = {
    runNode: () => JSON.stringify(TICK),
    readText: () => BRIEF,
    loadItems: () => [{ num: '3037', slug: 'declare-dispatch', scope: ['we:scripts/operations/'] }],
    listAgents: () => [],
  };

  it('calls checkAlreadyDone exactly once when a launch was cleared, and threads its verdict onto the read', () => {
    let calls = 0;
    const out = readTick({
      num: '3037', ...bindings,
      checkAlreadyDone: (n) => { calls += 1; expect(n).toBe('3037'); return { done: false, pr: null, checked: true }; },
    });
    expect(calls).toBe(1);
    expect(out.alreadyDone).toEqual({ done: false, pr: null, checked: true });
  });

  it('never calls checkAlreadyDone when nothing was cleared for this item — no launch, no gh cost', () => {
    let calls = 0;
    const out = readTick({
      num: '9999', ...bindings, runNode: () => JSON.stringify({ decisions: {}, nextState: {} }),
      checkAlreadyDone: () => { calls += 1; return { done: true, pr: {} }; },
    });
    expect(out.launch).toBeNull();
    expect(calls).toBe(0);
    expect(out.alreadyDone).toEqual({ done: false, pr: null, checked: false });
  });
});

describe('#3110 — attemptTagFor: the pure retry-letter mapping', () => {
  it('zero prior attempts → no tag, the byte-identical-to-before case', () => {
    expect(attemptTagFor(0)).toBe('');
  });
  it('one prior attempt (this dispatch is the SECOND) → \'b\', matching the documented `conveyor-2500b` precedent', () => {
    expect(attemptTagFor(1)).toBe('b');
  });
  it('counts on up: 2 → \'c\', 3 → \'d\'', () => {
    expect(attemptTagFor(2)).toBe('c');
    expect(attemptTagFor(3)).toBe('d');
  });
  it('caps at \'z\' rather than overflowing past a single letter (a 26th+ retry is its own anomaly)', () => {
    expect(attemptTagFor(25)).toBe('z');
    expect(attemptTagFor(26)).toBe('z');
    expect(attemptTagFor(1000)).toBe('z');
  });
  it('degenerate input (negative, NaN, non-numeric) fails to the safe no-tag default, never throws', () => {
    expect(attemptTagFor(-1)).toBe('');
    expect(attemptTagFor(NaN)).toBe('');
    expect(attemptTagFor('not a number')).toBe('');
    expect(attemptTagFor(undefined)).toBe('');
  });
});

describe('#3110 — fillBrief tolerates a blank OPTIONAL placeholder (ATTEMPT_TAG), everything else unchanged', () => {
  const VALUES = { ITEM_NUM: '3037', ITEM_SPEC_PATH: 'x', LANE: '8', SESSION_SLUG: 'conveyor-3037', SCOPE: 'we:x', DELIVERY_BASE: 'main' };

  it('ATTEMPT_TAG never supplied at all does not throw, even though it is now in the build required set', () => {
    // BRIEF (the synthetic fixture above) never references {{ATTEMPT_TAG}} at all, so this only proves the
    // per-name required-value check treats it as optional-and-absent rather than missing-and-fatal; the real
    // substitution mechanics (does {{ATTEMPT_TAG}} actually resolve to '' / a letter) are proven separately
    // below against the REAL brief file, which does reference it.
    const { prompt, unknownTokens } = fillBrief(BRIEF, { ...VALUES }, BRIEF_REQUIRED_BY_KIND.build);
    expect(unknownTokens).toEqual([]);
    expect(prompt).not.toContain('undefined');
  });

  it('a NON-optional name is still refused blank — the exemption is per-name, not global', () => {
    expect(() => fillBrief(BRIEF, { ...VALUES, SESSION_SLUG: '' }, BRIEF_REQUIRED_BY_KIND.build))
      .toThrow(/no value for the brief placeholder \{\{SESSION_SLUG\}\}/);
  });

  it('an explicit empty `optionalNames` list restores the old all-required behaviour for ATTEMPT_TAG too', () => {
    expect(() => fillBrief(BRIEF, { ...VALUES }, BRIEF_REQUIRED_BY_KIND.build, []))
      .toThrow(/no value for the brief placeholder \{\{ATTEMPT_TAG\}\}/);
  });

  it('OPTIONAL_BRIEF_PLACEHOLDERS names exactly ATTEMPT_TAG, and only the build kind carries it', () => {
    expect(OPTIONAL_BRIEF_PLACEHOLDERS).toEqual(['ATTEMPT_TAG']);
    expect(BRIEF_PLACEHOLDERS).toContain('ATTEMPT_TAG');
    expect(BRIEF_REQUIRED_BY_KIND.build).toContain('ATTEMPT_TAG');
    expect(BRIEF_REQUIRED_BY_KIND.prepare).not.toContain('ATTEMPT_TAG');
    expect(BRIEF_REQUIRED_BY_KIND['prepare-decision']).not.toContain('ATTEMPT_TAG');
    expect(BRIEF_REQUIRED_BY_KIND.fix).not.toContain('ATTEMPT_TAG');
    expect(BRIEF_REQUIRED_BY_KIND['ci-heal']).not.toContain('ATTEMPT_TAG');
  });
});

describe('#3110 — a fresh build dispatch\'s attempt tag rides its session slug and branch instruction', () => {
  it('a genuine first attempt (no prior in-flight record) is byte-identical to before — no letter at all', () => {
    const v = shapeDispatchRead(tickRead(), { num: '3037' });
    expect(v.sessionSlug).toBe('conveyor-3037');
    expect(v.prompt).toContain('session: conveyor-3037');
    expect(v.prompt).not.toContain('conveyor-3037b');
  });

  it('one prior AGED-OUT in-flight record for this item → the retry gets the \'b\' tag on its session slug', () => {
    // The exact shape #3390-adjacent tests already use for "aged out, no longer holds, but still on disk":
    // `dispatchStillHolds` sees it as gone (not `holdingRuns`), so the dispatch proceeds — but it is still one
    // real prior attempt, which is exactly what `attemptTagFor` needs to count.
    const gone = goneRun({ startedAt: isoPlus(NOW, -60) });
    const v = shapeDispatchRead(tickRead({ inFlightDispatches: inFlightBlock([gone]) }), { num: '3037' });
    expect(v.dispatching).toBe(true);
    expect(v.sessionSlug).toBe('conveyor-3037b');
    expect(v.prompt).toContain('session: conveyor-3037b');
  });

  // The synthetic `BRIEF` fixture above carries no branch-naming line at all (it is a 5-line stand-in, not the
  // real markdown) — this proves the REAL template's `{{ATTEMPT_TAG}}` usage against the real file on disk,
  // the same way "FILLS THE REAL BRIEF ON DISK" below proves the other five.
  it('the REAL delivery-agent brief folds ATTEMPT_TAG into the branch name exactly where step 8 shows', () => {
    const VALUES = {
      ITEM_NUM: '3037', ITEM_SPEC_PATH: 'backlog/3037-x.md', LANE: '8', SESSION_SLUG: 'conveyor-3037b', SCOPE: 'we:scripts/',
      DELIVERY_BASE: 'main',
    };
    const firstAttempt = fillBrief(readFileSync(briefPath(REPO_ROOT, 'build'), 'utf8'), { ...VALUES, ATTEMPT_TAG: '' }, BRIEF_REQUIRED_BY_KIND.build);
    expect(firstAttempt.prompt).toContain('lane/3037-<slug>');
    expect(firstAttempt.prompt).not.toContain('lane/3037b-<slug>');

    const retry = fillBrief(readFileSync(briefPath(REPO_ROOT, 'build'), 'utf8'), { ...VALUES, ATTEMPT_TAG: 'b' }, BRIEF_REQUIRED_BY_KIND.build);
    expect(retry.prompt).toContain('lane/3037b-<slug>');
    expect(retry.prompt).not.toContain('lane/3037-<slug>'); // the unsuffixed form must not also appear
  });

  it('two prior aged-out records → \'c\'; a HOLDING (still-alive) record instead refuses the dispatch entirely', () => {
    const twoGone = [goneRun({ runId: 'a', startedAt: isoPlus(NOW, -60) }), goneRun({ runId: 'b', startedAt: isoPlus(NOW, -50) })];
    expect(shapeDispatchRead(tickRead({ inFlightDispatches: inFlightBlock(twoGone) }), { num: '3037' }).sessionSlug).toBe('conveyor-3037c');

    const held = tickRead({ inFlightDispatches: inFlightBlock([inFlightRun()]) });
    const refused = shapeDispatchRead(held, { num: '3037' });
    expect(refused.dispatching).toBe(false); // never reaches attempt-tag computation at all
  });

  it('prepare/prepare-decision kinds never gain a letter — only a fresh build branch needs one', () => {
    const prepareRead = tickRead({
      launchKind: 'prepare',
      launch: { num: '3037', lane: 8 },
      dispatchedGuard: { num: '3037', lane: 8, spawnedTick: 0 },
      inFlightDispatches: inFlightBlock([goneRun({ startedAt: isoPlus(NOW, -60) })]),
    });
    expect(shapeDispatchRead(prepareRead, { num: '3037' }).sessionSlug).toBe('prepare-3037');
  });
});

describe('shapeDispatchRead — refuses a dispatch a real merged PR already shows done (#3457/#3460)', () => {
  const alreadyDonePr = (over = {}) => ({
    number: 1768, url: 'https://github.com/chalbert/web-everything/pull/1768',
    title: 'review-loop-policy: mechanical acceptance from a clean independent verdict (#3434)',
    mergedAt: '2026-09-01T16:44:28Z', ...over,
  });

  it('refuses the dispatch, names the merged PR URL in the reason, and reports alreadyDonePr', () => {
    const pr = alreadyDonePr();
    const v = shapeDispatchRead(tickRead({ alreadyDone: { done: true, pr, checked: true } }), { num: '3037' });
    expect(v.dispatching).toBe(false);
    expect(v.lane).toBeNull();
    expect(v.sessionSlug).toBeNull();
    expect(v.prompt).toBeNull();
    expect(v.alreadyDonePr).toEqual(pr);
    expect(v.holdReason).toContain(pr.url);
    expect(v.holdReason).toContain('already appears CLOSED');
  });

  it('reproduces the REAL #3434 shape end to end: a `prepare-decision` launch, refused on the actual evidence', () => {
    // #3434 was `kind: decision`, `status: open` — the tick core would clear it for a `prepare-decision`
    // dispatch, exactly like the read that follows. #3457's own motivating incident was TWO wasted dispatches
    // against this exact shape; this pins that the guard now catches it.
    const pr = alreadyDonePr();
    const read = tickRead({
      launchKind: 'prepare-decision',
      launch: { num: '3434', lane: 8 },
      dispatchedGuard: { num: '3434', lane: 8, spawnedTick: 0, kind: 'prepare-decision' },
      resolvedNum: '3434',
      item: { num: '3434', slug: 'review-loop-policy-decision', specPath: 'backlog/3434-review-loop-policy-decision.md', scope: ['we:docs/agent/'] },
      alreadyDone: { done: true, pr, checked: true },
    });
    const v = shapeDispatchRead(read, { num: '3434' });
    expect(v.dispatching).toBe(false);
    expect(v.holdReason).toContain('https://github.com/chalbert/web-everything/pull/1768');
    expect(v.holdReason).toContain('prepare-decision');
  });

  it('reproduces the REAL #3433 shape — a plain `build` launch, refused the same way with its own PR', () => {
    const pr = { number: 1829, url: 'https://github.com/chalbert/web-everything/pull/1829', title: 'WE #3433: bake a Bash disallowedTools deny list into every dispatched review session', mergedAt: '2026-09-02T16:31:19Z' };
    const v = shapeDispatchRead(tickRead({ resolvedNum: '3433', alreadyDone: { done: true, pr, checked: true } }), { num: '3433' });
    expect(v.dispatching).toBe(false);
    expect(v.holdReason).toContain('https://github.com/chalbert/web-everything/pull/1829');
  });

  it('an UNCHECKED or nothing-found verdict never blocks a real, legitimately-needed dispatch', () => {
    expect(shapeDispatchRead(tickRead({ alreadyDone: { done: false, pr: null, checked: true } }), { num: '3037' }).dispatching).toBe(true);
    expect(shapeDispatchRead(tickRead({ alreadyDone: { done: false, pr: null, checked: false } }), { num: '3037' }).dispatching).toBe(true);
    expect(shapeDispatchRead(tickRead(), { num: '3037' }).dispatching).toBe(true); // no `alreadyDone` field at all — pre-#3460 fixtures unaffected
  });

  it('takes priority over "not cleared" but does not fire when nothing was cleared (raw.alreadyDone absent by construction)', () => {
    // readTick only ever sets `alreadyDone.done` when a launch existed, so a fixture that claims `done: true`
    // with `launch: null` is not a real shape readTick produces — but the pure function must still not crash
    // or dispatch on it, since it stays defensive regardless of what a future caller hands it.
    const v = shapeDispatchRead(tickRead({ launch: null, launchKind: 'build', suppressed: null, alreadyDone: { done: true, pr: alreadyDonePr(), checked: true } }), { num: '3037' });
    expect(v.dispatching).toBe(false);
    expect(v.holdReason).toContain('already appears CLOSED');
  });

  it('every other exit still reports `alreadyDonePr: null` — the field is on every finding, not just this branch', () => {
    expect(shapeDispatchRead(tickRead(), { num: '3037' }).alreadyDonePr).toBeNull();
    const held = tickRead({ inFlightDispatches: inFlightBlock([inFlightRun()]) });
    expect(shapeDispatchRead(held, { num: '3037' }).alreadyDonePr).toBeNull();
  });
});

// ── #3462: the manual `--num=<N>` path now reads `blockedBy`/`openBlockers` too ────────────────────────────

describe('findItem — carries `openBlockers` through, where it used to be dropped (#3462)', () => {
  it('reads `openBlockers` off the loader record onto the shaped item', () => {
    const it_ = findItem('3398', () => [
      { num: '3398', slug: 'conveyor-supervisor-runner-residency', scope: ['we:scripts/conveyor/'], openBlockers: ['3443'] },
    ]);
    expect(it_.openBlockers).toEqual(['3443']);
  });

  it('defaults to `[]` when the loader record has no `openBlockers` at all (every edge resolved, or none named)', () => {
    const it_ = findItem('3037', () => [
      { num: '3037', slug: 'declare-dispatch', scope: ['we:scripts/operations/'] },
    ]);
    expect(it_.openBlockers).toEqual([]);
  });
});

// ── #xdx3ifb multi-repo slice 3: `findItem` also matches a renamed card's `bornAs` ────────────────────────────
describe('findItem — falls back to `bornAs` when `num` doesn\'t match (#xdx3ifb)', () => {
  // Live shape: WE PR #2518's card `x3izqob` was JIT-renumbered to `#3945` at land (#2288) while its
  // still-open impl-repo branch (`lane/x3izqob-...`) kept naming the pre-rename hash — the fix daemon's own
  // `laneRefItemNum` extraction can only ever produce that hash, never the new number it has no way to learn.
  const renamed = { num: '3945', bornAs: 'x3izqob', slug: 'review-human-advisory-gap', scope: ['we:scripts/conveyor/reconcile-pass.mjs'] };

  it('resolves a hash key against the renamed card\'s `bornAs` when no item\'s `num` matches it', () => {
    const it_ = findItem('x3izqob', () => [renamed]);
    expect(it_).not.toBeNull();
    expect(it_.num).toBe('3945');
    expect(it_.scope).toEqual(['we:scripts/conveyor/reconcile-pass.mjs']);
  });

  it('still prefers a direct `num` match over `bornAs` when both are present (no ambiguity introduced)', () => {
    const it_ = findItem('3945', () => [renamed, { num: 'x3izqob', slug: 'stale-provisional-twin', scope: [] }]);
    expect(it_.num).toBe('3945');
    expect(it_.slug).toBe('review-human-advisory-gap');
  });

  it('still returns null for a hash with no `num` OR `bornAs` match anywhere (a genuinely unknown key)', () => {
    expect(findItem('xnotreal', () => [renamed])).toBeNull();
  });
});

describe('shapeDispatchRead — refuses a dispatch for an item with an unresolved `blockedBy` edge (#3462)', () => {
  // THE REAL #3398 SHAPE: the tick core cleared it for `spawnBuilds` anyway (three times, live, on
  // 2026-09-02) while its own frontmatter carried `blockedBy: ["3443"]`, an item still `status: open`. A
  // fabricated item here stands in for #3398 — no in-flight guard, a free lane, the core having (wrongly)
  // cleared it — to prove the refusal fires on `openBlockers` alone, independent of the core's own decision.
  const blockedRead = (over = {}) => tickRead({
    item: { num: '3037', slug: 'declare-dispatch', specPath: 'backlog/3037-declare-dispatch.md', scope: ['we:scripts/operations/'], openBlockers: ['3443'] },
    ...over,
  });

  it('FAILS AGAINST PRE-FIX CODE: refuses the dispatch and names the open blocker in the reason', () => {
    const v = shapeDispatchRead(blockedRead(), { num: '3037' });
    expect(v.dispatching).toBe(false);
    expect(v.lane).toBeNull();
    expect(v.sessionSlug).toBeNull();
    expect(v.prompt).toBeNull();
    expect(v.openBlockers).toEqual(['3443']);
    expect(v.holdReason).toContain('blocked');
    expect(v.holdReason).toContain('3443');
  });

  it('names every unresolved blocker when there is more than one', () => {
    const v = shapeDispatchRead(blockedRead({
      item: { num: '3037', slug: 'declare-dispatch', specPath: 'backlog/3037-declare-dispatch.md', scope: ['we:scripts/operations/'], openBlockers: ['3443', '3444'] },
    }), { num: '3037' });
    expect(v.dispatching).toBe(false);
    expect(v.holdReason).toContain('3443');
    expect(v.holdReason).toContain('3444');
  });

  it('fires regardless of `launchKind` — a blocked `prepare-decision` is refused exactly like a blocked `build`', () => {
    const v = shapeDispatchRead(blockedRead({ launchKind: 'prepare-decision' }), { num: '3037' });
    expect(v.dispatching).toBe(false);
    expect(v.holdReason).toContain('prepare-decision');
  });

  it('takes priority over "not cleared" — fires even when the core never cleared this item at all', () => {
    // Not the shape `readTick` produces today (the core would have to independently agree the item is
    // blocked), but the refusal must not depend on `launch` being truthy — the whole point is that it does not
    // trust the core's decision on this axis.
    const v = shapeDispatchRead(blockedRead({ launch: null, suppressed: null }), { num: '3037' });
    expect(v.dispatching).toBe(false);
    expect(v.holdReason).toContain('blocked');
  });

  it('is a HARD, UNCONDITIONAL refusal — an unrecognized "force" key on the caller args changes nothing', () => {
    // #3462's recorded decision (see the backlog item's `## Progress`): a manual dispatch may never force a
    // blocked item through, and there is deliberately no flag to ask for one. `shapeDispatchRead`'s second
    // argument is destructured for exactly `num`/`expectedWithinMinutes`, so a caller that hands it an
    // override-shaped extra key is silently ignored rather than honoured.
    const v = shapeDispatchRead(blockedRead(), { num: '3037', force: true, override: 'blockedBy' });
    expect(v.dispatching).toBe(false);
    expect(v.holdReason).toContain('blocked');
  });

  it('an item with every `blockedBy` edge resolved (`openBlockers: []`) dispatches normally', () => {
    expect(shapeDispatchRead(tickRead({
      item: { num: '3037', slug: 'declare-dispatch', specPath: 'backlog/3037-declare-dispatch.md', scope: ['we:scripts/operations/'], openBlockers: [] },
    }), { num: '3037' }).dispatching).toBe(true);
  });

  it('an item with no `openBlockers` field at all dispatches normally — pre-#3462 fixtures unaffected', () => {
    expect(shapeDispatchRead(tickRead(), { num: '3037' }).dispatching).toBe(true);
  });

  it('every other exit still reports `openBlockers: []` — the field is on every finding, not just this branch', () => {
    expect(shapeDispatchRead(tickRead(), { num: '3037' }).openBlockers).toEqual([]);
    const held = tickRead({ inFlightDispatches: inFlightBlock([inFlightRun()]) });
    expect(shapeDispatchRead(held, { num: '3037' }).openBlockers).toEqual([]);
  });
});

describe('readTick — `openBlockers` reaches the read end to end, from `loadItems` through to the refusal (#3462)', () => {
  const TICK = { decisions: { spawnBuilds: [{ num: '3398', lane: 5 }] }, nextState: { tick: 1 } };
  const bindings = {
    runNode: () => JSON.stringify(TICK),
    readText: () => BRIEF,
    loadItems: () => [{ num: '3398', slug: 'conveyor-supervisor-runner-residency', scope: ['we:scripts/conveyor/'], openBlockers: ['3443'] }],
    listAgents: () => [],
    checkAlreadyDone: () => ({ done: false, pr: null, checked: true }),
  };

  it('threads `openBlockers` from the loader onto `item`, and `shapeDispatchRead` refuses on it', () => {
    const out = readTick({ num: '3398', ...bindings });
    expect(out.item.openBlockers).toEqual(['3443']);
    const v = shapeDispatchRead(out, { num: '3398' });
    expect(v.dispatching).toBe(false);
    expect(v.holdReason).toContain('3443');
  });
});


// ── #3637 — the POC delivery target rides the brief as {{DELIVERY_BASE}} ────────────────────────────────────

describe('#3637 — deliveryTarget resolves to the brief\'s {{DELIVERY_BASE}}', () => {
  const REG = { version: 1, branches: [{ branch: 'lane/demo', purpose: 'p', owner: 'o', dateOpened: '2026-09-12', target: 'main', scope: [], graduationItem: null }] };

  it('DELIVERY_BASE is a registered placeholder, required for BUILD only', () => {
    expect(BRIEF_PLACEHOLDERS).toContain('DELIVERY_BASE');
    expect(BRIEF_REQUIRED_BY_KIND.build).toContain('DELIVERY_BASE');
    for (const kind of ['prepare', 'prepare-decision', 'fix', 'ci-heal']) {
      expect(BRIEF_REQUIRED_BY_KIND[kind]).not.toContain('DELIVERY_BASE');
    }
  });

  it('THE REAL BRIEF carries the token — the literal `--base=main` is gone from both the acquire and the open-pr', () => {
    const brief = readFileSync(briefPath(REPO_ROOT, 'build'), 'utf8');
    expect(brief).toMatch(/\{\{DELIVERY_BASE\}\}/);
    expect(brief).not.toMatch(/--base=main\b/);
  });

  it('an item with NO deliveryTarget resolves to main — today\'s behaviour, byte-identical', () => {
    expect(resolveDeliveryBase(null, '3037', REG)).toBe('main');
    expect(resolveDeliveryBase('main', '3037', REG)).toBe('main');
  });

  it('a REGISTERED POC branch resolves to that branch, either spelling', () => {
    expect(resolveDeliveryBase('lane/demo', '3037', REG)).toBe('lane/demo');
    expect(resolveDeliveryBase('origin/lane/demo', '3037', REG)).toBe('lane/demo');
  });

  it('an UNREGISTERED branch REFUSES the dispatch rather than forking a lane from a ref that may not exist', () => {
    expect(() => resolveDeliveryBase('lane/never-declared', '3037', REG)).toThrow(/not a registered POC branch/);
  });

  it('a resolved POC branch survives BRIEF_VALUE_RE — it is pasted unquoted into a shell command', () => {
    expect(BRIEF_VALUE_RE.test('lane/mechanical-dispatcher')).toBe(true);
  });
});

it('tags sibling PR dispatches', () => {
  expect(sessionSlugFor(3, 'fix', 49, '', 'frontierui')).toBe('fix-fui-49');
  expect(sessionSlugFor(3, 'ci-heal', 49, '', 'plateau-app')).toBe('ci-heal-pa-49');
});
