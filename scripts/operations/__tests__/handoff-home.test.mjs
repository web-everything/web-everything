/**
 * @file handoff-home.test.mjs — the handoff's tracked home (#3779, location slice), against REAL git.
 *
 * Every repository here is a temp directory: a bare `origin.git`, a `board` clone standing in for this repo's
 * checkout, and one or two handoff working copies. Nothing touches the real remote or the real handoff
 * directory. Visibility is injected (a local bare remote has no GitHub slug to ask `gh` about).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  HANDOFF_BRANCH, HANDOFF_FILES, githubSlug, handoffHome, publishRefusals, pullHandoff, pushHandoff,
} from '../handoff-home.mjs';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const SCRIPT = resolve(__dirname, '..', 'handoff-home.mjs');
const [SNAPSHOT, RULES] = HANDOFF_FILES;

let root;
let origin;
let board;
const PRIVATE = () => 'PRIVATE';

/** A handoff directory holding both files, as the operator's does today. */
function handoffDir(name, snapshot = 'HANDOFF v1\n', rules = 'RULES\n1. first rule\n') {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SNAPSHOT), snapshot);
  writeFileSync(join(dir, RULES), rules);
  return dir;
}
const remoteTip = () => {
  try { return git(['rev-parse', `refs/heads/${HANDOFF_BRANCH}`], origin).trim(); } catch { return null; }
};
const remoteFile = (name) => git(['show', `refs/heads/${HANDOFF_BRANCH}:${name}`], origin);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'handoff-home-'));
  origin = join(root, 'origin.git');
  git(['init', '--quiet', '--bare', origin], root);
  git(['clone', '--quiet', origin, 'board'], root);
  board = join(root, 'board');
  // A per-repo identity: a CI runner has none, and the transport's worktree commit inherits this checkout's config.
  git(['config', 'user.name', 'test'], board);
  git(['config', 'user.email', 'test@example.com'], board);
  writeFileSync(join(board, 'README.md'), 'board\n');
  git(['add', 'README.md'], board);
  git(['commit', '--quiet', '-m', 'board'], board);
  git(['push', '--quiet', 'origin', 'HEAD:refs/heads/trunk'], board);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('path', () => {
  it('is the one fixed home, outside ~/.claude', () => {
    expect(handoffHome({ home: '/h' })).toBe('/h/workspace/.operations/handoff');
    expect(handoffHome({ home: '/h' })).not.toContain('.claude');
  });

  it('is what the CLI prints for `path`', () => {
    const out = execFileSync(process.execPath, [SCRIPT, 'path'], { encoding: 'utf8', env: { ...process.env, HOME: root } });
    expect(out.trim()).toBe(join(root, 'workspace', '.operations', 'handoff'));
  });
});

describe('push', () => {
  it('creates ops/handoff on the first push, as an orphan holding exactly the two files', () => {
    const dir = handoffDir('home');
    const out = pushHandoff({ dir, board, visibility: PRIVATE, message: 'first' });
    expect(out).toMatchObject({ status: 'pushed', created: true });
    expect(out.commit).toBe(remoteTip());
    expect(git(['ls-tree', '--name-only', remoteTip()], origin).trim().split('\n').sort()).toEqual([...HANDOFF_FILES].sort());
    expect(git(['rev-list', '--count', remoteTip()], origin).trim()).toBe('1');
    expect(remoteFile(SNAPSHOT)).toBe('HANDOFF v1\n');
    // The working copy is now a clean checkout of the pushed tip, and the files were not reworded.
    expect(git(['rev-parse', 'HEAD'], dir).trim()).toBe(remoteTip());
    expect(git(['status', '--porcelain'], dir)).toBe('');
    expect(readFileSync(join(dir, RULES), 'utf8')).toBe('RULES\n1. first rule\n');
  });

  it('lands a fast-forward commit on ops/handoff when a file changes', () => {
    const dir = handoffDir('home');
    const first = pushHandoff({ dir, board, visibility: PRIVATE }).commit;
    writeFileSync(join(dir, RULES), 'RULES\n1. first rule\n2. second rule\n');
    const out = pushHandoff({ dir, board, visibility: PRIVATE, message: 'append rule 2' });
    expect(out.status).toBe('pushed');
    expect(git(['rev-parse', `${remoteTip()}^`], origin).trim()).toBe(first);
    expect(git(['log', '-1', '--format=%s', remoteTip()], origin).trim()).toBe('append rule 2');
    expect(remoteFile(RULES)).toContain('2. second rule');
    expect(git(['status', '--porcelain'], dir)).toBe('');
  });

  it('is `unchanged`, not an error, when nothing changed', () => {
    const dir = handoffDir('home');
    const first = pushHandoff({ dir, board, visibility: PRIVATE }).commit;
    expect(pushHandoff({ dir, board, visibility: PRIVATE })).toMatchObject({ status: 'unchanged', commit: first });
  });

  it('refuses on a diverged remote and leaves both the remote and the working copy untouched', () => {
    const a = handoffDir('a');
    pushHandoff({ dir: a, board, visibility: PRIVATE });
    const b = join(root, 'b');
    mkdirSync(b);
    pullHandoff({ dir: b, board });
    const bHead = git(['rev-parse', 'HEAD'], b).trim();

    writeFileSync(join(a, SNAPSHOT), 'HANDOFF v2 from a\n');
    pushHandoff({ dir: a, board, visibility: PRIVATE });
    const tipAfterA = remoteTip();

    writeFileSync(join(b, SNAPSHOT), 'HANDOFF v2 from b\n');
    const out = pushHandoff({ dir: b, board, visibility: PRIVATE });
    expect(out.status).toBe('refused');
    expect(out.reasons.join('\n')).toMatch(/diverged/);
    expect(remoteTip()).toBe(tipAfterA);
    expect(remoteFile(SNAPSHOT)).toBe('HANDOFF v2 from a\n');
    expect(git(['rev-parse', 'HEAD'], b).trim()).toBe(bHead);
    expect(readFileSync(join(b, SNAPSHOT), 'utf8')).toBe('HANDOFF v2 from b\n');
  });

  it('refuses a working copy that never pulled an existing branch', () => {
    pushHandoff({ dir: handoffDir('a'), board, visibility: PRIVATE });
    const tip = remoteTip();
    const out = pushHandoff({ dir: handoffDir('fresh', 'other\n'), board, visibility: PRIVATE });
    expect(out.status).toBe('refused');
    expect(out.reasons[0]).toMatch(/never pulled/);
    expect(remoteTip()).toBe(tip);
  });

  it('refuses when the scrub flags a file, before any git runs in the working copy', () => {
    const dir = handoffDir('home', `HANDOFF\ntoken: ghp_${'A1b2C3d4E5'.repeat(4)}\n`);
    const out = pushHandoff({ dir, board, visibility: PRIVATE });
    expect(out.status).toBe('refused');
    expect(out.reasons.some((r) => r.startsWith(`${SNAPSHOT}:`))).toBe(true);
    expect(remoteTip()).toBeNull();
    expect(existsSync(join(dir, '.git'))).toBe(false);
  });

  it('refuses a personal home path on a PUBLIC repo, and an unknown visibility', () => {
    const dir = handoffDir('home', 'see /Users/someone/workspace/notes.md\n');
    const pub = pushHandoff({ dir, board, visibility: () => 'PUBLIC' });
    expect(pub.status).toBe('refused');
    expect(pub.reasons.join('\n')).toMatch(/personal home-directory path/);
    expect(pushHandoff({ dir, board, visibility: () => null }).reasons.join('\n')).toMatch(/visibility is unknown/);
    expect(remoteTip()).toBeNull();
  });
}, 30_000);

