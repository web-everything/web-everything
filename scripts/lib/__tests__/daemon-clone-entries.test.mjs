import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cloneRuntimeEntries } from '../daemon-clone-entries.mjs';
import { DAEMON_ENTRY_MODULES } from '../daemon-boot-smoke.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'clone-entries-'));
  dirs.push(dir);
  const root = join(dir, 'clone');
  const launchAgentsDir = join(dir, 'agents');
  mkdirSync(root); mkdirSync(launchAgentsDir);
  return { dir, root, launchAgentsDir };
}

it('unions clone-realpath LaunchAgents, mapped passes, caller entries and boot entries', () => {
  const f = fixture();
  const real = realpathSync(f.root);
  const alias = join(f.dir, 'alias');
  symlinkSync(f.root, alias);
  const programs = {
    'com.we.drain.plist': ['/usr/bin/node', join(real, 'scripts/drain.mjs')],
    'com.plateau.pass.plist': ['/usr/bin/node', join(real, 'skills-src/conveyor/pass-daemon.mjs'), '--pass=branch-drift'],
    'com.webeverything.other.plist': ['/usr/bin/node', `${real}-other/foreign.mjs`],
    'org.other.plist': ['/usr/bin/node', join(real, 'ignored.mjs')],
  };
  for (const name of Object.keys(programs)) writeFileSync(join(f.launchAgentsDir, name), 'plist');
  const calls = [];
  const result = cloneRuntimeEntries({ ...f, root: alias, entries: ['scripts/caller.mjs', 'scripts/drain.mjs'],
    run(bin, args, opts) {
      calls.push([bin, args, opts]);
      return { status: 0, stdout: JSON.stringify({ ProgramArguments: programs[args.at(-1).split('/').at(-1)] }) };
    },
  });
  expect(new Set(result)).toEqual(new Set([...DAEMON_ENTRY_MODULES, 'scripts/drain.mjs',
    'skills-src/conveyor/pass-daemon.mjs', 'scripts/conveyor/branch-drift.mjs', 'scripts/caller.mjs']));
  expect(calls).toHaveLength(3);
  expect(calls[0][0]).toBe('plutil');
  expect(calls[0][1].slice(0, 5)).toEqual(['-convert', 'json', '-o', '-', '--']);
  expect(calls[0][2].timeout).toBeGreaterThan(0);
  expect(calls[0][2].maxBuffer).toBeGreaterThan(0);
});

it('throws on unreadable LaunchAgents directory instead of silently narrowing entries', () => {
  const f = fixture();
  expect(() => cloneRuntimeEntries({ ...f, launchAgentsDir: join(f.dir, 'missing') })).toThrow();
});

it('discovers aliased LaunchAgent and caller entries and mapped passes while excluding external paths', () => {
  const f = fixture();
  const alias = join(f.dir, 'alias');
  symlinkSync(f.root, alias);
  mkdirSync(join(f.root, 'scripts'));
  writeFileSync(join(f.root, 'scripts', 'worker.mjs'), 'export {};');
  const external = join(f.dir, 'external');
  mkdirSync(external);
  writeFileSync(join(external, 'foreign.mjs'), 'export {};');
  symlinkSync(external, join(f.root, 'external-link'));
  symlinkSync(join(f.root, 'scripts', 'worker.mjs'), join(f.dir, 'worker-alias.mjs'));
  const programs = {
    'com.we.worker.plist': ['node', join(alias, 'scripts/worker.mjs')],
    'com.we.pass.plist': ['node', join(alias, 'skills-src/conveyor/pass-daemon.mjs'), '--pass=branch-drift'],
    'com.we.file-alias.plist': ['node', join(f.dir, 'worker-alias.mjs')],
    'com.we.external.plist': ['node', join(alias, 'external-link/foreign.mjs')],
    'com.we.prefix.plist': ['node', `${realpathSync(f.root)}-other/foreign.mjs`],
  };
  for (const name of Object.keys(programs)) writeFileSync(join(f.launchAgentsDir, name), 'plist');
  const run = (_bin, args) => ({ status: 0,
    stdout: JSON.stringify({ ProgramArguments: programs[args.at(-1).split('/').at(-1)] }) });
  for (const root of [f.root, alias]) {
    expect(new Set(cloneRuntimeEntries({ ...f, root, run })))
      .toEqual(new Set([...DAEMON_ENTRY_MODULES, 'scripts/worker.mjs',
        'skills-src/conveyor/pass-daemon.mjs', 'scripts/conveyor/branch-drift.mjs']));
    expect(cloneRuntimeEntries({ ...f, root, entries: [join(alias, 'scripts/caller.mjs')], run }))
      .toContain('scripts/caller.mjs');
  }
  expect(() => cloneRuntimeEntries({ ...f, entries: [join(alias, 'external-link/foreign.mjs')], run }))
    .toThrow('runtime entry outside clone');
});

