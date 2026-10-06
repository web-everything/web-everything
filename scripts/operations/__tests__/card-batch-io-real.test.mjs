// @vitest-environment node
/**
 * @file scripts/operations/__tests__/card-batch-io-real.test.mjs
 * @description Fidelity qualifier (#2949) for `card-batch-io.mjs`: admission driven against a REAL bare origin and a
 *   NARROW (`--single-branch`) producer clone, the geometry #3264 hid behind injected doubles. The producer clone's
 *   refspec does not cover the batch ref, so admission must read and write the remote by URL, never through a
 *   remote-tracking ref. The stub-free suite in `card-batch-io.test.mjs` keeps pinning decisions; this pins mechanics.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admitCard } from '../card-batch-io.mjs';
import { withNarrowClone } from './helpers/real-repo.mjs';

const REF = 'lane/card-batch-prevention-1';

describe('card batch admission against a real origin and a narrow clone', () => {
  it('admits a card to the origin, then recovers the lost record from the remote batch', async () => {
    await withNarrowClone(async (ctx) => {
      // The geometry under test: the clone's fetch refspec has no wildcard, so the batch ref is never tracked.
      expect(ctx.fetchRefspecs().some((spec) => spec.includes('*'))).toBe(false);

      const stateDir = mkdtempSync(join(tmpdir(), 'card-batch-real-'));
      try {
        const baseSha = ctx.git(['rev-parse', 'HEAD']).trim();
        mkdirSync(join(ctx.clone, 'backlog'), { recursive: true });
        const bytes = Buffer.from('# Card 5192\r\nCafé\r\n');
        writeFileSync(join(ctx.clone, 'backlog/5192-card.md'), bytes);
        const input = {
          cardPath: 'backlog/5192-card.md', cardId: '5192', idemKey: 'key-5192', baseSha, kind: 'prevention',
          source: { repo: 'org/repo', pr: 1, head: baseSha }, laneDir: ctx.clone,
        };
        const options = { stateDir, remote: 'origin', owner: 'real-a', leaseMs: 60_000 };

        const admitted = await admitCard(input, options);
        expect(admitted).toMatchObject({ action: 'admit', batchRef: REF });
        expect(ctx.originBranches()).toContain(REF);
        // Bytes on the origin are the producer's exact bytes, with the card as the batch's only addition.
        expect(Buffer.from(ctx.showOnOrigin(REF, 'backlog/5192-card.md'), 'utf8')).toEqual(bytes);
        expect(ctx.git(['ls-remote', '--refs', 'origin', REF]).trim()).toContain(admitted.member.commitSha);

        // Losing the local record is repaired from the origin's own commit evidence, not duplicated.
        rmSync(join(stateDir, 'org-repo-prevention.json'));
        const again = await admitCard(input, options);
        expect(again.action).toBe('dedupe');
        expect(JSON.parse(readFileSync(join(stateDir, 'org-repo-prevention.json'), 'utf8')).headSha)
          .toBe(admitted.member.commitSha);
        // The dedupe pushed nothing: the origin ref is still the original admission commit.
        expect(ctx.git(['ls-remote', '--refs', 'origin', REF]).trim()).toContain(admitted.member.commitSha);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });
  }, 30_000);
});
