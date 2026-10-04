/**
 * @file http-adapter.test.mjs — the HTTP caller, derived from a declaration (#3036).
 *
 * THE THREE PROPERTIES THIS FILE EXISTS FOR:
 *
 *   1. **THE ROUTE TABLE IS DERIVED FROM STEP KINDS.** A `compute`-only declaration gets a route table with no
 *      non-GET route in it, because {@link ../http-adapter.mjs}'s `planRoutes` derives the table from step
 *      kinds. Proven twice over: the plan is asserted, and then a whole `suggest-next` request is served
 *      through a store whose every method THROWS — which passes only because the read-only path has no store
 *      in scope to call. **The limit of that is asserted too, in `the limits of "read-only"` below: a
 *      `compute`-only declaration whose fn closes over a writer is served on `GET` and writes. Do not read
 *      property 1 as a security guarantee; the guarantee is `#3036 read-only is a property of the DECLARING
 *      MODULE` further down, and it is narrower.**
 *   2. **GENERICITY.** The same adapter, with no `review-pr` knowledge anywhere in it, drives `review-pr`
 *      through start → judge → reduce → its `confirm` suspend, and resumes it — executing nothing. A run
 *      crosses surfaces in BOTH directions: started on the command line and finished over HTTP, and started
 *      over HTTP and finished on the command line, both against the same store.
 *   3. **THE ERRORS ARE THE COMMAND LINE'S.** The enum, missing-field and unknown-field refusals are asserted
 *      BYTE-IDENTICAL against `parseOperationArgv`/`validateInput`, not against a copied string.
 *
 * NOTHING HERE SPAWNS A PROCESS, TOUCHES `gh`, OR LEAVES A SERVER RUNNING. The one real `node:http` server is
 * created, bound to port 0, requested against, and closed inside a single test. The exploit test writes one
 * file into `node:os`'s tmpdir and removes it in the same test.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { get as httpGet, request as httpRequest } from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { importGraph } from './import-graph.mjs';
import { createRegistry, isReadOnlyOperation, op } from '../registry.mjs';
import { compute, effect } from '../step-kinds.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { inFlight } from '../effect-executor.mjs';
import { validateInput } from '../registry.mjs';
import { buildCliSpec, judgeOutcome, parseOperationArgv, runOperationCli } from '../cli-adapter.mjs';
import { OPERATIONS, resolveOperation } from '../run.mjs';
import { reviewPrOperation, REVIEW_PR_OP, REVIEW_EFFECTS } from '../review-pr.mjs';
import { suggestNextOperation, SUGGEST_NEXT_OP } from '../suggest-next.mjs';
import { GATE_HEALTH_OP } from '../gate-health.mjs';
import { GRADUATION_PROGRESS_REPORT_OP } from '../graduation-progress-report.mjs';
import { DISPATCH_LANE_OP } from '../dispatch-lane.mjs';
import { DISPATCH_ELIGIBILITY_OP } from '../dispatch-eligibility.mjs';
import { REVIEW_PREP_OP } from '../review-prep.mjs';
import { CLAIM_OP } from '../claim.mjs';
import { RESOLVE_OP } from '../resolve.mjs';
import { SCAFFOLD_OP } from '../scaffold.mjs';
import { FILE_ITEM_OP } from '../file-item.mjs';
import { CLEAR_STUCK_SESSION_OP } from '../clear-stuck-session.mjs';
import { DOCKET_REFRESH_OP } from '../docket-refresh.mjs';
import { RESTART_RUNNER_OP } from '../restart-runner.mjs';
import { PRIORITY_SYNC_OP } from '../priority-sync.mjs';
import { EXPLORE_OP } from '../explore.mjs';
import { OPEN_PR_OP } from '../open-pr.mjs';
import { RECORD_VERDICT_OP } from '../record-verdict.mjs';
import { VERIFY_OP } from '../verify.mjs';
import { MUTATION_CHECK_OP } from '../mutation-check.mjs';
import { PR_STATUS_OP } from '../pr-status.mjs';
import { LAND_ADVANCE_OP } from '../land-advance.mjs';
import { PR_RECONCILE_OP } from '../pr-reconcile.mjs';
import { RUNNER_ACTIVITY_OP } from '../runner-activity.mjs';
import { PR_OWNERSHIP_OP } from '../pr-ownership.mjs';
import { DAEMON_STATUS_OP } from '../daemon-status.mjs';
import { HEAVY_QUEUE_OP } from '../heavy-queue.mjs';
import { REVIEW_SEAT_CAPS_OP } from '../review-seat-caps.mjs';
import { LIVE_STATE_OP } from '../live-state.mjs';
import { LIVE_WORK_OP } from '../live-work.mjs';
import { ROUTE_PR_OUTCOME_OP } from '../route-pr-outcome.mjs';
import { STALE_STATE_OP } from '../stale-state.mjs';
import { AGENT_ACTIVITY_OP } from '../agent-activity.mjs';
import { ITEM_ACTIVITY_OP } from '../item-activity.mjs';
import { STAGE_PR_VIEW_OP } from '../stage-pr-view.mjs';
import { GAP_SWEEP_STATUS_OP } from '../gap-sweep-status.mjs';
import { TELEMETRY_SUMMARY_OP } from '../telemetry-summary.mjs';
import {
  DEFAULT_BASE_PATH,
  assertReadOnlyDeclaration,
  createNodeRequestListener,
  describeOperation,
  handleOperationRequest,
  isReadOnlyDeclaration,
  parseQueryInput,
  planRoutes,
  runReadOnly,
  segmentsUnder,
} from '../http-adapter.mjs';

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────

/** A loader-shaped board item. */
function item(num, over = {}) {
  return {
    num: String(num).padStart(3, '0'), id: `${String(num).padStart(3, '0')}-x`, title: `item ${num}`,
    kind: 'story', size: 3, status: 'open', tier: 'A', batchable: true, batchCost: 3,
    locus: 'webeverything', leverageScore: 0, directUnblocks: 0, transitiveUnblocks: 0, unblocksToReady: 0,
    ...over,
  };
}
const BOARD = [item(101, { leverageScore: 5, unblocksToReady: 2 }), item(102), item(103, { kind: 'task', size: undefined })];

/** A stub `readPr` — the same shape `review-pr.test.mjs` uses, trimmed to what a suspend needs. */
function stubReader({ labels = ['review:pending'] } = {}) {
  return ({ pr, repo }) => ({
    detail: {
      pr, repo, title: 'a parked PR', url: `https://example.invalid/${pr}`, labels,
      humanRequired: labels.includes('review:human'),
      reviewClass: labels.includes('review:human') ? 'human' : 'pending',
      disposition: { mode: 'converge', autoLand: false }, escalationReason: ['gate-self'],
      advisoryComment: null, humanComment: null,
      diffStat: [{ path: 'scripts/x.mjs', additions: 1, deletions: 0 }],
    },
    headRefName: 'lane/thing',
    state: 'OPEN', // #xwp8ioh — `review-pr.read` refuses a non-OPEN or unreadable PR before `judge`
    body: 'the PR description',
    net: { paths: ['scripts/x.mjs'], base: 'a'.repeat(40), revSha: 'b'.repeat(40), rev: 'origin/lane/thing', scored: true },
    diff: { text: '--- a/x\n+++ b/x\n+one\n', scored: true },
  });
}

