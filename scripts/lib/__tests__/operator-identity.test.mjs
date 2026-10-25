// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isHumanOperatorComment, operatorBoundComments } from '../operator-identity.mjs';
import { redTeamGateMarker } from '../red-team-gate.mjs';

const head = 'c'.repeat(40);
const by = (login, outcome) => ({ author: { login }, body: `${redTeamGateMarker(9, head, outcome)}\n- 1 finding(s) left advisory (#1).` });

describe('operatorBoundComments', () => {
  it('drops operator-* gate records that a human operator did not write', () => {
    const kept = operatorBoundComments([by('web-everything', 'operator-card'), by('chalbert[bot]', 'operator-not-real'), by('chalbert', 'operator-card')]);
    expect(kept).toHaveLength(1);
    expect(kept[0].author.login).toBe('chalbert');
  });
  it('passes every other comment through untouched', () => {
    const others = [by('web-everything', 'round-cap'), { author: { login: 'x' }, body: 'hello' }, 'plain'];
    expect(operatorBoundComments(others)).toEqual(others);
  });
  it('tolerates a non-array', () => expect(operatorBoundComments(null)).toEqual([]));
  it('isHumanOperatorComment needs an allowlisted, non-bot login', () => {
    expect(isHumanOperatorComment({ author: { login: 'chalbert' } })).toBe(true);
    expect(isHumanOperatorComment({ author: { login: 'web-everything' } })).toBe(false);
    expect(isHumanOperatorComment({ author: { login: 'chalbert[bot]' } })).toBe(false);
    expect(isHumanOperatorComment('text')).toBe(false);
  });
  it.each([
    ['an allowlisted is_bot author without a Bot type', { author: { login: 'chalbert', is_bot: true } }],
    ['an allowlisted Bot author', { author: { login: 'chalbert', type: 'Bot' } }],
    ['an allowlisted REST Bot user', { user: { login: 'chalbert', type: 'Bot' } }],
    ['an allowlisted REST is_bot user without a Bot type', { user: { login: 'chalbert', is_bot: true } }],
    ['a bot suffix', { author: { login: 'chalbert[bot]' } }],
    ['a non-operator login', { author: { login: 'web-everything' } }],
    ['a string without author metadata', 'text'],
  ])('rejects %s', (_name, comment) => {
    expect(isHumanOperatorComment(comment)).toBe(false);
  });
  it.each(['author', 'user'])('accepts an allowlisted human through %s', key => {
    expect(isHumanOperatorComment({ [key]: { login: 'ChAlBeRt', type: 'User', is_bot: false } })).toBe(true);
  });
});
