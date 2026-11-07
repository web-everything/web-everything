/** R671 red-first contract: judgeActor policy + actor= on the existing gate marker. */
import { describe, it, expect, vi } from 'vitest';
import * as authorship from '../marker-authorship.mjs';
import { assertHumanOperator, isHumanOperatorComment, isRulingComment, judgePolicyOnce, operatorBoundComments } from '../operator-identity.mjs';
import { ignoredRulings, operatorBlockRulings } from '../ruling-ledger.mjs';
import { buildOperatorRulingComment, mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } from '../jury-core.mjs';

// Ledger fixtures must not depend on which historical commits exist in the host checkout (as ruling-ledger.test.mjs).
vi.mock('../restack-equivalence.mjs', () => ({ isRestackOf: () => false }));
// A pass-through spy on the preferences read, so a test can count how often the judge policy hits the disk (#6494 F2).
const { readPrefs } = vi.hoisted(() => ({ readPrefs: vi.fn() }));
vi.mock('../policy-cascade.mjs', async (original) => {
  const real = await original();
  readPrefs.mockImplementation(real.readPlatformPreferences);
  return { ...real, readPlatformPreferences: (...args) => readPrefs(...args) };
});
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
  // The authority boundary takes no findings at all, so classification can never gate a judge block here; the
  // plan-level tests ('judge block permits security or unreadable classification', both writers) pin the rest.
  it('the authority boundary admits an enabled judge block without reading any classification', () => {
    const read = { judgeActorPolicy: { value: { enabled: true, actor } } };
    expect(authorship.assertJudgeAuthority.length).toBe(2);
    expect(() => authorship.assertJudgeAuthority(read, { actor, ruling: 'block',
      findings: [{ category: 'security/injection' }, { findingClass: 'unknown' }] })).not.toThrow();
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

describe('#6494 judge policy is read once per reader pass, and logged once per line', () => {
  const block = () => judgeGate('operator-block', '- 1 confirmed break(s) sent back to the fixer (#1).');
  it('operatorBoundComments resolves the policy once for every judge comment of the pass', () => {
    const resolve = vi.fn(() => ({ value: { enabled: true, actor } }));
    const policy = judgePolicyOnce(resolve);
    expect(operatorBoundComments([block(), block(), block()], { policy })).toHaveLength(3);
    expect(isRulingComment(block(), policy)).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it('a failed policy read refuses every judge comment of the pass without re-reading', () => {
    const resolve = vi.fn(() => { throw new Error('unreadable judge actor policy'); });
    const policy = judgePolicyOnce(resolve);
    expect(operatorBoundComments([block(), block()], { policy })).toEqual([]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it('a non-judge comment never reads the policy', () => {
    const resolve = vi.fn(() => ({ value: { enabled: true, actor } }));
    expect(operatorBoundComments([result, cap], { policy: judgePolicyOnce(resolve) })).toHaveLength(2);
    expect(resolve).not.toHaveBeenCalled();
  });
  it('readJudgeActorPolicy logs a distinct provenance line once per sink, not once per call', () => {
    const lines = [];
    const log = line => lines.push(line);
    for (let i = 0; i < 4; i++) authorship.readJudgeActorPolicy({ env: {}, platform: {}, log });
    authorship.readJudgeActorPolicy({ env: { WE_JUDGE_ACTOR_ENABLED: 'false' }, platform: {}, log });
    expect(lines.filter(l => /^policy-cascade judgeActor /.test(l))).toEqual([
      'policy-cascade judgeActor enabled=true (standard) actor=judge:r10 (standard)',
      'policy-cascade judgeActor enabled=false (env) actor=judge:r10 (standard)']);
  });
  it('the red-team gate readers read the preferences a fixed number of times, however many judge blocks the thread has', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const reads = comments => {
        readPrefs.mockClear();
        expect(operatorRulingsOnLiveResult(comments, pr, head).blocked).toEqual(new Set([1]));
        expect(liveResultGateState(comments, pr, head, 'we', null).outcomes.has('operator-block')).toBe(true);
        const d = disposition(comments);
        expect([...d.held, ...d.sendBack].map(f => f.index)).toEqual([1]);
        expect(operatorBoundComments(comments)).toHaveLength(comments.length);
        return readPrefs.mock.calls.length;
      };
      const one = reads([result, cap, block()]);
      expect(one).toBeGreaterThan(0);
      expect(reads([result, cap, block(), block(), block(), block(), block()])).toBe(one);
    } finally { errors.mockRestore(); }
  });
});

describe('#6494 judge writers hold the gate-visible policy (a tool block only narrows it)', () => {
  const writer = over => authorship.readJudgeWriterPolicy({ env: {}, log: () => {}, ...over });
  it.each([
    ['no tool block', {}, true],
    ['tool enables an enabled gate', { tool: { enabled: true } }, true],
    ['tool disables', { tool: { enabled: false } }, false],
    ['env disables the gate under an enabling tool', { tool: { enabled: true }, env: { WE_JUDGE_ACTOR_ENABLED: 'false' } }, false],
  ])('%s', (_name, over, enabled) => {
    expect(writer(over).value.enabled).toBe(enabled);
  });
  it('assertJudgeAuthority refuses supersession given as a flag string or as a derived id list', () => {
    const read = { judgeActorPolicy: { value: { enabled: true, actor } } };
    for (const supersedes of ['operator:aaaaaaaaa:0123456789ab', ['operator:aaaaaaaaa:0123456789ab'], ' x ,'])
      expect(() => authorship.assertJudgeAuthority(read, { actor, ruling: 'block', supersedes })).toThrow('judge cannot supersede rulings; operator-only');
    for (const supersedes of [undefined, '', '  ', []])
      expect(() => authorship.assertJudgeAuthority(read, { actor, ruling: 'block', supersedes })).not.toThrow();
  });
});

// #6494 F3 — ignoredRulings: a judge structured block is a standing block like auto-policy's, only while it is a
// gate-counted judge block, and it never settles the escalation ladder the way an operator's own ruling does.
describe('#6494 ignoredRulings with judge structured blocks', () => {
  const H1 = 'a'.repeat(40), H2 = 'b'.repeat(40);
  const t = n => new Date(Date.parse('2026-10-03T08:00:00Z') + n * 60_000).toISOString();
  const repo = 'web-everything/web-everything';
  const record = (h, runId) => {
    const original = { summary: 'policy pointer files are missing from the standards manifest so the gate cannot see them',
      file: 'policy/pointer.md', line: 12, verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
    const key = referralFindingKey('judge', original);
    return { version: 1, repo, pr: 3794, head: h, runId, reviewer: mandatoryReferralReviewer(runId),
      authorBody: '<!-- authored-by-actor: author -->', attempted: true,
      referrals: [{ key, seat: 'judge', original, finding: normalizeFinding(original) }], rulings: [] };
  };
  const recComment = (rec, n) => ({ body: renderReferralRecord(rec), createdAt: t(n), author: { login: botLogin } });
  const rulingComment = (rec, n, { who = actor, login = botLogin, supersedes } = {}) => ({ author: { login }, createdAt: t(n),
    body: buildOperatorRulingComment({ version: 1, repo, pr: rec.pr, head: rec.head, actor: who, channel: 'review daemon',
      reason: who === actor ? `${attribution}\nblocked: the pointer list is incomplete` : 'still blocked', at: t(n), clearerId: '',
      rulings: [{ runId: rec.runId, key: rec.referrals[0].key, result: 'block', ...(supersedes ? { supersedes } : {}) }] }) });
  const r1 = record(H1, 'run-1'), r2 = record(H2, 'run-2');
  const cameBack = extra => ignoredRulings({ headRefOid: H2, comments: [recComment(r1, 1), ...extra, recComment(r2, 10)] });

  it('a gate-counted judge block is a standing block: the same finding re-raised on a later head came back', () => {
    const ig = cameBack([rulingComment(r1, 3)]);
    expect(ig?.matches).toHaveLength(1);
    expect(ig.matches[0].source).toBe('structured');
  });
  it('a disabled judge policy makes the persisted judge block inert (no standing block)', () => {
    vi.stubEnv('WE_JUDGE_ACTOR_ENABLED', 'false');
    try { expect(cameBack([rulingComment(r1, 3)])).toBeNull(); } finally { vi.unstubAllEnvs(); }
  });
  it.each([['an operator login', { login: opLogin }], ['an unknown login', { login: 'mallory' }],
    ['a supersedes list', { supersedes: ['operator:aaaaaaaaa:0123456789ab'] }]])(
    'a forged judge block (%s) registers nothing', (_name, over) => {
      expect(cameBack([rulingComment(r1, 3, over)])).toBeNull();
    });
  it('a judge re-block on the current head does not settle the ladder; an operator block does (control)', () => {
    const judgeAgain = ignoredRulings({ headRefOid: H2, comments: [recComment(r1, 1), rulingComment(r1, 3), recComment(r2, 10), rulingComment(r2, 12)] });
    expect(judgeAgain?.matches).toHaveLength(1);
    expect(judgeAgain.misses).toBe(1);
    expect(ignoredRulings({ headRefOid: H2, comments: [recComment(r1, 1), rulingComment(r1, 3), recComment(r2, 10),
      rulingComment(r2, 12, { who: opLogin, login: opLogin })] })).toBeNull();
  });
});
