import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import * as core from '../../../scripts/lib/jury-core.mjs';

// Execute the actual import-free workflow gate without launching the top-level harness.
const workflow = readFileSync('skills-src/jury/subject-jury.workflow.js', 'utf8');
const start = workflow.indexOf('async function redTeamGate(');
const end = workflow.indexOf('\n// ─', start);
if (start < 0 || end < 0) throw new Error('redTeamGate source boundary missing');
const gateSource = workflow.slice(start, end);
function loadGate(agent) {
  return runInNewContext(`(${gateSource})`, {
    agent, RED_TEAM_LENS: 'red-team', RED_TEAM_SCHEMA: {}, VERDICT_SCHEMA: {},
    log: () => {}, redTeamPrompt: () => '', reducePrompt: () => '',
    jurorRunningEvent: (juror, round) => ({ type: 'juror-running', juror, round }),
    findingEvent: (juror, finding, round) => ({ type: 'finding', juror, finding, round }),
    verdictEvent: (juror, verdict, round) => ({ type: 'verdict', juror, verdict, round }),
  });
}
const roster = () => ({ subject: 'standards', subjectNoun: 'standard', ledger: [] });
const closed = { verdict: 'needs-human', outcome: 'escalate' };

describe('lost red-team reduce fails closed', () => {
  const cases = [
    [null, []], [null, [{ summary: 'defect' }]],
    [{}, []], [{ outcome: 'land' }, []],
  ];
  it.each(cases)('pure fallback holds missing verdict: %j / %j', (reduced, findings) => {
    expect(core.redTeamReduceFallback).toBeTypeOf('function');
    expect(core.redTeamReduceFallback({ reduced, findings })).toEqual(closed);
  });
  it.each(cases)('actual workflow holds missing verdict: %j / %j', async (reduced, findings) => {
    const agent = vi.fn().mockResolvedValueOnce({ findings }).mockResolvedValueOnce(reduced);
    const result = await loadGate(agent)(roster(), '', '', 1, 3);
    expect(result).toMatchObject(closed);
  });
  it.each([
    [{ verdict: 'accept' }, { verdict: 'accept', outcome: 'land' }],
    [{ verdict: 'changes', outcome: 'continue' }, { verdict: 'changes', outcome: 'continue' }],
    [{ verdict: 'needs-human' }, closed],
  ])('honours a present reducer verdict in both implementations: %j', async (reduced, expected) => {
    expect(core.redTeamReduceFallback({ reduced, findings: [] })).toEqual(expected);
    const agent = vi.fn().mockResolvedValueOnce({ findings: [] }).mockResolvedValueOnce(reduced);
    expect(await loadGate(agent)(roster(), '', '', 1, 3)).toMatchObject(expected);
  });
  it('replays the recorded empty-findings reducer failure as a hold/escalation', async () => {
    const run = JSON.parse(readFileSync('skills-src/jury/__tests__/fixtures/red-team-reducer-failure.json', 'utf8'));
    const calls = [...run.calls];
    const agent = vi.fn(async (_prompt, { label }) => {
      const call = calls.shift();
      expect(label).toBe(call.label);
      if (call.error) throw new Error(call.error);
      return call.result;
    });
    const state = roster();
    const result = await loadGate(agent)(state, '', '', run.round, run.roundCap);
    expect(result).toEqual(run.expected);
    expect(calls).toEqual([]);
    expect(agent).toHaveBeenCalledTimes(2);
    expect(state.ledger.at(-1)).toMatchObject({ type: 'verdict', verdict: 'needs-human' });
    expect(state.ledger.some(event => event.verdict === 'accept')).toBe(false);
  });
});
