/**
 * @file scripts/lib/__tests__/poc-branches-repo.test.mjs
 * @description The registry's `repo` field: a sibling-repo POC branch (plateau-app's alpha branch,
 *   `lane/wip-quickview`) can be registered and landed on with `poc-land` from that repo's own lane, while an
 *   entry with no `repo` stays a Web Everything branch exactly as before, and every WE-only consumer (drift
 *   defaults, `deliveryTarget:`, the mechanical sync, the prototype-tracker guard) keeps seeing WE branches only.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeRegistry, findPocBranch, isPocBranch, validatePocBranch, validateDeliveryTarget, branchesForRepo,
  upsertPocBranch, removePocBranch, writeRegistry, DEFAULT_POC_REPO,
} from '../poc-branches.mjs';
import { runPocBranchSync } from '../../conveyor/poc-branch-sync.mjs';
import { protectedBranchNames } from '../../guard-prototype-tracker.mjs';

const WE = { branch: 'lane/daemon-poc', purpose: 'WE daemons', owner: '3383', dateOpened: '2026-09-23', target: 'main', scope: [], autoSync: true };
const ALPHA = { branch: 'lane/wip-quickview', repo: 'plateauapp/plateau-app', purpose: 'the /wip alpha publisher branch', owner: '3383', dateOpened: '2026-10-03', target: 'main', scope: [], autoSync: false };
const reg = normalizeRegistry({ version: 1, branches: [WE, ALPHA] });

describe('poc-branches `repo` field', () => {
  it('an entry with no repo is a Web Everything branch (backward compatible)', () => {
    expect(DEFAULT_POC_REPO).toBe('web-everything/web-everything');
    expect(findPocBranch(reg, 'lane/daemon-poc')?.branch).toBe('lane/daemon-poc');
    expect(findPocBranch(reg, 'lane/daemon-poc', 'web-everything/web-everything')).not.toBeNull();
    expect(findPocBranch(reg, 'origin/lane/daemon-poc', 'chalbert/web-everything')).not.toBeNull(); // legacy slug canonicalized
  });

  it('a sibling-repo entry is found only for its own repo', () => {
    expect(findPocBranch(reg, 'lane/wip-quickview', 'plateauapp/plateau-app')?.repo).toBe('plateauapp/plateau-app');
    expect(findPocBranch(reg, 'lane/wip-quickview')).toBeNull();
    expect(isPocBranch(reg, 'lane/daemon-poc', 'plateauapp/plateau-app')).toBe(false);
  });

  it('WE-only consumers never see the sibling-repo branch', () => {
    expect(branchesForRepo(reg).map((b) => b.branch)).toEqual(['lane/daemon-poc']);
    expect(validateDeliveryTarget(reg, 'lane/wip-quickview').ok).toBe(false);
    expect(protectedBranchNames(reg, '3383')).toEqual(['lane/daemon-poc']);
    const synced = [];
    runPocBranchSync({ registry: reg, env: {}, sync: ({ entry }) => { synced.push(entry.branch); return { branch: entry.branch, status: 'ok' }; } });
    expect(synced).toEqual(['lane/daemon-poc']);
  });

  it('the same branch name may be registered once per repo; duplicates within a repo still drop', () => {
    const r = normalizeRegistry({ branches: [WE, { ...WE, repo: 'plateauapp/plateau-app' }, { ...WE }] });
    expect(r.branches).toHaveLength(2);
    expect(r.dropped).toHaveLength(1);
  });

  it('validates the slug shape and round-trips the file without adding repo to WE entries', () => {
    expect(validatePocBranch({ ...ALPHA, repo: 'not a slug' }).ok).toBe(false);
    let written = '';
    writeRegistry({ registry: reg, path: '/x', write: (_p, s) => { written = s; } });
    const parsed = JSON.parse(written);
    expect(parsed.branches[0]).not.toHaveProperty('repo');
    expect(parsed.branches[1].repo).toBe('plateauapp/plateau-app');
  });

  it('upsert/remove are scoped to the repo', () => {
    const r2 = removePocBranch(reg, 'lane/wip-quickview');
    expect(r2.branches).toHaveLength(2); // WE-scoped removal leaves the plateau entry
    expect(removePocBranch(reg, 'lane/wip-quickview', 'plateauapp/plateau-app').branches).toHaveLength(1);
    expect(upsertPocBranch(reg, { ...ALPHA, purpose: 'renamed' }).branches.filter((b) => b.branch === 'lane/wip-quickview')).toHaveLength(1);
  });
});
