/** Real git fidelity: the card reader runs real git against a real repo with a real origin/main ref. */
import { execFileSync } from 'node:child_process';
import { chmodSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { withRealRepo } from './helpers/real-repo.mjs';
import { readPriorityCards } from '../build-priority-set-io.mjs';

afterEach(() => { vi.unstubAllEnvs(); });

it('reads the real remote main despite a shadowing local branch and refuses a missing card', async () => {
  await withRealRepo(async ctx => {
    ctx.commit({ 'backlog/0042-example.md': '---\nid: 42\nscope: [scripts/a.mjs]\n---\nbody\n' });
    ctx.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    ctx.commit({ 'backlog/0042-example.md': '---\nscope: [scripts/shadow.mjs]\n---\n' });
    ctx.git(['update-ref', 'refs/heads/origin/main', 'HEAD']);
    const git = args => ctx.git(args);
    expect(readPriorityCards({ git })('42').scope).toEqual(['scripts/a.mjs']);
    expect(() => readPriorityCards({ git })('43')).toThrow(/missing or ambiguous/);
  });
});

it('refuses real directory, ancestor, missing and symlink tree entries; accepts only regular blob modes on the pinned card SHA', async () => {
  await withRealRepo(async ctx => {
    const regular = 'scripts/conveyor/a.mjs', executable = 'scripts/lib/ledger-readiness-daily.mjs';
    ctx.commit({
      'backlog/42-example.md': '---\nscope: ["we:scripts/conveyor/a.mjs"]\n---\n',
      [regular]: 'export {};\n', [executable]: 'export {};\n',
      'scripts/conveyor/relocated.mjs/child.mjs': 'export {};\n',
    });
    symlinkSync('a.mjs', join(ctx.root, 'scripts/conveyor/link.mjs'));
    chmodSync(join(ctx.root, executable), 0o755);
    ctx.git(['add', '--', 'scripts']);
    ctx.git(['commit', '--quiet', '-m', 'fixture: file modes']);
    ctx.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const read = readPriorityCards({ git: args => ctx.git(args) });
    expect(read('42').scope).toEqual(['we:scripts/conveyor/a.mjs']);
    for (const path of ['scripts/conveyor', 'scripts/conveyor/relocated.mjs', 'scripts/conveyor/missing.mjs', 'scripts/conveyor/link.mjs']) {
      expect(read.pathType(path), path).not.toBe('file');
    }
    ctx.git(['rm', '--quiet', '--', regular]);
    ctx.git(['commit', '--quiet', '-m', 'fixture: remove regular file']);
    ctx.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    expect(read.pathType('scripts/conveyor/A.mjs')).not.toBe('file');
    expect(read.pathType(regular)).toBe('file');
    expect(read.pathType(executable)).toBe('file');
    expect(readPriorityCards({ git: args => ctx.git(args) }).pathType(regular)).not.toBe('file');
  });
});

it('reads bounded content from the pinned main blob despite worktree and ref changes', async () => {
  await withRealRepo(async ctx => {
    const path = 'scripts/lib/ledger-readiness-daily.mjs';
    ctx.commit({ [path]: '// @guard\n' });
    ctx.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const calls = [];
    const read = readPriorityCards({ git: (args, options) => { calls.push({ args, options }); return ctx.git(args); } });
    expect(read.readContent(path)).toBe('// @guard\n');
    ctx.commit({ [path]: 'export {};\n' });
    ctx.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    expect(read.readContent(path)).toBe('// @guard\n');
    expect(calls.filter(call => call.args[0] === 'show').every(call => call.options.maxBuffer === 65536)).toBe(true);
    expect(() => read.readContent('scripts/missing.mjs')).toThrow();
    expect(readPriorityCards({ git: args => ctx.git(args) }).readContent(path)).toBe('export {};\n');
  });
});

it('bounds real Git content output at 64 KiB and refuses overflow', async () => {
  await withRealRepo(async ctx => {
    const path = 'scripts/lib/ledger-readiness-daily.mjs';
    ctx.commit({ [path]: 'x'.repeat(65537) });
    ctx.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const read = readPriorityCards({ git: (args, options) => execFileSync('git', args, {
      encoding: 'utf8', timeout: 10000, cwd: ctx.root, ...options, maxBuffer: options?.maxBuffer ?? 8 * 1024 * 1024,
    }) });
    expect(() => read.readContent(path)).toThrow(/ENOBUFS/);
  });
});

it.each(['refs/replace/', 'refs/hostile/'])(
  'isolates the default Git runner from repository overrides and %s blob replacements', async replaceBase => {
    await withRealRepo(async ctx => {
      await withRealRepo(async other => {
        const card = 'backlog/42-example.md', settings = 'scripts/settings/build-priority-scope.json';
        const original = {
          [card]: '---\nscope: ["we:scripts/conveyor/a.mjs"]\n---\n',
          [settings]: '{"allowedFiles":["scripts/conveyor/a.mjs"]}',
        };
        const hostile = {
          [card]: '---\nscope: ["we:scripts/lib/unlisted.mjs"]\n---\n',
          [settings]: '{"allowedFiles":["scripts/lib/unlisted.mjs"]}',
        };
        ctx.commit(original);
        const sha = ctx.head();
        ctx.git(['update-ref', 'refs/remotes/origin/main', sha]);
        ctx.commit(hostile);
        other.commit(hostile);
        other.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
        for (const path of [card, settings]) {
          const before = ctx.head(`${sha}:${path}`), after = ctx.head(`HEAD:${path}`);
          ctx.git(['update-ref', `${replaceBase}${before}`, after]);
          expect(ctx.git(['show', `${sha}:${path}`], {
            env: { ...process.env, GIT_REPLACE_REF_BASE: replaceBase },
          })).toBe(hostile[path]);
        }
        for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
          'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_INDEX_FILE']) {
          vi.stubEnv(key, join(other.root, key === 'GIT_WORK_TREE' ? '' : '.git'));
        }
        vi.stubEnv('GIT_REPLACE_REF_BASE', replaceBase);
        vi.stubEnv('GIT_CONFIG_COUNT', '999');
        vi.stubEnv('GIT_NO_REPLACE_OBJECTS', '0');
        const read = readPriorityCards({ root: ctx.root });
        expect(read('42').scope).toEqual(['we:scripts/conveyor/a.mjs']);
        expect(read.readScopeSettings()).toBe(original[settings]);
      });
    });
  });

