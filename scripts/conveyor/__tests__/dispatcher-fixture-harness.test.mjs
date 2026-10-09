/**
 * @file scripts/conveyor/__tests__/dispatcher-fixture-harness.test.mjs
 * @description The dispatcher FIXTURE-ROOT HARNESS (#3445, epic #3402/#2274). #3402 ruled that validating a
 *   change to the dispatcher machinery itself must run against a throwaway `mkdtemp` fixture, never real
 *   backlog items / real PRs / real shared state — but until this file, nothing actually chained the three
 *   layers (`backlog.mjs build-queue` → `conveyor-state.mjs` → `dispatch-plan.mjs` → `tick-core.mjs`'s
 *   `planTick`) against one. It exercises the `--backlog-dir` override (`backlog.mjs`, `dispatch-plan.mjs`,
 *   `conveyor-state.mjs`, threaded further into `tick-core.mjs`'s own shell) added alongside it, plus the
 *   `--repo` gap closed on `conveyor-state.mjs`'s `gh pr list` call, via {@link withFakeGh} (mirrors
 *   `scripts/operations/__tests__/helpers/fake-claude.mjs`) so the PR picture is synthetic too.
 *
 *   The synthetic corpus covers the four cases #3445 names: an OPEN build-ready item (#9001), a BLOCKED item
 *   (#9002, `blockedBy` an unresolved id), and two items already `active` with an in-flight PR each — one
 *   carrying `review:changes` (#9003) and one whose required check has gone red after a green open (#9004).
 *
 *   NO REAL LANE POOL (#x7xv2xt). `--backlog-dir` puts `conveyor-state.mjs` and `dispatch-plan.mjs` in fixture
 *   mode: neither shells `lane-pool.mjs` or `scope-lease-collect.mjs` (both scan every real lane), and
 *   dispatch-plan takes its free lanes from `--free-lanes=`. This used to shell the real pool, and test-spawned
 *   runs were observed scanning ~129 real lanes for up to an hour, some orphaned after vitest died. A `node`
 *   spy on `PATH` ({@link withNodeSpy}) records every script the CLIs start, and the test asserts neither
 *   pool script is among them. The fix/CI-heal decisions are asserted by calling `planTick` (the PURE
 *   core) directly with a synthetic `freeLanes` + `bookkeeping.launchedNums`, sidestepping the real lane pool
 *   entirely for that half of the chain (a prior-tick "this conveyor already launched #9003/#9004" is supplied
 *   the way the real bookkeeping would carry it across ticks — `planFixSpawns`/`planCiHealSpawns` both gate on
 *   `launchedNums`, never spawning a fix/heal for a PR the conveyor didn't itself launch).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { withFakeGh } from './helpers/fake-gh.mjs';
import { withNodeSpy } from './helpers/node-spy.mjs';
import { planTick } from '../tick-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const BACKLOG_CLI = join(ROOT, 'scripts', 'backlog.mjs');
const STATE_CLI = join(ROOT, 'scripts', 'readiness', 'conveyor-state.mjs');
const PLAN_CLI = join(ROOT, 'scripts', 'readiness', 'dispatch-plan.mjs');

/** Write one fixture backlog item — frontmatter (JSON values are valid YAML) + a one-line body. */
function writeItem(dir, filename, frontmatter, title) {
  const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  writeFileSync(join(dir, filename), `---\n${fm}\n---\n\n# ${title}\n`, 'utf8');
}

