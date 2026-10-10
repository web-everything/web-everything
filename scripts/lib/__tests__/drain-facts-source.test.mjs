/**
 * @file scripts/lib/__tests__/drain-facts-source.test.mjs
 * @description The drain's pass-start PR reads from the webhook store when fresh, else GitHub (operator go
 *   2026-10-09 16:35 ET). Store rows below are shaped like the live store's answer for web-everything on 2026-10-09.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadDrainFactsSettings, readPassFacts, storeCheckRow, resolveRequiredCheckViaStore, overlayListingRow,
  createFactsTally, formatFactsSourceLine, DRAIN_FACTS_SOURCE_ENV,
} from '../drain-facts-source.mjs';
import { SETTINGS_DIR } from '../settings-files.mjs';

const WE = 'web-everything/web-everything';
const HEAD = 'a6c2b3336aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const storeRow = (over = {}) => ({ repo: WE, number: 4017, headSha: HEAD, draft: false, state: 'open', merged: false,
  labels: ['ready-to-merge', 'review:accepted'], checks: [{ name: 'test', app: 'github-actions', conclusion: 'success' }], suites: [], review: null, ...over });
const reader = (rows) => async ({ repo }) => (repo === WE ? { asOfMs: Date.now() - 2000, prs: rows } : null);

describe('settings cascade', () => {
  it('built-in default store-first; the declared file says store-first; env overrides; unknown → github', () => {
    expect(loadDrainFactsSettings({ file: {}, env: {} }).source).toBe('store-first');
    const file = JSON.parse(readFileSync(join(SETTINGS_DIR, 'drain-facts-source.json'), 'utf8'));
    expect(loadDrainFactsSettings({ file, env: {} }).source).toBe('store-first');
    expect(loadDrainFactsSettings({ file, env: { [DRAIN_FACTS_SOURCE_ENV]: 'github' } }).source).toBe('github');
    const bad = loadDrainFactsSettings({ file: { drainFactsSource: { source: 'nope' } }, env: {} });
    expect(bad.source).toBe('github');
    expect(bad.errors.join()).toMatch(/drainFactsSource/);
  });
});

describe('readPassFacts', () => {
  it('store per repo when fresh, github with the reason otherwise', async () => {
    const by = await readPassFacts({ repos: [WE, 'frontier-ui/frontierui', null], readRepoFacts: reader([storeRow()]) });
    expect(by.get(WE)).toMatchObject({ source: 'store', reason: 'served' });
    expect(by.get(WE).prs.get(4017).headSha).toBe(HEAD);
    expect(by.get('frontier-ui/frontierui')).toMatchObject({ source: 'github', reason: 'store-not-fresh' });
    expect(by.get('cwd')).toMatchObject({ source: 'github', reason: 'no-repo-slug' });
  });
  it('the reader\'s own reason is kept; a throwing reader falls back, never throws', async () => {
    const by = await readPassFacts({ repos: [WE, 'x/y'], readRepoFacts: async ({ repo }) => { if (repo === WE) return { unavailable: 'feed-stale' }; throw new Error('boom'); } });
    expect(by.get(WE)).toMatchObject({ source: 'github', reason: 'feed-stale' });
    expect(by.get('x/y').reason).toMatch(/^store-error: boom/);
  });
  it('setting github → no store read at all', async () => {
    const read = vi.fn();
    const by = await readPassFacts({ repos: [WE], settings: { source: 'github' }, readRepoFacts: read });
    expect(read).not.toHaveBeenCalled();
    expect(by.get(WE)).toMatchObject({ source: 'github', reason: 'setting: github' });
  });
});

describe('the required check from the store', () => {
  const pr = { number: 4017, headRefOid: HEAD, statusCheckRollup: [] };
  const byOf = async (rows) => (await readPassFacts({ repos: [WE], readRepoFacts: reader(rows) })).get(WE);
  it('a completed run on the SAME head answers', async () => {
    expect(storeCheckRow(await byOf([storeRow()]), pr)).toMatchObject({ __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS', head_sha: HEAD });
  });
  it('another head, no such check, or no conclusion → null (absence is never green)', async () => {
    expect(storeCheckRow(await byOf([storeRow({ headSha: 'other' })]), pr)).toBeNull();
    expect(storeCheckRow(await byOf([storeRow({ checks: [] })]), pr)).toBeNull();
    expect(storeCheckRow(await byOf([storeRow({ checks: [{ name: 'test', conclusion: null }] })]), pr)).toBeNull();
  });
  it('resolveRequiredCheckViaStore: store first, GitHub only when the store cannot answer; the fast path is untouched', async () => {
    const tally = createFactsTally();
    const live = vi.fn(async (p) => ({ ...p, resolvedLive: true }));
    const repoFacts = await byOf([storeRow(), storeRow({ number: 4066, headSha: 'f6ea', checks: [] })]);
    const fromStore = await resolveRequiredCheckViaStore({ ...pr, requiredCheckReadError: 'x', statusCheckRollup: [{ name: 'test', __typename: 'CheckRun', conclusion: null }] },
      { repoFacts, needsDirectRead: () => true, resolveLive: live, tally });
    expect(fromStore.requiredCheckReadError).toBeUndefined();
    expect(fromStore.statusCheckRollup).toEqual([expect.objectContaining({ name: 'test', conclusion: 'SUCCESS', source: 'store' })]);
    const fromGh = await resolveRequiredCheckViaStore({ number: 4066, headRefOid: 'f6ea' }, { repoFacts, needsDirectRead: () => true, resolveLive: live, tally });
    expect(fromGh.resolvedLive).toBe(true);
    const fast = { ...pr, statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }] };
    expect(await resolveRequiredCheckViaStore(fast, { repoFacts, needsDirectRead: () => false, resolveLive: live, tally })).toBe(fast);
    expect(tally).toEqual({ checksFromStore: 1, checksFromGithub: 1 });
    expect(live).toHaveBeenCalledTimes(1);
  });
});

describe('overlayListingRow', () => {
  it('labels and draft from the store when it agrees on the head; a head mismatch is marked, not overlaid', async () => {
    const repoFacts = (await readPassFacts({ repos: [WE], readRepoFacts: reader([storeRow({ draft: true })]) })).get(WE);
    const row = { number: 4017, headRefOid: HEAD, labels: [{ name: 'ready-to-merge' }], isDraft: false, mergeable: 'MERGEABLE' };
    expect(overlayListingRow(row, repoFacts)).toEqual({ ...row, labels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }], isDraft: true, factsSource: 'store' });
    expect(overlayListingRow({ ...row, headRefOid: 'newer' }, repoFacts)).toEqual({ ...row, headRefOid: 'newer', factsHeadMismatch: true });
    expect(overlayListingRow(row, { source: 'github', prs: new Map() })).toBe(row);
  });
});

describe('formatFactsSourceLine', () => {
  it('one machine-readable line naming the source per repo', async () => {
    const by = await readPassFacts({ repos: [WE, 'frontier-ui/frontierui'], readRepoFacts: reader([storeRow()]) });
    const line = formatFactsSourceLine(by, { checksFromStore: 3, checksFromGithub: 1 });
    expect(line.startsWith('merge-ai-prs · facts-source: ')).toBe(true);
    const j = JSON.parse(line.replace('merge-ai-prs · facts-source: ', ''));
    expect(j).toMatchObject({ source: 'mixed', checksFromStore: 3, checksFromGithub: 1, repos: { [WE]: { source: 'store', prs: 1 }, 'frontier-ui/frontierui': { source: 'github', reason: 'store-not-fresh' } } });
  });
});
