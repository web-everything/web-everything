// @repo-scanning-test scope=files — every script naming an ops/* ref is a listed by-name reader or a known non-reader.
/**
 * @file lane-git-diet.test.mjs — proof for the lane git diet: the config ops (pure + idempotent), the real-git
 *   semantics it relies on (negative refspec excludes ops/* from a default fetch, but an explicit full refspec
 *   still updates origin/ops/x), and the ops-ref reader inventory (complete, every reader fetches by name).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  LANE_DEFAULT_FETCH, LANE_OPS_NEGATIVE_FETCH, laneDietConfigOps, applyLaneDietConfig, OPS_REF_READERS,
} from '../lane-git-diet.mjs';
import { scopedScanFiles } from '../repo-scan-tests.mjs';

const REPO = join(import.meta.dirname, '..', '..', '..');
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.LANE_SESSION;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const refs = (cwd, prefix = 'refs/remotes/origin/') => git(cwd, 'for-each-ref', '--format=%(refname)', prefix).split('\n').filter(Boolean);

describe('laneDietConfigOps (pure)', () => {
  it('adds the negative refspec and both unpack limits to a stock clone', () => {
    expect(laneDietConfigOps({ fetchValues: [LANE_DEFAULT_FETCH], kv: {} })).toEqual([
      ['config', '--local', '--add', 'remote.origin.fetch', LANE_OPS_NEGATIVE_FETCH],
      ['config', '--local', '--replace-all', 'fetch.unpackLimit', '1'],
      ['config', '--local', '--replace-all', 'transfer.unpackLimit', '1'],
    ]);
  });
  it('is idempotent: a diet lane needs nothing', () => {
    expect(laneDietConfigOps({ fetchValues: [LANE_DEFAULT_FETCH, LANE_OPS_NEGATIVE_FETCH], kv: { 'fetch.unpackLimit': '1', 'transfer.unpackLimit': '1' } })).toEqual([]);
  });
  it('never leaves a negative refspec alone: restores the default positive one when none exists', () => {
    const ops = laneDietConfigOps({ fetchValues: [], kv: {} });
    expect(ops[0]).toEqual(['config', '--local', '--add', 'remote.origin.fetch', LANE_DEFAULT_FETCH]);
  });
  it('keeps a custom positive refspec and does not add the default beside it', () => {
    const ops = laneDietConfigOps({ fetchValues: ['+refs/heads/main:refs/remotes/origin/main'], kv: {} });
    expect(ops.some((o) => o.includes(LANE_DEFAULT_FETCH))).toBe(false);
  });
  it('applyLaneDietConfig reads unset keys as unset (git exit 1) and applies only the missing ops', () => {
    const calls = [];
    const run = (args) => {
      calls.push(args);
      if (args[3] === 'remote.origin.fetch') return `${LANE_DEFAULT_FETCH}\n`;
      if (args[2] === '--get-all') { const e = new Error('exit 1'); e.status = 1; throw e; }
      return '';
    };
    expect(applyLaneDietConfig(run)).toHaveLength(3);
  });
  it('applyLaneDietConfig propagates a non-"unset" read failure instead of re-adding refspecs', () => {
    const writes = [];
    const run = (args) => {
      if (args.includes('--get-all')) { const e = new Error('timed out'); e.status = null; throw e; }
      writes.push(args);
      return '';
    };
    expect(() => applyLaneDietConfig(run)).toThrow(/timed out/);
    expect(writes).toEqual([]);
  });
});

describe('ops-ref reader inventory', () => {
  const EXPLICIT = /trackingRefspec\(|\+refs\/heads\/\$\{[^}]+\}:refs\/remotes\/|readFromTransportBranch|red-main-freeze-shared\.mjs/;
  it('every listed reader fetches its ops ref explicitly by name (or delegates to one that does)', () => {
    for (const r of OPS_REF_READERS) {
      const src = readFileSync(join(REPO, r.file), 'utf8');
      expect({ file: r.file, explicit: EXPLICIT.test(src) }).toEqual({ file: r.file, explicit: true });
    }
  });
  // Files that name an ops/* branch in code but never READ its tracking ref in a checkout.
  const NON_READERS = {
    'scripts/collect-review-requests.mjs': 'request DIRECTORY name inside the branch tree (CI job)',
    'scripts/operations/record-verdict.mjs': 'request file path inside the branch tree',
    'scripts/lib/red-main-quarantine.mjs': 'branch-name constant only (pure rules)',
    'scripts/lib/merge-delivery-policy.mjs': 'default branch-name policy value',
    'scripts/lib/daemon-rebuild/wrong-branch-heal.mjs': 'daemon clone CURRENT-branch name check, not a tracking ref',
    'scripts/lib/operation-io-fidelity.mjs': 'message text',
    'scripts/merge-ai-prs.mjs': 'message text',
    'scripts/operations/stage-pr-view.mjs': 'compares provenance against TRANSPORT_REF; the read is the injected stage-pr-view-io reader',
    'scripts/lib/lane-git-diet.mjs': 'this inventory',
    'scripts/lane-pool.mjs': 'drops stale tracking refs after clone',
  };
  const OPS_IN_CODE = /['"`](?:refs\/remotes\/origin\/)?ops\/|origin\/ops\/|\b(?:TRANSPORT_BRANCH|LEDGER_TRANSPORT_BRANCH|PRECEDENT_TRANSPORT_BRANCH|QUARANTINE_BRANCH|HANDOFF_BRANCH|redMainFreezeBranch|TRANSPORT_REF)\b/;
  const walk = (dir) => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === 'node_modules' || n === '__tests__') return [];
    return statSync(p).isDirectory() ? walk(p) : (n.endsWith('.mjs') && !n.includes('.test.') ? [p] : []);
  });
  it('is complete: every script naming an ops/* ref in code is a listed reader or a known non-reader', () => {
    const listed = new Set([...OPS_REF_READERS.map((r) => r.file), ...Object.keys(NON_READERS)]);
    const unlisted = [];
    const files = scopedScanFiles(walk(join(REPO, 'scripts')).map((abs) => relative(REPO, abs)));
    for (const rel of files) {
      const code = readFileSync(join(REPO, rel), 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
      if (OPS_IN_CODE.test(code) && !listed.has(rel)) unlisted.push(rel);
    }
    expect(unlisted).toEqual([]);
  });
});

describe('real git: negative refspec keeps ops/* out of a default fetch', () => {
  let root;
  let up;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'lane-git-diet-'));
    up = join(root, 'up');
    mkdirSync(up);
    git(up, 'init', '-q', '-b', 'main');
    writeFileSync(join(up, 'a.txt'), 'a');
    git(up, 'add', 'a.txt');
    git(up, 'commit', '-qm', 'a');
    git(up, 'update-ref', 'refs/heads/ops/review-requests', 'HEAD');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('a diet lane ignores ops/* on a default fetch, yet an explicit reader fetch still updates origin/ops/x', () => {
    const scratch = join(root, 'diet');
    git(root, 'clone', '-q', up, scratch);
    applyLaneDietConfig((args) => git(scratch, ...args));
    git(scratch, 'update-ref', '-d', 'refs/remotes/origin/ops/review-requests');
    git(scratch, 'fetch', '-q', '--prune', 'origin');
    expect(refs(scratch).some((r) => r.includes('/ops/'))).toBe(false);
    git(scratch, 'fetch', '-q', 'origin', '+refs/heads/ops/review-requests:refs/remotes/origin/ops/review-requests');
    expect(git(scratch, 'rev-parse', 'origin/ops/review-requests')).toBe(git(up, 'rev-parse', 'ops/review-requests'));
    git(scratch, 'fetch', '-q', '--prune', 'origin'); // a later default --prune does not drop the reader's ref
    expect(refs(scratch)).toContain('refs/remotes/origin/ops/review-requests');
  });
});
