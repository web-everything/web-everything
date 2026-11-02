/**
 * @file `daemon-overlay.mjs replace` and `retire` (R310, incident 2026-11-01). Real CLI, real bare origin + clone.
 * The review and health-watch daemons froze for hours because an old top that blocked the rebuild could only be
 * removed by hand. `replace` is the safe form of "remove before adoption": the new top must contain every commit
 * of the old one. `retire` drops a proved-retired registration only at the tip that was proved.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { retireRegistration, replaceRegistration, settlePendingDrops, readPendingDrops, inferPrNumber } from '../daemon-overlay.mjs';
import { addOverlay } from '../lib/daemon-overlays.mjs';
import { planRebuild } from '../lib/daemon-rebuild.mjs';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'daemon-overlay.mjs');
const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
const mktemp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
function gitOk(cwd, args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function fixture() {
  const base = mktemp('we-overlay-rr-');
  const origin = join(base, 'origin.git');
  const clone = join(base, 'clone');
  mkdirSync(clone);
  gitOk(base, ['init', '--bare', '-q', origin]);
  gitOk(clone, ['init', '-q', '-b', 'main']);
  writeFileSync(join(clone, 'README.md'), 'init\n');
  gitOk(clone, ['add', '-A']);
  gitOk(clone, ['commit', '-q', '-m', 'init']);
  gitOk(clone, ['remote', 'add', 'origin', origin]);
  gitOk(clone, ['push', '-q', '-u', 'origin', 'main']);
  const author = join(base, 'author');
  gitOk(base, ['clone', '-q', origin, author]);
  const state = mktemp('we-overlay-rr-state-');
  // gh stub: no PR heads any ref; every other GitHub question fails (fails closed in the planner).
  const bin = mktemp('we-overlay-rr-gh-');
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nif [ "$1 $2" = "pr list" ]; then echo "[]"; exit 0; fi\nif [ "$1 $2" = "repo view" ]; then echo web-everything/web-everything; exit 0; fi\nexit 1\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, WE_DAEMON_OVERLAY_DIR: state, WE_DAEMON_OVERLAY_STACK_BASES: '{}', WE_OVERLAY_NO_PR: 'warn' };
  /** Commit `file` on `ref` (starting from `from`) and push it; returns the new tip. */
  const push = (ref, file, content, from = 'origin/main') => {
    gitOk(author, ['fetch', '-q', 'origin']);
    gitOk(author, ['checkout', '-q', '-B', ref, from]);
    writeFileSync(join(author, file), content);
    gitOk(author, ['add', '-A']);
    gitOk(author, ['commit', '-q', '-m', `${ref}: ${file}`]);
    gitOk(author, ['push', '-q', '-f', 'origin', `HEAD:refs/heads/${ref}`]);
    return gitOk(author, ['rev-parse', 'HEAD']);
  };
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [CLI, ...args, `--clone=${clone}`, '--json'], { encoding: 'utf8', timeout: 60_000, env: { ...env, ...extraEnv } });
  const list = () => {
    const name = readdirSync(state).find((n) => n.endsWith('.json'));
    return name ? JSON.parse(readFileSync(join(state, name), 'utf8')).overlays.map((o) => o.ref) : [];
  };
  const events = () => {
    const name = readdirSync(state).find((n) => n.endsWith('.events.jsonl'));
    return name ? readFileSync(join(state, name), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  /** Fast-forward main to `ref` (the branch landed). */
  const land = (ref) => gitOk(author, ['push', '-q', 'origin', `refs/remotes/origin/${ref}:refs/heads/main`]);
  const entry = (ref) => {
    const name = readdirSync(state).find((n) => n.endsWith('.json'));
    return JSON.parse(readFileSync(join(state, name), 'utf8')).overlays.find((o) => o.ref === ref);
  };
  /** Replace the gh stub: `prs` is what every `pr list` answers; `repo view` still names the repo. */
  const ghPrs = (prs) => writeFileSync(join(bin, 'gh'), `#!/bin/sh\nif [ "$1 $2" = "pr list" ]; then echo '${JSON.stringify(prs)}'; exit 0; fi\nif [ "$1 $2" = "repo view" ]; then echo web-everything/web-everything; exit 0; fi\nexit 1\n`, { mode: 0o755 });
  /** Squash-merge: main gets the same content in a NEW commit, then the branch is deleted. Returns the main commit. */
  const squash = (ref, file, content) => {
    gitOk(author, ['fetch', '-q', 'origin']);
    gitOk(author, ['checkout', '-q', '-B', 'sq-main', 'origin/main']);
    writeFileSync(join(author, file), content);
    gitOk(author, ['add', '-A']);
    gitOk(author, ['commit', '-q', '-m', `squash ${ref}`]);
    gitOk(author, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
    gitOk(author, ['push', '-q', 'origin', `:refs/heads/${ref}`]);
    return gitOk(author, ['rev-parse', 'HEAD']);
  };
  return { push, run, list, events, land, entry, clone, env, ghPrs, squash, author };
}

describe('daemon-overlay.mjs replace', () => {
  it('registers the new top and drops the old one when every old commit is contained', () => {
    const f = fixture();
    f.push('lane/old-top', 'a.txt', 'a\n');
    expect(f.run(['add', '--ref=lane/old-top']).status).toBe(0);
    const tip = f.push('lane/new-top', 'b.txt', 'b\n', 'origin/lane/old-top');
    const r = f.run(['replace', '--ref=lane/new-top', '--replaces=lane/old-top', `--expected-sha=${tip}`]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ replaced: true, registered: true, containment: { contained: true, newTip: tip } });
    expect(f.list()).toEqual(['lane/new-top']);
    expect(f.events().at(-1)).toMatchObject({ kind: 'replaced', ref: 'lane/old-top', replacedBy: 'lane/new-top', newTip: tip });
  });

  it('refuses to replace a registration with an approved edge resolution', () => {
    const f = fixture();
    f.push('lane/old-top', 'a.txt', 'a\n');
    expect(f.run(['add', '--ref=lane/old-top']).status).toBe(0);
    expect(f.run(['approve-edge', '--ref=lane/old-top', `--sha=${'e'.repeat(40)}`, '--by=op']).status).toBe(0);
    const tip = f.push('lane/new-top', 'b.txt', 'b\n', 'origin/lane/old-top');
    const r = f.run(['replace', '--ref=lane/new-top', '--replaces=lane/old-top', `--expected-sha=${tip}`]);
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout)).toMatchObject({ replaced: false, registered: false, refused: 'replaced-has-edge-resolution' });
    expect(f.list()).toEqual(['lane/old-top']);
  });

  it('the replacement inherits an explicit pin of the old registration', () => {
    const f = fixture();
    f.push('lane/old-top', 'a.txt', 'a\n');
    expect(f.run(['add', '--ref=lane/old-top', '--pinned']).status).toBe(0);
    const tip = f.push('lane/new-top', 'b.txt', 'b\n', 'origin/lane/old-top');
    const r = f.run(['replace', '--ref=lane/new-top', '--replaces=lane/old-top', `--expected-sha=${tip}`]);
    expect(r.status, r.stderr).toBe(0);
    expect(f.entry('lane/new-top')).toMatchObject({ pinned: true });
  });

  it.each([false, true])('refuses when the old top has a commit the new top lacks, changing nothing (check: %s)', (check) => {
    const f = fixture();
    f.push('lane/old-top', 'a.txt', 'a\n');
    expect(f.run(['add', '--ref=lane/old-top']).status).toBe(0);
    const tip = f.push('lane/new-top', 'b.txt', 'b\n');
    const before = f.events().length;
    const r = f.run(['replace', '--ref=lane/new-top', '--replaces=lane/old-top', `--expected-sha=${tip}`, ...(check ? ['--check'] : [])]);
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout)).toMatchObject(check ? { wouldReplace: false, refused: 'not-contained' } : { replaced: false, registered: false, refused: 'not-contained' });
    expect(f.list()).toEqual(['lane/old-top']);
    expect(f.events()).toHaveLength(before);
  });

  it('a contained check reports wouldReplace without mutating', () => {
    const f = fixture();
    f.push('lane/old-top', 'a.txt', 'a\n');
    expect(f.run(['add', '--ref=lane/old-top']).status).toBe(0);
    const tip = f.push('lane/new-top', 'b.txt', 'b\n', 'origin/lane/old-top');
    const r = f.run(['replace', '--check', '--ref=lane/new-top', '--replaces=lane/old-top', `--expected-sha=${tip}`]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ wouldReplace: true, containment: { contained: true } });
    expect(f.list()).toEqual(['lane/old-top']);
  });

  it('refuses an unregistered old ref and a moved new tip', () => {
    const f = fixture();
    const tip = f.push('lane/new-top', 'b.txt', 'b\n');
    expect(JSON.parse(f.run(['replace', '--ref=lane/new-top', '--replaces=lane/ghost', `--expected-sha=${tip}`]).stdout)).toMatchObject({ refused: 'replaced-not-registered' });
    f.push('lane/old-top', 'a.txt', 'a\n');
    expect(f.run(['add', '--ref=lane/old-top']).status).toBe(0);
    const r = f.run(['replace', '--ref=lane/new-top', '--replaces=lane/old-top', `--expected-sha=${'0'.repeat(40)}`]);
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout)).toMatchObject({ refused: 'sha-moved' });
    expect(f.list()).toEqual(['lane/old-top']);
  });
});

