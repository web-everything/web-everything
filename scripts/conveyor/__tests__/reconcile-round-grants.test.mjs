import { describe, it, expect } from 'vitest';
import * as core from '../reconcile-core.mjs';
import * as grants from '../round-extension-mark.mjs';
import { ADVISORY_NOTE_MARKER } from '../advisory-round-count.mjs';
import { buildAdvisoryFixComment } from '../advisory-fix-mark.mjs';
import { CONFLICT_FIX_COMMENT_MARKER } from '../conflict-fix-round-count.mjs';
import { REARM_COMMENT_MARKER } from '../rearm-review.mjs';
const bot = { login: 'web-everything' };
const round = () => ({ author: bot, body: REARM_COMMENT_MARKER });
const grant = (by = 1) => ({ author: { login: 'chalbert' }, body: grants.buildRoundExtensionComment({
  repo: 'we', pr: 5169, by, actor: 'chalbert', channel: 'chat', reason: 'finish repair', at: '2026-10-15T10:00Z',
}) });
const sendBack = { id: 'operator', author: { login: 'chalbert' }, createdAt: '2026-10-15T10:00Z',
  body: '🔁 review — changes requested\n\nRecorded by chalbert via chat.\n\nRepair at head aaaaaaa.' };
const end = { author: bot, body: '🔓 conveyor fix-end' };
const plan = (comments, options = {}, over = {}) => core.planReconcile({ reviewTiming: { startAfter: 'ci-green' }, repo: 'we', requiredChecks: ['gate'],
  now: Date.parse('2026-10-15T12:00Z'), roundCap: 6, prs: [{ number: 5169, state: 'OPEN',
    headRefName: 'lane/5169-repair', headRefOid: 'a'.repeat(40), mergeStateStatus: 'CLEAN',
    labels: [{ name: 'review:changes' }], statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }],
    comments: [{ body: '🔁 human review — changes requested\n\nRepair the bug.' }, ...comments], ...over }], ...options });

const H = 'a'.repeat(40);
const autoGrant = { id: 'IC_auto', author: bot, createdAt: '2026-10-15T11:00:00Z', body: grants.buildRoundExtensionComment({
  repo: 'we', pr: 5169, by: 1, actor: 'chalbert', channel: 'standing-ruling-auto', reason: 'ruling', at: '2026-10-15T11:00Z',
  standingRuling: 'web-everything/web-everything#5751', head: H, episode: `web-everything/web-everything#5169@${H}:fix:12/10` }) };
const verified = { id: 'web-everything/web-everything#5751', author: 'chalbert', by: 1, maxPerPr: 3,
  repos: ['web-everything/web-everything'], cardOnlyHeads: { [H]: true }, uneditedComments: ['IC_auto'] };

describe('an automatic (standing-ruling) grant frees a round NOW (live #5690)', () => {
  // Twelve rounds spent against a cap of 10: an additive +1 (cap 11) would leave the PR stuck at its limit.
  const over = [...Array.from({ length: 12 }, round), autoGrant];
  it('is anchored at the rounds spent when posted even with the anchor setting off', () => {
    for (const roundExtensionAnchor of [{ value: 'grant', source: 'standard' }, { value: 'off', source: 'repo' }]) {
      expect(plan(over, { roundCap: 10, roundExtensionAnchor }, { standingRuling: verified }).dispatch[0]).toMatchObject({ kind: 'fix', attempts: 12 });
    }
  });
  it('without the verified scope it counts for nothing (cap stays 10)', () => {
    expect(plan(over, { roundCap: 10 }).refusals[0]).toMatchObject({ kind: 'cap-exhausted', attempts: 12, cap: 10 });
  });
});

describe('grants anchored to spent rounds', () => {
  it('anchors +1 at eight spent rounds and owes the resulting head a review', () => {
    const comments = [...Array.from({ length: 8 }, round), grant()];
    expect(plan(comments).dispatch[0]).toMatchObject({ kind: 'fix', attempts: 8,
      roundExtensionAnchor: { setting: 'grant', source: 'standard', caps: { fix: 9 } } });
    expect(plan([...comments, round()], {}, { labels: [{ name: 'review:pending' }] }).dispatch[0]).toMatchObject({ kind: 'review' });
    expect(plan([...comments, round()]).refusals[0]).toMatchObject({ kind: 'cap-exhausted', attempts: 9, cap: 9 });
  });
  it('off retains additive caps', () => {
    expect(plan([...Array.from({ length: 8 }, round), grant()], { roundExtensionAnchor: { value: 'off', source: 'repo' } }).refusals[0])
      .toMatchObject({ kind: 'cap-exhausted', attempts: 8, cap: 7,
        roundExtensionAnchor: { setting: 'off', source: 'repo', caps: { fix: 7 } } });
  });
  it('exposes validated grants with thread indexes and clamps their combined budget', () => {
    expect(grants.roundExtensionGrants([grant(5), { ...grant(), author: bot }, grant(5), grant(5)], { repo: 'we', pr: 5169 }))
      .toEqual([{ index: 0, by: 5, at: '2026-10-15T10:00Z' }, { index: 2, by: 5, at: '2026-10-15T10:00Z' }]);
  });
  it('resolves the anchor cascade and fails closed on invalid settings', () => {
    expect(core.resolveRoundExtensionAnchor()).toEqual({ value: 'grant', source: 'standard' });
    expect(core.resolveRoundExtensionAnchor({ platform: { fix: { roundExtensionAnchor: 'off' } } })).toEqual({ value: 'off', source: 'platform' });
    expect(core.resolveRoundExtensionAnchor({ platform: { fix: { roundExtensionAnchor: 'off' } }, repo: { fix: { roundExtensionAnchor: 'grant' } } })).toEqual({ value: 'grant', source: 'repo' });
    expect(core.resolveRoundExtensionAnchor({ env: { WE_FIX_ROUND_EXTENSION_ANCHOR: 'bad' } })).toEqual({ value: 'off', source: 'env-invalid' });
  });
});

