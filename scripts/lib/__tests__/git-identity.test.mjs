/**
 * @file git-identity.test.mjs — the placeholder-author check every surface shares (bootstrap, lane-pool, guard).
 *   Incident: 2026-10-05..20 the global git config said `test` / `test@test.com` and nothing flagged it.
 */
import { describe, it, expect } from 'vitest';
import {
  checkGitIdentity, identityVerdict, parseIdent, readGitIdentity, resolveGitIdentityPlaceholders, BUILTIN_PLACEHOLDERS,
  configHasUserOverride, laneIdentityReport,
} from '../git-identity.mjs';

describe('checkGitIdentity', () => {
  it('flags the exact incident identity', () => {
    const r = checkGitIdentity({ name: 'test', email: 'test@test.com' });
    expect(r.status).toBe('placeholder');
    expect(r.reasons.join(' ')).toMatch(/name "test"/);
  });

  it.each([
    ['foo', 'someone@realcorp.io'],
    ['Real Person', 'anyone@example.com'],
    ['Real Person', 'dev@mail.example.org'],
    ['Real Person', 'me@localhost'],
    ['ROOT', 'admin@realcorp.io'],
    ['Real Person', 'not-an-address'],
    ['  Example  ', 'x@realcorp.io'],
  ])('placeholder: %s <%s>', (name, email) => {
    expect(checkGitIdentity({ name, email }).status).toBe('placeholder');
  });

  it.each([
    [{ name: '', email: 'a@realcorp.io' }],
    [{ name: 'Real Person', email: '' }],
    [{ name: '   ', email: undefined }],
    [{}],
  ])('missing: %j', (ident) => {
    expect(checkGitIdentity(ident).status).toBe('missing');
  });

  it.each([
    ['Ada Lovelace', 'ada@analytical.engine'],
    ['web-everything[bot]', '123+bot@users.noreply.github.com'],
    ['Testa Rossa', 'testa@realcorp.io'],          // contains "test", is not "test"
    ['Real Person', 'someone@contest.com'],       // ends with "test.com" but is not that domain
    ['Real Person', 'bar@realcorp.io'],           // a placeholder NAME as a local part is still a real address
    ['Real Person', 'someone@email.com'],         // mail.com's real provider domain (audit finding)
  ])('ok: %s <%s>', (name, email) => {
    expect(checkGitIdentity({ name, email })).toEqual({ status: 'ok', reasons: [] });
  });
});

describe('identityVerdict — worst of author and committer', () => {
  const real = { name: 'Ada', email: 'ada@analytical.engine' };
  it('a placeholder committer fails an ok author', () => {
    const v = identityVerdict({ author: real, committer: { name: 'test', email: 'test@test.com' } });
    expect(v.status).toBe('placeholder');
    expect(v.detail).toMatch(/^committer:/);
  });
  it('missing outranks placeholder', () => {
    expect(identityVerdict({ author: { name: 'test', email: 'x@test.com' }, committer: { name: '', email: '' } }).status).toBe('missing');
  });
  it('ok names the author, never the email', () => {
    const v = identityVerdict({ author: real, committer: real });
    expect(v).toEqual({ status: 'ok', detail: 'author "Ada" ok' });
  });
});

describe('parseIdent / readGitIdentity', () => {
  it('parses git var output', () => {
    expect(parseIdent('Ada Lovelace <ada@x.io> 1700000000 +0000\n')).toEqual({ name: 'Ada Lovelace', email: 'ada@x.io' });
    expect(parseIdent('garbage')).toEqual({ name: '', email: '' });
  });
  it('git\'s own "identity unknown" refusal reads as missing, never throws', () => {
    const run = () => { const e = new Error('Command failed: git var'); e.stderr = '*** Please tell me who you are.\nfatal: unable to auto-detect email address'; throw e; };
    const id = readGitIdentity('/nowhere', { run });
    expect(id.error).toBeUndefined();
    expect(identityVerdict(id).status).toBe('missing');
  });
  it('any OTHER git failure (timeout, EMFILE) is error, not missing', () => {
    const run = () => { const e = new Error('spawnSync git ETIMEDOUT'); e.code = 'ETIMEDOUT'; throw e; };
    const id = readGitIdentity('/nowhere', { run });
    expect(id.error).toMatch(/ETIMEDOUT/);
    expect(identityVerdict(id).status).toBe('error');
  });
  it('reasons never echo the full address', () => {
    const v = identityVerdict({ author: { name: 'Ada', email: 'you@example.com' }, committer: { name: 'Ada', email: 'you@example.com' } });
    expect(v.status).toBe('placeholder');
    expect(v.detail).not.toMatch(/you@/);
  });
  it('asks git for both author and committer', () => {
    const asked = [];
    const run = (_cmd, args) => { asked.push(args[1]); return 'Ada <ada@x.io> 1 +0000'; };
    readGitIdentity('/r', { run });
    expect(asked).toEqual(['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']);
  });
});