describe('daemon-overlay.mjs retire', () => {
  it('re-proves retirement, drops the registration at the proved tip and records an auto-retired event', () => {
    const f = fixture();
    const tip = f.push('lane/done', 'a.txt', 'a\n');
    expect(f.run(['add', '--ref=lane/done']).status).toBe(0);
    f.land('lane/done');
    const r = f.run(['retire', '--ref=lane/done', `--expected-tip=${tip}`, `--expected-entry=${JSON.stringify(f.entry('lane/done'))}`]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ retired: true, refused: null, reason: 'in-main' });
    expect(f.list()).toEqual([]);
    expect(f.events().at(-1)).toMatchObject({ kind: 'auto-retired', ref: 'lane/done', reason: 'in-main', tip, evidence: { contentInMain: true } });
  });

  it('never drops a registration with work that is not on main, whatever the caller claims', () => {
    const f = fixture();
    const tip = f.push('lane/live', 'a.txt', 'unique live work\n');
    expect(f.run(['add', '--ref=lane/live']).status).toBe(0);
    const r = f.run(['retire', '--ref=lane/live', `--expected-tip=${tip}`, '--reason=in-main']);
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout)).toMatchObject({ retired: false, refused: 'not-proved', proof: { action: 'keep', reason: 'unique-commits-not-on-main' } });
    expect(f.list()).toEqual(['lane/live']);
  });

  it('keeps the registration when its tip moved after the proof', () => {
    const f = fixture();
    const proved = f.push('lane/done', 'a.txt', 'a\n');
    expect(f.run(['add', '--ref=lane/done']).status).toBe(0);
    const moved = f.push('lane/done', 'b.txt', 'b\n', 'origin/lane/done');
    f.land('lane/done');
    const r = f.run(['retire', '--ref=lane/done', `--expected-tip=${proved}`]);
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout)).toMatchObject({ retired: false, refused: 'tip-moved', tipNow: moved });
    expect(f.list()).toEqual(['lane/done']);
  });

  it('refuses when the registration is no longer the one that was proved', () => {
    const f = fixture();
    const tip = f.push('lane/done', 'a.txt', 'a\n');
    expect(f.run(['add', '--ref=lane/done']).status).toBe(0);
    f.land('lane/done');
    const r = f.run(['retire', '--ref=lane/done', `--expected-tip=${tip}`, `--expected-entry=${JSON.stringify({ ...f.entry('lane/done'), pr: 99 })}`]);
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout)).toMatchObject({ retired: false, refused: 'registration-changed' });
    expect(f.list()).toEqual(['lane/done']);
  });

  it('restores the registration when the post-drop tip read throws', async () => {
    const f = fixture();
    const tip = f.push('lane/done', 'a.txt', 'a\n');
    expect(f.run(['add', '--ref=lane/done']).status).toBe(0);
    const r = await retireRegistration({ root: f.clone, ref: 'lane/done', expectedTip: tip, env: f.env, deps: {
      prove: () => ({ action: 'retire', reason: 'in-main', tip, evidence: {} }), tip: () => { throw new Error('network'); } } });
    expect(r).toMatchObject({ retired: false, refused: 'tip-unreadable-restored' });
    expect(f.list()).toEqual(['lane/done']);
  });

  it('restores the registration when a push landed before the drop', async () => {
    const f = fixture();
    const tip = f.push('lane/done', 'a.txt', 'a\n');
    expect(f.run(['add', '--ref=lane/done', '--pinned', '--reason=keep me']).status).toBe(0);
    const before = f.entry('lane/done');
    const r = await retireRegistration({ root: f.clone, ref: 'lane/done', expectedTip: tip, env: f.env, deps: {
      prove: () => ({ action: 'retire', reason: 'in-main', tip, evidence: {} }), tip: () => 'f'.repeat(40) } });
    expect(r).toMatchObject({ retired: false, refused: 'tip-moved-restored' });
    expect(f.entry('lane/done')).toMatchObject({ ref: 'lane/done', pinned: true, reason: 'keep me', addedAt: before.addedAt });
    expect(f.events().at(-1)).toMatchObject({ kind: 'auto-retire-reverted', ref: 'lane/done', restored: 'restored' });
    expect(readPendingDrops(f.clone, f.env)).toEqual([]);
  });

  describe('a retire interrupted after the drop', () => {
    async function interrupted() {
      const f = fixture();
      const tip = f.push('lane/done', 'a.txt', 'a\n');
      expect(f.run(['add', '--ref=lane/done', '--reason=keep me']).status).toBe(0);
      const killed = () => { throw new Error('killed'); };
      await expect(retireRegistration({ root: f.clone, ref: 'lane/done', expectedTip: tip, env: f.env, deps: {
        prove: () => ({ action: 'retire', reason: 'in-main', tip, evidence: {} }), afterDrop: killed } })).rejects.toThrow('killed');
      expect(f.list()).toEqual([]);
      expect(readPendingDrops(f.clone, f.env)).toMatchObject([{ kind: 'retire', ref: 'lane/done', tip }]);
      return { f, tip };
    }
    it('restores it on the next run when the tip moved', async () => {
      const { f } = await interrupted();
      const settled = await settlePendingDrops({ root: f.clone, env: f.env, deps: { tip: () => 'f'.repeat(40) } });
      expect(settled).toEqual([{ ref: 'lane/done', outcome: 'restored' }]);
      expect(f.entry('lane/done')).toMatchObject({ reason: 'keep me' });
      expect(readPendingDrops(f.clone, f.env)).toEqual([]);
    });
    it('restores it when the tip cannot be read (fails closed)', async () => {
      const { f } = await interrupted();
      expect(await settlePendingDrops({ root: f.clone, env: f.env, deps: { tip: () => undefined } })).toEqual([{ ref: 'lane/done', outcome: 'restored' }]);
      expect(f.list()).toEqual(['lane/done']);
    });
    it('confirms the drop when the tip is unchanged', async () => {
      const { f, tip } = await interrupted();
      expect(await settlePendingDrops({ root: f.clone, env: f.env, deps: { tip: () => tip } })).toEqual([{ ref: 'lane/done', outcome: 'drop-confirmed' }]);
      expect(f.list()).toEqual([]);
      expect(readPendingDrops(f.clone, f.env)).toEqual([]);
    });
    it('a guarded add settles the intent before its own check, so it is never admitted against the shorter list', async () => {
      const { f } = await interrupted();
      // The real remote tip of lane/done is unchanged, so the drop is confirmed before lane/other is checked.
      f.push('lane/other', 'o.txt', 'o\n');
      expect(f.run(['add', '--ref=lane/other']).status).toBe(0);
      expect(readPendingDrops(f.clone, f.env)).toEqual([]);
      expect(f.events().map((e) => e.kind)).toContain('auto-retired');
    });
    it('the CLI recover-drops restores it when the real remote tip moved', async () => {
      const { f } = await interrupted();
      f.push('lane/done', 'b.txt', 'pushed before the drop\n', 'origin/lane/done');
      const r = f.run(['recover-drops']);
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ settled: [{ ref: 'lane/done', outcome: 'restored' }], pending: [] });
      expect(f.entry('lane/done')).toMatchObject({ reason: 'keep me' });
    });
    it('never overwrites a newer registration of the same ref', async () => {
      const { f } = await interrupted();
      addOverlay(f.clone, { ref: 'lane/done', reason: 'newer' }, { env: f.env });
      expect(await settlePendingDrops({ root: f.clone, env: f.env, deps: { tip: () => 'f'.repeat(40) } })).toEqual([{ ref: 'lane/done', outcome: 'still-registered' }]);
      expect(f.entry('lane/done')).toMatchObject({ reason: 'newer' });
    });
  });
});

