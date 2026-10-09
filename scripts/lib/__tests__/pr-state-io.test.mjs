/** @file IO-level /state guarantees through the injected runner: failed probes stay visible, notes need a trusted author and the current head, output is sanitized. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fixDispatchSessionName } from '../../conveyor/fix-claim-store.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPrFacts, readCardFacts, cleanText } from '../pr-state-io.mjs';
import { derivePrState } from '../pr-state-core.mjs';

const PR = 987654, SHA = 'a'.repeat(40), HEAD_AT = '2026-10-06T10:00:00Z';
let scratch;
beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), 'pr-state-io-')); });
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const green = name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: HEAD_AT });
// The declared fallback required set is test/smoke/daemon-soak, so a green rollup must carry all three.
const graphql = (comments = [], { nodes = ['test', 'smoke', 'daemon-soak', 'integration'].map(green), hasNextPage = false } = {}) => JSON.stringify({ data: { repository: { pullRequest: {
  comments: { pageInfo: { hasPreviousPage: false }, nodes: comments },
  timelineItems: { nodes: [] },
  commits: { nodes: [{ commit: { oid: SHA, committedDate: HEAD_AT, statusCheckRollup: { contexts: { pageInfo: { hasNextPage }, nodes } } } }] } } } } });
/** A runner answering each probe; `fail` names probes that throw. */
function runner({ comments, fail = [], agents = '[]', protection = '{"contexts":["test"]}', labels = ['review:changes'], rollup } = {}) {
  return (bin, args) => {
    const joined = [bin, ...args].join(' ');
    const probe = bin === 'claude' ? 'agents' : joined.includes('graphql') ? 'graphql' : joined.includes('protection') ? 'protection' : 'view';
    if (fail.includes(probe)) throw new Error(`${probe} down`);
    if (joined.includes('pr list')) return '[]';
    if (probe === 'agents') return agents;
    if (probe === 'graphql') return graphql(comments, rollup);
    if (probe === 'protection') return protection;
    return JSON.stringify({ number: PR, state: 'OPEN', isDraft: false, mergeStateStatus: 'CLEAN', headRefOid: SHA,
      labels: labels.map(name => ({ name })), body: '', createdAt: HEAD_AT });
  };
}
const io = (extra = {}) => ({ run: runner(extra), home: scratch, root: scratch,
  env: { WE_STATE_DAEMON_ROOT: join(scratch, 'daemon') }, now: () => '2026-10-06T12:00:00Z' });
const note = (body, login = 'web-everything', createdAt = '2026-10-06T11:00:00Z') => ({ body, createdAt, author: { login } });

