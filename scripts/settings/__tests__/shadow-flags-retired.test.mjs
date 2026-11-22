// @vitest-environment node
// Tier 1: hermetic policy boundaries, no forge calls or counted-path mutations.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { resolvePostAcceptAdvisorySettings } from '../../lib/post-accept-advisory-settings.mjs';
import { resolveTimingPolicy } from '../../lib/review-timing-settings.mjs';
import { resolveReviewChurn } from '../../conveyor/review-churn.mjs';
import { resolveDeliveryCapacity } from '../../lib/delivery-capacity.mjs';
import { readDeliveryPrioritySettings } from '../../conveyor/delivery-priority-shadow.mjs';
import { resolveStaleReferralHumanShadow } from '../../conveyor/stale-referral-human-shadow.mjs';
import { createAsyncShadow } from '../../lib/drain-async-shadow.mjs';
import { traceEnabled } from '../../lib/test-cache-trace.mjs';
import { derivePanelVerdict, MANDATORY_LENSES } from '../../lib/jury-core.mjs';
import { reviewMustVoid } from '../../lib/review-timing.mjs';
import { classifyPr } from '../../merge-ai-prs.mjs';
import { evaluatePrGates } from '../../lib/merge-gate-ci.mjs';
import { build, verify } from '../../lib/drain-verdict.mjs';

const root = new URL('../../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const workflow = name => yaml.load(read(`.github/workflows/${name}.yml`));
const dirs = [];
const temp = () => { const dir = mkdtempSync(join(process.env.TMPDIR, 'retired-shadow-')); dirs.push(dir); return dir; };
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

// Adapted from merge-gate-ci.test.mjs: pinned, accepted, prose-only PR; inject all IO.
function facts() {
  return {
    repo: 'o/r', num: 7, defaultBranch: 'main',
    pr: { number: 7, title: 't', body: 'A real body', baseRefName: 'main', headRefName: 'lane/x', headRefOid: HEAD,
      isCrossRepository: false, labels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }],
      commits: [{ oid: HEAD, messageHeadline: 'x', messageBody: 'Co-Authored-By: Claude <noreply@anthropic.com>' }], statusCheckRollup: [] },
    manifest: { live: null }, netSignals: { scored: true, changedFiles: ['docs/a.md'], diffLines: 2,
      humanBasisFiles: ['docs/a.md'], cumulativeDiffLines: 2, basisNarrowed: true,
      netDiffText: { text: 'diff --git a/docs/a.md b/docs/a.md\n@@ -0,0 +1 @@\n+doc\n', scored: true, rev: HEAD }, diffHunks: '' },
    acceptance: { headSha: HEAD, acceptedSha: HEAD, headReadFailed: false },
    bodyHistory: { bodies: ['A real body'], complete: true }, duplicateIds: { main: [] },
    redMain: { source: 'ops/red-main', frozen: false }, enqueueClearance: null,
    redTeamCheck: { ok: true, reason: 'red-team check run succeeded on head' },
    ledger: { authority: 'labels', folded: null, derived: null }, pinnedHead: { sha: HEAD }, gatePaths: { files: ['docs/a.md'] },
  };
}
function countedOutputs() {
  const f = facts();
  const options = { carrySetting: { value: 'off', source: 'test' }, proveCarry: () => { throw Error('unexpected IO'); }, write: () => {} };
  const verdict = build(inputs);
  return JSON.stringify({
    review: ['accept', 'changes', 'needs-human'].map(v => derivePanelVerdict({ findings: [],
      lensVerdicts: Object.fromEntries(MANDATORY_LENSES.map(lens => [lens, v])) })),
    drain: [classifyPr(f.pr), classifyPr({ ...f.pr, statusCheckRollup: null }), classifyPr({ ...f.pr, isDraft: true })],
    merge: [evaluatePrGates(f, options), evaluatePrGates({ num: 7, prReadError: 'unreadable' }, options)],
    headBinding: [verify(verdict, inputs, { now }), verify(verdict, { ...inputs, headSha: MAIN }, { now }),
      verify(null, inputs, { now }), reviewMustVoid({ reviewedHead: HEAD, currentHead: MAIN, checks: [] })],
  });
}

it('each retired shadow flag resolves off', () => {
  for (const [name, , , , resolve] of flags) expect.soft(resolve(), name).toBe('off');
});

// File-only settings use the production resolver's read seam; no repository settings are edited.
function resolveObserver(name, env, value, resolve) {
  if (name === 'delivery-capacity auto tune') return resolveDeliveryCapacity({ env, platform: {},
    read: () => ({ deliveryCapacity: { autoTune: { mode: value } } }) }).value.autoTune.mode;
  if (name === 'delivery-priority') return readDeliveryPrioritySettings({ env,
    read: () => JSON.stringify({ deliveryPriority: { mode: value } }) }).mode;
  return resolve(env);
}

it.each(flags.filter(([name]) => !['test-selection-measure', 'drain-verdict'].includes(name)))(
  '%s: real resolver selects old shadow and retired values with byte-identical counted verdicts',
  (name, envKey, before, off, resolve) => {
    const env = {};
    if (envKey) { env[envKey] = before; vi.stubEnv(envKey, before); }
    expect(resolveObserver(name, env, before, resolve), `${name} old shadow`).toBe('shadow');
    const previous = countedOutputs();
    if (envKey) { env[envKey] = off; vi.stubEnv(envKey, off); }
    expect(resolveObserver(name, env, off, resolve), `${name} retired`).toBe('off');
    expect(countedOutputs(), name).toBe(previous);
  });

// Workflow triggers have no settings resolver. Exercise the real YAML loader for both shapes.
it.each(['test-selection-measure', 'drain-verdict'])(
  '%s: old automatic and retired manual triggers leave counted verdict bytes identical', name => {
    const doc = workflow(name);
    expect(Object.keys(doc.on)).toEqual(['workflow_dispatch']);
    const retired = countedOutputs();
    const old = yaml.load(yaml.dump({ ...doc, on: { ...doc.on,
      ...(name === 'drain-verdict' ? { schedule: [{ cron: '*/10 * * * *' }] } : { push: { branches: ['main'] } }) } }));
    expect(Object.keys(old.on)).toContain(name === 'drain-verdict' ? 'schedule' : 'push');
    expect(countedOutputs()).toBe(retired);
  });

it('absent evidence and a moved head remain closed after retirement', () => {
  expect(verify(null, inputs, { now }).ok).toBe(false);
  expect(verify(build(inputs), { ...inputs, headSha: MAIN }, { now }).ok).toBe(false);
  expect(evaluatePrGates({ num: 7, prReadError: 'unreadable' }).ok).toBe(false);
  expect(() => derivePanelVerdict({ findings: [], lensVerdicts: {} })).toThrow(/missing verdict/);
  expect(workflow('test-selection-measure').env?.WE_MEASURE_TEST_SELECTION).toBeUndefined();
});
