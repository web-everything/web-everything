import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrestageWorld } from './fixtures/merge-ai-prs-prestage-world.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs');
const world = createPrestageWorld((argv, options) => spawnSync(process.execPath, [script, ...argv], options));

// A direct subprocess smoke also gives the inventory guard a statically provable active call;
// the CLI scenario below supplies its process callback through an external fixture factory.
it('real CLI entry point passes the Node syntax check', () => {
  const result = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8', timeout: 10_000 });
  expect(result.status, result.stderr).toBe(0);
});

it('real CLI prepares pending CI, then consumes the green-event admission', () => world(async ({ pr, run }) => {
  expect((await run()).stderr).toContain('eligible=true');
  pr.statusCheckRollup[0] = { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', head_sha: pr.headRefOid };
  const next = await run(true);
  expect(next.report).toMatchObject({ prestaged: true, enqueueOutcomes: [{ num: 42, outcome: 'enqueued' }] });
  expect(next.calls.filter(a => a.some(x => x.includes('enqueuePullRequest')))).toHaveLength(1);
}, { slug: 'web-everything/web-everything' }), 120_000); // capability gate refuses the fixture default slug
