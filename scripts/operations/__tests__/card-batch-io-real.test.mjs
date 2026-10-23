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
import { fileIntoBatch } from '../card-batch-file.mjs';
import { cardOnlyEligibility, raisedBySidecarId } from '../../lib/card-batch-policy.mjs';
import { resolveAlsoRaisedRoute, loadAlsoRaisedRoute } from '../../lib/card-batch-settings.mjs';
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

  it('admits an also-raised sidecar through fileIntoBatch once per idemKey (PR #5818 leak)', async () => {
    await withNarrowClone(async (ctx) => {
      const stateDir = mkdtempSync(join(tmpdir(), 'card-batch-real-sidecar-'));
      try {
        const baseSha = ctx.git(['rev-parse', 'HEAD']).trim();
        const rel = 'backlog/raised-by/5473/5502-f2483ee5bcd4a6160171a2fd.md';
        mkdirSync(join(ctx.clone, 'backlog/raised-by/5473'), { recursive: true });
        writeFileSync(join(ctx.clone, rel), '- Also raised by web-everything/web-everything#5502 (finding 1: `we:x.md:18` — Add the test)\n');
        const preventionSettings = { batchFiling: true, batchWindowMinutes: 60, batchMaxCards: 25, batchLeaseWaitMinutes: 15, sources: {} };
        const settings = { batchFiling: true, batchMaxCards: 25, batchMaxMinutes: 60, sources: {} };
        const file = () => fileIntoBatch({
          laneDir: ctx.clone, cardPath: rel, kind: 'prevention', actor: 'mechanical', idemKey: `prevention-raised-by:${rel}`,
          source: { repo: 'org/repo', pr: 5502, head: baseSha },
        }, { settings, preventionSettings, stateDir, baseSha, launch: () => {}, log: () => {} });
        const first = await file();
        expect(first).toMatchObject({ batched: true, batchRef: REF, deduped: false });
        expect(first.member.cardId).toBe('rb-5473-5502-f2483ee5bcd4a6160171a2fd');
        expect(ctx.showOnOrigin(REF, rel)).toContain('Also raised by');
        const second = await file();
        expect(second).toMatchObject({ batched: true, batchRef: REF, deduped: true });
        expect(ctx.git(['ls-remote', '--refs', 'origin', REF]).trim()).toContain(first.member.commitSha);
        const state = JSON.parse(readFileSync(join(stateDir, 'org-repo-prevention.json'), 'utf8'));
        expect(state.members).toHaveLength(1);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });
  }, 30_000);

  it('eligibility: a canonical sidecar is batch data; a non-canonical raised-by path or other file is not', () => {
    const row = (path) => [{ status: 'A', mode: '100644', path }];
    expect(cardOnlyEligibility(row('backlog/raised-by/5473/5502-f2483ee5bcd4a6160171a2fd.md')).ok).toBe(true);
    expect(cardOnlyEligibility(row('backlog/raised-by/5473/notes.md')).ok).toBe(false);
    expect(cardOnlyEligibility(row('backlog/raised-by/5473/5502-f2483ee5bcd4a6160171a2fd.json')).ok).toBe(false);
    expect(cardOnlyEligibility(row('scripts/x.mjs')).ok).toBe(false);
    expect(cardOnlyEligibility([{ status: 'M', mode: '100644', path: 'backlog/raised-by/5473/5502-f2483ee5bcd4a6160171a2fd.md' }]).ok).toBe(false);
    expect(raisedBySidecarId('backlog/raised-by/x8dyw05/12-aaaaaaaaaaaaaaaaaaaaaaaa.md')).toBe('rb-x8dyw05-12-aaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('settings: prevention.alsoRaised.route cascades standard → platform → repo → env and ignores unknown values', () => {
    expect(resolveAlsoRaisedRoute({})).toEqual({ route: 'batch', source: 'standard', invalid: [] });
    expect(resolveAlsoRaisedRoute({ repo: { alsoRaised: { route: 'single' } } })).toMatchObject({ route: 'single', source: 'repo' });
    expect(resolveAlsoRaisedRoute({ repo: { alsoRaised: { route: 'single' } }, env: { WE_PREVENTION_ALSO_RAISED_ROUTE: 'batch' } }))
      .toMatchObject({ route: 'batch', source: 'env' });
    expect(resolveAlsoRaisedRoute({ platform: { alsoRaised: { route: 'single' } }, repo: { alsoRaised: { route: 'pr' } } }))
      .toEqual({ route: 'single', source: 'platform', invalid: ['repo.alsoRaised.route'] });
    expect(loadAlsoRaisedRoute({ env: {}, read: () => '{}' })).toMatchObject({ route: 'batch', source: 'repo' });
  });
});
