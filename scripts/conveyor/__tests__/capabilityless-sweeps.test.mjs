import { describe, expect, it } from 'vitest';
import { loadProtectedNums } from '../queue.mjs';
import { REVERIFY_SWEEP_REPOS } from '../load-flake-reverify.mjs';
import { runDraftPromotionStep } from '../draft-promotion-loop.mjs';
import { runSupersedeSweep } from '../supersede-watch.mjs';
import { runOrphanFixRoundPass } from '../orphan-fix-round.mjs';
import { gatherSnapshot } from '../liveness-sweep.mjs';
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
  // PR #6911 operator send-back: the liveness sweep queried longshore and reported false stalls.
  const livenessDeps = (seenShared, seenGh, repos) => ({
    homedir: () => '/tmp/home', env: {}, ...(repos ? { repos } : {}),
    readSharedOpenPrs: ({ repo }) => { seenShared.push(repo); return null; },
    execFileSync: (cmd, args) => {
      if (cmd === 'gh') { seenGh.push(args[args.indexOf('--repo') + 1]); return '[]'; }
      throw new Error(`unexpected ${cmd}`);
    },
    cachedClaudeAgents: () => '[]', daemonCloneRoots: () => [], readTail: () => '',
    readFile: () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; }, writeMovementStore: () => {},
  });
  it('liveness-sweep never issues a GitHub read for longshore (default registry)', async () => {
    const seenShared = [], seenGh = [];
    const out = await gatherSnapshot({ now: '2026-11-17T20:00:00Z', ledger: '/tmp/l', noMovementStore: true },
      livenessDeps(seenShared, seenGh));
    expect(seenShared).toEqual(slugs);
    expect(seenGh).toEqual(slugs);
    expect(out.errors.filter(e => String(e.source).includes(CONSTELLATION_REPOS.longshore.slug))).toEqual([]);
  });
  it('liveness-sweep applies the capability filter to an injected registry too', async () => {
    const seenShared = [], seenGh = [];
    await gatherSnapshot({ now: '2026-11-17T20:00:00Z', ledger: '/tmp/l', noMovementStore: true }, livenessDeps(seenShared, seenGh, {
      we: { slug: 'org/capable', capabilities: { review: true } },
      cards: { slug: 'org/cards-only', capabilities: { review: false, fix: false, ciHeal: false, build: 'off' } },
    }));
    expect(seenShared).toEqual(['org/capable']);
    expect(seenGh).toEqual(['org/capable']);
  });
  it('ledger-backfill-rulings excludes longshore', async () => {
    const seen = [];
    await backfill({ resolveBoard: repo => { seen.push(repo); return null; } });
    expect(seen).toEqual(slugs);
  });
});
