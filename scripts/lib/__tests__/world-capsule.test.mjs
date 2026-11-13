import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SMOKE_CHECKS } from '../daemon-live-smoke.mjs';
import {
  createCapsuleRecorder, recordingRunChild, finalizeCapsule, writeCapsule,
  readCapsule, replayRunChild, readCapsuleState,
} from '../daemon-rebuild/world-capsule.mjs';

const sha256 = body => createHash('sha256').update(body).digest('hex');
const args = ['api', '--method', 'GET', 'repos/example/repo'];
const body = '{"id":42,"name":"repo"}\n';
const stateContent = Buffer.from([0, 255, 10, 65]);
let dir;
beforeEach(() => { dir = mkdtempSync(join(process.env.TMPDIR, 'world-capsule-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

async function fixture() {
  const recorder = createCapsuleRecorder();
  await recordingRunChild(async () => ({ stdout: body }), recorder)('gh', args);
  writeFileSync(join(dir, 'state.bin'), stateContent);
  return finalizeCapsule(recorder, { stateRoots: [{ root: dir, files: ['state.bin'] }] });
}

// Discover the writer's file without pinning an unspecified on-disk filename.
async function persisted(capsule) {
  const target = join(dir, 'capsule');
  await writeCapsule(target, capsule);
  const file = readdirSync(target).find(name => {
    try { return JSON.parse(readFileSync(join(target, name), 'utf8')).version === 1; }
    catch { return false; }
  });
  expect(file).toBeDefined();
  return { target, file: join(target, file) };
}

describe('world capsule (R649 S1)', () => {
  it('round-trips recorded stdout, canonical keys, SHA-256 hashes and binary state', async () => {
    const capsule = await fixture();
    expect(capsule.version).toBe(1);
    expect(capsule.gh).toEqual([{ key: `gh ${args.join('\u0000')}`, sha256: sha256(body), body }]);
    expect(capsule.state).toEqual([{
      root: dir, path: 'state.bin', sha256: sha256(stateContent),
      contentBase64: stateContent.toString('base64'),
    }]);
    expect(capsule.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await fixture()).manifestSha256).toBe(capsule.manifestSha256);
    const { target } = await persisted(capsule);
    const restored = await readCapsule(target);
    expect(restored).toEqual(capsule);
    expect(await replayRunChild(restored)('gh', args)).toBe(body);
    expect(Buffer.from(await readCapsuleState(restored, dir, 'state.bin'))).toEqual(stateContent);
  });

  it('records and replays the real gh-api-repo smoke row without persisting credentials', async () => {
    const row = SMOKE_CHECKS.find(check => check.name === 'gh-api-repo');
    expect(row).toBeDefined();
    const recorder = createCapsuleRecorder();
    const fakeInner = vi.fn(async () => ({ stdout: body }));
    const ctx = {
      ghChildEnv: { GH_TOKEN: 'gh\x70_SECRETSECRETSECRET1234567890' },
      budgets: { ghApiMs: 1000 }, runChild: recordingRunChild(fakeInner, recorder),
    };
    expect(await row.run(ctx)).toMatchObject({ ok: true });
    expect(fakeInner).toHaveBeenCalledTimes(1);
    expect(fakeInner.mock.calls[0][2]).toMatchObject({ env: ctx.ghChildEnv });
    const capsule = await finalizeCapsule(recorder, { stateRoots: [] });
    expect(capsule.gh).toHaveLength(1);
    for (const secret of ['GH_TOKEN', 'ghp_', 'Authorization']) {
      expect(JSON.stringify(capsule)).not.toContain(secret);
    }
    const replay = replayRunChild(capsule);
    expect(await row.run({ ...ctx, runChild: replay })).toMatchObject({ ok: true });
    await expect(replay('gh', ['api', 'repos/different/repo'])).rejects.toThrow('world-capsule miss');
  });

  it('fails closed on unrecorded commands, arguments and state paths or roots', async () => {
    const capsule = await fixture();
    const replay = replayRunChild(capsule);
    await expect(replay('node', args)).rejects.toThrow('world-capsule miss');
    await expect(replay('gh', [...args, '--paginate'])).rejects.toThrow('world-capsule miss');
    for (const [root, path] of [[dir, 'absent'], [join(dir, 'other'), 'state.bin']]) {
      await expect(async () => readCapsuleState(capsule, root, path)).rejects.toThrow('world-capsule miss');
    }
  });

  it.each(['body', 'gh sha', 'state content', 'state sha', 'manifest'])('rejects tampered %s on read', async kind => {
    const { target, file } = await persisted(await fixture());
    const capsule = JSON.parse(readFileSync(file, 'utf8'));
    if (kind === 'body') capsule.gh[0].body += 'tampered';
    if (kind === 'gh sha') capsule.gh[0].sha256 = '0'.repeat(64);
    if (kind === 'state content') capsule.state[0].contentBase64 = Buffer.from('tampered').toString('base64');
    if (kind === 'state sha') capsule.state[0].sha256 = '0'.repeat(64);
    if (kind === 'manifest') capsule.manifestSha256 = '0'.repeat(64);
    writeFileSync(file, JSON.stringify(capsule));
    await expect(async () => readCapsule(target)).rejects.toThrow();
  });

  it.each(['missing dir', 'missing file', 'empty file', 'not JSON', '{}', 'empty entries'])(
    'refuses %s instead of passing without evidence', async kind => {
      const { target, file } = await persisted(await fixture());
      if (kind === 'missing dir') rmSync(target, { recursive: true });
      else if (kind === 'missing file') rmSync(file);
      else {
        const text = kind === 'empty file' ? '' : kind === 'not JSON' ? 'not json' : kind === '{}' ? '{}'
          : JSON.stringify({ version: 1, gh: [], state: [], manifestSha256: '0'.repeat(64) });
        writeFileSync(file, text);
      }
      await expect(async () => readCapsule(target)).rejects.toThrow();
    },
  );

  it('refuses finalization with no recorded evidence', async () => {
    await expect(async () => finalizeCapsule(createCapsuleRecorder(), { stateRoots: [] })).rejects.toThrow();
  });

  it('refuses a missing listed state file even when gh evidence exists', async () => {
    const recorder = createCapsuleRecorder();
    await recordingRunChild(async () => body, recorder)('gh', args);
    await expect(async () => finalizeCapsule(recorder, {
      stateRoots: [{ root: dir, files: ['absent'] }],
    })).rejects.toThrow();
  });

  it.each([
    ['api', '--method', 'POST', 'repos/example/repo'],
    ['api', '-X', 'DELETE', 'repos/example/repo'],
    ['api', '--method=POST', 'repos/example/repo'],
    ...['-f', '-F', '--input'].map(flag => ['api', '--method', 'GET', 'repos/example/repo', flag, 'value']),
    ['pr', 'merge', '42'],
  ])('rejects mutating gh arguments %j before calling inner', async (...argv) => {
    const inner = vi.fn();
    await expect(recordingRunChild(inner, createCapsuleRecorder())('gh', argv)).rejects.toThrow();
    expect(inner).not.toHaveBeenCalled();
  });

  it.each([
    ['api', 'repos/example/repo'], ['api', '-X', 'GET', 'repos/example/repo'],
    ...['pr', 'issue', 'run'].flatMap(command => ['list', 'view'].map(action => [command, action, '--repo', 'o/r'])),
  ])('records read-only gh arguments %j from string results', async (...argv) => {
    const recorder = createCapsuleRecorder();
    const inner = vi.fn(async () => body);
    const opts = { env: { GH_TOKEN: 'ghp_secret' }, headers: { Authorization: 'Bearer secret' } };
    expect(await recordingRunChild(inner, recorder)('gh', argv, opts)).toBe(body);
    expect(inner).toHaveBeenCalledWith('gh', argv, opts);
    const capsule = await finalizeCapsule(recorder, { stateRoots: [] });
    expect(capsule.gh).toEqual([{ key: `gh ${argv.join('\u0000')}`, sha256: sha256(body), body }]);
    expect(JSON.stringify(capsule)).not.toMatch(/GH_TOKEN|ghp_|Authorization|Bearer |headers/);
  });

  it('passes non-gh commands through without recording', async () => {
    const recorder = createCapsuleRecorder();
    const result = { stdout: 'local result' };
    const inner = vi.fn(async () => result);
    const opts = { timeoutMs: 1000 };
    expect(await recordingRunChild(inner, recorder)('node', ['--version'], opts)).toBe(result);
    expect(inner).toHaveBeenCalledWith('node', ['--version'], opts);
    await expect(async () => finalizeCapsule(recorder, { stateRoots: [] })).rejects.toThrow();
  });

  it.each(['Authorization', 'ghp_', 'gho_', 'ghs_', 'github_\x70at_', 'Bearer '])(
    'refuses a secret-looking body containing %s', async secret => {
      const recorder = createCapsuleRecorder();
      await expect(recordingRunChild(async () => ({ stdout: `prefix ${secret}secret` }), recorder)(
        'gh', args,
      )).rejects.toThrow();
      await expect(async () => finalizeCapsule(recorder, { stateRoots: [] })).rejects.toThrow();
    },
  );

  it.each(['../outside', 'nested/../../outside', 'absolute'])('refuses escaping state path %s', async path => {
    const root = join(dir, 'root');
    mkdirSync(join(root, 'nested'), { recursive: true });
    writeFileSync(join(dir, 'outside'), 'exists outside root');
    writeFileSync(join(root, 'present'), 'state');
    await expect(async () => finalizeCapsule(createCapsuleRecorder(), {
      stateRoots: [{ root, files: ['present', path === 'absolute' ? join(dir, 'outside') : path] }],
    })).rejects.toThrow();
  });

  it.each(['GH_REPO', 'GH_HOST'])('refuses %s retargeting at record and replay time', async (name) => {
    const recorder = createCapsuleRecorder();
    const inner = vi.fn(async () => '{"ok":true}');
    await recordingRunChild(inner, recorder)('gh', ['api', '--method', 'GET', 'repos/o/r'], { env: {} });
    await expect(recordingRunChild(inner, recorder)('gh', ['api', '--method', 'GET', 'repos/o/x'], { env: { [name]: 'other' } })).rejects.toThrow();
    const replay = replayRunChild(finalizeCapsule(recorder, { stateRoots: [] }));
    await expect(replay('gh', ['api', '--method', 'GET', 'repos/o/r'], { env: { [name]: 'other' } })).rejects.toThrow('world-capsule miss');
  });

  it('refuses inherited GH_REPO and implicit-cwd repository lookups', async () => {
    const inner = vi.fn(async () => '[]');
    const run = recordingRunChild(inner, createCapsuleRecorder());
    await expect(run('gh', ['pr', 'list', '--json', 'number'])).rejects.toThrow();
    await expect(run('gh', ['api', '--method', 'GET', 'repos/{owner}/{repo}'])).rejects.toThrow();
    vi.stubEnv('GH_REPO', 'owner/other');
    try {
      await expect(run('gh', ['pr', 'list', '--repo', 'o/r', '--json', 'number'])).rejects.toThrow();
    } finally { vi.unstubAllEnvs(); }
    expect(inner).not.toHaveBeenCalled();
  });

  it('poisons the recorder after a conflicting or failed response so it cannot finalize', async () => {
    const argv = ['api', '--method', 'GET', 'repos/o/r'];
    for (const second of [async () => '{"v":2}', async () => { throw new Error('boom'); }]) {
      const recorder = createCapsuleRecorder();
      await recordingRunChild(async () => '{"v":1}', recorder)('gh', argv);
      await expect(recordingRunChild(second, recorder)('gh', argv)).rejects.toThrow();
      expect(() => finalizeCapsule(recorder, { stateRoots: [] })).toThrow();
    }
  });

  it('refuses to finalize while a read is pending and seals the recorder after finalizing', async () => {
    const recorder = createCapsuleRecorder();
    const argv = ['api', '--method', 'GET', 'repos/o/r'];
    await recordingRunChild(async () => '{"v":1}', recorder)('gh', argv);
    let release;
    const slow = recordingRunChild(() => new Promise((_, reject) => { release = reject; }), recorder)('gh', ['api', '--method', 'GET', 'repos/o/s']);
    expect(() => finalizeCapsule(recorder, { stateRoots: [] })).toThrow();
    release(new Error('late failure'));
    await expect(slow).rejects.toThrow('late failure');
    expect(() => finalizeCapsule(recorder, { stateRoots: [] })).toThrow();
    const clean = createCapsuleRecorder();
    await recordingRunChild(async () => '{"v":1}', clean)('gh', argv);
    finalizeCapsule(clean, { stateRoots: [] });
    await expect(recordingRunChild(async () => '{"v":2}', clean)('gh', argv)).rejects.toThrow();
  });

  it('does not import readPrsFromFile', () => {
    const source = readFileSync(join(process.cwd(), 'scripts/lib/daemon-rebuild/world-capsule.mjs'), 'utf8');
    expect(source).not.toContain('readPrsFromFile');
  });
});