describe('configHasUserOverride / laneIdentityReport (lane-pool status)', () => {
  it('detects a [user] override in a .git/config', () => {
    expect(configHasUserOverride('[core]\n\tbare = false\n[user]\n\tname = test\n')).toBe(true);
    expect(configHasUserOverride('[core]\n\tname = x\n[remote "origin"]\n\turl = u\n')).toBe(false);
    expect(configHasUserOverride('')).toBe(false);
    expect(configHasUserOverride('[author]\n\tname = test\n')).toBe(true);
    expect(configHasUserOverride('[committer]\n\temail = x@test.com\n')).toBe(true);
    expect(configHasUserOverride('[includeIf "gitdir:~/w/"]\n\tpath = id.inc\n')).toBe(true);
    expect(configHasUserOverride('[include]\n\tpath = x\n')).toBe(true);
  });
  const real = { author: { name: 'Ada', email: 'ada@x.io' }, committer: { name: 'Ada', email: 'ada@x.io' } };
  const fake = { author: { name: 'test', email: 'test@test.com' }, committer: { name: 'test', email: 'test@test.com' } };
  const lanes = [1, 2, 3].map((n) => ({ lane: n, dir: `/p/lane-${n}` }));
  it('reads the ambient identity ONCE for lanes with no override', () => {
    const reads = [];
    const r = laneIdentityReport({ lanes, readIn: (d) => { reads.push(d); return fake; }, hasOverride: () => false });
    expect(reads).toEqual(['/p/lane-1']);
    expect(r.status).toBe('placeholder');
    expect(r.bad.map((b) => b.lane)).toEqual([1, 2, 3]);
  });
  it('a lane whose own config overrides to a placeholder is singled out', () => {
    const r = laneIdentityReport({ lanes, readIn: (d) => (d.endsWith('2') ? fake : real), hasOverride: (d) => d.endsWith('2') });
    expect(r.bad.map((b) => b.lane)).toEqual([2]);
  });
  it('an unreadable identity is not reported as a placeholder lane', () => {
    expect(laneIdentityReport({ lanes, readIn: () => ({ ...real, error: 'ETIMEDOUT' }), hasOverride: () => false }).bad).toEqual([]);
  });
  it('all real → ok', () => {
    expect(laneIdentityReport({ lanes, readIn: () => real, hasOverride: () => false })).toEqual({ status: 'ok', bad: [] });
  });
});

describe('resolveGitIdentityPlaceholders — a cascade setting that can only widen the floor', () => {
  const noSettings = () => ({ settings: {} });
  it('defaults to the built-in list, sources standard', () => {
    const r = resolveGitIdentityPlaceholders({ env: {}, readSettings: noSettings });
    expect(r.names).toEqual([...BUILTIN_PLACEHOLDERS.names]);
    expect(r.sources.extraNames).toBe('standard');
  });
  it('a tool block ADDS names/domains and names its source', () => {
    const r = resolveGitIdentityPlaceholders({ env: {}, tool: { extraNames: ['Claude Agent'], extraEmailDomains: ['corp.invalid'] } });
    expect(r.names).toContain('claude agent');
    expect(r.names).toContain('test');                       // floor kept
    expect(r.emailDomains).toContain('corp.invalid');
    expect(r.sources.extraNames).toBe('tool');
    expect(checkGitIdentity({ name: 'Claude Agent', email: 'a@realcorp.io' }, r).status).toBe('placeholder');
  });
  it('an invalid block falls back to the floor (never weakens it)', () => {
    const r = resolveGitIdentityPlaceholders({ env: {}, tool: { extraNames: 'test' } });
    expect(r.names).toEqual([...BUILTIN_PLACEHOLDERS.names]);
  });
  it('env adds names, emails and @domains', () => {
    const r = resolveGitIdentityPlaceholders({ env: { WE_GIT_IDENTITY_EXTRA_PLACEHOLDERS: 'bot, ci@realcorp.io, @realcorp.local' }, readSettings: noSettings });
    expect(r.names).toContain('bot');
    expect(r.emails).toContain('ci@realcorp.io');
    expect(r.emailDomains).toContain('realcorp.local');
    expect(r.sources.extraNames).toBe('env');
  });
  it('a throwing settings read still yields the floor', () => {
    const r = resolveGitIdentityPlaceholders({ env: {}, readSettings: () => { throw new Error('boom'); } });
    expect(r.names).toEqual([...BUILTIN_PLACEHOLDERS.names]);
  });
});
