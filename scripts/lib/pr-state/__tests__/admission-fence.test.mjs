// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { admitClearHuman } from '../admit-clear-human.mjs';
import { readSnapshot, labelsDigest, commentVersion } from '../snapshot.mjs';

const HEAD = 'a'.repeat(40);
const NOW = Date.parse('2026-10-28T12:00:00Z');
const BUDGET = 5_000;

function fixture() {
  return {
    snapshot: {
      head: HEAD, labels: ['review:human'], labelsVersion: '2026-10-28T11:59:00Z',
      comments: [{ id: 'C1', author: 'operator', body: 'Evidence',
        createdAt: '2026-10-28T11:00:00Z', lastEditedAt: null }],
      reviews: [], openReferrals: [], redTeam: { resultId: null, rulingNeeded: false },
      standingRulings: [], holdEventIds: ['hold:1'], humanOnlyHold: false,
      netDiff: { headSha: HEAD, files: ['docs/example.md'], diffLines: 12 }, now: NOW,
    },
    options: {
      delegation: { pinnedHead: HEAD, expiresAt: NOW + BUDGET + 1 },
      config: { ineligibleLabels: ['do-not-merge'], commitBudgetMs: BUDGET,
        decideSetLabel: () => ({ allowed: true }), scoreDiff: () => ({ escalate: false }) },
    },
  };
}

describe('clearing authority evidence fence', () => {
  it('carries ghost authors and a null review commit through snapshot admission', async () => {
    const { snapshot: evidence, options } = fixture();
    const connection = nodes => ({ nodes, pageInfo: { hasNextPage: false } });
    const snapshot = await readSnapshot({
      repo: 'example/project', pr: 42, expectedHead: HEAD, now: NOW,
      io: {
        graphql: () => ({ repository: { pullRequest: {
          headRefOid: HEAD, updatedAt: evidence.labelsVersion,
          labels: connection(evidence.labels.map(name => ({ name }))),
          comments: connection(evidence.comments.map(c => ({ ...c, author: null }))),
          reviews: connection([{ id: 'R1', author: null, state: 'APPROVED', commit: null }]),
        } } }),
        netDiffAtHead: () => evidence.netDiff,
        openReferrals: ({ comments }) => {
          expect(comments[0].author).toBeNull();
          return evidence.openReferrals;
        },
        redTeam: () => evidence.redTeam,
        standingRulings: () => evidence.standingRulings,
        holdEventIds: () => evidence.holdEventIds,
        humanOnlyHold: () => evidence.humanOnlyHold,
      },
    });
    expect(snapshot.reviews[0]).toEqual({ id: 'R1', author: null, state: 'APPROVED', commit: null });
    expect(admitClearHuman(snapshot, options)).toEqual({
      admit: true, reasons: [], basis: ['hold:1'],
      fence: { headSha: HEAD, labelsDigest: labelsDigest(snapshot.labels),
        commentVersion: commentVersion(snapshot.comments) },
    });
  });

  it('readSnapshot deeply freezes authorization evidence', async () => {
    const { snapshot: evidence, options } = fixture();
    const connection = nodes => ({ nodes, pageInfo: { hasNextPage: false } });
    const snapshot = await readSnapshot({
      repo: 'example/project', pr: 42, expectedHead: HEAD, now: NOW,
      io: {
        graphql: () => ({ repository: { pullRequest: {
          headRefOid: HEAD, updatedAt: evidence.labelsVersion,
          labels: connection(evidence.labels.map(name => ({ name }))),
          comments: connection(evidence.comments.map(c => ({ ...c, author: { login: c.author } }))),
          reviews: connection([{ id: 'R1', author: { login: 'reviewer' },
            state: 'APPROVED', commit: { oid: HEAD } }]),
        } } }),
        netDiffAtHead: () => evidence.netDiff,
        openReferrals: () => evidence.openReferrals,
        redTeam: () => evidence.redTeam,
        standingRulings: () => evidence.standingRulings,
        holdEventIds: () => evidence.holdEventIds,
        humanOnlyHold: () => evidence.humanOnlyHold,
      },
    });
    const before = structuredClone(snapshot);
    const authority = admitClearHuman(snapshot, options);
    const assertFrozen = value => {
      if (value !== null && typeof value === 'object') {
        expect(Object.isFrozen(value)).toBe(true);
        for (const child of Object.values(value)) assertFrozen(child);
      }
    };
    assertFrozen(snapshot);
    const mutations = [
      () => { snapshot.head = 'b'.repeat(40); },
      () => { snapshot.labels.push('do-not-merge'); },
      () => { snapshot.comments[0].body = 'Replaced evidence'; },
      () => { snapshot.reviews[0].author.login = 'impostor'; },
      () => { snapshot.reviews[0].commit.oid = 'b'.repeat(40); },
      () => { snapshot.openReferrals.push('finding:1'); },
      () => { snapshot.redTeam.rulingNeeded = true; },
      () => { snapshot.standingRulings.push('ruling:forged'); },
      () => { snapshot.holdEventIds.pop(); },
      () => { snapshot.netDiff.files.push('scripts/sensitive.mjs'); },
      () => { snapshot.netDiff.diffLines = 0; },
    ];
    for (const mutate of mutations) {
      expect(mutate).toThrow(TypeError);
      expect(snapshot).toEqual(before);
      expect(admitClearHuman(snapshot, options)).toEqual(authority);
    }
  });

  it('throws for a mismatched diff head even when policy and score permit clearing', () => {
    const { snapshot, options } = fixture();
    snapshot.netDiff.headSha = 'b'.repeat(40);
    expect(() => admitClearHuman(snapshot, options)).toThrow(/netDiff head mismatch/);
  });

  it.each([
    ['head-moved', f => {
      f.snapshot.head = 'b'.repeat(40);
      f.snapshot.netDiff.headSha = f.snapshot.head;
    }],
    ['ineligible-label:do-not-merge', f => { f.snapshot.labels.push('do-not-merge'); }],
    ['open-referral:finding:1', f => { f.snapshot.openReferrals.push('finding:1'); }],
    ['red-team-ruling-needed', f => { f.snapshot.redTeam = { resultId: 'RT1', rulingNeeded: true }; }],
    ['decide-refused', f => { f.options.config.decideSetLabel = () => ({ allowed: false }); }],
    ['diff-escalates', f => { f.options.config.scoreDiff = () => ({ escalate: true }); }],
    ['delegation-expired', f => { f.options.delegation.expiresAt = NOW + BUDGET; }],
  ])('refuses %s and returns the fence of the observed evidence', (reason, change) => {
    const f = fixture();
    change(f);
    const before = structuredClone(f.snapshot);
    const result = admitClearHuman(f.snapshot, f.options);
    expect(result).toEqual({
      admit: false, reasons: [reason], basis: ['hold:1'],
      fence: { headSha: f.snapshot.head, labelsDigest: labelsDigest(f.snapshot.labels),
        commentVersion: commentVersion(f.snapshot.comments) },
    });
    expect(f.snapshot).toEqual(before);
  });
});
