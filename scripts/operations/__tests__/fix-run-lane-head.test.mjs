import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEASE_FILENAME } from '../../lib/lane-lease.mjs';
import { laneHeadCheck, ensureLaneHead, probeLaneHead, readLaneLease, runFixCli, LauncherError, parseAcquiredLanePath } from '../fix-run.mjs';

const holder = 'conveyor-fix-lane-10-eaae3ffe';
const foreign = 'orchestrator-slots-lane-10-4fef772b';
const prHead = '6509e66bc'.padEnd(40, '0');
const oldHead = '9904fc5'.padEnd(40, '0');
const lease = { holder };

function fixture({ head = prHead, owner = holder, lanePath = '/lanes/lane-10' } = {}) {
  const state = { head, owner, dirty: '', spawnHead: null };
  const calls = [];
  const run = vi.fn((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'gh') return JSON.stringify({ title: 'T', headRefOid: prHead });
    if (args.includes('acquire')) {
      if (args.includes('--lane=10')) state.head = prHead;
      return JSON.stringify({ path: lanePath, holder });
    }
    if (args.includes('rev-parse') && args.at(-1) === 'HEAD') return state.head;
    if (args.includes('status')) return state.dirty;
    return '';
  });
  const readLease = vi.fn(() => ({ holder: state.owner }));
  const spawn = vi.fn(async () => { state.spawnHead = state.head; });
  const recordOutcome = vi.fn(), appendLoopRow = vi.fn(), releaseClaim = vi.fn(async () => ({}));
  const io = { run, readLease, readPrompt: () => 'brief', removePrompt: () => {},
    readComments: async () => [{ body: '🔁 review — changes requested\nrepair' }],
    resolveProvider: () => ({ spawn }), pendingRearm: { read: () => null, write: () => {}, clear: () => {} },
    recordOutcome, recordRouted: () => ({}), appendLoopRow, releaseClaim,
    recordPush: () => {}, write: () => {}, writeErr: () => {}, weRoot: '/we' };
  return { state, calls, run, readLease, spawn, recordOutcome, appendLoopRow, releaseClaim, io };
}
const argv = ['--pr=5759', '--session=fix-5759', '--ref=lane/pr', '--prompt-file=/p', '--provider=codex'];

// Keep subprocesses stubbed, but omit io.readLease to exercise the production disk reader.
function diskLeaseFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fix-lane-lease-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const lanePath = join(root, 'lane-10');
  const gitDir = join(lanePath, '.git');
  mkdirSync(gitDir, { recursive: true });
  const marker = join(gitDir, LEASE_FILENAME);
  const setLease = kind => {
    rmSync(marker, { recursive: true, force: true });
    if (kind === 'missing') return;
    if (kind === 'unreadable') { mkdirSync(marker); return; }
    const contents = {
      owned: JSON.stringify({ holder }), foreign: JSON.stringify({ holder: foreign }),
      malformed: '{"holder":', 'missing holder': '{}', null: 'null',
    };
    writeFileSync(marker, contents[kind]);
  };
  setLease('owned');
  // A plausible worktree marker must never substitute for the allocator's .git marker.
  writeFileSync(join(lanePath, LEASE_FILENAME), JSON.stringify({ holder }));
  const f = fixture({ ...options, lanePath });
  delete f.io.readLease;
  return { ...f, lanePath, gitDir, marker, setLease };
}

const invalidDiskLeases = ['foreign', 'missing', 'malformed', 'unreadable', 'missing holder', 'null'];

