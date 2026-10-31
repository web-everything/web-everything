// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync as realSpawnSync } from 'node:child_process';
import { resolveToolsRoot } from '../tools-root.mjs';
import { maybeReexecFromToolsRoot, TOOLS_ROOT_ENTRIES } from '../tools-root-guard.mjs';

const script = 'scripts/readiness/heavy-admission.mjs';
const sha = 'a'.repeat(40);
let base, home, root, ownRoot, env, options;
const write = (path, text) => { fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, text); };
const checkout = path => {
  fs.mkdirSync(join(path, '.git'), { recursive: true });
  write(join(path, 'package.json'), JSON.stringify({ name: 'web-everything' }));
  write(join(path, 'scripts/lib/tools-root.mjs'), '// marker');
  write(join(path, script), '// entry');
};
const git = (path, args) => ({ status: 0, stdout: args.includes('HEAD') ? sha : path });
beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'we-tools-root-')));
  home = join(base, 'home');
  root = join(base, 'tools');
  ownRoot = join(base, 'lane');
  checkout(root); checkout(ownRoot);
  env = { WE_TOOLS_ROOT: root, WE_DAEMON_EVENTS: join(base, 'events', 'daemon-events.jsonl') };
  options = { scriptRelPath: script, env, home, ownRoot, git };
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));
const guardOptions = () => ({ ...options, entryUrl: pathToFileURL(join(ownRoot, script)),
  argv: [process.execPath, join(ownRoot, script), 'run', '--', 'literal $(data)', 'space arg'],
  cwd: ownRoot, spawnSync: vi.fn(() => ({ status: 7 })), exit: vi.fn(), log: vi.fn(),
  appendEvent: vi.fn(() => true),
});
// A separate work tree reads the current git directory without writing fixture commits.
const liveGuardFixture = () => {
  const repo = resolve('.');
  const gitDir = realSpawnSync('git', ['rev-parse', '--absolute-git-dir'], { encoding: 'utf8', cwd: repo }).stdout.trim();
  fs.rmSync(join(root, '.git'), { recursive: true }); fs.symlinkSync(gitDir, join(root, '.git'));
  for (const name of ['tools-root-guard.mjs', 'tools-root.mjs', 'daemon-clone-layout.mjs']) {
    write(join(ownRoot, 'scripts/lib', name), fs.readFileSync(join(repo, 'scripts/lib', name), 'utf8'));
  }
  return { ...process.env, ...env, WE_TOOLS_ROOT_REEXEC: undefined,
    WE_PLATFORM_PREFERENCES: join(base, 'absent.json') };
};
const rejectionCases = [
  ['tools-root input exceeds byte limit; use local tooling', o => write(join(root, 'package.json'), ' '.repeat(256 * 1024 + 1))],
  ['platform preferences must be an object', o => {
    const prefs = join(base, 'prefs.json'); write(prefs, '[]'); o.env = { WE_PLATFORM_PREFERENCES: prefs };
  }],
  ['tools.root must be an absolute path', o => { o.env.WE_TOOLS_ROOT = 'relative'; }],
  ['tools.root cannot be a lane or daemon clone', o => {
    const lane = join(base, '.lanes', 'tools'); checkout(lane); o.env.WE_TOOLS_ROOT = lane;
  }],
  ['entry script must be inside its repository', o => { o.scriptRelPath = '../escape.mjs'; }],
  ['tools.root is not a web-everything checkout', o => fs.rmSync(join(root, '.git'), { recursive: true })],
  ['requested script is missing or outside tools.root', o => {
    fs.rmSync(join(root, script)); fs.mkdirSync(join(root, script));
  }],
  ['tools.root is not a git checkout root', o => { o.git = () => ({ status: 0, stdout: ownRoot }); }],
  ['tools.root HEAD is unavailable', o => { o.git = (path, args) => ({ status: 0, stdout: args.includes('HEAD') ? '' : path }); }],
];

