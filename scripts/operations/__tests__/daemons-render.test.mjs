// @vitest-environment node
/**
 * @file scripts/operations/daemons-render.test.mjs
 * @description Portable daemon rendering and read-only installation comparison contracts.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_MANIFEST, resolveManifestEntry } from '../../../skills-src/conveyor/daemon-manifest.mjs';
import { runPassDaemonLoop } from '../../../skills-src/conveyor/pass-daemon.mjs';
import { sweepAdvisoryLabels } from '../../conveyor/advisory-label-sweep.mjs';
import { validateTable, renderPlist, renderAll, diffPlists, missingSiblingPasses, DEFERRED_SIBLING_PASSES } from '../daemons-render.mjs';
import { readTable, writeOutDir, readInstalled, main } from '../daemons-render-io.mjs';

const host = { home: '/home/studio', nodePath: '/opt/node/bin/node', path: '/opt/node/bin:/usr/bin:/bin' };
const task = { label: 'test.daemon', program: ['{node}', '{home}/job.mjs'], runAtLoad: true, keepAlive: false };
const table = tasks => ({ version: 1, tasks });
const scratch = [];
const temp = () => { const dir = mkdtempSync(join(process.env.TMPDIR, 'daemons-render-')); scratch.push(dir); return dir; };
afterEach(() => { vi.unstubAllEnvs(); for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('daemon renderer', () => {
  it('validates the shipped table and covers all 25 labels deterministically', () => {
    const source = readTable();
    expect(() => validateTable(source)).not.toThrow();
    const files = renderAll(source, host);
    expect(files).toHaveLength(25);
    expect(new Set(files.map(file => file.label)).size).toBe(25);
    expect(files).toEqual(renderAll(source, host));
    for (const file of files) {
      expect(file.file).toBe(`${file.label}.plist`);
      expect(file.xml).not.toContain('/Users/');
      expect(file.xml).not.toContain('{home}');
    }
  });

  it('leaves max live review rounds to review-concurrency settings in every shipped task and the review-daemon render', () => {
    const source = readTable();
    for (const shippedTask of source.tasks) {
      expect(shippedTask.env ?? {}, shippedTask.label).not.toHaveProperty('WE_REVIEW_MAX_LIVE_ROUNDS');
    }
    const reviewDaemon = renderAll(source, host).find(file => file.label === 'com.we.review-daemon');
    expect(reviewDaemon).toBeDefined();
    expect(reviewDaemon.xml).not.toContain('WE_REVIEW_MAX_LIVE_ROUNDS');
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

  // Rendered-output contract (no host shell): the publisher command reads the home from its environment, so a
  // hostile host.home is carried only as an XML-escaped environment value and is never substituted into the
  // shell source or interpreted by the renderer.
  const decode = text => text.replace(/&(amp|lt|gt|quot|apos);/g, (_match, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity]);
  const hostileHome = '/home-$(touch dollar-executed)-`touch backtick-executed`-$HOME-\'"&<>';
  const renderPublisher = () => {
    const publisher = readTable().tasks.find(entry => entry.label === 'com.plateau.wip-publisher');
    const xml = renderPlist(publisher, { ...host, home: hostileHome });
    const args = [...xml.match(/<array>([\s\S]*?)<\/array>/)[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map(match => decode(match[1]));
    const env = Object.fromEntries([...xml.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)[1].matchAll(/<key>([^<]*)<\/key>\s*<string>([\s\S]*?)<\/string>/g)].map(match => [decode(match[1]), decode(match[2])]));
    return { xml, args, env };
  };

  it('preserves shell metacharacters in host.home verbatim in the rendered environment and never in the command', () => {
    const { xml, args, env } = renderPublisher();
    expect(env.WE_WIP_PUBLISH_HOME).toBe(hostileHome);
    expect(env.WE_STATE_ROOT).toBe(`${hostileHome}/workspace/webeverything`);
    expect(args).toHaveLength(3);
    expect(args.slice(0, 2)).toEqual(['/bin/zsh', '-lc']);
    // Exact command pin: the only expansion is the double-quoted env reference in the cd, so no eval, unquoted
    // expansion or home substitution can enter without changing this string.
    expect(args[2]).toBe('cd "$WE_WIP_PUBLISH_HOME/workspace/plateau-app" && { git pull --ff-only --quiet || echo "wip-publisher: git pull skipped (offline or local changes) — running the code on disk"; } && exec npm run --silent wip:publish');
    expect(args[2].match(/\$/g)).toHaveLength(1);
    for (const fragment of ['dollar-executed', 'backtick-executed', hostileHome]) expect(args[2]).not.toContain(fragment);
    expect(xml).toContain('&quot;&amp;&lt;&gt;');
    expect(xml).not.toContain('{home}');
    expect(xml).toContain(`<string>${hostileHome.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')}/Library/Logs/plateau-wip-publisher.log</string>`);
  });

  // Shell-integration test: the ONE test that executes a host shell (the production /bin/zsh). Skipped with a
  // printed reason where zsh is absent (Linux CI); the contract above is asserted on rendered output regardless.
  const zshPresent = existsSync('/bin/zsh');
  if (!zshPresent) console.info('SKIP shell-integration test: /bin/zsh is absent on this host');
  it.skipIf(!zshPresent)('shell-integration: rendered publisher command runs under /bin/zsh without executing host.home substitutions', () => {
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
    const args = [...xml.match(/<array>([\s\S]*?)<\/array>/)[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map(match => decode(match[1]));
    const env = Object.fromEntries([...xml.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)[1].matchAll(/<key>([^<]*)<\/key>\s*<string>([\s\S]*?)<\/string>/g)].map(match => [decode(match[1]), decode(match[2])]));
    const output = execFileSync('/bin/zsh', ['-f', '-c', args[2]], { cwd: root, env, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 });
    expect(output.trim()).toBe(realpathSync(app));
    expect(existsSync(join(root, 'dollar-executed'))).toBe(false);
    expect(existsSync(join(root, 'backtick-executed'))).toBe(false);
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
    const home = temp();
    mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true });
    writeFileSync(join(home, 'Library/LaunchAgents', `${task.label}.plist`), 'x');
    expect(() => readInstalled(task.label, { home, exec: () => { throw new Error('unreadable'); } })).toThrow(/unreadable/);
    expect(() => readInstalled('absent.daemon', { home, exec: () => { throw new Error('unreadable'); } })).toThrow(expect.objectContaining({ code: 'PLIST_NOT_INSTALLED' }));
  });

  it('classifies a missing plutil executable as unreadable when the plist exists in both reporting modes', () => {
    const home = temp();
    const launch = join(home, 'Library/LaunchAgents');
    mkdirSync(launch, { recursive: true });
    const source = readTable();
    source.tasks.forEach(({ label }) => writeFileSync(join(launch, `${label}.plist`), 'x'));
    writeFileSync(join(launch, `${task.label}.plist`), 'x');
    const exec = () => { throw Object.assign(new Error('spawn plutil ENOENT'), { code: 'ENOENT' }); };
    const installedReader = label => readInstalled(label, { home, exec });
    expect(() => installedReader(task.label)).toThrow(expect.not.objectContaining({ code: 'ENOENT' }));
    const log = vi.fn();
    const saved = process.exitCode;
    try {
      main(['--check', `--host-home=${home}`], { log, installedReader });
      expect(process.exitCode).toBe(1);
      expect(log.mock.calls.flat().join('\n')).toContain('installed evidence unreadable');
      expect(log.mock.calls.flat().join('\n')).not.toContain('not installed:');
      log.mockClear();
      expect(() => main(['--dry-run', `--host-home=${home}`], { log, installedReader })).toThrow(/incomplete/);
      expect(log.mock.calls.flat().join('\n')).not.toContain('would create');
    } finally {
      process.exitCode = saved;
    }
  });

  it('CLI renders with overrides and prints relative summaries without home paths', () => {
    const out = join(temp(), 'output');
    const log = vi.fn();
    main([`--out=${out}`, `--host-home=${host.home}`, `--node=${host.nodePath}`], { log });
    expect(readFileSync(join(out, 'com.webeverything.host-sampler.plist'), 'utf8')).toContain(host.nodePath);
    expect(log.mock.calls.flat().join('\n')).not.toContain(host.home);
    expect(() => main(['--unknown'], { log })).toThrow(/unknown/i);
  });

  it('plans a job for every per-repo manifest pass whose -we sibling is scheduled, each scoped to its own repo', () => {
    const source = readTable();
    expect(missingSiblingPasses(source)).toEqual([]);
    const passes = source.tasks.map(t => t.manifestPass);
    for (const name of ['advisory-label-sweep-frontierui', 'advisory-label-sweep-plateau-app']) expect(passes).toContain(name);
    const gaps = missingSiblingPasses({ version: 1, tasks: source.tasks.filter(t => t.manifestPass !== 'advisory-label-sweep-frontierui') });
    expect(gaps.map(g => g.pass)).toEqual(['advisory-label-sweep-frontierui']);
    expect(gaps[0].repo).toMatch(/frontierui$/);
  });

  it.each([
    ['we', 'web-everything/web-everything'],
    ['frontierui', 'frontier-ui/frontierui'],
    ['plateau-app', 'plateauapp/plateau-app'],
  ])('scopes the scheduled advisory-label-sweep-%s job to exactly its own repository', (key, repo) => {
    const pass = `advisory-label-sweep-${key}`;
    const job = readTable().tasks.find(t => t.manifestPass === pass);
    expect(job).toBeDefined();
    expect(job.program.filter(a => a.startsWith('--pass='))).toEqual([`--pass=${pass}`]);
    expect(DAEMON_MANIFEST[pass].args.filter(a => a.startsWith('--repo='))).toEqual([`--repo=${repo}`]);
  });

  it('keeps both ci-red-recovery siblings unscheduled and reports both gaps when deferral is disabled', () => {
    const source = readTable();
    const deferred = ['ci-red-recovery-watch-frontierui', 'ci-red-recovery-watch-plateau-app'];
    expect(DEFERRED_SIBLING_PASSES).toEqual(deferred);
    expect(source.tasks.filter(t => deferred.includes(t.manifestPass))).toEqual([]);
    expect(missingSiblingPasses(source, DAEMON_MANIFEST, []).map(g => g.pass)).toEqual(deferred);
  });

  it('the scheduled frontierui pass repairs eligible advisory labels in one sweep', async () => {
    const job = readTable().tasks.find(t => t.manifestPass === 'advisory-label-sweep-frontierui');
    const passName = job.program.find(a => a.startsWith('--pass=')).slice(7);
    const entry = resolveManifestEntry(passName);
    expect(entry.script).toBe('scripts/conveyor/advisory-label-sweep.mjs');
    expect(entry.args).toEqual(['sweep', '--repo=frontier-ui/frontierui']);
    const head = 'b'.repeat(40);
    const labels = new Set(['review:human', 'review:awaiting-advisory']);
    const pr = () => ({
      number: 59, state: 'OPEN', headRefOid: head, labels: [...labels],
      comments: [{
        body: `**Verdict:** 🚦 human review required\n**Advisory outcome:** \`accept\`\nNet basis: \`${'a'.repeat(40)}..${head}\``,
        createdAt: '2026-11-25T12:00:00Z', author: { login: 'web-everything' },
      }],
    });
    const listPrs = vi.fn(() => [pr()]);
    const readPr = vi.fn(pr);
    const setLabels = vi.fn((_repo, _number, { add, remove }) => {
      if (add) labels.add(add);
      remove.forEach(label => labels.delete(label));
    });
    const runPass = vi.fn(async () => {
      const results = sweepAdvisoryLabels({
        repo: entry.args.find(a => a.startsWith('--repo=')).slice(7),
        listPrs, readPr, listUnpublishedStatuses: () => [], provider: { setLabels, ensureLabel: vi.fn() },
      });
      expect(results).toEqual([{ num: 59, add: 'advisory:accepted', remove: ['review:awaiting-advisory'] }]);
      return { code: 0 };
    });
    const onRunError = vi.fn();
    await runPassDaemonLoop({ runPass, sleep: vi.fn(), intervalMs: entry.intervalMs, maxRuns: 1, onRunError });
    expect(onRunError).not.toHaveBeenCalled();
    expect(runPass).toHaveBeenCalledTimes(1);
    expect(listPrs).toHaveBeenCalledWith({ repo: 'frontier-ui/frontierui' });
    expect(readPr).toHaveBeenCalledWith({ repo: 'frontier-ui/frontierui', number: 59 });
    expect(setLabels).toHaveBeenCalledTimes(1);
    expect(setLabels).toHaveBeenCalledWith('frontier-ui/frontierui', 59, {
      add: 'advisory:accepted', remove: ['review:awaiting-advisory'],
    });
    expect([...labels].sort()).toEqual(['advisory:accepted', 'review:human']);
  });

  it('--check lists missing and not-installed jobs read-only; dry-run says would create', () => {
    const log = vi.fn();
    const missing = Object.assign(new Error('x'), { code: 'PLIST_NOT_INSTALLED' });
    const reader = label => { if (label.endsWith('advisory-label-sweep-frontierui')) throw missing; return {}; };
    const saved = process.exitCode;
    main(['--check', `--host-home=${host.home}`], { log, installedReader: reader });
    expect(process.exitCode).toBe(1);
    process.exitCode = saved;
    expect(log.mock.calls.flat().join('\n')).toContain('not installed: com.we.conveyor-pass-daemon.advisory-label-sweep-frontierui');
    for (const bad of [
      () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); },
      () => { throw Object.assign(new Error('spawn'), { code: 'ENOENT' }); },
      () => null,
    ]) {
      process.exitCode = undefined;
      log.mockClear();
      main(['--check', `--host-home=${host.home}`], { log, installedReader: bad });
      expect(process.exitCode).toBe(1);
      expect(log.mock.calls.flat().join('\n')).toContain('installed evidence unreadable');
    }
    process.exitCode = saved;
    const noRunPass = readTable().tasks.map(t => (t.manifestPass === 'advisory-label-sweep-frontierui' ? { ...t, program: ['{node}', '{home}/other.mjs'] } : t));
    expect(missingSiblingPasses({ version: 1, tasks: noRunPass }).map(g => g.pass)).toEqual(['advisory-label-sweep-frontierui']);
    log.mockClear();
    main(['--dry-run', `--host-home=${host.home}`], { log, installedReader: reader });
    expect(log.mock.calls.flat().join('\n')).toContain('pendingHostEnv:');
    expect(log.mock.calls.flat().join('\n')).toMatch(/advisory-label-sweep-frontierui\.plist: not installed: would create \(scoped to [^)]*frontierui\)/);
  });

  it('dry-run reports per-label differences, pending names and incomplete evidence', () => {
    const log = vi.fn();
    const installedReader = vi.fn(() => ({}));
    const files = main(['--dry-run', `--host-home=${host.home}`, `--node=${host.nodePath}`], { log, installedReader });
    expect(installedReader).toHaveBeenCalledTimes(25);
    expect(files).toHaveLength(25);
    expect(log.mock.calls.flat().join('\n')).toContain('differences: EnvironmentVariables');
    expect(log.mock.calls.flat().join('\n')).toContain('pendingHostEnv:');
    expect(log.mock.calls.flat().join('\n')).not.toContain(host.home);
    log.mockClear();
    expect(() => main(['--dry-run', `--host-home=${host.home}`], { log, installedReader: () => { throw new Error(`${host.home}/private`); } })).toThrow(/incomplete/);
    expect(log.mock.calls.flat().join('\n')).toContain('inspect this installed plist and rerun');
    expect(log.mock.calls.flat().join('\n')).not.toContain(host.home);
  });
});

it('renders the host developer directory while preserving a task override', () => {
  expect(renderPlist(task, { ...host, developerDir: '/Library/Developer/CommandLineTools' })).toContain('<string>/Library/Developer/CommandLineTools</string>');
  expect(renderPlist({ ...task, env: { DEVELOPER_DIR: '/nonexistent/fake' } }, { ...host, developerDir: '/Library/Developer/CommandLineTools' })).toContain('<string>/nonexistent/fake</string>');
  expect(renderPlist(task, host)).not.toContain('<key>DEVELOPER_DIR</key>');
});