describe('readPrFacts probes', () => {
  it('reads green required checks on the current head', () => {
    const facts = readPrFacts(PR, io());
    expect(facts.requiredChecks).toEqual([{ name: 'test', state: 'green' }]);
    expect(facts.probeErrors).toEqual([]);
  });
  it('a failed head/comments probe marks checks unknown, never waiting on CI', () => {
    const facts = readPrFacts(PR, io({ fail: ['graphql'] }));
    expect(facts.probeErrors).toContain('GitHub head/comments unavailable');
    expect(facts.requiredChecks).toEqual([{ name: 'test', state: 'unknown' }]);
    const state = derivePrState(facts);
    expect(state.phase).not.toBe('WAITING-CI');
    expect(state.phase).toBe('NEEDS-OPERATOR');
  });
  it('a failed required-check policy probe is visible and blocks READY-TO-MERGE even with every fallback check green', () => {
    const healthy = derivePrState(readPrFacts(PR, io({ labels: ['ready-to-merge'] })));
    expect(healthy.phase).toBe('READY-TO-MERGE');
    const facts = readPrFacts(PR, io({ fail: ['protection'], labels: ['ready-to-merge'] }));
    expect(facts.probeErrors.join(' ')).toContain('required-check policy');
    expect(facts.requiredChecks.every(c => c.state === 'green')).toBe(true);
    expect(derivePrState(facts).phase).toBe('NEEDS-OPERATOR');
  });
  it('a truncated check rollup leaves an unseen required check unknown, not missing', () => {
    const facts = readPrFacts(PR, io({ protection: '{"contexts":["test","smoke"]}', rollup: { nodes: [green('test')], hasNextPage: true } }));
    expect(facts.probeErrors).toContain('check rollup truncated at 100');
    expect(facts.requiredChecks.find(c => c.name === 'test').state).toBe('green');
    expect(facts.requiredChecks.find(c => c.name === 'smoke').state).toBe('unknown');
  });
  it('a fixer that pushed mid-session is a new head: claim head differs from the live head', () => {
    const name = fixDispatchSessionName({ repo: 'we', pr: PR, kind: 'fix' });
    const jobs = join(scratch, '.claude/jobs/one');
    mkdirSync(jobs, { recursive: true });
    writeFileSync(join(jobs, 'state.json'), JSON.stringify({ name, status: 'done', startedAt: '2026-10-06T11:00:00Z', endedAt: '2026-10-06T11:50:00Z' }));
    const claim = headSha => () => ({ owner: name, meta: { headSha } });
    const facts = readPrFacts(PR, { ...io(), readClaim: claim('b'.repeat(40)) });
    expect(facts.sessions.find(s => s.name === name).headAtStart).toBe('b'.repeat(40));
    expect(derivePrState(facts).evidence.join(' ')).toContain('new head pushed');
    const same = readPrFacts(PR, { ...io(), readClaim: claim(SHA) });
    expect(derivePrState(same).evidence.join(' ')).not.toContain('new head pushed');
  });
  it('a failed `claude agents` probe is recorded', () => {
    expect(readPrFacts(PR, io({ fail: ['agents'] })).probeErrors).toContain('claude agents unavailable');
  });
  it('conveyor notes from an untrusted author never gate the operator', () => {
    const facts = readPrFacts(PR, io({ comments: [note('needs your decision: x', 'mallory'), note('round-cap exhausted', 'mallory')] }));
    expect(facts.needsDecisionNote).toBe(false);
    expect(facts.roundCapNote).toBe(false);
  });
  it('trusted notes count only when posted after the current head', () => {
    expect(readPrFacts(PR, io({ comments: [note('needs your decision: x')] })).needsDecisionNote).toBe(true);
    expect(readPrFacts(PR, io({ comments: [note('needs your decision: x', 'web-everything', '2026-10-06T09:00:00Z')] })).needsDecisionNote).toBe(false);
  });
});