describe('production on-disk fixer lease reader', () => {
  it('reads the allocator marker, returns null for a missing file, and propagates parse and IO errors', () => {
    const f = diskLeaseFixture();
    expect(readLaneLease(f.lanePath)).toEqual({ holder });
    f.setLease('foreign');
    expect(readLaneLease(f.lanePath)).toEqual({ holder: foreign });
    f.setLease('missing');
    expect(readLaneLease(f.lanePath)).toBeNull();
    f.setLease('malformed');
    expect(() => readLaneLease(f.lanePath)).toThrow(SyntaxError);
    // A directory gives a deterministic read error even when tests run as root.
    f.setLease('unreadable');
    expect(() => readLaneLease(f.lanePath)).toThrow(/EISDIR/);
  });

  it('starts and releases an unchanged lane using the default reader', async () => {
    const f = diskLeaseFixture();
    expect((await runFixCli(argv, f.io)).code).toBe(0);
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.state.spawnHead).toBe(prHead);
    expect(f.readLease).not.toHaveBeenCalled();
    expect(f.calls.filter(c => c.args.includes('release'))).toHaveLength(1);
  });

  it('recovers a clean wrong head using the real marker and the acquired holder', async () => {
    const f = diskLeaseFixture({ head: oldHead });
    expect((await runFixCli(argv, f.io)).code).toBe(0);
    expect(f.state.spawnHead).toBe(prHead);
    const recovery = f.calls.find(c => c.args.includes('--lane=10') && c.args.includes('acquire'));
    expect(recovery.args).toContain(`--expect-holder=${holder}`);
    expect(f.readLease).not.toHaveBeenCalled();
  });

  it.each(invalidDiskLeases)('refuses a %s disk lease before recovery or spawn', async kind => {
    const f = diskLeaseFixture({ head: oldHead });
    f.setLease(kind);
    expect((await runFixCli(argv, f.io)).code).toBe(1);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.calls.filter(c => c.args.includes('acquire'))).toHaveLength(1);
    expect(f.calls.some(c => c.args.some(arg => ['add', 'update-index', 'commit', 'push', 'release'].includes(arg)))).toBe(false);
    expect(f.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failed', reason: expect.stringContaining('refusing to start the agent'),
    }));
    expect(f.releaseClaim).toHaveBeenCalledOnce();
    expect(f.readLease).not.toHaveBeenCalled();
  });
});

describe('ownership loss before post-agent staging', () => {
  function stagedFixture() {
    const f = diskLeaseFixture();
    const stageEntry = vi.fn(() => ({ data: Buffer.from('repair\n'), mode: '100644' }));
    const pendingRearm = { read: () => null, write: vi.fn(), clear: vi.fn() };
    f.io.stageEntry = stageEntry;
    f.io.pendingRearm = pendingRearm;
    f.io.run = (cmd, args, opts) => {
      const value = f.run(cmd, args, opts);
      if (cmd === 'git' && args.includes('--absolute-git-dir')) return f.gitDir;
      if (cmd === 'git' && args.includes('commit')) f.state.head = 'a'.repeat(40);
      return value;
    };
    f.spawn.mockImplementation(async () => {
      writeFileSync(join(f.lanePath, 'repair.txt'), 'repair\n');
      f.state.dirty = ' M repair.txt\0';
    });
    return { ...f, stageEntry, pendingRearm };
  }

  it.each(invalidDiskLeases)('refuses a %s lease left by the agent before reading or staging its edits', async kind => {
    const f = stagedFixture();
    const edit = f.spawn.getMockImplementation();
    f.spawn.mockImplementation(async () => { await edit(); f.setLease(kind); });
    expect((await runFixCli(argv, f.io)).code).toBe(1);
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.state.dirty).toBe(' M repair.txt\0');
    expect(readFileSync(join(f.lanePath, 'repair.txt'), 'utf8')).toBe('repair\n');
    expect(f.stageEntry).not.toHaveBeenCalled();
    expect(f.calls.some(c => c.cmd === 'git' && c.args.some(arg =>
      ['--absolute-git-dir', 'add', 'update-index', 'commit', 'push'].includes(arg)))).toBe(false);
    expect(f.calls.some(c => c.args.includes('release') || c.args.some(arg => arg.endsWith('rearm-review.mjs')))).toBe(false);
    expect(f.pendingRearm.write).not.toHaveBeenCalled();
    // Missing/foreign/holder-less leases are the distinct, same-refusal 'lease-lost' outcome; other bad markers stay 'failed'.
    expect(f.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      outcome: ['foreign', 'missing', 'missing holder', 'null'].includes(kind) ? 'lease-lost' : 'failed',
      reason: expect.stringContaining('refusing to push or stage files'),
    }));
    expect(f.releaseClaim).toHaveBeenCalledOnce();
    expect(f.readLease).not.toHaveBeenCalled();
  });

  it('stages, commits and pushes the same edits when the disk lease remains owned', async () => {
    const f = stagedFixture();
    expect((await runFixCli(argv, f.io)).code).toBe(0);
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.stageEntry).toHaveBeenCalledWith(f.lanePath, 'repair.txt');
    for (const command of ['add', 'update-index', 'commit', 'push']) {
      expect(f.calls.some(c => c.cmd === 'git' && c.args.includes(command))).toBe(true);
    }
    expect(f.pendingRearm.write).toHaveBeenCalledOnce();
    expect(f.readLease).not.toHaveBeenCalled();
  });
});

