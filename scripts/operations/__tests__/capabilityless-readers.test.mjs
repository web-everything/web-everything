import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOpenPrsForClose } from '../close-items-io.mjs';
import { createItemActivityReader } from '../item-activity-io.mjs';
import { createPrOwnershipReader } from '../pr-ownership-io.mjs';
import { collectDay } from '../delivery-metrics.mjs';
import { CONSTELLATION_REPOS } from '../../lib/constellation-repos.mjs';

const keys = ['we', 'frontierui', 'plateau-app'];
const slugs = keys.map(key => CONSTELLATION_REPOS[key].slug);

it('readOpenPrsForClose never queries longshore', () => {
  const seen = [];
  const result = readOpenPrsForClose({ paging: { pageSize: 20, pageRetries: 0 },
    exec: (_bin, _args, options) => {
      seen.push(options.env.GH_REPO);
      return JSON.stringify({ data: { repository: { pullRequests: {
        totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null },
      } } } });
    },
  });
  expect(seen).toEqual(slugs);
  expect(result).toEqual({ prs: [] });
});

it('createItemActivityReader never lists longshore', () => {
  const seen = [];
  const read = createItemActivityReader({ readSources: () => ({ rows: [] }), listCompletions: () => [],
    listPrs: repo => { seen.push(repo); return []; },
    viewPr: () => { throw new Error('unexpected individual read'); },
  });
  const result = read({ card: '1234' });
  expect(seen).toEqual(keys);
  expect(result.runs).toEqual([]);
  expect(result.gaps).toEqual([]);
});

it('createPrOwnershipReader never reconciles longshore', () => {
  const seen = [];
  const read = createPrOwnershipReader({
    reconcile: ({ repo }) => { seen.push(repo); return { dispatch: [], refusals: [], notes: [] }; },
    readAgents: () => [], enrich: rows => rows, readActivity: () => { throw new Error('fixture'); },
    pathExists: () => false, run: () => { throw new Error('unexpected child'); },
  });
  expect(read().repos.map(row => row.repo)).toEqual(keys);
  expect(seen).toEqual(slugs);
});

it('delivery-metrics collectDay never queries longshore', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capabilityless-metrics-'));
  try {
    const seen = [];
    const result = await collectDay('2026-11-15', {
      env: { WE_COORDINATION_ROOT: dir, WE_FIX_LOOP_LEDGER: join(dir, 'fix.jsonl'), WE_NEEDS_YOU_FEED: join(dir, 'feed.jsonl') },
      settings: { delivery: { metrics: { protocols: [] } } }, readShadow: () => ({ runs: [], corrupt: 0 }),
      coroner: () => ({ sources: { jobs: { found: false }, archive: { found: false } }, sessions: [] }),
      gh: args => {
        const query = decodeURIComponent(args[1]);
        seen.push(/repo:([^ ]+)/.exec(query)?.[1]);
        return { items: [], total_count: 0, incomplete_results: false };
      },
    });
    expect(seen).toEqual(slugs);
    expect(result.prs.rows).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
