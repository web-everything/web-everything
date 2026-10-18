/**
 * x55dojc / #4291 advisory review — the REAL `realIo` of both probation run scripts, driven against a real temp
 * git repo (never a fake `io`): the arc suites stub every io call, so without this file a realIo that dropped
 * `env: laneEnv` from `commit`, handed the hooks-disabled env to the worker, or leaked a worker-created file
 * past `discardChanges` would redden nothing.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { realIo as buildRealIo } from '../probation-build-run.mjs';
import { realIo as healRealIo } from '../probation-heal-run.mjs';

let dirs = [];
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'we-probation-realio-'));
  dirs.push(dir);
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '--quiet');
  git('config', 'user.email', 't@t.com');
  git('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.md'), 'v0\n');
  git('add', 'a.md');
  git('commit', '--quiet', '-m', 'base');
  return { dir, base: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim() };
}
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

// Prints the git-config override a child inherits (or `none`) — what the worker's own git calls would see.
const PRINT_ENV = 'process.stdout.write(JSON.stringify({ lastMessage: `${process.env.GIT_CONFIG_COUNT ?? "none"}|${process.env.LANE_SESSION ?? ""}` }))';

describe.each([
  ['probation-build-run', buildRealIo],
  ['probation-heal-run', healRealIo],
])('%s realIo — against a real git repo', (_name, realIo) => {
  const env = { ...process.env };
  delete env.GIT_CONFIG_COUNT;
  const io = realIo({ session: 'sess-1', env });

  it('the worker keeps the repo\'s own hooks (e.g. the pre-push main guard): no hooks-disabled override reaches it', async () => {
    const r = await io.runWorker(['-e', PRINT_ENV]);
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.out).lastMessage).toBe('none|sess-1');
  });

  it('a planted pre-commit hook never runs on the launcher\'s own commit, even with hooksPath repointed on disk', () => {
    const { dir } = makeRepo();
    const marker = join(dir, 'HOOK-RAN');
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    const hook = join(dir, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`);
    chmodSync(hook, 0o755);
    execFileSync('git', ['config', 'core.hooksPath', '.git/hooks'], { cwd: dir });
    writeFileSync(join(dir, 'a.md'), 'v1\n');
    io.commit(dir, ['a.md'], 'launcher commit');
    expect(existsSync(marker)).toBe(false);
    expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim()).toBe('launcher commit');
  });

  it('discardChanges removes a worker-created file even after diffNumstat intent-added it, and keeps pre-existing untracked files', () => {
    const { dir, base } = makeRepo();
    writeFileSync(join(dir, 'keep.txt'), 'was here before the worker\n');
    const preexisting = io.untracked(dir);
    writeFileSync(join(dir, 'evil.md'), 'worker-created\n');
    writeFileSync(join(dir, 'a.md'), 'worker-edited\n');
    io.diffNumstat(dir, base, preexisting); // intent-adds evil.md — it no longer lists as untracked
    io.discardChanges(dir, base, preexisting);
    expect(existsSync(join(dir, 'evil.md'))).toBe(false);
    expect(existsSync(join(dir, 'keep.txt'))).toBe(true);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim()).toBe('?? keep.txt');
  });
});

/**
 * #4291 advisory finding (security/coverage) — EVERY subprocess the launcher itself runs in the lane must carry
 * the hooks-disabled override, not just `commit`. A `git` shim first on PATH and a `NODE_OPTIONS` preload
 * record the override each child inherits (the preload then exits, so no real WE script runs), and every io
 * method that touches the lane is driven once.
 */
function recordingEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'we-probation-envlog-'));
  dirs.push(dir);
  const log = join(dir, 'calls.log');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'git'), `#!/bin/sh\nprintf '%s git %s\\n' "\${GIT_CONFIG_COUNT:-none}" "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(join(dir, 'bin', 'git'), 0o755);
  const preload = join(dir, 'preload.cjs');
  writeFileSync(preload, `require('node:fs').appendFileSync(${JSON.stringify(log)}, \`\${process.env.GIT_CONFIG_COUNT ?? 'none'} node \${process.argv[1] ?? ''}\\n\`); process.exit(0);\n`);
  const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, NODE_OPTIONS: `--require=${preload}` };
  delete env.GIT_CONFIG_COUNT;
  return { env, lines: () => readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

describe.each([
  ['probation-build-run', buildRealIo, (io, dir, base) => {
    // The preload exits without a path; acquisition now surfaces that refusal.
    expect(() => io.acquireLane({ lane: 1, session: 's', scope: ['we:a.md'] })).toThrow('lane-pool returned no lane path');
    io.claim('1', 's', dir);
    io.headSha(dir);
    const pre = io.untracked(dir);
    writeFileSync(join(dir, 'a.md'), 'v1\n');
    io.diffNumstat(dir, base, pre);
    io.resolveItem('1', dir);
    io.commit(dir, ['a.md'], 'm');
    io.runGate(dir);
    io.openPr({ lanePath: dir, num: '1', slug: 'x', attemptTag: '', bodyFile: join(dir, '.git', 'body') });
    io.discardChanges(dir, base, pre);
  }],
  ['probation-heal-run', healRealIo, (io, dir, base) => {
    io.acquireLane({ ref: 'lane/x', lane: 1, session: 's', scope: ['we:a.md'] });
    io.rebaseOntoMain(dir);
    io.headSha(dir);
    const pre = io.untracked(dir);
    writeFileSync(join(dir, 'a.md'), 'v1\n');
    io.diffNumstat(dir, base, pre);
    io.diffText(dir, base);
    io.runGate(dir);
    io.commit(dir, ['a.md'], 'm');
    io.push(dir, 'lane/x', base);
    io.discardChanges(dir, base, pre);
  }],
])('%s realIo — every launcher subprocess in the lane inherits the hooks-disabled override', (_name, realIo, drive) => {
  it('no git or node child the launcher starts in the lane runs without it', () => {
    const { dir, base } = makeRepo();
    const { env, lines } = recordingEnv();
    drive(realIo({ session: 'sess-1', env }), dir, base);
    const calls = lines();
    expect(calls.some((l) => / git /.test(l))).toBe(true);
    expect(calls.some((l) => / node /.test(l))).toBe(true);
    expect(calls.filter((l) => !l.startsWith('1 '))).toEqual([]);
  });
});

describe('probation-heal-run realIo — the checker is a worker too', () => {
  it('the checker keeps the repo\'s own hooks: no hooks-disabled override reaches it', async () => {
    const env = { ...process.env };
    delete env.GIT_CONFIG_COUNT;
    expect(healRealIo({ session: 'sess-1', env }).runChecker(['-e', PRINT_ENV])).toBe('none|sess-1');
  });
});
