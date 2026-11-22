// @vitest-environment node
// Tier 1: hermetic policy boundaries, no forge calls or counted-path mutations.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { resolvePostAcceptAdvisorySettings } from '../post-accept-advisory-settings.mjs';
import { resolveTimingPolicy } from '../review-timing-settings.mjs';
import { resolveReviewChurn } from '../../conveyor/review-churn.mjs';
import { resolveDeliveryCapacity } from '../delivery-capacity.mjs';
import { logFixPassPriorityShadow, readDeliveryPrioritySettings } from '../../conveyor/delivery-priority-shadow.mjs';
import { decideStaleReferralHumanHold, resolveStaleReferralHumanShadow } from '../../conveyor/stale-referral-human-shadow.mjs';
import { createAsyncShadow } from '../drain-async-shadow.mjs';
import { traceEnabled } from '../test-cache-trace.mjs';
import { derivePanelVerdict } from '../jury-core.mjs';
import { REVIEW_TIMING_DEFAULTS, reviewStartGate } from '../review-timing.mjs';
import ShadowReporter from '../../test-cache/shadow-reporter.mjs';
import { planReconcile } from '../../conveyor/reconcile-core.mjs';
import { createDeliveryCapacityTune } from '../../operations/delivery-capacity-tune-shell.mjs';
import { evaluatePrGates } from '../merge-gate-ci.mjs';
import { build, verify } from '../drain-verdict.mjs';

const root = new URL('../../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const workflow = name => yaml.load(read(`.github/workflows/${name}.yml`));
const dirs = [];
// Linux CI may leave TMPDIR unset; join(undefined, …) would throw before any assertion runs.
const temp = () => { const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'retired-shadow-')); dirs.push(dir); return dir; };
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// Resolver probes BEFORE edits, with empty env/platform (2026-11-21):
// "WE_REVIEW_POST_ACCEPT_ADVISORY_MODE=shadow"
// 'reviewChurn={"sameTree":"shadow","capMode":"shadow"}'
// "WE_REVIEW_START_EARLY=shadow"
// "deliveryCapacity.autoTune.mode=shadow" (NOT deliveryCapacity.mode, which is live count|units)
// "deliveryPriority.mode=shadow"
// "WE_TEST_CACHE_TRACE=true"
// "staleReferralHumanShadow.enabled=true"
// "drain.asyncShadow=shadow" (observer methods are distinct; off returns shared noops)
// 'test-selection-measure.on={"push":{"branches":["main"]},"workflow_dispatch":null}'
// 'drain-verdict.on={"workflow_dispatch":{"inputs":{"pr":{"description":"PR number to classify","required":true,"type":"number"}}},"schedule":[{"cron":"*/10 * * * *"}]}'
// Exceptions, deliberately unchanged:
// 'workerCapacity={"targetLoad":30,"ceiling":10,"sources":{"targetLoad":"repo","ceiling":"repo"}}': no mode flag.
// WE_RESOURCE_SHADOW: NEEDS-CRITERION; off skips admit() in shadowAdmission, also a live gate input.
// "resourceGate.cutover=enforce"; "WE_RESOURCE_SHADOW=off -> undefined"
// "scopedRereview=shadow": on activates bindingPriorRoundDecision, changing counted acceptance.
// Hydrogen: no model alias in model-settings.json. Carbon/neon/lens/round-judge are out of scope.
const flags = [
  ['post-accept-advisory', 'WE_REVIEW_POST_ACCEPT_ADVISORY_MODE', 'shadow', 'off',
    (env = {}) => resolvePostAcceptAdvisorySettings({ env, platform: {}, log: () => {} }).value.mode],
  ['review-churn cap', 'WE_REVIEW_CHURN_CAP_MODE', 'shadow', 'off',
    (env = {}) => resolveReviewChurn({ env, platform: {} }).capMode],
  ['review-churn same tree', 'WE_REVIEW_CHURN_SAME_TREE', 'shadow', 'off',
    (env = {}) => resolveReviewChurn({ env, platform: {} }).sameTree],
  ['review-early-start', 'WE_REVIEW_START_EARLY', 'shadow', 'off',
    (env = {}) => resolveTimingPolicy({ env, platformReview: {}, platformFix: {} }).review.startEarly],
  ['delivery-capacity auto tune', null, 'shadow', 'off',
    () => resolveDeliveryCapacity({ env: {}, platform: {} }).value.autoTune.mode],
  ['delivery-priority', null, 'shadow', 'off',
    () => readDeliveryPrioritySettings({ env: {}, read: (...args) => readFileSync(...args) }).mode],
  ['test-result-cache trace', 'WE_TEST_CACHE_TRACE', '1', '0',
    (env = {}) => traceEnabled(env) ? 'shadow' : 'off'],
  ['stale-referral-human', 'WE_STALE_REFERRAL_HUMAN_SHADOW', '1', '0',
    (env = {}) => resolveStaleReferralHumanShadow({ env, platform: {} }).value.enabled ? 'shadow' : 'off'],
  ['drain-async', 'WE_ASYNC_DRAIN', 'shadow', 'off', (env = {}) => {
    const dir = temp();
    const observer = createAsyncShadow({ env, dir });
    observer.observePass({ candidates: [{ repo: 'o/r', num: 7, headSha: HEAD }] });
    observer.recordActual({ repo: 'o/r', num: 7, headSha: HEAD });
    return readdirSync(dir).length ? 'shadow' : 'off';
  }],
  ['test-selection-measure', 'WE_MEASURE_TEST_SELECTION', undefined, undefined,
    () => Object.keys(workflow('test-selection-measure').on).join(',') === 'workflow_dispatch' ? 'off' : 'shadow'],
  ['drain-verdict', null, 'schedule', 'workflow_dispatch',
    () => Object.keys(workflow('drain-verdict').on).join(',') === 'workflow_dispatch' ? 'off' : 'shadow'],
];
const HEAD = 'a'.repeat(40), MAIN = 'b'.repeat(40);
const provenance = { runId: '123456', event: 'workflow_dispatch', ref: 'refs/heads/main', workflow: 'drain-verdict' };
const inputs = { repo: 'o/r', pr: 7, headSha: HEAD, mainSha: MAIN, computedAt: '2026-11-21T12:00:00.000Z', decision: 'enqueue', provenance };
const now = Date.parse(inputs.computedAt);

