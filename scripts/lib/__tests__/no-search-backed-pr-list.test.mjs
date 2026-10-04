/**
 * @file no-search-backed-pr-list.test.mjs — the #no-label-search regression guard (2026-09-27 live incident):
 *   `gh pr list --label ready-to-merge` failed the drain every pass with "API rate limit already exceeded"
 *   from GitHub's issue-SEARCH index (a separate, much smaller budget than the ordinary GraphQL list the same
 *   call already is), while the real GraphQL budget had 2000+ points to spare. Three call sites did this
 *   (`scripts/merge-ai-prs.mjs`'s drain listing, `scripts/review-runner.mjs`'s `discoverPending`,
 *   `scripts/lane-resume.mjs`'s `discover`) — all converted in the same change this test ships with, to list
 *   the open PRs plainly and filter by label CLIENT-SIDE. This test scans the real, tracked repo source
 *   (`git ls-files`, not a fixture) so a future regression of the same shape fails a real gate run, not just a
 *   fixture's synthetic case.
 *
 *   PROOF THIS TEST IS NOT VACUOUS: reverting any one of the three fixed call sites to its pre-fix `--label`
 *   argv reproduces a failure here (verified by hand while authoring this change — see the PR description for
 *   the before/after run). The allowlist below is deliberately narrow and named per file, so it cannot
 *   silently swallow a new, unrelated offender.
 */
/** @repo-scanning-test scope=files — see scripts/lib/repo-scan-tests.mjs (verify scopes it via VERIFY_SCAN_FILES, #3887). */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { scanScope } from '../repo-scan-tests.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSearchBackedGhListCalls, filterOpenPrsByLabel, OPEN_PR_LIST_LIMIT } from '../no-search-backed-pr-list.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Sanctioned exceptions — a genuinely different pattern from the incident (see the module header for why):
 * `--search '<title> in:title' --state merged`, a duplicate-title check against UNBOUNDED merged-PR history,
 * where "list everything, then filter client-side" is not a safe substitute. Keyed by repo-relative path;
 * each entry names the flag it allows so an unrelated new flag on the SAME file still fails loudly.
 */
const ALLOWLIST = {
  'scripts/operations/dispatch-lane-io.mjs': ['--search'],
  'scripts/readiness/conveyor-instrument.mjs': ['--search'],
  // `resolvePrBouncedViaGh`: `--search 'head:lane/<item>-' --state all`, a branch-PREFIX lookup against the same
  // unbounded PR history (`--head` is exact-match only), called only by the one-off backfill, never a polling loop.
  'scripts/conveyor/run-rating.mjs': ['--search'],
  // `cliReadPrepareStatus`: `--search 'head:lane/<item>-prepare-' --state all`, the same branch-PREFIX lookup
  // (`--head` is exact-match only; the prepare slug is unknown), run only when main's card carries no stamp yet AND the
  // item has prepare-attempt evidence (a claim, in-flight row, current settled row or hold) — at most one search per
  // tracked item per tick, never one per offered candidate.
  'skills-src/conveyor/build-dispatch-daemon.mjs': ['--search'],
};