it.each(['symlink', 'gitlink'])('refuses %s scope settings even when the blob text is valid allowlist JSON', async mode => {
  await withRealRepo(async ctx => {
    const settings = 'scripts/settings/build-priority-scope.json';
    const contents = '{"allowedFiles":["scripts/conveyor/a.mjs"]}';
    ctx.commit({ [settings]: contents });
    if (mode === 'symlink') {
      unlinkSync(join(ctx.root, settings));
      symlinkSync(contents, join(ctx.root, settings));
      ctx.git(['add', '--', settings]);
    } else {
      ctx.git(['update-index', '--cacheinfo', `160000,${ctx.head()},${settings}`]);
    }
    ctx.git(['commit', '--quiet', '-m', 'fixture: non-regular settings']);
    ctx.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    if (mode === 'symlink') expect(ctx.git(['show', `HEAD:${settings}`])).toBe(contents);
    const read = readPriorityCards({ git: args => ctx.git(args) });
    expect(() => read.readScopeSettings()).toThrow(/invalid settings file mode/);
  });
});

it('reads scope settings from the same pinned SHA as cards and ignores broader worktree and ref state', async () => {
  await withRealRepo(async ctx => {
    const settings = 'scripts/settings/build-priority-scope.json';
    const listed = 'scripts/conveyor/a.mjs';
    const original = JSON.stringify({ allowedFiles: [listed] });
    ctx.commit({ [settings]: original, 'backlog/42-example.md': '---\nscope: ["we:scripts/conveyor/a.mjs"]\n---\n' });
    ctx.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const sha = ctx.git(['rev-parse', 'HEAD']).trim();
    const calls = [];
    const read = readPriorityCards({ git: (args, options) => { calls.push(args); return ctx.git(args); } });
    read('42');
    const broader = JSON.stringify({ allowedFiles: [listed, 'scripts/lib/unlisted.mjs'] });
    writeFileSync(join(ctx.root, settings), broader);
    expect(read.readScopeSettings()).toBe(original);
    ctx.commit({ [settings]: broader });
    ctx.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    expect(read.readScopeSettings()).toBe(original);
    expect(calls.filter(args => args[0] === 'show')).toContainEqual(['show', `${sha}:${settings}`]);
    expect(readPriorityCards({ git: args => ctx.git(args) }).readScopeSettings()).toBe(broader);
  });
});

it('refuses missing scope settings at the snapshot even when present in the worktree', async () => {
  await withRealRepo(async ctx => {
    ctx.commit({ 'scripts/settings/other.json': '{}' });
    ctx.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    writeFileSync(join(ctx.root, 'scripts/settings/build-priority-scope.json'), '{"allowedFiles":["scripts/lib/ledger-readiness-daily.mjs"]}');
    expect(() => readPriorityCards({ git: args => ctx.git(args) }).readScopeSettings()).toThrow();
  });
});