/** A store whose every method throws. Passing it into a read-only request is the structural assertion. */
function refusingStore(why = 'the read-only path must never touch a run store') {
  const boom = () => { throw new Error(why); };
  return { read: boom, write: boom, delete: boom, list: boom };
}

/** A deterministic run-id minter. */
function idMinter() {
  let n = 0;
  return (name) => `${name}-${String(++n).padStart(3, '0')}`;
}

/** Build the two declarations and a `resolve`/`names` pair over them — the adapter's whole per-repo wiring. */
function wiring({ readerOptions, sinks = {}, board = BOARD } = {}) {
  const table = {
    [REVIEW_PR_OP]: () => ({ declaration: reviewPrOperation({ readPr: stubReader(readerOptions) }), sinks }),
    [SUGGEST_NEXT_OP]: () => ({
      declaration: suggestNextOperation({
        loadBoard: () => ({ items: board }),
        loadExclusions: () => ({ nums: [], sources: [{ id: 'prepare-hold', nums: [] }] }),
      }),
      sinks: {},
    }),
  };
  const resolve = (name) => {
    if (!Object.hasOwn(table, name)) {
      throw new Error(`operations: no operation named ${JSON.stringify(name)} (known: ${Object.keys(table).sort().join(', ')})`);
    }
    const { declaration, sinks: s } = table[name]();
    const registry = createRegistry();
    registry.register(declaration);
    return { declaration, registry, sinks: s };
  };
  return { resolve, names: () => Object.keys(table).sort() };
}

/** A canned juror, so `awaiting-judge` resolves without a spawn. */
const stubJudge = async () => judgeOutcome({ summary: 'nothing blocking', findings: [] }, { costUsd: 0.01, wallMs: 10 });

const REVIEW_PR_DECL = () => reviewPrOperation({ readPr: stubReader() });
const SUGGEST_DECL = () => suggestNextOperation({ loadBoard: () => ({ items: BOARD }) });

const HERE = dirname(fileURLToPath(import.meta.url));
const OPS_DIR = resolvePath(HERE, '..');

// ── 1. the route table is derived from step kinds — and what that is worth ──────────────────────────────────

describe('the route table is a function of the step kinds', () => {
  it('a compute-only declaration plans GET routes and NOTHING else', () => {
    const routes = planRoutes(SUGGEST_DECL());
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /operations/suggest-next',
      'GET /operations/suggest-next/run',
    ]);
    expect(routes.every((r) => r.method === 'GET' && r.safe === true)).toBe(true);
    // No run-record route at all: a run that cannot suspend has nothing to store.
    expect(routes.some((r) => r.path.includes('/runs'))).toBe(false);
  });

  it('a declaration that can suspend or write is NEVER reachable by a safe method', () => {
    const routes = planRoutes(REVIEW_PR_DECL());
    const executing = routes.filter((r) => r.kind === 'start' || r.kind === 'advance');
    expect(executing.map((r) => r.method)).toEqual(['POST', 'POST']);
    expect(executing.every((r) => r.safe === false)).toBe(true);
    // The only GETs are reads — the describe route and the run record.
    expect(routes.filter((r) => r.method === 'GET').map((r) => r.kind)).toEqual(['describe', 'read-run']);
    // …so no crawler, prefetch or <img src> can start one.
    expect(routes.some((r) => r.method === 'GET' && r.safe === false)).toBe(false);
  });

  it('the read-only branch is derived, not declared — one non-compute step flips the whole table', () => {
    expect(isReadOnlyDeclaration(SUGGEST_DECL())).toBe(true);
    expect(isReadOnlyDeclaration(REVIEW_PR_DECL())).toBe(false);
  });
});

describe('the read-only path is given nothing to write WITH', () => {
  it('serves a whole suggest-next request through a store whose every method throws', async () => {
    const res = await handleOperationRequest(
      { method: 'GET', url: '/operations/suggest-next/run?limit=2' },
      { ...wiring(), store: refusingStore(), judge: () => { throw new Error('no juror on a read-only path'); }, newRunId: idMinter() },
    );
    expect(res.status).toBe(200);
    expect(res.body.stopped).toBe('complete');
    expect(res.body.verdict.suggested).toHaveLength(2);
    expect(res.body.persisted).toBe(false);
  });

  it('`runReadOnly` takes no store, no sinks and no judge — and refuses a declaration that can suspend', () => {
    expect(() => runReadOnly(REVIEW_PR_DECL(), { input: { pr: 1, repo: 'a/b' }, id: 'r-1', registry: createRegistry() }))
      .toThrow(/is not `compute`-only — judge\(judge\), judgeSecurity\(judge\), mandatoryReferrals\(effect\), advise\(effect\), confirm\(confirm\), stageVerdict\(effect\), record\(effect\)/);
    expect(() => assertReadOnlyDeclaration(REVIEW_PR_DECL())).toThrow(/is not `compute`-only/);
    expect(assertReadOnlyDeclaration(SUGGEST_DECL()).name).toBe(SUGGEST_NEXT_OP);
  });

  it('refuses a write METHOD on the read route with a truthful Allow', async () => {
    const res = await handleOperationRequest(
      { method: 'POST', url: '/operations/suggest-next/run', body: {} },
      { ...wiring(), newRunId: idMinter() },
    );
    expect(res.status).toBe(405);
    expect(res.body.allow).toEqual(['GET']);
  });

  it('has no run-record route to reach at all, and says why', async () => {
    for (const [method, url] of [['POST', '/operations/suggest-next/runs'], ['GET', '/operations/suggest-next/runs/abc']]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await handleOperationRequest({ method, url, body: {} }, { ...wiring(), newRunId: idMinter() });
      expect(res.status).toBe(404);
      expect(res.body.error).toContain('is READ-ONLY');
      expect(res.body.error).toContain('every declared step is `compute`');
    }
  });
});