describe('dispatcher fixture-root harness — conveyor-state → dispatch-plan → tick-core against a synthetic corpus (#3445)', () => {
  it('threads --backlog-dir + --repo through the whole chain and derives the right holds/spawns', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'dispatcher-fixture-'));
    const backlogDir = join(fixtureRoot, 'backlog');
    mkdirSync(backlogDir, { recursive: true });
    const queueFile = join(fixtureRoot, 'queue.json');
    const fakeGh = withFakeGh({
      prs: [
        {
          number: 501, state: 'OPEN', headRefName: 'lane/9003-inflight-review-changes',
          labels: [{ name: 'review:changes' }],
          statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
          mergeStateStatus: 'CLEAN',
        },
        {
          number: 502, state: 'OPEN', headRefName: 'lane/9004-red-ci',
          labels: [{ name: 'ready-to-merge' }], // #2666 wasGreenAtOpen — went red AFTER a green open
          statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }],
          mergeStateStatus: 'CLEAN',
        },
      ],
    });

    const nodeSpy = withNodeSpy();

    try {
      writeItem(backlogDir, '9001-ready-item.md', {
        // card #4470 — a truly BUILD-READY item now also carries a truthful `preparedDate`; without one the
        // live daemon's default `preparePolicy` (`dispatch-plan.mjs`'s own IO shell, opted in unconditionally)
        // holds it `needs-prepare` instead of launching, which this fixture's own assertions below would catch.
        bornAs: 'x9001fix', kind: 'story', size: 2, status: 'open', preparedDate: '2026-01-01',
        scope: ['we:scripts/fixture-thing.mjs'], dateOpened: '2026-01-01', tags: [],
      }, 'An open, build-ready fixture item');
      writeItem(backlogDir, '9002-blocked-item.md', {
        bornAs: 'x9002fix', kind: 'story', size: 2, status: 'open',
        scope: ['we:scripts/fixture-thing2.mjs'], blockedBy: ['9099'], dateOpened: '2026-01-01', tags: [],
      }, 'A blocked fixture item');
      writeItem(backlogDir, '9003-inflight-review-changes.md', {
        bornAs: 'x9003fix', kind: 'story', size: 2, status: 'active',
        scope: ['we:scripts/fixture-thing3.mjs'], dateOpened: '2026-01-01', dateStarted: '2026-01-02', tags: [],
      }, 'An active fixture item with an in-flight review:changes PR');
      writeItem(backlogDir, '9004-red-ci.md', {
        bornAs: 'x9004fix', kind: 'story', size: 2, status: 'active',
        scope: ['we:scripts/fixture-thing4.mjs'], dateOpened: '2026-01-01', dateStarted: '2026-01-02', tags: [],
      }, 'An active fixture item with a red-CI PR');
      // Only #9001 is CLEARED for build (#2613 session-local sidecar) — #9002/#9003/#9004 must never launch
      // regardless of clearing, but leaving them uncleared too pins that clearing alone never overrides readiness.
      writeFileSync(queueFile, JSON.stringify([{ num: '9001', addedAt: new Date().toISOString() }]), 'utf8');

      // The node spy goes first on PATH, so every `node <script>` the CLIs shell is recorded (then really run).
      const env = {
        ...process.env, ...fakeGh.env, CONVEYOR_QUEUE_FILE: queueFile,
        PATH: `${nodeSpy.env.PATH.split(':')[0]}:${fakeGh.env.PATH}`, NODE_SPY_LOG: nodeSpy.env.NODE_SPY_LOG,
      };

      // 1. backlog.mjs build-queue --backlog-dir — the READY set is exactly #9001 (open, unblocked); #9002 is
      //    blocked (unresolved blockedBy), #9003/#9004 are active (isReady requires status:open).
      const bq = JSON.parse(execFileSync(
        'node', [BACKLOG_CLI, 'build-queue', '--json', `--backlog-dir=${backlogDir}`],
        { encoding: 'utf8', env },
      ));
      expect(bq.queue.map((r) => String(r.num))).toEqual(['9001']);

      // 2. conveyor-state.mjs --backlog-dir --repo — state.queue mirrors the ready set; state.prs is the FAKE
      //    gh's synthetic PRs, correctly shaped (labels / ci) by the REAL shapePrs/ciRollup.
      const state = JSON.parse(execFileSync(
        'node', [STATE_CLI, '--json', `--backlog-dir=${backlogDir}`, '--repo=fixture-org/fixture-repo'],
        { encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024 },
      ));
      expect(state.queue.map((r) => r.num)).toEqual(['9001']);
      const pr9003 = state.prs.find((p) => p.num === '9003');
      const pr9004 = state.prs.find((p) => p.num === '9004');
      expect(pr9003?.labels).toContain('review:changes');
      expect(pr9004?.ci).toBe('fail');
      expect(state.lanePool).toBe('skipped'); // #x7xv2xt — fixture mode: an empty pool, not the real one

      // The `--repo` gap this item closes (conveyor-state.mjs's `gh pr list` used to drop the flag other calls
      // in the same file already pass) — proven by inspecting what the fake `gh` actually received.
      const prListCall = fakeGh.calls().find((c) => c.argv[0] === 'pr' && c.argv[1] === 'list');
      expect(prListCall?.argv).toContain('--repo=fixture-org/fixture-repo');

      // 3. dispatch-plan.mjs --backlog-dir --free-lanes — a blocked/active item is EXCLUDED from the ready queue
      //    upstream (backlog.mjs build-queue never emits it), so #9002/#9003/#9004 can never appear in launch OR
      //    held. #9001 (cleared + ready + scoped) launches onto the ONE fixture lane: fixture mode has no real
      //    leases, so nothing overlaps and the concurrency cap is not reached. `--no-drift-check` and
      //    `--no-pause-check` keep the two remaining real-state reads (the drift branch, the operator's pause
      //    marker) out of a fixture run.
      // Ground-truth refresh runs detached and can outlive the CLI, writing into fakeGh during cleanup.
      // This fixture tests dispatch decisions; disable that unrelated background enrichment.
      const spyMark = nodeSpy.scripts().length;
      const plan = JSON.parse(execFileSync(
        process.execPath,
        [PLAN_CLI, '--json', `--backlog-dir=${backlogDir}`, '--free-lanes=901', '--no-drift-check', '--no-pause-check', '--no-ground-truth'],
        { encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024 },
      ));
      const allNums = [...plan.launch.map((l) => String(l.num)), ...plan.held.map((h) => String(h.num))];
      expect(allNums).not.toContain('9002');
      expect(allNums).not.toContain('9003');
      expect(allNums).not.toContain('9004');
      expect(plan.launch).toEqual([expect.objectContaining({ num: '9001', lane: 901 })]);
      expect(plan.lanePool).toEqual({ freeLanes: 'explicit', leases: 'fixture-empty' });

      // #x7xv2xt — THE REAL LANE POOL WAS NEVER TOUCHED. The spy saw dispatch-plan's own `backlog.mjs` read
      // (proving it sits on the path the CLI's children use), and no `lane-pool.mjs` / `scope-lease-collect.mjs`
      // process was started by conveyor-state or dispatch-plan.
      const started = nodeSpy.scripts();
      expect(started.slice(spyMark).some((p) => p.endsWith('backlog.mjs'))).toBe(true);
      expect(started.filter((p) => /lane-pool\.mjs$|scope-lease-collect\.mjs$/.test(p))).toEqual([]);

      // 4. tick-core.mjs's planTick (pure core) — fed the real `state` above, plus a SYNTHETIC freeLanes +
      //    bookkeeping.launchedNums simulating "this conveyor already launched #9003/#9004 on a prior tick"
      //    (the real-world shape of an in-flight PR — planFixSpawns/planCiHealSpawns both refuse to spawn for
      //    a PR whose item this conveyor never launched). Large synthetic lane ids avoid colliding with any
      //    real lane dispatch-plan's own CLI call above may have assigned.
      const { decisions } = planTick({
        state,
        plan: { launch: [], held: [] }, // this tick's build layer is irrelevant to the fix/ci-heal assertions
        freeLanes: [901, 902, 903],
        bookkeeping: { tick: 1, launchedNums: ['9003', '9004'] },
      });
      expect(decisions.spawnFixes.map((s) => s.pr)).toEqual([501]);
      expect(decisions.spawnCiHeals.map((s) => ({ pr: s.pr, reason: s.reason }))).toEqual([{ pr: 502, reason: 'red-ci' }]);
    } finally {
      fakeGh.cleanup();
      nodeSpy.cleanup();
      rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 60_000); // several `node` subprocess shells — generous timeout, not a perf assertion

  // card #4470 — a converge round-1 panel finding (6 of 10 seats, correctness/security/standards-conformance/
  // claim-accuracy) caught that every other test for the `needs-prepare` gate calls the PURE `dispatchPlan()`
  // core directly with an explicit `preparePolicy` — none of them exercise `dispatch-plan.mjs`'s own `main()`
  // IO shell, which is where the LIVE daemon's default (`preparePolicy = { requirePreparedDate: true }` unless
  // `--no-prepare-check`) actually lives. This test closes exactly that gap: it shells the REAL CLI, not the
  // pure function, against an UNPREPARED fixture item.
  it('dispatch-plan.mjs main() enforces needs-prepare BY DEFAULT and skips it under --no-prepare-check (#4470)', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'dispatcher-fixture-prepare-'));
    const backlogDir = join(fixtureRoot, 'backlog');
    mkdirSync(backlogDir, { recursive: true });
    const queueFile = join(fixtureRoot, 'queue.json');
    const fakeGh = withFakeGh({ prs: [] });
    try {
      // An open, scoped, otherwise build-ready item that carries NO `preparedDate` — the exact shape the live
      // queue is full of today (card #4470's own body: "dispatch-plan tags nearly every row 'unprep'").
      writeItem(backlogDir, '9101-unprepared-item.md', {
        bornAs: 'x9101fix', kind: 'story', size: 2, status: 'open',
        scope: ['we:scripts/fixture-thing101.mjs'], dateOpened: '2026-01-01', tags: [],
      }, 'An open, scoped, UNPREPARED fixture item');
      writeFileSync(queueFile, JSON.stringify([{ num: '9101', addedAt: new Date().toISOString() }]), 'utf8');
      // dispatch-plan lists open PRs; hand it an empty fake `gh` so it never reaches the real/hermetic one.
      const env = { ...process.env, ...fakeGh.env, CONVEYOR_QUEUE_FILE: queueFile };

      // Default (no `--no-prepare-check`): the live daemon's own posture. An unprepared item holds
      // `needs-prepare` — never launches — proving `main()` actually wires `preparePolicy` into `dispatchPlan`
      // rather than leaving it `null` (the pure core's own "gate off" default, which every OTHER test here
      // exercises directly and would pass even if this wiring were dropped).
      // `--no-size-check` isolates this test to the prepare axis alone (the size-policy axis is a separate,
      // already-covered concern — without it a sized fixture item's `launch` entry also carries `sized: true`).
      const held = JSON.parse(execFileSync(
        process.execPath,
        [PLAN_CLI, '--json', `--backlog-dir=${backlogDir}`, '--free-lanes=911', '--no-drift-check', '--no-pause-check', '--no-ground-truth', '--no-size-check'],
        { encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024 },
      ));
      expect(held.launch).toEqual([]);
      expect(held.held).toEqual(expect.arrayContaining([{ num: '9101', reason: 'needs-prepare' }]));

      // `--no-prepare-check`: the documented escape hatch (mirrors `--no-size-check`) — the SAME unprepared item
      // now launches, proving the flag genuinely disables the axis rather than being dead wiring.
      const skipped = JSON.parse(execFileSync(
        process.execPath,
        [PLAN_CLI, '--json', `--backlog-dir=${backlogDir}`, '--free-lanes=912', '--no-drift-check', '--no-pause-check', '--no-ground-truth', '--no-size-check', '--no-prepare-check'],
        { encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024 },
      ));
      expect(skipped.launch).toEqual([{ num: '9101', lane: 912 }]);
      expect(skipped.held).toEqual([]);
    } finally {
      fakeGh.cleanup();
      rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);
});
