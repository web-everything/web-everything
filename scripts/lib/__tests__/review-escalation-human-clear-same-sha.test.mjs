import { describe, it, expect, vi } from 'vitest';
import { parseLatestHumanClearedSha, isAcceptRecordBody, isSanctionedAcceptRecordBody } from '../review-escalation.mjs';

// Live #5193 (2026-10-13): the operator cleared 9c7202417 (clear-human); a false no-push re-arm then triggered an AI
// re-review whose plain accept named the SAME sha, so merge-gate read "no human clearance" for the cleared tree.
const X = '9c72024172156f0f8b1b1c0c3f94b44d1031bdd3';
const Y = 'a'.repeat(40);
const CLEAR_HEADING = '✅ review — `review:human` cleared via the sanctioned path';
const clearBlock = sha => `${CLEAR_HEADING}\n<!-- reviewed-sha: ${sha} -->\n<!-- cleared-human: chalbert -->`;
const clear = sha => ({ author: { login: 'chalbert' }, body: clearBlock(sha) });
const accept = sha => ({ author: { login: 'web-everything' }, body: `✅ review — accepted\n<!-- reviewed-sha: ${sha} -->` });

describe('parseLatestHumanClearedSha — same-sha carry (reviewClearance.humanClearanceSurvivesSameShaAccept)', () => {
  it('a later plain accept of the cleared sha, with nothing revoking in between, keeps the human clearance', () => {
    expect(parseLatestHumanClearedSha([clear(X), accept(X)], { sameShaCarries: true })).toBe(X);
  });
  it('#5193 live history: a re-arm between the clearance and the same-sha accept ends the carry (PR #5237 round 4)', () => {
    // Decision: a re-arm is a revocation for this parser (fail closed). The live #5193 case is handled upstream instead:
    // the re-arm guard refuses a no-push re-arm, and restoration puts back the original clearance record's label.
    const rearm = { author: { login: 'web-everything[bot]' }, body: '🔧 conveyor fix — re-armed for re-review' };
    expect(parseLatestHumanClearedSha([clear(X), rearm, accept(X)], { sameShaCarries: true })).toBeNull();
    expect(parseLatestHumanClearedSha([clear(X), rearm], { sameShaCarries: true })).toBe(X);
  });
  it('setting off restores latest-record-only', () => {
    expect(parseLatestHumanClearedSha([clear(X), accept(X)], { sameShaCarries: false })).toBeNull();
  });
  it('never carries across a record for a different tree (#xuboo0q)', () => {
    expect(parseLatestHumanClearedSha([clear(X), accept(Y)], { sameShaCarries: true })).toBeNull();
    expect(parseLatestHumanClearedSha([clear(X), accept(Y), accept(X)], { sameShaCarries: true })).toBeNull();
  });
  // PR #5237 round 4 (block): a revocation that carries no reviewed-sha marker ends the same-sha run, so a later
  // plain accept of the same sha cannot revive the revoked clearance.
  const say = (body, login = 'web-everything[bot]') => ({ author: { login }, body });
  it.each([
    ['changes verdict', say('🔁 review — changes requested\n\n1. fix it')],
    ['human changes verdict', say('🔁 human review — changes requested', 'chalbert')],
    ['re-arm', say('🔧 conveyor fix — re-armed for re-review')],
    ['stand-down', say('🛑 conveyor fix — stood down (needs-judgment)')],
    ['drain park', say('<!-- drain-park-reason -->\n⏸ **Parked for review by the drain**\nengine-tier path changed')],
    ['CI-heal escalation', say('🚦 conveyor CI-heal — escalated')],
    ['review paused', say('review paused: operator hold')],
    ['clearance revoked by re-score', say('**Your `review:human` clearance was revoked by an automated re-score.** …')],
    ['operator free text', say('Hold this one, I need to look again.', 'chalbert')],
    ['re-stamp heading, then a revocation', say('📌 review — acceptance re-stamped after a rebase (no new review)\n\nREVOKED', 'chalbert')],
  ])('does not carry clearance across a marker-free revocation: %s', (_kind, revocation) => {
    expect(parseLatestHumanClearedSha([clear(X), revocation, accept(X)], { sameShaCarries: true })).toBeNull();
  });
  it('a changes verdict that itself quotes the reviewed sha also ends the run', () => {
    const verdict = say(`🔁 review — changes requested\n<!-- reviewed-sha: ${X} -->`, 'web-everything');
    expect(parseLatestHumanClearedSha([clear(X), verdict, accept(X)], { sameShaCarries: true })).toBeNull();
  });
  // PR #5237 round 5 (red team): a revocation that QUOTES the reviewed-sha marker is a marker-bearing record, so it
  // skipped the marker-free revocation check. Only a recognised acceptance (or a machine note) continues the run now.
  const quote = `<!-- reviewed-sha: ${X} -->`;
  it.each([
    ['fenced quote', `Hold this PR; I revoke my approval.\n\n\`\`\`\n${quote}\n\`\`\``],
    ['blockquote', `Hold this PR; I revoke my approval.\n> ${quote}`],
    ['whole-line quote', `Hold this PR; I revoke my approval.\n${quote}`],
    ['inline quote', `I revoke my approval of ${quote} — hold.`],
    ['lookalike accept heading', `✅ review — accepted?? No: I revoke it.\n${quote}`],
  ])('does not carry clearance across a revocation that quotes the marker: %s', (_kind, body) => {
    const revocation = say(body, 'chalbert');
    expect(parseLatestHumanClearedSha([clear(X), revocation, accept(X)], { sameShaCarries: true })).toBeNull();
    expect(parseLatestHumanClearedSha([clear(X), accept(X), revocation, accept(X)], { sameShaCarries: true })).toBeNull();
    expect(parseLatestHumanClearedSha([clear(X), revocation, accept(X)], { sameShaCarries: false })).toBeNull();
  });
  it('recognises every acceptance its producers render, and nothing else they render', async () => {
    const { buildVerdictComment } = await import('../../review-set-label.mjs');
    const { buildCarryRecordBody } = await import('../human-clearance-carry.mjs');
    const verdict = to => buildVerdictComment({ to, actor: 'chalbert', headSha: X, reason: 'looked at it',
      humanClearance: to === 'restamp' ? { actor: 'chalbert', sha: X } : null });
    const plainRestamp = buildVerdictComment({ to: 'restamp', actor: 'drain', headSha: X });
    const carry = buildCarryRecordBody({ fromSha: Y, toSha: X, fingerprint: 'd'.repeat(64), actor: 'chalbert', headDiffText: 'diff' });
    for (const body of [...['accepted', 'clear-human', 'restamp'].map(verdict), plainRestamp, carry]) {
      expect(isAcceptRecordBody(body), body).toBe(true);
      expect(isSanctionedAcceptRecordBody(body), body).toBe(true);
    }
    expect(isSanctionedAcceptRecordBody(verdict('changes'))).toBe(false);
    // Renamed 2026-10-11; records under the old heading are still on open PRs.
    expect(isAcceptRecordBody('📌 review — human clearance carried forward (identical net diff after a mechanical refresh, no new review)\n')).toBe(true);
    expect(isAcceptRecordBody(verdict('changes'))).toBe(false);
  });
  // PR #5237 operator send-back (2026-10-14): quoting a WHOLE revoked clearance block (both markers) revived the human
  // approval: the quote read as a fresh clearance and restarted the run. A revoked clearance stays revoked until a NEW
  // clear-human ceremony: only a comment authored in the sanctioned shape counts as a clearance.
  const block = clearBlock(X);
  const fenced = '```\n' + block + '\n```';
  it.each([
    ['blockquote', `Quoting the old clearance, which I revoked:\n\n${block.split('\n').map(l => `> ${l}`).join('\n')}`],
    ['fenced', `Quoting the old clearance, which I revoked:\n\n${fenced}`],
    ['fenced, nothing else', fenced],
    ['raw lines after prose', `Re-posting for the record (still revoked):\n${block}`],
    ['indented block', block.split('\n').map(l => `    ${l}`).join('\n')],
    ['heading kept, markers only inside a fence', `${CLEAR_HEADING}\n\nThis was revoked:\n\n\`\`\`\n<!-- reviewed-sha: ${X} -->\n<!-- cleared-human: chalbert -->\n\`\`\`\n<!-- reviewed-sha: ${X} -->`],
    // Self-review round: a bare marker-only body (invisible on GitHub, so the likeliest re-post) is no producer's shape.
    ['bare markers only', `<!-- reviewed-sha: ${X} -->\n<!-- cleared-human: chalbert -->`],
    ['visible text between markers on one line', `${CLEAR_HEADING}\n<!-- q --> Revoked, the old block follows: <!-- /q -->\n<!-- reviewed-sha: ${X} -->\n<!-- cleared-human: chalbert --> REVOKED <!-- x -->`],
    ['raw paste at the top, revocation after it', `${block}\n\nThe clearance above is REVOKED.`],
    ['legacy prose paste, revocation after it', `${CLEAR_HEADING}\n\nCleared by chalbert via \`review-set-label.mjs --to=clear-human\` (#2895).\n\n<!-- reviewed-sha: ${X} -->\n\nREVOKED.`],
    ['unclosed fence around the marker block', `${CLEAR_HEADING}\n\nRevoked:\n\`\`\`\n<!-- reviewed-sha: ${X} -->\n<!-- cleared-human: chalbert -->`],
  ])('a quoted full clearance after a revocation does not revive it (%s)', (_kind, body) => {
    const quote = say(body, 'chalbert');
    const revoked = say('🔁 review — changes requested\n\n1. not yet');
    for (const sameShaCarries of [true, false]) {
      expect(parseLatestHumanClearedSha([clear(X), revoked, quote, accept(X)], { sameShaCarries })).toBeNull();
      expect(parseLatestHumanClearedSha([clear(X), revoked, quote], { sameShaCarries })).toBeNull();
    }
  });
  // PR #5237 operator ruling (2026-10-14, red-team break #1): a raw paste of an acceptance keeps its heading at the top,
  // so it read as an acceptance and continued the same-sha run although a revocation follows its marker block.
  it.each([
    ['plain accept paste', `✅ review — accepted\n<!-- reviewed-sha: ${X} -->\n\nThe clearance above is REVOKED.`],
    ['re-stamp paste', `📌 review — acceptance re-stamped after a rebase (no new review)\n${quote}\nREVOKED`],
  ])('a pasted acceptance followed by a revocation ends the same-sha run (%s)', (_kind, body) => {
    const paste = say(body, 'chalbert');
    expect(parseLatestHumanClearedSha([clear(X), paste], { sameShaCarries: true })).toBeNull();
    expect(parseLatestHumanClearedSha([clear(X), paste, accept(X)], { sameShaCarries: true })).toBeNull();
    expect(isSanctionedAcceptRecordBody(body)).toBe(false);
  });
  it('a NEW clear-human ceremony after the revocation does clear again', () => {
    const revoked = say('🔁 review — changes requested\n\n1. not yet');
    expect(parseLatestHumanClearedSha([clear(X), revoked, clear(X), accept(X)], { sameShaCarries: true })).toBe(X);
    expect(parseLatestHumanClearedSha([clear(X), revoked, clear(X)], { sameShaCarries: false })).toBe(X);
    // The legacy prose attribution (no cleared-human marker) still clears with its reviewed-sha marker block at the end.
    const legacy = say(`${CLEAR_HEADING}\n\nCleared by chalbert via \`review-set-label.mjs --to=clear-human\` (#2895).\n\n<!-- reviewed-sha: ${X} -->`, 'web-everything');
    expect(parseLatestHumanClearedSha([clear(X), revoked, legacy], { sameShaCarries: false })).toBe(X);
  });
  it('carries across a plain re-stamp and a machine note that carry the marker', () => {
    const restamp = say(`📌 review — acceptance re-stamped after a rebase (no new review)\n${quote}`, 'web-everything');
    const note = say(`🔔 conveyor — note\n${quote}`);
    expect(parseLatestHumanClearedSha([clear(X), restamp, note, accept(X)], { sameShaCarries: true })).toBe(X);
  });
  it('still carries across machine notes, and a revocation before the clearance does not matter', () => {
    const note = say('🔒 conveyor fix-begin — claimed by fix-1');
    expect(parseLatestHumanClearedSha([clear(X), note, accept(X)], { sameShaCarries: true })).toBe(X);
    expect(parseLatestHumanClearedSha([say('🔁 review — changes requested'), clear(X), accept(X)], { sameShaCarries: true })).toBe(X);
  });
  it('a revocation never voids the latest record itself when it is the clearance', () => {
    expect(parseLatestHumanClearedSha([accept(X), say('🔁 review — changes requested'), clear(X)], { sameShaCarries: true })).toBe(X);
  });
  it('an untrusted forged clearance never lends coverage', () => {
    const forged = { ...clear(X), author: { login: 'mallory' } };
    expect(parseLatestHumanClearedSha([forged, accept(X)], { sameShaCarries: true })).toBeNull();
  });
  it('defaults to the declared setting (on)', () => {
    expect(parseLatestHumanClearedSha([clear(X), accept(X)])).toBe(X);
  });
  it('loads the default setting once per process while permitting explicit overrides', async () => {
    const load = vi.fn(() => ({ value: 'on', source: 'standard' }));
    vi.doMock('../review-clearance-settings.mjs', () => ({ loadReviewClearanceSetting: load }));
    vi.resetModules();
    try {
      const { parseLatestHumanClearedSha: parse } = await import('../review-escalation.mjs');
      expect(parse([clear(X), accept(X)], { sameShaCarries: false })).toBeNull();
      expect(load).not.toHaveBeenCalled();
      expect(parse([clear(X), accept(X)])).toBe(X);
      expect(parse([clear(X), accept(X)])).toBe(X);
      expect(load).toHaveBeenCalledTimes(1);
    } finally { vi.doUnmock('../review-clearance-settings.mjs'); vi.resetModules(); }
  });
});