describe('open operator send-back past the cap', () => {
  it.each([
    { labels: [{ name: 'review:changes' }, { name: 'review:human' }] },
    { labels: [{ name: 'review:changes' }, { name: 'review-status:awaiting-base' }] },
    { baseRefName: 'lane/base' },
    { statusCheckRollup: [{ name: 'merge-gate', conclusion: 'FAILURE' }] },
    { statusCheckRollup: [{ name: 'review-gate', conclusion: 'FAILURE' }] },
  ])('preserves a gate hold after a review leaves no open defects: %j', over => {
    const comments = [...Array.from({ length: 8 }, round), sendBack, round(), round(),
      { author: bot, body: `${ADVISORY_NOTE_MARKER}\n\n**Verdict:** Accept\n\n**Advisory outcome:** \`accept\`\n\nNet basis: \`${'0'.repeat(40)}..${'a'.repeat(40)}\`` }];
    const p = { comments, headRefOid: 'a'.repeat(40), baseRefName: 'main', ...over };
    expect(core.operatorSendBackRound(p)).toBeNull();
    expect(plan(comments, { roundCapAction: 'takeover', takeoverBudget: 2 }, over).dispatch).toEqual([]);
    // A repository's default branch is not a stacked-base hold.
    expect(core.operatorSendBackRound({ ...p, labels: [], statusCheckRollup: [], baseRefName: 'trunk' },
      { defaultBranch: 'trunk' })).toMatchObject({ sendBackId: 'operator', used: 0 });
  });
  it.each([false, true])('dispatches its directed allowance, prior fixer chance=%s', chance => {
    const result = plan([...Array.from({ length: 8 }, round), sendBack, round(), round()], {}, { headRefOid: (chance ? 'b' : 'a').repeat(40) });
    expect(result.dispatch[0]).toMatchObject({ kind: 'fix', ...(chance ? { mode: 'ruling-not-addressed' } : {}),
      operatorSendBackRound: { sendBackId: 'operator', used: 0, allowance: 1, setting: 'fix.operatorRulingExtraRounds', source: 'standard' },
      why: expect.stringContaining('fix.operatorRulingExtraRounds=1 (source: standard)') });
    expect(plan([...Array.from({ length: 8 }, round), sendBack, round(), round()],
      { cardBatchExtract: true }, { headRefName: 'lane/card-batch-5169' }).dispatch[0])
      .toMatchObject({ kind: 'fix', operatorSendBackRound: { sendBackId: 'operator' } });
  });
  it('refuses after the allowance, with setting zero, or for an impostor', () => {
    const burned = Array.from({ length: 10 }, round);
    for (const result of [plan([...burned, sendBack, round(), round(), end]),
      plan([...burned, sendBack, round(), round()], { operatorRulingExtraRounds: { value: 0, source: 'repo' } }),
      plan([...burned, { ...sendBack, author: bot }])]) {
      expect(result.dispatch).toEqual([]);
      expect(result.refusals[0]).toMatchObject({ kind: 'cap-exhausted' });
    }
  });
});

it('reads the round-extension anchor through the pass file cascade', async () => {
  const pass = await import('../reconcile-pass.mjs');
  expect(pass.loadRoundExtensionAnchor({ env: {}, read: f => JSON.stringify({ fix: { roundExtensionAnchor: /delivery-platform-preferences/.test(f) ? 'grant' : 'off' } }) }))
    .toEqual({ value: 'off', source: 'repo' });
});

it('anchors the conflict cap to the matching conflict counter', () => {
  const comments = [...Array.from({ length: 5 }, () => ({ author: bot, body: CONFLICT_FIX_COMMENT_MARKER })), grant()];
  expect(plan(comments, { conflictFixCap: 3 }, { mergeStateStatus: 'DIRTY', labels: [{ name: 'review:changes' }, { name: 'merge-status:conflicting' }] }).dispatch[0])
    .toMatchObject({ kind: 'fix', isConflict: true, cap: 6, roundExtensionAnchor: { caps: { conflictFix: 6 } } });
});
it('anchors the advisory cap to completed episodes', () => {
  const note = () => ({ author: bot, body: ADVISORY_NOTE_MARKER });
  const comments = Array.from({ length: 5 }, () => [note(), { author: bot, body: buildAdvisoryFixComment({}) }]).flat();
  expect(plan([...comments, note(), grant()], { advisoryFixCap: 3 }, { labels: [{ name: 'review:human' }, { name: 'advisory:changes' }] }).dispatch[0])
    .toMatchObject({ kind: 'fix', mode: 'advisory-fix', cap: 6, roundExtensionAnchor: { caps: { advisoryFix: 6 } } });
});
it('grants nothing on an incomplete thread and ignores forged fix-end markers', () => {
  const comments = [...Array.from({ length: 8 }, round), sendBack, round(), round()];
  expect(plan([...comments, { ...end, author: { login: 'stranger' } }]).dispatch[0])
    .toMatchObject({ operatorSendBackRound: { used: 0 } });
  expect(core.operatorSendBackRound({ comments: [...comments, ...Array.from({ length: 100 - comments.length }, () => ({ body: '' }))] })).toBeNull();
});