it('discovers entries in the supplied environment HOME without changing the process HOME', () => {
  const f = fixture();
  const home = join(f.dir, 'home');
  const agents = join(home, 'Library', 'LaunchAgents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, 'com.we.isolated.plist'), 'plist');
  const ambientHome = process.env.HOME;
  const calls = [];
  const result = cloneRuntimeEntries({ root: f.root, env: { HOME: home },
    run(bin, args) {
      calls.push(args.at(-1));
      return { status: 0, stdout: JSON.stringify({
        ProgramArguments: ['node', join(realpathSync(f.root), 'isolated.mjs')],
      }) };
    },
  });
  expect(result).toContain('isolated.mjs');
  expect(calls).toEqual([join(agents, 'com.we.isolated.plist')]);
  expect(process.env.HOME).toBe(ambientHome);
});

it('fails closed on a cyclic LaunchAgent path instead of silently omitting it', () => {
  const f = fixture();
  symlinkSync('cycle', join(f.root, 'cycle'));
  writeFileSync(join(f.launchAgentsDir, 'com.we.cycle.plist'), 'plist');
  expect(() => cloneRuntimeEntries({ ...f, run: () => ({ status: 0,
    stdout: JSON.stringify({ ProgramArguments: ['node', join(f.root, 'cycle/worker.mjs')] }),
  }) })).toThrow();
});

it('fails closed when the supplied HOME has no readable LaunchAgents directory', () => {
  const f = fixture();
  let spawned = false;
  expect(() => cloneRuntimeEntries({ root: f.root, env: { HOME: join(f.dir, 'missing-home') },
    run() { spawned = true; },
  })).toThrow();
  expect(spawned).toBe(false);
});

it.each([
  { status: 1, stdout: '' }, { status: 0, stdout: '{' },
  { status: 0, stdout: '{}' }, { status: 0, stdout: '{"ProgramArguments":[42]}' },
])('throws on unreadable or malformed plist: %j', response => {
  const f = fixture();
  writeFileSync(join(f.launchAgentsDir, 'com.we.bad.plist'), 'bad');
  expect(() => cloneRuntimeEntries({ ...f, run: () => response })).toThrow();
});

it('refuses an unknown pass for this clone', () => {
  const f = fixture();
  writeFileSync(join(f.launchAgentsDir, 'com.we.pass.plist'), 'plist');
  expect(() => cloneRuntimeEntries({ ...f, run: () => ({ status: 0,
    stdout: JSON.stringify({ ProgramArguments: ['node', join(realpathSync(f.root), 'skills-src/conveyor/pass-daemon.mjs'), '--pass=unknown'] }),
  }) })).toThrow();
});

it.each(['scripts/daemon.mjs', './daemon.js', 'daemon.cjs', 'daemon.ts', 'relative/runner', '.', '..',
  'daemon.mts', 'daemon.py', 'daemon.cts', 'daemon.tsx', '--import=./x', '--import=package',
  '--require=./x', '--loader=./x', '--experimental-loader=./x',
  '--import', '--require', '--loader', '--experimental-loader', '-r./relative-module.cjs', '-rpackage', '-r'])(
  'refuses an unsupported LaunchAgent entrypoint/module argument: %s', entry => {
    const f = fixture();
    writeFileSync(join(f.launchAgentsDir, 'com.we.relative.plist'), 'plist');
    expect(() => cloneRuntimeEntries({ ...f, run: () => ({ status: 0,
      stdout: JSON.stringify({ ProgramArguments: ['/usr/bin/env', 'node', entry] }),
    }) })).toThrow(`LaunchAgents unsupported entrypoint/module argument refused: com.we.relative.plist: ${entry}`);
  });

it.each(['runner', 'daemon.mts', 'daemon.py'])('refuses an existing unsupported clone file: %s', entry => {
  const f = fixture();
  writeFileSync(join(f.root, entry), 'entrypoint');
  writeFileSync(join(f.launchAgentsDir, 'com.we.file.plist'), 'plist');
  const alias = join(f.dir, 'alias');
  symlinkSync(f.root, alias);
  for (const arg of [entry, join(realpathSync(f.root), entry)]) {
    expect(() => cloneRuntimeEntries({ ...f, root: alias, run: () => ({ status: 0,
      stdout: JSON.stringify({ ProgramArguments: ['/usr/bin/env', 'node', arg] }),
    }) })).toThrow(`LaunchAgents unsupported entrypoint/module argument refused: com.we.file.plist: ${arg}`);
  }
});

it.each([
  ['worker.mjs', 'worker.py'],
  ['worker.py', 'worker.mjs'],
])('refuses an absolute clone symlink with an unsupported argument or target extension: %s -> %s', (entry, target) => {
  const f = fixture();
  writeFileSync(join(f.root, target), 'entrypoint');
  const arg = join(f.root, entry);
  symlinkSync(target, arg);
  writeFileSync(join(f.launchAgentsDir, 'com.we.symlink.plist'), 'plist');
  expect(() => cloneRuntimeEntries({ ...f, run: () => ({ status: 0,
    stdout: JSON.stringify({ ProgramArguments: ['node', arg] }),
  }) })).toThrow(`LaunchAgents unsupported entrypoint/module argument refused: com.we.symlink.plist: ${arg}`);
});

it('refuses --import=./x even when its target exists in the clone', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'x'), 'export {};');
  writeFileSync(join(f.launchAgentsDir, 'com.we.loader.plist'), 'plist');
  expect(() => cloneRuntimeEntries({ ...f, run: () => ({ status: 0,
    stdout: JSON.stringify({ ProgramArguments: ['node', '--import=./x'] }),
  }) })).toThrow('LaunchAgents unsupported entrypoint/module argument refused: com.we.loader.plist: --import=./x');
});

