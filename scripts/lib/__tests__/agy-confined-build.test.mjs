// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runConfinedAgyBuild } from '../agy-confined-build.mjs';
import { deriveAgyFixAdmission, isAdmissibleTargetPath } from '../agy-fix-admission.mjs';

import { admissibleTargets, refusedTargets } from './fixtures/agy-target-path-cases.mjs';

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
          options.beforeExec?.(args, clone);
          commands.push(args);
          execCalls.push({ bin, args, opts });
          if (options.numstat !== undefined && args.includes('--numstat')) return options.numstat;
          if (options.raw !== undefined && args.includes('--raw')) return options.raw;
          if (options.untracked !== undefined && args.includes('ls-files')) return options.untracked;
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
    { scope: Array(1) },
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
      settings: { allowedKinds: ['feature'], maxSize: 1 } })).status).toBe('ok');
    expect((await f.run(undefined, { input: { kind: 'feature', size: 2 },
      env: { WE_AGY_BUILD_KINDS: 'feature', WE_AGY_BUILD_MAX_SIZE: '2' } })).status).toBe('ok');
  });
  it.each([
    { settings: { maxSize: 2 } },
    { settings: { maxSize: 1 }, env: { WE_AGY_BUILD_MAX_SIZE: '2' } },
  ])('maxSize widening admits a kind outside allowedKinds: %j', async options => {
    const f = fixture();
    expect(await f.run(undefined, { ...options, input: { kind: 'feature', size: 2 } }))
      .toMatchObject({ status: 'ok', applied: [] });
    expect(f.spawnAgy).toHaveBeenCalledOnce();
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
  it('voids an oversized worker snapshot before diffing with a provider fallback', async () => {
    const f = fixture();
    let post;
    const result = await f.run(dir => {
      writeFileSync(join(dir, 'docs/huge.md'), '');
      truncateSync(join(dir, 'docs/huge.md'), 64 * 1024 * 1024 + 1);
      post = f.commands.length;
    });
    expect(result).toMatchObject({ status: 'voided', applied: [] });
    expect(result.reasons.join(' ')).toContain('next fix provider');
    expect(f.commands.slice(post).some(args => args.includes('--raw'))).toBe(false);
  });
  it('preserves unchanged internal baseline symlinks without following worker links', async () => {
    const f = fixture();
    symlinkSync('a.md', join(f.lane, 'docs/reference'));
    commit(f.lane);
    expect(await f.run(dir => writeFileSync(join(dir, 'docs/a.md'), 'after\n')))
      .toMatchObject({ status: 'ok', applied: ['docs/a.md'] });
    expect(lstatSync(join(f.lane, 'docs/reference')).isSymbolicLink()).toBe(true);
  });
  it.each([false, true])('refuses JavaScript files under __fixtures__ at admission and application (tracked=%s)', async tracked => {
    const path = 'blocks/selection/__tests__/__fixtures__/payload.js';
    const f = fixture();
    if (tracked) {
      mkdirSync(dirname(join(f.lane, path)), { recursive: true });
      writeFileSync(join(f.lane, path), 'before\n');
      commit(f.lane);
    }
    expect(deriveAgyFixAdmission({ size: 1, scope: [path] }, { scope: [path] })).toBeNull();
    expect(await f.run(dir => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), 'after\n');
    }, { input: { scope: ['blocks/selection/__tests__'] } })).toMatchObject({ status: 'voided', applied: [] });
    expect(git(f.lane, 'status', '--porcelain')).toBe('');
  });
  it('never executes a clean filter planted after the control hash', async () => {
    const f = fixture();
    const marker = join(f.root, 'filter-executed');
    let post = false;
    let planted = false;
    const result = await f.run(dir => {
      writeFileSync(join(dir, 'docs/a.md'), 'after\n');
      post = true;
    }, { beforeExec: (args, dir) => {
      // The real-lane snapshot happens after the post-worker control check.
      if (post && !planted && args.includes(f.lane)) {
        planted = true;
        writeFileSync(join(dir, '.git/config'), `[filter "attack"]\n clean = touch '${marker}'\n`);
        writeFileSync(join(dir, '.gitattributes'), '* filter=attack\n');
      }
    } });
    expect(planted).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(result).toMatchObject({ status: 'voided', applied: [] });
  });
  it('never executes a delayed surviving writer clean filter after the control hash', async () => {
    const f = fixture();
    const go = join(f.root, 'go'), done = join(f.root, 'done'), marker = join(f.root, 'executed');
    let writer, exited, post = false, triggered = false;
    try {
      const result = await f.run(async dir => {
        writeFileSync(join(dir, 'docs/a.md'), 'after\n');
        writer = spawn(process.execPath, ['--input-type=module', '-e', `
          import { existsSync, writeFileSync } from 'node:fs';
          const [dir, go, done, marker] = process.argv.slice(1);
          const timer = setInterval(() => {
            if (!existsSync(go)) return;
            writeFileSync(dir + '/.git/config', '[filter "attack"]\\n clean = touch "' + marker + '"\\n');
            writeFileSync(dir + '/.gitattributes', '* filter=attack\\n');
            writeFileSync(done, 'ready');
            clearInterval(timer);
          }, 5);
          setTimeout(() => process.exit(2), 10000).unref();
          process.stdout.write('ready');
        `, dir, go, done, marker], { stdio: ['ignore', 'pipe', 'pipe'] });
        exited = new Promise(resolve => writer.on('close', resolve));
        await new Promise((resolve, reject) => { writer.stdout.once('data', resolve); writer.once('error', reject); });
        post = true;
      }, { beforeExec: args => {
        if (!post || triggered || !args.includes(f.lane)) return;
        triggered = true;
        writeFileSync(go, 'go');
        // Allow the separate process to mutate controls while the launcher is in its post-hash window.
        execFileSync(process.execPath, ['-e', `
          const fs = require('node:fs');
          const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) { clearInterval(timer); } }, 5);
        `, done], { timeout: 5000 });
      } });
      expect(triggered).toBe(true);
      expect(await exited).toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(result).toMatchObject({ status: 'voided', applied: [] });
      expect(git(f.lane, 'status', '--porcelain')).toBe('');
    } finally { writer?.kill(); if (exited) await exited; }
  });
  it.each(admissibleTargets)('admits and applies allowlisted path %s inside scope', async path => {
    const f = fixture();
    expect(deriveAgyFixAdmission({ taskKind: 'feature', size: 1, scope: [path] }, { scope: [path] })).not.toBeNull();
    expect(await f.run(dir => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), 'new content\n');
    }, { input: { kind: 'feature', scope: [path] } })).toMatchObject({ status: 'ok', applied: [path] });
    expect(readFileSync(join(f.lane, path), 'utf8')).toBe('new content\n');
  });
  it.each(refusedTargets.map(p => [JSON.stringify(p), p]))('refuses %s at admission and as a changed path', async (_label, path) => {
    expect(deriveAgyFixAdmission({ taskKind: 'feature', size: 1, scope: [path] }, { scope: [path] })).toBeNull();
    expect(isAdmissibleTargetPath(path)).toBe(false);
    const f = fixture();
    expect(await f.run(undefined, { input: { kind: 'feature', scope: [path] } }))
      .toMatchObject({ status: 'refused', applied: [] });
    expect(f.spawnAgy).not.toHaveBeenCalled();
    for (const evidence of [
      { raw: `:100644 100644 ${'0'.repeat(40)} ${'1'.repeat(40)} M\0${path}\0` },
      { untracked: `${path}\0` },
    ]) {
      expect(await f.run(undefined, evidence)).toMatchObject({ status: 'voided', applied: [] });
      expect(f.commands.some(a => a.includes('apply'))).toBe(false);
    }
    expect(f.spawnAgy).toHaveBeenCalledTimes(2);
    expect(git(f.lane, 'status', '--porcelain')).toBe('');
  });
  it.each([false, true])('voids policy-cascade changes before apply (tracked=%s)', async tracked => {
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
    })).toMatchObject({ status: 'voided', applied: [] });
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
  it('uses only a launcher-owned repository for post-run diff generation', async () => {
    const f = fixture();
    let post;
    expect((await f.run(dir => {
      writeFileSync(join(dir, 'docs/a.md'), 'after\n');
      writeFileSync(join(dir, 'docs/guide.md'), 'new\n');
      post = f.execCalls.length;
    })).status).toBe('ok');
    const after = f.execCalls.slice(post);
    expect(after.some(c => c.args.includes(f.clone()) || c.opts.cwd === f.clone()
      || c.opts.env.GIT_WORK_TREE === f.clone())).toBe(false);
    const calls = after.filter(c => c.opts.env.GIT_WORK_TREE);
    expect(calls).toHaveLength(4);
    for (const { args, opts } of calls) {
      const trusted = opts.env.GIT_WORK_TREE;
      expect(trusted).not.toBe(f.clone());
      expect(existsSync(trusted)).toBe(false); // launcher cleans its diff repository too
      expect(opts.env).toMatchObject({ GIT_DIR: join(trusted, '.git'), GIT_COMMON_DIR: join(trusted, '.git'),
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
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
    expect(f.commands.find(a => a.includes('apply') && !a.includes('--numstat'))).toContain('--include=docs/*');
  });
  it.each([
    ['test-fix', 'docs', 'docs/__tests__/package.json'],
    ['doc-fix', 'docs', 'docs/.github/workflows/x.yml'],
    ['doc-fix', 'docs', 'docs/deep/pnpm-lock.yaml'],
    ['test-fix', 'docs', 'docs/__tests__/deep/bun.lock'],
    ['doc-fix', 'docs', 'docs/scripts/settings/config.json'],
    ['doc-fix', 'notes.md', 'notes.md/code.js'],
    ['test-fix', 'blocks/selection/sample.test.ts', 'blocks/selection/sample.test.ts/code.js'],
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
  it.each([false, true])('voids an admissible test outside item scope (tracked=%s)', async tracked => {
    const f = fixture();
    const path = 'blocks/selection/b.test.ts';
    if (tracked) {
      mkdirSync(join(f.lane, 'blocks/selection'), { recursive: true });
      writeFileSync(join(f.lane, path), 'before\n');
      commit(f.lane);
    }
    expect(isAdmissibleTargetPath(path)).toBe(true);
    expect(await f.run(dir => {
      mkdirSync(join(dir, 'blocks/selection'), { recursive: true });
      writeFileSync(join(dir, path), 'changed\n');
    }, { input: { kind: 'test-fix', scope: ['blocks/selection/a.test.ts'] } }))
      .toMatchObject({ status: 'voided', applied: [] });
    expect(f.commands.some(a => a.includes('apply'))).toBe(false);
    expect(git(f.lane, 'status', '--porcelain')).toBe('');
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
  it.each(['.git/config', '.git/commondir', '.git/HEAD', '.git/index', '.git/info/attributes', '.git/info/exclude',
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
    let post;
    const result = await f.run(dir => {
      writeFileSync(join(dir, 'docs/a.md'), 'after\n');
      mkdirSync(join(dir, 'docs/sub'));
      git(dir, 'update-index', '--add', '--cacheinfo', `160000,${git(dir, 'rev-parse', 'HEAD').trim()},docs/sub`);
      post = f.commands.length;
    });
    expect(result).toMatchObject({ status: 'voided', applied: [] });
    expect(result.reasons.join(' ')).toContain('clone git controls changed');
    expect(f.commands.slice(post)).toEqual([]);
    expect(git(f.lane, 'status', '--porcelain')).toBe('');
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
    // Real agy 1.5.11 tool names (`edit_file`, `read_file`) use a `Path` parameter and must stay clone-contained.
    [tool('edit_file', { Path: '/dev/null' })],
    [tool('read_file', { Path: '/etc/passwd' })],
    [tool('read_file', {})],
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
    ['conflicting tool names', tool('write_to_file', { TargetFile: 'docs/a.md', CodeContent: 'x' }, { tool_info: { name: 'run_command', parameters: { TargetFile: 'docs/a.md', CodeContent: 'x' } } })],
    ['outside write_to_file with a non-tool step_type', tool('write_to_file', { TargetFile: '/dev/null' }, { step_type: 'mystery' })],
    ['outside view_file with a non-tool step_type', tool('view_file', { AbsolutePath: '/dev/null' }, { step_type: 'mystery' })],
    ['tool-named update with a non-tool step_type', tool('unknown_tool', {}, { step_type: 'mystery' })],
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

it('cleans transcript and discards clone edits when the sandbox launcher fails', async () => {
  const f = fixture();
  let transcriptDir;
  const result = await f.run((clone, args) => {
    transcriptDir = dirname(args.logFile);
    writeFileSync(join(clone, 'docs/a.md'), 'discarded edit\n');
  }, { spawnError: true });
  expect(result).toMatchObject({ status: 'voided', applied: [] });
  expect(readFileSync(join(f.lane, 'docs/a.md'), 'utf8')).toBe('before\n');
  expect(existsSync(transcriptDir)).toBe(false);
  expect(existsSync(f.clone())).toBe(false);
});

describe('final patch enforcement', () => {
  it.each(['tracked', 'untracked'])('voids executable %s additions', async type => {
    const f = fixture();
    expect(await f.run(dir => {
      writeFileSync(join(dir, 'docs/new.md'), 'new prose\n');
      chmodSync(join(dir, 'docs/new.md'), 0o755);
      if (type === 'tracked') git(dir, 'add', 'docs/new.md');
    })).toMatchObject({ status: 'voided', applied: [] });
    expect(f.commands.some(a => a.includes('apply'))).toBe(false);
    expect(git(f.lane, 'status', '--porcelain')).toBe('');
  });
  it.each(['docs/x.json', 'docs/.gitignore'])('voids %s introduced between raw and final patch reads', async path => {
    const f = fixture();
    if (path.endsWith('.gitignore')) {
      writeFileSync(join(f.lane, path), '# before\n');
      commit(f.lane);
    }
    let mutated = false;
    expect(await f.run(dir => writeFileSync(join(dir, 'docs/a.md'), 'after\n'), {
      beforeExec: (args) => {
        if (!mutated && args.includes('diff') && args.includes('--binary') && !args.includes('--no-index')) {
          // Synthetic corruption of the launcher-owned final artifact must still be rejected.
          const dir = args[args.indexOf('-C') + 1];
          mutated = true;
          writeFileSync(join(dir, path), 'changed\n');
          if (path.endsWith('.json')) git(dir, 'add', path);
        }
      },
    })).toMatchObject({ status: 'voided', applied: [] });
    expect(mutated).toBe(true);
    expect(f.commands.some(a => a.includes('apply') && !a.includes('--numstat'))).toBe(false);
    expect(git(f.lane, 'status', '--porcelain')).toBe('');
  });
  it.each(['new file mode 100755', 'old mode 100644\nnew mode 100755'])
  ('voids late final patch mode changes: %s', async mode => {
    const f = fixture();
    let mutated = false;
    expect(await f.run(dir => writeFileSync(join(dir, 'docs/a.md'), 'after\n'), {
      beforeExec: (args) => {
        if (!mutated && args.includes('diff') && args.includes('--binary') && !args.includes('--no-index')) {
          const dir = args[args.indexOf('-C') + 1];
          mutated = true;
          if (mode.startsWith('new file')) {
            writeFileSync(join(dir, 'docs/new.md'), 'new\n');
            chmodSync(join(dir, 'docs/new.md'), 0o755);
            git(dir, 'add', 'docs/new.md');
          } else chmodSync(join(dir, 'docs/a.md'), 0o755);
        }
      },
    })).toMatchObject({ status: 'voided', applied: [] });
    expect(mutated).toBe(true);
    expect(f.commands.some(a => a.includes('apply'))).toBe(false);
    expect(git(f.lane, 'status', '--porcelain')).toBe('');
  });
});

it.each(['', 'unreadable\0'])('voids incomplete final-patch path evidence %j', async numstat => {
  const f = fixture();
  expect(await f.run(dir => writeFileSync(join(dir, 'docs/a.md'), 'after\n'), { numstat }))
    .toMatchObject({ status: 'voided', applied: [] });
  expect(f.commands.some(a => a.includes('apply') && !a.includes('--numstat'))).toBe(false);
  expect(git(f.lane, 'status', '--porcelain')).toBe('');
});

it.each(['maxSize', 'kindMaxSize'].flatMap(key =>
  [1, 1000000].flatMap(size => [
    ...[{ unexpected: 1 }, 0, -1, 1.5, '2', null].map(value =>
      [key, size, { settings: { [key]: value } }]),
    ...['NaN', 'Infinity', '0', '-1', '1.5', 'invalid'].map(value =>
      [key, size, { env: { [key === 'maxSize' ? 'WE_AGY_BUILD_MAX_SIZE' : 'WE_AGY_BUILD_KIND_MAX_SIZE']: value } }]),
  ])))('refuses invalid %s for size %s with a human fallback: %j', async (_key, size, options) => {
  const f = fixture();
  const result = await f.run(undefined, { ...options, input: { size } });
  expect(result).toMatchObject({ status: 'refused', applied: [] });
  expect(result.reasons.join(' ')).toMatch(/provider|human|operator/);
  expect(f.spawnAgy).not.toHaveBeenCalled();
  expect(f.commands).toEqual([]);
});
