/**
 * @file scripts/__tests__/pr-land-finish-guard.test.mjs
 * @description Real-git behavioral proof of `pr-land.mjs`'s #2833/#4296 finish-guard, extracted as
 *   `resolveFinishGuardVerdict` specifically so it can be driven directly with a real git repo instead of only
 *   through source-text regex assertions on the CLI (converge round 1, 2026-09-29 — the correctness, security
 *   and standards-conformance jurors each independently flagged that the landing path that matters most had no
 *   behavioral coverage of its own; `pr-land.test.mjs`'s existing #2833 wiring test pins the SHAPE, this pins
 *   the BEHAVIOR). Shares the exact merge fixture shape `scripts/__tests__/verify-lane.test.mjs`'s #4296
 *   describe block uses for the bare `check` CLI, applied here to the function `pr-land.mjs` actually calls —
 *   no `gh`, no push, no network: `resolveFinishGuardVerdict` never touches either.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFinishGuardVerdict } from '../pr-land.mjs';
import { readVerifyMarker } from '../lib/lane-verify.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pr-land-finish-guard-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const gitDirOf = (d) => join(d, '.git');
const runGit = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const headSha = () => runGit(['rev-parse', 'HEAD']);
const laneBranch = () => runGit(['symbolic-ref', '--short', 'HEAD']);
const commit = (msg) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg], { cwd: dir });
const writeAndAdd = (relPath, contents) => {
  mkdirSync(join(dir, relPath.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
  writeFileSync(join(dir, relPath), contents);
  execFileSync('git', ['add', relPath], { cwd: dir });
};
/** Write a marker directly (never through the real `verify-lane.mjs` writer — this suite only needs the SHAPE
 *  `resolveFinishGuardVerdict` reads, and driving the real gate here would be the exact "run everything" cost
 *  the diff-driven shrink already exists to avoid). */
function writeGreenMarker(sha) {
  const record = { sha, status: 'green', startedAt: '2026-09-29T00:00:00.000Z', finishedAt: '2026-09-29T00:01:00.000Z', suites: 'test', exitCode: 0 };
  writeFileSync(join(gitDirOf(dir), '.lane-verify'), JSON.stringify(record, null, 2) + '\n');
  return record;
}

describe('resolveFinishGuardVerdict (#4296) — a real merge of origin/main touching only an out-of-lane file keeps a green marker valid', () => {
  it('lands GREEN: the marker is for the pre-merge sha, the merge touched only a file the lane never edited', () => {
    writeAndAdd('scripts/verify-lane.mjs', 'base\n');
    writeAndAdd('scripts/operations/ci-heal-pr-dispatch.mjs', 'base\n');
    commit('base');
    const main = laneBranch();
    execFileSync('git', ['branch', 'origin/main'], { cwd: dir });

    writeAndAdd('scripts/verify-lane.mjs', 'lane edit\n');
    commit('lane edit');
    const laneSha = headSha();
    writeGreenMarker(laneSha);

    execFileSync('git', ['checkout', '-q', 'origin/main'], { cwd: dir });
    writeAndAdd('scripts/operations/ci-heal-pr-dispatch.mjs', 'upstream edit\n');
    commit('upstream edit');
    execFileSync('git', ['checkout', '-q', main], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '--no-edit', '-q', 'origin/main'], { cwd: dir });
    const mergeSha = headSha();
    expect(mergeSha).not.toBe(laneSha);

    const gate = resolveFinishGuardVerdict({
      gitDir: gitDirOf(dir), headSha: mergeSha, remote: 'origin', base: 'main', runGit, readMarker: readVerifyMarker,
    });

    expect(gate).toMatchObject({ ok: true, status: 'green', reason: 'verified' });
    expect(gate.detail).toMatch(/carried forward/);
  });

  it('REFUSES (unverified): a merge that DOES touch a file the lane relies on still forces a re-verify — not a blanket bypass', () => {
    writeAndAdd('scripts/verify-lane.mjs', 'base\n');
    commit('base');
    const main = laneBranch();
    execFileSync('git', ['branch', 'origin/main'], { cwd: dir });

    writeAndAdd('scripts/verify-lane.mjs', 'lane edit\n');
    commit('lane edit');
    const laneSha = headSha();
    writeGreenMarker(laneSha);

    execFileSync('git', ['checkout', '-q', 'origin/main'], { cwd: dir });
    writeAndAdd('scripts/verify-lane.mjs', 'base\nupstream addition\n');
    commit('upstream addition to the lane\'s own file');
    execFileSync('git', ['checkout', '-q', main], { cwd: dir });
    // May auto-merge cleanly or conflict, depending on git's hunk heuristics — either way the merge commit's
    // diff against the marker's sha touches scripts/verify-lane.mjs, which is exactly what this counter-case
    // needs; `resolveFinishGuardVerdict` never runs `git merge` itself, so how the conflict (if any) resolves is
    // incidental to what it is testing.
    try {
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '--no-edit', '-q', 'origin/main'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      writeFileSync(join(dir, 'scripts/verify-lane.mjs'), 'lane edit\nupstream addition\n');
      execFileSync('git', ['add', 'scripts/verify-lane.mjs'], { cwd: dir });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--no-edit', '-q'], { cwd: dir });
    }
    const mergeSha = headSha();
    expect(mergeSha).not.toBe(laneSha);

    const gate = resolveFinishGuardVerdict({
      gitDir: gitDirOf(dir), headSha: mergeSha, remote: 'origin', base: 'main', runGit, readMarker: readVerifyMarker,
    });

    expect(gate).toMatchObject({ ok: false, status: 'absent', reason: 'unverified' });
  });

  it('a RED marker recorded for a covered stale sha still REFUSES — the carry-forward preserves the STATUS, not just the shape', () => {
    writeAndAdd('scripts/verify-lane.mjs', 'base\n');
    writeAndAdd('scripts/operations/ci-heal-pr-dispatch.mjs', 'base\n');
    commit('base');
    const main = laneBranch();
    execFileSync('git', ['branch', 'origin/main'], { cwd: dir });

    writeAndAdd('scripts/verify-lane.mjs', 'lane edit\n');
    commit('lane edit');
    const laneSha = headSha();
    writeFileSync(join(gitDirOf(dir), '.lane-verify'), JSON.stringify({ sha: laneSha, status: 'red', startedAt: 't', finishedAt: 'u', suites: 'test', exitCode: 2 }, null, 2) + '\n');

    execFileSync('git', ['checkout', '-q', 'origin/main'], { cwd: dir });
    writeAndAdd('scripts/operations/ci-heal-pr-dispatch.mjs', 'upstream edit\n');
    commit('upstream edit');
    execFileSync('git', ['checkout', '-q', main], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '--no-edit', '-q', 'origin/main'], { cwd: dir });
    const mergeSha = headSha();

    const gate = resolveFinishGuardVerdict({
      gitDir: gitDirOf(dir), headSha: mergeSha, remote: 'origin', base: 'main', runGit, readMarker: readVerifyMarker,
    });

    expect(gate).toMatchObject({ ok: false, status: 'red', reason: 'verify-red' });
  });

  it('an unreachable recordSha (a torn/foreign marker) fails CLOSED, never open — the real `git diff` throws and the caller\'s runGit propagates it', () => {
    writeAndAdd('scripts/verify-lane.mjs', 'base\n');
    commit('base');
    execFileSync('git', ['branch', 'origin/main'], { cwd: dir });
    writeAndAdd('scripts/verify-lane.mjs', 'lane edit\n');
    commit('lane edit');
    // No checkout back to `main` needed here — this test never touches `origin/main` again.

    // A marker for a sha this repo has never seen (never gc'd — simply never existed here).
    writeGreenMarker('f'.repeat(40));
    const mergeSha = headSha();

    const gate = resolveFinishGuardVerdict({
      gitDir: gitDirOf(dir), headSha: mergeSha, remote: 'origin', base: 'main', runGit, readMarker: readVerifyMarker,
    });

    // real `git diff --name-only <bogus> <mergeSha>` throws (execFileSync throws on git's non-zero exit) —
    // laneRelevantChangeSince's try/catch turns that into `null`, which verifyGateDecision treats as UNKNOWN,
    // never as "no overlap" — the exact fail-closed contract laneRelevantChangeSince's own doc states.
    expect(gate).toMatchObject({ ok: false, status: 'absent', reason: 'unverified' });
  });
});

