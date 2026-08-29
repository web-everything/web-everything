/**
 * @file dispatch-crosses-processes.test.mjs — #3037's second acceptance clause, end to end.
 *
 * *"The launched agent's handle is recorded on the run so the conveyor can find it after a restart."* A
 * restart is a PROCESS boundary, so proving it needs one: the dispatch happens here, and every observation
 * happens in a **real second `node` process** that is handed nothing but a run id and a directory and
 * rehydrates everything else off disk — the same technique, and the same reason, as
 * `./run-crosses-processes.test.mjs`.
 *
 * The child runs the REAL observer (`we:scripts/operations/dispatch-lane-io.mjs`) against the REAL registry
 * resolved from the record's own operation name. Both of the observer's READS are stubbed through env vars —
 * the `claude agents --json` liveness listing and (since #x9ylkp7) the `gh pr list` PR listing. No `claude`
 * process is started by this suite, no agent is ever launched, and no network call is made.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import { advanceWhileRunning, runStatus, startRun } from '../engine.mjs';
import { applyPendingEffects } from '../effect-executor.mjs';
import { createFileRunStore } from '../run-store.mjs';
import { createRegistry } from '../registry.mjs';
import { DISPATCH_LANE_OP, dispatchLaneOperation } from '../dispatch-lane.mjs';
import { createDispatchSinks } from '../dispatch-lane-io.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SCRIPT = resolve(HERE, '..', '__fixtures__', 'observe-dispatch.mjs');
const RUN_ID = 'run-dispatch-xproc';
const HANDLE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
// #3331: `entry.handle` is the SHORT id the CLI's own `--bg` confirmation carries, a genuine prefix of the
// full id. `HANDLE` stays the FULL id used in `FIXTURE_AGENTS` (realistic — what `claude agents --json`
// actually reports); `SHORT_HANDLE` is what the sink now records and what dispatch-side assertions compare.
const SHORT_HANDLE = HANDLE.split('-')[0];
/** A fake `--bg` confirmation carrying `shortId`, shaped exactly like the real CLI's (#3331). */
const bgStdout = (shortId, name = 'conveyor-3037') => `backgrounded · ${shortId} · ${name}\n`;

const BRIEF = 'build #{{ITEM_NUM}} at {{ITEM_SPEC_PATH}} in lane {{LANE}} as {{SESSION_SLUG}} scoped {{SCOPE}}';
/** A PRIMARY checkout — the sink refuses to dispatch from a lane clone, which is what the default resolves to here. */
const PRIMARY = '/primary/webeverything';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'we-op-dispatch-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Dispatch #3037 onto the lane the (stubbed) tick core assigned, and leave the record on disk. */
async function dispatchAndPark({ startedAt = '2026-08-13T09:00:00.000Z' } = {}) {
  const registry = createRegistry();
  registry.register(dispatchLaneOperation({
    readTick: () => ({
      resolvedNum: '3037',
      launch: { num: '3037', lane: 8 },
      suppressed: null,
      item: { num: '3037', slug: 'declare-dispatch', specPath: 'backlog/3037-declare-dispatch.md', scope: ['we:scripts/operations/'] },
      briefTemplate: BRIEF,
      nextState: { tick: 1, buildGuards: [{ num: '3037', lane: 8, spawnedTick: 0 }] },
      statusLine: 'conveyor · 1 building',
      notes: [],
      bookkeepingSource: 'file',
    }),
  }));

  const store = createFileRunStore(dir);
  let run = advanceWhileRunning(startRun({ op: DISPATCH_LANE_OP, id: RUN_ID, input: { num: '3037' }, registry }), { registry });
  expect(runStatus(run, { registry })).toBe('awaiting-effect');

  // The one thing stubbed on THIS side: `claude --bg` is not run. Everything else — the in-flight write, the
  // handle, the deadline — is the real executor and the real sink.
  const sinks = createDispatchSinks({
    root: PRIMARY, spawnAgent: () => bgStdout(SHORT_HANDLE), mintSessionId: () => HANDLE, now: () => new Date('2026-08-13T09:00:00.000Z'),
  });
  const outcome = await applyPendingEffects(run, { sinks, store });
  run = outcome.run;
  expect(run.effects[0].status).toBe('in-flight');

  // AGE THE DISPATCH past the observer's listing-grace window. A just-started session is legitimately still
  // `running` even when absent from the listing (`--bg` returns before the listing settles), and every case
  // below is about a dispatch old enough for that grace to have expired.
  run = { ...run, effects: run.effects.map((e) => ({ ...e, startedAt })) };
  store.write(run);
  return run;
}

/** Observe in a FRESH process that has never seen the run. Returns its parsed stdout. */
function observeInChild(env = {}) {
  const stdout = execFileSync(process.execPath, [OBSERVE_SCRIPT, RUN_ID], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // BOTH READS DEFAULT TO EMPTY. `FIXTURE_PRS: '[]'` is load-bearing rather than tidy: without it the child
    // shells a REAL `gh pr list` and the verdict of this suite depends on the live state of whatever repo it
    // is checked out in. `[]` is the honest default here — these cases are about a dispatch with no PR.
    env: { ...process.env, OPERATION_RUNS_DIR: dir, FIXTURE_AGENTS: '[]', FIXTURE_PRS: '[]', ...env },
  });
  return JSON.parse(stdout);
}

