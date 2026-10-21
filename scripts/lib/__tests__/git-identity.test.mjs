/**
 * @file git-identity.test.mjs — the placeholder-author check every surface shares (bootstrap, lane-pool, guard).
 *   Incident: 2026-10-05..20 the global git config said `test` / `test@test.com` and nothing flagged it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  checkGitIdentity, identityVerdict, parseIdent, readGitIdentity, resolveGitIdentityPlaceholders, BUILTIN_PLACEHOLDERS,
  laneIdentityReport, ensureLaneHooksPath,
} from '../git-identity.mjs';

describe('hook repair failures cannot silently disable commit guards', () => {
  const get = ['config', '--show-scope', '--get', 'core.hooksPath'];
  it('replaces all duplicate local values before verifying the effective value', () => {
    let values = ['/dev/null', '/other-hooks'];
    const result = ensureLaneHooksPath('/lane', {
      exists: () => true,
      run: (args) => {
        if (args.join(' ') === get.join(' ')) return `local\t${values.at(-1)}\n`;
        if (args.join(' ') !== 'config --local --replace-all core.hooksPath .githooks') {
          throw new Error('cannot overwrite multiple values with a single value');
        }
        values = ['.githooks'];
        return '';
      },
    });
    expect(result.status).toBe('set');
    expect(values).toEqual(['.githooks']);
  });
  it('logs write errors with the lane, failure and guard consequence', () => {
    const logs = [];
    const result = ensureLaneHooksPath('/lane', {
      exists: () => true,
      run: (args) => {
        if (args.join(' ') === get.join(' ')) return 'local\t/dev/null\n';
        throw new Error('could not lock config file\nmore detail');
      },
      log: (line) => logs.push(line),
    });
    expect(result).toMatchObject({ status: 'error', detail: 'could not lock config file' });
    expect(logs.join('\n')).toMatch(/\/lane:.*could not lock config file.*pre-commit guards/);
  });
  it.each([true, false])('reports a failed read as error (write=%s)', (write) => {
    const logs = [];
    let calls = 0;
    const result = ensureLaneHooksPath('/lane', {
      write, exists: () => true,
      run: () => { calls++; throw Object.assign(new Error('git config timed out'), { code: 'ETIMEDOUT' }); },
      log: (line) => logs.push(line),
    });
    expect(result.status).toBe('error');
    expect(calls).toBe(1);
    expect(logs.join('\n')).toMatch(/git config timed out/);
  });
  it('only an absent key (git exit 1) is treated as unset', () => {
    const result = ensureLaneHooksPath('/lane', {
      write: false, exists: () => true,
      run: () => { throw Object.assign(new Error('key absent'), { status: 1 }); },
    });
    expect(result).toMatchObject({ status: 'unset', was: null });
  });
  it('a failed verification read cannot report successful repair', () => {
    let reads = 0;
    const logs = [];
    const result = ensureLaneHooksPath('/lane', {
      exists: () => true,
      run: (args) => {
        if (args.join(' ') !== get.join(' ')) return '';
        if (++reads === 1) return 'local\t/dev/null\n';
        throw Object.assign(new Error('cannot read repaired config'), { status: 128 });
      },
      log: (line) => logs.push(line),
    });
    expect(result.status).toBe('error');
    expect(logs.join('\n')).toMatch(/cannot read repaired config/);
  });
  it('still returns an error if its logger throws', () => {
    expect(ensureLaneHooksPath('/lane', {
      exists: () => { throw new Error('unreadable hooks'); },
      log: () => { throw new Error('logger failed'); },
    })).toMatchObject({ status: 'error', detail: 'unreadable hooks' });
  });
  // Exercise the actual shared provision/refresh/acquire function without starting the pool CLI or writing Git state.
  const pool = readFileSync(resolve(process.cwd(), 'scripts/lane-pool.mjs'), 'utf8');
  const start = pool.indexOf('function writeLaneEnv(');
  const body = pool.slice(start, pool.indexOf('\n}', start) + 2);
  it.each(['error', 'override', 'unset'])('the pool refuses a lane when hook repair returns %s', (status) => {
    let writes = 0;
    const invoke = () => runInNewContext(`${body}\nwriteLaneEnv({}, 7);`, {
      ensureLaneHooksPath: () => ({ status, detail: 'repair failed' }),
      laneDir: () => '/lane', log: () => {},
      laneEnvLocal: () => 'PORT=1234',
      writeFileSync: () => { writes++; }, join: (...parts) => parts.join('/'),
    });
    expect(invoke).toThrow(/core\.hooksPath.*pre-commit guards/);
    expect(writes).toBe(0);
  });
  it.each(['ok', 'set', 'skipped'])('the pool still proceeds when hook repair returns %s', (status) => {
    let writes = 0;
    runInNewContext(`${body}\nwriteLaneEnv({}, 7);`, {
      ensureLaneHooksPath: () => ({ status }),
      laneDir: () => '/lane', log: () => {},
      laneEnvLocal: () => 'PORT=1234',
      writeFileSync: () => { writes++; }, join: (...parts) => parts.join('/'),
    });
    expect(writes).toBe(1);
  });
});

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

describe('laneIdentityReport (lane-pool status) — git resolves each lane', () => {
  const real = { author: { name: 'Ada', email: 'ada@x.io' }, committer: { name: 'Ada', email: 'ada@x.io' } };
  const fake = { author: { name: 'test', email: 'test@test.com' }, committer: { name: 'test', email: 'test@test.com' } };
  const lanes = [1, 2, 3].map((n) => ({ lane: n, dir: `/p/lane-${n}` }));
  it('asks git in EVERY lane (no config-file parsing to fool)', () => {
    const reads = [];
    const r = laneIdentityReport({ lanes, readIn: (d) => { reads.push(d); return fake; } });
    expect(reads).toEqual(['/p/lane-1', '/p/lane-2', '/p/lane-3']);
    expect(r.status).toBe('placeholder');
    expect(r.bad.map((b) => b.lane)).toEqual([1, 2, 3]);
  });
  it('a lane whose own config resolves to a placeholder is singled out', () => {
    const r = laneIdentityReport({ lanes, readIn: (d) => (d.endsWith('2') ? fake : real) });
    expect(r.bad.map((b) => b.lane)).toEqual([2]);
  });
  it('an unreadable identity is not reported as a placeholder lane', () => {
    expect(laneIdentityReport({ lanes, readIn: () => ({ ...real, error: 'ETIMEDOUT' }) }).bad).toEqual([]);
  });
  it('all real → ok', () => {
    expect(laneIdentityReport({ lanes, readIn: () => real })).toEqual({ status: 'ok', bad: [] });
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
  it.each([
    [{ extraNames: 'test' }],
    [{ extraNames: { nested: ['bad'] } }],          // audit finding: a nested object used to slip through
    [{ extraNames: ['ok', 7] }],
    [{ extraNames: [''] }],
    [{ extraEmailDomains: [['x']] }],
  ])('an invalid block %j is ignored with a warning; the floor still applies', (tool) => {
    const warns = [];
    const r = resolveGitIdentityPlaceholders({ env: {}, tool, warn: (l) => warns.push(l) });
    expect(r.names).toEqual([...BUILTIN_PLACEHOLDERS.names]);
    expect(r.emailDomains).toEqual([...BUILTIN_PLACEHOLDERS.emailDomains]);
    expect(warns.join(' ')).toMatch(/ignored invalid gitIdentityPlaceholders/);
    expect(checkGitIdentity({ name: 'test', email: 'a@realcorp.io' }, r).status).toBe('placeholder');
  });
  it('env adds names, emails and @domains', () => {
    const r = resolveGitIdentityPlaceholders({ env: { WE_GIT_IDENTITY_EXTRA_PLACEHOLDERS: 'bot, ci@realcorp.io, @realcorp.local' }, readSettings: noSettings });
    expect(r.names).toContain('bot');
    expect(r.emails).toContain('ci@realcorp.io');
    expect(r.emailDomains).toContain('realcorp.local');
    expect(r.sources.extraNames).toBe('env');
  });
  it('a throwing settings read still yields the floor', () => {
    const r = resolveGitIdentityPlaceholders({ env: {}, readSettings: () => { throw new Error('boom'); }, warn: () => {} });
    expect(r.names).toEqual([...BUILTIN_PLACEHOLDERS.names]);
  });
});