describe('tools.root resolution and guard', () => {
  it('unset means local execution without a reason, re-exec, logs or events', async () => {
    expect(resolveToolsRoot({ ...options, env: {} })).toEqual({ active: false });
    const o = { ...guardOptions(), env: {} };
    await maybeReexecFromToolsRoot(o);
    expect(o.spawnSync).not.toHaveBeenCalled();
    expect(o.log).not.toHaveBeenCalled();
    expect(o.appendEvent).not.toHaveBeenCalled();
  });

  it('re-execs exactly once, preserving argv, environment and lane cwd, and logs provenance once per process', async () => {
    const o = guardOptions();
    o.env.EXTRA = 'retained';
    await maybeReexecFromToolsRoot(o);
    expect(o.spawnSync).toHaveBeenCalledTimes(1);
    expect(o.spawnSync).toHaveBeenCalledWith(process.execPath, [join(root, script), ...o.argv.slice(2)], {
      stdio: 'inherit', cwd: ownRoot, env: { ...o.env, WE_TOOLS_ROOT_REEXEC: root },
    });
    expect(o.exit).toHaveBeenCalledTimes(1);
    expect(o.exit).toHaveBeenCalledWith(7);
    expect(o.log).toHaveBeenCalledTimes(1);
    expect(o.log).toHaveBeenCalledWith(`[tools-root] running ${script} from ${root} @ aaaaaaa`);
    await maybeReexecFromToolsRoot(o);
    expect(o.log).toHaveBeenCalledTimes(1);
    const child = { ...guardOptions(), env: o.spawnSync.mock.calls[0][2].env };
    await maybeReexecFromToolsRoot(child);
    expect(child.spawnSync).not.toHaveBeenCalled();
    expect(child.log).not.toHaveBeenCalled();
    expect(child.appendEvent).not.toHaveBeenCalled();
  });

  it('reads platform tools.root at the default path and lets environment override it', () => {
    write(join(home, '.claude/platform-preferences.json'), JSON.stringify({ tools: { root } }));
    expect(resolveToolsRoot({ ...options, env: {} })).toEqual({ active: true, root, sha });
    expect(resolveToolsRoot({ ...options, env: { WE_TOOLS_ROOT: 'relative' } }).reason).toMatch(/absolute/);
  });

  it.each(TOOLS_ROOT_ENTRIES)('allows the explicitly opted-in entry %s', async entry => {
    write(join(ownRoot, entry), '// local entry'); write(join(root, entry), '// tools entry');
    const o = { ...guardOptions(), entryUrl: pathToFileURL(join(ownRoot, entry)),
      argv: [process.execPath, join(ownRoot, entry)] };
    await maybeReexecFromToolsRoot(o);
    expect(o.spawnSync).toHaveBeenCalledWith(process.execPath, [join(root, entry)], expect.any(Object));
  });

  it.each([true, false])('library import from an unlisted scripts entry stays silent (tools counterpart: %s)', async counterpart => {
    const runner = 'scripts/pr-land.mjs';
    write(join(ownRoot, runner), '// local runner');
    if (counterpart) write(join(root, runner), '// tools runner');
    const o = { ...guardOptions(), entryUrl: pathToFileURL(join(ownRoot, runner)),
      argv: [process.execPath, join(ownRoot, runner)], git: vi.fn(git) };
    await maybeReexecFromToolsRoot(o);
    expect(o.spawnSync).not.toHaveBeenCalled();
    expect(o.log).not.toHaveBeenCalled();
    expect(o.appendEvent).not.toHaveBeenCalled();
    expect(o.git).not.toHaveBeenCalled();
  });

  it.each(rejectionCases)('rejects the explicit resolver reason: %s', (reason, arrange) => {
    arrange(options);
    expect(resolveToolsRoot(options)).toEqual({ active: false, reason });
  });

  it('requires a table-driven case for every explicit resolver rejection reason', () => {
    const source = fs.readFileSync(new URL('../tools-root.mjs', import.meta.url), 'utf8');
    const reasons = [...source.matchAll(/throw Error\('([^']+)'\)/g)].map(match => match[1]);
    expect(reasons.sort()).toEqual(rejectionCases.map(([reason]) => reason).sort());
  });

  it('keeps first-import guard wiring and the declared entry allowlist in sync', () => {
    const guarded = [];
    const visit = rel => {
      for (const entry of fs.readdirSync(resolve(rel), { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        const path = `${rel}/${entry.name}`;
        if (entry.isDirectory()) visit(path);
        else if (entry.name.endsWith('.mjs')) {
          const imports = fs.readFileSync(resolve(path), 'utf8').match(/^import .*$/gm) ?? [];
          if (imports.some(line => /from ['"].*tools-root-guard\.mjs|^import ['"].*tools-root-guard\.mjs/.test(line))) {
            expect(imports[0], path).toMatch(/tools-root-guard/);
            guarded.push(path);
          }
        }
      }
    };
    visit('scripts');
    expect(guarded.sort()).toEqual([...TOOLS_ROOT_ENTRIES].sort());
  });

  it.each(['node_modules/vitest/vitest.mjs', 'other-script.mjs', 'scripts-other/run.mjs', 'scripts/pr-land.mjs',
    'scripts/nested/runner.mjs',
    'scripts/__tests__/runner.mjs', 'scripts/nested/__tests__/runner.mjs', 'scripts/node_modules/runner.mjs',
  ])('silently leaves library entrypoint %s local even when tools.root contains it', entry => {
    write(join(ownRoot, entry), '// local runner');
    write(join(root, entry), '// tools runner');
    const o = { ...guardOptions(), entryUrl: pathToFileURL(join(ownRoot, entry)),
      argv: [process.execPath, join(ownRoot, entry)], git: vi.fn(git) };
    maybeReexecFromToolsRoot(o);
    expect(o.spawnSync).not.toHaveBeenCalled();
    expect(o.exit).not.toHaveBeenCalled();
    expect(o.log).not.toHaveBeenCalled();
    expect(o.appendEvent).not.toHaveBeenCalled();
    expect(o.git).not.toHaveBeenCalled();
  });

  it.each(['node_modules/vitest/vitest.mjs', 'scripts/__tests__/runner.mjs', '../outside.mjs'])
    ('silently rejects a scripts entrypoint whose realpath is %s', target => {
      write(join(ownRoot, target), '// runner');
      const alias = join(ownRoot, 'scripts/alias.mjs');
      fs.symlinkSync(join(ownRoot, target), alias);
      write(join(root, 'scripts/alias.mjs'), '// tools runner');
      const o = { ...guardOptions(), entryUrl: pathToFileURL(alias), argv: [process.execPath, alias] };
      maybeReexecFromToolsRoot(o);
      expect(o.spawnSync).not.toHaveBeenCalled();
      expect(o.exit).not.toHaveBeenCalled();
      expect(o.log).not.toHaveBeenCalled();
      expect(o.appendEvent).not.toHaveBeenCalled();
    });

  it('silently continues locally when the entrypoint realpath is unavailable', () => {
    fs.rmSync(join(ownRoot, script));
    const o = guardOptions();
    maybeReexecFromToolsRoot(o);
    expect(o.spawnSync).not.toHaveBeenCalled();
    expect(o.exit).not.toHaveBeenCalled();
    expect(o.log).not.toHaveBeenCalled();
    expect(o.appendEvent).not.toHaveBeenCalled();
  });

  it('uses WE_PLATFORM_PREFERENCES and reports unreadable or malformed preferences', () => {
    const path = join(base, 'custom.json');
    write(path, JSON.stringify({ tools: { root } }));
    expect(resolveToolsRoot({ ...options, env: { WE_PLATFORM_PREFERENCES: path } }).active).toBe(true);
    write(path, '{broken');
    expect(resolveToolsRoot({ ...options, env: { WE_PLATFORM_PREFERENCES: path } })).toEqual({ active: false, reason: expect.any(String) });
    expect(resolveToolsRoot({ ...options, env: {}, fs: { ...fs, openSync: () => { throw Error('denied'); } } }).reason).toBe('denied');
  });

  it.each(['relative', 'missing script', 'not a repo', 'wrong package', 'bad git', 'not a checkout root', 'unknown sha'])('falls back with one diagnostic for %s', async kind => {
    const o = guardOptions();
    if (kind === 'relative') o.env.WE_TOOLS_ROOT = 'relative';
    if (kind === 'missing script') fs.rmSync(join(root, script));
    if (kind === 'not a repo') fs.rmSync(join(root, '.git'), { recursive: true });
    if (kind === 'wrong package') write(join(root, 'package.json'), '{"name":"other"}');
    if (kind === 'bad git') o.git = () => ({ status: 1, stderr: 'fatal' });
    if (kind === 'not a checkout root') o.git = (path, args) => ({ status: 0, stdout: args.includes('HEAD') ? sha : ownRoot });
    if (kind === 'unknown sha') o.git = (path, args) => ({ status: 0, stdout: args.includes('HEAD') ? '' : path });
    await maybeReexecFromToolsRoot(o);
    expect(o.spawnSync).not.toHaveBeenCalled();
    expect(o.exit).not.toHaveBeenCalled();
    expect(o.log).toHaveBeenCalledTimes(1);
    expect(o.log).toHaveBeenCalledWith(expect.stringMatching(/^\[tools-root\] ignored: .+/));
  });

  it.each(['workspace/.lanes/pool/lane-1', 'other/.lanes/pool/lane-1', 'workspace/.daemon-clones/review/v1', 'workspace/web-everything-review-daemon'])('refuses lane/daemon clone %s directly and through a symlink', part => {
    const target = join(home, part); checkout(target);
    const alias = join(base, 'alias'); fs.symlinkSync(target, alias);
    for (const path of [target, alias]) {
      expect(resolveToolsRoot({ ...options, env: { WE_TOOLS_ROOT: path } })).toEqual({ active: false, reason: expect.stringMatching(/lane or daemon/) });
    }
  });

  it('refuses lexical lane aliases even when they resolve outside the pool', () => {
    const alias = join(home, 'workspace/.lanes/alias');
    fs.mkdirSync(dirname(alias), { recursive: true }); fs.symlinkSync(root, alias);
    expect(resolveToolsRoot({ ...options, env: { WE_TOOLS_ROOT: alias } }).active).toBe(false);
  });

  it('same checkout through a symlink means no action', () => {
    const alias = join(base, 'same'); fs.symlinkSync(root, alias);
    expect(resolveToolsRoot({ ...options, ownRoot: alias })).toEqual({ active: false });
  });

  it('refuses an escaping script, including symlink escapes', () => {
    expect(resolveToolsRoot({ ...options, scriptRelPath: '../escape.mjs' }).active).toBe(false);
    fs.rmSync(join(root, script)); fs.symlinkSync(join(ownRoot, script), join(root, script));
    expect(resolveToolsRoot(options).active).toBe(false);
  });

  it.each(['preferences', 'package'])('bounds %s read requests and cumulative bytes, with local fallback for oversized input', kind => {
    const limit = 256 * 1024;
    const path = kind === 'preferences' ? join(base, 'oversized.json') : join(root, 'package.json');
    write(path, ' '.repeat(limit * 2 + 17));
    let bytesRead = 0;
    const requests = [];
    const observedFs = {
      ...fs,
      readFileSync: vi.fn(fs.readFileSync),
      readSync: vi.fn((fd, buffer, offset, length, position) => {
        requests.push({ offset, length, bytesReadBefore: bytesRead });
        // Force short reads so the bound must hold across multiple requests.
        const count = fs.readSync(fd, buffer, offset, Math.min(length, 8192), position);
        bytesRead += count;
        return count;
      }),
    };
    const result = resolveToolsRoot({ ...options, fs: observedFs,
      env: kind === 'preferences' ? { WE_PLATFORM_PREFERENCES: path } : env,
    });
    expect(result).toEqual({ active: false, reason: expect.stringMatching(/byte limit.*local/) });
    expect(observedFs.readFileSync).not.toHaveBeenCalled();
    expect(requests.length).toBeGreaterThan(1);
    for (const { offset, length, bytesReadBefore } of requests) {
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(length).toBeGreaterThan(0);
      expect(offset + length).toBeLessThanOrEqual(limit + 1);
      expect(length).toBeLessThanOrEqual(limit + 1 - bytesReadBefore);
    }
    expect(bytesRead).toBe(limit + 1);
  });

  it('appends an event only when root or sha changes, across guard invocations', async () => {
    const o = guardOptions();
    await maybeReexecFromToolsRoot(o);
    expect(JSON.parse(fs.readFileSync(join(dirname(env.WE_DAEMON_EVENTS), 'tools-root-last.json'), 'utf8')))
      .toEqual({ root, sha });
    await maybeReexecFromToolsRoot(o);
    expect(o.appendEvent).toHaveBeenCalledTimes(1);
    expect(o.appendEvent.mock.calls[0][0]).toEqual({ kind: 'tools-root-override', detail: { root, sha, script } });
    o.git = (path, args) => ({ status: 0, stdout: args.includes('HEAD') ? 'b'.repeat(40) : path });
    await maybeReexecFromToolsRoot(o);
    expect(o.appendEvent).toHaveBeenCalledTimes(2);
    const other = join(base, 'other-tools'); checkout(other); o.env.WE_TOOLS_ROOT = other;
    await maybeReexecFromToolsRoot(o);
    expect(o.appendEvent).toHaveBeenCalledTimes(3);
  });

  it('does not persist an event that failed to append; storage failures still launch tooling', async () => {
    const o = guardOptions(); o.appendEvent.mockReturnValue(false);
    await maybeReexecFromToolsRoot(o); await maybeReexecFromToolsRoot(o);
    expect(o.appendEvent).toHaveBeenCalledTimes(2);
    o.appendEvent.mockImplementation(() => { throw Error('denied'); });
    await maybeReexecFromToolsRoot(o);
    expect(o.spawnSync).toHaveBeenCalledTimes(3);
  });

  it('signal exits as 1, while spawn errors and thrown seams continue locally', async () => {
    const o = guardOptions(); o.spawnSync.mockReturnValue({ signal: 'SIGTERM', status: null });
    await maybeReexecFromToolsRoot(o); expect(o.exit).toHaveBeenCalledWith(1);
    o.exit.mockClear(); o.spawnSync.mockReturnValue({ error: Error('missing executable'), status: null });
    await maybeReexecFromToolsRoot(o); expect(o.exit).not.toHaveBeenCalled();
    o.spawnSync.mockImplementation(() => { throw Error('failed spawn'); });
    expect(() => maybeReexecFromToolsRoot(o)).not.toThrow();
    o.git = () => { throw Error('failed git'); };
    expect(() => maybeReexecFromToolsRoot(o)).not.toThrow();
  });

  it('strips control characters from the single invalid-setting diagnostic', async () => {
    const o = guardOptions(); o.git = () => { throw Error('bad\n\u001b[31mevidence'); };
    await maybeReexecFromToolsRoot(o);
    expect(o.log).toHaveBeenCalledTimes(1);
    expect(o.log).toHaveBeenCalledWith('[tools-root] ignored: bad  [31mevidence');
  });

  it.each(['node_modules/vitest/vitest.mjs', 'scripts/pr-land.mjs'])
    ('importing a guarded module from %s preserves local execution without logs or events', runner => {
    const repo = resolve('.');
    const gitDir = realSpawnSync('git', ['rev-parse', '--absolute-git-dir'], { encoding: 'utf8', cwd: repo }).stdout.trim();
    fs.rmSync(join(root, '.git'), { recursive: true }); fs.symlinkSync(gitDir, join(root, '.git'));
    for (const name of ['tools-root-guard.mjs', 'tools-root.mjs', 'daemon-clone-layout.mjs']) {
      write(join(ownRoot, 'scripts/lib', name), fs.readFileSync(join(repo, 'scripts/lib', name), 'utf8'));
    }
    const eventsUrl = pathToFileURL(join(repo, 'scripts/lib/daemon-events.mjs')).href;
    write(join(ownRoot, 'scripts/lib/daemon-events.mjs'), `export { appendDaemonEvent, daemonEventsPath } from ${JSON.stringify(eventsUrl)};\n`);
    write(join(ownRoot, script), "import '../lib/tools-root-guard.mjs';\n");
    const guardedUrl = pathToFileURL(join(ownRoot, script)).href;
    write(join(ownRoot, runner), `import ${JSON.stringify(guardedUrl)};\nconsole.log('local runner');\n`);
    write(join(root, runner), "console.log('tools runner'); process.exitCode=9;\n");
    const result = realSpawnSync(process.execPath, [join(ownRoot, runner)], {
      cwd: ownRoot, env: { ...process.env, ...env, WE_TOOLS_ROOT_REEXEC: undefined,
        WE_PLATFORM_PREFERENCES: join(base, 'absent.json') }, encoding: 'utf8', timeout: 15000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('local runner\n');
    expect(result.stderr).toBe('');
    expect(fs.existsSync(env.WE_DAEMON_EVENTS)).toBe(false);
    expect(fs.existsSync(join(dirname(env.WE_DAEMON_EVENTS), 'tools-root-last.json'))).toBe(false);
  });

  it.each(['timeout', 'excessive output'])
    ('default event writer remains bounded and launches tooling after %s', kind => {
      const childEnv = liveGuardFixture();
      const missedBound = join(base, 'writer-outlived-bound');
      // Each fixture self-terminates even if a bound regresses. The sentinel distinguishes
      // maxBuffer recovery from the independent timeout, without timing the test runner.
      write(join(ownRoot, 'scripts/lib/daemon-events.mjs'), `
        import { writeFileSync } from 'node:fs';
        export const daemonEventsPath = ({env}) => env.WE_DAEMON_EVENTS;
        export async function appendDaemonEvent() {
          ${kind === 'excessive output' ? "process.stdout.write('x'.repeat(128 * 1024));" : ''}
          await new Promise(resolve => setTimeout(resolve, ${kind === 'timeout' ? 7000 : 1500}));
          writeFileSync(${JSON.stringify(missedBound)}, 'writer exceeded its bound');
          return false;
        }
      `);
      write(join(ownRoot, script), "import '../lib/tools-root-guard.mjs';\nthrow Error('local entry ran');\n");
      write(join(root, script), "console.log('selected tooling'); process.exitCode=9;\n");
      const result = realSpawnSync(process.execPath, [join(ownRoot, script)], {
        cwd: ownRoot, env: childEnv, encoding: 'utf8', timeout: 15000,
      });
      expect(result.status, result.stderr).toBe(9);
      expect(result.stdout).toBe('selected tooling\n');
      expect(fs.existsSync(missedBound)).toBe(false);
      expect(fs.existsSync(join(dirname(env.WE_DAEMON_EVENTS), 'tools-root-last.json'))).toBe(false);
    }, 20000);

  it('runs the actual first-import guard before entry dependencies, preserving the real lane cwd and child exit status', () => {
    // Use the current git directory read-only, with a separate work tree, so no fixture commit is needed.
    const repo = resolve('.');
    const gitDir = realSpawnSync('git', ['rev-parse', '--absolute-git-dir'], { encoding: 'utf8', cwd: repo }).stdout.trim();
    const tool = join(base, 'live-tools'); checkout(tool);
    fs.rmSync(join(tool, '.git'), { recursive: true }); fs.symlinkSync(gitDir, join(tool, '.git'));
    for (const name of ['tools-root-guard.mjs', 'tools-root.mjs', 'daemon-clone-layout.mjs']) {
      write(join(ownRoot, 'scripts/lib', name), fs.readFileSync(join(repo, 'scripts/lib', name), 'utf8'));
    }
    const eventsUrl = pathToFileURL(join(repo, 'scripts/lib/daemon-events.mjs')).href;
    write(join(ownRoot, 'scripts/lib/daemon-events.mjs'), `export { appendDaemonEvent, daemonEventsPath } from ${JSON.stringify(eventsUrl)};\n`);
    const local = join(repo, script);
    const entry = join(ownRoot, script);
    write(join(ownRoot, 'scripts/readiness/local-dependency.mjs'), "throw Error('local dependency ran');\n");
    write(entry, "import '../lib/tools-root-guard.mjs';\nimport './local-dependency.mjs';\nthrow Error('local body ran');\n");
    write(join(tool, script), `console.log(JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(2),marker:process.env.WE_TOOLS_ROOT_REEXEC})); process.exitCode=9;\n`);
    const result = realSpawnSync(process.execPath, [entry, 'literal $()', 'two words'], {
      cwd: ownRoot, env: { ...process.env, ...env, WE_TOOLS_ROOT: tool, WE_TOOLS_ROOT_REEXEC: undefined,
        WE_PLATFORM_PREFERENCES: join(base, 'absent.json') }, encoding: 'utf8', timeout: 15000,
    });
    expect(result.status, result.stderr).toBe(9);
    expect(JSON.parse(result.stdout)).toEqual({ cwd: ownRoot, argv: ['literal $()', 'two words'], marker: tool });
    expect(result.stderr).toContain(`[tools-root] running ${script}`);
    const recorded = fs.readFileSync(env.WE_DAEMON_EVENTS, 'utf8').trim().split('\n').map(JSON.parse);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ kind: 'tools-root-override', detail: { root: tool, script, sha: expect.stringMatching(/^[a-f0-9]{40}$/) } });
    expect(JSON.parse(fs.readFileSync(join(dirname(env.WE_DAEMON_EVENTS), 'tools-root-last.json'), 'utf8')))
      .toEqual({ root: tool, sha: recorded[0].detail.sha });
    // All three rollout entry points must evaluate the guard before any other imports.
    for (const path of [local, join(repo, 'scripts/readiness/remote-exec.mjs'), join(repo, 'scripts/verify-lane.mjs')]) {
      expect(fs.readFileSync(path, 'utf8').match(/^import .*$/m)?.[0]).toMatch(/tools-root-guard/);
    }
  });
});
