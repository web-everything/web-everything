// @vitest-environment node
/** R593: remote.transport=git-bundle - verified bundle ships a real worktree to Forge; default stays rsync. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { materializeWorktree, mirrorReadOnlyForSlots, validBundleEvidence } from '../forge-exec-bases.mjs';
import { manifestWire, digestManifest } from '../forge-exec-manifest.mjs';
import { planBundle, bundleEvidence, resolveTransport, runnerSupportsBundle, capabilityRecord, capabilityAdvertisesBundle } from '../remote-git-bundle.mjs';
import { decideRemote, resolveAdmissionPolicy, readRunnerBundleCapability, writeRunnerCapabilities } from '../heavy-admission.mjs';

const ident = ['-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid'];
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const exec = async ({ file, args, cwd, input }) => {
  const r = spawnSync(file, args, { cwd, input });
  return { code: r.status ?? 254, stdout: r.stdout ?? Buffer.alloc(0), stderr: r.stderr ?? Buffer.alloc(0) };
};
const hash = (text) => createHash('sha256').update(text).digest('hex');

let root, lane, runnerMain, tip, work, container, spy;
beforeEach(async () => {
  root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'gbt-'));
  const source = join(root, 'public');
  await fs.mkdir(source);
  git(source, 'init', '-b', 'main');
  await fs.writeFile(join(source, 'tracked.txt'), 'base');
  git(source, 'add', '.'); git(source, ...ident, 'commit', '-m', 'public');
  runnerMain = git(source, 'rev-parse', 'HEAD');
  git(root, 'clone', '--bare', source, join(root, 'repo.git'));
  git(join(root, 'repo.git'), 'update-ref', 'refs/remotes/origin/main', runnerMain);
  lane = join(root, 'lane');
  git(root, 'clone', source, lane);
  await fs.writeFile(join(lane, 'tracked.txt'), 'changed');
  git(lane, 'add', '.'); git(lane, ...ident, 'commit', '-m', 'wip');
  tip = git(lane, 'rev-parse', 'HEAD');
  work = join(root, 'snapshot'); container = join(root, 'container');
  await fs.mkdir(work); await fs.mkdir(join(container, 'bundle'), { recursive: true });
  await fs.writeFile(join(work, 'tracked.txt'), 'changed');
  spy = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const manifestFor = (head) => {
  const manifest = { ...manifestWire({ entries: [{ path: Buffer.from('tracked.txt'), sha256: hash('changed'), executable: false, tracked: true }], excluded: [] }), git: { head } };
  return { manifest, manifestDigest: digestManifest(manifest) };
};
const run = async ({ head = tip, bundle, runnerBase = runnerMain, sharedClone = true, mutate } = {}) => {
  const dir = join(root, 'out'); await fs.mkdir(dir, { recursive: true });
  const plan = await planBundle({ cwd: lane, head: tip, runnerBase, exec, directory: dir });
  if (plan.file) await fs.copyFile(plan.file, join(container, 'bundle', 'git.bundle'));
  if (mutate) await mutate(join(container, 'bundle', 'git.bundle'));
  const evidence = bundle ?? bundleEvidence(plan);
  const { manifest, manifestDigest } = manifestFor(head);
  const spied = async (call) => { spy.push(call.args); return exec(call); };
  await materializeWorktree({ work, root, head, manifest, manifestDigest, exec: spied, sharedClone,
    bundle: { ...evidence, file: join(container, 'bundle', 'git.bundle') } });
  return plan;
};

describe('R593 bundle ingest on the runner', () => {
  it('fetches a verified incremental bundle into a per-run clone and checks out the exact tip', async () => {
    const plan = await run();
    expect(plan.mode).toBe('incremental');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(tip);
    // No network fetch from the public origin in bundle mode.
    expect(spy.some(a => a.includes('fetch') && a.includes('origin'))).toBe(false);
  });
  it('a missing base falls back to a full bundle that still verifies', async () => {
    const plan = await run({ runnerBase: 'f'.repeat(40) });
    expect(plan.mode).toBe('full');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(tip);
  });
  it('ships no bundle when Forge already has the tip', async () => {
    await fs.writeFile(join(work, 'tracked.txt'), 'changed');
    const dir = join(root, 'out2'); await fs.mkdir(dir);
    const plan = await planBundle({ cwd: lane, head: runnerMain, runnerBase: runnerMain, exec, directory: dir });
    expect(plan).toEqual({ mode: 'none', tip: runnerMain });
  });
  it('refuses a bundle whose tip is not the manifest-bound head', async () => {
    await expect(run({ head: runnerMain })).rejects.toMatchObject({ code: 'git-head-unavailable' });
    expect(existsSync(join(work, '.git'))).toBe(false);
  });
  it('refuses when the mirror has no refreshed public main (no cached local main fallback)', async () => {
    git(join(root, 'repo.git'), 'update-ref', '-d', 'refs/remotes/origin/main');
    await expect(run()).rejects.toMatchObject({ code: 'git-head-unavailable' });
  });
  it('refuses a corrupt bundle (digest mismatch)', async () => {
    await expect(run({ mutate: async file => { const b = await fs.readFile(file); b[b.length - 5] ^= 0xff; await fs.writeFile(file, b); } }))
      .rejects.toMatchObject({ code: 'git-head-unavailable' });
    expect(existsSync(join(work, '.git'))).toBe(false);
  });
  it('refuses a corrupt bundle even when the attacker also fixes the digest (git bundle verify)', async () => {
    const garbage = Buffer.from('# v2 git bundle\n' + `${tip} HEAD\n\nPACK-not-a-pack`);
    await expect(run({ mutate: file => fs.writeFile(file, garbage), bundle: { mode: 'incremental', sha256: createHash('sha256').update(garbage).digest('hex'), bytes: garbage.length } }))
      .rejects.toMatchObject({ code: 'git-head-unavailable' });
  });
  it('refuses a size mismatch and invalid evidence', async () => {
    await expect(run({ bundle: { mode: 'incremental', sha256: 'a'.repeat(64), bytes: 1 } })).rejects.toMatchObject({ code: 'git-head-unavailable' });
    expect(validBundleEvidence({ mode: 'weird' })).toBe(false);
    expect(validBundleEvidence({ mode: 'full', sha256: 'zz', bytes: 5 })).toBe(false);
    expect(validBundleEvidence({ mode: 'none' })).toBe(true);
  });
  it('uses --shared only while repo.git is not writable by slot users, else --no-local copies', async () => {
    const mirror = join(root, 'repo.git');
    await fs.chmod(mirror, 0o755);
    expect(await mirrorReadOnlyForSlots(mirror)).toBe(true);
    await run();
    expect(spy.find(a => a.includes('clone'))).toContain('--shared');
    spy = []; await fs.rm(join(work, '.git'), { recursive: true, force: true });
    await fs.chmod(join(mirror, 'objects'), 0o777);
    expect(await mirrorReadOnlyForSlots(mirror)).toBe(false);
    await run();
    const clone = spy.find(a => a.includes('clone'));
    expect(clone).toContain('--no-local'); expect(clone).not.toContain('--shared');
  });
});

describe('R593 client and routing', () => {
  it('defaults to rsync and only an exact git-bundle selects the bundle', () => {
    expect(resolveTransport(undefined)).toBe('rsync'); expect(resolveTransport('bundle')).toBe('rsync');
    expect(resolveTransport('git-bundle')).toBe('git-bundle');
    expect(resolveAdmissionPolicy({ platform: {} }).settings.remote.transport).toBe('rsync');
  });
  it('an old runner (no gitBundle) is not fed a bundle', () => {
    expect(runnerSupportsBundle({ gitWorktree: 2 })).toBe(false);
    expect(runnerSupportsBundle({ gitBundle: 1 })).toBe(true);
    const old = capabilityRecord({ host: 'forge', capabilities: { gitWorktree: 2 }, nowMs: 1000 });
    expect(capabilityAdvertisesBundle(old, { host: 'forge', nowMs: 1001 })).toBe(false);
  });
  it('capability cache expires and is host-bound', () => {
    const rec = capabilityRecord({ host: 'forge', capabilities: { gitBundle: 1 }, nowMs: 1000 });
    expect(capabilityAdvertisesBundle(rec, { host: 'forge', nowMs: 2000 })).toBe(true);
    expect(capabilityAdvertisesBundle(rec, { host: 'other', nowMs: 2000 })).toBe(false);
    expect(capabilityAdvertisesBundle(rec, { host: 'forge', nowMs: 1000 + 61 * 60_000 })).toBe(false);
  });
  describe('needs-git tests route remote only with the capability', () => {
    let cwd;
    const mk = (transport) => resolveAdmissionPolicy({ platform: { remote: { enabled: true, mode: 'always', loadPerCoreThreshold: 3, clientPath: null,
      maxConcurrent: 8, backoffMs: 120000, backoffFailures: 3, maxLoadPerCore: 0.8, minFreeRamPct: 15, transport } } });
    beforeEach(async () => {
      cwd = join(root, 'repo'); await fs.mkdir(cwd);
      await fs.writeFile(join(cwd, 'git.test.mjs'), "import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['ls-files']);\n");
    });
    const decide = (policy, runnerBundleOk) => decideRemote({ policy, loadPerCore: 4, cwd, argv: ['npx', 'vitest', 'run', 'git.test.mjs'], runnerBundleOk });
    it('git-bundle + capability keeps remote', () => expect(decide(mk('git-bundle'), true)).toMatchObject({ remote: true }));
    it('git-bundle without capability stays local', () => expect(decide(mk('git-bundle'), false)).toMatchObject({ remote: false, needsGit: true }));
    it('rsync stays local even with the capability', () => expect(decide(mk('rsync'), true)).toMatchObject({ remote: false, needsGit: true }));
    it('capability cache round-trips and unreadable means no', () => {
      const dir = join(root, 'remote'); const clock = () => 5000;
      expect(readRunnerBundleCapability({ root: dir, host: 'forge', clock })).toBe(false);
      writeRunnerCapabilities({ root: dir, host: 'forge', capabilities: { gitBundle: 1 }, clock });
      expect(readRunnerBundleCapability({ root: dir, host: 'forge', clock })).toBe(true);
    });
  });
});