it('fails closed on non-ENOENT filesystem errors for a bare argument', () => {
  const f = fixture();
  symlinkSync('runner', join(f.root, 'runner'));
  writeFileSync(join(f.launchAgentsDir, 'com.we.cycle.plist'), 'plist');
  expect(() => cloneRuntimeEntries({ ...f, run: () => ({ status: 0,
    stdout: JSON.stringify({ ProgramArguments: ['node', 'runner'] }),
  }) })).toThrow(expect.objectContaining({ code: 'ELOOP' }));
});

it('R230 permits bare interpreters, option flags and numeric argument tokens', () => {
  const f = fixture();
  writeFileSync(join(f.launchAgentsDir, 'com.we.tokens.plist'), 'plist');
  expect(new Set(cloneRuntimeEntries({ ...f, run: () => ({ status: 0,
    stdout: JSON.stringify({ ProgramArguments: ['/usr/bin/env', 'node', '--pass=x', '--pass=',
      '--repo=owner/repo', '--path=relative/file.js', '42'] }),
  }) }))).toEqual(new Set(DAEMON_ENTRY_MODULES));
});

it('permits --repo=owner/repo on a LaunchAgent with an absolute entrypoint', () => {
  const f = fixture();
  writeFileSync(join(f.launchAgentsDir, 'com.we.postmortem.plist'), 'plist');
  const entry = 'scripts/conveyor/pass-daemons/pr-postmortem-pass.mjs';
  expect(new Set(cloneRuntimeEntries({ ...f, run: () => ({ status: 0,
    stdout: JSON.stringify({ ProgramArguments: ['node', join(f.root, entry), '--repo=owner/repo', '--watch'] }),
  }) }))).toEqual(new Set([...DAEMON_ENTRY_MODULES, entry]));
});

it('permits node paths, absolute scripts, plain flags, pass names and numeric argument tokens', () => {
  const f = fixture();
  for (const entry of ['worker.mjs', 'worker.js', 'worker.cjs']) writeFileSync(join(f.root, entry), 'export {};');
  writeFileSync(join(f.launchAgentsDir, 'com.we.tokens.plist'), 'plist');
  expect(new Set(cloneRuntimeEntries({ ...f, run: () => ({ status: 0,
    stdout: JSON.stringify({ ProgramArguments: ['/usr/bin/env', 'node', '/usr/bin/node',
      join(f.root, 'worker.mjs'), join(f.root, 'worker.js'), join(f.root, 'worker.cjs'), '-e', '--no-warnings', '--pass=NAME', '42'] }),
  }) }))).toEqual(new Set([...DAEMON_ENTRY_MODULES, 'worker.mjs', 'worker.js', 'worker.cjs']));
});

it('refuses an extensionless in-clone LaunchAgent script entry instead of silently omitting it', () => {
  const f = fixture();
  mkdirSync(join(f.root, 'scripts'));
  writeFileSync(join(f.root, 'scripts', 'some-daemon'), 'entrypoint');
  writeFileSync(join(f.launchAgentsDir, 'com.we.ext.plist'), 'plist');
  for (const arg of [join(realpathSync(f.root), 'scripts/some-daemon'), 'scripts/some-daemon']) {
    expect(() => cloneRuntimeEntries({ ...f, run: () => ({ status: 0,
      stdout: JSON.stringify({ ProgramArguments: ['/usr/bin/node', arg] }),
    }) })).toThrow(`LaunchAgents unsupported entrypoint/module argument refused: com.we.ext.plist: ${arg}`);
  }
});