describe('readPrFacts reads the repo it is given (xhetzpl)', () => {
  /** Record every gh argv so the test can assert the slug each probe carried. */
  const recording = () => { const calls = []; const inner = runner(); return { calls, run: (bin, args) => { calls.push([bin, ...args]); return inner(bin, args); } }; };
  it('every gh probe carries the plateau-app slug when repo=plateauapp/plateau-app', () => {
    const rec = recording();
    const facts = readPrFacts(PR, { ...io(), run: rec.run, repo: 'plateauapp/plateau-app' });
    const gh = rec.calls.filter(c => c[0] === 'gh');
    expect(gh.find(c => c.includes('view'))).toEqual(expect.arrayContaining(['--repo', 'plateauapp/plateau-app']));
    expect(gh.find(c => c.includes('graphql')).join(' ')).toContain('owner:"plateauapp",name:"plateau-app"');
    expect(gh.find(c => c.some(a => /protection/.test(a))).join(' ')).toContain('repos/plateauapp/plateau-app/');
    expect(gh.flat().join(' ')).not.toContain('web-everything/web-everything');
    expect(facts.probeErrors).toEqual([]);
  });
  it('an unreadable protection probe falls back to that repo\'s declared policy, not WE\'s (plateau-app: test + e2e)', () => {
    const facts = readPrFacts(PR, { ...io({ fail: ['protection'] }), repo: 'plateauapp/plateau-app' });
    expect(facts.requiredChecks.map(c => c.name)).toEqual(['test', 'e2e']);
    expect(facts.probeErrors).toContain('required-check policy (using declared fallback) unavailable');
  });
  it('accepts the internal key too (frontierui)', () => {
    const rec = recording();
    readPrFacts(PR, { ...io(), run: rec.run, repo: 'frontierui' });
    expect(rec.calls.find(c => c.includes('view'))).toEqual(expect.arrayContaining(['--repo', 'frontier-ui/frontierui']));
  });
  it('defaults to web-everything when no repo is given', () => {
    const rec = recording();
    readPrFacts(PR, { ...io(), run: rec.run });
    expect(rec.calls.find(c => c.includes('view'))).toEqual(expect.arrayContaining(['--repo', 'web-everything/web-everything']));
  });
  it('an unknown repo fails closed instead of reading web-everything', () => {
    expect(() => readPrFacts(PR, { ...io(), repo: 'someone/else' })).toThrow(/unknown repo/);
  });
  it('a plateau-app fix session is matched by its own name, a WE session with the same number is not', () => {
    const own = fixDispatchSessionName({ repo: 'plateau-app', pr: PR, kind: 'fix' });
    const we = fixDispatchSessionName({ repo: 'we', pr: PR, kind: 'fix' });
    const agents = JSON.stringify([{ name: own, status: 'busy', startedAt: HEAD_AT }, { name: we, status: 'busy', startedAt: HEAD_AT }]);
    const facts = readPrFacts(PR, { ...io({ agents }), repo: 'plateauapp/plateau-app' });
    expect(facts.sessions.map(s => s.name)).toEqual([own]);
  });
});

describe('readCardFacts probes', () => {
  it('a failed `claude agents` probe is reported as unknown, not as no sessions', () => {
    const card = readCardFacts('card-none', io({ fail: ['agents'] }));
    expect(card.activeSessionsKnown).toBe(false);
    expect(card.evidence.join(' ')).toContain('claude agents unavailable');
  });
  it('a working probe reports sessions as known', () => {
    expect(readCardFacts('card-none', io()).activeSessionsKnown).toBe(true);
  });
});

describe('cleanText', () => {
  it.each([
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc', 'eyJhbGci'],
    ['{"token": "abcSECRET123"}', 'abcSECRET123'],
    ['{"password":"hunter2hunter2"}', 'hunter2'],
    ['{"private_key":"AAAAB3NzaC1yc2E"}', 'AAAAB3NzaC1yc2E'],
    ['{"access_key": "k-12345-secretvalue"}', 'secretvalue'],
    ['{"token": 123456789}', '123456789'],
    ['token=abcSECRET123 next', 'abcSECRET123'],
    ['xoxb-1234567890-abcdefghij', 'xoxb-1234567890'],
    ['AKIAABCDEFGHIJKLMNOP', 'AKIAABCDEFGHIJ'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdef'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig_abcdef', 'eyJzdWIi'],
  ])('redacts %s', (input, secret) => {
    const out = cleanText(input);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });
  it('strips OSC, CSI and control characters so a log line cannot rewrite the terminal', () => {
    const out = cleanText('before\x1b]52;c;ZXZpbA==\x07mid\x1b[31mred\x1b[0m\rSTUCK\x00end');
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
    expect(out).not.toContain('ZXZpbA');
    expect(out).toContain('before');
    expect(out).toContain('end');
  });
  it('removes bidi overrides that reorder a printed line', () => {
    expect(cleanText('safe‮STUCK⁦x')).toBe('safeSTUCKx');
  });
  it('is bounded', () => { expect(cleanText('x'.repeat(5000)).length).toBeLessThanOrEqual(1201); });
});
