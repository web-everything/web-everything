/** R671 red-first contract: judgeActor policy + actor= on the existing gate marker. */
import { describe, it, expect, vi } from 'vitest';
import * as authorship from '../marker-authorship.mjs';
import { assertHumanOperator, isHumanOperatorComment, isRulingComment, operatorBoundComments } from '../operator-identity.mjs';
import { operatorBlockRulings } from '../ruling-ledger.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { redTeamGateMarker, liveResultGateState, operatorRulingsOnLiveResult,
  readRedTeamDisposition, CONFIRMED_BREAKS_DEFAULTS } from '../red-team-gate.mjs';
import { buildReviewedShaMarker, buildClearedHumanMarker } from '../review-escalation.mjs';

const actor = 'judge:r10';
const attribution = 'Ruled by acting judge (R10), not the operator';
const head = 'a'.repeat(40), pr = 71;
const botLogin = authorship.AUTOMATION_LOGINS[0];
const opLogin = authorship.OPERATOR_LOGINS[0];
const comment = (body, login = botLogin) => ({ body, author: { login }, createdAt: '2026-11-07T12:00:00Z' });
const result = comment(renderRedTeamComment({ pr, rev: head, provider: 'codex', model: 'm',
  recheckStatus: 'ok', foldedVerdict: 'changes', findings: [{ summary: 'live break', category: 'edge-case',
    findingClass: 'coverage-or-style', impactIfUnfixed: 'broken', file: 'src/x.js', line: 7, confirmedByRecheck: true }] }));
const rid = liveResultGateState([result], pr, head).resultId;
// Contract: actor= is part of the anchored gate marker, not free-form words in a reason.
const judgeGate = (outcome, line, login = botLogin) => comment(
  redTeamGateMarker(pr, head, outcome, rid).replace(' -->', ` actor=${actor} -->`)
    + `\n${attribution}\n${line}`, login);
const cap = comment(redTeamGateMarker(pr, head, 'round-cap', rid));
const disposition = comments => readRedTeamDisposition({ comments, pr, head, setting: CONFIRMED_BREAKS_DEFAULTS,
  operatorRulings: { anyState: true }, repo: 'we' });

describe('R671 judgeActor policy cascade', () => {
  const policy = over => authorship.readJudgeActorPolicy({ env: {}, platform: {}, tool: {}, ...over });
  it('exports JUDGE_ACTOR separately without adding an operator login', () => {
    expect(authorship.JUDGE_ACTOR).toBe(actor);
    expect(authorship.OPERATOR_LOGINS).not.toContain(actor);
    expect(policy().value).toEqual({ enabled: true, actor });
    expect(policy().sources).toMatchObject({ enabled: 'standard', actor: 'standard' });
  });
  it('resolves standard -> platform -> tool -> environment and logs both effective leaves and sources', () => {
    expect(policy({ platform: { enabled: false } })).toMatchObject({ value: { enabled: false }, sources: { enabled: 'platform' } });
    expect(policy({ platform: { enabled: false }, tool: { enabled: true } }))
      .toMatchObject({ value: { enabled: true }, sources: { enabled: 'tool' } });
    const logs = [];
    const resolved = policy({ platform: { enabled: true }, tool: { enabled: true },
      env: { WE_JUDGE_ACTOR_ENABLED: 'false', WE_JUDGE_ACTOR: actor, WE_POLICY_CASCADE_LOG: '1' },
      log: line => logs.push(line) });
    expect(resolved).toMatchObject({ value: { enabled: false, actor }, sources: { enabled: 'env', actor: 'env' } });
    expect(logs.join('\n')).toMatch(/policy-cascade.*judgeActor.*enabled=false \(env\)/);
    expect(logs.join('\n')).toMatch(/actor=judge:r10 \(env\)/);
  });
  it.each([{ platform: { enabled: 'yes' } }, { tool: { actor: '' } },
    { env: { WE_JUDGE_ACTOR_ENABLED: 'maybe' } }, { env: { WE_JUDGE_ACTOR: 'chalbert' } }])(
    'malformed policy refuses rather than falling back to enabled: %j', over => {
      expect(authorship.readJudgeActorPolicy).toBeTypeOf('function');
      expect(() => policy(over)).toThrow(/invalid|malformed|judge/i);
    });

});

