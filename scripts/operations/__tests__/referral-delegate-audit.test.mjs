import { describe, it, expect } from 'vitest';
import { openReferralFindings, planOperatorRuling } from '../record-referral-ruling.mjs';
import { buildOperatorRulingComment, parseOperatorRulingComment, carriedActor } from '../../lib/jury-core.mjs';
import { ignoredRulings } from '../../lib/ruling-ledger.mjs';
import { H1, H2, repo, record, recordComment } from '../../conveyor/__tests__/ruling-fixtures.mjs';
import { AUTOMATION_LOGINS } from '../../lib/marker-authorship.mjs';

function fixture() {
  const comments = [recordComment(record({ head: H1, runId: 'run-1' }), 5)];
  const read = { ...openReferralFindings({ comments, repo, pr: 3794, head: H1 }), head: H1,
    identity: { login: 'web-everything', type: 'Bot' }, now: '2026-11-24T12:00:00Z', clearerId: 'test',
    card: { ref: 'we:backlog/123-gap.md', readable: true } };
  read.open[0] = { ...read.open[0], findingClass: 'coverage-or-style', classBasis: 'coverage gap' };
  const input = { repo, pr: 3794, finding: 'all-open', ruling: 'card', actor: 'referral-ruler', channel: 'referral-auto-rule', reason: 'pre-existing gap', expectHead: H1 };
  return { read, input, comments };
}
describe('delegate writer and merge reader audit', () => {
  it.each(['blocked', 'ruled', 'disputed', 'needs-recheck'])('delegate cannot replace %s with a card', state => {
    const { read, input } = fixture(); read.open[0].state = state;
    expect(() => planOperatorRuling(read, input)).toThrow(/pending/);
  });
  it.each(['correctness-in-normal-use', 'security-reachable-today', 'coverage-or-style'])('delegate cannot card %s even under a permissive class policy', findingClass => {
    const { read, input } = fixture(); read.open[0].findingClass = findingClass;
    if (findingClass === 'coverage-or-style') read.open[0].alsoClasses = ['security-reachable-today'];
    read.findingClassPolicy = { 'security-reachable-today': 'defer-card', allowSecurityDefer: true };
    expect(() => planOperatorRuling(read, input)).toThrow(/fix-now|security/);
  });
  it.each(['malformed', 'unknown', 'protected'])('delegate refuses %s protection evidence', kind => {
    const { read, input } = fixture();
    if (kind === 'malformed') read.protectionMalformed = true;
    if (kind === 'unknown') read.open[0].protectionUnknown = ['unreadable history'];
    if (kind === 'protected') read.open[0].protectingRulings = [{ id: 'human-block' }];
    expect(() => planOperatorRuling(read, input)).toThrow(/protection|protected|malformed/);
  });
  it('delegate cannot explicitly supersede', () => {
    const { read, input } = fixture();
    expect(() => planOperatorRuling(read, { ...input, supersedes: 'human-block' })).toThrow(/supersede/);
  });
  it('poster stamp binds the delegate to exactly one automation principal', () => {
    const { read, input } = fixture(); const plan = planOperatorRuling(read, input);
    expect(plan.record.poster).toBe('web-everything');
    for (const login of [...AUTOMATION_LOGINS.filter(x => x !== 'web-everything'), 'chalbert', 'outsider']) {
      expect(parseOperatorRulingComment({ body: plan.body, author: { login } })?.record).toBeUndefined();
    }
    const { poster, ...unstamped } = plan.record;
    expect(parseOperatorRulingComment({ body: buildOperatorRulingComment(unstamped), author: { login: 'web-everything' } })?.record).toBeUndefined();
  });
  it('delegate block participates in ignored-ruling escalation', () => {
    const { read, input, comments } = fixture(); delete read.card;
    const plan = planOperatorRuling(read, { ...input, ruling: 'block' });
    comments.push({ body: plan.body, author: { login: 'web-everything' } });
    comments.push(recordComment(record({ head: H2, runId: 'run-2' }), 20));
    expect(ignoredRulings({ number: 3794, headRefOid: H2, comments }).misses).toBeGreaterThan(0);
  });
  it('carried delegate card is never labelled operator', () => {
    const from = { head: H1, runId: 'run-1', key: 'key' };
    expect(carriedActor({ result: 'card', from }, { operatorRulings: [{ ...from, actor: 'referral-ruler' }] })).toBe('referral delegate');
  });
});

import ancestryBreak from '../../conveyor/soak/breaks/referral-auto-rule-no-sweep-dependency.mjs';
import * as cp from 'node:child_process';
vi.mock('node:child_process', async original => ({ ...await original(), spawnSync: vi.fn() }));
import { vi } from 'vitest';
it('fix presence follows ancestry even when behavioural execution fails', () => {
  const calls = [];
  const spy = vi.spyOn(cp, 'spawnSync').mockImplementation((cmd, args) => {
    calls.push([cmd, args]);
    return { status: cmd === 'git' && args.includes('--is-ancestor') ? 0 : 1 };
  });
  try {
    expect(ancestryBreak.fixPresent(process.cwd())).toBe(true);
    expect(calls.every(([cmd]) => cmd === 'git')).toBe(true);
  } finally { spy.mockRestore(); }
});
