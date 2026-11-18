// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runConfinedAgyBuild } from '../agy-confined-build.mjs';
import { deriveAgyFixAdmission, isAgyFixPathAllowed } from '../agy-fix-admission.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const git = (dir, ...args) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', dir, ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const commit = dir => { git(dir, 'add', '.'); git(dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'); };
const tool = (name, parameters, extra = {}) => ({ event: 'step_update', step_update: {
  step_type: 'tool', step_index: 1, state: 'DONE', tool_name: name, tool_info: { parameters }, ...extra,
} });
const finish = { event: 'result', result: { status: 'SUCCESS', response: 'done' } };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'we-agy-build-test-'));
  roots.push(root);
  const lane = join(root, 'lane');
  mkdirSync(join(lane, 'docs'), { recursive: true });
  git(lane, 'init', '-q');
  writeFileSync(join(lane, 'docs/a.md'), 'before\n');
  writeFileSync(join(lane, 'outside.txt'), 'original\n');
  commit(lane);
  let clone;
  const commands = [];
  const execCalls = [];
  const spawnAgy = vi.fn();
  const log = vi.fn();
  const run = async (act = () => {}, options = {}) => {
    spawnAgy.mockImplementation(async args => {
      clone = args.dir;
      expect(clone.startsWith(`${lane}/`)).toBe(false);
      expect(readFileSync(join(lane, 'docs/a.md'), 'utf8')).toBe(options.laneContent ?? 'before\n');
      await act(args.dir, args);
      const events = options.transcript ?? [
        tool('write_to_file', { TargetFile: join(args.dir, 'docs/a.md'), CodeContent: 'after\n' }), finish,
      ];
      const stdout = events.map(e => JSON.stringify(e)).join('\n');
      if (!options.missingTranscript) writeFileSync(args.logFile, options.forgedTranscript ?? stdout);
      if (options.spawnError) throw new Error('spawn failed');
      return { code: 0, stdout, ...options.outcome };
    });
    return runConfinedAgyBuild({ task: 'repair', laneDir: lane, kind: 'doc-fix', size: 1, scope: ['docs'],
      ...options.input, deps: {
        env: options.env ?? {}, log, spawnAgy: options.production ? undefined : spawnAgy,
        platform: options.platform ?? 'unsupported-test-platform', sandboxExists: () => options.sandboxExists ?? false,
        mkTempDir: prefix => { clone = mkdtempSync(prefix); roots.push(clone); return clone; },
        readFile: p => {
          if (p.endsWith('settings/agy-build.json')) {
            if (options.settingsError) throw new Error('unreadable');
            return options.settingsText ?? JSON.stringify(options.settings ?? { allowedKinds: ['doc-fix', 'test-fix'], maxSize: 1 });
          }
          if (options.unreadableTranscript) throw new Error('unreadable transcript');
          return readFileSync(p, 'utf8');
        },
        exec: (bin, args, opts) => {
          commands.push(args);
          execCalls.push({ bin, args, opts });
          if (options.raw !== undefined && args.includes('--raw')) return options.raw;
          try { return execFileSync(bin, args, opts); }
          catch (e) { if (opts.diffExit && e.status === 1) return String(e.stdout); throw e; }
        },
      } });
  };
  return { root, lane, run, spawnAgy, commands, execCalls, log, clone: () => clone };
}

