// @vitest-environment node
/**
 * @file scripts/operations/daemons-render.test.mjs
 * @description Portable daemon rendering and read-only installation comparison contracts.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_MANIFEST } from '../../../skills-src/conveyor/daemon-manifest.mjs';
import { validateTable, renderPlist, renderAll, diffPlists } from '../daemons-render.mjs';
import { readTable, writeOutDir, readInstalled, main } from '../daemons-render-io.mjs';

const host = { home: '/home/studio', nodePath: '/opt/node/bin/node', path: '/opt/node/bin:/usr/bin:/bin' };
const task = { label: 'test.daemon', program: ['{node}', '{home}/job.mjs'], runAtLoad: true, keepAlive: false };
const table = tasks => ({ version: 1, tasks });
const scratch = [];
const temp = () => { const dir = mkdtempSync(join(process.env.TMPDIR, 'daemons-render-')); scratch.push(dir); return dir; };
afterEach(() => { vi.unstubAllEnvs(); for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('daemon renderer', () => {
  it('validates the shipped table and covers all 23 labels deterministically', () => {
    const source = readTable();
    expect(() => validateTable(source)).not.toThrow();
    const files = renderAll(source, host);
    expect(files).toHaveLength(23);
    expect(new Set(files.map(file => file.label)).size).toBe(23);
    expect(files).toEqual(renderAll(source, host));
    for (const file of files) {
      expect(file.file).toBe(`${file.label}.plist`);
      expect(file.xml).not.toContain('/Users/');
      expect(file.xml).not.toContain('{home}');
    }
  });

  it.each([
    ['unknown task key', { ...task, surprise: true }, /unknown/i],
    ['unknown token', { ...task, program: ['{missing}'] }, /token/i],
    ['literal user home', { ...task, stdout: ['', 'Users', 'person', 'log'].join('/') }, /literal/i],
    ['literal linux home', { ...task, env: { SAFE: ['', 'home', 'person'].join('/') } }, /literal/i],
    ['invalid program', { ...task, program: [] }, /program/i],
    ['invalid interval', { ...task, startInterval: -1 }, /Interval/],
  ])('refuses %s', (_name, invalid, error) => {
    expect(() => validateTable(table([invalid]))).toThrow(error);
  });

  it('refuses unknown top-level keys and duplicate labels', () => {
    expect(() => validateTable({ ...table([task]), unknown: 1 })).toThrow(/unknown/i);
    expect(() => validateTable(table([task, task]))).toThrow(/duplicate/i);
  });

  it.each(['KEY', 'TOKEN', 'SECRET', 'PRIVATE', 'APP_ID', 'INSTALLATION', 'URL', 'PASSWORD', 'AUTH'])('refuses secret-like env key %s', key => {
    expect(() => validateTable(table([{ ...task, env: { [`WE_${key}`]: 'literal' } }]))).toThrow(/env/i);
  });

  it('checks pass arguments against the imported manifest and matching manifestPass', () => {
    const pass = Object.keys(DAEMON_MANIFEST)[0];
    expect(() => validateTable(table([{ ...task, program: ['node', `--pass=${pass}`], manifestPass: pass }]))).not.toThrow();
    for (const manifestPass of [undefined, 'missing-pass', Object.keys(DAEMON_MANIFEST)[1]]) {
      expect(() => validateTable(table([{ ...task, program: ['node', `--pass=${pass}`], manifestPass }]))).toThrow(/manifestPass/);
    }
  });

  it('omits hostEnvKeys values from both environment sources and lists pending names', () => {
    vi.stubEnv('WE_AUTH_TOKEN', 'private-sentinel');
    vi.stubEnv('PATH', 'ambient-path-sentinel');
    const [file] = renderAll(table([{ ...task, hostEnvKeys: ['WE_AUTH_TOKEN'], env: { Z: 'last', A: 'first' } }]), { ...host, WE_AUTH_TOKEN: 'overlay-sentinel' });
    expect(file.pendingHostEnv).toEqual(['WE_AUTH_TOKEN']);
    expect(file.xml).not.toMatch(/private-sentinel|overlay-sentinel|ambient-path-sentinel|WE_AUTH_TOKEN/);
    expect(file.xml).toContain(host.path);
    expect(file.xml.indexOf('<key>A</key>')).toBeLessThan(file.xml.indexOf('<key>Z</key>'));
    expect(() => renderPlist({ ...task, env: { SAFE: 'value' }, hostEnvKeys: ['SAFE'] }, host)).toThrow(/hostEnvKeys/);
  });

  it('XML-escapes hostile labels and arguments and round-trips their diff', () => {
    const label = `evil<&>"'`;
    const xml = renderPlist({ label, program: [label] }, host);
    expect(xml).toContain('evil&lt;&amp;&gt;&quot;&apos;');
    expect(diffPlists(xml, { Label: label, ProgramArguments: [label], EnvironmentVariables: { PATH: host.path } })).toEqual([]);
  });

  // The rendered publisher command runs under /bin/zsh on the macOS host. zsh is absent on Linux CI, so the
  // production-shell run is explicitly skipped there (visible as skipped) and a /bin/sh run always covers the
  // POSIX source's quoting.
  const metacharacterProbe = shellArgv => {
    const root = temp();
    const home = join(root, 'home-$(touch dollar-executed)-`touch backtick-executed`-$HOME-\'"&<>');
    const app = join(home, 'workspace/plateau-app');
    const bin = join(root, 'bin');
    mkdirSync(app, { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$PWD"\n', { mode: 0o700 });

    const publisher = readTable().tasks.find(entry => entry.label === 'com.plateau.wip-publisher');
    const xml = renderPlist(publisher, { ...host, home, path: `${bin}:/usr/bin:/bin` });
    const decode = text => text.replace(/&(amp|lt|gt|quot|apos);/g, (_match, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity]);
    const args = [...xml.match(/<array>([\s\S]*?)<\/array>/)[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map(match => decode(match[1]));
    const env = Object.fromEntries([...xml.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)[1].matchAll(/<key>([^<]*)<\/key>\s*<string>([\s\S]*?)<\/string>/g)].map(match => [decode(match[1]), decode(match[2])]));
    expect(env.WE_WIP_PUBLISH_HOME).toBe(home);
    expect(args.slice(0, 2)).toEqual(['/bin/zsh', '-lc']);
    expect(args[2]).not.toContain(home);
    const [shell, flags] = shellArgv(args);
    const output = execFileSync(shell, [...flags, args[2]], { cwd: root, env, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 });
    expect(output.trim()).toBe(realpathSync(app));
    expect(existsSync(join(root, 'dollar-executed'))).toBe(false);
    expect(existsSync(join(root, 'backtick-executed'))).toBe(false);
  };

  it.skipIf(!existsSync('/bin/zsh'))('preserves shell metacharacters in host.home without executing substitutions (rendered /bin/zsh)', () => {
    // Disable startup files for the probe; run the rendered shell source with only rendered env.
    metacharacterProbe(args => [args[0], ['-f', '-c']]);
  });

  it('preserves shell metacharacters in host.home without executing substitutions (POSIX /bin/sh)', () => {
    metacharacterProbe(() => ['/bin/sh', ['-c']]);
  });

  it('preserves booleans, intervals, paths and process type and reports leaf differences', () => {
    const xml = renderPlist({ ...task, workingDir: '{home}', stdout: '{home}/out', stderr: '{home}/err', startInterval: 20, throttleInterval: 0, processType: 'Background' }, host);
    const installed = { Label: task.label, ProgramArguments: [host.nodePath, `${host.home}/job.mjs`], RunAtLoad: true, KeepAlive: false, WorkingDirectory: host.home, StandardOutPath: `${host.home}/out`, StandardErrorPath: `${host.home}/err`, StartInterval: 20, ThrottleInterval: 0, ProcessType: 'Background', EnvironmentVariables: { PATH: 'old', WE_AUTH_TOKEN: 'secret' } };
    expect(diffPlists(xml, installed)).toEqual(['EnvironmentVariables.PATH', 'EnvironmentVariables.WE_AUTH_TOKEN']);
    expect(() => diffPlists('not XML', installed)).toThrow();
    expect(() => diffPlists(xml, null)).toThrow();
  });

  it('refuses actual HOME LaunchAgents when host-home differs', () => {
    const actualHome = temp();
    const selectedHome = temp();
    vi.stubEnv('HOME', actualHome);
    const launch = join(actualHome, 'Library/LaunchAgents');
    const files = renderAll(table([task]), { ...host, home: selectedHome });

    expect(() => writeOutDir(launch, files, { home: selectedHome })).toThrow(/LaunchAgents/);
    expect(existsSync(join(launch, files[0].file))).toBe(false);
    expect(existsSync(join(actualHome, 'Library'))).toBe(false);
  });

  it('writes only output files and refuses LaunchAgents and symlink aliases', () => {
    const home = temp();
    const launch = join(home, 'Library/LaunchAgents');
    mkdirSync(launch, { recursive: true });
    const alias = join(home, 'alias');
    symlinkSync(launch, alias);
    const files = renderAll(table([task]), host);
    for (const dir of [launch, join(launch, 'nested'), join(alias, 'nested')]) {
      expect(() => writeOutDir(dir, files, { home })).toThrow(/LaunchAgents/);
    }
    const out = join(home, 'rendered');
    writeOutDir(out, files, { home });
    expect(readFileSync(join(out, files[0].file), 'utf8')).toBe(files[0].xml);
    expect(() => writeOutDir(out, [{ ...files[0], file: '../escape.plist' }], { home })).toThrow(/filename/);
  });

  it('reads installed plists only through bounded plutil argv and propagates failure', () => {
    const exec = vi.fn(() => '{"Label":"test.daemon"}');
    expect(readInstalled(task.label, { home: host.home, exec })).toEqual({ Label: task.label });
    expect(exec).toHaveBeenCalledWith('plutil', ['-convert', 'json', '-o', '-', `${host.home}/Library/LaunchAgents/test.daemon.plist`], expect.objectContaining({ timeout: expect.any(Number), maxBuffer: expect.any(Number) }));
    expect(() => readInstalled('../escape', { home: host.home, exec })).toThrow();
    expect(() => readInstalled(task.label, { home: host.home, exec: () => { throw new Error('unreadable'); } })).toThrow(/unreadable/);
  });

  it('CLI renders with overrides and prints relative summaries without home paths', () => {
    const out = join(temp(), 'output');
    const log = vi.fn();
    main([`--out=${out}`, `--host-home=${host.home}`, `--node=${host.nodePath}`], { log });
    expect(readFileSync(join(out, 'com.webeverything.host-sampler.plist'), 'utf8')).toContain(host.nodePath);
    expect(log.mock.calls.flat().join('\n')).not.toContain(host.home);
    expect(() => main(['--unknown'], { log })).toThrow(/unknown/i);
  });

  it('dry-run reports per-label differences, pending names and incomplete evidence', () => {
    const log = vi.fn();
    const installedReader = vi.fn(() => ({}));
    const files = main(['--dry-run', `--host-home=${host.home}`, `--node=${host.nodePath}`], { log, installedReader });
    expect(installedReader).toHaveBeenCalledTimes(23);
    expect(files).toHaveLength(23);
    expect(log.mock.calls.flat().join('\n')).toContain('differences: EnvironmentVariables');
    expect(log.mock.calls.flat().join('\n')).toContain('pendingHostEnv:');
    expect(log.mock.calls.flat().join('\n')).not.toContain(host.home);
    log.mockClear();
    expect(() => main(['--dry-run', `--host-home=${host.home}`], { log, installedReader: () => { throw new Error(`${host.home}/private`); } })).toThrow(/incomplete/);
    expect(log.mock.calls.flat().join('\n')).toContain('inspect this installed plist and rerun');
    expect(log.mock.calls.flat().join('\n')).not.toContain(host.home);
  });
});
