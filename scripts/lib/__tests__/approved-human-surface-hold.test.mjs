import { describe, it, expect } from 'vitest';
import { decideHoldApprovedHumanSurfaceHead as decide, resolveSkipRebaseApprovedHumanSurface as resolve } from '../approved-human-surface-hold.mjs';
const yes = { setting: 'on', approved: true, humanSurface: true, conflicting: false, manifestOnHead: false };
describe('approved human head hold', () => {
  it('requires all five conditions', () => {
    expect(decide(yes).hold).toBe(true);
    for (const [key, value] of Object.entries({ setting: 'off', approved: false, humanSurface: false, conflicting: true, manifestOnHead: true })) {
      expect(decide({ ...yes, [key]: value }).hold, key).toBe(false);
    }
    expect(decide({}).hold).toBe(false);
  });
  it('resolves default, file, environment and invalid fallthrough', () => {
    const file = JSON.stringify({ mergeQueue: { skipRebaseApprovedHumanSurface: 'on' } });
    expect(resolve({ env: {}, readFile: () => { throw Error(); } })).toEqual({ value: 'off', source: 'default' });
    expect(resolve({ env: {}, readFile: () => file })).toEqual({ value: 'on', source: 'settings' });
    for (const value of ['off', 'false', '0']) expect(resolve({ env: { WE_MERGE_QUEUE_SKIP_REBASE_APPROVED_HUMAN_SURFACE: value }, readFile: () => file }).value).toBe('off');
    for (const value of ['on', 'true', '1']) expect(resolve({ env: { WE_MERGE_QUEUE_SKIP_REBASE_APPROVED_HUMAN_SURFACE: value }, readFile: () => file }).source).toBe('env');
    expect(resolve({ env: { WE_MERGE_QUEUE_SKIP_REBASE_APPROVED_HUMAN_SURFACE: 'bad' }, readFile: () => file }).source).toBe('settings');
  });
});

describe('live approval proof and same-head refresh', () => {
  it('uses trusted live clearance, the tracked manifest and existing human classifier', async () => {
    const { readApprovedHumanSurfaceHold } = await import('../approved-human-surface-hold.mjs');
    const sha = 'a'.repeat(40), base = 'b'.repeat(40);
    let manifest = '', cleared = sha, workflow = true, broken = false, author = 'chalbert';
    const exec = (file, args) => {
      if (broken) throw Error('unreadable');
      if (file === 'gh') return JSON.stringify({ headRefOid: sha, labels: ['review:accepted'], mergeable: 'MERGEABLE' });
      if (args[0] === 'merge-base') return base;
      if (args[0] === 'ls-tree') return manifest;
      if (args.includes('--name-only')) return workflow ? '.github/workflows/test.yml' : 'readme.md';
      return '';
    };
    const read = () => readApprovedHumanSurfaceHold({ setting: 'on', pr: 1, repo: 'owner/repo', expectedHead: sha, exec,
      readComments: () => [{ author: { login: author }, body: `<!-- reviewed-sha: ${cleared} -->\n<!-- cleared-human: operator -->` }] });
    expect(read().hold).toBe(true);
    author = 'stranger'; expect(read().hold).toBe(false); author = 'chalbert';
    manifest = '.lane-manifest.json'; expect(read().hold).toBe(false); manifest = '';
    cleared = base; expect(read().hold).toBe(false); cleared = sha;
    workflow = false; expect(read().hold).toBe(false); broken = true; expect(read).toThrow();
  });
  it('reruns the required workflow on the pinned head and refuses a moved or unreadable head', async () => {
    const { refreshHeldHead } = await import('../approved-human-surface-hold.mjs');
    const { refreshStalePr } = await import('../merge-queue-hook.mjs');
    const sha = 'a'.repeat(40); let reruns = 0;
    const options = { laneRef: 'lane/test', expectedHead: sha, runId: 123, readTip: () => sha, rerun: () => { reruns++; } };
    expect(await refreshHeldHead({ hold: true, options, refresh: refreshStalePr })).toMatchObject({ ok: true, action: 'rerun' });
    expect(reruns).toBe(1);
    expect(await refreshHeldHead({ hold: true, options: { ...options, readTip: () => null }, refresh: refreshStalePr })).toMatchObject({ ok: false, action: 'head-moved' });
    expect(reruns).toBe(1);
    expect(await refreshHeldHead({ hold: true, options: { ...options, runId: null }, refresh: refreshStalePr })).toMatchObject({ ok: false, action: 'current-no-run' });
  });
});

it('excuses queue freshness while preserving actual checks, conflicts and native review holds', async () => {
  const { retainApprovedHumanQueueHead: retain } = await import('../approved-human-surface-hold.mjs');
  const { revalidateForMerge } = await import('../../merge-ai-prs.mjs');
  const facts = { hold: true, queueOwnsFreshness: true };
  const pr = { number: 1, title: 'change', body: 'Real description', headRefOid: 'a'.repeat(40),
    labels: ['ready-to-merge', 'review:accepted'], commits: [], mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND',
    statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
  expect(revalidateForMerge(retain(pr, facts)).decision).toBe('merge');
  expect(revalidateForMerge(pr).decision).toBe('skip');
  const red = { ...pr, statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] };
  expect(revalidateForMerge(retain(red, facts)).decision).toBe('skip');
  for (const change of [{ mergeable: 'CONFLICTING' }, { reviewDecision: 'CHANGES_REQUESTED' }, { mergeStateStatus: 'BLOCKED' }, { mergeStateStatus: 'DIRTY' }]) {
    const blocked = { ...pr, ...change }; expect(retain(blocked, facts)).toBe(blocked);
  }
  expect(retain(pr, { ...facts, hold: false })).toBe(pr);
  expect(retain(pr, { ...facts, queueOwnsFreshness: false })).toBe(pr);
});