describe('a dispatch started here is found by a process that never saw it', () => {
  it('the second process reads the handle, the lane and the brief off disk', async () => {
    await dispatchAndPark();
    const seen = observeInChild({ FIXTURE_AGENTS: JSON.stringify([{ sessionId: HANDLE, kind: 'background' }]) });

    // THE ACCEPTANCE CLAUSE: nothing but a run id crossed the boundary, and the handle came back.
    expect(seen.handle).toBe(HANDLE);
    expect(seen.lane).toBe(8);
    expect(seen.expectedBy).toBe('2026-08-13T10:30:00.000Z');
    // The brief the agent was dispatched with is on the record too, so a restart knows what it asked for.
    expect(seen.promptBytes).toBeGreaterThan(0);
    // The session is live, so the run stays exactly where it was.
    expect(seen.stillRunning).toEqual(['run-dispatch-xproc#2#0']);
    expect(seen.status).toBe('awaiting-effect');
    expect(seen.effects).toEqual([{ key: 'run-dispatch-xproc#2#0', status: 'in-flight', handle: HANDLE }]);
  });

  it('a handle no longer listed is reported for a person, and NOTHING is written', async () => {
    await dispatchAndPark();
    const seen = observeInChild({ FIXTURE_AGENTS: JSON.stringify([{ sessionId: 'a-different-session' }]) });

    expect(seen.resolved).toEqual([]);
    expect(seen.unresolved).toHaveLength(1);
    expect(seen.unresolved[0].error).toMatch(/liveness and not outcome/);
    // Still in-flight, still holding its handle: `unresolved` licenses no caller to retry or advance.
    expect(seen.effects[0]).toMatchObject({ status: 'in-flight', handle: HANDLE });
    expect(seen.status).toBe('awaiting-effect');
  });

  it('and the record on disk agrees — a THIRD process sees the same unresolved dispatch', async () => {
    await dispatchAndPark();
    observeInChild();
    const again = observeInChild();
    expect(again.handle).toBe(HANDLE);
    expect(again.effects[0].status).toBe('in-flight');
    // The reason the previous pass recorded survives, which is the only durable trace of why it is stuck.
    expect(createFileRunStore(dir).read(RUN_ID).effects[0].observedError).toMatch(/liveness and not outcome/);
  });

  it('#x9ylkp7: the REAL observer resolves it across the boundary when the item\'s PR has MERGED', async () => {
    // The clause this item adds, proven where it matters: a process that never dispatched, holding nothing but
    // a run id, reads the PR axis and closes the entry out with no person involved. Nothing is stubbed here
    // except the two listings — the observer, the registry and the store are the real ones.
    await dispatchAndPark();
    const seen = observeInChild({
      FIXTURE_AGENTS: '[]', // the session is already gone: liveness ALONE would still say `unresolved`
      FIXTURE_PRS: JSON.stringify([{
        number: 4242, headRefName: 'lane/3037-declare-dispatch', state: 'MERGED',
        mergedAt: '2026-08-13T09:30:00.000Z', labels: [], // AFTER the entry's startedAt (09:00) — attributable
      }]),
    });
    expect(seen.unresolved).toEqual([]);
    expect(seen.resolved).toEqual([{ key: 'run-dispatch-xproc#2#0', type: 'conveyor.dispatch-delivery-agent', status: 'succeeded', recordedAs: 'applied' }]);
    expect(seen.effects[0].status).toBe('applied');
    expect(seen.status).toBe('complete');
    expect(createFileRunStore(dir).read(RUN_ID).effects[0].result).toMatchObject({ resolvedBy: 'pr-merged', pr: 4242 });
  });

  it('#x9ylkp7: a PREVIOUS attempt\'s merged PR does NOT resolve it — the stale guard holds across processes too', async () => {
    await dispatchAndPark();
    const seen = observeInChild({
      FIXTURE_AGENTS: '[]',
      FIXTURE_PRS: JSON.stringify([{
        number: 4241, headRefName: 'lane/3037-declare-dispatch', state: 'MERGED',
        mergedAt: '2026-08-12T09:30:00.000Z', labels: [], // a DAY before this entry started
      }]),
    });
    expect(seen.resolved).toEqual([]);
    expect(seen.unresolved[0].error).toMatch(/PREVIOUS attempt/);
    expect(seen.effects[0]).toMatchObject({ status: 'in-flight', handle: HANDLE });
  });

  it('an outcome that DOES resolve it completes the run in that other process', async () => {
    await dispatchAndPark();
    // A terminal answer with neither axis involved — the child stubs the observer outright. What is being
    // proven is the RESUME path itself: a terminal answer arriving in a process that never dispatched marks
    // the entry `applied` and advances the run to completion.
    const seen = observeInChild({ FIXTURE_OBSERVATION: 'succeeded' });
    expect(seen.resolved).toEqual([{ key: 'run-dispatch-xproc#2#0', type: 'conveyor.dispatch-delivery-agent', status: 'succeeded', recordedAs: 'applied' }]);
    expect(seen.status).toBe('complete');
    expect(seen.effects[0].status).toBe('applied');

    // …and the effect step's finding records what the dispatch produced, so a later step could read it.
    const onDisk = createFileRunStore(dir).read(RUN_ID);
    expect(onDisk.findings.dispatch.applied).toBe(true);
  });
});
