import { describe, expect, it } from 'vitest';
import { loadProtectedNums } from '../queue.mjs';
import { REVERIFY_SWEEP_REPOS } from '../load-flake-reverify.mjs';
import { runDraftPromotionStep } from '../draft-promotion-loop.mjs';
import { runSupersedeSweep } from '../supersede-watch.mjs';
import { runOrphanFixRoundPass } from '../orphan-fix-round.mjs';
import { countOpenPrsAllRepos } from '../../lib/pr-limit.mjs';
import { main as backfill } from '../../operations/ledger-backfill-rulings.mjs';
import { CONSTELLATION_REPOS } from '../../lib/constellation-repos.mjs';

const keys = ['we', 'frontierui', 'plateau-app'];
const slugs = keys.map(key => CONSTELLATION_REPOS[key].slug);

describe('default maintenance sweeps exclude capability-less longshore', () => {
  it('queue loadProtectedNums reads only capable repos and preserves protections', async () => {
    const seen = [];
    const protectedNums = await loadProtectedNums({
      env: {}, fetchPrs: ({ repo }) => { seen.push(repo); return [{ title: '#1234', headRefName: 'lane/1234-test' }]; },
      readClaims: () => [{ num: '2345' }], readFixClaims: () => [{ num: '3456' }], readRuns: async () => [{ num: '4567' }],
    });
    expect(seen).toEqual(slugs);
    expect(protectedNums.has('1234')).toBe(true);
    expect([...protectedNums].sort()).toEqual(['1234', '2345', '3456', '4567']);
  });
  it('queue refuses pruning when a capable repo cannot be read', async () => {
    await expect(loadProtectedNums({ env: {}, fetchPrs: () => { throw new Error('unavailable'); } })).rejects.toThrow('unavailable');
  });
  it('REVERIFY_SWEEP_REPOS excludes longshore', () => {
    expect(REVERIFY_SWEEP_REPOS).toEqual(keys);
  });
  it('countOpenPrsAllRepos excludes longshore without hiding capable-repo failures', () => {
    const seen = [];
    const rows = countOpenPrsAllRepos({ env: {}, scope: { excludeCardOnly: false }, localOnly: true,
      readShared: ({ repo }) => { seen.push(repo); return null; },
    });
    expect(rows.map(row => row.repoKey)).toEqual(keys);
    expect(seen).toEqual(slugs);
    expect(rows.every(row => row.unavailable)).toBe(true);
  });
  it('draft-promotion-loop excludes longshore', () => {
    const seen = [];
    runDraftPromotionStep({ listDrafts: ({ repoSlug }) => { seen.push(repoSlug); return []; } });
    expect(seen).toEqual(slugs);
  });
  it('supersede-watch excludes longshore', () => {
    const seen = [];
    const out = runSupersedeSweep({ settings: { hold: true }, apply: false,
      readOpenNumbers: ({ repo }) => { seen.push(repo); return []; }, readMergedPrs: () => [],
    });
    expect(seen).toEqual(slugs);
    expect(out.repos.map(row => row.repo)).toEqual(slugs);
  });
  it('orphan-fix-round excludes longshore', async () => {
    const seen = [];
    await runOrphanFixRoundPass({ env: {}, listBounced: slug => { seen.push(slug); return []; } });
    expect(seen).toEqual(slugs);
  });
  it('ledger-backfill-rulings excludes longshore', async () => {
    const seen = [];
    await backfill({ resolveBoard: repo => { seen.push(repo); return null; } });
    expect(seen).toEqual(slugs);
  });
});