describe('the limits of "read-only" — asserted, so the claim above cannot grow back', () => {
  /**
   * THE EXPLOIT, AS A TEST. A `compute`-only declaration whose step fn closes over `writeFileSync` passes
   * `isReadOnlyOperation`, passes `assertReadOnlyDeclaration`, is planned a `GET …/run` route, and returns
   * `200` with the file on disk. Nothing in `op()` or in either predicate inspects a step fn's closure — they
   * read the declared KIND. This test exists so that any future header claiming a `compute` step "cannot reach
   * the world" is contradicted by a green test sitting next to it.
   */
  it('a compute-only declaration whose fn closes over a writer IS served on GET, and writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-op-readonly-'));
    const victim = join(dir, 'written-by-a-compute-step.txt');
    try {
      const declaration = op('closure-writer', {
        input: { who: { type: 'string', required: false, default: 'world' } },
        verdictFrom: 'lookup',
        lookup: compute({
          reads: ['input.who'],
          fn: (view) => { writeFileSync(victim, `${view.input.who}\n`); return { greeting: view.input.who }; },
        }),
      });

      // Every declaration-level check says "read-only".
      expect(isReadOnlyOperation(declaration)).toBe(true);
      expect(() => assertReadOnlyDeclaration(declaration)).not.toThrow();
      expect(planRoutes(declaration).map((r) => `${r.method} ${r.path}`))
        .toEqual(['GET /operations/closure-writer', 'GET /operations/closure-writer/run']);

      const registry = createRegistry();
      registry.register(declaration);
      const res = await handleOperationRequest(
        { method: 'GET', url: '/operations/closure-writer/run?who=reviewer' },
        {
          resolve: () => ({ declaration, registry, sinks: {} }),
          names: () => [declaration.name],
          store: refusingStore(),
          newRunId: idMinter(),
        },
      );

      // …and the "write-free" GET wrote a file.
      expect(res.status).toBe(200);
      expect(res.body.persisted).toBe(false); // no RUN RECORD — which is all `persisted` ever meant
      expect(existsSync(victim)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the describe route ships the caveat, so a consumer is not told `readOnly` means "writes nothing"', () => {
    const described = describeOperation(SUGGEST_DECL());
    expect(described.readOnly).toBe(true);
    expect(described.readOnlyCaveat).toContain('declared step KINDS');
    expect(described.readOnlyCaveat).toContain('not a guarantee');
    // …and an operation that is not read-only carries neither field's prose.
    expect(describeOperation(REVIEW_PR_DECL()).readOnlyCaveat).toBeNull();
  });
});

