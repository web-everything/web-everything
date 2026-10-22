// approval-binding (operator 2026-10-21): an operator clear-human clearance is bound to the PR's net-change
// fingerprint, not the commit sha. Real-git replays of the day's cases plus the never-weaken refusals.
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearanceCovers, clearanceBindsHead, computeClearanceCoverage, latestOperatorClearanceRecord, gitNetDiffAt,
  resolveClearanceBindingSettings, logClearanceBindingSettings, _resetClearanceBindingLog,
} from '../approval-binding.mjs';
import {
  buildReviewedShaMarker, buildReviewedDiffMarker, buildReviewedContributionMarker, buildClearedHumanMarker,
  decideReviewGate, decideContradictoryVerdictHeal, shouldReparkForTestTampering, REVIEW_LABELS, normalizeDiffFingerprint,
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

  it('#5742: the drain numbering commit on top of the cleared head is covered (numbering tier)', () => {
    const r = repo();
    const comments = [clearHuman(r.cleared, r.netDiff(r.cleared).text)];
    const head = r.number();
    expect(r.coverage(comments, head)).toMatchObject({ covers: true, tier: 'numbering', base: r.cleared, liveHead: head });
    // Kill switch: sha binding restores today's behaviour.
    const sha = { ...settings, bindTo: { value: 'sha', source: 'env' } };
    expect(r.coverage(comments, head, { settings: sha }).covers).toBe(false);
    // normalizeNumbering off: the fingerprint moved, so the numbering head is not covered.
    const off = { ...settings, normalizeNumbering: { value: false, source: 'env' } };
    expect(r.coverage(comments, head, { settings: off }).covers).toBe(false);
  });

  it('#5530: numbering on top of a rebase whose base changed a context line — covered through contribution + replay', () => {
    const r = repo();
    const comments = [clearHuman(r.cleared, r.netDiff(r.cleared).text)];
    // main moves a context line next to the PR's hunk; the drain rebases the lane, then numbers its card.
    r.git(['checkout', '-q', 'main']);
    r.write('scripts/app.mjs', APP('const c = 33;'));
    const main2 = r.commit('main moves a context line');
    r.git(['update-ref', 'refs/remotes/origin/main', main2]);
    r.git(['checkout', '-q', 'pr']);
    r.git(['rebase', '-q', 'main']);
    const rebased = r.git(['rev-parse', 'HEAD']);
    const head = r.number();
    const cov = r.coverage(comments, head);
    expect(cov).toMatchObject({ covers: true, tier: 'numbering', base: rebased });
    expect(cov.reason).toMatch(/replay/);
    // The rebased head itself (no numbering) is covered by the contribution tier.
    expect(r.coverage(comments, rebased)).toMatchObject({ covers: true, tier: 'contribution' });
  });

  it('a mechanical merge of main into the lane keeps the clearance (conflict-watch / drain refresh)', () => {
    const r = repo();
    const comments = [clearHuman(r.cleared, r.netDiff(r.cleared).text)];
    r.git(['checkout', '-q', 'main']);
    r.write('scripts/other.mjs', 'export const other = true;\n');
    const main2 = r.commit('unrelated main change');
    r.git(['update-ref', 'refs/remotes/origin/main', main2]);
    r.git(['checkout', '-q', 'pr']);
    r.git(['merge', '-q', '--no-edit', 'main']);
    expect(r.coverage(comments, r.git(['rev-parse', 'HEAD']))).toMatchObject({ covers: true, tier: 'fingerprint' });
  });
});

