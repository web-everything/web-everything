import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planReconcile } from '../reconcile-core.mjs';
import { loadExternalCheckApps, isExternalAppCheck } from '../external-check-apps.mjs';

const repo = 'web-everything/web-everything';
const head = 'ab9985630d90019a07b94e946bc75f8de7a6161f';
const NOW = Date.parse('2026-10-14T17:00:00Z');
const failed = { name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-14T16:00:00Z',
  detailsUrl: `https://github.com/${repo}/actions/runs/123/job/456` };
const evidence = { eligible: true, repo, pr: 5273, head, signature: 's', variant: 'owed-ci-rerun',
  jobs: [{ repo, head, run: 123, job: 456, attempt: 1 }], infraCancelled: true };
const plan = (rollup) => planWith(['test'], rollup);
const inputWith = (requiredChecks, rollup) => ({
  prs: [{ number: 5273, state: 'OPEN', isDraft: true, headRefName: 'lane/x', headRefOid: head, labels: [],
    mergeStateStatus: 'BLOCKED', comments: [], statusCheckRollup: rollup, requiredCheckCompletedAt: '2026-10-14T16:00:00Z',
    requiredCheckName: 'test', aheadByOnMain: 0, mainGreenNow: { red: false, sha: '123456789abcdef', at: '2026-10-14T07:00:00Z' },
    owedCiRerunRetry: evidence, timeoutRetry: { eligible: false, reason: 'timeout-evidence:incomplete-failure-inventory' },
    timeoutRetryBudget: { confirmed: 0, rejected: 0 } }],
  agents: [], requiredChecks, now: NOW, mainRedWindows: [], staleCiRerun: 'once-per-head' });
const planWith = (requiredChecks, rollup) => planReconcile(inputWith(requiredChecks, rollup));
const reran = out => out.dispatch.some(r => r.kind === 'ci-timeout-rerun');
const iso = ms => new Date(NOW - ms).toISOString();

const exemptChecks = [
  { __typename: 'CheckRun', name: 'review-gate', workflowName: 'Review gate', status: 'IN_PROGRESS' },
  { __typename: 'CheckRun', name: 'red-team', workflowName: '', status: 'IN_PROGRESS',
    appSlug: 'web-everything', appId: 5037855, detailsUrl: 'https://example.invalid/app-check' },
];
const rerunVariants = ['stale-ci-rerun', 'owed-ci-rerun'];
const missingStatuses = [{}, { status: undefined }, { status: null }, { status: '' }];

// Exercise both callers of the live-check guard through the real planner. The control
// pins the branch and proves that the refusal is caused only by the changed evidence.
function assertBoundary(reconcile, variant, check, { pr = {}, checkFields = {} } = {}) {
  const input = inputWith(['test'], [failed, check]);
  input.owedCiRerun = { rerun: 'on', maxRerunsPerHead: 1 };
  if (variant === 'owed-ci-rerun') {
    input.mainRedWindows = [{ start: '2026-10-14T15:00:00Z', end: '2026-10-14T16:30:00Z' }];
    input.prs[0].aheadByOnMain = 33;
    input.prs[0].mainGreenNow = { ...input.prs[0].mainGreenNow, at: '2026-10-14T16:30:00Z' };
  }
  expect(reconcile(input).dispatch).toContainEqual(expect.objectContaining({ kind: 'ci-timeout-rerun', variant }));
  const { status, ...withoutStatus } = check;
  const held = reconcile({ ...input, prs: [{ ...input.prs[0], ...pr,
    statusCheckRollup: [failed, { ...withoutStatus, ...checkFields }] }] });
  expect(reran(held)).toBe(false);
  expect(held.refusals).toContainEqual(expect.objectContaining({
    kind: variant === 'owed-ci-rerun' ? 'owed-ci-rerun' : 'ci-timeout-rerun-in-flight',
    why: expect.stringContaining('still running'),
  }));
}

