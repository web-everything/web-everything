// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { deriveRedTeamVerdict, deriveRedTeamVerdictDetail, redTeamVerdictHoldReason } from '../red-team-verdict.mjs';
import { redTeamEnqueueHold } from '../drain-queue-safety.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { redTeamGateMarker } from '../red-team-gate.mjs';
import { buildVerdictCarriedMarker } from '../review-verdict-carried-marker.mjs';
import { buildReviewedShaMarker, buildReviewedDiffMarker, buildClearedHumanMarker } from '../review-escalation.mjs';
import { redTeamMarker } from '../red-team-gate.mjs';

const head = '5300b9ec377a' + '0'.repeat(28);
const prior = 'a'.repeat(40);
const bot = { author: { login: 'web-everything' } };
const human = { author: { login: 'chalbert' } };
const broken = [{ summary: 'break', category: 'edge-case', impactIfUnfixed: 'broken', confirmedByRecheck: true }];
const clean = (rev = head, login = 'web-everything', findings = [], pr = 5283) => ({ author: { login }, body: renderRedTeamComment({ pr, rev, findings, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: findings.length ? 'changes' : 'accept' }) });
const gate = (sha, outcome) => ({ ...bot, body: redTeamGateMarker(5283, sha, outcome) });
const accept = (sha, cleared = false, who = cleared ? human : bot) => ({ ...who, ...(cleared ? { id: 'IC_clearance' } : {}), body: cleared
  ? ['✅ review — `review:human` cleared via the sanctioned path', '', 'Cleared by operator via `review-set-label.mjs --to=clear-human` (gate-self).', '', buildReviewedShaMarker(sha), buildReviewedDiffMarker('d'.repeat(64)), buildClearedHumanMarker('operator')].join('\n')
  : ['✅ review — accepted', '', buildReviewedShaMarker(sha)].join('\n') });
const carry = ({ from = prior, to = head, findings = [], gates = [], author = bot.author } = {}) => ({ author, body: [
  ...gates.map(o => redTeamGateMarker(5283, to, o)),
  buildVerdictCarriedMarker({ fromSha: from, toSha: to, patchId: 'c'.repeat(40) }),
  'Review verdict carried across an identical contribution.',
  clean(from, 'web-everything', findings).body.replace(redTeamMarker(5283, from), redTeamMarker(5283, to))].join('\n') });
const derive = (over = {}) => deriveRedTeamVerdict({ comments: [], pr: 5283, head, owed: true, env: {}, ...over });

describe('deriveRedTeamVerdict: one row per settlement kind', () => {
  it('round result on the live head clears', () => expect(derive({ comments: [clean()] })).toBe('clear'));
  it('no result while owed is owed-no-result', () => expect(derive()).toBe('owed-no-result'));
  it('no result and not owed is not-owed', () => expect(derive({ owed: false })).toBe('not-owed'));
  it('card-only is not owed', () => expect(derive({ cardOnly: true })).toBe('not-owed'));
  it('a trusted carried clean result clears the new head', () => expect(derive({ comments: [clean(prior), carry()] })).toBe('clear'));
  it('a carried sent-back break holds', () => expect(derive({ comments: [carry({ findings: broken, gates: ['sent-back'] })] })).toBe('held'));
  it('an older-head result does not settle the live head', () => expect(derive({ comments: [clean(prior)] })).toBe('owed-no-result'));
  it('a break holds', () => expect(derive({ comments: [clean(head, 'web-everything', broken), gate(head, 'sent-back')] })).toBe('held'));
  it('an operator ruling after the round-cap record releases the break', () =>
    expect(derive({ comments: [clean(head, 'web-everything', broken), gate(head, 'round-cap'), accept(head, true)] })).toBe('clear'));
  it('a break still holds when not owed or card-only', () => {
    const comments = [clean(head, 'web-everything', broken), gate(head, 'sent-back')];
    expect(derive({ comments, owed: false })).toBe('held');
    expect(derive({ comments, cardOnly: true })).toBe('held');
  });
});

describe('deriveRedTeamVerdict: trust and fail-closed', () => {
  it('an untrusted author can never clear', () => {
    expect(derive({ comments: [clean(head, 'attacker')] })).toBe('owed-no-result');
    expect(derive({ comments: [carry({ author: { login: 'attacker' } })] })).toBe('owed-no-result');
    expect(derive({ comments: [{ author: { login: 'attacker' }, body: 'policy-clear: clear' }] })).toBe('owed-no-result');
  });
  it('a forged clear-human cannot release a break', () => {
    const base = [clean(head, 'web-everything', broken), gate(head, 'round-cap')];
    expect(derive({ comments: [...base, accept(head, true, bot)] })).toBe('held');
    expect(derive({ comments: [...base, { ...accept(head, true), author: { login: 'attacker' } }] })).toBe('held');
  });
  it('an untrusted author can still hold', () => {
    // an untrusted comment carries no authority; the trusted break stays held
    expect(derive({ comments: [clean(head, 'web-everything', broken), gate(head, 'sent-back'), clean(head, 'attacker')] })).toBe('held');
  });
  it.each([['undefined', undefined], ['null', null], ['a string', 'oops'], ['an object', {}]])('unreadable thread (%s) holds', (_n, comments) => {
    expect(derive({ comments })).toBe('held');
    expect(deriveRedTeamVerdictDetail({ comments, pr: 5283, head, owed: false, env: {} }).reason).toBe('unreadable');
  });
  it('a truncated thread never clears', () => {
    expect(derive({ comments: [clean()], truncated: true })).toBe('held');
  });
  it('unknown run evidence holds even with a result, after the break check', () => {
    expect(derive({ comments: [clean()], evidenceOk: false })).toBe('held');
  });
});