describe('clearanceCovers — never weakened', () => {
  it('a one-byte content change is not covered', () => {
    const r = repo();
    const comments = [clearHuman(r.cleared, r.netDiff(r.cleared).text)];
    r.write('scripts/app.mjs', APP(undefined, 'const e = 51;'));
    const cov = r.coverage(comments, r.commit('one byte'));
    expect(cov.covers).toBe(false);
  });

  it('a one-byte change hidden under a numbering commit is not covered', () => {
    const r = repo();
    const comments = [clearHuman(r.cleared, r.netDiff(r.cleared).text)];
    r.write('scripts/app.mjs', APP(undefined, 'const e = 51;'));
    r.commit('one byte');
    expect(r.coverage(comments, r.number()).covers).toBe(false);
  });

  it('a mode-only change is not covered', () => {
    const r = repo();
    const comments = [clearHuman(r.cleared, r.netDiff(r.cleared).text)];
    chmodSync(join(r.cwd, 'scripts/app.mjs'), 0o755);
    const head = r.commit('mode only');
    expect(r.git(['diff', '--name-only', r.cleared, head])).toBe('scripts/app.mjs');
    expect(r.coverage(comments, head).covers).toBe(false);
  });

  it('a trailing-newline-only change is not covered', () => {
    const r = repo();
    const comments = [clearHuman(r.cleared, r.netDiff(r.cleared).text)];
    r.write('backlog/xabc123-foo.md', '---\nkind: story\n---\nfollow-up of the app change');
    expect(r.coverage(comments, r.commit('drop the trailing newline')).covers).toBe(false);
  });

  it('only a trusted clear-human record counts: an untrusted forged clearance, or a plain accept alone, covers nothing', () => {
    const r = repo();
    const diff = r.netDiff(r.cleared).text;
    const head = r.number();
    const forged = { ...clearHuman(r.cleared, diff), viewerDidAuthor: false, author: { login: 'stranger' } };
    expect(latestOperatorClearanceRecord([forged])).toBeNull();
    expect(r.coverage([forged], head).covers).toBe(false);
    expect(r.coverage([plainAccept(r.cleared, diff)], head).covers).toBe(false);
  });

  it('the live fingerprint comes from git, never a comment: a later trusted comment naming the live head\'s digest does not matter', () => {
    const r = repo();
    const diff = r.netDiff(r.cleared).text;
    r.write('scripts/app.mjs', APP(undefined, 'const e = 99;'));
    const head = r.commit('substantive');
    // A plain accept of the NEW head after the clearance: the clearance is still the record, and it does not cover.
    const comments = [clearHuman(r.cleared, diff), plainAccept(head, r.netDiff(head).text)];
    expect(latestOperatorClearanceRecord(comments).sha).toBe(r.cleared);
    expect(r.coverage(comments, head).covers).toBe(false);
  });

  it('a later hold, send-back or standing change request stops a content-bound cover; a later accept or head-move note does not', () => {
    const r = repo();
    const diff = r.netDiff(r.cleared).text;
    const head = r.number();
    const ok = (comments, extra) => r.coverage(comments, head, extra).covers;
    expect(ok([clearHuman(r.cleared, diff), plainAccept(r.cleared, diff)])).toBe(true);
    expect(ok([clearHuman(r.cleared, diff), trusted('**`review:accepted` removed — stale acceptance beside `review:pending`.**\n\nx')])).toBe(true);
    expect(ok([clearHuman(r.cleared, diff), { body: 'Please hold this PR.', author: { login: 'chalbert' } }])).toBe(false);
    expect(ok([clearHuman(r.cleared, diff), trusted('🔁 review — changes requested\n\nRecorded by reviewer.')])).toBe(false);
    expect(ok([clearHuman(r.cleared, diff)], { reviews: null })).toBe(false);
    expect(ok([clearHuman(r.cleared, diff)], { reviews: [{ state: 'CHANGES_REQUESTED', submitted_at: '2026-10-21T00:00:00Z', user: { login: 'x' } }] })).toBe(false);
    expect(ok([clearHuman(r.cleared, diff)], { reviews: [] })).toBe(true);
    // The sha tier (same head) is unchanged by later comments, as today.
    expect(r.coverage([clearHuman(r.cleared, diff), { body: 'Please hold this PR.', author: { login: 'chalbert' } }], r.cleared).covers).toBe(true);
  });

  it('the existing kill switches narrow it: carry off → sha only; numbering carry off → no numbering normalization', () => {
    const off = { value: false, source: 'env' };
    const on = { value: true, source: 'test' };
    expect(resolveClearanceBindingSettings({ env: {}, tool: {}, platform: null, humanCarry: off, numberingCarry: on }).bindTo.value).toBe('sha');
    expect(resolveClearanceBindingSettings({ env: {}, tool: {}, platform: null, humanCarry: on, numberingCarry: off }).normalizeNumbering.value).toBe(false);
    expect(resolveClearanceBindingSettings({ env: {}, tool: {}, platform: null, humanCarry: on, numberingCarry: on }))
      .toMatchObject({ bindTo: { value: 'fingerprint' }, normalizeNumbering: { value: true } });
  });

  it('content the text digests cannot see is still refused: invalid UTF-8 byte swap, binary blob, rename', () => {
    const r = repo();
    r.write('scripts/raw.txt', Buffer.from([0x61, 0x80, 0x0a]));
    r.write('scripts/blob.bin', Buffer.from([0, 1, 2, 3, 0, 255]));
    const cleared = r.commit('raw bytes the operator cleared');
    const comments = [clearHuman(cleared, r.netDiff(cleared).text)];
    // 0x80 → 0x81: both decode to U+FFFD, so the text fingerprints collide; the replay's object ids do not.
    r.write('scripts/raw.txt', Buffer.from([0x61, 0x81, 0x0a]));
    const swapped = r.commit('invalid UTF-8 byte swap');
    expect(normalizeDiffFingerprint(r.netDiff(swapped).text)).toBe(normalizeDiffFingerprint(r.netDiff(cleared).text));
    expect(r.coverage(comments, swapped).covers).toBe(false);
    r.git(['reset', '-q', '--hard', cleared]);
    r.write('scripts/blob.bin', Buffer.from([0, 1, 2, 3, 0, 254]));
    expect(r.coverage(comments, r.commit('binary byte')).covers).toBe(false);
    r.git(['reset', '-q', '--hard', cleared]);
    r.git(['mv', 'scripts/blob.bin', 'scripts/blob2.bin']);
    expect(r.coverage(comments, r.commit('rename')).covers).toBe(false);
  });

  it('diff configuration or the working directory cannot hide a changed path (diff.relative from a subdirectory)', () => {
    const r = repo();
    const comments = [clearHuman(r.cleared, r.netDiff(r.cleared).text)];
    r.git(['config', 'diff.relative', 'true']);
    r.write('scripts/app.mjs', APP(undefined, 'const e = 77;'));
    const head = r.commit('code outside backlog/');
    const sub = join(r.cwd, 'backlog');
    const cov = computeClearanceCoverage({ comments, liveHead: head, exec: execFileSync, cwd: sub, settings, log: quiet, reviews: [] });
    expect(cov.covers).toBe(false);
  });

  it('bindTo=sha is the parent behaviour exactly: a later plain accept hides the clearance even on the same head', () => {
    const r = repo();
    const diff = r.netDiff(r.cleared).text;
    const sha = { ...settings, bindTo: { value: 'sha', source: 'env' } };
    expect(r.coverage([clearHuman(r.cleared, diff)], r.cleared, { settings: sha })).toMatchObject({ covers: true, tier: 'sha' });
    expect(r.coverage([clearHuman(r.cleared, diff), plainAccept(r.cleared, diff)], r.cleared, { settings: sha }).covers).toBe(false);
  });

  it('a commit wearing the numbering subject that also changes code is not normalized', () => {
    const r = repo();
    const comments = [clearHuman(r.cleared, r.netDiff(r.cleared).text)];
    const content = readFileSync(join(r.cwd, 'backlog/xabc123-foo.md'), 'utf8');
    r.git(['mv', 'backlog/xabc123-foo.md', 'backlog/7001-foo.md']);
    r.write('backlog/7001-foo.md', content.replace(/^---\n/, '---\nbornAs: xabc123\n'));
    r.write('backlog/0001-parent.md', 'parent card\nsee #7001\n');
    r.write('scripts/app.mjs', APP(undefined, 'const e = 500;'));
    const head = r.commit('drain: JIT-number xabc123→#7001 at land (#2288)');
    const cov = r.coverage(comments, head);
    expect(cov.covers).toBe(false);
    expect(cov.reason).toMatch(/numbering/);
  });

  it('a later trusted send-back carrying a reviewed-sha marker is still a hold; omitted formal reviews refuse', () => {
    const r = repo();
    const diff = r.netDiff(r.cleared).text;
    const head = r.number();
    const sendBack = trusted(`🔁 review — changes requested\n\nRecorded by reviewer.\n\n${buildReviewedShaMarker(r.cleared)}`);
    expect(latestOperatorClearanceRecord([clearHuman(r.cleared, diff), sendBack]).laterStands).toBe(true);
    expect(r.coverage([clearHuman(r.cleared, diff), sendBack], head).covers).toBe(false);
    // Prose quoting a marker is not an acceptance record either.
    const quoted = trusted(`Hold on — this is not ok. ${buildReviewedShaMarker(r.cleared)}`);
    expect(r.coverage([clearHuman(r.cleared, diff), quoted], head).covers).toBe(false);
    expect(r.coverage([clearHuman(r.cleared, diff)], head, { reviews: undefined }).covers).toBe(false);
    expect(r.coverage([clearHuman(r.cleared, diff)], head, { reviews: () => { throw new Error('gh'); } }).covers).toBe(false);
    expect(r.coverage([clearHuman(r.cleared, diff)], head, { reviews: () => [] }).covers).toBe(true);
  });

  it('unreadable evidence fails closed', () => {
    const clearance = { sha: 'a'.repeat(40), diff: 'b'.repeat(64), contribution: 'c'.repeat(64) };
    const liveHead = 'd'.repeat(40);
    const reviews = [];
    expect(clearanceCovers({ clearance, liveHead, reviews }).covers).toBe(false);
    // Even a strict (byte-identical text) match needs the replay proof.
    expect(clearanceCovers({ clearance, liveHead, reviews, fingerprintOf: () => ({ diff: 'b'.repeat(64), contribution: 'c'.repeat(64) }) }).covers).toBe(false);
    expect(clearanceCovers({ clearance, liveHead, reviews, fingerprintOf: () => ({ diff: 'b'.repeat(64), contribution: 'c'.repeat(64) }),
      proveReplay: () => ({ ok: true, reason: 'replayed' }) })).toMatchObject({ covers: true, tier: 'fingerprint' });
    // A proven numbering run whose base fails the replay is not covered.
    expect(clearanceCovers({ clearance, liveHead, reviews, fingerprintOf: (sha) => (sha === liveHead ? { diff: 'f'.repeat(64), contribution: 'f'.repeat(64) }
      : { diff: 'b'.repeat(64), contribution: 'c'.repeat(64) }), numberingProof: () => ({ ok: true, base: 'e'.repeat(40), reason: 'numbering' }),
      proveReplay: () => ({ ok: false, reason: 'differs' }) }).covers).toBe(false);
    expect(clearanceCovers({ clearance, liveHead, reviews, fingerprintOf: () => null }).covers).toBe(false);
    expect(clearanceCovers({ clearance, liveHead, reviews, fingerprintOf: () => { throw new Error('git'); } }).covers).toBe(false);
    // Contribution match without the replay proof is not enough.
    expect(clearanceCovers({ clearance, liveHead, reviews, fingerprintOf: () => ({ diff: 'e'.repeat(64), contribution: 'c'.repeat(64) }),
      proveReplay: () => ({ ok: false, reason: 'conflict' }) }).covers).toBe(false);
    expect(clearanceCovers({ clearance, liveHead, reviews, fingerprintOf: () => ({ diff: 'e'.repeat(64), contribution: 'c'.repeat(64) }),
      proveReplay: () => ({ ok: true, reason: 'replayed' }) })).toMatchObject({ covers: true, tier: 'contribution' });
    // strict equivalence policy refuses the contribution tier outright.
    expect(clearanceCovers({ clearance, liveHead, reviews, equivalence: 'strict', fingerprintOf: () => ({ diff: 'e'.repeat(64), contribution: 'c'.repeat(64) }),
      proveReplay: () => ({ ok: true, reason: 'replayed' }) }).covers).toBe(false);
  });
});

