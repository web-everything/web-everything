// approval-binding (operator 2026-10-21): an operator clear-human clearance is bound to the PR's net-change
// fingerprint, not the commit sha. Real-git replays of the day's cases plus the never-weaken refusals.
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeClearanceCoverage, gitNetDiffAt } from '../approval-binding.mjs';
import {
  buildReviewedShaMarker, buildReviewedDiffMarker, buildReviewedContributionMarker, buildClearedHumanMarker,
  decideReviewGate, REVIEW_LABELS,
} from '../review-escalation.mjs';
import { planHumanSurfaceRepark } from '../../conveyor/human-surface-repark.mjs';

const settings = { bindTo: { value: 'fingerprint', source: 'test' }, normalizeNumbering: { value: true, source: 'test' } };
const quiet = () => {};
const trusted = (body) => ({ body, viewerDidAuthor: true });
const clearHuman = (sha, diffText, actor = 'chalbert') => trusted([
  '✅ review — `review:human` cleared via the sanctioned path', '', `Cleared by ${actor} via \`review-set-label.mjs --to=clear-human\``, '',
  buildReviewedShaMarker(sha), buildReviewedDiffMarker(diffText), buildReviewedContributionMarker(diffText), buildClearedHumanMarker(actor),
].join('\n'));
const plainAccept = (sha, diffText) => trusted(['✅ review — accepted', '', buildReviewedShaMarker(sha),
  buildReviewedDiffMarker(diffText), buildReviewedContributionMarker(diffText)].join('\n'));

const repos = [];
afterEach(() => { for (const cwd of repos.splice(0)) rmSync(cwd, { recursive: true, force: true }); });
const APP = (line3 = 'const c = 3;', line5 = 'const e = 5;') => ['const a = 1;', 'const b = 2;', line3, 'const d = 4;', line5,
  'const f = 6;', 'const g = 7;', 'const h = 8;', 'const i = 9;', 'const j = 10;', ''].join('\n');

function repo() {
  const cwd = mkdtempSync(join(tmpdir(), 'approval-binding-'));
  repos.push(cwd);
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path, text) => writeFileSync(join(cwd, path), text);
  const commit = (message) => { git(['add', '-A']); git(['commit', '-q', '-m', message]); return git(['rev-parse', 'HEAD']); };
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Approval Binding Test']);
  mkdirSync(join(cwd, 'backlog'));
  mkdirSync(join(cwd, 'scripts'));
  write('backlog/0001-parent.md', 'parent card\n');
  write('scripts/app.mjs', APP());
  const base = commit('base');
  git(['update-ref', 'refs/remotes/origin/main', base]);
  // The PR: a new provisional card, a reference to it, and one code line.
  git(['checkout', '-q', '-b', 'pr']);
  write('backlog/xabc123-foo.md', '---\nkind: story\n---\nfollow-up of the app change\n');
  write('backlog/0001-parent.md', 'parent card\nsee #xabc123\n');
  write('scripts/app.mjs', APP(undefined, 'const e = 50;'));
  const cleared = commit('the change the operator cleared');
  // The drain's own card numbering, exactly as `applyLedger` writes it.
  const number = () => {
    const content = readFileSync(join(cwd, 'backlog/xabc123-foo.md'), 'utf8');
    git(['mv', 'backlog/xabc123-foo.md', 'backlog/7001-foo.md']);
    write('backlog/7001-foo.md', content.replace(/^---\n/, '---\nbornAs: xabc123\n'));
    write('backlog/0001-parent.md', 'parent card\nsee #7001\n');
    return commit('drain: JIT-number xabc123→#7001 at land (#2288)');
  };
  const netDiff = (sha) => gitNetDiffAt({ exec: (c, a, o) => execFileSync(c, a, { cwd, ...o }), sha });
  // Formal reviews read and empty unless a case says otherwise (every content-bound cover requires the read).
  const coverage = (comments, liveHead, extra = {}) => computeClearanceCoverage({ comments, liveHead, exec: execFileSync, cwd, settings, log: quiet, reviews: [], ...extra });
  return { cwd, git, write, commit, base, cleared, number, netDiff, coverage };
}

describe('clearanceCovers — replays of the 2026-10-21 cases (real git)', () => {
  it('#5485: a fresh plain review on the SAME head never hides the clearance', () => {
    const r = repo();
    const diff = r.netDiff(r.cleared).text;
    const comments = [clearHuman(r.cleared, diff), plainAccept(r.cleared, diff)];
    const cov = r.coverage(comments, r.cleared);
    expect(cov).toMatchObject({ covers: true, tier: 'sha', liveHead: r.cleared });
    // The gate that re-parked review:human on #5485 now sees the clearance bound to the live head.
    const before = decideReviewGate({ labels: [REVIEW_LABELS.accepted], acceptedSha: r.cleared, headSha: r.cleared, permissionChange: true, humanClearedSha: null });
    expect(before).toMatchObject({ action: 'park', applyLabel: REVIEW_LABELS.human });
    const after = decideReviewGate({ labels: [REVIEW_LABELS.accepted], acceptedSha: r.cleared, headSha: r.cleared, permissionChange: true, humanClearedSha: null, clearanceCoverage: cov });
    expect(after.action).toBe('merge');
    // …and the human-surface sweep no longer re-parks it.
    const files = ['.github/workflows/merge-gate.yml'];
    const planned = (c) => planHumanSurfaceRepark({ currentLabels: [REVIEW_LABELS.accepted], files, headSha: r.cleared, comments, clearanceCoverage: c });
    expect(planned(null).repark).toBe(true);
    expect(planned(() => cov)).toMatchObject({ repark: false });
  });
});