describe('agy build fail-closed admission', () => {
  it.each([
    { platform: 'linux', sandboxExists: true }, { platform: 'darwin', sandboxExists: false },
  ])('refuses production without macOS sandbox-exec, leaving lane and host targets unchanged (%j)', async availability => {
    const f = fixture();
    const hostTarget = join(f.root, 'host-data.txt');
    writeFileSync(hostTarget, 'valuable untracked host data\n');
    const attemptOutsideWrite = vi.fn(() => {
      writeFileSync(join(f.lane, 'outside.txt'), 'destroyed\n');
      writeFileSync(hostTarget, 'destroyed\n');
    });
    const result = await f.run(attemptOutsideWrite, { production: true, ...availability });
    expect(result).toMatchObject({ status: 'refused', applied: [] });
    expect(result.reasons.join(' ')).toContain('requires macOS sandbox-exec');
    expect(f.spawnAgy).not.toHaveBeenCalled();
    expect(attemptOutsideWrite).not.toHaveBeenCalled();
    expect(f.commands).toEqual([]);
    expect(f.clone()).toBeUndefined();
    expect(readFileSync(join(f.lane, 'outside.txt'), 'utf8')).toBe('original\n');
    expect(readFileSync(hostTarget, 'utf8')).toBe('valuable untracked host data\n');
  });
  it.each([
    ['doc-fix', 2], ['test-fix', 2], ['doc-fix', 3], ['test-fix', 3], ['feature', 1],
  ])('admits bounded allowed kind OR bounded size (%s, %s)', async (kind, size) => {
    const f = fixture();
    expect(await f.run(undefined, { input: { kind, size } })).toMatchObject({ status: 'ok', applied: [] });
    expect(f.spawnAgy).toHaveBeenCalledOnce();
  });
  it.each([
    { kind: 'feature', size: 2 }, { kind: 'doc-fix', size: 4 }, { kind: 'test-fix', size: 4 },
    { kind: undefined }, { size: undefined }, { size: '1' }, { size: Infinity },
    { size: NaN }, { scope: undefined }, { scope: [] }, { scope: ['/docs'] },
    { scope: ['docs/../outside.txt'] }, { scope: ['.git'] }, { scope: ['**'] },
    { scope: Array.from({ length: 21 }, (_, i) => `docs/${i}.md`) },
  ])('refuses missing, oversized or unsafe admission %j without launching', async input => {
    const f = fixture();
    const r = await f.run(undefined, { input });
    expect(r).toMatchObject({ status: 'refused', applied: [] });
    expect(r.reasons.join(' ')).toContain('provider');
    expect(f.spawnAgy).not.toHaveBeenCalled();
  });
  it.each([{ settingsError: true }, { settingsText: '{' }, { settingsText: 'null' },
    { settings: { maxSize: '2' } }, { env: { WE_AGY_BUILD_MAX_SIZE: 'invalid' } },
    ...['invalid', '', '0', '-1', '1.5', 'NaN', 'Infinity'].map(value => ({ env: { WE_AGY_BUILD_KIND_MAX_SIZE: value } })),
    ...['3', 0, -1, 1.5, null].map(kindMaxSize => ({ settings: { kindMaxSize } })),
  ])('refuses unreadable or malformed settings/env %j', async options => {
    const f = fixture();
    expect((await f.run(undefined, options)).status).toBe('refused');
    expect(f.spawnAgy).not.toHaveBeenCalled();
  });
  it('allows explicit setting widening and env overrides above settings', async () => {
    const f = fixture();
    expect((await f.run(undefined, { input: { kind: 'feature', size: 2 },
      settings: { allowedKinds: ['feature'], maxSize: 0 } })).status).toBe('ok');
    expect((await f.run(undefined, { input: { kind: 'feature', size: 2 },
      env: { WE_AGY_BUILD_KINDS: 'feature', WE_AGY_BUILD_MAX_SIZE: '2' } })).status).toBe('ok');
  });
  it('env narrowing wins over widened settings', async () => {
    const f = fixture();
    expect((await f.run(undefined, { input: { kind: 'feature', size: 2 },
      settings: { allowedKinds: ['feature'], maxSize: 10 },
      env: { WE_AGY_BUILD_KINDS: 'doc-fix,test-fix', WE_AGY_BUILD_MAX_SIZE: '1' } })).status).toBe('refused');
  });
  it('admits twenty scope entries independently of size', async () => {
    const f = fixture();
    expect((await f.run(undefined, { input: { scope: Array.from({ length: 20 }, (_, i) => `docs/${i}.md`) } })).status).toBe('ok');
    expect(f.spawnAgy).toHaveBeenCalledOnce();
  });
  it.each([
    [{ kindMaxSize: 3 }, '4', 4, 'ok'],
    [{ kindMaxSize: 4 }, '3', 4, 'refused'],
    [{ kindMaxSize: 4 }, undefined, 4, 'ok'],
  ])('resolves kindMaxSize env above settings: %j, %s', async (settings, override, size, status) => {
    const f = fixture();
    expect((await f.run(undefined, { settings, input: { size },
      env: override === undefined ? {} : { WE_AGY_BUILD_KIND_MAX_SIZE: override } })).status).toBe(status);
    expect(f.spawnAgy).toHaveBeenCalledTimes(status === 'ok' ? 1 : 0);
    expect(f.log.mock.calls.flat().join(' ')).toContain(`kindMaxSize=${override ?? settings.kindMaxSize}`);
    expect(f.log.mock.calls.flat().join(' ')).toContain(override === undefined ? '(tool)' : '(env)');
  });
});