describe('clearanceBindsHead — the readers\' one predicate', () => {
  const head = 'a'.repeat(40);
  it('honours a sha match, or a covering verdict computed for THIS head only', () => {
    expect(clearanceBindsHead({ humanClearedSha: head, headSha: head })).toBe(true);
    expect(clearanceBindsHead({ humanClearedSha: 'b'.repeat(40), headSha: head })).toBe(false);
    expect(clearanceBindsHead({ headSha: head, coverage: { covers: true, liveHead: head } })).toBe(true);
    expect(clearanceBindsHead({ headSha: head, coverage: { covers: true, liveHead: 'c'.repeat(40) } })).toBe(false);
    expect(clearanceBindsHead({ headSha: head, coverage: { covers: 'yes', liveHead: head } })).toBe(false);
    expect(clearanceBindsHead({ headSha: null, coverage: { covers: true, liveHead: head } })).toBe(false);
  });
  it('routes the tamper re-park and both heals', () => {
    const cov = { covers: true, liveHead: head };
    expect(shouldReparkForTestTampering({ tampered: true, netDiffScored: true, humanClearedSha: 'b'.repeat(40), headSha: head })).toBe(true);
    expect(shouldReparkForTestTampering({ tampered: true, netDiffScored: true, humanClearedSha: 'b'.repeat(40), headSha: head, clearanceCoverage: cov })).toBe(false);
    const pendingAccepted = [REVIEW_LABELS.pending, REVIEW_LABELS.accepted];
    expect(decideContradictoryVerdictHeal({ currentLabels: pendingAccepted, acceptedSha: 'b'.repeat(40), headSha: head, fetchOk: true }).heal).toBe(true);
    expect(decideContradictoryVerdictHeal({ currentLabels: pendingAccepted, acceptedSha: 'b'.repeat(40), headSha: head, fetchOk: true, clearanceCoverage: cov }))
      .toMatchObject({ heal: false, reason: 'clearance-covers-head' });
    const humanAccepted = [REVIEW_LABELS.human, REVIEW_LABELS.accepted];
    expect(decideContradictoryVerdictHeal({ currentLabels: humanAccepted, humanClearedSha: 'b'.repeat(40), headSha: head, fetchOk: true }).heal).toBe(true);
    expect(decideContradictoryVerdictHeal({ currentLabels: humanAccepted, humanClearedSha: 'b'.repeat(40), headSha: head, fetchOk: true, clearanceCoverage: cov }))
      .toMatchObject({ heal: false, reason: 'genuine-clearance' });
  });
  it('a stale-looking accept is not re-parked when the clearance covers the head; review:changes still applies', () => {
    const cov = { covers: true, liveHead: head };
    const inputs = { labels: [REVIEW_LABELS.accepted], acceptedSha: 'b'.repeat(40), headSha: head, humanRequired: true };
    expect(decideReviewGate(inputs)).toMatchObject({ action: 'park', staleAcceptance: true });
    expect(decideReviewGate({ ...inputs, clearanceCoverage: cov }).action).toBe('merge');
    expect(decideReviewGate({ ...inputs, labels: [REVIEW_LABELS.changes], clearanceCoverage: cov }).action).toBe('wait-author');
  });
});