describe('daemon-overlay.mjs retire of a squash-merged, deleted branch', () => {
  const merged = (ref, tip, mergeOid, n = 7) => ({ number: n, state: 'MERGED', headRefName: ref, headRefOid: tip, mergeCommit: { oid: mergeOid } });
  const setup = () => {
    const f = fixture();
    const tip = f.push('lane/sq', 'a.txt', 'squashed\n');
    expect(f.run(['add', '--ref=lane/sq']).status).toBe(0);
    const mergeOid = f.squash('lane/sq', 'a.txt', 'squashed\n');
    return { f, tip, mergeOid };
  };
  const retire = (f, tip) => f.run(['retire', '--ref=lane/sq', `--expected-tip=${tip}`]);

  it('retires when the merged PR headed this ref at the expected tip and its merge commit is on main', () => {
    const { f, tip, mergeOid } = setup();
    f.ghPrs([merged('lane/sq', tip, mergeOid)]);
    const r = retire(f, tip);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ retired: true, reason: 'pr-squash-merged' });
    expect(f.list()).toEqual([]);
    expect(f.events().at(-1)).toMatchObject({ kind: 'auto-retired', ref: 'lane/sq', tip });
  });

  it('restores the registration when the branch is recreated at the proved tip before the drop', async () => {
    const { f, tip, mergeOid } = setup();
    const r = await retireRegistration({ root: f.clone, ref: 'lane/sq', expectedTip: tip, env: f.env, deps: {
      prove: () => ({ ref: 'lane/sq', action: 'retire', reason: 'pr-squash-merged', tip, pr: 7, evidence: { refGone: true, mergeCommit: mergeOid } }),
      tip: () => tip, // the branch is back on origin at the very tip the PR had
    } });
    expect(r).toMatchObject({ retired: false, refused: 'tip-moved-restored' });
    expect(f.list()).toEqual(['lane/sq']);
  });

  it('an interrupted squash retire is restored on recovery when the branch reappeared at the proved tip', async () => {
    const { f, tip, mergeOid } = setup();
    await expect(retireRegistration({ root: f.clone, ref: 'lane/sq', expectedTip: tip, env: f.env, deps: {
      prove: () => ({ ref: 'lane/sq', action: 'retire', reason: 'pr-squash-merged', tip, pr: 7, evidence: { refGone: true, mergeCommit: mergeOid } }),
      tip: () => null, afterDrop: () => { throw new Error('killed'); } } })).rejects.toThrow('killed');
    expect(f.list()).toEqual([]);
    expect(await settlePendingDrops({ root: f.clone, env: f.env, deps: { tip: () => tip } })).toEqual([{ ref: 'lane/sq', outcome: 'restored' }]);
    expect(f.list()).toEqual(['lane/sq']);
    // and with the branch still deleted, the drop is confirmed
    await expect(retireRegistration({ root: f.clone, ref: 'lane/sq', expectedTip: tip, env: f.env, deps: {
      prove: () => ({ ref: 'lane/sq', action: 'retire', reason: 'pr-squash-merged', tip, pr: 7, evidence: { refGone: true, mergeCommit: mergeOid } }),
      tip: () => null, afterDrop: () => { throw new Error('killed'); } } })).rejects.toThrow('killed');
    expect(await settlePendingDrops({ root: f.clone, env: f.env, deps: { tip: () => null } })).toEqual([{ ref: 'lane/sq', outcome: 'drop-confirmed' }]);
  });

  it('refuses when the merge commit is not an ancestor of main', () => {
    const { f, tip } = setup();
    f.ghPrs([merged('lane/sq', tip, tip)]); // the (deleted) branch tip is not on main
    expect(JSON.parse(retire(f, tip).stdout)).toMatchObject({ retired: false, refused: 'not-proved' });
    expect(f.list()).toEqual(['lane/sq']);
  });

  it('refuses when the merged PR head was a different commit than the expected tip', () => {
    const { f, tip, mergeOid } = setup();
    f.ghPrs([merged('lane/sq', 'e'.repeat(40), mergeOid)]);
    expect(JSON.parse(retire(f, tip).stdout)).toMatchObject({ retired: false });
    expect(f.list()).toEqual(['lane/sq']);
  });

  it('refuses when two merged PRs headed this ref (ambiguous)', () => {
    const { f, tip, mergeOid } = setup();
    f.ghPrs([merged('lane/sq', tip, mergeOid, 7), merged('lane/sq', tip, mergeOid, 8)]);
    expect(JSON.parse(retire(f, tip).stdout)).toMatchObject({ retired: false, refused: 'not-proved' });
  });

  it('refuses when the PR is not merged', () => {
    const { f, tip, mergeOid } = setup();
    f.ghPrs([{ ...merged('lane/sq', tip, mergeOid), state: 'CLOSED' }]);
    expect(JSON.parse(retire(f, tip).stdout)).toMatchObject({ retired: false, refused: 'not-proved' });
  });

  it('refuses when GitHub gives no PR at all', () => {
    const { f, tip } = setup();
    expect(JSON.parse(retire(f, tip).stdout)).toMatchObject({ retired: false, refused: 'not-proved' });
  });

  it('does not use the squash proof while the branch still exists with unmerged work', () => {
    const f = fixture();
    const tip = f.push('lane/sq', 'a.txt', 'first\n');
    expect(f.run(['add', '--ref=lane/sq']).status).toBe(0);
    const mergeOid = f.squash('lane/sq', 'a.txt', 'first\n');
    const tip2 = f.push('lane/sq', 'b.txt', 'extra unmerged work\n', tip);
    f.ghPrs([merged('lane/sq', tip, mergeOid)]);
    expect(JSON.parse(retire(f, tip2).stdout)).toMatchObject({ retired: false, refused: 'not-proved' });
    expect(f.list()).toEqual(['lane/sq']);
  });
});

