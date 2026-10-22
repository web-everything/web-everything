/**
 * @file git-identity.test.mjs — the placeholder-author check every surface shares (bootstrap, lane-pool, guard).
 *   Incident: 2026-10-05..20 the global git config said `test` / `test@test.com` and nothing flagged it.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import {
  checkGitIdentity, identityVerdict, parseIdent, readGitIdentity, resolveGitIdentityPlaceholders, BUILTIN_PLACEHOLDERS,
  laneIdentityReport, ensureLaneHooksPath, hookRunnable, invokedAsScript, laneHooksGitArgs,
} from '../git-identity.mjs';

describe('hook repair failures cannot silently disable commit guards', () => {
  const get = ['config', '--show-scope', '--get', 'core.hooksPath'];
  it('repairs the directory Git actually uses, so a previously skipped real hook executes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-hooks-'));
    const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, 'global-config') };
    const run = (args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      writeFileSync(env.GIT_CONFIG_GLOBAL, '');
      run(['init', '-q']);
      mkdirSync(join(dir, '.githooks'));
      writeFileSync(join(dir, '.githooks/pre-commit'), '#!/bin/sh\ntouch hook-ran\n');
      chmodSync(join(dir, '.githooks/pre-commit'), 0o755);
      run(['config', '--local', 'core.hooksPath', '.githooks ']);
      run(['hook', 'run', '--ignore-missing', 'pre-commit']);
      expect(existsSync(join(dir, 'hook-ran'))).toBe(false);
      expect(ensureLaneHooksPath(dir, { run, write: false })).toMatchObject({ status: 'override', was: '.githooks ' });
      expect(run(['config', '--get', 'core.hooksPath'])).toBe('.githooks \n');
      expect(ensureLaneHooksPath(dir, { run, log: () => {} }).status).toBe('set');
      run(['hook', 'run', '--ignore-missing', 'pre-commit']);
      expect(existsSync(join(dir, 'hook-ran'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('refuses a lane whose pre-commit exists but git would ignore (not executable), on every path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-hooks-noexec-'));
    const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, 'global-config') };
    const run = (args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      writeFileSync(env.GIT_CONFIG_GLOBAL, '');
      run(['init', '-q']);
      mkdirSync(join(dir, '.githooks'));
      writeFileSync(join(dir, '.githooks/pre-commit'), '#!/bin/sh\ntouch hook-ran\n');
      chmodSync(join(dir, '.githooks/pre-commit'), 0o644);
      run(['config', '--local', 'core.hooksPath', '.githooks']);
      run(['hook', 'run', '--ignore-missing', 'pre-commit']);
      expect(existsSync(join(dir, 'hook-ran'))).toBe(false);
      for (const write of [false, true]) {
        const logs = [];
        const result = ensureLaneHooksPath(dir, { run, write, log: (l) => logs.push(l) });
        expect(result.status).toBe('error');
        expect(result.detail).toMatch(/not executable/);
        expect(logs.join('\n')).toMatch(/pre-commit guards may NOT run/);
      }
      run(['config', '--local', '--unset', 'core.hooksPath']);
      expect(ensureLaneHooksPath(dir, { run, log: () => {} }).status).toBe('error');
      // A TRACKED hook replaced by a dangling symlink runs nothing either: error, never `skipped`.
      run(['add', '.githooks/pre-commit']);
      rmSync(join(dir, '.githooks/pre-commit'));
      symlinkSync(join(dir, 'nowhere'), join(dir, '.githooks/pre-commit'));
      const dangling = ensureLaneHooksPath(dir, { run, log: () => {} });
      expect(dangling.status).toBe('error');
      expect(dangling.detail).toMatch(/tracked but missing/);
      rmSync(join(dir, '.githooks/pre-commit'));
      run(['rm', '-q', '--cached', '.githooks/pre-commit']);
      expect(ensureLaneHooksPath(dir, { run, log: () => {} }).status).toBe('skipped');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('hookRunnable matches what git runs: executable regular file only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-hook-runnable-'));
    try {
      const file = join(dir, 'pre-commit');
      writeFileSync(file, '#!/bin/sh\n');
      chmodSync(file, 0o644);
      expect(hookRunnable(file)).toBe(false);
      chmodSync(file, 0o755);
      expect(hookRunnable(file)).toBe(true);
      symlinkSync(file, join(dir, 'via-link'));
      expect(hookRunnable(join(dir, 'via-link'))).toBe(true);
      mkdirSync(join(dir, 'a-dir'), { mode: 0o755 });
      expect(hookRunnable(join(dir, 'a-dir'))).toBe(false);
      expect(hookRunnable(join(dir, 'missing'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it.each(['.githooks ', ' .githooks', '.githooks\t', '.githooks\r', '.githooks\n', '.githooks\u2028', '.githooks\u00a0'])('preserves the exact hooks directory %j for reporting and repair', (value) => {
    let effective = value;
    const calls = [];
    const run = (args) => {
      calls.push(args);
      if (args.join(' ') === get.join(' ')) return `local\t${effective}\n`;
      expect(args).toEqual(['config', '--local', '--replace-all', 'core.hooksPath', '.githooks']);
      effective = '.githooks';
      return '';
    };
    expect(ensureLaneHooksPath('/lane', { write: false, exists: () => true, runnable: () => true, run })).toMatchObject({ status: 'override', was: value });
    expect(calls).toHaveLength(1);
    expect(ensureLaneHooksPath('/lane', { exists: () => true, runnable: () => true, run, log: () => {} })).toMatchObject({ status: 'set', was: value });
    expect(effective).toBe('.githooks');
  });
  it('does not falsely verify a repair that still resolves to a whitespace-suffixed directory', () => {
    const result = ensureLaneHooksPath('/lane', {
      exists: () => true, runnable: () => true, log: () => {},
      run: (args) => args.join(' ') === get.join(' ') ? 'worktree\t.githooks \n' : '',
    });
    expect(result).toMatchObject({ status: 'override', was: '.githooks ', scope: 'worktree' });
  });
  it('replaces all duplicate local values before verifying the effective value', () => {
    let values = ['/dev/null', '/other-hooks'];
    const result = ensureLaneHooksPath('/lane', {
      exists: () => true, runnable: () => true,
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
      exists: () => true, runnable: () => true,
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
      write, exists: () => true, runnable: () => true,
      run: () => { calls++; throw Object.assign(new Error('git config timed out'), { code: 'ETIMEDOUT' }); },
      log: (line) => logs.push(line),
    });
    expect(result.status).toBe('error');
    expect(calls).toBe(1);
    expect(logs.join('\n')).toMatch(/git config timed out/);
  });
  it('only an absent key (git exit 1) is treated as unset', () => {
    const result = ensureLaneHooksPath('/lane', {
      write: false, exists: () => true, runnable: () => true,
      run: () => { throw Object.assign(new Error('key absent'), { status: 1 }); },
    });
    expect(result).toMatchObject({ status: 'unset', was: null });
  });
  it('a failed verification read cannot report successful repair', () => {
    let reads = 0;
    const logs = [];
    const result = ensureLaneHooksPath('/lane', {
      exists: () => true, runnable: () => true,
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

describe('hooks-path verification never runs lane-controlled git config commands (red-team finding, PR #5775)', () => {
  // The DEFAULT runner on purpose: the verification's own git calls are the ones under test.
  const lanes = (fn) => {
    const base = mkdtempSync(join(tmpdir(), 'identity-hooks-hardening-'));
    const marker = join(base, 'marker-ran');
    const script = join(base, 'marker.sh');
    writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> "${marker}"\n`);
    chmodSync(script, 0o755);
    writeFileSync(join(base, 'global-config'), '');
    vi.stubEnv('HOME', base);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(base, 'global-config'));
    const make = (name, poisoned, setup) => {
      const dir = join(base, name);
      mkdirSync(dir);
      const run = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      run(['init', '-q']);
      writeFileSync(join(dir, 'file'), 'x\n');
      run(['add', 'file']);
      setup(dir, run);
      if (poisoned) {
        run(['config', '--local', 'core.fsmonitor', script]);
        run(['config', '--local', 'diff.external', script]);
        run(['config', '--local', 'core.pager', script]);
      }
      return dir;
    };
    try {
      fn({ marker, make });
    } finally {
      vi.unstubAllEnvs();
      rmSync(base, { recursive: true, force: true });
    }
  };
  const hook = (dir, mode = 0o755) => {
    mkdirSync(join(dir, '.githooks'), { recursive: true });
    writeFileSync(join(dir, '.githooks/pre-commit'), '#!/bin/sh\n');
    chmodSync(join(dir, '.githooks/pre-commit'), mode);
  };
  const scenarios = {
    'tracked but missing hook (ls-files)': (dir, run) => { hook(dir); run(['add', '.githooks/pre-commit']); rmSync(join(dir, '.githooks/pre-commit')); },
    'untracked, absent hook (ls-files)': () => {},
    'hook present, hooksPath unset (config read + write)': (dir) => hook(dir),
    'hook present, worktree override (config read + write + unset)': (dir, run) => {
      hook(dir);
      run(['config', 'extensions.worktreeConfig', 'true']);
      run(['config', '--worktree', 'core.hooksPath', '/dev/null']);
    },
  };
  it('a sparse index whose .githooks tree is missing never lazy-fetches through a lane-set uploadpack', () => {
    lanes(({ marker, make }) => {
      const lane = make('sparse', false, (dir, run) => {
        hook(dir);
        mkdirSync(join(dir, 'keep'));
        writeFileSync(join(dir, 'keep/file'), 'k\n');
        run(['add', '.githooks/pre-commit', 'keep/file']);
        run(['-c', 'user.name=Fixture', '-c', 'user.email=f@realcorp.io', 'commit', '-q', '-m', 'v1']);
        run(['sparse-checkout', 'set', '--cone', '--sparse-index', 'keep']);
        const tree = run(['rev-parse', 'HEAD:.githooks']).trim();
        rmSync(join(dir, '.git/objects', tree.slice(0, 2), tree.slice(2)));
        run(['config', 'core.repositoryformatversion', '1']);
        run(['config', 'extensions.partialClone', 'origin']);
        run(['config', 'remote.origin.url', dir]);
        run(['config', 'remote.origin.promisor', 'true']);
        run(['config', 'remote.origin.uploadpack', `echo uploadpack >> "${marker}"; git-upload-pack`]);
      });
      expect(existsSync(join(lane, '.githooks/pre-commit'))).toBe(false);
      for (const write of [false, true]) expect(ensureLaneHooksPath(lane, { write, log: () => {} }).status).toBe('error');
      expect(existsSync(marker) ? readFileSync(marker, 'utf8') : '').toBe('');
    });
  });
  it('pins every lane-hardening key except the core.hooksPath under test', () => {
    const args = laneHooksGitArgs(['ls-files', '--error-unmatch', '--', '.githooks/pre-commit']);
    expect(args).toEqual(expect.arrayContaining(['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'protocol.allow=never']));
    expect(args.some((a) => a.startsWith('core.hooksPath='))).toBe(false);
    expect(args.slice(-4)).toEqual(['ls-files', '--error-unmatch', '--', '.githooks/pre-commit']);
  });
  it.each(Object.keys(scenarios))('%s: same verdict as a clean lane, and the marker never runs', (name) => {
    lanes(({ marker, make }) => {
      const clean = make('clean', false, scenarios[name]);
      const poisoned = make('poisoned', true, scenarios[name]);
      const strip = (r) => ({ ...r, detail: r.detail?.replaceAll(poisoned, clean) });
      for (const write of [false, true, false]) {
        const want = ensureLaneHooksPath(clean, { write, log: () => {} });
        expect(strip(ensureLaneHooksPath(poisoned, { write, log: () => {} }))).toEqual(want);
      }
      expect(readGitIdentity(poisoned)).toEqual(readGitIdentity(clean));
      expect(existsSync(marker) ? readFileSync(marker, 'utf8') : '').toBe('');
    });
  });
});

describe('invokedAsScript — entry scripts never silently skip main()', () => {
  it('matches through a space, a symlink in either direction, and a relative argv[1]; rejects another file', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'identity-entry-')));
    try {
      const real = join(base, 'has space', 'guard.mjs');
      mkdirSync(dirname(real));
      writeFileSync(real, '');
      symlinkSync(join(base, 'has space'), join(base, 'link'), 'dir');
      const viaLink = join(base, 'link', 'guard.mjs');
      expect(invokedAsScript(real, pathToFileURL(real).href)).toBe(true);
      expect(invokedAsScript(viaLink, pathToFileURL(real).href)).toBe(true);
      expect(invokedAsScript(real, pathToFileURL(viaLink).href)).toBe(true);
      expect(invokedAsScript(relative(process.cwd(), viaLink), pathToFileURL(real).href)).toBe(true);
      writeFileSync(join(base, 'other.mjs'), '');
      expect(invokedAsScript(join(base, 'other.mjs'), pathToFileURL(real).href)).toBe(false);
      expect(invokedAsScript(undefined, pathToFileURL(real).href)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
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