describe('review.clearance settings', () => {
  it('cascade: standard → tool → env, invalid values never override, source logged once', () => {
    expect(resolveClearanceBindingSettings({ env: {}, tool: {}, platform: null })).toMatchObject({ bindTo: { value: 'fingerprint' }, normalizeNumbering: { value: true } });
    expect(resolveClearanceBindingSettings({ env: {}, tool: { clearance: { bindTo: 'sha' } }, platform: null }).bindTo).toEqual({ value: 'sha', source: 'tool' });
    expect(resolveClearanceBindingSettings({ env: { WE_REVIEW_CLEARANCE_BIND_TO: 'sha' }, tool: {}, platform: null }).bindTo).toEqual({ value: 'sha', source: 'env' });
    expect(resolveClearanceBindingSettings({ env: { WE_REVIEW_CLEARANCE_BIND_TO: 'loose' }, tool: {}, platform: null }).bindTo.value).toBe('fingerprint');
    expect(resolveClearanceBindingSettings({ env: { WE_REVIEW_CLEARANCE_NORMALIZE_NUMBERING: 'off' }, tool: {}, platform: null }).normalizeNumbering).toEqual({ value: false, source: 'env' });
    _resetClearanceBindingLog();
    const lines = [];
    logClearanceBindingSettings(settings, (l) => lines.push(l));
    logClearanceBindingSettings(settings, (l) => lines.push(l));
    expect(lines).toEqual(['policy · review.clearance.bindTo=fingerprint (test) · review.clearance.normalizeNumbering=true (test)\n']);
  });
});
