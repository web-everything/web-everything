/**
 * @file scripts/lib/__tests__/lane-litter.test.mjs
 * @description Pure-core tests for `we:scripts/lib/lane-litter.mjs` — the shared known-safe-scratch-litter
 *   allowlist + cleanup core for `we:backlog/3568-*.md`, reused by both `we:scripts/lane-pool.mjs#cmdRelease`
 *   and `we:scripts/conveyor/lane-pool-health-watch.mjs`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  LANE_RELEASE_LITTER_ALLOWLIST, isAllowlistedLitterPath, planLitterCleanup, cleanLaneLitter,
} from '../lane-litter.mjs';

describe('isAllowlistedLitterPath', () => {
  it('matches every literal name in the default allowlist', () => {
    expect(isAllowlistedLitterPath('.commit-msg.txt')).toBe(true);
    expect(isAllowlistedLitterPath('.pr-body.md')).toBe(true);
    expect(isAllowlistedLitterPath('.pr-body.txt')).toBe(true);
  });

  it('matches a wildcard pattern within one path segment', () => {
    expect(isAllowlistedLitterPath('review-3568-output.json')).toBe(true);
    expect(isAllowlistedLitterPath('commit-msg-fix-1.txt')).toBe(true);
  });

  // #3383 — live-observed 2026-09-23 on the plateau-app pool: these are the newly-added patterns, one live
  // example per pattern plus the exact filenames actually found in a real lane (`.pr-body-2759.md`,
  // `.pr-body-wip-postdeploy-smoke.md`, `.open-pr-out.json`, one `.converge-*` file per extension observed —
  // `.json`, `.stderr`, `.diff` — proving the single `.converge-*` prefix pattern covers all of them without
  // one entry per extension/round).
  it('matches the #3383 open-pr / pr-body-suffixed / pr-land-result / converge-* patterns', () => {
    expect(isAllowlistedLitterPath('.pr-body-2759.md')).toBe(true);
    expect(isAllowlistedLitterPath('.pr-body-wip-postdeploy-smoke.md')).toBe(true);
    expect(isAllowlistedLitterPath('.open-pr.json')).toBe(true);
    expect(isAllowlistedLitterPath('.open-pr-out.json')).toBe(true);
    expect(isAllowlistedLitterPath('.pr-land-result.json')).toBe(true);
    expect(isAllowlistedLitterPath('.converge-state.json')).toBe(true);
    expect(isAllowlistedLitterPath('.converge-panel-r1-result.stderr')).toBe(true);
    expect(isAllowlistedLitterPath('.converge-material-r1-current.diff')).toBe(true);
  });

  it('does not match an unrelated file', () => {
    expect(isAllowlistedLitterPath('scratch-notes-mine.txt')).toBe(false);
    expect(isAllowlistedLitterPath('file.txt')).toBe(false);
  });

  // #3568 — the doc comment on LANE_RELEASE_LITTER_ALLOWLIST promises "`*` matches any run of characters
  // within one path segment (no directory traversal)" — a naive `*` → `.*` translation breaks that promise,
  // since JS `.` in a regex matches `/` too. A candidate like `review-foo/bar-output.json` would then wrongly
  // match `review-*-output.json`, and `cleanLaneLitter` would `git clean -f --` an untracked file that was
  // never one of the five intended top-level scratch names — an unrecoverable deletion (#2267's data-loss
  // guard exists precisely to prevent this class of thing).
  it('a slash-containing candidate never matches a wildcard pattern, even when the segments would (no directory traversal)', () => {
    expect(isAllowlistedLitterPath('review-foo/bar-output.json')).toBe(false);
    expect(isAllowlistedLitterPath('some/dir/commit-msg-fix-1.txt')).toBe(false);
    expect(isAllowlistedLitterPath('review-x-output.json/nested')).toBe(false);
  });

  it('tolerant of a missing/empty path', () => {
    expect(isAllowlistedLitterPath('')).toBe(false);
    expect(isAllowlistedLitterPath(undefined)).toBe(false);
  });

  it('a literal `?` in an allowlist pattern matches only that exact character, not a regex wildcard', () => {
    expect(isAllowlistedLitterPath('a.txt', ['a?.txt'])).toBe(false);
    expect(isAllowlistedLitterPath('a?.txt', ['a?.txt'])).toBe(true);
  });
});

describe('planLitterCleanup', () => {
  it('classifies every untracked allowlisted path as toRemove, everything else as leaveDirty', () => {
    const porcelain = [
      '?? .commit-msg.txt',
      '?? review-3568-output.json',
      '?? scratch-notes-mine.txt',
      ' M file.txt',
    ].join('\n');
    const plan = planLitterCleanup(porcelain);
    expect(plan.toRemove.sort()).toEqual(['.commit-msg.txt', 'review-3568-output.json']);
    expect(plan.leaveDirty.sort()).toEqual(['file.txt', 'scratch-notes-mine.txt']);
  });

  it('a nested untracked allowlist-shaped path is never removed (the directory-traversal guard)', () => {
    const plan = planLitterCleanup('?? review-foo/bar-output.json\n');
    expect(plan.toRemove).toEqual([]);
    expect(plan.leaveDirty).toEqual(['review-foo/bar-output.json']);
  });

  it('empty/null porcelain plans nothing either way', () => {
    expect(planLitterCleanup('')).toEqual({ toRemove: [], leaveDirty: [] });
    expect(planLitterCleanup(null)).toEqual({ toRemove: [], leaveDirty: [] });
  });

  it('a custom allowlist is honored instead of the default export', () => {
    const plan = planLitterCleanup('?? my-scratch.tmp\n', ['my-scratch.tmp']);
    expect(plan.toRemove).toEqual(['my-scratch.tmp']);
  });

  // #3568 — a filename git C-quotes (a literal double-quote character, here) is parsed with its quoting still
  // attached, since this function reads plain (non `-z`) porcelain output (see the module docblock for why
  // that is currently inert). Pin that it falls through SAFELY to `leaveDirty` — never wrongly matched into
  // `toRemove` despite the quoting, and never throws.
  it('a git-C-quoted filename falls through safely to leaveDirty, never into toRemove', () => {
    // git's real C-quoting for a name containing a literal `"` renders as: "review-1-output.json\"weird" —
    // wrapped in quotes with the embedded quote backslash-escaped.
    const plan = planLitterCleanup('?? "review-1-output.json\\"weird"\n');
    expect(plan.toRemove).toEqual([]);
    expect(plan.leaveDirty).toEqual(['"review-1-output.json\\"weird"']);
  });
});

describe('LANE_RELEASE_LITTER_ALLOWLIST', () => {
  it('is the exact live-observed set (extend, never loosen the mechanism)', () => {
    expect(LANE_RELEASE_LITTER_ALLOWLIST).toEqual([
      '.commit-msg.txt', '.pr-body.md', '.pr-body.txt', 'review-*-output.json', 'commit-msg-fix-*.txt',
      '.commit-msg-fix-*.txt', '.review-*-output.json',
      '.pr-body-*.md', '.open-pr*.json', '.pr-land-result.json', '.converge-*',
      '.conveyor/', '.delivery-commit-msg-*.txt',
    ]);
  });

  // #x01u7az — live-observed 2026-09-24: `.conveyor/` (the session sidecar) was the ONLY dirty entry on
  // roughly two dozen of the pool's ~90 lanes at once, none leased — none of the file-shaped patterns above
  // can ever match a directory (their `[^/]*` never crosses the trailing `/`), so `acquire`'s auto-pick read
  // the whole pool as "held/dirty" and starved `--purpose=review-loop` dispatches (PR #2582, seven straight
  // `blocked-on-infra` sessions over more than an hour). Confirmed by reintroduction: this fails without the
  // new entry.
  it('.conveyor/ (the session sidecar directory) is allowlisted', () => {
    expect(isAllowlistedLitterPath('.conveyor/')).toBe(true);
    // A file WITHIN the directory is a different path (one more segment) and must NOT match the directory
    // entry itself — `git status --porcelain` never reports it separately while the whole tree is untracked,
    // but the pattern's own no-traversal guard must still hold if it ever is.
    expect(isAllowlistedLitterPath('.conveyor/queue.json')).toBe(false);
  });

  // Same incident, a naming-drift sibling of the already-allowlisted `.commit-msg-fix-*.txt` family.
  it('.delivery-commit-msg-*.txt (the delivery-agent-prefixed commit-msg scratch) is allowlisted', () => {
    expect(isAllowlistedLitterPath('.delivery-commit-msg-build.txt')).toBe(true);
    expect(isAllowlistedLitterPath('.delivery-commit-msg-gate-fix.txt')).toBe(true);
  });

  // Live-caught 2026-09-22: several lanes' ONLY dirty file was `.review-loop-output.json` (leading dot),
  // which `review-*-output.json` never matched — a plain glob has no implicit "optionally dotted" behavior.
  // Confirmed by reintroduction: this fails against the pre-fix 5-entry list.
  it('the dot-prefixed form of review-*-output.json and commit-msg-fix-*.txt now matches too', () => {
    expect(isAllowlistedLitterPath('.review-loop-output.json')).toBe(true);
    expect(isAllowlistedLitterPath('.review-3568-output.json')).toBe(true);
    expect(isAllowlistedLitterPath('.commit-msg-fix-1.txt')).toBe(true);
  });

  it('the un-dotted forms still match too — this is an addition, not a replacement', () => {
    expect(isAllowlistedLitterPath('review-loop-output.json')).toBe(true);
    expect(isAllowlistedLitterPath('commit-msg-fix-1.txt')).toBe(true);
  });

  it('the dot-prefixed pattern still respects the no-directory-traversal guard', () => {
    expect(isAllowlistedLitterPath('.review-foo/bar-output.json')).toBe(false);
  });
});

// ── cleanLaneLitter — the one IO caller (real git only past this point) ──────────────────────────────────
describe('cleanLaneLitter', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  // A red-team finding on #3568: `planLitterCleanup(null)` reports empty `toRemove`/`leaveDirty`, which reads
  // identically to a genuinely clean lane — so a FAILED internal status read must never fall through to that
  // same shape. Proved with a real directory that is not a git repo at all, so `git status --porcelain`
  // genuinely fails rather than being simulated.
  it('a failed internal status read (not a git repo) returns skipped:true, never a silent "nothing to do"', () => {
    dir = mkdtempSync(join(tmpdir(), 'lane-litter-not-a-repo-'));
    const result = cleanLaneLitter(dir);
    expect(result).toEqual({ removed: [], leaveDirty: [], skipped: true, complete: false });
  });

  it('a failed internal status read is skipped:true even WITH isLeasedNow provided — the read-failure check runs first', () => {
    dir = mkdtempSync(join(tmpdir(), 'lane-litter-not-a-repo-'));
    let called = false;
    const result = cleanLaneLitter(dir, { isLeasedNow: () => { called = true; return false; } });
    expect(result.skipped).toBe(true);
    expect(called).toBe(false); // never even reached — the null-porcelain check returns first
  });

  // #3568 — `git clean`'s pathspec parser treats an unescaped `*`/`?`/`[` as a GLOB, not a literal character.
  // A real untracked file whose literal name happens to contain one of those (while still matching this
  // module's own allowlist regex) must delete ONLY itself, never expand into deleting an unrelated untracked
  // sibling (proved directly in a `/tmp` repro before this fix: `git clean -f -- 'review-*-output.json'`
  // without `:(literal)` removed BOTH a file literally named that AND an unrelated `review-2-output.json`).
  it('a literal glob-metacharacter filename is removed WITHOUT collaterally deleting an unrelated sibling', () => {
    dir = mkdtempSync(join(tmpdir(), 'lane-litter-glob-safety-'));
    execFileSync('git', ['init', '--quiet'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    // A literal filename that MATCHES `review-*-output.json`'s regex (its `[^/]*` middle segment can capture
    // a literal "*" char) while ALSO being a valid glob pattern if git ever treated it as one.
    writeFileSync(join(dir, 'review-*-output.json'), 'a\n');
    writeFileSync(join(dir, 'unrelated-real-work.txt'), 'b\n'); // matches NO allowlist entry at all

    const result = cleanLaneLitter(dir);

    expect(result.removed).toEqual(['review-*-output.json']);
    expect(existsSync(join(dir, 'review-*-output.json'))).toBe(false);
    expect(existsSync(join(dir, 'unrelated-real-work.txt'))).toBe(true);
  });

  // #3568 — independently pins git's OWN documented pathspec contract (not a call into `cleanLaneLitter`,
  // which cannot be argv-spied here: `execFileSync` is a non-configurable property on the built-in
  // `node:child_process` module namespace, so `vi.spyOn` cannot intercept it). This proves the underlying
  // mechanism `:(literal)` relies on actually behaves as documented, using the real git binary: for THIS
  // allowlist's single-wildcard/prefix-suffix pattern shape, any filename git's glob could collaterally match
  // is — by construction — ALSO an independent match of this module's own (more permissive) regex, so no
  // sibling-survives test can regression-pin the exact code line; this test instead pins the git-level fact
  // the fix depends on, verified manually against a real collateral-deletion repro before this fix landed.
  it('git clean -f -n literally reports MORE candidates via glob than via :(literal) (the mechanism this fix relies on)', () => {
    dir = mkdtempSync(join(tmpdir(), 'lane-litter-glob-mechanism-'));
    execFileSync('git', ['init', '--quiet'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    writeFileSync(join(dir, 'review-*-output.json'), 'a\n');
    writeFileSync(join(dir, 'review-2-output.json'), 'b\n');

    const glob = execFileSync('git', ['clean', '-f', '-n', '--', 'review-*-output.json'], { cwd: dir, encoding: 'utf8' });
    const literal = execFileSync('git', ['clean', '-f', '-n', '--', ':(literal)review-*-output.json'], { cwd: dir, encoding: 'utf8' });

    expect(glob.split('\n').filter(Boolean)).toHaveLength(2); // both files — the glob expanded
    expect(literal.split('\n').filter(Boolean)).toHaveLength(1); // only the literally-named file
  });

  // #3568 — `tryGit` swallows failures and returns `null` on a non-zero exit; a file must be counted as
  // `removed` only when the `git clean` call actually succeeded, never merely attempted. Reproduced with a
  // real permission-denied deletion (a read-only directory), not a simulated exec failure. Skipped when
  // running as root: root ignores a directory's write-permission bits, so this repro (and the failure it
  // exists to prove) does not occur in that environment (a common CI/container default).
  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)('a git-clean call that actually FAILS (permission denied) is not counted as removed', () => {
    dir = mkdtempSync(join(tmpdir(), 'lane-litter-clean-fails-'));
    execFileSync('git', ['init', '--quiet'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    writeFileSync(join(dir, '.commit-msg.txt'), 'litter\n');
    execFileSync('chmod', ['555', dir]); // read+execute only — deletion inside it now fails
    try {
      const result = cleanLaneLitter(dir);
      expect(result.removed).toEqual([]);
      expect(existsSync(join(dir, '.commit-msg.txt'))).toBe(true); // still there — the clean genuinely failed
    } finally {
      execFileSync('chmod', ['755', dir]); // restore so afterEach's rmSync can clean up
    }
  });
});

describe('cleanLaneLitter — isLeasedNow (the last gate, right before the mutation, #3568)', () => {
  let dir;
  function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lane-litter-isleasednow-'));
    git(['init', '--quiet'], dir);
    git(['config', 'user.email', 't@t.com'], dir);
    git(['config', 'user.name', 't'], dir);
    writeFileSync(join(dir, 'file.txt'), 'v1\n');
    git(['add', 'file.txt'], dir);
    git(['commit', '--quiet', '-m', 'v1'], dir);
    writeFileSync(join(dir, '.commit-msg.txt'), 'litter\n');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a true isLeasedNow cancels the removal — nothing is deleted, skipped:true, complete:false', () => {
    const result = cleanLaneLitter(dir, { isLeasedNow: () => true });
    expect(result).toEqual({ removed: [], leaveDirty: [], skipped: true, complete: false });
    expect(existsSync(join(dir, '.commit-msg.txt'))).toBe(true);
  });

  it('a false isLeasedNow proceeds normally — skipped:false, complete:true', () => {
    const result = cleanLaneLitter(dir, { isLeasedNow: () => false });
    expect(result).toEqual({ removed: ['.commit-msg.txt'], leaveDirty: [], skipped: false, complete: true });
    expect(existsSync(join(dir, '.commit-msg.txt'))).toBe(false);
  });

  // #3568 — a mid-loop lease acquisition (checked on the SECOND of two litter files) must stop further
  // removal, not just the first-file case a single up-front check would have covered. A trip mid-loop is a
  // DECLINE, not a partial success — `skipped:true`/`complete:false` even though one file already got through.
  it('re-checks isLeasedNow on EVERY file, not once up front — a mid-loop lease stops further removal', () => {
    writeFileSync(join(dir, '.pr-body.md'), 'litter 2\n'); // a second, independent litter file
    let calls = 0;
    const isLeasedNow = () => { calls += 1; return calls >= 2; }; // unleased for file 1, leased by file 2
    const result = cleanLaneLitter(dir, { isLeasedNow });
    expect(result.removed).toHaveLength(1); // exactly one of the two got through before the lease tripped
    expect(result.skipped).toBe(true);
    expect(result.complete).toBe(false);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('isLeasedNow is never called when there is nothing to remove (already clean of litter)', () => {
    rmSync(join(dir, '.commit-msg.txt'));
    let called = false;
    cleanLaneLitter(dir, { isLeasedNow: () => { called = true; return true; } });
    expect(called).toBe(false);
  });

  it('omitting isLeasedNow entirely (cmdRelease call shape) behaves exactly as before — no gate at all', () => {
    const result = cleanLaneLitter(dir);
    expect(result).toEqual({ removed: ['.commit-msg.txt'], leaveDirty: [], skipped: false, complete: true });
  });
});
