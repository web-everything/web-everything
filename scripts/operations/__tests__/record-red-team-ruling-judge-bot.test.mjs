/** Opportunity #30: a judge ruling posts through the bot path, never the operator's login. */
import { describe, expect, it } from 'vitest';
import { ghEnvFor, resolveRulingIdentity, judgeAuditLine } from '../record-red-team-ruling-io.mjs';
import { assertJudgeAuthority, JUDGE_ACTOR } from '../../lib/marker-authorship.mjs';

const operatorEnv = { GH_TOKEN: 'op-token', GITHUB_TOKEN: 'op-token', WE_GH_AUTH_TOKEN_HASH: 'h', PATH: '/bin' };
const BOT = JSON.stringify({ login: 'we-app[bot]', type: 'Bot' });

describe('judge ruling posts as the bot', () => {
  it('runs gh under the App-writer env: inherited tokens dropped, personal fallback refused', () => {
    const env = ghEnvFor(JUDGE_ACTOR, operatorEnv);
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.WE_GH_AUTH_PERSONAL_FALLBACK).toBe('refuse');
  });

  it('leaves the operator channel unchanged for a human actor', () => {
    const env = ghEnvFor('chalbert', operatorEnv);
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.WE_GH_AUTH_PERSONAL_FALLBACK).toBeUndefined();
  });

  it('resolves the judge identity under the App-writer env and returns the bot', () => {
    let seen;
    const id = resolveRulingIdentity(JUDGE_ACTOR, { env: operatorEnv, run: (_c, _a, o) => { seen = o.env; return { status: 0, stdout: BOT }; } });
    expect(id).toEqual({ login: 'we-app[bot]', type: 'Bot' });
    expect(seen.WE_GH_AUTH_PERSONAL_FALLBACK).toBe('refuse');
    expect(seen.GH_TOKEN).toBeUndefined();
  });

  it('NEGATIVE: no bot token is a named refusal, never an operator-login fallback', () => {
    const run = () => ({ status: 1, stderr: 'no app token' });
    expect(() => resolveRulingIdentity(JUDGE_ACTOR, { env: operatorEnv, run }))
      .toThrow(/judge ruling refused: WE App token unavailable, no operator-login fallback/);
  });

  it('NEGATIVE: an operator login answering for the judge is still refused downstream', async () => {
    const { assertRulingIdentity } = await import('../../lib/operator-identity.mjs');
    const op = resolveRulingIdentity(JUDGE_ACTOR, { env: operatorEnv, run: () => ({ status: 0, stdout: JSON.stringify({ login: 'chalbert', type: 'User' }) }) });
    expect(() => assertRulingIdentity(op, JUDGE_ACTOR)).toThrow(/trusted automation/);
  });

  it('NEGATIVE: a judge can never grant, clear, accept or supersede (unknown kinds refuse)', () => {
    const read = { judgeActorPolicy: { value: { enabled: true, actor: JUDGE_ACTOR } } };
    for (const ruling of ['card', 'not-real', 'accepted', 'clear-human', 'grant', undefined]) {
      expect(() => assertJudgeAuthority(read, { actor: JUDGE_ACTOR, ruling })).toThrow(/operator-only/);
    }
    expect(() => assertJudgeAuthority(read, { actor: JUDGE_ACTOR, ruling: 'block', supersedes: 'x' })).toThrow(/supersede/);
  });

  it('emits the audit line with actor=orchestrator channel=judge', () => {
    const line = judgeAuditLine({ pr: 7160, repo: 'o/r', head: 'a'.repeat(40), login: 'we-app[bot]' });
    expect(line).toBe(`judge-ruling-audit actor=orchestrator channel=judge repo=o/r pr=7160 head=${'a'.repeat(40)} poster=we-app[bot]`);
  });
});