function trackedSourceFiles() {
  const keep = (f) => /\.(mjs|js)$/.test(f) && !/\/__tests__\/|\/__fixtures__\//.test(f);
  // Scoped (verify, #3887): the changed files themselves — `git ls-files` cannot see a brand-new untracked file.
  const scope = scanScope();
  if (scope) return [...scope].filter((f) => /^(scripts|skills-src)\//.test(f) && keep(f) && existsSync(join(ROOT, f)));
  const out = execFileSync('git', ['ls-files', 'scripts', 'skills-src'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter(keep);
}

describe('no-search-backed-pr-list (#no-label-search)', () => {
  it('flags a synthetic --label on a pr list argv (the exact pre-fix shape)', () => {
    const src = `
      const listArgs = ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100'];
      if (label) listArgs.push('--label', label);
    `;
    const findings = findSearchBackedGhListCalls(src);
    expect(findings.map((f) => f.flag)).toEqual(['--label']);
  });

  it('does not flag an ordinary --label on gh pr edit/create (a real write, not a list)', () => {
    const src = `execFileSync('gh', ['pr', 'edit', String(n), '--add-label', label]);`;
    expect(findSearchBackedGhListCalls(src)).toEqual([]);
  });

  it('does not flag a plain, unfiltered gh pr list', () => {
    const src = `const prs = shJSON('gh', ['pr', 'list', ...repoFlag, '--state', 'open', '--json', 'number,labels'], []);`;
    expect(findSearchBackedGhListCalls(src)).toEqual([]);
  });

  it('flags the `--label=value` assignment form and a backticked flag (review finding: FLAG_RE bypass)', () => {
    const eq = `execFileSync('gh', ['pr', 'list', '--state', 'open', '--label=ready-to-merge']);`;
    expect(findSearchBackedGhListCalls(eq).map((f) => f.flag)).toEqual(['--label']);
    const tick = `execFileSync('gh', ['pr', 'list', \`--search\`, q]);`;
    expect(findSearchBackedGhListCalls(tick).map((f) => f.flag)).toEqual(['--search']);
    // a longer, unrelated flag that merely STARTS with a guarded name is not a hit
    expect(findSearchBackedGhListCalls(`['pr', 'list', '--labels-json']`)).toEqual([]);
  });

  it('flags gh short aliases -l / -S / -A, but not -L (the --limit alias)', () => {
    const src = `['pr', 'list', '-l', 'x', '-S', q, '-A', me, '-L', '500']`;
    expect(findSearchBackedGhListCalls(src).map((f) => f.flag)).toEqual(['-l', '-S', '-A']);
  });

  it('every tracked scripts/ + skills-src/ source file is free of an unallowlisted --label/--search/--author on a pr|issue list call', () => {
    const offenders = [];
    for (const file of trackedSourceFiles()) {
      let content;
      try { content = readFileSync(join(ROOT, file), 'utf8'); } catch { continue; }
      const findings = findSearchBackedGhListCalls(content);
      const allowed = ALLOWLIST[file] || [];
      for (const f of findings) {
        if (!allowed.includes(`--${f.flag.replace(/^--/, '')}`) && !allowed.includes(f.flag)) {
          offenders.push(`${file}:${f.line} — ${f.flag} on a pr/issue list call (search-backed; rate-limits separately from the GraphQL budget — #no-label-search)`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// Review finding (PR #2798, correctness): client-side filtering reused the OLD `--limit` (100/200), which once
// capped the small server-side-FILTERED set but now caps the RAW open-PR list BEFORE the label check — so a
// labeled PR past the cap was silently dropped. The shared helper + limit below close that.
describe('filterOpenPrsByLabel (#no-label-search truncation)', () => {
  const rows = (n, labeledAt, label = 'ready-to-merge') => Array.from({ length: n }, (_, i) => ({
    number: 1000 - i, labels: i === labeledAt ? [{ name: label }] : [{ name: 'other' }],
  }));

  it('finds a labeled PR positioned past the OLD 100/200 caps (the 250th open PR)', () => {
    const { prs, truncated } = filterOpenPrsByLabel(rows(300, 249), 'ready-to-merge');
    expect(prs.map((p) => p.number)).toEqual([751]);
    expect(truncated).toBe(false);
    expect(OPEN_PR_LIST_LIMIT).toBeGreaterThan(200);
  });

  it('reports a FULL page as possibly-truncated — never a silent drop', () => {
    const { prs, truncated } = filterOpenPrsByLabel(rows(OPEN_PR_LIST_LIMIT, -1), 'ready-to-merge');
    expect(prs).toEqual([]);
    expect(truncated).toBe(true);
  });

  it('accepts string-shaped labels and a missing labels field; no label = no filter', () => {
    const r = [{ number: 1, labels: ['review:pending'] }, { number: 2 }];
    expect(filterOpenPrsByLabel(r, 'review:pending').prs.map((p) => p.number)).toEqual([1]);
    expect(filterOpenPrsByLabel(r, null).prs).toHaveLength(2);
    expect(filterOpenPrsByLabel('not-an-array', 'x')).toEqual({ prs: [], truncated: false });
  });

  // Wiring: each converted call site lists with the shared limit and routes through the helper (so it gets the
  // truncation signal) — a bare numeric `--limit` literal on those open-PR listings is exactly the regressed shape.
  for (const file of ['scripts/merge-ai-prs.mjs', 'scripts/review-runner.mjs', 'scripts/lane-resume.mjs']) {
    it(`${file} filters its open-PR listing through filterOpenPrsByLabel with no numeric --limit literal`, () => {
      const src = readFileSync(join(ROOT, file), 'utf8');
      expect(src).toMatch(/filterOpenPrsByLabel\(/);
      const openLists = src.match(/\[\s*'pr',\s*'list'[^\]]*'--state',\s*'open'[^\]]*\]/g) || [];
      expect(openLists.length).toBeGreaterThan(0);
      for (const argv of openLists) expect(argv).not.toMatch(/'--limit',\s*'\d+'/);
    });
  }
});