describe('#3036 read-only is a property of the DECLARING MODULE — the part that IS checkable', () => {
  /**
   * THE PROPERTY, STATED EXACTLY: for every operation this repo registers as read-only, the module that
   * DECLARES it reaches nothing that can act — its whole static import graph has zero non-relative
   * specifiers, so no `node:` builtin and no package. Its `compute` fns therefore hold no writer in lexical
   * scope, and the only way one can arrive is through the `deps` its builder is handed at the single call
   * site in `../run.mjs`.
   *
   * THE HOLE, EQUALLY EXACTLY: `deps` is not covered, and for the one read-only operation that ships it is
   * where all the io lives — the test below asserts that too, rather than leaving it implied. This is the
   * same technique #3032's engine test uses (`engine.test.mjs`, "the engine's import graph reaches nothing
   * that can act"); it is applied here to a strictly narrower claim.
   */
  const DECLARING_MODULE = Object.freeze({
    'health-respond': 'health-respond.mjs',
    [REVIEW_PR_OP]: 'review-pr.mjs',
    [SUGGEST_NEXT_OP]: 'suggest-next.mjs',
    [GATE_HEALTH_OP]: 'gate-health.mjs',
    [DISPATCH_LANE_OP]: 'dispatch-lane.mjs',
    [DISPATCH_ELIGIBILITY_OP]: 'dispatch-eligibility.mjs',
    // backlog/xzdi27a-* — `review-prep`'s judge+effect steps make it NOT read-only (see the pinned list two
    // tests below), so it needs no import-graph purity of its own; it is listed here only so THIS map keeps
    // covering every registered operation (the assertion immediately below).
    [REVIEW_PREP_OP]: 'review-prep.mjs',
    // #3034 — `claim`'s `write` step is an `effect`, so it is NOT read-only either (same reasoning as
    // `review-prep` above); listed here only for map coverage.
    [CLAIM_OP]: 'claim.mjs',
    // #3150 — `explore` dispatches agents and files items, so it is NOT read-only either. Its own suite pins
    // the stronger property this map cannot express: `explore.mjs` reaches nothing that can act (it is a
    // declaration with no injected reader at all), asserted in `explore.test.mjs`.
    [EXPLORE_OP]: 'explore.mjs',
    // `open-pr`'s `submit` step shells `pr-land.mjs`, so it is NOT read-only; listed here for map coverage.
    // Its own suite pins the two properties that matter for a routing operation and that this list cannot
    // express: the declaring module reaches nothing at all, and the io shell reaches `child_process` and NO
    // network — the home is its only route to GitHub.
    [OPEN_PR_OP]: 'open-pr.mjs',
    // #xrk6hmj — `record-verdict`'s `stage` step pushes to the transport branch, so it is emphatically NOT
    // read-only; listed here only for map coverage. Its declaring module still imports nothing that can act
    // (the reader and the git sinks live in `record-verdict-io.mjs`), but that is a discipline its own suite
    // pins, not a claim this pinned list makes.
    [RECORD_VERDICT_OP]: 'record-verdict.mjs',
    // #xp240uk — `verify` is two `compute` steps with no sink, so it IS read-only and appears in the pinned
    // list below. Its io (the spawn of the single home) lives entirely in `verify-io.mjs` and arrives only
    // through the `runChecks` its builder is handed in `../run.mjs`, which is what keeps this module pure.
    [VERIFY_OP]: 'verify.mjs',
    // `stage-pr-view`'s `write` step puts a file on disk, so it is NOT read-only; listed here for map
    // coverage. Its own suite pins the property this list cannot express for a writing operation: the
    // DECLARING module reaches nothing that can act, and every write lives in `stage-pr-view-io.mjs`.
    [STAGE_PR_VIEW_OP]: 'stage-pr-view.mjs',
    // #x4omld5 — `mutation-check` is two `compute` steps with no sink, so it is read-only BY THE TEST THIS
    // FILE APPLIES: its declaring module imports only `registry.mjs` and `step-kinds.mjs` and can reach
    // nothing that acts. Worth stating plainly that the OPERATION does write — it sabotages a source file to
    // see whether the suite notices — but that write is transactional and self-reversing, lives entirely in
    // `mutation-check-io.mjs`, and arrives only through the `probe` its builder is handed in `../run.mjs`.
    // It declares no effect because there is nothing durable for a replay to re-apply.
    // #xewnork — READ-ONLY and genuinely so: both steps are `compute`, the declaring module imports only
    // `registry.mjs` and `step-kinds.mjs`, and every `gh` call lives in `pr-status-io.mjs` behind the
    // injected reader. It reads PRs; it can act on none of them.
    [PR_STATUS_OP]: 'pr-status.mjs',
    // #3720/#3856 — `land-advance` is READ-ONLY (plan only, no sinks): its declaration reaches nothing that
    // can act — every effect the plan can call for (dispatching a delivery agent, a CI-heal repair, a review,
    // queueing an item) lives behind `land-advance-io.mjs`'s sinks, which `../run.mjs` never wires into this
    // registration (`sinks: {}`).
    [LAND_ADVANCE_OP]: 'land-advance.mjs',
    // #3694 — READ-ONLY and genuinely so: both steps are `compute`, imports are `registry.mjs`/`step-kinds.mjs` and pure `pr-status.mjs` helpers, and every `gh` call lives in `pr-status-io.mjs` behind the injected reader.
    [PR_RECONCILE_OP]: 'pr-reconcile.mjs',
    [RUNNER_ACTIVITY_OP]: 'runner-activity.mjs',
    // #4056 — READ-ONLY and genuinely so: both steps are `compute`, the declaring module imports only
    // `registry.mjs` and `step-kinds.mjs`, and every reconcile/agents/transcript/lane/timeline/runner-activity
    // read (and the borrowed `classifyPr`/`bindAgents`) lives in `pr-ownership-io.mjs` behind the injected reader.
    [PR_OWNERSHIP_OP]: 'pr-ownership.mjs',
    // #4067 (epic #4075, under #3383) — READ-ONLY and genuinely so: both steps are `compute`, the declaring
    // module imports only `registry.mjs` and `step-kinds.mjs`, and every launchd/lease/log/git/overlay/
    // rebuild-alert read lives in `daemon-status-io.mjs` behind the injected `collect` reader.
    [DAEMON_STATUS_OP]: 'daemon-status.mjs',
    // Card xb0iuxq (epic #4075, under #3383) — READ-ONLY and genuinely so: both steps are `compute`, the
    // declaring module imports only `registry.mjs` and `step-kinds.mjs`, and every `admissionStatus`/`ps`/
    // `git`/lane-lease read lives in `heavy-queue-io.mjs` behind the injected `collect` reader.
    [HEAVY_QUEUE_OP]: 'heavy-queue.mjs',
    // Card xvz55jf (epic #3931) — READ-ONLY and genuinely so: both steps are `compute`, the declaring module's
    // whole transitive graph (`registry.mjs`, `step-kinds.mjs`, `../conveyor/health-watch-core.mjs` for the
    // `DEFAULT_HEALTH_CONFIG` threshold constant, `../lib/secret-scrub.mjs`) has zero external imports, and
    // every daemon/queue/health/lane/drain/auth/load read lives in `live-state-io.mjs` behind the injected
    // `collect` reader.
    [LIVE_STATE_OP]: 'live-state.mjs',
    // Card x20lkf6 (epic #3931) — READ-ONLY and genuinely so: both steps are `compute`, the declaring module
    // imports only `registry.mjs`, `step-kinds.mjs`, the pure `agent-activity.mjs#resolveAgentActivity` join
    // and `session-verdicts.mjs#isPermissionWait`, and every `claude agents`/review-job/lane-lease/transcript-
    // mtime/pid-liveness/heavy-queue read lives in `live-work-io.mjs` behind the injected `collect` reader.
    [LIVE_WORK_OP]: 'live-work.mjs',
    // #xrpo1 — READ-ONLY and genuinely so: both steps are `compute`, the declaring module imports only
    // `registry.mjs` and `step-kinds.mjs`, and the `deriveReviewDisposition`/`parseEscalationReason` calls
    // live in `route-pr-outcome-io.mjs` behind the injected reader — see that file's header for why the call
    // could not live in the declaration and stay on this list.
    [ROUTE_PR_OUTCOME_OP]: 'route-pr-outcome.mjs',
    // READ-ONLY and genuinely so: both steps are `compute`; the declaring module imports only `registry.mjs`/`step-kinds.mjs`, and all pid/lease/claim/run-store reads live in `stale-state-io.mjs` behind the injected `readState` reader.
    [STALE_STATE_OP]: 'stale-state.mjs',
    [MUTATION_CHECK_OP]: 'mutation-check.mjs',
    // #xrrpfo7 — `claim`'s sibling at the close of the lifecycle, and NOT read-only for the same reason
    // `claim` is not: its `write` step splices the card. Listed here for map coverage; its own suite pins
    // the property this list cannot express for a writing operation — the DECLARING module reaches nothing
    // that can act, and every write lives in `resolve-io.mjs`.
    [RESOLVE_OP]: 'resolve.mjs',
    // #xrrpfo7 — the BIRTH of the lifecycle. NOT read-only, for the same reason `claim` is not: its `write`
    // step creates the card. Listed for map coverage; the declaring module reaches nothing that can act and
    // every write lives in `scaffold-io.mjs`, behind the guarded writer.
    [SCAFFOLD_OP]: 'scaffold.mjs',
    // #xkp1mv8 — `gap-sweep-status`'s one step is an `effect` (its own header explains why: `mode: 'snapshot'`
    // writes a file, and the step kind cannot depend on which mode a given call chooses), so it is NOT
    // read-only; listed here for map coverage. The declaring module still reaches nothing that can act — the
    // one shell of the CLI lives entirely in `gap-sweep-status-io.mjs`, behind the sink `../run.mjs` wires it
    // through.
    [GAP_SWEEP_STATUS_OP]: 'gap-sweep-status.mjs',
    // #3383 — `file-item`'s `write` AND `queueAdd` steps are both
    // effects, so it is emphatically NOT read-only; listed here for map coverage. The declaring module still
    // reaches nothing that can act — both effects' sinks live in `file-item-io.mjs`, which reuses
    // `scaffold-io.mjs`'s own guarded write sink and adds only a `queue-store.mjs` sink beside it.
    [FILE_ITEM_OP]: 'file-item.mjs',
    // #3690/#xd9xwtn — READ-ONLY and genuinely so: both steps are `compute`, the declaring module imports
    // only `registry.mjs` and `step-kinds.mjs`, and the `readStore()` call lives in
    // `graduation-progress-report-io.mjs` behind the injected `readScorecards` reader.
    [GRADUATION_PROGRESS_REPORT_OP]: 'graduation-progress-report.mjs',
    // #3383 — `clear-stuck-session`'s `authorize` step is a `confirm` and its `move` step is an `effect`, so
    // it is NOT read-only; listed here for map coverage. The declaring module still reaches nothing that can
    // act — `fs`, `claude agents`, `ps` and the run-store all live in `clear-stuck-session-io.mjs`, behind the
    // `readStuckFacts` reader and the sink `../run.mjs` wires through.
    [CLEAR_STUCK_SESSION_OP]: 'clear-stuck-session.mjs',
    // backlog `xaxks4j` — READ-ONLY and genuinely so: its one step is `compute`, the declaring module imports
    // only `registry.mjs`, `step-kinds.mjs` and the pure `telemetry-summary.mjs`/`telemetry-machine.mjs`
    // libs, and every fs/`plutil`/clock read lives in `telemetry-summary-io.mjs` behind the injected
    // `loadFacts` reader.
    [TELEMETRY_SUMMARY_OP]: 'telemetry-summary.mjs',
    // #3723 (under epic #3383) — `docket-refresh`'s `apply` step is an `effect` (the checkout's own generator
    // + a content-hash-gated render/hand-off), so it is NOT read-only; listed here for map coverage. The
    // declaring module still reaches nothing that can act — every `fs`/`child_process`/`node:crypto` call
    // lives in `docket-refresh-io.mjs`, behind the injected `readFacts` reader and the sink `../run.mjs`
    // wires through.
    [DOCKET_REFRESH_OP]: 'docket-refresh.mjs',
    // #3383 (graduated under #3892) — the SAFE conveyor restart. Three of its six steps are effects, so it is
    // emphatically NOT read-only; listed here for map coverage. The declaring module reaching nothing that can
    // act matters MORE here than anywhere else on this list: this operation's verbs are SIGNAL A PROCESS and
    // SPAWN ONE, and every one of them lives in `restart-runner-io.mjs` behind the three sinks `../run.mjs`
    // wires through. Its own suite pins that graph property directly.
    [RESTART_RUNNER_OP]: 'restart-runner.mjs',
    // #3383 (graduated under #3892) — `priority-sync`'s `apply` step is an effect (it rewrites the tracker
    // card's section), so it is NOT read-only; listed for map coverage. Its declaring module is itself a leaf
    // (asserted in `priority-sync.test.mjs`).
    [PRIORITY_SYNC_OP]: 'priority-sync.mjs',
    // backlog #3932 (epic #3931, under #3383) — READ-ONLY and genuinely so: both steps are `compute`, the
    // declaring module imports only `registry.mjs`, `step-kinds.mjs` and the pure `session-slug.mjs` parser,
    // and every `claude agents`/review-job/lane-lease/transcript read lives in `agent-activity-io.mjs`
    // behind the injected `readActivity` reader.
    [AGENT_ACTIVITY_OP]: 'agent-activity.mjs',
    // #4198 — compute-only; evidence reads are injected from item-activity-io.mjs.
    [ITEM_ACTIVITY_OP]: 'item-activity.mjs',
    // Card xn2wf9t (#3383 follow-up) — READ-ONLY and genuinely so: both steps are `compute`, the declaring
    // module imports only `registry.mjs` and `step-kinds.mjs`, and the scorecard-store read lives behind the
    // injected `collect` reader `../run.mjs` binds to `review-extra-seats.mjs#readSeatCapUsage`.
    [REVIEW_SEAT_CAPS_OP]: 'review-seat-caps.mjs',
  });

  it('the module map covers every operation the repo declares — a new one cannot slip past this file', () => {
    expect(Object.keys(DECLARING_MODULE).sort()).toEqual(Object.keys(OPERATIONS).sort());
  });

  it('every operation registered as read-only declares in a module that reaches nothing that can act', () => {
    const readOnly = Object.keys(OPERATIONS).filter((name) => isReadOnlyOperation(resolveOperation(name).declaration));
    // Pinned, not derived: adding a read-only operation must be a deliberate edit here.
    expect(readOnly.sort()).toEqual(['health-respond', AGENT_ACTIVITY_OP, DAEMON_STATUS_OP, DISPATCH_ELIGIBILITY_OP, GATE_HEALTH_OP, GRADUATION_PROGRESS_REPORT_OP, HEAVY_QUEUE_OP, ITEM_ACTIVITY_OP, LAND_ADVANCE_OP, LIVE_STATE_OP, LIVE_WORK_OP, PR_OWNERSHIP_OP, PR_STATUS_OP, PR_RECONCILE_OP, REVIEW_SEAT_CAPS_OP, ROUTE_PR_OUTCOME_OP, RUNNER_ACTIVITY_OP, STALE_STATE_OP, SUGGEST_NEXT_OP, TELEMETRY_SUMMARY_OP, VERIFY_OP].sort());
    for (const name of readOnly) {
      const { external } = importGraph(resolvePath(OPS_DIR, DECLARING_MODULE[name]));
      expect(external, `\`${name}\` declares in ${DECLARING_MODULE[name]}, which must import nothing that can act`)
        .toEqual([]);
    }
  });

  it('and the check stops at the injected deps — suggest-next\'s own readers DO reach fs and child_process', () => {
    // Not a defect being tolerated quietly: this is the boundary of the guarantee, written down as an
    // assertion so the header's "that narrows the surface; it does not close it" cannot rot into a stronger
    // claim. Both readers only read; that is a promise this repo keeps, not a property anything verifies.
    const { external } = importGraph(resolvePath(OPS_DIR, 'suggest-next-io.mjs'));
    expect(external).toContain('node:fs');
    expect(external).toContain('node:child_process');
  });

  it('a declaration module that imports a writer FAILS the check — the scanner is not vacuous', () => {
    // `review-pr` is the negative control: it is not read-only, and its module graph is full of writers. If
    // the scanner ever returned `[]` for everything, this would fail and the assertion above would be empty.
    const { external } = importGraph(resolvePath(OPS_DIR, 'review-pr.mjs'));
    expect(external).toContain('node:fs');
    expect(external).toContain('node:child_process');
  });
});

