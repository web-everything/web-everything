/**
 * @file dispatch-lane-fixture-harness.test.mjs — the dispatcher fixture-root harness, ONE HOP FURTHER (#3446).
 *
 * `scripts/conveyor/__tests__/dispatcher-fixture-harness.test.mjs` (#3445) chained `backlog.mjs build-queue` →
 * `conveyor-state.mjs` → `dispatch-plan.mjs` → `tick-core.mjs`'s `planTick` against a synthetic `mkdtemp`
 * backlog corpus, and stopped at the tick core's OWN decision (`decisions.spawnBuilds`). Nothing chained past
 * it into `dispatch-lane.mjs` / `dispatch-lane-io.mjs` — the REAL argv-building
 * ({@link import('../dispatch-lane-io.mjs').buildAgentArgv}) and guard logic
 * ({@link import('../dispatch-lane-io.mjs').assertNotALaneCheckout}, the double-dispatch hold
 * `dispatchStillHolds` guards) had never been driven against a fixture at all — only against hand-written
 * stubs (`dispatch-lane.test.mjs`) or a live process with a hand-built payload (`dispatch-spawn-live.test.mjs`).
 * This file is that hop: it drives `dispatch-lane-io.mjs`'s REAL `readTick` (its own item lookup, its own
 * run-store-backed double-dispatch guard, its own already-done ground-truth check) against the SAME KIND of
 * fixture corpus #3445 built, and REAL `createDispatchSinks` with `withFakeClaude()`
 * (`scripts/operations/__tests__/helpers/fake-claude.mjs`) on `PATH` — never an injected `spawnAgent` — so the
 * argv the real `claude` CLI would see is asserted, not assumed.
 *
 * WHAT IS SIDESTEPPED, and why — stated precisely because "sidestepped" is easy to overstate. `tick-core.mjs`'s
 * CLI shells `dispatch-plan.mjs`, which reads the session-local queue sidecar, re-enriches via
 * `backlog.mjs build-queue`, runs its own already-done check, and only THEN calls its pure `dispatchPlan` with
 * the REAL free-lane list from `lane-pool.mjs list --acquirable --json` — a count that is real on the machine
 * running this suite and can be zero, which would make the launch decision flaky. This file does not run
 * `dispatch-plan.mjs` at all: it calls `planTick` (`tick-core.mjs`'s own exported, pure core — the REAL
 * function) directly, fed the REAL `state` this fixture's `backlog.mjs` + `conveyor-state.mjs` subprocesses
 * produced, with a HAND-BUILT `plan.launch` row standing in for the whole of `dispatch-plan.mjs`'s decision
 * (not merely its lane-pool call). So this harness proves `dispatch-lane(-io).mjs`'s argv-building and guard
 * logic against an ASSUMED-correct launch row — it does not prove `dispatch-plan.mjs` would itself select this
 * item; that half is #3445's own harness's job. Everything past the assumed launch row —
 * `dispatch-lane-io.mjs#readTick`'s item lookup, its run-store-backed in-flight guard, its already-done check,
 * `dispatch-lane.mjs#shapeDispatchRead`, and `dispatch-lane-io.mjs#createDispatchSinks`
 * (`assertNotALaneCheckout`, `buildAgentArgv`, the real `defaultSpawnAgent` through the fake `claude` on
 * `PATH`) — runs for real, unstubbed.
 *
 * ZERO REAL SESSIONS, ZERO REAL BACKLOG ITEMS OR PRs. `withFakeClaude()` costs no token and starts no model —
 * and `fake.assertWins(env)` is asserted before the one real spawn in this file, so a bug in the env-merge
 * chain fails loudly here rather than quietly reaching whatever `claude` the host has (mirrors
 * `dispatch-spawn-live.test.mjs`'s own guard). `withFakeGh()` answers every `gh` call from this repo's
 * readiness/tick machinery; the run store lives in a throwaway `mkdtemp` directory, never `.operations/runs/`
 * in a real checkout; and the backlog corpus is the synthetic one this file writes, never `backlog/`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { withFakeGh } from '../../conveyor/__tests__/helpers/fake-gh.mjs';
import { withNodeSpy } from '../../conveyor/__tests__/helpers/node-spy.mjs';
import { withFakeClaude } from './helpers/fake-claude.mjs';
import { planTick } from '../../conveyor/tick-core.mjs';
import {
  readTick, REPO_ROOT, createDispatchSinks, defaultListAgents,
  inFlightDispatchesFor, persistLastSeenLive,
} from '../dispatch-lane-io.mjs';
import { shapeDispatchRead, DISPATCH_EFFECT } from '../dispatch-lane.mjs';
import { createFileRunStore } from '../run-store.mjs';
import { isInFlightResult } from '../effect-executor.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const BACKLOG_CLI = join(ROOT, 'scripts', 'backlog.mjs');
const STATE_CLI = join(ROOT, 'scripts', 'readiness', 'conveyor-state.mjs');

const NUM = '9001';
const FAKE_LANE = 901;
const NOW = new Date('2026-01-01T12:00:00.000Z');

/** Write one fixture backlog item — mirrors `dispatcher-fixture-harness.test.mjs` (#3445). */
function writeItem(dir, filename, frontmatter, title) {
  const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  writeFileSync(join(dir, filename), `---\n${fm}\n---\n\n# ${title}\n`, 'utf8');
}