function resetFixture({ drift } = {}) {
  const f = fixture();
  const baseline = 'b'.repeat(40), main = 'c'.repeat(40), base = 'd'.repeat(40), tree = 'e'.repeat(40);
  const finding = { author: { login: 'web-everything' }, body: '🔁 review — changes requested\n'
    + '### Findings (1)\n**correctness/bug** (1)\n- `a.mjs:10` — same bug' };
  const io = { ...f.io,
    readComments: async () => [
      { author: { login: 'chalbert' }, body: `scope-baseline: ${baseline}` },
      finding, { author: { login: 'chalbert' }, body: '🔓 conveyor fix-end' }, finding,
    ],
    resolveProvider: async () => {
      await Promise.resolve();
      if (drift === 'holder') f.state.owner = foreign;
      if (drift === 'missing lease') f.readLease.mockReturnValue(null);
      if (drift === 'unreadable lease') f.readLease.mockImplementation(() => { throw new Error('unreadable lease'); });
      if (drift === 'head') f.state.head = oldHead;
      return { spawn: f.spawn };
    },
    run: (cmd, args, opts) => {
      const value = f.run(cmd, args, opts);
      if (cmd !== 'git') return value;
      if (args.includes('rev-parse') && args.at(-1) === 'origin/main^{commit}') return main;
      if (args.includes('merge-base') && !args.includes('--is-ancestor')) return base;
      if (args.includes('diff') && args.includes('--name-only')) return 'a.mjs\0';
      if (args.includes('merge-tree')) return tree;
      return value;
    },
  };
  return { ...f, io, tree };
}

describe('repeated-finding reset pins the acquired head and holder', () => {
  it.each(['holder', 'missing lease', 'unreadable lease', 'head'])(
    'refuses %s drift during provider resolution before reset mutations', async drift => {
      const f = resetFixture({ drift });
      expect((await runFixCli([...argv, '--scope=we:a.mjs'], f.io)).code).toBe(1);
      expect(f.calls.filter(c => c.cmd === 'git' && c.args.some(arg =>
        ['merge-tree', 'read-tree', 'cherry-pick', 'commit', 'push'].includes(arg))).map(c => c.args)).toEqual([]);
      expect(f.calls.filter(c => c.args.includes('acquire'))).toHaveLength(1);
      expect(f.spawn).not.toHaveBeenCalled();
    });
  it('allows the real reset path with an unchanged head and holder', async () => {
    const f = resetFixture();
    expect((await runFixCli([...argv, '--scope=we:a.mjs'], f.io)).code).toBe(0);
    expect(f.calls.some(c => c.args.includes('merge-tree'))).toBe(true);
    expect(f.calls.some(c => c.args.includes('read-tree') && c.args.at(-1) === f.tree)).toBe(true);
    expect(f.spawn).not.toHaveBeenCalled();
  });
});

function mergeFixture({ driftAt, drift = 'head', parent = prHead } = {}) {
  const f = fixture();
  const mergedHead = 'a'.repeat(40);
  let merging = false;
  const changeLane = () => {
    if (drift === 'holder') f.state.owner = foreign;
    else f.state.head = oldHead;
  };
  const run = (cmd, args, opts) => {
    const value = f.run(cmd, args, opts);
    if (cmd !== 'git') return value;
    if (args.includes('fetch') && driftAt === 'fetch') changeLane();
    if (args.includes('merge') && args.includes('--no-commit')) {
      merging = true;
      if (driftAt === 'merge') changeLane();
    }
    if (args.includes('commit')) { merging = false; f.state.head = mergedHead; }
    if (args.includes('--git-path')) return 'MERGE_HEAD';
    if (args.includes('rev-parse') && args.at(-1) === `${mergedHead}^1`) return parent;
    return value;
  };
  const io = { ...f.io, run, fileExists: path => path.endsWith('MERGE_HEAD') && merging,
    resolveProvider: async () => {
      await Promise.resolve();
      if (driftAt === 'provider') changeLane();
      return { spawn: f.spawn };
    } };
  return { ...f, io, mergedHead };
}

