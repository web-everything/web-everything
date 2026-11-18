// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runConfinedAgyBuild } from '../agy-confined-build.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const git = (dir, ...args) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', dir, ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const commit = dir => { git(dir, 'add', '.'); git(dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'); };
const tool = (name, parameters, extra = {}) => ({ event: 'step_update', step_update: {
  step_type: 'tool', step_index: 1, state: 'DONE', tool_name: name, tool_info: { parameters }, ...extra,
} });
const finish = { event: 'result', result: { status: 'success', response: 'done' } };

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
  const spawnAgy = vi.fn();
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
        env: options.env ?? {}, log: vi.fn(), spawnAgy: options.production ? undefined : spawnAgy,
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
          if (options.raw !== undefined && args.includes('--raw')) return options.raw;
          try { return execFileSync(bin, args, opts); }
          catch (e) { if (opts.diffExit && e.status === 1) return String(e.stdout); throw e; }
        },
      } });
  };
  return { root, lane, run, spawnAgy, commands, clone: () => clone };
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
    ['doc-fix', 2], ['test-fix', 2], ['feature', 1],
  ])('admits allowed kind OR bounded size (%s, %s)', async (kind, size) => {
    const f = fixture();
    expect(await f.run(undefined, { input: { kind, size } })).toMatchObject({ status: 'ok', applied: [] });
    expect(f.spawnAgy).toHaveBeenCalledOnce();
  });
  it.each([
    { kind: 'feature', size: 2 }, { kind: undefined }, { size: undefined }, { size: '1' },
    { size: NaN }, { scope: undefined }, { scope: [] }, { scope: ['/docs'] },
    { scope: ['docs/../outside.txt'] }, { scope: ['.git'] }, { scope: ['**'] },
  ])('refuses missing, oversized or unsafe admission %j without launching', async input => {
    const f = fixture();
    const r = await f.run(undefined, { input });
    expect(r).toMatchObject({ status: 'refused', applied: [] });
    expect(r.reasons.join(' ')).toContain('provider');
    expect(f.spawnAgy).not.toHaveBeenCalled();
  });
  it.each([{ settingsError: true }, { settingsText: '{' }, { settingsText: 'null' },
    { settings: { maxSize: '2' } }, { env: { WE_AGY_BUILD_MAX_SIZE: 'invalid' } },
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
});

describe('launcher-owned atomic application', () => {
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
  it.each(['.git/config', '.git/hooks/pre-commit', '.git/info/attributes'])('voids planted %s without post-run git in the clone', async p => {
    const f = fixture();
    let post;
    expect((await f.run(dir => {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), 'planted\n');
      post = f.commands.length;
    })).status).toBe('voided');
    expect(f.commands.slice(post).some(a => a.includes(f.clone()))).toBe(false);
    expect(git(f.lane, 'status', '--porcelain')).toBe('');
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