/** The fake's PATH-prefix directory — every fake shapes its `env.PATH` as `${dir}:${...}`. */
const fakeDir = (env) => env.PATH.split(':')[0];

/** A run record `createFileRunStore` will accept — mirrors `dispatch-lane-integration.test.mjs`'s own fixture. */
function inFlightRecord({ id, num, handle, startedAt, expectedBy }) {
  return {
    v: 1,
    id,
    op: 'dispatch-lane',
    input: { num: String(num) },
    cursor: 2,
    findings: {},
    verdict: null,
    effects: [{
      key: `${id}#2#0`,
      stepIndex: 2,
      index: 0,
      type: DISPATCH_EFFECT,
      status: 'in-flight',
      handle,
      startedAt,
      expectedBy,
      payload: { num },
    }],
    telemetry: [],
    pending: null,
  };
}

/** Seed the fake `claude`'s own `agents --json` listing with a session, without ever starting one for real. */
function seedFakeClaudeSession(fakeClaude, sessionId) {
  const log = JSON.parse(readFileSync(fakeClaude.env.FAKE_CLAUDE_LOG, 'utf8'));
  log.sessions.push({
    id: String(sessionId).slice(0, 8), sessionId, name: `conveyor-${NUM}`, kind: 'background', state: 'running', cwd: '/tmp',
  });
  writeFileSync(fakeClaude.env.FAKE_CLAUDE_LOG, JSON.stringify(log));
}