describe('launcher-owned atomic application', () => {
  it.each([false, true])('voids policy-cascade.mjs under scripts/lib scope before apply (tracked=%s)', async tracked => {
    const f = fixture();
    const path = 'scripts/lib/policy-cascade.mjs';
    if (tracked) {
      mkdirSync(dirname(join(f.lane, path)), { recursive: true });
      writeFileSync(join(f.lane, path), 'before\n');
      commit(f.lane);
    }
    expect(await f.run(dir => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), 'changed\n');
    }, { input: { kind: 'fix', scope: ['scripts/lib'] } })).toMatchObject({ status: 'voided', applied: [] });
    expect(f.spawnAgy).toHaveBeenCalledOnce();
    expect(f.commands.some(a => a.includes('apply'))).toBe(false);
    expect(git(f.lane, 'status', '--porcelain')).toBe('');
  });
  it.each([
    ...['docs/agent', 'docs/agent/testing.md', 'scripts/hooks', 'scripts/hooks/check.mjs',
      'scripts/lib/review-policy.mjs', 'scripts/lib/new-policy.mjs', 'scripts/lib/policy-cascade.mjs',
      'scripts/lib/critical-work.mjs', 'scripts/settings/agy-build.json', '.github', '.github/CODEOWNERS',
      'AGENTS.md', '.git/config', '.GIT/config', '.github/workflows/ci.yml', 'package.json',
      'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'npm-shrinkwrap.json',
      'Cargo.lock', 'Gemfile.lock', 'docs/.github/workflows/x.yml', 'tests/deep/pnpm-lock.yaml',
      'docs/scripts/settings/config.json', 'scripts/settings', 'scripts', 'nested/package.json',
      '.gitattributes', 'docs/.gitattributes', '../escape.md', '/absolute.md', 'bad\\path', 'bad:repo',
      'bad//path', 'bad/./path', 'bad\x00path', 'bad*glob', 'bad?glob', 'bad[glob]', 'bad{glob}']
      .map(path => ['fix', path]),
    ['doc-fix', 'scripts/operations/fix-run.mjs'], ['doc-fix', 'src/_data/blocks.json'],
    ['test-fix', 'src'], ['test-fix', 'src/main.ts'], ['test-fix', '__fixtures__/data.json'],
  ].map(([kind, path]) => [`${kind} ${JSON.stringify(path)}`, kind, path]))(
    'refuses admission denylist entry %s as an applied path too', async (_label, kind, path) => {
    expect(deriveAgyFixAdmission({ taskKind: kind, size: 1, scope: [path] }, { scope: [path] })).toBeNull();
    expect(isAgyFixPathAllowed(path, kind)).toBe(false);
    const f = fixture();
    // A permitted ancestor keeps valid paths in scope, so containment cannot mask a policy gap.
    const ancestor = path.split('/')[0];
    const scope = /^[^\x00-\x1f\x7f\\*?\[\]{}:]+$/.test(ancestor)
      && ancestor && ancestor !== '..' && ancestor.toLowerCase() !== '.git' ? ancestor : 'docs';
    const result = await f.run(undefined, { input: { kind, scope: [scope] },
      raw: `:100644 100644 ${'0'.repeat(40)} ${'1'.repeat(40)} M\0${path}\0` });
    expect(result).toMatchObject({ status: 'voided', applied: [] });
    expect(result.reasons).toContain('unsafe or out-of-scope changed path');
    expect(f.spawnAgy).toHaveBeenCalledOnce();
    expect(f.commands.some(a => a.includes('apply'))).toBe(false);
    expect(git(f.lane, 'status', '--porcelain')).toBe('');
  });
  it.each([false, true])('voids critical docs/agent/testing.md under docs scope atomically (tracked=%s)', async tracked => {
    const f = fixture();
    const path = 'docs/agent/testing.md';
    if (tracked) {
      mkdirSync(dirname(join(f.lane, path)), { recursive: true });
      writeFileSync(join(f.lane, path), 'before\n');
      commit(f.lane);
    }
    expect(await f.run(dir => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), 'changed\n');
      writeFileSync(join(dir, 'docs/a.md'), 'after\n');
    })).toMatchObject({ status: 'voided', applied: [] });
    expect(f.commands.some(a => a.includes('apply'))).toBe(false);
    expect(git(f.lane, 'status', '--porcelain')).toBe('');
  });
  it.each([false, true])('applies non-critical docs/guide.md under docs scope (tracked=%s)', async tracked => {
    const f = fixture();
    if (tracked) {
      writeFileSync(join(f.lane, 'docs/guide.md'), 'before\n');
      commit(f.lane);
    }
    expect(await f.run(dir => writeFileSync(join(dir, 'docs/guide.md'), 'after\n')))
      .toMatchObject({ status: 'ok', applied: ['docs/guide.md'] });
    expect(readFileSync(join(f.lane, 'docs/guide.md'), 'utf8')).toBe('after\n');
  });
  it('pins every post-run clone git call, including untracked diff generation', async () => {
    const f = fixture();
    let post;
    expect((await f.run(dir => {
      writeFileSync(join(dir, 'docs/a.md'), 'after\n');
      writeFileSync(join(dir, 'docs/guide.md'), 'new\n');
      post = f.execCalls.length;
    })).status).toBe('ok');
    const calls = f.execCalls.slice(post).filter(c => c.opts.env.GIT_WORK_TREE === f.clone());
    expect(calls).toHaveLength(5);
    for (const { args, opts } of calls) {
      expect(opts.env).toMatchObject({ GIT_DIR: join(f.clone(), '.git'), GIT_COMMON_DIR: join(f.clone(), '.git'),
        GIT_WORK_TREE: f.clone(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_NO_REPLACE_OBJECTS: '1', GIT_ALTERNATE_OBJECT_DIRECTORIES: '' });
      expect(args).toEqual(expect.arrayContaining(['core.attributesFile=/dev/null', 'core.fsmonitor=false',
        'core.hooksPath=/dev/null', 'core.pager=cat', 'diff.external=']));
      if (args.includes('diff')) expect(args).toEqual(expect.arrayContaining(['--no-ext-diff', '--no-textconv']));
    }
  });
  it('applies an in-scope hunk and an untracked text file, without staging or committing', async () => {
    const f = fixture();
    const head = git(f.lane, 'rev-parse', 'HEAD');
    const r = await f.run(dir => {
      writeFileSync(join(dir, 'docs/a.md'), 'after\n');
      writeFileSync(join(dir, 'docs/new.md'), 'new text without newline');
    });
    expect(r).toMatchObject({ status: 'ok', applied: ['docs/a.md', 'docs/new.md'], finalMessage: 'done', stdout: expect.any(String) });
    expect(readFileSync(join(f.lane, 'docs/a.md'), 'utf8')).toBe('after\n');
    expect(readFileSync(join(f.lane, 'docs/new.md'), 'utf8')).toBe('new text without newline');
    expect(git(f.lane, 'diff', '--cached')).toBe('');
    expect(git(f.lane, 'rev-parse', 'HEAD')).toBe(head);
    expect(existsSync(f.clone())).toBe(false);
    expect(f.commands.find(a => a.includes('clone'))).toEqual(expect.arrayContaining(['--no-hardlinks', '--template=']));
    for (const args of f.commands) expect(args.slice(0, 4)).toEqual(['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']);
    expect(f.commands.some(a => a.includes('--index'))).toBe(false);
    expect(f.commands.find(a => a.includes('apply'))).toContain('--include=docs/*');
  });
  it.each([
    ['test-fix', 'tests', 'tests/package.json'],
    ['doc-fix', 'docs', 'docs/.github/workflows/x.yml'],
    ['doc-fix', 'docs', 'docs/deep/pnpm-lock.yaml'],
    ['test-fix', 'tests', 'tests/deep/bun.lock'],
    ['doc-fix', 'docs', 'docs/scripts/settings/config.json'],
    ['doc-fix', 'notes.md', 'notes.md/code.js'],
    ['test-fix', 'sample.test.ts', 'sample.test.ts/code.js'],
  ])('voids %s scope %s applying forbidden or misclassified %s atomically', async (kind, scope, path) => {
    for (const tracked of [false, true]) {
      const f = fixture();
      if (tracked) {
        mkdirSync(dirname(join(f.lane, path)), { recursive: true });
        writeFileSync(join(f.lane, path), 'before\n');
        commit(f.lane);
      }
      const result = await f.run(dir => {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), 'changed\n');
        if (scope === 'docs') writeFileSync(join(dir, 'docs/a.md'), 'after\n');
      }, { input: { kind, scope: [scope] } });
      expect(result).toMatchObject({ status: 'voided', applied: [] });
      expect(git(f.lane, 'status', '--porcelain')).toBe('');
      expect(f.commands.some(a => a.includes('apply'))).toBe(false);
    }
  });
  it('voids an out-of-scope write and applies NOTHING, including the in-scope hunk', async () => {
    const f = fixture();
    expect((await f.run(dir => {
      writeFileSync(join(dir, 'docs/a.md'), 'after\n');
      writeFileSync(join(dir, 'outside.txt'), 'changed\n');
    })).status).toBe('voided');
    expect(git(f.lane, 'status', '--porcelain')).toBe('');
    expect(f.commands.some(a => a.includes('apply'))).toBe(false);
  });
  it('voids out-of-scope untracked additions before applying an in-scope hunk', async () => {
    const f = fixture();
    expect((await f.run(dir => {
      writeFileSync(join(dir, 'docs/a.md'), 'after\n');
      writeFileSync(join(dir, 'new.txt'), 'outside\n');
    })).status).toBe('voided');
    expect(git(f.lane, 'status', '--porcelain')).toBe('');
  });
  it.each(['.git/config', '.git/commondir', '.git/HEAD', '.git/info/attributes', '.git/info/exclude',
    '.git/objects/info/alternates', '.git/shallow', '.git/worktrees/evil/gitdir', '.git/modules/evil/config',
    '.git/refs/replace/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '.git/hooks/pre-commit', '.git/hooks/nested/hook',
  ])('voids planted %s without ANY post-run git', async p => {
    const f = fixture();
    let post;
    expect((await f.run(dir => {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), p.endsWith('attributes') ? '* filter=attacker\n' : 'planted\n');
      post = f.commands.length;
    })).status).toBe('voided');
    expect(f.commands.slice(post)).toEqual([]);
    expect(git(f.lane, 'status', '--porcelain')).toBe('');
  });
  it.each(['symlink', 'gitfile', 'missing'])('voids .git replaced with %s without ANY post-run git', async type => {
    const f = fixture();
    let post;
    expect(await f.run(dir => {
      renameSync(join(dir, '.git'), join(dir, '.git-saved'));
      if (type === 'symlink') symlinkSync('.git-saved', join(dir, '.git'));
      if (type === 'gitfile') writeFileSync(join(dir, '.git'), 'gitdir: .git-saved\n');
      post = f.commands.length;
    })).toMatchObject({ status: 'voided', applied: [] });
    expect(f.commands.slice(post)).toEqual([]);
  });
  it('voids a redirected control parent without ANY post-run git', async () => {
    const f = fixture();
    let post;
    expect(await f.run(dir => {
      mkdirSync(join(dir, '.git/info'), { recursive: true }); // --template= leaves no info dir
      renameSync(join(dir, '.git/info'), join(dir, '.git/info-saved'));
      symlinkSync('info-saved', join(dir, '.git/info'));
      post = f.commands.length;
    })).toMatchObject({ status: 'voided', applied: [] });
    // Only git aimed at the attacker-writable clone is forbidden; the trusted lane's own snapshot git is fine.
    expect(f.commands.slice(post).filter(a => a.some(x => String(x).startsWith(f.clone())))).toEqual([]);
  });
  it('refuses a committed symlink out of the clone before launching', async () => {
    const f = fixture();
    symlinkSync(f.root, join(f.lane, 'docs/escape'));
    commit(f.lane);
    expect((await f.run()).status).toBe('refused');
    expect(f.spawnAgy).not.toHaveBeenCalled();
    expect(existsSync(f.clone())).toBe(false);
  });
  it.each([['outside', dir => symlinkSync('/dev/null', join(dir, 'docs/link'))],
    ['inside', dir => symlinkSync('a.md', join(dir, 'docs/link'))],
    ['tracked', dir => { rmSync(join(dir, 'docs/a.md')); symlinkSync('../outside.txt', join(dir, 'docs/a.md')); }],
  ])('rejects %s symlink creation', async (_label, act) => {
    const f = fixture();
    expect((await f.run(act)).status).toBe('voided');
    expect(git(f.lane, 'status', '--porcelain')).toBe('');
  });
  it('rejects executable mode changes', async () => {
    const f = fixture();
    expect((await f.run(dir => chmodSync(join(dir, 'docs/a.md'), 0o755))).status).toBe('voided');
    expect(lstatSync(join(f.lane, 'docs/a.md')).mode & 0o111).toBe(0);
  });
  it('rejects a submodule entry', async () => {
    const f = fixture();
    expect((await f.run(dir => {
      mkdirSync(join(dir, 'docs/sub'));
      git(dir, 'update-index', '--add', '--cacheinfo', `160000,${git(dir, 'rev-parse', 'HEAD').trim()},docs/sub`);
    })).status).toBe('voided');
  });
  it('rejects a traversal path in per-file evidence', async () => {
    const f = fixture();
    expect((await f.run(undefined, { raw: ':100644 100644 aaaaaaa bbbbbbb M\0docs/../outside.txt\0' })).status).toBe('voided');
    expect(f.commands.some(a => a.includes('apply'))).toBe(false);
  });
  it.each(['tracked', 'untracked'])('rejects %s binary changes', async type => {
    const f = fixture();
    expect((await f.run(dir => writeFileSync(join(dir, type === 'tracked' ? 'docs/a.md' : 'docs/bin'), Buffer.from([0, 1, 2])))).status).toBe('voided');
    expect(git(f.lane, 'status', '--porcelain')).toBe('');
  });
  it('fails an apply conflict atomically rather than overwriting dirty lane content', async () => {
    const f = fixture();
    writeFileSync(join(f.lane, 'docs/a.md'), 'lane edit\n');
    expect((await f.run(dir => writeFileSync(join(dir, 'docs/a.md'), 'clone edit\n'), { laneContent: 'lane edit\n' })).status).toBe('voided');
    expect(readFileSync(join(f.lane, 'docs/a.md'), 'utf8')).toBe('lane edit\n');
  });
});

