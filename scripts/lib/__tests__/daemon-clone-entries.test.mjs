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
