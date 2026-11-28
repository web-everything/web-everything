// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { findRawPushes } from '../push-gate-lint.mjs';
import { planWrongBranchHeal, healWrongBranch, parseTrackedChanges, resolveWrongBranchHealSettings, IN_PROGRESS_MARKERS } from '../daemon-rebuild/wrong-branch-heal.mjs';

const settings = { branches: ['ops/review-requests'], pathPrefixes: ['verdict-ledger/'] };

it('keeps detached recovery within the original two Git exceptions and rejects an added push', () => {
  const file = 'scripts/lib/daemon-rebuild/wrong-branch-heal.mjs';
  const source = readFileSync(new URL('../daemon-rebuild/wrong-branch-heal.mjs', import.meta.url), 'utf8');
  const allow = JSON.parse(readFileSync(new URL('../../push-gate-allowlist.json', import.meta.url), 'utf8'));
  const budget = allow.entries[file].sites;
  expect(budget).toBe(2);
  const sites = findRawPushes(source, file);
  expect(sites).toHaveLength(budget);
  // Each counted call must visibly pin its command; renaming a helper cannot hide a new exemption.
  expect(sites.map(site => source.split('\n')[site.line - 1].match(/git\(\['(merge-base|update-ref)'/)?.[1]).sort())
    .toEqual(['merge-base', 'update-ref']);
  expect(findRawPushes(`${source}\ngit(['push', 'origin', 'main']);`, file).length).toBeGreaterThan(budget);
});

// DAEMON-CLONE-DETACHED-HEAL fixtures never inherit Git configuration, hooks, cwd or daemon state.
const detachedTemps = [];
afterEach(() => { for (const dir of detachedTemps.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function detachedFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'detached-heal-'));
  detachedTemps.push(dir);
  const root = join(dir, 'clone');
  const origin = join(dir, 'origin.git');
  mkdirSync(root);
  const env = {
    PATH: process.env.PATH, HOME: dir, TMPDIR: dir, LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, 'no-global-config'),
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2026-11-27T12:00:00Z', GIT_COMMITTER_DATE: '2026-11-27T12:00:00Z',
  };
  const calls = [];
  const git = args => {
    calls.push(args);
    return spawnSync('git', args, { cwd: root, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
  };
  const ok = args => { const r = git(args); expect(r.status, r.stderr).toBe(0); return r.stdout.trim(); };
  ok(['init', '--bare', '--quiet', '-b', 'main', origin]);
  ok(['init', '--quiet', '-b', 'main']);
  ok(['remote', 'add', 'origin', origin]);
  writeFileSync(join(root, 'tracked.txt'), 'A\n');
  writeFileSync(join(root, 'collision.txt'), 'adopted bytes\n');
  writeFileSync(join(root, '.gitignore'), 'collision.txt\n');
  ok(['add', '-f', 'tracked.txt', 'collision.txt', '.gitignore']);
  ok(['commit', '--quiet', '-m', 'A: adopted']);
  const adoptedHead = ok(['rev-parse', 'HEAD']);
  ok(['checkout', '--quiet', '--detach']);
  ok(['rm', '--quiet', 'collision.txt']);
  writeFileSync(join(root, 'tracked.txt'), 'B\n');
  ok(['add', 'tracked.txt']);
  ok(['commit', '--quiet', '-m', 'B: detached']);
  const oldHead = ok(['rev-parse', 'HEAD']);
  writeFileSync(join(root, 'tracked.txt'), 'C\n');
  ok(['add', 'tracked.txt']);
  ok(['commit', '--quiet', '-m', 'C: remote tip']);
  const tip = ok(['rev-parse', 'HEAD']);
  // Remote IO is deliberately replaced with an explicit local tracking ref.
  ok(['update-ref', 'refs/remotes/origin/main', tip]);
  ok(['checkout', '--quiet', '--detach', oldHead]);
  const refs = () => ok(['for-each-ref', '--format=%(refname)', 'refs/we/wrong-branch-heal/']).split('\n').filter(Boolean);
  const heal = (extra = {}) => healWrongBranch({ git, settings, adoptedHead, now: () => 1234, ...extra });
  const unchanged = (head = oldHead, main = adoptedHead) => {
    expect(ok(['rev-parse', 'HEAD'])).toBe(head);
    expect(ok(['rev-parse', 'refs/heads/main'])).toBe(main);
    expect(git(['symbolic-ref', '--quiet', 'HEAD']).status).toBe(1);
    expect(refs()).toEqual([]);
  };
  return { dir, root, git, ok, calls, adoptedHead, oldHead, tip, refs, heal, unchanged };
}

describe('DAEMON-CLONE-DETACHED-HEAL', () => {
  const pure = overrides => planWrongBranchHeal({ branch: null, headSha: 'b'.repeat(40), mainSha: 'a'.repeat(40),
    adoptedHead: 'a'.repeat(40), headReachability: 'reachable', changedPaths: [], hasMain: true, settings, inProgress: [], ...overrides });

  it.each(['origin/main', 'ancestor'])('heals-detached-ahead-of-main: %s, preserving old HEAD under a named ref', where => {
    const f = detachedFixture();
    const head = where === 'origin/main' ? f.tip : f.oldHead;
    f.ok(['checkout', '--quiet', '--detach', head]);
    expect(f.git(['merge-base', '--is-ancestor', f.adoptedHead, head]).status).toBe(0);
    expect(head).not.toBe(f.adoptedHead);
    const result = f.heal();
    expect(result.healed).toBe(true);
    expect(f.ok(['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
    expect(f.ok(['rev-parse', 'HEAD'])).toBe(f.adoptedHead);
    expect(result.savedRef).toBe(`refs/we/wrong-branch-heal/1234-${head.slice(0, 9)}`);
    expect(f.ok(['rev-parse', result.savedRef])).toBe(head);
    expect(f.calls).toContainEqual(['merge-base', '--is-ancestor', head, 'refs/remotes/origin/main']);
    expect(f.calls).toContainEqual(['checkout', '--quiet', '--no-overwrite-ignore', 'main']);
    const save = f.calls.find(args => args[0] === 'update-ref' && args.includes(result.savedRef));
    expect(save.slice(-2)).toEqual([head, '0'.repeat(40)]);
  });

  it('refuses dirty tracked tree before saving', () => {
    const f = detachedFixture();
    writeFileSync(join(f.root, 'tracked.txt'), 'dirty\n');
    expect(f.heal().reason).toBe('detached-with-changes');
    f.unchanged();
    expect(readFileSync(join(f.root, 'tracked.txt'), 'utf8')).toBe('dirty\n');
  });
  it('refuses foreign detached commits before saving', () => {
    const f = detachedFixture();
    f.ok(['update-ref', 'refs/remotes/origin/main', f.adoptedHead]);
    expect(f.heal().reason).toBe('detached-foreign-commit');
    f.unchanged();
  });
  it('refuses local main different from the adopted head', () => {
    const f = detachedFixture();
    expect(f.heal({ adoptedHead: f.tip }).reason).toBe('detached-not-adopted');
    f.unchanged();
  });
  it.each([
    ['adoptedHead', null], ['adoptedHead', 'bad'], ['mainSha', 'bad'], ['headSha', 'bad'],
  ])('refuses invalid %s=%s before saving', (field, value) => {
    expect(pure({ [field]: value }).reason).toBe('detached-not-adopted');
    const f = detachedFixture();
    const git = args => {
      if (args.join(' ') === `rev-parse --verify --quiet ${field === 'mainSha' ? 'refs/heads/main' : 'HEAD'}` && field !== 'adoptedHead') {
        return { status: 0, stdout: value };
      }
      return f.git(args);
    };
    expect(f.heal({ git, ...(field === 'adoptedHead' ? { adoptedHead: value } : {}) }).reason).toBe('detached-not-adopted');
    f.unchanged();
  });
  it.each(IN_PROGRESS_MARKERS)('refuses operation marker %s at the helper', marker => {
    const f = detachedFixture();
    writeFileSync(join(f.root, '.git', marker), 'paused\n');
    expect(f.heal().reason).toBe('operation-in-progress');
    f.unchanged();
    expect(readFileSync(join(f.root, '.git', marker), 'utf8')).toBe('paused\n');
  });
  it.each(['missing-origin-main', 'exit-128', 'timeout', 'throw'])('refuses unreadable reachability: %s', fault => {
    const f = detachedFixture();
    if (fault === 'missing-origin-main') f.ok(['update-ref', '-d', 'refs/remotes/origin/main']);
    const git = args => {
      if (args[0] === 'merge-base' && fault !== 'missing-origin-main') {
        if (fault === 'throw') throw new Error('injected unreadable reachability');
        return { status: fault === 'timeout' ? null : 128, stdout: '', error: new Error(fault) };
      }
      return f.git(args);
    };
    expect(f.heal({ git }).reason).toBe('detached-reachability-unreadable');
    f.unchanged();
  });
  it.each([undefined, 'unexpected', 'unreadable'])('pure reachability %s fails closed', headReachability => {
    expect(pure({ headReachability }).reason).toBe('detached-reachability-unreadable');
  });
  it('save-failed stops without attempting checkout', () => {
    const f = detachedFixture();
    const calls = [];
    const git = args => { calls.push(args); return args[0] === 'update-ref' ? { status: 128, stderr: 'injected save refusal' } : f.git(args); };
    expect(f.heal({ git }).reason).toBe('save-failed');
    expect(calls.some(args => args[0] === 'checkout')).toBe(false);
    f.unchanged();
  });
  it.each(['untracked', 'ignored'])('switch-failed preserves %s collision bytes and saved ref', collision => {
    const f = detachedFixture();
    // The untracked variant removes the ignore rule in its own detached commit.
    let head = f.oldHead;
    if (collision === 'untracked') {
      writeFileSync(join(f.root, '.gitignore'), '');
      f.ok(['add', '.gitignore']); f.ok(['commit', '--quiet', '-m', 'remove ignore rule']);
      head = f.ok(['rev-parse', 'HEAD']);
      f.ok(['update-ref', 'refs/remotes/origin/main', head]);
    }
    const bytes = Buffer.from([0, 1, 255, 10, 13]);
    writeFileSync(join(f.root, 'collision.txt'), bytes);
    const result = f.heal();
    expect(result.reason).toBe('switch-failed');
    expect(f.git(['symbolic-ref', '--quiet', 'HEAD']).status).toBe(1);
    expect(f.ok(['rev-parse', 'HEAD'])).toBe(head);
    expect(f.ok(['rev-parse', result.detail.savedRef])).toBe(head);
    expect(f.refs()).toEqual([result.detail.savedRef]);
    expect(readFileSync(join(f.root, 'collision.txt'))).toEqual(bytes);
  });
  it.each(['head', 'main', 'head-unreadable', 'main-missing', 'dirty', 'status-unreadable', 'marker', 'git-dir-unreadable'])(
    're-verifies before mutation: %s changed since planning', change => {
      const f = detachedFixture();
      let statusRead = false;
      let mutated = false;
      const git = args => {
        const key = args.join(' ');
        if (statusRead && !mutated) {
          mutated = true;
          if (change === 'head') f.ok(['checkout', '--quiet', '--detach', f.tip]);
          if (change === 'main') f.ok(['update-ref', 'refs/heads/main', f.tip]);
          if (change === 'main-missing') f.ok(['update-ref', '-d', 'refs/heads/main']);
          if (change === 'dirty') writeFileSync(join(f.root, 'tracked.txt'), 'raced\n');
          if (change === 'marker') writeFileSync(join(f.root, '.git', 'REBASE_HEAD'), f.oldHead);
        }
        if (statusRead && ((change === 'head-unreadable' && key === 'rev-parse --verify --quiet HEAD')
          || (change === 'status-unreadable' && args[0] === 'status')
          || (change === 'git-dir-unreadable' && key === 'rev-parse --absolute-git-dir'))) return { status: 128, stdout: '' };
        const result = f.git(args);
        if (args[0] === 'status') statusRead = true;
        return result;
      };
      const reason = { dirty: 'detached-with-changes', 'status-unreadable': 'status-unreadable', marker: 'operation-in-progress',
        'git-dir-unreadable': 'git-dir-unreadable' }[change] ?? 'detached-state-changed';
      const result = f.heal({ git });
      expect(result.reason).toBe(reason);
      if (reason === 'detached-state-changed') expect(result.detail.field).toBe(change.startsWith('head') ? 'headSha' : 'mainSha');
      expect(mutated).toBe(true);
      expect(f.ok(['rev-parse', 'HEAD'])).toBe(change === 'head' ? f.tip : f.oldHead);
      if (change !== 'main-missing') expect(f.ok(['rev-parse', 'refs/heads/main'])).toBe(change === 'main' ? f.tip : f.adoptedHead);
      else expect(f.git(['rev-parse', '--verify', 'refs/heads/main']).status).not.toBe(0);
      expect(f.refs()).toEqual([]);
    });
  it('re-verifies before checkout: HEAD moved after saving refuses checkout and retains the original HEAD', () => {
    const f = detachedFixture();
    const calls = [];
    let savedRef = null;
    let interveningHead = null;
    const git = args => {
      calls.push(args);
      const result = f.git(args);
      if (args[0] === 'update-ref' && args[1].startsWith('refs/we/wrong-branch-heal/') && result.status === 0) {
        savedRef = args[1];
        expect(f.ok(['rev-parse', savedRef])).toBe(f.oldHead);
        writeFileSync(join(f.root, 'tracked.txt'), 'intervening committed work\n');
        f.ok(['add', 'tracked.txt']);
        f.ok(['commit', '--quiet', '-m', 'intervening work after audit save']);
        interveningHead = f.ok(['rev-parse', 'HEAD']);
      }
      return result;
    };
    const result = f.heal({ git });
    expect(interveningHead).toMatch(/^[a-f0-9]{40}$/);
    expect(interveningHead).not.toBe(f.oldHead);
    expect(result).toEqual({ healed: false, reason: 'detached-state-changed', detail: { field: 'headSha', savedRef } });
    expect(calls.filter(args => args[0] === 'checkout')).toEqual([]);
    expect(f.ok(['rev-parse', 'HEAD'])).toBe(interveningHead);
    expect(f.git(['symbolic-ref', '--quiet', 'HEAD']).status).toBe(1);
    expect(f.ok(['rev-parse', 'refs/heads/main'])).toBe(f.adoptedHead);
    expect(readFileSync(join(f.root, 'tracked.txt'), 'utf8')).toBe('intervening committed work\n');
    expect(f.refs()).toEqual([savedRef]);
    expect(f.ok(['rev-parse', result.detail.savedRef])).toBe(f.oldHead);
  });
  it.each(['save', 'switch'])('reverify refuses HEAD attached at same sha before %s', before => {
    const f = detachedFixture();
    const branch = 'fixture-unallowlisted';
    const calls = [];
    let attached = false;
    const git = args => {
      calls.push(args);
      const result = f.git(args);
      if (!attached && args[0] === (before === 'save' ? 'merge-base' : 'update-ref')) {
        expect(result.status).toBe(0);
        f.ok(['checkout', '--quiet', '-b', branch]);
        attached = true;
      }
      return result;
    };
    const result = f.heal({ git });
    const savedRef = `refs/we/wrong-branch-heal/1234-${f.oldHead.slice(0, 9)}`;
    expect(result).toEqual({ healed: false, reason: 'detached-state-changed',
      detail: { field: 'detached', ...(before === 'switch' ? { savedRef } : {}) } });
    expect(attached).toBe(true);
    expect(calls.filter(args => args[0] === 'checkout')).toEqual([]);
    expect(calls.filter(args => args[0] === 'update-ref')).toHaveLength(before === 'switch' ? 1 : 0);
    expect(f.ok(['symbolic-ref', 'HEAD'])).toBe(`refs/heads/${branch}`);
    expect(f.ok(['rev-parse', 'HEAD'])).toBe(f.oldHead);
    expect(f.ok(['rev-parse', 'refs/heads/main'])).toBe(f.adoptedHead);
    expect(f.refs()).toEqual(before === 'switch' ? [savedRef] : []);
    if (before === 'switch') expect(f.ok(['rev-parse', result.detail.savedRef])).toBe(f.oldHead);
  });
  it.each(['save', 'switch'].flatMap(before => ['exit-128', 'timeout', 'missing-result', 'throw'].map(fault => [before, fault])))(
    'reverify refuses unreadable detached state before %s: %s', (before, fault) => {
      const f = detachedFixture();
      const calls = [];
      let saved = false;
      const git = args => {
        calls.push(args);
        if (args.join(' ') === 'symbolic-ref -q HEAD' && (before === 'save' || saved)) {
          if (fault === 'throw') throw new Error('injected detached-state read failure');
          if (fault === 'missing-result') return undefined;
          return { status: fault === 'timeout' ? null : 128, stdout: '' };
        }
        const result = f.git(args);
        if (args[0] === 'update-ref') { expect(result.status).toBe(0); saved = true; }
        return result;
      };
      const result = f.heal({ git });
      const savedRef = `refs/we/wrong-branch-heal/1234-${f.oldHead.slice(0, 9)}`;
      expect(result).toEqual({ healed: false, reason: 'detached-state-changed',
        detail: { field: 'detached', ...(before === 'switch' ? { savedRef } : {}) } });
      expect(calls.filter(args => args[0] === 'checkout')).toEqual([]);
      expect(calls.filter(args => args[0] === 'update-ref')).toHaveLength(before === 'switch' ? 1 : 0);
      expect(f.ok(['rev-parse', 'HEAD'])).toBe(f.oldHead);
      expect(f.git(['symbolic-ref', '--quiet', 'HEAD']).status).toBe(1);
      expect(f.refs()).toEqual(before === 'switch' ? [savedRef] : []);
      if (before === 'switch') expect(f.ok(['rev-parse', result.detail.savedRef])).toBe(f.oldHead);
    });
  it.each(['save', 'switch'].flatMap(before => ['unreachable', 'missing-origin-main', 'exit-128', 'timeout', 'throw'].map(fault => [before, fault])))(
    'reverify refuses origin/main no longer containing HEAD before %s: %s', (before, fault) => {
      const f = detachedFixture();
      const calls = [];
      let changed = false;
      const git = args => {
        calls.push(args);
        if (changed && args[0] === 'merge-base' && !['unreachable', 'missing-origin-main'].includes(fault)) {
          if (fault === 'throw') throw new Error('injected reachability read failure');
          return { status: fault === 'timeout' ? null : 128, stdout: '' };
        }
        const result = f.git(args);
        if (!changed && args[0] === (before === 'save' ? 'merge-base' : 'update-ref')) {
          expect(result.status).toBe(0);
          if (fault === 'unreachable') f.ok(['update-ref', 'refs/remotes/origin/main', f.adoptedHead]);
          if (fault === 'missing-origin-main') f.ok(['update-ref', '-d', 'refs/remotes/origin/main']);
          changed = true;
        }
        return result;
      };
      const result = f.heal({ git });
      const savedRef = `refs/we/wrong-branch-heal/1234-${f.oldHead.slice(0, 9)}`;
      expect(result).toEqual({ healed: false, reason: 'detached-state-changed',
        detail: { field: 'reachability', ...(before === 'switch' ? { savedRef } : {}) } });
      expect(changed).toBe(true);
      expect(calls.filter(args => args[0] === 'checkout')).toEqual([]);
      expect(calls.filter(args => args[0] === 'update-ref')).toHaveLength(before === 'switch' ? 1 : 0);
      expect(f.ok(['rev-parse', 'HEAD'])).toBe(f.oldHead);
      expect(f.git(['symbolic-ref', '--quiet', 'HEAD']).status).toBe(1);
      expect(f.ok(['rev-parse', 'refs/heads/main'])).toBe(f.adoptedHead);
      expect(f.refs()).toEqual(before === 'switch' ? [savedRef] : []);
      if (before === 'switch') expect(f.ok(['rev-parse', result.detail.savedRef])).toBe(f.oldHead);
      if (fault === 'unreachable') expect(f.ok(['rev-parse', 'refs/remotes/origin/main'])).toBe(f.adoptedHead);
      if (fault === 'missing-origin-main') expect(f.git(['rev-parse', '--verify', 'refs/remotes/origin/main']).status).toBe(128);
    });
  it('saved-ref collision never replaces an existing audit ref', () => {
    const f = detachedFixture();
    const ref = `refs/we/wrong-branch-heal/1234-${f.oldHead.slice(0, 9)}`;
    f.ok(['update-ref', ref, f.adoptedHead]);
    const result = f.heal();
    expect(result).toMatchObject({ healed: false, reason: 'save-failed' });
    expect(f.ok(['rev-parse', ref])).toBe(f.adoptedHead);
    expect(f.ok(['rev-parse', 'HEAD'])).toBe(f.oldHead);
    expect(f.git(['symbolic-ref', '--quiet', 'HEAD']).status).toBe(1);
  });
  it('unreadable HEAD wins over malformed adoptedHead', () => {
    const f = detachedFixture();
    const git = args => args.join(' ') === 'rev-parse --verify --quiet HEAD' ? { status: 128, stdout: '' } : f.git(args);
    expect(f.heal({ git, adoptedHead: 'bad' }).reason).toBe('detached-or-unreadable-head');
    f.unchanged();
  });
  it('detached at main needs no adoption evidence, reachability or saved ref', () => {
    const f = detachedFixture();
    f.ok(['checkout', '--quiet', '--detach', f.adoptedHead]);
    const calls = [];
    const git = args => { calls.push(args); return f.git(args); };
    expect(f.heal({ git, adoptedHead: null })).toMatchObject({ healed: true, savedRef: null });
    expect(calls.some(args => ['merge-base', 'update-ref'].includes(args[0]))).toBe(false);
    expect(f.refs()).toEqual([]);
  });
  it.each([
    ['operation-in-progress', { inProgress: ['REBASE_HEAD'], headSha: null }],
    ['git-dir-unreadable', { inProgress: null, headSha: null }],
    ['detached-or-unreadable-head', { headSha: null, hasMain: false }],
    ['no-local-main', { hasMain: false, changedPaths: null }],
    ['status-unreadable', { changedPaths: null, adoptedHead: null }],
    ['detached-with-changes', { changedPaths: ['tracked.txt'], adoptedHead: null }],
    ['detached-not-adopted', { adoptedHead: null, headReachability: 'unreadable' }],
    ['detached-reachability-unreadable', { headReachability: 'unreadable' }],
    ['detached-foreign-commit', { headReachability: 'unreachable' }],
  ])('precedence: %s wins over later refusals', (reason, overrides) => expect(pure(overrides).reason).toBe(reason));
});
const mainSha = '536356170' + '0'.repeat(31);
const detachedCases = [
  { name: 'clean HEAD at main', headSha: mainSha, changedPaths: [], expected: { heal: true, savedRefNeeded: false } },
  { name: 'tracked store change at main', headSha: mainSha, changedPaths: ['verdict-ledger/x'], expected: { heal: false, reason: 'detached-with-changes' } },
  { name: 'tracked non-store change at main', headSha: mainSha, changedPaths: ['scripts/x'], expected: { heal: false, reason: 'detached-with-changes' } },
  { name: 'HEAD off main without adoption evidence', headSha: '1'.repeat(40), changedPaths: [], expected: { heal: false, reason: 'detached-not-adopted' } },
  { name: 'unreadable HEAD', headSha: null, changedPaths: [], expected: { heal: false, reason: 'detached-or-unreadable-head' } },
  { name: 'missing main', headSha: mainSha, hasMain: false, changedPaths: [], expected: { heal: false, reason: 'no-local-main' } },
  { name: 'unreadable status', headSha: mainSha, changedPaths: null, expected: { heal: false, reason: 'status-unreadable' } },
];
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete ENV[k];

function gitIn(cwd) {
  return (args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
}

/** Replay of wev-review-daemon on 2026-10-09 06:55 ET: on the ledger branch, ledger file staged, untracked sidecars. */
function replayClone({ extraTracked = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wrong-branch-heal-'));
  const g = gitIn(dir);
  g(['init', '--quiet', '-b', 'main']);
  mkdirSync(join(dir, 'skills-src/conveyor'), { recursive: true });
  writeFileSync(join(dir, 'skills-src/conveyor/review-daemon.mjs'), 'export {};\n');
  writeFileSync(join(dir, '.gitignore'), '.conveyor/\n');
  g(['add', '.']); g(['commit', '--quiet', '-m', 'main']);
  g(['checkout', '--quiet', '--orphan', 'ops/review-requests']);
  g(['rm', '-r', '--quiet', '--cached', '.']);
  rmSync(join(dir, 'skills-src'), { recursive: true, force: true }); rmSync(join(dir, '.gitignore'));
  mkdirSync(join(dir, 'verdict-ledger'));
  writeFileSync(join(dir, 'verdict-ledger/web-everything-web-everything.jsonl'), '{"a":1}\n');
  g(['add', 'verdict-ledger']); g(['commit', '--quiet', '-m', 'verdict-ledger: append']);
  writeFileSync(join(dir, 'verdict-ledger/web-everything-web-everything.jsonl'), '{"a":1}\n{"b":2}\n');
  g(['add', 'verdict-ledger']);
  if (extraTracked) { writeFileSync(join(dir, 'other.txt'), 'x\n'); g(['add', 'other.txt']); }
  mkdirSync(join(dir, '.conveyor')); writeFileSync(join(dir, '.conveyor/review-daemon.log'), 'log\n');
  return { dir, g };
}

describe('planWrongBranchHeal (pure rule)', () => {
  it.each(detachedCases)('detached: $name', ({ headSha, changedPaths, hasMain = true, expected }) => {
    expect(planWrongBranchHeal({ branch: null, headSha, mainSha: hasMain ? mainSha : null, changedPaths, hasMain, settings })).toEqual(expected);
  });
  it('heals an allowlisted branch with only store changes', () => {
    expect(planWrongBranchHeal({ branch: 'ops/review-requests', changedPaths: ['verdict-ledger/x.jsonl'], hasMain: true, settings })).toEqual({ heal: true, savedRefNeeded: false });
  });
  it('refuses an unknown branch, a detached HEAD, a foreign change, no main, unreadable status', () => {
    expect(planWrongBranchHeal({ branch: 'feature/x', changedPaths: [], hasMain: true, settings }).reason).toBe('branch-not-allowlisted');
    expect(planWrongBranchHeal({ branch: null, changedPaths: [], hasMain: true, settings }).reason).toBe('detached-or-unreadable-head');
    expect(planWrongBranchHeal({ branch: 'ops/review-requests', changedPaths: ['scripts/a.mjs'], hasMain: true, settings }).reason).toBe('non-store-changes');
    expect(planWrongBranchHeal({ branch: 'ops/review-requests', changedPaths: [], hasMain: false, settings }).reason).toBe('no-local-main');
    expect(planWrongBranchHeal({ branch: 'ops/review-requests', changedPaths: null, hasMain: true, settings }).reason).toBe('status-unreadable');
  });
  it('parses renames as both paths', () => {
    expect(parseTrackedChanges('M  verdict-ledger/a\0R  b\0c\0')).toEqual(['verdict-ledger/a', 'b', 'c']);
  });
  it('settings: defaults when malformed, file values when valid', () => {
    expect(resolveWrongBranchHealSettings({ read: () => '{' })).toEqual(settings);
    expect(resolveWrongBranchHealSettings({ read: () => '{"wrongBranchHeal":{"branches":["ops/x"]}}' }).branches).toEqual(['ops/x']);
  });
});

describe('healWrongBranch (2026-10-11 detached drain-daemon clone)', () => {
  const emptyGitDir = mkdtempSync(join(tmpdir(), 'wrong-branch-heal-gitdir-'));
  it.each(detachedCases)('detached IO: $name', ({ headSha, changedPaths, hasMain = true, expected }) => {
    const calls = [];
    const git = (args) => {
      calls.push(args);
      switch (args.join(' ')) {
        case 'symbolic-ref --short HEAD': return { status: 1, stdout: '' };
        case 'rev-parse --verify --quiet HEAD': return { status: headSha ? 0 : 1, stdout: headSha ? `${headSha}\n` : '' };
        case 'rev-parse --verify --quiet refs/heads/main': return { status: hasMain ? 0 : 1, stdout: hasMain ? `${mainSha}\n` : '' };
        case 'rev-parse --absolute-git-dir': return { status: 0, stdout: `${emptyGitDir}\n` };
        case 'status --porcelain=v1 -z --untracked-files=no': return { status: changedPaths === null ? 1 : 0, stdout: (changedPaths ?? []).map((p) => ` M ${p}\0`).join('') };
        case 'checkout --quiet main': return { status: 0, stdout: '' };
        default: throw new Error(`Unexpected git command: ${args.join(' ')}`);
      }
    };
    expect(healWrongBranch({ git, settings })).toEqual(expected.heal
      ? { healed: true, from: `(detached at ${mainSha.slice(0, 9)})`, savedRef: null }
      : { healed: false, reason: expected.reason });
    expect(calls.filter(([cmd]) => cmd === 'checkout')).toEqual(expected.heal ? [['checkout', '--quiet', 'main']] : []);
  });

  it('reattaches a real clean detached HEAD at main without changing the commit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wrong-branch-heal-detached-'));
    const g = gitIn(dir);
    try {
      expect(g(['init', '--quiet', '-b', 'main']).status).toBe(0);
      writeFileSync(join(dir, 'tracked.txt'), 'main\n');
      expect(g(['add', 'tracked.txt']).status).toBe(0);
      expect(g(['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'main']).status).toBe(0);
      const sha = g(['rev-parse', '--verify', '--quiet', 'HEAD']).stdout.trim();
      expect(g(['checkout', '--quiet', '--detach']).status).toBe(0);
      expect(g(['symbolic-ref', '--short', 'HEAD']).status).not.toBe(0);
      expect(healWrongBranch({ git: g, settings })).toEqual({ healed: true, from: `(detached at ${sha.slice(0, 9)})`, savedRef: null });
      expect(g(['symbolic-ref', '--short', 'HEAD']).stdout.trim()).toBe('main');
      expect(g(['rev-parse', 'HEAD']).stdout.trim()).toBe(sha);
      expect(g(['status', '--porcelain=v1']).stdout).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('in-progress git operations block the heal (red-team: paused interactive rebase)', () => {
  it('pure rule: refuses on any in-progress operation, on both paths, and when state is unreadable', () => {
    const ops = ['rebase-merge'];
    expect(planWrongBranchHeal({ branch: null, headSha: mainSha, mainSha, changedPaths: [], hasMain: true, settings, inProgress: ops }))
      .toEqual({ heal: false, reason: 'operation-in-progress', detail: { operations: ops } });
    expect(planWrongBranchHeal({ branch: 'ops/review-requests', changedPaths: ['verdict-ledger/x'], hasMain: true, settings, inProgress: ['CHERRY_PICK_HEAD'] }).reason)
      .toBe('operation-in-progress');
    expect(planWrongBranchHeal({ branch: null, headSha: mainSha, mainSha, changedPaths: [], hasMain: true, settings, inProgress: null }).reason)
      .toBe('git-dir-unreadable');
    expect(planWrongBranchHeal({ branch: null, headSha: mainSha, mainSha, changedPaths: [], hasMain: true, settings, inProgress: [] })).toEqual({ heal: true, savedRefNeeded: false });
  });

  // Each state is created by real git, then healWrongBranch must leave HEAD detached and the operation intact.
  const scenarios = {
    'rebase paused by break before the first pick': (dir, g, ctx) => {
      g(['checkout', '--quiet', 'feature']);
      const r = spawnSync('git', ['rebase', '-i', 'main'], { cwd: dir, encoding: 'utf8', env: { ...ENV, GIT_SEQUENCE_EDITOR: `sh -c 'printf "break\\n" | cat - "$0" > "$0.new" && mv "$0.new" "$0"'` } });
      expect(r.status).toBe(0);
      expect(existsSync(join(dir, '.git/rebase-merge'))).toBe(true);
      ctx.expectIntact = () => expect(existsSync(join(dir, '.git/rebase-merge'))).toBe(true);
    },
    'cherry-pick stopped (CHERRY_PICK_HEAD present)': (dir, g, ctx) => {
      g(['checkout', '--quiet', '--detach']);
      // simulate a stopped sequencer: CHERRY_PICK_HEAD is what git leaves for a stopped pick
      writeFileSync(join(dir, '.git/CHERRY_PICK_HEAD'), `${g(['rev-parse', 'feature']).stdout.trim()}\n`);
      ctx.expectIntact = () => expect(existsSync(join(dir, '.git/CHERRY_PICK_HEAD'))).toBe(true);
    },
    'bisect in progress': (dir, g, ctx) => {
      g(['checkout', '--quiet', '--detach']);
      writeFileSync(join(dir, '.git/BISECT_LOG'), 'git bisect start\n');
      ctx.expectIntact = () => expect(existsSync(join(dir, '.git/BISECT_LOG'))).toBe(true);
    },
  };
  it.each(Object.keys(scenarios))('real clone, detached at main: %s', (name) => {
    const dir = mkdtempSync(join(tmpdir(), 'wrong-branch-heal-op-'));
    const g = gitIn(dir);
    const gc = (a) => g(['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a]);
    try {
      g(['init', '--quiet', '-b', 'main']);
      writeFileSync(join(dir, 'a.txt'), 'a\n'); g(['add', 'a.txt']); gc(['commit', '--quiet', '-m', 'a']);
      g(['checkout', '--quiet', '-b', 'feature']);
      writeFileSync(join(dir, 'b.txt'), 'b\n'); g(['add', 'b.txt']); gc(['commit', '--quiet', '-m', 'b']);
      g(['checkout', '--quiet', 'main']);
      const ctx = {};
      scenarios[name](dir, g, ctx);
      if (name.startsWith('rebase')) {
        expect(g(['symbolic-ref', '--short', 'HEAD']).status).not.toBe(0);
        expect(g(['rev-parse', 'HEAD']).stdout.trim()).toBe(g(['rev-parse', 'main']).stdout.trim());
      }
      const r = healWrongBranch({ git: g, settings });
      expect(r).toMatchObject({ healed: false, reason: 'operation-in-progress' });
      expect(g(['symbolic-ref', '--short', 'HEAD']).status).not.toBe(0);
      ctx.expectIntact();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('in-progress check: fail-closed reads and re-check before mutating', () => {
  const mk = (root, extra = {}) => (args) => {
    switch (args.join(' ')) {
      case 'symbolic-ref --short HEAD': return { status: 1, stdout: '' };
      case 'rev-parse --verify --quiet HEAD': case 'rev-parse --verify --quiet refs/heads/main': return { status: 0, stdout: `${mainSha}\n` };
      case 'rev-parse --absolute-git-dir': return { status: 0, stdout: `${root}\n` };
      case 'status --porcelain=v1 -z --untracked-files=no': extra.onStatus?.(); return { status: 0, stdout: '' };
      case 'checkout --quiet main': extra.checkedOut = true; return { status: 0, stdout: '' };
      default: throw new Error(`Unexpected git command: ${args.join(' ')}`);
    }
  };
  it('a git dir that is not a directory (stat error other than ENOENT) refuses', () => {
    const root = mkdtempSync(join(tmpdir(), 'wrong-branch-heal-notdir-'));
    try {
      writeFileSync(join(root, 'gitdir-file'), 'x');
      const extra = {};
      expect(healWrongBranch({ git: mk(join(root, 'gitdir-file'), extra), settings })).toEqual({ healed: false, reason: 'git-dir-unreadable' });
      expect(extra.checkedOut).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('an operation that starts after the plan was read (during status) still blocks the switch', () => {
    const root = mkdtempSync(join(tmpdir(), 'wrong-branch-heal-race-'));
    try {
      const extra = { onStatus: () => mkdirSync(join(root, 'rebase-merge')) };
      expect(healWrongBranch({ git: mk(root, extra), settings })).toMatchObject({ healed: false, reason: 'operation-in-progress', detail: { operations: ['rebase-merge'] } });
      expect(extra.checkedOut).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('a live git process (index.lock) blocks the switch', () => {
    const root = mkdtempSync(join(tmpdir(), 'wrong-branch-heal-lock-'));
    try {
      writeFileSync(join(root, 'index.lock'), '');
      expect(healWrongBranch({ git: mk(root), settings })).toMatchObject({ healed: false, reason: 'operation-in-progress' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('healWrongBranch (replay of the 2026-10-09 review-daemon clone)', () => {
  it('saves the ledger change to a named ref, returns to main, restores the daemon entry, keeps untracked', () => {
    const { dir, g } = replayClone();
    expect(existsSync(join(dir, 'skills-src/conveyor/review-daemon.mjs'))).toBe(false);
    const r = healWrongBranch({ git: g, settings, now: () => 42 });
    expect(r).toEqual({ healed: true, from: 'ops/review-requests', savedRef: 'refs/we/wrong-branch-heal/42' });
    expect(g(['symbolic-ref', '--short', 'HEAD']).stdout.trim()).toBe('main');
    expect(existsSync(join(dir, 'skills-src/conveyor/review-daemon.mjs'))).toBe(true);
    expect(existsSync(join(dir, '.conveyor/review-daemon.log'))).toBe(true);
    expect(g(['show', 'refs/we/wrong-branch-heal/42:verdict-ledger/web-everything-web-everything.jsonl']).stdout).toContain('"b":2');
    rmSync(dir, { recursive: true, force: true });
  });
  it('still refuses when a non-store tracked file changed, and touches nothing', () => {
    const { dir, g } = replayClone({ extraTracked: true });
    const r = healWrongBranch({ git: g, settings });
    expect(r).toMatchObject({ healed: false, reason: 'non-store-changes' });
    expect(g(['symbolic-ref', '--short', 'HEAD']).stdout.trim()).toBe('ops/review-requests');
    expect(g(['diff', '--cached', '--name-only']).stdout).toContain('other.txt');
    rmSync(dir, { recursive: true, force: true });
  });
});