describe('R671 judge readers bind actor and automation author', () => {
  it('automation judge block counts at operatorBoundComments and shared gate', () => {
    const block = judgeGate('operator-block', '- 1 confirmed break(s) sent back to the fixer (#1).');
    expect(operatorBoundComments([block])).toEqual([block]);
    expect(isHumanOperatorComment(block)).toBe(false);
    expect(operatorRulingsOnLiveResult([result, cap, block], pr, head).blocked).toEqual(new Set([1]));
    const d = disposition([result, cap, block]);
    expect([...d.held, ...d.sendBack].map(f => f.index)).toEqual([1]);
  });
  it.each(['operator-card', 'operator-not-real', 'accept', 'clear-human', 'card-queued', 'sent-back', 'round-cap'])(
    'ignores forged automation judge %s outcome in v1', outcome => {
      const c = judgeGate(outcome, '- 1 finding(s) left advisory (#1).');
      expect(operatorBoundComments([c])).toEqual([]);
      expect(operatorRulingsOnLiveResult([result, cap, c], pr, head).ruled.size).toBe(0);
      expect(liveResultGateState([result, c], pr, head, 'we', null).outcomes.has(outcome)).toBe(false);
      expect(disposition([result, cap, c]).held.map(f => f.index)).toEqual([1]);
    });
  it.each(['mallory', opLogin, undefined])('ignores judge marker by other/missing author %s even with viewerDidAuthor', login => {
    const block = judgeGate('operator-block', '- 1 confirmed break(s) sent back to the fixer (#1).', login);
    block.author = login === undefined ? undefined : { login };
    block.viewerDidAuthor = true;
    expect(operatorBoundComments([block])).toEqual([]);
    expect(operatorRulingsOnLiveResult([result, block], pr, head).blocked.size).toBe(0);
    expect(liveResultGateState([result, block], pr, head, 'we', null).outcomes.has('operator-block')).toBe(false);
  });
  it('automation without the judge actor cannot claim an operator card ruling', () => {
    const c = comment(redTeamGateMarker(pr, head, 'operator-card', rid)
      + '\n- 1 finding(s) carded by the operator to `we:backlog/x.md` (#1).');
    expect(operatorBoundComments([c])).toEqual([]);
    expect(operatorRulingsOnLiveResult([result, cap, c], pr, head).ruled.size).toBe(0);
  });
  it.each([botLogin, opLogin])('judge-looking clear-human never counts, even authored by %s', login => {
    const clearance = comment(['✅ review — `review:human` cleared via the sanctioned path', '',
      'Cleared by judge:r10 via `review-set-label.mjs --to=clear-human` (gate-self).', '', attribution,
      buildReviewedShaMarker(head), buildClearedHumanMarker(actor)].join('\n'), login);
    expect(isHumanOperatorComment(clearance)).toBe(false);
    expect(disposition([result, cap, clearance]).held.map(f => f.index)).toEqual([1]);
  });
  it('human identity binding remains unchanged and judge is not a blanket operator ledger ruling', () => {
    expect(assertHumanOperator({ login: opLogin, type: 'User' }, opLogin)).toBe(opLogin);
    expect(() => assertHumanOperator({ login: botLogin, type: 'Bot' }, actor)).toThrow();
    const c = comment(`## Operator ruling: send back to fix (block)\n\n${attribution}\nactor=judge:r10\n\n1. \`src/x.js\` ruling: block`);
    expect(operatorBlockRulings([c])).toEqual([]);
  });
});


describe('R671 v1 only adds holds', () => {
  it.each(['card', 'not-real', 'approval', 'clear-human', 'accept', undefined])('refuses judge %s in the shared authority boundary', ruling => {
    expect(() => authorship.assertJudgeAuthority({}, { actor, ruling, asJudge: true }))
      .toThrow(`judge ${ruling ?? 'grant'} is refused in v1; operator-only`);
  });
  it('block needs no classification or protected-path eligibility', () => {
    expect(() => authorship.assertJudgeAuthority({}, { actor, ruling: 'block' },
      [{ category: 'security/injection' }, { findingClass: 'unknown' }])).not.toThrow();
  });
  it('disabled policy refuses persisted judge blocks', () => {
    vi.stubEnv('WE_JUDGE_ACTOR_ENABLED', 'false');
    try {
      const block = judgeGate('operator-block', '- 1 confirmed break(s) sent back to the fixer (#1).');
      expect(operatorBoundComments([block])).toEqual([]);
      expect(operatorRulingsOnLiveResult([result, block], pr, head).blocked.size).toBe(0);
    } finally { vi.unstubAllEnvs(); }
  });
  it('judge block without attribution is ignored', () => {
    const block = judgeGate('operator-block', '- 1 confirmed break(s) sent back to the fixer (#1).');
    block.body = block.body.replace(attribution, '');
    expect(operatorBoundComments([block])).toEqual([]);
  });
  it('a judge block marker cannot smuggle a release action', () => {
    const block = judgeGate('operator-block', '- 1 finding(s) left advisory (#1).');
    expect(disposition([result, cap, block]).held.map(f => f.index)).toEqual([1]);
    expect(operatorRulingsOnLiveResult([result, cap, block], pr, head).ruled.size).toBe(0);
  });
  it('judge grant markers never count', async () => {
    const { buildRoundExtensionComment, countGrantedRoundExtensions } = await import('../../conveyor/round-extension-mark.mjs');
    const body = buildRoundExtensionComment({ repo: 'web-everything/web-everything', pr, by: 1, actor,
      channel: 'chat', reason: attribution, at: '2026-11-07T12:00:00Z' }) + `\n${attribution}`;
    for (const login of [botLogin, opLogin]) expect(countGrantedRoundExtensions([comment(body, login)],
      { repo: 'web-everything/web-everything', pr })).toBe(0);
  });
  it.each([['security/injection', true], ['security-foo', true], ['securityish', false]])(
    'shared security matcher classifies %s as %s', (value, security) => {
      expect(authorship.isSecurityClass(value)).toBe(security);
    });
});


describe('R671 judge comments cannot carry review clearance tokens', () => {
  it.each(['reviewed-sha', 'ReViEwEd-ShA', 'cleared-human', 'ClEaReD-HuMaN'])(
    'rejects judge block containing %s anywhere, including prose', token => {
      const block = judgeGate('operator-block', '- 1 confirmed break(s) sent back to the fixer (#1).');
      block.body += `\nOrdinary prose before ${token} and after.`;
      expect(isRulingComment(block)).toBe(false);
      expect(operatorBoundComments([block])).toEqual([]);
      expect(liveResultGateState([result, block], pr, head).outcomes.has('operator-block')).toBe(false);
    });
  it('preserves operator comments containing review clearance tokens', () => {
    const block = comment(redTeamGateMarker(pr, head, 'operator-block', rid)
      + '\n- 1 confirmed break(s) sent back to the fixer (#1).\nreviewed-sha and CLEARED-HUMAN in prose', opLogin);
    expect(isRulingComment(block)).toBe(true);
    expect(operatorBoundComments([block])).toEqual([block]);
  });
});
