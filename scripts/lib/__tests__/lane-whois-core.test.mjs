/**
 * @file scripts/lib/__tests__/lane-whois-core.test.mjs
 * @description Proof of #3383's verdict rule (`classifyLaneVerdict`) and card-id guessing
 * (`guessCardIds`) — the PURE decision core `lane-whois.mjs` shells out to. No fs/git/gh anywhere here.
 */
import { describe, it, expect } from 'vitest';
import { guessCardIds, classifyLaneVerdict, holderPresumedAlive } from '../lane-whois-core.mjs';

describe('guessCardIds', () => {
  it('reads a numeric card id from a backlog/ path', () => {
    expect(guessCardIds({ paths: ['backlog/3901-graduate-coordination.md'] })).toEqual(['3901']);
  });

  it('reads a hash-style card id from a backlog/ path', () => {
    expect(guessCardIds({ paths: ['backlog/x9xqexm-durable-clearance.md'] })).toEqual(['x9xqexm']);
  });

  it('reads a card id out of a commit subject and a branch name, deduped', () => {
    const ids = guessCardIds({ commitSubject: 'resolve #3901 on land', branch: 'lane/3901-graduate' });
    expect(ids).toEqual(['3901']);
  });

  it('returns [] with no evidence at all', () => {
    expect(guessCardIds({})).toEqual([]);
  });
});

describe('classifyLaneVerdict', () => {
  it('is in-use whenever the holder is alive, regardless of everything else', () => {
    expect(classifyLaneVerdict({ holderAlive: true, uncommittedCount: 40, preserved: false }).verdict).toBe('in-use');
  });

  it('is finished-reclaimable with a dead holder and nothing uncommitted/ahead', () => {
    const r = classifyLaneVerdict({ holderAlive: false, uncommittedCount: 0, aheadCount: 0 });
    expect(r.verdict).toBe('finished-reclaimable');
  });

  it('is finished-reclaimable when the card resolved AND every change is preserved', () => {
    const r = classifyLaneVerdict({
      holderAlive: false, uncommittedCount: 3, cardStatuses: ['resolved'], preserved: true,
    });
    expect(r.verdict).toBe('finished-reclaimable');
  });

  it('is finished-reclaimable when the PR merged AND every change is preserved (no card found)', () => {
    const r = classifyLaneVerdict({
      holderAlive: false, aheadCount: 2, prStates: ['MERGED'], preserved: true,
    });
    expect(r.verdict).toBe('finished-reclaimable');
  });

  it('is finished-needs-review when done but NOT provably preserved — never auto-reclaim', () => {
    const r = classifyLaneVerdict({
      holderAlive: false, uncommittedCount: 2, cardStatuses: ['resolved'], preserved: false,
    });
    expect(r.verdict).toBe('finished-needs-review');
  });

  it('is unknown-work when the card/PR is still open and there is real content', () => {
    const r = classifyLaneVerdict({
      holderAlive: false, uncommittedCount: 5, cardStatuses: ['open'], preserved: false,
    });
    expect(r.verdict).toBe('unknown-work');
  });

  it('is unknown-work when there is content but NO card/PR evidence at all', () => {
    const r = classifyLaneVerdict({ holderAlive: false, aheadCount: 1, preserved: false });
    expect(r.verdict).toBe('unknown-work');
  });

  it('a mix of resolved and open cards is NOT a done signal (every() must hold)', () => {
    const r = classifyLaneVerdict({
      holderAlive: false, uncommittedCount: 1, cardStatuses: ['resolved', 'open'], preserved: false,
    });
    expect(r.verdict).toBe('unknown-work');
  });
});

describe('holderPresumedAlive', () => {
  it('delegates straight to the injected isLeaseStale', () => {
    const staleFn = () => false;
    expect(holderPresumedAlive({ x: 1 }, staleFn, 0, 0)).toBe(true);
    expect(holderPresumedAlive(null, staleFn, 0, 0)).toBe(false);
  });
});
