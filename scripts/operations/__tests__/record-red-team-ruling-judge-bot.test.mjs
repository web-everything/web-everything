/** Opportunity #30: a judge ruling posts through the bot path, never the operator's login. */
import { describe, expect, it, vi } from 'vitest';
import { createRecordRedTeamRulingReader, ghEnvFor, resolveRulingIdentity, judgeAuditLine } from '../record-red-team-ruling-io.mjs';
import { assertJudgeAuthority, JUDGE_ACTOR } from '../../lib/marker-authorship.mjs';
import { assertRulingIdentity } from '../../lib/operator-identity.mjs';
import * as ghThrottle from '../../lib/gh-throttle.mjs';

const operatorEnv = { GH_TOKEN: 'op-token', GITHUB_TOKEN: 'op-token', WE_GH_AUTH_TOKEN_HASH: 'h', PATH: '/bin' };

describe('judge ruling posts as the bot', () => {
  it('accepts an installation token whose supported endpoints exclude GET /user', () => {
    const calls = [];
    const run = (command, args, options) => {
      calls.push({ command, args, env: options.env });
      if (args[1] === 'installation/repositories?per_page=1') {
        expect(options.timeout).toBe(60_000);
        expect(options.maxBuffer).toBe(4 * 1024 * 1024);
        return { status: 0, stdout: '1\n' };
      }
      return { status: 1, stderr: 'Resource not accessible by integration' };
    };
    expect(resolveRulingIdentity(JUDGE_ACTOR, { env: operatorEnv, run }))
      .toEqual({ login: 'web-everything[bot]', type: 'Bot' });
    expect(calls).toEqual([{ command: 'gh', args: ['api', 'installation/repositories?per_page=1', '--jq', '.total_count'],
      env: expect.objectContaining({ WE_GITHUB_APP_ROLE: 'legacy', WE_GH_AUTH_PERSONAL_FALLBACK: 'refuse' }) }]);
    expect(calls[0].env.GH_TOKEN).toBeUndefined();
    expect(calls[0].env.GITHUB_TOKEN).toBeUndefined();
  });

  it.each([true, false])('planning reader uses the default throttled App identity path (available=%s)', available => {
    const probe = vi.spyOn(ghThrottle, 'runGhSync').mockImplementation((args, options) => {
      expect(args).toEqual(['api', 'installation/repositories?per_page=1', '--jq', '.total_count']);
      expect(options.env.WE_GITHUB_APP_ROLE).toBe('legacy');
      expect(options.env.WE_GH_AUTH_PERSONAL_FALLBACK).toBe('refuse');
      expect(options.env.GH_TOKEN).toBeUndefined();
      expect(options.env.GITHUB_TOKEN).toBeUndefined();
      if (!available) throw new Error('installation token expired');
      return '1\n';
    });
    try {
      const read = createRecordRedTeamRulingReader({ env: operatorEnv, log: () => {}, assertFresh: () => {},
        readThread: () => ({ headRefOid: 'a'.repeat(40), labels: [], comments: [] }),
        readStandingRulingScope: () => null, readScope: () => ({ value: {} }), readSetting: () => ({ value: {} }) });
      const input = { repo: 'o/r', pr: 7160, actor: JUDGE_ACTOR };
      if (available) {
        const context = read(input);
        expect(context.identity).toEqual({ login: 'web-everything[bot]', type: 'Bot' });
        expect(assertRulingIdentity(context.identity, JUDGE_ACTOR)).toBe('web-everything[bot]');
      } else expect(() => read(input)).toThrow(/judge ruling refused: WE App token unavailable, no operator-login fallback/);
      expect(probe).toHaveBeenCalledTimes(1);
    } finally { probe.mockRestore(); }
  });

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
    const id = resolveRulingIdentity(JUDGE_ACTOR, { env: { ...operatorEnv, WE_GITHUB_APP_ROLE: 'reviewer' },
      run: (_c, _a, o) => { seen = o.env; return { status: 0, stdout: '1\n' }; } });
    expect(id).toEqual({ login: 'web-everything[bot]', type: 'Bot' });
    expect(seen.WE_GH_AUTH_PERSONAL_FALLBACK).toBe('refuse');
    expect(seen.WE_GITHUB_APP_ROLE).toBe('legacy');
    expect(seen.GH_TOKEN).toBeUndefined();
    expect(seen.WE_GH_AUTH_TOKEN_HASH).toBeUndefined();
  });

  it('accepts an authenticated installation with no repositories', () => {
    const id = resolveRulingIdentity(JUDGE_ACTOR, { env: operatorEnv, run: () => ({ status: 0, stdout: '0\n' }) });
    expect(id).toEqual({ login: 'web-everything[bot]', type: 'Bot' });
  });

  it.each(['', 'null', '{}', '-1', '1.5', '9007199254740992', '{"login":"chalbert","type":"User"}'])
  ('NEGATIVE: invalid installation probe response %j refuses without fallback', stdout => {
    let calls = 0;
    expect(() => resolveRulingIdentity(JUDGE_ACTOR, { env: operatorEnv, run: () => { calls++; return { status: 0, stdout }; } }))
      .toThrow(/judge ruling refused: WE App token unavailable, no operator-login fallback/);
    expect(calls).toBe(1);
  });

  it.each([
    { status: 1, stderr: 'Requires an installation access token' },
    { status: null, error: new Error('spawn failed') },
  ])('NEGATIVE: personal authentication or a failed probe refuses (%j)', result => {
    let calls = 0;
    expect(() => resolveRulingIdentity(JUDGE_ACTOR, { env: operatorEnv, run: () => { calls++; return result; } }))
      .toThrow(/judge ruling refused: WE App token unavailable, no operator-login fallback/);
    expect(calls).toBe(1);
  });

  it('resolves a human actor through the operator endpoint', () => {
    const id = resolveRulingIdentity('chalbert', { env: operatorEnv, run: (command, args, options) => {
      expect(command).toBe('gh');
      expect(args).toEqual(['api', 'user']);
      expect(options.env.GH_TOKEN).toBeUndefined();
      expect(options.env.WE_GH_AUTH_PERSONAL_FALLBACK).toBeUndefined();
      return { status: 0, stdout: JSON.stringify({ login: 'chalbert', type: 'User' }) };
    } });
    expect(id).toEqual({ login: 'chalbert', type: 'User' });
  });

  it('NEGATIVE: no bot token is a named refusal, never an operator-login fallback', () => {
    const run = () => ({ status: 1, stderr: 'no app token' });
    expect(() => resolveRulingIdentity(JUDGE_ACTOR, { env: operatorEnv, run }))
      .toThrow(/judge ruling refused: WE App token unavailable, no operator-login fallback/);
  });

  it('NEGATIVE: an operator login answering for the judge is still refused downstream', () => {
    const op = resolveRulingIdentity('chalbert', { env: operatorEnv, run: () => ({ status: 0, stdout: JSON.stringify({ login: 'chalbert', type: 'User' }) }) });
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
