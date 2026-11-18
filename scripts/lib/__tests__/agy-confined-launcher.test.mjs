// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultSpawnAgy } from '../agy-confined-build.mjs';
import { agyRunEvidence, readAgyHold, saveAgyHold } from '../antigravity-run-evidence.mjs';

const host = vi.hoisted(() => ({ home: null }));
vi.mock('node:os', async importOriginal => {
  const original = await importOriginal();
  return { ...original, homedir: () => host.home ?? original.homedir() };
});
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal(), spawn: vi.fn() }));

const roots = [];
afterEach(() => {
  host.home = null;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'we-agy-launcher-test-')));
  roots.push(root);
  host.home = join(root, 'home');
  const cli = join(host.home, 'bin/agy');
  const dir = join(root, 'clone');
  const laneDir = join(root, 'lane');
  for (const p of [dirname(cli), dir, laneDir]) mkdirSync(p, { recursive: true });
  mkdirSync(join(host.home, '.gemini/antigravity-cli'), { recursive: true });
  mkdirSync(join(host.home, '.gemini/config/projects'), { recursive: true });
  writeFileSync(join(host.home, '.gemini/antigravity-cli/settings.json'), '{}', { mode: 0o600 });
  writeFileSync(join(host.home, '.gemini/config/config.json'), '{}', { mode: 0o600 });
  writeFileSync(cli, '#!/bin/sh\nexit 0\n');
  chmodSync(cli, 0o700);
  vi.stubEnv('ANTIGRAVITY_QUOTA_DIR', join(root, 'quota'));
  const options = { cli, dir, laneDir, task: 'repair', model: 'gemini-test', stream: false, logFile: join(root, 'events.jsonl') };
  return { root, options };
}

it('production launcher consults persisted quota holds and refuses before sandbox launch', async () => {
  const { options } = fixture();
  saveAgyHold(agyRunEvidence({ requestedModel: options.model, stderr: 'RESOURCE_EXHAUSTED Resets in 1h' }));
  const result = await defaultSpawnAgy(options);
  expect(result).toMatchObject({ code: 1, fallbackDecision: 'skip-quota-hold', modelEvidence: 'not-launched' });
  expect(spawn).not.toHaveBeenCalled();
});

it('production sandbox callback records quota exhaustion using the real store and passes a scrubbed environment', async () => {
  const { options } = fixture();
  vi.stubEnv('GH_TOKEN', 'must-not-reach-child');
  vi.stubEnv('SSH_AUTH_SOCK', '/host-agent');
  spawn.mockImplementation((bin, args, opts) => {
    expect(bin).toBe('/usr/bin/sandbox-exec');
    expect(args).toContain(realpathSync(options.cli));
    const profile = readFileSync(args[1], 'utf8');
    expect(profile).toContain(`(subpath ${JSON.stringify(dirname(options.cli))})`);
    expect(opts.env).not.toHaveProperty('GH_TOKEN');
    expect(opts.env).not.toHaveProperty('SSH_AUTH_SOCK');
    expect(opts.env).not.toHaveProperty('ANTIGRAVITY_QUOTA_DIR');
    expect(opts.env.TMPDIR).toBe(opts.env.TMP);
    expect(opts.env.TMPDIR).toBe(opts.env.TEMP);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    queueMicrotask(() => {
      child.stderr.write('RESOURCE_EXHAUSTED Resets in 1h');
      child.emit('close', 1);
    });
    return child;
  });
  expect(readAgyHold(options.model)).toBeNull();
  expect(await defaultSpawnAgy(options)).toMatchObject({ code: 1, quotaState: 'exhausted' });
  expect(readAgyHold(options.model)).toMatchObject({ fallbackDecision: 'skip-quota-hold', heldBackend: 'google' });
  expect(spawn).toHaveBeenCalledOnce();
  expect(await defaultSpawnAgy(options)).toMatchObject({ fallbackDecision: 'skip-quota-hold' });
  expect(spawn).toHaveBeenCalledOnce();
});

it('resolves the binary symlink and refuses a target under home/workspace', async () => {
  const { options } = fixture();
  const target = join(host.home, 'workspace/bin/agy');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, '#!/bin/sh\nexit 0\n');
  chmodSync(target, 0o700);
  const link = join(host.home, 'bin/redirected-agy');
  symlinkSync(target, link);
  await expect(defaultSpawnAgy({ ...options, cli: link })).rejects.toThrow('binary overlaps workspace');
  expect(spawn).not.toHaveBeenCalled();
});

it('fails closed on an unresolved executable with an operator fallback', async () => {
  const { options } = fixture();
  await expect(defaultSpawnAgy({ ...options, cli: join(host.home, 'missing-agy') }))
    .rejects.toThrow('use another provider or request operator review');
  expect(spawn).not.toHaveBeenCalled();
});
