import { describe, it, expect, vi } from 'vitest';
vi.hoisted(() => vi.resetModules());
vi.mock('node:child_process', async original => {
  const real = await original();
  const spawnSync = vi.fn(() => ({ status: 1, stderr: 'offline' }));
  return { ...real, spawnSync, default: { ...real.default, spawnSync } };
});
import { spawnSync } from 'node:child_process';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { readRedTeamDisposition, redTeamGateMarker, redTeamResultId, parseRedTeamComment, CONFIRMED_BREAKS_DEFAULTS, operatorRulingsOnLiveResult, gateOutcomesForHead, liveResultGateState } from '../red-team-gate.mjs';
import { isRulingComment, operatorBoundComments, isAncestorOfMain } from '../operator-identity.mjs';
import { AUTOMATION_LOGINS, JUDGE_ATTRIBUTION } from '../marker-authorship.mjs';

const head = 'a'.repeat(40), mainSha = 'b'.repeat(40), pr = 71;
const card = 'we:backlog/xabcdef-card.md';
const policy = () => ({ enabled: true, actor: 'judge:r10' });
const findingClasses = { 'coverage-or-style': 'defer-card', 'security-reachable-today': 'defer-card', allowSecurityDefer: true };
const bot = body => ({ body, author: { login: AUTOMATION_LOGINS[0] } });
function fixture(fields = {}) {
  const result = bot(renderRedTeamComment({ pr, rev: head, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
    findings: [{ summary: 'break', file: 'src/x.js', line: 7, category: 'edge-case', impactIfUnfixed: 'broken', confirmedByRecheck: true,
      findingClass: 'coverage-or-style', classBasis: 'missing coverage', ...fields }] }));
  const parsed = parseRedTeamComment(result.body), rid = redTeamResultId(parsed);
  const judge = (outcome, line) => bot(redTeamGateMarker(pr, head, outcome, rid).replace(' -->', ' actor=judge:r10 -->') + `\n${JUDGE_ATTRIBUTION}\n${line}`);
  const block = judge('operator-block', '- 1 confirmed break(s) NOT sent back: held for a card (#1).');
  const release = judge('operator-card', `- 1 finding(s) carded by the operator to \`${card}\` (#1).\nPre-existing on main (${mainSha}): probe node probe.mjs; main=null pr=null`);
  return { comments: [result, bot(redTeamGateMarker(pr, head, 'round-cap', rid)), block, release], release, findings: parsed.findings };
}
const valid = { head, findingClasses, isAncestorOfMain: sha => sha === mainSha, cardReadable: ref => ref === card };
function read(f, over = {}) {
  return readRedTeamDisposition({ comments: f.comments, pr, head, setting: { ...CONFIRMED_BREAKS_DEFAULTS, findingClasses },
    operatorRulings: { anyState: true }, ...valid, ...over });
}
describe('judge card security at the real gate reader', () => {
  it('default ancestry refreshes main, runs bounded merge-base against the fresh tip and closes on errors', () => {
    const calls = [];
    expect(isAncestorOfMain(mainSha, { run: (...args) => { calls.push(args); return { status: 0, stdout: mainSha }; } })).toBe(true);
    expect(calls[0][1]).toEqual(['fetch', 'origin', 'main']);
    expect(calls[2]).toMatchObject(['git', ['merge-base', '--is-ancestor', mainSha, mainSha], { timeout: 5000, maxBuffer: 1 << 20 }]);
    for (const result of [{ status: 1 }, { status: null, error: new Error('unreadable') }, { status: 0, error: new Error('overflow') }])
      expect(isAncestorOfMain(mainSha, { run: () => result })).toBe(false);
    expect(isAncestorOfMain(mainSha, { run: () => { throw new Error('unreadable'); } })).toBe(false);
    expect(isAncestorOfMain('invalid', { run: () => { throw new Error('must not run'); } })).toBe(false);
  });
  it('releases a fully valid judge card backed by main and a readable card', () => {
    const f = fixture();
    expect(read(f).dispositions.get(1).state).toBe('released carded');
    expect(operatorRulingsOnLiveResult(f.comments, pr, head, valid).carded.has(1)).toBe(true);
    expect(gateOutcomesForHead(f.comments, pr, head, valid).has('operator-card')).toBe(true);
    expect(liveResultGateState(f.comments, pr, head, null, null, valid).outcomes.has('operator-card')).toBe(true);
  });
  it.each([
    ['arbitrary SHA is not an ancestor', {}, { isAncestorOfMain: () => false }],
    ['nonexistent card', {}, { cardReadable: () => false }],
    ['security class even with explicit deferral', { findingClass: 'security-reachable-today' }, {}],
    ['security retained in alsoClasses', { alsoClasses: ['security-reachable-today'] }, {}],
    ['security reachable today', { securityReachableToday: true }, {}],
    ['current class changed to fix-now after release', {}, { setting: { ...CONFIRMED_BREAKS_DEFAULTS, findingClasses: { 'coverage-or-style': 'fix-now' } } }],
    ['missing ancestry dependency', {}, { isAncestorOfMain: undefined }],
    ['missing card dependency', {}, { cardReadable: undefined }],
    ['ancestry read error', {}, { isAncestorOfMain: () => { throw new Error('unreadable'); } }],
    ['card read error', {}, { cardReadable: () => { throw new Error('unreadable'); } }],
  ])('keeps the hold: %s', (_name, fields, over) => {
    const f = fixture(fields);
    expect(read(f, over).held.map(f => f.index)).toEqual([1]);
    const context = { ...valid, ...over, findingClasses: over.setting?.findingClasses ?? findingClasses, findings: f.findings };
    expect(isRulingComment(f.release, policy, context)).toBe(false);
    expect(operatorBoundComments(f.comments, { policy, ...context })).not.toContain(f.release);
    expect(operatorRulingsOnLiveResult(f.comments, pr, head, context).carded.has(1)).toBe(false);
    expect(gateOutcomesForHead(f.comments, pr, head, context).has('operator-card')).toBe(false);
    expect(liveResultGateState(f.comments, pr, head, null, null, context).outcomes.has('operator-card')).toBe(false);
  });
  it('revokes a previously released judge card when the current policy becomes fix-now', () => {
    const f = fixture();
    expect(read(f).dispositions.get(1).state).toBe('released carded');
    const changed = { ...CONFIRMED_BREAKS_DEFAULTS, findingClasses: { 'coverage-or-style': 'fix-now' } };
    expect(read(f, { setting: changed }).held.map(f => f.index)).toEqual([1]);
  });
  it('every default reader refuses a release when the fresh evidence read fails', () => {
    const f = fixture();
    spawnSync.mockClear();
    expect(isRulingComment(f.release, policy)).toBe(false);
    expect(operatorBoundComments(f.comments, { policy })).not.toContain(f.release);
    expect(operatorRulingsOnLiveResult(f.comments, pr, head).carded.size).toBe(0);
    expect(gateOutcomesForHead(f.comments, pr, head).has('operator-card')).toBe(false);
    expect(liveResultGateState(f.comments, pr, head).outcomes.has('operator-card')).toBe(false);
    expect(spawnSync).toHaveBeenCalledWith('git', ['fetch', 'origin', 'main'], expect.any(Object));
  });
  it('identity filter binds the marker to the live head and validates named findings', () => {
    const f = fixture(), context = { ...valid, findings: f.findings };
    expect(isRulingComment(f.release, policy, context)).toBe(true);
    expect(operatorBoundComments(f.comments, { policy, ...context })).toContain(f.release);
    expect(isRulingComment(f.release, policy, { ...context, head: 'c'.repeat(40) })).toBe(false);
    expect(isRulingComment(f.release, policy, { ...context, findings: [] })).toBe(false);
    expect(isRulingComment({ ...f.release, body: f.release.body.replace(card, 'missing') }, policy, context)).toBe(false);
    const stale = { ...f, comments: f.comments.map(c => c === f.release ? { ...c, body: c.body.replace(head, 'c'.repeat(40)) } : c) };
    expect(read(stale).held.map(f => f.index)).toEqual([1]);
  });
});