describe('escape evidence', () => {
  it.each([
    [tool('run_command', { CommandLine: 'git status' })],
    [tool('run_command', { CommandLine: 'git status' }, { status: 'TOOL_ERROR' })],
    [tool('run_command', { CommandLine: 'echo unsafe' })],
    [tool('new_unknown_writer', { TargetFile: 'docs/a.md' })],
    [tool('write_to_file', { TargetFile: '../escape' })],
    [tool('write_to_file', { TargetFile: '/dev/null' })],
    [tool('write_to_file', { CodeContent: 'opaque' })],
    [tool('view_file', { AbsolutePath: '/dev/null' })],
  ])('voids git, shell, unknown tools and outside paths %#', async event => {
    const f = fixture();
    expect((await f.run(dir => writeFileSync(join(dir, 'docs/a.md'), 'changed\n'), {
      transcript: [event, finish],
    })).status).toBe('voided');
    expect(git(f.lane, 'status', '--porcelain')).toBe('');
  });
  it.each([
    ['errored run_command', tool('run_command', '{bad json', { status: 'TOOL_ERROR' })],
    ['errored outside write_to_file', tool('write_to_file', { TargetFile: '/dev/null' }, { state: 'ERROR' })],
    ['unknown tool', tool('unknown_tool', {})],
    ['cancelled shell', tool('shell', {}, { state: 'CANCELLED' })],
    ['pending unknown tool', tool('unknown_tool', {}, { state: 'PENDING' })],
    ['missing name', tool(undefined, {}, { state: 'ERROR' })],
    ['error-bearing outside write', { ...tool('write_to_file', {}), step_update: {
      step_type: 'tool', tool_name: 'write_to_file', tool_info: { error: 'failed', parameters: { TargetFile: '/dev/null' } },
    } }],
    ['errored outside read', tool('view_file', { AbsolutePath: '/dev/null' }, { state: 'ERROR' })],
    ['mislabeled outside write event', { ...tool('write_to_file', { TargetFile: '/dev/null' }), event: 'unknown' }],
  ])('voids %s regardless of status or malformed parameters', async (_label, event) => {
    const f = fixture();
    expect((await f.run(undefined, { transcript: [event, finish] })).status).toBe('voided');
    expect(f.commands.some(a => a.includes('apply'))).toBe(false);
    expect(git(f.lane, 'status', '--porcelain')).toBe('');
  });
  it('accepts native reads and writes confined to the clone', async () => {
    const f = fixture();
    expect((await f.run(dir => writeFileSync(join(dir, 'docs/a.md'), 'after\n'), { transcript: [
      tool('view_file', { AbsolutePath: 'docs/a.md' }),
      tool('write_to_file', { TargetFile: 'docs/a.md', CodeContent: 'after\n' }), finish,
    ] })).status).toBe('ok');
    expect(readFileSync(join(f.lane, 'docs/a.md'), 'utf8')).toBe('after\n');
  });
  it('voids moved HEAD', async () => {
    const f = fixture();
    expect((await f.run(dir => git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'move'))).status).toBe('voided');
  });
  it('audits every path update even when a tool step reuses its index', async () => {
    const f = fixture();
    expect((await f.run(undefined, { transcript: [
      tool('write_to_file', { TargetFile: 'docs/a.md' }),
      tool('write_to_file', { TargetFile: '../outside.txt' }), finish,
    ] })).status).toBe('voided');
  });
  it('detects an injected fake worker changing the lane without claiming to undo its write', async () => {
    const f = fixture();
    const r = await f.run(dir => {
      writeFileSync(join(dir, 'docs/a.md'), 'clone\n');
      writeFileSync(join(f.lane, 'outside.txt'), 'escape\n');
    });
    expect(r.status).toBe('voided');
    expect(readFileSync(join(f.lane, 'docs/a.md'), 'utf8')).toBe('before\n');
    expect(readFileSync(join(f.lane, 'outside.txt'), 'utf8')).toBe('escape\n');
    expect(r.reasons.join(' ')).not.toContain(f.root);
  });
  it.each([{ missingTranscript: true }, { unreadableTranscript: true }, { transcript: [] },
    { transcript: [tool('finish', {})] }, { transcript: [], spawnError: true },
  ])('voids missing, unreadable or incomplete transcript %j', async options => {
    const f = fixture();
    expect((await f.run(undefined, options)).status).toBe('voided');
    expect(existsSync(f.clone())).toBe(false);
  });
  it.each([
    ['error result', [{ event: 'result', result: { status: 'ERROR', error: 'failed' } }]],
    ['max turns', [{ event: 'result', result: { status: 'MAX_TURNS' } }]],
    ['malformed result', [{ event: 'result', result: {} }]],
    ['missing result', [{ event: 'init' }]],
    ['two results', [finish, finish]],
    ['error after success', [finish, { event: 'error', error: 'late failure' }]],
    ['error flag', [{ ...finish, is_error: true }]],
    ['error subtype', [{ ...finish, subtype: 'error_max_turns' }]],
    ['nested error flag', [{ ...finish, result: { ...finish.result, is_error: true } }]],
  ])('voids %s even after an in-scope edit', async (_label, transcript) => {
    const f = fixture();
    expect((await f.run(dir => writeFileSync(join(dir, 'docs/a.md'), 'after\n'), { transcript })).status).toBe('voided');
    expect(readFileSync(join(f.lane, 'docs/a.md'), 'utf8')).toBe('before\n');
  });
  it('admits exactly one terminal SUCCESS result', async () => {
    const f = fixture();
    expect((await f.run(undefined, { transcript: [finish] })).status).toBe('ok');
  });
  it('returns failed with cleanup after a failed agy run with complete escape evidence', async () => {
    const f = fixture();
    expect((await f.run(undefined, { outcome: { code: 1 } })).status).toBe('failed');
    expect(existsSync(f.clone())).toBe(false);
  });
  it('voids a transcript rewritten to hide a tool call', async () => {
    const f = fixture();
    expect((await f.run(undefined, { forgedTranscript: JSON.stringify(finish) })).status).toBe('voided');
  });
});

it('audits launcher-owned private transcript outside clone and removes it after applying', async () => {
  const f = fixture();
  let transcriptDir;
  const result = await f.run((clone, args) => {
    transcriptDir = dirname(args.logFile);
    expect(transcriptDir.startsWith(`${clone}/`)).toBe(false);
    expect(transcriptDir.startsWith(`${f.lane}/`)).toBe(false);
    expect(lstatSync(transcriptDir).mode & 0o777).toBe(0o700);
    writeFileSync(join(clone, 'docs/a.md'), 'after\n');
  });
  expect(result).toMatchObject({ status: 'ok', applied: ['docs/a.md'] });
  expect(readFileSync(join(f.lane, 'docs/a.md'), 'utf8')).toBe('after\n');
  expect(existsSync(transcriptDir)).toBe(false);
});
it('removes launcher transcript directory after rejected transcript audit', async () => {
  const f = fixture();
  let transcriptDir;
  expect(await f.run((_clone, args) => { transcriptDir = dirname(args.logFile); },
    { forgedTranscript: '{}' })).toMatchObject({ status: 'voided' });
  expect(existsSync(transcriptDir)).toBe(false);
});