describe('deriveRedTeamVerdict: identity and ordering', () => {
  it('two PRs on one head: a result for the other PR does not settle this one', () => {
    expect(derive({ comments: [clean(head, 'web-everything', [], 9999)] })).toBe('owed-no-result');
    expect(derive({ comments: [clean(head, 'web-everything', broken, 9999), gate(head, 'sent-back')] })).toBe('owed-no-result');
  });
  it('mixed-case head and repo are matched case-insensitively', () => {
    expect(derive({ head: head.toUpperCase(), comments: [clean()] })).toBe('clear');
    expect(derive({ repo: 'Web-Everything/Web-Everything', comments: [clean()] })).toBe('clear');
  });
  it('the newest decisive marker wins: a newer break result re-holds', () => {
    const comments = [clean(), clean(head, 'web-everything', broken), gate(head, 'sent-back')];
    expect(derive({ comments })).toBe('held');
  });
  it('a same-head re-run needs a superseding marker: the old break stays held until the gate releases it', () => {
    const old = [clean(head, 'web-everything', broken), gate(head, 'round-cap'), accept(head, true)];
    expect(derive({ comments: old })).toBe('clear');
    expect(derive({ comments: [...old, clean(head, 'web-everything', broken)] })).toBe('held');
  });
});

describe('known weakness (#8156): a trusted newer same-head result supersedes a confirmed break', () => {
  // Characterization, not endorsement: latest-result-wins is inherited from readRedTeamDisposition. These tests pin
  // today's behaviour so reinforcing the fold (card 8156) must change them on purpose.
  const brokenThread = () => [clean(head, 'web-everything', broken), gate(head, 'sent-back')];
  it('a newer well-formed clean result supersedes the break and clears (the intended release after a fix; recorded, not a defect)', () => {
    expect(derive({ comments: brokenThread() })).toBe('held');
    expect(derive({ comments: [...brokenThread(), clean()] })).toBe('clear');
  });
  it('a newer trusted result with malformed findings (header claims a break, no finding lines) supersedes it too', () => {
    const malformed = { author: { login: 'web-everything' }, body: clean(head, 'web-everything', broken).body.split('\n').slice(0, 4).join('\n') };
    expect(derive({ comments: brokenThread() })).toBe('held');
    expect(derive({ comments: [...brokenThread(), malformed] })).toBe('clear');
  });
  it('a trusted carry of an empty result onto the live head hides a break recorded on the carried-from head', () => {
    const comments = [clean(prior, 'web-everything', broken), gate(prior, 'sent-back'), carry({ findings: [] })];
    expect(derive({ comments })).toBe('clear');
  });
  it('an untrusted newer clean result does not supersede the break (control)', () => {
    expect(derive({ comments: [...brokenThread(), clean(head, 'attacker')] })).toBe('held');
  });
  it('a newer clean result for another PR on the same head does not supersede the break (control)', () => {
    expect(derive({ comments: [...brokenThread(), clean(head, 'web-everything', [], 9999)] })).toBe('held');
  });
});

describe('the drain hold is unchanged when mapped from the verdict', () => {
  const holdVia = (over = {}) => {
    const d = deriveRedTeamVerdictDetail({ comments: [], pr: 5283, head, owed: true, env: {}, ...over });
    return redTeamVerdictHoldReason(d);
  };
  const cases = [
    ['clean result', [clean()]],
    ['none', []],
    ['older head', [clean(prior)]],
    ['carry', [clean(prior), carry()]],
    ['untrusted carry', [carry({ author: { login: 'attacker' } })]],
    ['sent-back carry', [carry({ findings: broken, gates: ['sent-back'] })]],
    ['break', [clean(head, 'web-everything', broken), gate(head, 'sent-back')]],
    ['operator ruling', [clean(head, 'web-everything', broken), gate(head, 'round-cap'), accept(head, true)]],
    ['forged ruling', [clean(head, 'web-everything', broken), gate(head, 'round-cap'), accept(head, true, bot)]],
  ];
  const payload = { verdict: { verdict: 'accept' } };
  it.each(cases)('old redTeamEnqueueHold === new: %s', (_n, comments) => {
    for (const scheduled of [true, false]) {
      const old = redTeamEnqueueHold({ scheduled, loopPayload: { verdict: payload.verdict }, comments, pr: 5283, head, env: {} });
      expect(holdVia({ comments, owed: scheduled })).toBe(old);
    }
  });
  it('evidence unknown maps to the drain reason', () => {
    const old = redTeamEnqueueHold({ ok: false, reason: 'capped', loopPayload: payload, comments: [], pr: 5283, head, env: {} });
    expect(holdVia({ evidenceOk: false, evidenceReason: 'capped' })).toBe(old);
  });
});