describe('dispatch-lane fixture-root harness — REAL argv-building + guard logic against the fixture (#3446)', () => {
  let fixtureRoot;
  let backlogDir;
  let fakeGh;
  let decisions;
  let nextState;

  // ONE fixture, ONE real backlog.mjs + conveyor-state.mjs subprocess pair, shared by every case below — the
  // launch decision (`decisions.spawnBuilds`) and its guard entry (`nextState.buildGuards`) do not vary
  // per case, only the run-store / fake-claude state each case drives past them.
  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'dispatch-lane-fixture-'));
    backlogDir = join(fixtureRoot, 'backlog');
    mkdirSync(backlogDir, { recursive: true });
    fakeGh = withFakeGh({ prs: [] });

    writeItem(backlogDir, `${NUM}-ready-item.md`, {
      bornAs: 'x9001fix', kind: 'story', size: 2, status: 'open',
      scope: ['we:scripts/fixture-thing.mjs'], dateOpened: '2026-01-01', tags: [],
    }, 'An open, build-ready fixture item');

    // #x7xv2xt — a `node` spy first on PATH records every script conveyor-state shells, so the test can prove
    // `--backlog-dir` kept it off the real lane pool (it used to run `lane-pool.mjs status` + a per-lane scan).
    const nodeSpy = withNodeSpy();
    const env = {
      ...process.env, ...fakeGh.env,
      PATH: `${nodeSpy.env.PATH.split(':')[0]}:${fakeGh.env.PATH}`, NODE_SPY_LOG: nodeSpy.env.NODE_SPY_LOG,
    };
    const bq = JSON.parse(execFileSync(
      'node', [BACKLOG_CLI, 'build-queue', '--json', `--backlog-dir=${backlogDir}`],
      { encoding: 'utf8', env },
    ));
    expect(bq.queue.map((r) => String(r.num))).toEqual([NUM]);

    const spyMark = nodeSpy.scripts().length;
    let state;
    try {
      state = JSON.parse(execFileSync(
        process.execPath, [STATE_CLI, '--json', `--backlog-dir=${backlogDir}`, '--repo=fixture-org/fixture-repo'],
        { encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024 },
      ));
      const started = nodeSpy.scripts().slice(spyMark);
      expect(started.some((p) => p.endsWith('backlog.mjs'))).toBe(true); // the spy is on the children's path
      expect(started.filter((p) => /lane-pool\.mjs$|scope-lease-collect\.mjs$/.test(p))).toEqual([]);
      expect(state.lanePool).toBe('skipped');
    } finally {
      nodeSpy.cleanup();
    }

    // `plan.launch` HAND-BUILT, standing in for the whole of `dispatch-plan.mjs`'s decision — see the file
    // header's "WHAT IS SIDESTEPPED" section. `planTick` itself is the REAL, exported core.
    const out = planTick({
      state,
      plan: { launch: [{ num: NUM, lane: FAKE_LANE }], held: [] },
      freeLanes: [FAKE_LANE],
      bookkeeping: { tick: 1, launchedNums: [] },
    });
    decisions = out.decisions;
    nextState = out.nextState;
    expect(decisions.spawnBuilds).toEqual([{ num: NUM, lane: FAKE_LANE }]);
  }, 60_000);

  afterAll(() => {
    fakeGh.cleanup();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  /**
   * One case's isolated fakes + `readTick` binding. Every seam is pointed at THIS case's fakes/temp dirs —
   * never the real `gh`/`claude`/run store — and `cleanup()` tears them down. Callers MUST call `cleanup()` in
   * a `finally`.
   */
  function setUpCase() {
    const caseRoot = mkdtempSync(join(tmpdir(), 'dispatch-lane-case-'));
    const runsDir = join(caseRoot, 'runs');
    mkdirSync(runsDir, { recursive: true });
    const fakeClaude = withFakeClaude();
    const combinedEnv = {
      ...process.env,
      PATH: `${fakeDir(fakeClaude.env)}:${fakeDir(fakeGh.env)}:${process.env.PATH}`,
      FAKE_CLAUDE_LOG: fakeClaude.env.FAKE_CLAUDE_LOG,
      FAKE_GH_FIXTURE: fakeGh.env.FAKE_GH_FIXTURE,
      FAKE_GH_LOG: fakeGh.env.FAKE_GH_LOG,
    };
    // #x8mpubm follow-up — `defaultSpawnAgent` now ALWAYS supplies its own `env` (GH_TOKEN/GITHUB_TOKEN
    // stripped; see `gh-app-shim.mjs#sanitizeSpawnEnv`), where before this file it never set one at all. This
    // fixture's OWN routing keys (`PATH` pointing at the fakes, `FAKE_CLAUDE_LOG`/`FAKE_GH_*`) must win
    // regardless — that is the entire point of the harness (see `fakeClaude.assertWins`) — so `combinedEnv`
    // goes LAST. Whatever else the code under test puts in its own `env` (like the token-stripping) still
    // comes through for every key `combinedEnv` does not itself define.
    const fakeExec = (cmd, args, opts = {}) => execFileSync(cmd, args, { ...opts, env: { ...opts.env, ...combinedEnv } });

    return {
      caseRoot, runsDir, fakeClaude, combinedEnv, fakeExec,
      /** One `readTick` call against this case's fixtures. */
      readFixtureTick: () => readTick({
        num: NUM,
        root: REPO_ROOT, // the real checkout — so the brief filled below is the REAL delivery-agent-brief.md
        exec: fakeExec,
        runNode: () => JSON.stringify({ decisions, nextState }),
        loadItems: () => [{ num: NUM, slug: 'ready-item', scope: ['we:scripts/fixture-thing.mjs'], openBlockers: [] }],
        listInFlightDispatches: (key) => inFlightDispatchesFor(key, { store: createFileRunStore(runsDir) }),
        listAgents: () => defaultListAgents({ exec: fakeExec, env: combinedEnv }),
        recordLiveness: (stamped) => {
          persistLastSeenLive(stamped, { store: createFileRunStore(runsDir), now: () => NOW });
          return stamped;
        },
        now: () => NOW,
      }),
      cleanup: () => {
        fakeClaude.cleanup();
        rmSync(caseRoot, { recursive: true, force: true });
      },
    };
  }

  it('dispatches #9001 for real — the produced argv matches the fixture-derived brief', async () => {
    const kase = setUpCase();
    try {
      const raw = kase.readFixtureTick();
      const read = shapeDispatchRead(raw, { num: NUM, expectedWithinMinutes: 90 });

      expect(read.dispatching).toBe(true);
      expect(read.lane).toBe(FAKE_LANE);
      expect(read.sessionSlug).toBe(`conveyor-${NUM}`);
      expect(read.itemSpecPath).toBe(`backlog/${NUM}-ready-item.md`);
      expect(read.scope).toEqual(['we:scripts/fixture-thing.mjs']);
      // THE REAL BRIEF, FILLED — every fixture-derived value lands in the real delivery-agent-brief.md text.
      expect(read.prompt).toContain(`#${NUM}`);
      expect(read.prompt).toContain(`backlog/${NUM}-ready-item.md`);
      expect(read.prompt).toContain(`--lane=${FAKE_LANE}`);
      expect(read.prompt).toContain(`conveyor-${NUM}`);
      expect(read.prompt).toContain('we:scripts/fixture-thing.mjs');

      // THE DISPATCH EFFECT'S PAYLOAD — the same fields `dispatch-lane.mjs`'s own `dispatch` step reads off
      // `read` (`shapeDispatchRead`'s own docblock: these ride the effect payload without re-deriving them).
      const payload = {
        num: read.num, launchKind: read.launchKind, lane: read.lane, sessionSlug: read.sessionSlug,
        itemSpecPath: read.itemSpecPath, scope: read.scope, prompt: read.prompt,
        expectedWithinMinutes: read.expectedWithinMinutes, pr: read.pr, reason: read.reason,
      };

      const happyRoot = join(kase.caseRoot, 'primary-checkout'); // NOT lane-shaped — assertNotALaneCheckout must pass
      mkdirSync(happyRoot, { recursive: true });
      const sinks = createDispatchSinks({ root: happyRoot, exec: kase.fakeExec });

      // THE FAKE MUST ACTUALLY WIN PATH before the one real spawn in this file — see `dispatch-spawn-live.test.mjs`'s
      // own reasoning: without this, a bug anywhere in `combinedEnv`'s merge silently reaches whatever `claude`
      // the host has, and for a `--bg` argv that is a real background agent on a machine with the real CLI installed.
      kase.fakeClaude.assertWins(kase.combinedEnv);
      const result = await sinks[DISPATCH_EFFECT](payload);

      expect(isInFlightResult(result)).toBe(true);
      expect(result.handle).toBeTruthy();

      const seen = kase.fakeClaude.lastArgv();
      expect(seen).toContain('--bg');
      // #3331 — the handle is no longer something the argv pins. `claude --bg` discards `--session-id`, so the
      // argv must not carry it, and `result.handle` is the id the CLI itself printed (the shim models both).
      expect(seen).not.toContain('--session-id');
      expect(result.handle).toBeTruthy();
      expect(seen[seen.indexOf('-n') + 1]).toBe(`conveyor-${NUM}`);
      expect(seen[seen.length - 1]).toBe(read.prompt);
    } finally {
      kase.cleanup();
    }
  }, 60_000);

  it('assertNotALaneCheckout refuses the dispatch — zero claude sessions spawned', async () => {
    const kase = setUpCase();
    try {
      const raw = kase.readFixtureTick();
      const read = shapeDispatchRead(raw, { num: NUM, expectedWithinMinutes: 90 });
      expect(read.dispatching).toBe(true);

      const payload = {
        num: read.num, launchKind: read.launchKind, lane: read.lane, sessionSlug: read.sessionSlug,
        itemSpecPath: read.itemSpecPath, scope: read.scope, prompt: read.prompt,
        expectedWithinMinutes: read.expectedWithinMinutes, pr: read.pr, reason: read.reason,
      };

      // A root whose BASENAME is `lane-<digits>` — exactly the shape `we:scripts/lane-pool.mjs` creates and
      // `assertNotALaneCheckout` refuses (the agent's own first brief step: acquiring a SECOND lane from
      // inside one nests two checkouts).
      const laneRoot = join(kase.caseRoot, 'lane-42');
      mkdirSync(laneRoot, { recursive: true });
      const sinks = createDispatchSinks({ root: laneRoot, exec: kase.fakeExec });

      await expect(sinks[DISPATCH_EFFECT](payload)).rejects.toThrow(/lane checkout/);
      // NOTHING WAS SPAWNED — the guard fires before `buildAgentArgv`/`spawnAgent` ever runs.
      expect(kase.fakeClaude.lastArgv()).toBeNull();
    } finally {
      kase.cleanup();
    }
  }, 60_000);

  it('the double-dispatch guard holds while the prior dispatch is LIVE — no second agent for an occupied lane', async () => {
    const kase = setUpCase();
    try {
      const handle = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const store = createFileRunStore(kase.runsDir);
      store.write(inFlightRecord({
        id: 'prior-run', num: NUM, handle,
        startedAt: NOW.toISOString(),
        expectedBy: new Date(NOW.getTime() + 90 * 60_000).toISOString(),
      }));
      // The fake claude's OWN listing says this handle is still running — never a real session, never a
      // real spawn — so `dispatchStillHolds` takes its `live === true` branch, which holds AT ANY AGE.
      seedFakeClaudeSession(kase.fakeClaude, handle);

      const raw = kase.readFixtureTick();
      const read = shapeDispatchRead(raw, { num: NUM, expectedWithinMinutes: 90 });

      expect(read.dispatching).toBe(false);
      expect(read.holdReason).toMatch(/already has a dispatch in flight/);
      expect(read.holdReason).toMatch(/STILL LISTED/);
      expect(read.prompt).toBeNull();
      // This test never calls `createDispatchSinks` at all, so "nothing spawned" holds by construction here —
      // what this DOES prove is that `readTick`'s own claude usage was exactly the guard's one listing read
      // (`agents --json`), i.e. the hold was decided from a REAL listing, not assumed.
      expect(kase.fakeClaude.lastArgv()).toEqual(['agents', '--json']);
    } finally {
      kase.cleanup();
    }
  }, 60_000);

  it('the guard (the "backoff") releases once a not-live hold ages past the listing grace window', async () => {
    const kase = setUpCase();
    try {
      const handle = 'ffffffff-1111-2222-3333-444444444444';
      const store = createFileRunStore(kase.runsDir);
      // STARTED WELL PAST THE GUARD'S OWN LISTING-GRACE WINDOW (10 minutes, `DISPATCH_GUARD_LISTING_GRACE_MINUTES`)
      // — never confirmed alive, so `dispatchStillHolds` anchors on `startedAt`.
      store.write(inFlightRecord({
        id: 'stale-run', num: NUM, handle,
        startedAt: new Date(NOW.getTime() - 20 * 60_000).toISOString(),
        expectedBy: new Date(NOW.getTime() - 15 * 60_000).toISOString(),
      }));
      // NO session seeded — the fake claude's real listing read comes back empty, so the guard's own liveness
      // check (not a stub) answers `live: false`: a listing was genuinely read and this handle is not in it.

      const raw = kase.readFixtureTick();
      const read = shapeDispatchRead(raw, { num: NUM, expectedWithinMinutes: 90 });

      // THE HOLD RELEASED — the prior dispatch aged out, and a fresh one is cleared exactly as if none had
      // ever run. This is the "backoff" clearing: the guard's own window, not a human, un-blocks the item.
      expect(read.dispatching).toBe(true);
      expect(read.lane).toBe(FAKE_LANE);
      // The aged-out record rides the verdict rather than vanishing — an operator can still see it.
      expect(read.agedOutRuns.map((r) => r.runId)).toEqual(['stale-run']);
    } finally {
      kase.cleanup();
    }
  }, 60_000);
});
