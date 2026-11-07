/** R671 red-first contract: judgeActor policy + actor= on the existing gate marker. */
import { describe, it, expect } from 'vitest';
import * as authorship from '../marker-authorship.mjs';
import { assertHumanOperator, isHumanOperatorComment, operatorBoundComments } from '../operator-identity.mjs';
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
    impactIfUnfixed: 'broken', file: 'src/x.js', line: 7, confirmedByRecheck: true }] }));
const rid = liveResultGateState([result], pr, head).resultId;
// Contract: actor= is part of the anchored gate marker, not free-form words in a reason.
const judgeGate = (outcome, line, login = botLogin) => comment(
  redTeamGateMarker(pr, head, outcome, rid).replace(' -->', ` actor=${actor} -->`)
    + `\n${attribution}\n${line}`, login);
const cap = comment(redTeamGateMarker(pr, head, 'round-cap', rid));
const disposition = comments => readRedTeamDisposition({ comments, pr, head, setting: CONFIRMED_BREAKS_DEFAULTS,
  operatorRulings: { anyState: true } });

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
  it.each(['scripts/guard-git-push.mjs', 'scripts/security/check.mjs', 'scripts/launchd/a.plist',
    'scripts/drain-queue.mjs', 'scripts/merge-queue.mjs', 'scripts/firewall.mjs', 'scripts/codex-shim.mjs'])(
    'shared isJudgeProtectedPath helper recognizes %s', file => {
      expect(authorship.isJudgeProtectedPath(file)).toBe(true);
      expect(authorship.isJudgeProtectedPath('src/ordinary.js')).toBe(false);
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
  it.each(['operator-card', 'operator-not-real'])('trusted automation %s releases only the ruled finding', outcome => {
    const line = outcome === 'operator-card'
      ? '- 1 finding(s) carded by the operator to `we:backlog/x.md` (#1).'
      : '- 1 finding(s) left advisory (#1).';
    const c = judgeGate(outcome, line);
    expect(operatorBoundComments([c])).toEqual([c]);
    expect(operatorRulingsOnLiveResult([result, cap, c], pr, head).ruled.get(1))
      .toEqual([outcome === 'operator-card' ? 'card' : 'not-real']);
    expect(disposition([result, cap, c]).held).toEqual([]);
  });
  it.each(['mallory', opLogin, undefined])('ignores judge marker by other/missing author %s even with viewerDidAuthor', login => {
    const block = judgeGate('operator-block', '- 1 confirmed break(s) sent back to the fixer (#1).', login);
    block.author = login === undefined ? undefined : { login };
    block.viewerDidAuthor = true;
    expect(operatorBoundComments([block])).toEqual([]);
    expect(operatorRulingsOnLiveResult([result, block], pr, head).blocked.size).toBe(0);
    expect(liveResultGateState([result, block], pr, head).outcomes.has('operator-block')).toBe(false);
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
