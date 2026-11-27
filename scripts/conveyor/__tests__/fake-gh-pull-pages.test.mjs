// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGithub, openPrPure, withStore } from './helpers/fake-gh.mjs';
import { defaultReadMergedPrs, defaultReadOpenNumbers, runSupersedeWatch } from '../supersede-watch.mjs';

const repo = 'web-everything/web-everything';
const now = Date.parse('2026-06-15T12:00:00Z');
const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fake-gh-pull-pages-'));
  roots.push(root);
  // These list reads require no Git objects. Seed the shared state machine directly.
  const gh = createFakeGithub({ root, repos: [{ slug: repo, originPath: root }] });
  const exec = (command, args, opts) => execFileSync(command, args, {
    ...opts, cwd: root, env: { ...process.env, ...gh.env }, timeout: 5_000,
  });
  const api = query => JSON.parse(exec('gh', ['api', `repos/${repo}/pulls?${query}`], { encoding: 'utf8' }));
  return { gh, exec, api };
}

describe('fake GitHub REST pull list used by supersede-watch', () => {
  it('serves every page past 200 in update order, including merged and unmerged closed PRs', () => {
    const { gh, exec, api } = fixture();
    withStore(gh.env.FAKE_GH_STORE, store => {
      const state = store.repos[repo];
      for (const merged of [false, true]) {
        for (let index = 0; index < 251; index += 1) {
          const pr = openPrPure(state, { head: 'fixture', body: 'Supersedes #9999', author: 'agent', now });
          // Reverse numeric order: sorting by PR number would give the wrong pages.
          pr.updatedAt = new Date(now - index * 60_000).toISOString();
          if (merged) {
            pr.state = 'MERGED';
            pr.mergedAt = pr.updatedAt;
            pr.closedAt = pr.mergedAt;
          }
        }
      }
      const closed = openPrPure(state, { head: 'fixture', now });
      closed.state = 'CLOSED';
      closed.closedAt = closed.updatedAt;
    });
    const open = defaultReadOpenNumbers({ repo, exec, requireComplete: true });
    // The open list is read newest-created first so activity cannot shift its pages; only membership matters.
    expect([...open].sort((a, b) => a - b)).toEqual(Array.from({ length: 251 }, (_, index) => index + 1));
    const merged = defaultReadMergedPrs({ repo, lookbackDays: 7, now, exec, requireComplete: true });
    expect(merged.map(pr => pr.number)).toEqual(Array.from({ length: 251 }, (_, index) => index + 252));
    expect(merged[0]).toEqual({ number: 252, body: 'Supersedes #9999', state: 'MERGED',
      mergedAt: new Date(now).toISOString(), author: { login: 'agent' } });
    const closed = api('state=closed&sort=updated&direction=desc&per_page=100&page=1');
    expect(closed).toHaveLength(100);
    expect(closed[0]).toMatchObject({ number: 503, state: 'closed', merged_at: null });
    expect(closed[1]).toMatchObject({ number: 252, state: 'closed', merged_at: new Date(now).toISOString() });
    expect(api('state=open&per_page=100&page=4')).toEqual([]);
  });

  it('allows an empty daemon pass, blocks on an API fault, and recovers on the next pass', () => {
    const { gh, exec } = fixture();
    // Exercise the daemon's default readers, including the count proofs; injected legacy
    // readers masked unsupported GraphQL calls and left every real daemon tick blocked.
    const tick = () => runSupersedeWatch({ repo, now, settings: { hold: true, lookbackDays: 7 }, exec });
    expect(tick()).toEqual({ repo, holds: [], applied: [] });
    gh.fault({ verb: 'api', kind: '5xx', times: 1 });
    // The watch reports the failed command's first line, before the child stderr/status.
    expect(tick()).toMatchObject({ blocked: true,
      error: expect.stringContaining('Command failed: gh api graphql') });
    expect(tick()).toEqual({ repo, holds: [], applied: [] });
  });

  it('counts GraphQL states separately and rejects missing or unknown states and queries', () => {
    const { gh, exec } = fixture();
    withStore(gh.env.FAKE_GH_STORE, store => {
      const state = store.repos[repo];
      openPrPure(state, { head: 'fixture', now });
      openPrPure(state, { head: 'fixture', now }).state = 'CLOSED';
      openPrPure(state, { head: 'fixture', now }).state = 'MERGED';
    });
    const query = 'query($o:String!,$n:String!,$s:[PullRequestState!]!){repository(owner:$o,name:$n){pullRequests(states:$s){totalCount}}}';
    const count = (states, text = query) => JSON.parse(exec('gh', ['api', 'graphql',
      '-f', `query=${text}`, '-f', 'o=web-everything', '-f', 'n=web-everything',
      ...states.flatMap(state => ['-f', `s[]=${state}`])], { encoding: 'utf8' }))
      .data.repository.pullRequests.totalCount;
    expect(count(['OPEN'])).toBe(1);
    expect(count(['CLOSED'])).toBe(1);
    expect(count(['MERGED'])).toBe(1);
    expect(count(['CLOSED', 'MERGED'])).toBe(2);
    expect(count(['OPEN', 'OPEN'])).toBe(1);
    expect(() => count([])).toThrow(/unsupported pull request states/);
    expect(() => count(['closed'])).toThrow(/unsupported pull request states/);
    expect(() => count(['UNKNOWN'])).toThrow(/unsupported pull request states/);
    expect(() => count(['OPEN'], query.replace('totalCount', 'nodes{id}'))).toThrow(/unsupported graphql query/);
  });

  it('counts only merged PRs inside the requested window and rejects unsupported searches', () => {
    const { gh, exec } = fixture();
    const since = new Date(now - 86400000).toISOString();
    withStore(gh.env.FAKE_GH_STORE, store => {
      const state = store.repos[repo];
      const old = openPrPure(state, { head: 'fixture', now });
      old.state = 'MERGED';
      old.mergedAt = new Date(now - 2 * 86400000).toISOString();
      const boundary = openPrPure(state, { head: 'fixture', now });
      boundary.state = 'MERGED';
      boundary.mergedAt = since;
      openPrPure(state, { head: 'fixture', now }).state = 'CLOSED';
      openPrPure(state, { head: 'fixture', now });
    });
    const count = search => JSON.parse(exec('gh', ['api', 'graphql', '-f',
      'query=query($q:String!){search(query:$q,type:ISSUE){issueCount}}', '-f', `q=${search}`], { encoding: 'utf8' }));
    expect(count(`repo:${repo} is:pr is:merged merged:>=${since}`).data.search.issueCount).toBe(1);
    expect(() => count(`repo:${repo} is:pr is:merged`)).toThrow(/unsupported merged inventory search/);
  });

  it('models search-index lag: the count drops lagging merges while the REST list keeps them', () => {
    const { gh, exec } = fixture();
    withStore(gh.env.FAKE_GH_STORE, store => {
      const state = store.repos[repo];
      for (let index = 0; index < 3; index += 1) {
        const pr = openPrPure(state, { head: 'fixture', body: '', author: 'agent', now });
        pr.state = 'MERGED';
        pr.mergedAt = new Date(now - index * 60_000).toISOString();
        pr.updatedAt = pr.mergedAt;
      }
      state.searchIndexMissing = [2];
    });
    const since = new Date(now - 86400000).toISOString();
    const indexed = JSON.parse(exec('gh', ['api', 'graphql', '-f',
      'query=query($q:String!){search(query:$q,type:ISSUE){issueCount}}', '-f', `q=repo:${repo} is:pr is:merged merged:>=${since}`],
    { encoding: 'utf8' })).data.search.issueCount;
    expect(indexed).toBe(2);
    // The daemon's default merged reader trusts REST as the inventory and uses search only as a lower bound.
    expect(defaultReadMergedPrs({ repo, lookbackDays: 7, now, exec, requireComplete: true }).map(pr => pr.number))
      .toEqual([1, 2, 3]);
  });

  it.each(['page=0','page=1.5', 'per_page=101', 'state=merged', 'sort=unknown', 'unknown=1'])(
    'rejects unsupported pagination instead of returning an empty success: %s', query => {
      const { api } = fixture();
      expect(() => api(query)).toThrow(/unsupported pulls pagination/);
    });
});
