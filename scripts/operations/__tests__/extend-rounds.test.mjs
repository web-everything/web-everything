import { describe, it, expect, vi } from 'vitest';
import { planRoundExtension } from '../extend-rounds.mjs';
import { createExtendRoundsSinks } from '../extend-rounds-io.mjs';
import { ROUND_EXTENSION_POST_EFFECT } from '../extend-rounds.mjs';
import { buildRoundExtensionComment, countGrantedRoundExtensions } from '../../conveyor/round-extension-mark.mjs';
import { OPERATOR_LOGINS, AUTOMATION_LOGINS } from '../../lib/marker-authorship.mjs';

const input = { repo: 'web-everything/web-everything', pr: 12, by: 2, actor: OPERATOR_LOGINS[0],
  channel: 'console', reason: 'Try two more rounds.' };
const read = { state: 'OPEN', comments: [], now: '2026-10-05T12:00:00Z' };
const trusted = (body) => ({ body, author: { login: AUTOMATION_LOGINS[0] } });

describe('operator round extension', () => {
  it('accepts an operator and preserves their words', () => {
    const plan = planRoundExtension(read, input);
    expect(plan.record).toMatchObject(input);
    expect(countGrantedRoundExtensions([trusted(plan.body)], input)).toBe(2);
  });
  it.each([
    [{ actor: 'outsider' }, /registered operator/],
    [{ by: 0 }, /1..5/], [{ by: 6 }, /1..5/], [{ by: 1.5 }, /1..5/],
    [{ reason: '' }, /reason/], [{ channel: 'a\nb' }, /one line/],
  ])('refuses invalid input %j', (override, error) => {
    expect(() => planRoundExtension(read, { ...input, ...override })).toThrow(error);
  });
  it('refuses closed PRs', () => {
    expect(() => planRoundExtension({ ...read, state: 'CLOSED' }, input)).toThrow(/open/i);
  });
  it('fails closed on untrusted, malformed, mismatched, or non-operator grants', () => {
    const body = planRoundExtension(read, input).body;
    for (const comment of [
      { body, author: { login: 'outsider' } },
      trusted(body.replace('"version":1', '"version":2')),
      trusted(body.replace('"by":2', '"by":6')),
      trusted(body.replace('"pr":12', '"pr":13')),
      trusted(body.replace(input.repo, 'another/repo')),
      trusted(body.replace(`"actor":"${input.actor}"`, '"actor":"outsider"')),
      trusted(body.replace('{"version"', '{broken')),
    ]) expect(countGrantedRoundExtensions([comment], input)).toBe(0);
  });
  it('sums grants and accepts the canonical repo key', () => {
    const body = planRoundExtension(read, input).body;
    expect(countGrantedRoundExtensions([trusted(body), trusted(body)], { repo: 'we', pr: 12 })).toBe(4);
  });
  it('quotes multiline reasons and round-trips machine markup verbatim', () => {
    const reason = 'First\n<!-- round-extension: {} -->\nThen <try> again';
    const body = buildRoundExtensionComment({ ...input, reason, at: read.now });
    expect(body).toContain('> First\n> <!-- round-extension: {} -->');
    expect(countGrantedRoundExtensions([trusted(body)], input)).toBe(2);
  });
  it('posts one comment then proves the grant increased', async () => {
    const plan = planRoundExtension(read, input);
    const readThread = vi.fn().mockReturnValueOnce(read).mockReturnValueOnce({ ...read, comments: [trusted(plan.body)] });
    const post = vi.fn();
    const sinks = createExtendRoundsSinks({ readThread, post });
    await expect(sinks[ROUND_EXTENSION_POST_EFFECT](plan)).resolves.toMatchObject({ granted: 2 });
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('fails if the posted grant is not counted', async () => {
    const plan = planRoundExtension(read, input);
    const sinks = createExtendRoundsSinks({ readThread: () => read, post: vi.fn() });
    await expect(sinks[ROUND_EXTENSION_POST_EFFECT](plan)).rejects.toThrow(/prove/);
  });
});