// ── 2. the describe route IS the --help ─────────────────────────────────────────────────────────────────────

describe('describe — one declaration, one description', () => {
  it('carries the command line\'s usage text verbatim', async () => {
    const res = await handleOperationRequest({ method: 'GET', url: '/operations/suggest-next' }, { ...wiring(), newRunId: idMinter() });
    expect(res.status).toBe(200);
    expect(res.body.usage).toBe(buildCliSpec(SUGGEST_DECL()).usage);
  });

  it('every described route names its KIND, so a consumer looks a route up instead of retyping its path', () => {
    // #3036 — the field a PROGRAMMATIC consumer keys off. `plateau:tools/dev-panel/drain-daemon.html` builds
    // its start / read / resume URLs from this table by kind; without it a console has to hand-write three
    // per-operation route shapes and drifts into silent 404s the moment `planRoutes` renames a segment.
    const described = describeOperation(REVIEW_PR_DECL());
    expect(described.routes.map((r) => r.kind)).toEqual(['describe', 'start', 'read-run', 'advance']);
    // The kind is what a caller resolves a path THROUGH — a lookup, never a second copy of the path.
    const byKind = Object.fromEntries(described.routes.map((r) => [r.kind, r]));
    expect(byKind.advance).toMatchObject({ method: 'POST', path: '/operations/review-pr/runs/:runId/advance' });
    expect(byKind['read-run']).toMatchObject({ method: 'GET', path: '/operations/review-pr/runs/:runId' });
    // A read-only declaration's table is a different SET of kinds, which is the point of keying on them.
    expect(describeOperation(SUGGEST_DECL()).routes.map((r) => r.kind)).toEqual(['describe', 'read-run-once']);
  });

  it('lists the declared value set, the defaults and the step kinds', () => {
    const described = describeOperation(SUGGEST_DECL());
    expect(described.input.tier).toEqual({ type: 'string', required: false, default: 'A', enum: ['A', 'B'] });
    expect(described.steps).toEqual([
      { name: 'board', kind: 'compute', reads: ['input.scanOpenPrs'] },
      { name: 'shortlist', kind: 'compute', reads: ['input.tier', 'input.limit', 'input.batchableOnly', 'input.parent', 'input.tag', 'input.locus', 'findings.board'] },
    ]);
    expect(described.readOnly).toBe(true);
    expect(described.readOnlyBecause).toContain('every declared step is `compute`');
  });

  it('the index lists every declared operation and whether it can write', async () => {
    const res = await handleOperationRequest({ method: 'GET', url: '/operations' }, { ...wiring(), newRunId: idMinter() });
    expect(res.body.operations).toEqual([
      { op: REVIEW_PR_OP, readOnly: false, describe: '/operations/review-pr', steps: ['read(compute)', 'judge(judge)', 'judgeSecurity(judge)', 'reduce(compute)', 'mandatoryReferrals(effect)', 'referralVerdict(compute)', 'advise(effect)', 'confirm(confirm)', 'stageVerdict(effect)', 'record(effect)'] },
      { op: SUGGEST_NEXT_OP, readOnly: true, describe: '/operations/suggest-next', steps: ['board(compute)', 'shortlist(compute)'] },
    ]);
  });
});