it('the drain-async probe runs where TMPDIR is unset (Linux CI)', () => {
  const saved = process.env.TMPDIR;
  delete process.env.TMPDIR; // vi.stubEnv(…, undefined) can leave the string 'undefined' behind
  try {
    const drainAsync = flags.find(([name]) => name === 'drain-async');
    expect(drainAsync[4]({ WE_ASYNC_DRAIN: 'shadow' })).toBe('shadow');
  } finally { if (saved !== undefined) process.env.TMPDIR = saved; }
});

it('each retired shadow flag resolves off', () => {
  for (const [name, , , , resolve] of flags) expect.soft(resolve(), name).toBe('off');
});

// ── Consumer equivalence: each flag's resolved value is fed to the code that READS it in production. ──
// `observed` is the shadow side effect and MUST differ between the old and retired value: it proves the varied
// input reached the consumer (a negative control; without it a byte-identical comparison is vacuous).
// `counted` is the live decision that consumer feeds and MUST be byte-identical. A flag whose only consumer is an
// observer has `counted: null`: retiring it is proven by its observer going silent, not by an equivalence claim.
const at = h => `2026-10-10T${String(h).padStart(2, '0')}:00:00Z`;
const BOT = { login: 'web-everything' };
const accept = (head, h) => ({ author: BOT, createdAt: at(h), body: `✅ review — accepted\n\n<!-- reviewed-sha: ${head} -->` });
const REQUIRED = ['standards', 'test-shard (1)', 'test'];
const ok = name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS', headSha: HEAD });
const CHECK_SHAPES = {
  green: REQUIRED.map(ok),
  pending: [ok('standards'), ok('test-shard (1)'), { name: 'test', status: 'IN_PROGRESS', conclusion: null, headSha: HEAD }],
  fastPending: [ok('standards'), { name: 'test-shard (1)', status: 'IN_PROGRESS', conclusion: null, headSha: HEAD }, ok('test')],
  fastMissing: [ok('standards'), ok('test')],
  red: [{ name: 'standards', status: 'COMPLETED', conclusion: 'FAILURE', headSha: HEAD }, ok('test-shard (1)'), ok('test')],
};
const reconcilePr = (checks, extra = {}) => ({
  number: 7, headRefName: 'lane/x-thing', headRefOid: HEAD, baseRefName: 'main', isDraft: false, createdAt: at(0),
  labels: [{ name: 'review:pending' }], files: [{ path: 'src/a.mjs' }], statusCheckRollup: checks,
  rowsComplete: true, rowsHead: HEAD, comments: [], ...extra });
const plan = (pr, reviewTiming = { startAfter: 'ci-green' }) => planReconcile({ reviewTiming, prs: [pr], agents: [],
  durableCounts: {}, now: Date.parse(at(20)), requiredChecks: REQUIRED });