describe('pull', () => {
  it('reports a missing branch and leaves the directory alone', () => {
    const dir = handoffDir('home');
    expect(pullHandoff({ dir, board })).toMatchObject({ status: 'no-remote-branch' });
    expect(existsSync(join(dir, '.git'))).toBe(false);
  });

  it('checks out the branch into an empty directory, then fast-forwards it', () => {
    const a = handoffDir('a');
    const first = pushHandoff({ dir: a, board, visibility: PRIVATE }).commit;
    const b = join(root, 'b');
    mkdirSync(b);
    expect(pullHandoff({ dir: b, board })).toMatchObject({ status: 'updated', to: first });
    expect(readFileSync(join(b, SNAPSHOT), 'utf8')).toBe('HANDOFF v1\n');
    expect(pullHandoff({ dir: b, board })).toMatchObject({ status: 'up-to-date' });

    writeFileSync(join(a, SNAPSHOT), 'HANDOFF v2\n');
    const second = pushHandoff({ dir: a, board, visibility: PRIVATE }).commit;
    expect(pullHandoff({ dir: b, board })).toMatchObject({ status: 'updated', from: first, to: second });
    expect(readFileSync(join(b, SNAPSHOT), 'utf8')).toBe('HANDOFF v2\n');
    expect(git(['status', '--porcelain'], b)).toBe('');
  });

  it('adopts the branch in a directory already holding identical files, and refuses differing ones', () => {
    pushHandoff({ dir: handoffDir('a'), board, visibility: PRIVATE });
    expect(pullHandoff({ dir: handoffDir('same'), board }).status).toBe('updated');
    const other = handoffDir('other', 'unpushed local text\n');
    expect(() => pullHandoff({ dir: other, board })).toThrow(/never pushed/);
    expect(readFileSync(join(other, SNAPSHOT), 'utf8')).toBe('unpushed local text\n');
  });
}, 30_000);

describe('the publish gate (pure)', () => {
  it('passes clean text on a private repo and names each file it refuses', () => {
    expect(publishRefusals({ visibility: 'PRIVATE', files: [{ name: 'x.md', content: 'see /Users/someone/a\n' }] })).toEqual([]);
    expect(publishRefusals({ visibility: 'PUBLIC', files: [{ name: 'x.md', content: 'plain words\n' }] })).toEqual([]);
    expect(publishRefusals({ visibility: 'PUBLIC', files: [{ name: 'x.md', content: '/home/someone/a' }] })[0]).toMatch(/^x\.md: personal/);
  });

  it('reads the GitHub slug from either remote form', () => {
    expect(githubSlug('https://github.com/web-everything/web-everything.git')).toBe('web-everything/web-everything');
    expect(githubSlug('git@github.com:web-everything/web-everything.git')).toBe('web-everything/web-everything');
    expect(githubSlug('/tmp/origin.git')).toBeNull();
  });
});