// ── 3. the errors are the command line's ────────────────────────────────────────────────────────────────────

describe('errors come from the generated validation', () => {
  it('an enum refusal is BYTE-IDENTICAL to the command line\'s', async () => {
    const fromCli = parseOperationArgv(SUGGEST_DECL(), ['--tier=C']).errors;
    const res = await handleOperationRequest(
      { method: 'GET', url: '/operations/suggest-next/run?tier=C' },
      { ...wiring(), newRunId: idMinter() },
    );
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(fromCli);
  });

  it('a missing required field and an unknown field are BYTE-IDENTICAL to `validateInput`', async () => {
    const decl = REVIEW_PR_DECL();
    const expected = validateInput(decl.input, { nope: 1 }).errors;
    expect(expected.length).toBe(3); // missing pr, missing repo, unknown nope — asserted so a silent shrink fails.
    const res = await handleOperationRequest(
      { method: 'POST', url: '/operations/review-pr/runs', body: { nope: 1 } },
      { ...wiring(), store: createMemoryRunStore(), judge: stubJudge, newRunId: idMinter() },
    );
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(expected);
  });

  it('a wrong type in a query parameter is refused before a run exists', async () => {
    const res = await handleOperationRequest(
      { method: 'GET', url: '/operations/suggest-next/run?limit=banana' },
      { ...wiring(), store: refusingStore(), newRunId: idMinter() },
    );
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(['query parameter `limit` must be a number, got "banana"']);
  });

  it('an unknown operation fails with the resolver\'s own words', async () => {
    const res = await handleOperationRequest({ method: 'GET', url: '/operations/nope' }, { ...wiring(), newRunId: idMinter() });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('operations: no operation named "nope" (known: review-pr, suggest-next)');
  });

  it('a repeated query parameter is refused rather than silently last-wins', () => {
    const parsed = parseQueryInput(SUGGEST_DECL(), new URLSearchParams('limit=1&limit=2'));
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0]).toContain('appears more than once');
  });

  it('is not mounted outside its base path', async () => {
    const res = await handleOperationRequest({ method: 'GET', url: '/elsewhere' }, { ...wiring(), newRunId: idMinter() });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain(`it is mounted at ${DEFAULT_BASE_PATH}`);
    expect(segmentsUnder('/operations', '/elsewhere')).toBeNull();
    expect(segmentsUnder('/operations', '/operations/a/b')).toEqual(['a', 'b']);
  });
});

// ── 4. genericity: the same adapter drives review-pr, executing nothing ─────────────────────────────────────