describe('daemon-overlay.mjs add records the PR when GitHub knows it', () => {
  const originHead = { headRepository: { nameWithOwner: 'web-everything/web-everything' }, isCrossRepository: false };

  it('closing a same-name fork PR cannot remove unmerged origin work in the rebuild planner', async () => {
    const f = fixture();
    const tip = f.push('lane/known', 'a.txt', 'unmerged origin work\n');
    f.ghPrs([{ number: 9, state: 'OPEN', headRefName: 'lane/known',
      headRepository: { nameWithOwner: 'contributor/web-everything' }, isCrossRepository: true }]);
    const r = f.run(['add', '--ref=lane/known'], { WE_DAEMON_OVERLAY_INFER_PR: '1' });
    expect(r.status, r.stderr).toBe(0);
    const stateQueries = [];
    const plan = await planRebuild({
      git: (args, opts = {}) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: f.author, encoding: 'utf8', env: { ...f.env, ...opts.env }, timeout: 20_000,
      }),
      headSha: gitOk(f.author, ['rev-parse', 'origin/main']), mainRef: 'origin/main',
      overlays: [f.entry('lane/known')],
      prState: (pr) => { stateQueries.push(pr); return 'CLOSED'; },
    });
    expect(plan.ok).toBe(true);
    expect(plan.applied).toMatchObject([{ ref: 'lane/known', sha: tip }]);
    expect(stateQueries).toEqual([]);
    expect(f.entry('lane/known').pr).toBe(null);
  });

  it('fills in the PR of the single open PR headed by the ref', () => {
    const f = fixture();
    f.push('lane/known', 'a.txt', 'a\n');
    f.ghPrs([{ number: 9, state: 'OPEN', headRefName: 'lane/known', ...originHead }]);
    expect(f.run(['add', '--ref=lane/known'], { WE_DAEMON_OVERLAY_INFER_PR: '1' }).status).toBe(0);
    expect(f.entry('lane/known').pr).toBe(9);
  });

  it('leaves the PR empty when two PRs head the ref', () => {
    const f = fixture();
    f.push('lane/known', 'a.txt', 'a\n');
    f.ghPrs([{ number: 9, state: 'OPEN', headRefName: 'lane/known', ...originHead }, { number: 10, state: 'OPEN', headRefName: 'lane/known', ...originHead }]);
    expect(f.run(['add', '--ref=lane/known'], { WE_DAEMON_OVERLAY_INFER_PR: '1' }).status).toBe(0);
    expect(f.entry('lane/known').pr).toBe(null);
  });

  it.each([false, true])('replace records only origin PRs (fork: %s)', (fork) => {
    const f = fixture();
    f.push('lane/old-top', 'a.txt', 'a\n');
    expect(f.run(['add', '--ref=lane/old-top']).status).toBe(0);
    const tip = f.push('lane/new-top', 'b.txt', 'b\n', 'origin/lane/old-top');
    f.ghPrs([{ number: 9, state: 'OPEN', headRefName: 'lane/new-top',
      ...(fork ? { headRepository: { nameWithOwner: 'contributor/web-everything' }, isCrossRepository: true } : originHead) }]);
    const r = f.run(['replace', '--ref=lane/new-top', '--replaces=lane/old-top', `--expected-sha=${tip}`], { WE_DAEMON_OVERLAY_INFER_PR: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(f.entry('lane/new-top').pr).toBe(fork ? null : 9);
  });
});