describe('a stale or unrelated live check does not defer the CI re-run forever (PR #6873)', () => {
  it('incomplete rollup holds despite an otherwise exempt external check', () => {
    for (const variant of rerunVariants) {
      for (const check of exemptChecks) {
        assertBoundary(planReconcile, variant, check, { pr: { rollupIncomplete: true }, checkFields: { status: check.status } });
      }
    }
  });
  it('status-less checks hold despite another workflow or configured app provenance', () => {
    for (const variant of rerunVariants) {
      for (const check of exemptChecks) {
        for (const checkFields of missingStatuses) assertBoundary(planReconcile, variant, check, { checkFields });
      }
    }
  });
  // Targeted mutation gate: load independent sibling copies so relative imports keep
  // working without ever changing the production module or nesting a test runner.
  // Import failures happen outside toThrow; only the no-rerun assertion kills a mutant.
  it.each([
    { name: 'rollupIncomplete refusal', find: "if (pr?.rollupIncomplete === true) return ['<rollup incomplete>'];", replace: '',
      cases: check => [{ pr: { rollupIncomplete: true }, checkFields: { status: check.status } }] },
    { name: 'status prerequisite', find: 'required && c.status && !required.has(c.name) && proven',
      replace: 'required && !required.has(c.name) && proven', cases: () => missingStatuses.map(checkFields => ({ checkFields })) },
  ])('boundary mutation gate kills removal of $name', async ({ find, replace, cases }) => {
    // Keep filesystem paths out of Vite's browser-asset URL transform.
    const conveyorDir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const source = readFileSync(join(conveyorDir, 'reconcile-core.mjs'), 'utf8');
    expect(source.split(find)).toHaveLength(2);
    const mutant = join(conveyorDir, `reconcile-core.boundary-mutant-${randomUUID()}.mjs`);
    writeFileSync(mutant, source.replace(find, () => replace), { flag: 'wx' });
    try {
      const { planReconcile: mutatedPlan } = await import(/* @vite-ignore */ mutant);
      for (const variant of rerunVariants) {
        for (const check of exemptChecks) {
          for (const boundary of cases(check)) {
            assertBoundary(planReconcile, variant, check, boundary);
            expect(() => assertBoundary(mutatedPlan, variant, check, boundary)).toThrowError(/^expected true to be false/);
          }
        }
      }
    } finally {
      unlinkSync(mutant);
    }
  });
  it('re-runs when the only live check is a non-required check of another workflow', () => {
    expect(reran(plan([failed, { name: 'review-gate', workflowName: 'Review gate', status: 'IN_PROGRESS', startedAt: iso(60_000) }]))).toBe(true);
  });
  it('holds for a long-running same-workflow check (no age cap) and for an unproven workflow', () => {
    expect(reran(plan([failed, { name: 'smoke', workflowName: 'CI', status: 'IN_PROGRESS', startedAt: iso(3 * 3600_000) }]))).toBe(false);
    expect(reran(plan([{ ...failed, workflowName: '' }, { name: 'review-gate', workflowName: 'Review gate', status: 'IN_PROGRESS' }]))).toBe(false);
    expect(reran(plan([failed, { __typename: 'CheckRun', name: 'x', startedAt: iso(3 * 3600_000) }]))).toBe(false);
  });
  it('re-runs only when the workflow-less check is posted by the configured red-team app (live #6873)', () => {
    const redTeam = { __typename: 'CheckRun', name: 'red-team', workflowName: '', status: 'IN_PROGRESS', conclusion: '', startedAt: iso(8 * 3600_000),
      detailsUrl: 'https://example.invalid/app-check', appSlug: 'web-everything', appId: 5037855 };
    expect(reran(plan([failed, redTeam]))).toBe(true);
    // same name from another app, name+link alone, or missing app metadata: fail closed
    expect(reran(plan([failed, { ...redTeam, appSlug: 'other-app', appId: 42 }]))).toBe(false);
    expect(reran(plan([failed, { ...redTeam, appSlug: undefined, appId: undefined }]))).toBe(false);
    expect(reran(plan([failed, { ...redTeam, appId: null }]))).toBe(false);
    expect(reran(plan([failed, { ...redTeam, name: 'smoke' }]))).toBe(false);
    expect(reran(plan([failed, { ...redTeam, detailsUrl: `https://github.com/${repo}/actions/runs/9/job/1` }]))).toBe(true);
    // a REQUIRED check still running holds
    expect(reran(plan([failed, { ...redTeam, name: 'test', detailsUrl: `https://github.com/${repo}/actions/runs/9/job/2` }]))).toBe(false);
  });
  it('ships the live red-team poster in settings and fails closed when settings are unreadable', async () => {
    const { loadExternalCheckApps } = await import('../external-check-apps.mjs');
    expect(loadExternalCheckApps()).toContainEqual({ name: 'red-team', appSlug: 'web-everything', appId: 5037855 });
    expect(loadExternalCheckApps({ read: () => { throw new Error('x'); } })).toEqual([]);
    expect(loadExternalCheckApps({ read: () => '{"fix":{"externalCheckApps":[{"name":"red-team"}]}}' })).toEqual([]);
  });
  it('matches a slug-only external app configuration after loading settings without an app id', () => {
    const apps = loadExternalCheckApps({ read: () => JSON.stringify({ fix: {
      externalCheckApps: [{ name: 'red-team', appSlug: 'web-everything' }],
    } }) });
    expect(apps).toEqual([{ name: 'red-team', appSlug: 'web-everything', appId: null }]);
    expect(isExternalAppCheck({ name: 'red-team', appSlug: 'web-everything' }, apps)).toBe(true);
    expect(isExternalAppCheck({ name: 'red-team', appSlug: 'web-everything', appId: 5037855 }, apps)).toBe(true);
  });
  it('fails closed for a slug-only external app when the check name or app slug is wrong or missing', () => {
    const apps = [{ name: 'red-team', appSlug: 'web-everything', appId: null }];
    for (const check of [
      { name: 'smoke', appSlug: 'web-everything' },
      { appSlug: 'web-everything' },
      { name: 'red-team', appSlug: 'other-app' },
      { name: 'red-team' },
      { name: 'red-team', appSlug: null },
      { name: 'red-team', appSlug: '' },
    ]) expect(isExternalAppCheck(check, apps)).toBe(false);
  });
  it('prefers a configured app id over a matching app slug', () => {
    const apps = [{ name: 'red-team', appSlug: 'web-everything', appId: 5037855 }];
    expect(isExternalAppCheck({ name: 'red-team', appSlug: 'other-app', appId: 5037855 }, apps)).toBe(true);
    expect(isExternalAppCheck({ name: 'red-team', appSlug: 'web-everything', appId: 42 }, apps)).toBe(false);
    expect(isExternalAppCheck({ name: 'red-team', appSlug: 'web-everything' }, apps)).toBe(false);
  });
  it('matches a slug-only external app beyond the first configured entry', () => {
    const apps = loadExternalCheckApps({ read: () => JSON.stringify({ fix: {
      externalCheckApps: [
        { name: 'red-team', appSlug: 'other-app' },
        { name: 'red-team', appSlug: 'web-everything' },
      ],
    } }) });
    expect(isExternalAppCheck({ name: 'red-team', appSlug: 'web-everything' }, apps)).toBe(true);
  });
  it('holds when proof is partial or the live check shares a run with a required check (audit round 1)', () => {
    const run = `https://github.com/${repo}/actions/runs/123/job/9`;
    const out = (rollup) => reran(planWith(['test', 'lint'], rollup));
    expect(out([{ ...failed, workflowName: '' }, { name: 'lint', workflowName: 'Lint', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'smoke', workflowName: 'CI', status: 'IN_PROGRESS', detailsUrl: run }])).toBe(false);
    // proof is COMPLETE here (lint present and named), so only the same-run protection can hold this rerun
    const lint = { name: 'lint', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' };
    expect(out([failed, lint, { name: 'smoke', workflowName: 'Other', status: 'IN_PROGRESS', detailsUrl: run }])).toBe(false);
    expect(out([failed, lint, { name: 'smoke', workflowName: 'Other', status: 'IN_PROGRESS', detailsUrl: 'https://example.invalid/x' }])).toBe(true);
  });
  it('holds when ANY row of a required check name lacks workflow metadata (audit r4 finding 1)', () => {
    const smoke = { name: 'smoke', workflowName: 'Other', status: 'IN_PROGRESS', startedAt: iso(60_000) };
    const lint = { name: 'lint', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' };
    expect(reran(planWith(['test', 'lint'], [failed, lint, { ...lint, workflowName: '' }, smoke]))).toBe(false);
    expect(reran(planWith(['test', 'lint'], [failed, lint, { ...lint }, smoke]))).toBe(true);
  });
  it('holds when a configured required check is absent from the rollup (audit r3 finding 1)', () => {
    const smoke = { name: 'smoke', workflowName: 'Other', status: 'IN_PROGRESS', startedAt: iso(60_000) };
    // required `lint` is absent from the rollup: the workflow proof is incomplete, so the live check holds the rerun
    expect(reran(planWith(['test', 'lint'], [failed, smoke]))).toBe(false);
    // control: with `lint` present and named, a different-workflow live check is still ignored
    expect(reran(planWith(['test', 'lint'], [failed, { name: 'lint', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }, smoke]))).toBe(true);
  });
  it('still holds for a recent live run of the CI workflow', () => {
    const out = plan([failed, { name: 'test-shard (1)', workflowName: 'CI', status: 'IN_PROGRESS', startedAt: iso(5 * 60_000) }]);
    expect(reran(out)).toBe(false);
    expect(out.refusals).toContainEqual(expect.objectContaining({ kind: 'ci-timeout-rerun-in-flight', why: expect.stringContaining('(live: test-shard (1))') }));
  });
});