describe('genericity — the adapter knows nothing about either operation', () => {
  it('drives review-pr to its `confirm` suspend over HTTP and applies no effect', async () => {
    const store = createMemoryRunStore();
    const applied = [];
    const sinks = new Proxy({}, { get: (_t, type) => (payload) => { applied.push({ type, payload }); } });
    const deps = { ...wiring({ sinks }), store, judge: stubJudge, newRunId: idMinter() };

    const started = await handleOperationRequest(
      { method: 'POST', url: '/operations/review-pr/runs', body: { pr: 1146, repo: 'web-everything/web-everything' } },
      deps,
    );
    expect(started.status).toBe(201);
    expect(started.headers.location).toBe(`/operations/review-pr/runs/${started.body.runId}`);
    expect(started.body.stopped).toBe('confirm');
    expect(started.body.pending.kind).toBe('confirm');
    expect(started.body.pending.of).toBe('agent');
    expect(started.body.pending.options).toEqual(['accept', 'changes', 'abstain']);
    // NOTHING RAN. The juror was a stub and no sink was ever reached.
    expect(applied).toEqual([]);
    expect(store.read(started.body.runId).effects).toEqual([]);
    // BOTH declared judge steps suspended and each cost rode back on its own resume — the generic loop,
    // unchanged by #3319 adding a second one. `1` here would mean the adapter had a hard-coded juror count.
    expect(started.body.spend.jurors).toBe(2);

    // The record is readable through the derived GET route.
    const read = await handleOperationRequest({ method: 'GET', url: `/operations/review-pr/runs/${started.body.runId}` }, deps);
    expect(read.status).toBe(200);
    // A read is a snapshot, not a drive: `status` says what the run waits on, `stopped` is null because
    // nothing was driven. The start response above carries both, with `stopped: 'confirm'`.
    expect(read.body.status).toBe('awaiting-confirm');
    expect(read.body.stopped).toBeNull();
    expect(started.body.status).toBe('awaiting-confirm');
    expect(read.body.persisted).toBe(true);

    // …and the resume route answers it. `abstain` declares zero effects, so the run completes writing nothing.
    const done = await handleOperationRequest(
      { method: 'POST', url: `/operations/review-pr/runs/${started.body.runId}/advance`, body: { value: 'abstain' } },
      deps,
    );
    expect(done.status).toBe(200);
    expect(done.body.stopped).toBe('complete');
    expect(applied).toEqual([]);
  });

  it('refuses an answer to a question that has not been asked — the CLI stop point, over HTTP', async () => {
    const store = createMemoryRunStore();
    const deps = { ...wiring(), store, judge: stubJudge, newRunId: idMinter() };
    const started = await handleOperationRequest(
      { method: 'POST', url: '/operations/review-pr/runs', body: { pr: 7, repo: 'a/b' } }, deps,
    );
    const done = await handleOperationRequest(
      { method: 'POST', url: `/operations/review-pr/runs/${started.body.runId}/advance`, body: { value: 'abstain' } }, deps,
    );
    expect(done.body.stopped).toBe('complete');
    // The run is finished; a second answer has nothing to answer.
    const again = await handleOperationRequest(
      { method: 'POST', url: `/operations/review-pr/runs/${started.body.runId}/advance`, body: { value: 'accept' } }, deps,
    );
    expect(again.status).toBe(409);
    expect(again.body.error).toContain('a question that has not been asked');
  });

  // #3063 — a declaration fn refusing deterministically (the gate-self `record` guard) used to escape
  // `driveRun` as an uncaught throw, which this route's own `try` turned into a bare `fail(500, message)` —
  // no run payload at all. `driveRun` now returns `stopped: 'step-refused'` instead of throwing, so this
  // route's `settled` check (unedited) falls through to its own 500 branch with the FULL `outcomePayload`.
  it('a refused declaration fn 500s with the full run payload, not a bare error string', async () => {
    const store = createMemoryRunStore();
    // A `humanRequired` PR runs `advise`'s (#xlw02hw) automatic advisory-note effect on the way to `confirm`,
    // which needs a sink even though this test's whole point is the LATER `record` refusal.
    const deps = {
      ...wiring({ readerOptions: { labels: ['review:human'] }, sinks: { [REVIEW_EFFECTS.ADVISORY_NOTE]: async () => ({ ok: true }), [REVIEW_EFFECTS.ADVISORY_LABEL]: async () => ({ ok: true }) } }),
      store,
      judge: stubJudge,
      newRunId: idMinter(),
    };
    const started = await handleOperationRequest(
      { method: 'POST', url: '/operations/review-pr/runs', body: { pr: 1153, repo: 'web-everything/web-everything' } },
      deps,
    );
    expect(started.body.pending.of).toBe('human');

    const refused = await handleOperationRequest(
      { method: 'POST', url: `/operations/review-pr/runs/${started.body.runId}/advance`, body: { value: 'accept' } },
      deps,
    );
    expect(refused.status).toBe(500);
    expect(refused.body.stopped).toBe('step-refused');
    expect(refused.body.runId).toBe(started.body.runId);
    expect(refused.body.findings.confirm).toBe('accept');
    expect(refused.body.error).toContain('human-ceremony-only');
    // NOT the bare-error shape a throw used to produce — the payload carries the whole envelope.
    expect(Object.keys(refused.body)).not.toEqual(['error']);
  });

  it('a run STARTED on the command line is finished over HTTP, against the same record', async () => {
    const store = createMemoryRunStore();
    const { resolve, names } = wiring();
    const { declaration, registry, sinks } = resolve(REVIEW_PR_OP);

    const cli = await runOperationCli({
      declaration, argv: ['--pr=1146', '--repo=web-everything/web-everything', '--json'],
      registry, store, sinks, judge: stubJudge, newRunId: () => 'review-pr-crossing',
    });
    expect(cli.stopped).toBe('confirm');

    // …and the browser picks it up. Same store, same record, no second implementation of anything.
    const deps = { resolve, names, store, judge: stubJudge, newRunId: idMinter() };
    const seen = await handleOperationRequest({ method: 'GET', url: '/operations/review-pr/runs/review-pr-crossing' }, deps);
    expect(seen.body.pending.asks).toBe(cli.run.pending.asks);
    const done = await handleOperationRequest(
      { method: 'POST', url: '/operations/review-pr/runs/review-pr-crossing/advance', body: { value: 'abstain' } }, deps,
    );
    expect(done.body.stopped).toBe('complete');
    expect(store.read('review-pr-crossing').findings.confirm).toBe('abstain');
  });

  it('and the OTHER direction: a run STARTED over HTTP is finished on the command line', async () => {
    // The card claims the crossing works "in the terminal … and the reverse". Only one direction was pinned;
    // this is the reverse, and it is a separate risk — the HTTP start writes the record and the CLI's
    // `--resume` has to find, validate and advance a record it did not create.
    const store = createMemoryRunStore();
    const { resolve, names } = wiring();
    const deps = { resolve, names, store, judge: stubJudge, newRunId: () => 'review-pr-reverse' };

    const started = await handleOperationRequest(
      { method: 'POST', url: '/operations/review-pr/runs', body: { pr: 1146, repo: 'web-everything/web-everything' } },
      deps,
    );
    expect(started.status).toBe(201);
    expect(started.body.stopped).toBe('confirm');
    expect(store.read('review-pr-reverse').pending.kind).toBe('confirm');

    // …and the terminal finishes it, against the record the browser wrote. No second implementation.
    const { declaration, registry, sinks } = resolve(REVIEW_PR_OP);
    const cli = await runOperationCli({
      declaration, argv: ['--resume=review-pr-reverse', '--answer=abstain', '--json'],
      registry, store, sinks, judge: stubJudge, newRunId: () => 'unused',
    });
    expect(cli.stopped).toBe('complete');
    expect(cli.code).toBe(0);
    expect(cli.run.id).toBe('review-pr-reverse');
    expect(store.read('review-pr-reverse').findings.confirm).toBe('abstain');
    // `abstain` declares no effects, so nothing was applied on either surface.
    expect(store.read('review-pr-reverse').effects).toEqual([]);
  });

  it('keeps the repo sanitisation — in the operation\'s io shell, not in the generic adapter', async () => {
    // The card asks that the console's hand-written repo guard "moves into the generator rather than being
    // dropped". It moved into the IO SHELL instead, which is the correct home: a repo-format rule is
    // `review-pr`'s knowledge and the adapter is generic over every declaration. The regex here is
    // byte-identical to `daemonReviewDetailJson`'s in `plateau:tools/dev-panel/vite-plugin.ts`.
    const { readPr } = await import('../review-pr-io.mjs');
    expect(() => readPr({ pr: 1, repo: 'web-everything/web-everything; rm -rf /' }))
      .toThrow(/`repo` must be <owner\/name>/);
    // …and the adapter itself adds no repo knowledge: a hostile value is a well-typed `string` to it, so it
    // passes the declaration's validation and is stopped one layer down, where the rule lives.
    const decl = REVIEW_PR_DECL();
    expect(validateInput(decl.input, { pr: 1, repo: 'a b; rm -rf /' }).ok).toBe(true);
  });

  it('a run id belonging to another operation is not served under this one', async () => {
    const store = createMemoryRunStore();
    const deps = { ...wiring(), store, judge: stubJudge, newRunId: idMinter() };
    const started = await handleOperationRequest(
      { method: 'POST', url: '/operations/review-pr/runs', body: { pr: 7, repo: 'a/b' } }, deps,
    );
    const res = await handleOperationRequest({ method: 'GET', url: `/operations/suggest-next/runs/${started.body.runId}` }, deps);
    expect(res.status).toBe(404);
  });
});

// ── 5. over a real socket, started and stopped in one test ──────────────────────────────────────────────────

describe('the node:http shim', () => {
  /** @type {import('node:http').Server|null} */
  let server = null;
  afterEach(async () => {
    if (server) await new Promise((done) => server.close(done));
    server = null;
  });

  /** One request/response over the loopback, as text. */
  function fetchText(port, path, { method = 'GET', body } = {}) {
    return new Promise((done, fail) => {
      const req = (method === 'GET' ? httpGet : httpRequest)(
        { host: '127.0.0.1', port, path, method },
        (res) => {
          let text = '';
          res.on('data', (c) => { text += c; });
          res.on('end', () => done({ status: res.statusCode, headers: res.headers, text }));
        },
      );
      req.on('error', fail);
      if (body !== undefined) req.write(JSON.stringify(body));
      if (method !== 'GET') req.end();
    });
  }

  it('serves the derived route over a real socket, and refuses a write method with Allow', async () => {
    const listener = createNodeRequestListener({ ...wiring(), store: refusingStore(), newRunId: idMinter() });
    server = createServer(listener);
    const port = await new Promise((done) => server.listen(0, '127.0.0.1', () => done(server.address().port)));

    const ok = await fetchText(port, '/operations/suggest-next/run?limit=1');
    expect(ok.status).toBe(200);
    const payload = JSON.parse(ok.text);
    expect(payload.op).toBe(SUGGEST_NEXT_OP);
    expect(payload.persisted).toBe(false);
    expect(payload.verdict.next.num).toBe('101');

    const refused = await fetchText(port, '/operations/suggest-next/run', { method: 'POST', body: {} });
    expect(refused.status).toBe(405);
    expect(refused.headers.allow).toBe('GET');
  });
});