describe('inferPrNumber origin identity and incomplete evidence', () => {
  const originUrl = 'git@github.com:web-everything/web-everything.git';
  const sameRepo = { number: 9, headRefName: 'lane/known',
    headRepository: { nameWithOwner: 'web-everything/web-everything' }, isCrossRepository: false };
  function infer(prs, { repo = 'web-everything/web-everything', originStatus = 0, listStatus = 0, repoStatus = 0, raw } = {}) {
    const calls = [];
    const value = inferPrNumber({ root: '/unused', ref: 'lane/known', env: {}, run: (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git') return { status: originStatus, stdout: originUrl };
      if (args[0] === 'repo') return { status: repoStatus, stdout: repo };
      return { status: listStatus, stdout: raw ?? JSON.stringify(prs) };
    } });
    return { value, calls };
  }

  it('resolves the origin remote explicitly rather than the gh default repository', () => {
    const { value, calls } = infer([sameRepo]);
    expect(value).toBe(9);
    expect(calls[0]).toEqual(['git', 'remote', 'get-url', 'origin']);
    expect(calls[1]).toEqual(['gh', 'repo', 'view', originUrl, '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
    expect(calls[2][calls[2].indexOf('--json') + 1].split(',')).toEqual(expect.arrayContaining(['headRepository', 'isCrossRepository']));
  });

  it.each([
    ['fork', { ...sameRepo, isCrossRepository: true, headRepository: { nameWithOwner: 'contributor/web-everything' } }],
    ['other owner despite same-repo flag', { ...sameRepo, headRepository: { nameWithOwner: 'contributor/web-everything' } }],
    ['other repository with same owner', { ...sameRepo, headRepository: { nameWithOwner: 'web-everything/unrelated' } }],
    ['cross-repository flag contradicts identity', { ...sameRepo, isCrossRepository: true }],
    ['unknown repository', { ...sameRepo, headRepository: null }],
    ['missing full identity', { ...sameRepo, headRepository: { name: 'web-everything' } }],
    ['missing cross-repository flag', { ...sameRepo, isCrossRepository: undefined }],
    ['wrong ref', { ...sameRepo, headRefName: 'lane/other' }],
    ['non-integer PR', { ...sameRepo, number: '9' }],
    ['non-positive PR', { ...sameRepo, number: 0 }],
  ])('refuses %s evidence', (_name, pr) => {
    expect(infer([pr]).value).toBe(null);
  });

  it('ignores a fork when exactly one origin PR matches', () => {
    expect(infer([{ ...sameRepo, number: 10, isCrossRepository: true,
      headRepository: { nameWithOwner: 'contributor/web-everything' } }, sameRepo]).value).toBe(9);
  });

  it('compares GitHub repository identity without case sensitivity', () => {
    expect(infer([{ ...sameRepo, headRepository: { nameWithOwner: 'Web-Everything/Web-Everything' } }]).value).toBe(9);
  });

  it.each([
    ['none', []], ['ambiguous', [sameRepo, { ...sameRepo, number: 10 }]],
    ['limit reached', [sameRepo, ...Array.from({ length: 4 }, (_, i) => ({ ...sameRepo, number: 10 + i, headRefName: 'lane/other' }))]],
  ])('refuses %s results', (_name, prs) => {
    expect(infer(prs).value).toBe(null);
  });

  it.each([
    { originStatus: 1 }, { repoStatus: 1 }, { listStatus: 1 }, { repo: 'invalid' },
    { raw: '{' }, { raw: '{}' }, { raw: 'null' },
  ])('refuses unreadable or malformed lookup: %j', (opts) => {
    expect(infer([sameRepo], opts).value).toBe(null);
  });
});

describe('replaceRegistration races', () => {
  it.each(['old', 'new'])('restores the old registration when the %s tip moved before the drop', async (moved) => {
    const f = fixture();
    const oldTip = f.push('lane/old-top', 'a.txt', 'a\n');
    expect(f.run(['add', '--ref=lane/old-top']).status).toBe(0);
    const newTip = f.push('lane/new-top', 'b.txt', 'b\n', 'origin/lane/old-top');
    const r = await replaceRegistration({ root: f.clone, ref: 'lane/new-top', old: 'lane/old-top', expectedSha: newTip, env: f.env, deps: {
      contain: () => ({ ok: true, contained: true, oldTip, newTip }),
      check: () => ({ ok: true, clean: true, candSha: newTip }),
      tip: (ref) => ((ref === 'lane/old-top') === (moved === 'old') ? 'f'.repeat(40) : ref === 'lane/old-top' ? oldTip : newTip),
    } });
    expect(r).toMatchObject({ ok: false, registered: true, refused: 'replace-raced-restored' });
    expect(f.list().sort()).toEqual(['lane/new-top', 'lane/old-top']);
    expect(f.events().at(-1)).toMatchObject({ kind: 'replace-reverted', ref: 'lane/old-top' });
  });

  it('requires a reason for --allow-no-pr, like add', () => {
    const f = fixture();
    const r = f.run(['replace', '--ref=lane/new-top', '--replaces=lane/old-top', `--expected-sha=${'a'.repeat(40)}`, '--allow-no-pr']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--allow-no-pr requires --reason');
  });
});
