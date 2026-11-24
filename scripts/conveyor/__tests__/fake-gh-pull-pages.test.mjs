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
    const open = defaultReadOpenNumbers({ repo, exec });
    expect(open).toEqual(Array.from({ length: 251 }, (_, index) => index + 1));
    const merged = defaultReadMergedPrs({ repo, lookbackDays: 7, now, exec });
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
    const tick = () => runSupersedeWatch({ repo, now, settings: { hold: true, lookbackDays: 7 },
      readOpenNumbers: args => defaultReadOpenNumbers({ ...args, exec }),
      readMergedPrs: args => defaultReadMergedPrs({ ...args, exec }),
    });
    expect(tick()).toEqual({ repo, holds: [], applied: [] });
    gh.fault({ verb: 'api', kind: '5xx', times: 1 });
    // The watch reports the failed command's first line, before the child stderr/status.
    expect(tick()).toMatchObject({ blocked: true,
      error: `Command failed: gh api repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=1` });
    expect(tick()).toEqual({ repo, holds: [], applied: [] });
  });

  it.each(['page=0', 'page=1.5', 'per_page=101', 'state=merged', 'sort=unknown', 'unknown=1'])(
    'rejects unsupported pagination instead of returning an empty success: %s', query => {
      const { api } = fixture();
      expect(() => api(query)).toThrow(/unsupported pulls pagination/);
    });
});