const rowOf = result => result.dispatch.find(row => row.prNumber === 7) ?? null;
const without = (value, key) => JSON.stringify(value, (k, v) => k === key ? undefined : v);
const churnPlan = (settings, comments, trees) => plan(reconcilePr(REQUIRED.map(ok), { comments,
  reviewChurn: { settings, headTree: 't'.repeat(40), trees } }));
const startGate = (policy, checks) => reviewStartGate({ headSha: HEAD, checks, requiredChecks: REQUIRED,
  rowsHead: HEAD, rowsComplete: true, repo: 'we', policy });
const startEarlyOf = value => resolveTimingPolicy({ env: { WE_REVIEW_START_EARLY: value }, platformReview: {}, platformFix: {} }).review;
// startEarly is read only when startAfter is NOT the repo's `push`: these are the documented rollback targets.
const ROLLBACK_START_AFTER = ['fast-checks', 'ci-green'];

const consumers = {
  'review-churn same tree': env => {
    const twin = 'c'.repeat(40);
    const result = churnPlan(resolveReviewChurn({ env, platform: {} }), [accept(twin, 1)], { [twin]: 't'.repeat(40) });
    return { observed: rowOf(result)?.churnShadow?.kind ?? null, counted: without(result, 'churnShadow') };
  },
  'review-churn cap': env => {
    const heads = ['c', 'd', 'e'].map(c => c.repeat(40));
    const settings = { ...resolveReviewChurn({ env, platform: {} }), maxLoopsPerPr: 2 };
    const result = churnPlan(settings, heads.map((head, i) => accept(head, i + 1)), {});
    return { observed: rowOf(result)?.churnShadow?.kind ?? null, counted: without(result, 'churnShadow') };
  },
  // Driven under each rollback startAfter, where reviewStartGate reads startEarly (under the repo's `push` it is
  // unread: pinned separately below). Review permission (`allowed`) is the counted decision; the refusal reason a
  // status label reads is pinned in its own test, because retiring DOES rename it on two shapes.
  'review-early-start': env => {
    const { startEarly } = resolveTimingPolicy({ env, platformReview: {}, platformFix: {} }).review;
    const policies = ROLLBACK_START_AFTER.map(startAfter => ({ ...REVIEW_TIMING_DEFAULTS, startAfter, startEarly }));
    return {
      observed: policies.every(policy => startGate(policy, CHECK_SHAPES.fastPending).wouldStartEarly === true),
      counted: JSON.stringify(policies.map(policy =>
        Object.values(CHECK_SHAPES).map(checks => [startGate(policy, checks).allowed, startGate(policy, checks).affected]))),
    };
  },
  // The tune shell is observation only (its recommendation is journaled, never applied): observer-only.
  'delivery-capacity auto tune': (env, mode) => {
    const resolvePolicy = () => resolveDeliveryCapacity({ env, platform: {},
      read: () => ({ deliveryCapacity: { autoTune: { mode } } }) });
    const touched = [];
    const io = { statSync: file => { touched.push(file); throw Object.assign(Error('absent'), { code: 'ENOENT' }); },
      readFileSync: () => '' };
    const tune = createDeliveryCapacityTune({ resolvePolicy, io, coordinationRoot: () => 'coord', now: () => now,
      exec: () => { touched.push('gh'); throw Error('no network in this test'); },
      readOpenPrs: () => [], readSources: () => ({}) });
    tune({ units: 4, mode: 'units' });
    return { observed: touched.length > 0, counted: null };
  },
  // The fix pass only logs the priority ranking (reconcile-fix-dispatch puts it on the pass output): observer-only.
  'delivery-priority': (env, mode) => {
    const lines = [];
    logFixPassPriorityShadow({ planned: [{ pr: 7, kind: 'fix', headRefOid: HEAD }], env, now, log: line => lines.push(line),
      readOwner: () => null,
      readSettings: () => readDeliveryPrioritySettings({ env, read: () => JSON.stringify({ deliveryPriority: { mode } }) }) });
    return { observed: lines.length > 0, counted: null };
  },
  // Observer-only, and its gate (review-loop-cli `mode !== 'off'`) needs the whole review-loop harness. That real
  // gate is driven under off/shadow/on, with live effects asserted identical, by review-loop-cli.test.mjs
  // 'CLI records later %s broken ratings and preserves off/shadow/on live effects'. Here: the value that gate reads.
  'post-accept-advisory': env => ({
    observed: resolvePostAcceptAdvisorySettings({ env, platform: {}, log: () => {} }).value.mode !== 'off', counted: null }),
  'stale-referral-human': async env => {
    const decision = await decideStaleReferralHumanHold({ repo: 'o/r', headRefOid: HEAD, labels: [{ name: 'review:human' }] },
      { settings: resolveStaleReferralHumanShadow({ env, platform: {} }) });
    return { observed: decision.why !== 'shadow disabled', counted: null };
  },
  // The vitest shadow reporter hands traced workers a run id only when tracing is on.
  'test-result-cache trace': env => {
    const reporterEnv = { ...env };
    new ShadowReporter({ env: reporterEnv, dir: temp() }).onInit({ config: { root: temp() } });
    return { observed: 'WE_TEST_CACHE_RUN_ID' in reporterEnv, counted: null };
  },
  'drain-async': env => ({ observed: flags.find(([name]) => name === 'drain-async')[4](env) === 'shadow', counted: null }),
};