describe('fixer merge preparation pins the acquired head and holder', () => {
  it.each(['head', 'holder'])('refuses %s drift during awaited provider resolution before merge, commit or spawn', async drift => {
    const f = mergeFixture({ driftAt: 'provider', drift });
    expect((await runFixCli([...argv, '--merge-onto=main'], f.io)).code).toBe(1);
    expect(f.calls.some(c => c.args.includes('merge') || c.args.includes('commit'))).toBe(false);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.calls.filter(c => c.args.includes('acquire'))).toHaveLength(1);
  });
  it.each(['head', 'holder'])('refuses %s drift during fetch before merge, commit or spawn', async drift => {
    const f = mergeFixture({ driftAt: 'fetch', drift });
    expect((await runFixCli([...argv, '--merge-onto=main'], f.io)).code).toBe(1);
    expect(f.calls.some(c => c.args.includes('merge') || c.args.includes('commit'))).toBe(false);
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it.each(['head', 'holder'])('refuses %s drift after merge preparation before commit or spawn', async drift => {
    const f = mergeFixture({ driftAt: 'merge', drift });
    expect((await runFixCli([...argv, '--merge-onto=main'], f.io)).code).toBe(1);
    expect(f.calls.some(c => c.args.includes('merge') && c.args.includes('--no-commit'))).toBe(true);
    expect(f.calls.some(c => c.args.includes('commit'))).toBe(false);
    expect(f.calls.some(c => c.args.includes('--abort'))).toBe(false);
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it.each([oldHead, ''])('refuses an unexpected or unreadable merge first parent (%s) before spawn or push', async parent => {
    const f = mergeFixture({ parent });
    expect((await runFixCli([...argv, '--merge-onto=main'], f.io)).code).toBe(1);
    expect(f.calls.some(c => c.args.includes('commit'))).toBe(true);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.calls.some(c => c.args.includes('push'))).toBe(false);
  });
  it('accepts a merge rooted at the pinned head and spawns on its verified commit', async () => {
    const f = mergeFixture();
    expect((await runFixCli([...argv, '--merge-onto=main'], f.io)).code).toBe(0);
    expect(f.state.spawnHead).toBe(f.mergedHead);
    expect(f.calls.some(c => c.args.includes(`${f.mergedHead}^1`))).toBe(true);
  });
});

describe('fixer lane head guard', () => {
  it('accepts both legacy path output and JSON acquire output', () => {
    expect(parseAcquiredLanePath('noise\n/lanes/lane-10\n')).toBe('/lanes/lane-10');
    expect(parseAcquiredLanePath(JSON.stringify({ path: '/lanes/lane-10', holder }))).toBe('/lanes/lane-10');
  });
  it('accepts the PR head only with our holder', () => {
    expect(laneHeadCheck({ laneHead: prHead, prHead, lease, holder })).toMatchObject({ ok: true, action: 'ok' });
    expect(laneHeadCheck({ laneHead: oldHead, prHead, lease, holder, clean: true })).toMatchObject({ ok: false, action: 'reset' });
    expect(laneHeadCheck({ laneHead: prHead, prHead, lease: null, holder })).toMatchObject({ action: 'refuse' });
  });
  it('recovers through lane-pool acquire with our holder, then re-checks before spawning', async () => {
    const f = fixture({ head: oldHead });
    expect((await runFixCli(argv, f.io)).code).toBe(0);
    expect(f.state.spawnHead).toBe(prHead);
    const recovery = f.calls.find(c => c.args.includes('--lane=10') && c.args.includes('acquire'));
    expect(recovery.cmd).toBe('node');
    expect(recovery.args).toEqual(['/we/scripts/lane-pool.mjs', 'acquire', '--lane=10',
      '--session=fix-5759', `--expect-holder=${holder}`, '--purpose=conveyor-fix', '--base=lane/pr']);
    expect(recovery.opts).toMatchObject({ cwd: '/we', env: { LANE_SESSION: holder } });
    expect(f.readLease.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(f.calls.some(c => c.args.includes('reset') || c.args.includes('fetch'))).toBe(false);
    expect(f.calls.filter(c => c.args.includes('rev-parse')).length).toBeGreaterThanOrEqual(4);
  });
  it('refuses recovery with an empty holder without calling acquire', () => {
    const f = fixture({ head: oldHead });
    expect(() => ensureLaneHead({ lanePath: '/lanes/lane-10', prHead, holder: '',
      sessionSlug: 'fix-5759', ref: 'lane/pr', weRoot: '/we', run: f.run, readLease: f.readLease }))
      .toThrow(LauncherError);
    expect(f.calls.some(c => c.args.includes('acquire'))).toBe(false);
  });
  it('refuses a foreign lease before spawn and records infra failure, releasing the claim', async () => {
    const f = fixture({ head: oldHead, owner: foreign });
    expect((await runFixCli(argv, f.io)).code).toBe(1);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.calls.filter(c => c.args.includes('acquire'))).toHaveLength(1);
    expect(f.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', reason: expect.stringContaining(foreign) }));
    expect(f.appendLoopRow).toHaveBeenCalledWith(expect.objectContaining({ infra: true }));
    expect(f.releaseClaim).toHaveBeenCalledOnce();
  });
  it('refuses push when the agent loses its lease', async () => {
    const f = fixture();
    f.spawn.mockImplementation(async () => { f.state.head = 'a'.repeat(40); });
    f.io.pendingRearm.write = () => { f.state.owner = foreign; };
    expect((await runFixCli(argv, f.io)).code).toBe(1);
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.calls.some(c => c.args.includes('push'))).toBe(false);
    expect(f.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('refusing to push') }));
  });
  it.each(['dirty', 'unpushed', 'foreign-at-acquire', 'wrong-head-after-acquire', 'stolen-after-acquire'])('refuses unsafe recovery before spawning: %s', async kind => {
    const f = fixture({ head: oldHead });
    if (kind === 'dirty') f.state.dirty = ' M file';
    const run = (cmd, args, opts) => {
      if (args.includes('acquire') && args.includes('--lane=10')) {
        if (kind === 'foreign-at-acquire') f.state.owner = foreign;
        if (kind === 'unpushed' || kind === 'foreign-at-acquire') {
          throw new Error(kind === 'unpushed' ? 'lane has unpushed local commits' : 'foreign lease');
        }
        const value = f.run(cmd, args, opts);
        if (kind === 'wrong-head-after-acquire') f.state.head = oldHead;
        if (kind === 'stolen-after-acquire') f.state.owner = foreign;
        return value;
      }
      return f.run(cmd, args, opts);
    };
    expect((await runFixCli(argv, { ...f.io, run })).code).toBe(1);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.state.head).toBe(kind === 'stolen-after-acquire' ? prHead : oldHead);
    expect(f.calls.some(c => c.args.includes('reset') || c.args.includes('fetch'))).toBe(false);
    expect(f.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }));
  });
  it('wraps allocator containment refusal as LauncherError', () => {
    const f = fixture({ head: oldHead });
    const run = (cmd, args, opts) => {
      if (args.includes('acquire')) throw new Error('unpushed local commits');
      return f.run(cmd, args, opts);
    };
    expect(() => ensureLaneHead({ lanePath: '/lanes/lane-10', prHead, holder,
      sessionSlug: 'fix-5759', ref: 'lane/pr', weRoot: '/we', run, readLease: f.readLease })).toThrow(LauncherError);
  });
  it('rechecks the lease immediately before spawn after launcher preparation', async () => {
    const f = fixture();
    f.io.resolveProvider = () => { f.state.owner = foreign; return { spawn: f.spawn }; };
    expect((await runFixCli(argv, f.io)).code).toBe(1);
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it('recovers a second clean HEAD drift before spawn', async () => {
    const f = fixture();
    f.io.resolveProvider = () => { f.state.head = oldHead; return { spawn: f.spawn }; };
    expect((await runFixCli(argv, f.io)).code).toBe(0);
    expect(f.state.spawnHead).toBe(prHead);
  });
  it('never resets launcher merge preparation on a mismatch', () => {
    const f = fixture({ head: oldHead });
    expect(() => ensureLaneHead({ lanePath: '/lanes/lane-10', prHead, holder,
      run: f.run, readLease: f.readLease, allowReset: false })).toThrow(LauncherError);
    expect(f.calls.some(c => c.args.includes('fetch') || c.args.includes('reset'))).toBe(false);
  });
  it('probe reads live evidence without writes and requires an asserted holder', () => {
    const f = fixture({ head: oldHead });
    const result = probeLaneHead({ lanePath: '/lanes/lane-10', pr: 5759, holder, run: f.run, readLease: f.readLease });
    expect(result).toMatchObject({ laneHead: oldHead, prHead, action: 'reset' });
    expect(probeLaneHead({ lanePath: '/lanes/lane-10', pr: 5759, run: f.run, readLease: f.readLease }).action).toBe('refuse');
    expect(f.calls.every(c => c.cmd === 'gh' || c.args.includes('rev-parse') || c.args.includes('status') || c.args.includes('config'))).toBe(true);
    expect(f.calls.filter(c => c.cmd === 'git').every(c => c.opts.env.GIT_OPTIONAL_LOCKS === '0')).toBe(true);
  });
});