/**
 * A DISPATCH IS NOT A SERVER FAULT (#3073; PR #1180 review, blocking 1). `driveAndRespond` mapped anything
 * other than `complete`/`confirm` to 500, so a run that parked on deliberately-started long work — the one
 * operation the operations epic exists to reach — came back as a server error. The CLI had the same defect
 * one layer down (it exited 1 after spinning to the turn cap).
 */
describe('an in-flight dispatch is a successful park over HTTP, not a 500', () => {
  const DISPATCH_OP = 'http-dispatch-fx';

  /** The adapter's whole per-repo wiring, over one dispatching declaration. */
  function dispatchWiring() {
    const build = () => ({
      declaration: op(DISPATCH_OP, {
        input: { pr: { type: 'number', required: true } },
        go: effect({
          reads: ['input.pr'],
          effects: (view) => [{ type: 'start.build', payload: { pr: view.input.pr }, dispatch: true }],
        }),
      }),
      sinks: { 'start.build': async () => inFlight({ handle: 'sess-http', expectedBy: '2099-01-01T00:00:00.000Z' }) },
    });
    return {
      resolve: (name) => {
        if (name !== DISPATCH_OP) throw new Error(`operations: no operation named ${JSON.stringify(name)}`);
        const { declaration, sinks } = build();
        const registry = createRegistry();
        registry.register(declaration);
        return { declaration, registry, sinks };
      },
      names: () => [DISPATCH_OP],
    };
  }

  it('answers 201 with the park recorded, not 500', async () => {
    const res = await handleOperationRequest(
      { method: 'POST', url: `${DEFAULT_BASE_PATH}/${DISPATCH_OP}/runs`, body: { pr: 7 } },
      { ...dispatchWiring(), newRunId: idMinter(), store: createMemoryRunStore(), judge: async () => { throw new Error('no juror'); } },
    );
    expect(res.status).toBe(201);
    expect(res.body.stopped).toBe('effect-in-flight');
    expect(res.body.inFlight).toHaveLength(1);
    expect(res.body.error).toBeUndefined();
  });
});

/**
 * READING A PARKED RUN MUST REPORT THE PARK (PR #1180 review, finding 1). `GET …/runs/<id>` builds its payload
 * with no drive behind it, so a passed-in `inFlight` defaulted to `[]` — and since the payload carries no
 * `effects` either, there was no way to recover a parked run's handle over HTTP at all. "The work outlives
 * this process" is the case the status exists for, so the read route is the one that matters most.
 */
describe('GET on a parked run reports what is in flight', () => {
  const DISPATCH_OP = 'http-parked-fx';

  function wiringFor() {
    const build = () => ({
      declaration: op(DISPATCH_OP, {
        input: { pr: { type: 'number', required: true } },
        go: effect({ reads: ['input.pr'], effects: () => [{ type: 'start.build', payload: {}, dispatch: true }] }),
      }),
      sinks: { 'start.build': async () => inFlight({ handle: 'sess-http' }) },
    });
    return {
      resolve: (name) => {
        if (name !== DISPATCH_OP) throw new Error(`operations: no operation named ${JSON.stringify(name)}`);
        const { declaration, sinks } = build();
        const registry = createRegistry();
        registry.register(declaration);
        return { declaration, registry, sinks };
      },
      names: () => [DISPATCH_OP],
    };
  }

  it('the POST parks it and the GET still names the in-flight effect', async () => {
    const wiring = wiringFor();
    const store = createMemoryRunStore();
    const newRunId = idMinter();
    const judge = async () => { throw new Error('no juror'); };

    const posted = await handleOperationRequest(
      { method: 'POST', url: `${DEFAULT_BASE_PATH}/${DISPATCH_OP}/runs`, body: { pr: 7 } },
      { ...wiring, newRunId, store, judge },
    );
    expect(posted.status).toBe(201);
    expect(posted.body.inFlight).toHaveLength(1);

    const got = await handleOperationRequest(
      { method: 'GET', url: `${DEFAULT_BASE_PATH}/${DISPATCH_OP}/runs/${posted.body.runId}` },
      { ...wiring, newRunId, store, judge },
    );
    expect(got.status).toBe(200);
    expect(got.body.inFlight).toEqual(posted.body.inFlight);
  });
});

/**
 * A NETWORK CLIENT IS NOT A PERSON (PR #1195 round 3, blocking). `applyPendingEffects` defaulted
 * `attemptedBy` to `human` on the grounds that every pre-waker caller was one — but `driveRun` is reached
 * from here too, and this adapter cannot tell a console user from another machine. Every request-driven
 * attempt was landing in the human retry population.
 *
 * Uses an EFFECT-ONLY declaration on purpose. The first version of this test drove `review-pr`, which
 * suspends at its confirm before any effect applies — so the loop over attempted effects ran zero times and
 * the assertion passed vacuously. That is the same decorative shape being fixed elsewhere in this diff.
 */
describe('effects applied over HTTP are attributed to an unidentifiable caller', () => {
  const OP_NAME = 'http-attrib-fx';

  function wiringFor(applied) {
    return {
      resolve: (name) => {
        if (name !== OP_NAME) throw new Error(`operations: no operation named ${JSON.stringify(name)}`);
        const declaration = op(OP_NAME, {
          input: { pr: { type: 'number', required: true } },
          go: effect({ reads: ['input.pr'], effects: () => [{ type: 'note.write', payload: {} }] }),
        });
        const registry = createRegistry();
        registry.register(declaration);
        return { declaration, registry, sinks: { 'note.write': async () => { applied.push('note.write'); return { ok: true }; } } };
      },
      names: () => [OP_NAME],
    };
  }

  it('records `unknown`, not `human`', async () => {
    const store = createMemoryRunStore();
    const applied = [];
    const res = await handleOperationRequest(
      { method: 'POST', url: `${DEFAULT_BASE_PATH}/${OP_NAME}/runs`, body: { pr: 7 } },
      { ...wiringFor(applied), newRunId: idMinter(), store, judge: async () => { throw new Error('no juror'); } },
    );
    expect(res.status).toBe(201);
    expect(applied).toEqual(['note.write']);          // the effect really ran — not a vacuous pass

    const entry = store.read(res.body.runId).effects[0];
    expect(entry.attempts).toBe(1);
    expect(entry.lastAttemptBy).toBe('unknown');
    expect(entry.humanAttempts).toBe(0);
    expect(entry.unknownAttempts).toBe(1);
  });
});