it('every retired setting flag has a consumer probe', () => {
  const settingFlags = flags.map(([name]) => name).filter(name => !['test-selection-measure', 'drain-verdict'].includes(name));
  expect(Object.keys(consumers).sort()).toEqual(settingFlags.sort());
});

it.each(flags.filter(([name]) => consumers[name]))(
  '%s: the real consumer observes the old shadow value and the retired value silences it, leaving any counted decision unchanged',
  async (name, envKey, before, off) => {
    const envFor = value => envKey ? { [envKey]: value } : {};
    const old = await consumers[name](envFor(before), before);
    const retired = await consumers[name](envFor(off), off);
    expect(old.observed, `${name}: the shadow value must reach the consumer (negative control)`).toBeTruthy();
    expect(retired.observed, `${name}: the retired value leaves the observer silent`).toBeFalsy();
    expect(retired.counted, `${name}: counted decision`).toBe(old.counted);
  });

it('review-early-start: under the repo startAfter (push) the start gate and the reconcile plan never read startEarly', () => {
  const live = value => startEarlyOf(value);
  expect(live('off').startAfter).toBe('push');
  for (const [shape, checks] of Object.entries(CHECK_SHAPES)) {
    expect(startGate(live('off'), checks), shape).toEqual(startGate(live('shadow'), checks));
    expect(JSON.stringify(plan(reconcilePr(checks), live('off'))), shape).toBe(JSON.stringify(plan(reconcilePr(checks), live('shadow'))));
  }
});

// NOT byte-identical, recorded rather than hidden: after a rollback of startAfter, the retired value restores the
// original strict refusal REASON (review-timing.mjs: "Rollback preserves the original strict CI-green result").
// Review permission and affected rows stay identical (counted above). The reason is an input to the review status
// label (pr-status-label reviewCiWait), so after such a rollback two shapes are labelled from the strict reason.
it('review-early-start: after a startAfter rollback, retiring renames exactly these refusal reasons', () => {
  const renamed = {};
  for (const startAfter of ROLLBACK_START_AFTER) for (const [shape, checks] of Object.entries(CHECK_SHAPES)) {
    const [shadow, off] = ['shadow', 'off'].map(value =>
      startGate({ ...REVIEW_TIMING_DEFAULTS, startAfter, startEarly: startEarlyOf(value).startEarly }, checks));
    expect(off.allowed, `${startAfter} ${shape}`).toBe(shadow.allowed);
    if (off.reason !== shadow.reason) renamed[`${startAfter} ${shape}`] = [shadow.reason, off.reason];
  }
  expect(renamed).toEqual({
    'fast-checks fastMissing': ['ci-not-registered', 'required-checks-not-successful'],
    'ci-green fastMissing': ['ci-not-registered', 'required-checks-not-successful'],
    'ci-green red': ['ci-red', 'required-checks-not-successful'],
  });
});

// Workflow triggers have no in-process consumer: no counted function reads a workflow file, so there is no
// equivalence to compare. The guard is the trigger shape itself (and auditWorkflow's refusal of other triggers).
it.each(['test-selection-measure', 'drain-verdict'])('%s: only a manual trigger remains', name => {
  expect(Object.keys(workflow(name).on)).toEqual(['workflow_dispatch']);
});

it('absent evidence and a moved head remain closed after retirement', () => {
  expect(verify(null, inputs, { now }).ok).toBe(false);
  expect(verify(build(inputs), { ...inputs, headSha: MAIN }, { now }).ok).toBe(false);
  expect(evaluatePrGates({ num: 7, prReadError: 'unreadable' }).ok).toBe(false);
  expect(() => derivePanelVerdict({ findings: [], lensVerdicts: {} })).toThrow(/missing verdict/);
  expect(workflow('test-selection-measure').env?.WE_MEASURE_TEST_SELECTION).toBeUndefined();
});