describe('resolveFinishGuardVerdict — a green marker carries over docs-only commits (delivery-blocker R826)', () => {
  const setup = () => {
    writeAndAdd('scripts/a.mjs', 'base\n');
    commit('base');
    execFileSync('git', ['branch', 'origin/main'], { cwd: dir });
    writeAndAdd('scripts/a.mjs', 'lane edit\n');
    commit('fix');
    const sha = headSha();
    writeGreenMarker(sha);
    return sha;
  };
  const verdict = () => resolveFinishGuardVerdict({ gitDir: gitDirOf(dir), headSha: headSha(), remote: 'origin', base: 'main', runGit, readMarker: readVerifyMarker });

  it('accepts a backlog card committed after the marker', () => {
    setup();
    writeAndAdd('backlog/9999-x.md', 'card\n');
    commit('card');
    expect(verdict()).toMatchObject({ ok: true, reason: 'verified' });
    expect(verdict().detail).toMatch(/verify-marker carried from/);
  });
  it('REFUSES a code commit after the marker', () => {
    setup();
    writeAndAdd('scripts/a.mjs', 'more code\n');
    commit('code');
    expect(verdict().ok).toBe(false);
  });
  it('REFUSES a script under docs/ (only .md counts)', () => {
    setup();
    writeAndAdd('docs/tool.mjs', 'x\n');
    commit('docs script');
    expect(verdict().ok).toBe(false);
  });
  it('REFUSES a root README.md (only backlog/ or docs/ .md counts)', () => {
    setup();
    writeAndAdd('README.md', 'x\n');
    commit('root md');
    expect(verdict().ok).toBe(false);
  });
  it('REFUSES code renamed to a docs .md name', () => {
    setup();
    writeAndAdd('docs/a.md', 'lane edit\n'); // identical content: git sees a rename
    execFileSync('git', ['rm', '-q', 'scripts/a.mjs'], { cwd: dir });
    commit('rename code to md');
    expect(verdict().ok).toBe(false);
  });
  it('REFUSES a marker on a non-ancestor commit', () => {
    setup();
    execFileSync('git', ['checkout', '-q', '--orphan', 'other'], { cwd: dir });
    writeAndAdd('backlog/1-y.md', 'c\n');
    commit('orphan card');
    expect(verdict().ok).toBe(false);
  });
});
