// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import b, { FIX_MARKERS } from './fix-end-rearms-review.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

defineBreakTest(b);

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
// origin/main before R618; keep the negative fixture stable after the fix merges.
const PRE_FIX_COMMIT = '163e9fe190bacdf6ebbcdc6786ddc9305e600aa6';
const CORE = 'scripts/conveyor/reconcile-core.mjs';
const SEND_BACKS = 'scripts/lib/operator-send-backs.mjs';

// Committed change manifest from PRE_FIX_COMMIT to the completed R618 implementation.
// Keep it independent of FIX_MARKERS and moving refs: a merge must not delete the omission cases.
// Comments, blank lines and delimiter-only lines carry no independent R618 behavior.
const R618_CHANGE_MANIFEST = {
  "scripts/conveyor/reconcile-core.mjs": [
    ".flatMap((c, index) => isTrustedMarkerAuthor(c) && typeof c?.body === 'string'",
    "? [{ c, index, body: c.body.trimStart(), at: Date.parse(c.createdAt) }] : [])",
    "const named = fixClaimReleaseHead(last.c.body);",
    "const releaseHead = isEnd && fixClaimReleaseHead(marker.c.body);",
    "return { releasedAtMs: last.at, index: last.index, head, who, releases: [...releasesBySession.values()] };",
    "function fixClaimReleaseHead(body) {",
    "const release = /^🔓 conveyor fix-end — fix claim released\\r?\\n\\r?\\n`([^`\\r\\n]+)` released the fix claim at `([a-f0-9]{7,40})`\\.(?:[ \\t]|\\r?\\n|$)/i.exec(body);",
    "return release?.[1].trim() ? release[2] : null;",
    "function latestHeadReview(pr, { currentHeadOnly = false } = {}) {",
    "const reviews = (Array.isArray(pr?.comments) ? pr.comments : [])",
    ".map((c, index) => ({ c, index }))",
    ".filter(({ c }) => isTrustedMarkerAuthor(c) && (isReviewVerdictComment(c) || latestAdvisory([c])))",
    ".filter(({ c }) => !isOperatorAuthored(c) || !openOperatorSendBacks({ comments: [c] }).length)",
    ".map(({ c, index }) => ({ index, head: reviewedHeadsOf(c).at(-1) ?? latestAdvisory([c])?.head, at: Date.parse(c.createdAt) }));",
    "if (!reviews.length || reviews.some(r => !r.head || !Number.isFinite(r.at))) return null;",
    "const current = reviews.filter(r => sameHeadSha(r.head, pr.headRefOid));",
    "if (currentHeadOnly) {",
    "if (current.some((r, i) => i > 0 && r.at <= current[i - 1].at)) return null;",
    "return current.at(-1) ?? null;",
    "if (current.length || reviews.some((r, i) => i > 0 && r.at <= reviews[i - 1].at)) return null;",
    "return reviews.at(-1);",
    "function operatorSendBackAfterReview(pr) {",
    "const review = latestHeadReview(pr, { currentHeadOnly: true });",
    "if (!review || !sameHeadSha(review.head, pr.headRefOid)) return null;",
    "const item = openOperatorSendBacks(pr).at(-1);",
    "if (!item?.body || !Number.isFinite(Date.parse(item.at)) || Date.parse(item.at) <= review.at",
    "|| item.index <= review.index",
    "|| (item.head && !sameHeadSha(item.head, pr.headRefOid))) return null;",
    "if (!item.id || !operatorSendBackRearm(pr, { verdictId: pr.comments[item.index].id })) return null;",
    "return { verdictId: item.id, login: item.login, body: item.body };",
    "advisoryReview = null, reviewAfterFix = null,",
    "if (advisoryReview || reviewAfterFix) {",
    "if ((advisoryReview?.ciWaived !== true || pr.reviewTiming?.startAfter !== 'ci-green') && !reviewChecksAllow({ pr, requiredChecks, refuse, withPhase, extra })) return;",
    "...(advisoryReview ? { advisoryReview: { head: advisoryReview.head, reason: advisoryReview.reason,",
    "...(advisoryReview.ciWaived === true ? { ciWaived: true } : {}) } } : {}),",
    "why: advisoryReview?.why ?? reviewAfterFix,",
    "const sendBack = (phase === 'needs-human' ? operatorSendBackAfterReview(pr) : null)",
    "?? ((ciRepairOwed || (phase === 'bounced' && !withPhase.labels.includes(CONFLICT_LABEL)))",
    "? operatorSendBackRearm(pr, operatorBudget) : null);",
    "why: `operator send-back by @${sendBack.login} with a must-fix body — re-armed once as a fix (operator re-arm)`,",
    "const lastReview = latestHeadReview(pr);",
    "const release = releasedFixClaim(pr);",
    "if (OWED[phase] && lastReview && release && release.releasedAtMs > lastReview.at",
    "&& !withPhase.labels.includes(CONFLICT_LABEL) && String(pr?.mergeStateStatus ?? '').toUpperCase() !== 'DIRTY'",
    "&& release.index > lastReview.index",
    "&& !sameHeadSha(lastReview.head, pr.headRefOid)) {",
    "const why = 'the fixer released a new head after the last review — its review is owed before another repair';",
    "dispatchReviewRow({ pr, requiredChecks, withPhase, base, attempts: roundAttempts(),",
    "roundCap: effectiveRoundCap, refuse, refuseCapExhausted, dispatch, now,",
    "...(withPhase.labels.includes(REVIEW_LABELS.human)",
    "? { advisoryReview: { head: pr.headRefOid, reason: 'fix-pushed', why } }",
    ": { reviewAfterFix: why }),",
    "continue;"
  ],
  "scripts/lib/operator-send-backs.mjs": [
    "if (text.trimStart().startsWith('🔓 conveyor fix-end') && namesSendBack(text, item)) {",
    "const at = Date.parse(c.createdAt), requestedAt = Date.parse(item.at);",
    "const release = /^🔓 conveyor fix-end — fix claim released\\r?\\n\\r?\\n`([^`\\r\\n]+)` released the fix claim at `([a-f0-9]{7,40})`\\.(?:[ \\t]|\\r?\\n|$)/i.exec(text);",
    "const head = release?.[1].trim() ? release[2] : null;",
    "if (Number.isFinite(at) && Number.isFinite(requestedAt) && at > requestedAt",
    "&& head && (!item.head || differentHead(item.head, head))) return true;"
  ]
};

function addedBehaviorLines(manifest = R618_CHANGE_MANIFEST) {
  const added = Object.entries(manifest).flatMap(([path, lines]) => lines.map(source => [path, source]));
  if (!added.length) throw new Error('R618 behavior enumeration must not be empty');
  return added;
}

const R618_LINES = addedBehaviorLines();

it('R618 enumeration remains nonempty when origin/main equals HEAD and the integration diff is empty', () => {
  const git = vi.mocked(execFileSync), original = git.getMockImplementation();
  const head = 'f'.repeat(40);
  try {
    git.mockImplementation((command, args) => {
      if (command === 'git' && args[0] === 'rev-parse' && ['origin/main', 'HEAD'].includes(args[1])) return head;
      if (command === 'git' && args[0] === 'diff' && args.includes('origin/main')) return '';
      throw new Error('Unexpected command in post-merge fixture');
    });
    expect(execFileSync('git', ['rev-parse', 'origin/main'])).toBe(execFileSync('git', ['rev-parse', 'HEAD']));
    expect(execFileSync('git', ['diff', 'origin/main', '--', CORE, SEND_BACKS])).toBe('');
    const calls = git.mock.calls.length;
    expect(addedBehaviorLines()).toHaveLength(59);
    expect(addedBehaviorLines()).toEqual(R618_LINES);
    expect(git.mock.calls).toHaveLength(calls);
  } finally { git.mockImplementation(original); }
});

it('empty R618 behavior enumeration fails closed instead of skipping omission tests', () => {
  expect(() => addedBehaviorLines({})).toThrow('R618 behavior enumeration must not be empty');
});

it('FIX_MARKERS represents every behavior-bearing line added or changed by R618', () => {
  expect(R618_LINES).toHaveLength(59);
  const uncovered = R618_LINES.filter(([path, source]) =>
    !(FIX_MARKERS[path] ?? []).some(marker => marker.includes(source.trim())));
  expect(uncovered).toEqual([]);
});

it.each(R618_LINES)('fixPresent refuses omission of %s — %s', (path, sourceLine) => {
  withFixedSources(sourceRoot => {
    const source = readFileSync(join(sourceRoot, path), 'utf8').split('\n');
    let omitted = 0;
    const changed = source.map(line => {
      if (line.trim() !== sourceLine) return line;
      omitted++;
      return '/* omitted R618 behavior */';
    });
    expect(omitted).toBeGreaterThan(0);
    writeFileSync(join(sourceRoot, path), changed.join('\n'));
    expect(b.fixPresent(sourceRoot)).toBe(false);
  });
});

function withFixedSources(check) {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'soak-r618-partial-'));
  try {
    for (const path of [CORE, SEND_BACKS]) {
      mkdirSync(resolve(sourceRoot, path, '..'), { recursive: true });
      writeFileSync(join(sourceRoot, path), readFileSync(join(ROOT, path), 'utf8'));
    }
    expect(b.fixPresent(sourceRoot)).toBe(true);
    check(sourceRoot);
  } finally { rmSync(sourceRoot, { recursive: true, force: true }); }
}

it.each([SEND_BACKS, CORE])('fixPresent refuses a root with %s reverted to pinned pre-fix origin/main', path => {
  withFixedSources(sourceRoot => {
    const original = execFileSync('git', ['show', `${PRE_FIX_COMMIT}:${path}`],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(join(sourceRoot, path), original);
    expect(b.fixPresent(sourceRoot)).toBe(false);
  });
});

it.each([
  ['post-fix review rearm', CORE, "reason: 'fix-pushed'"],
  ["review-history read", CORE, "const reviews = (Array.isArray(pr?.comments) ? pr.comments : [])"],
  ["trusted-author review filter", CORE, ".filter(({ c }) => isTrustedMarkerAuthor(c) && (isReviewVerdictComment(c) || latestAdvisory([c])))"],
  ["operator request filter", CORE, ".filter(({ c }) => !isOperatorAuthored(c) || !openOperatorSendBacks({ comments: [c] }).length)"],
  ["review-after-fix CI gate", CORE, "if ((advisoryReview?.ciWaived !== true || pr.reviewTiming?.startAfter !== 'ci-green') && !reviewChecksAllow({ pr, requiredChecks, refuse, withPhase, extra })) return;"],
  ['review-after-fix consumer signature', CORE, 'advisoryReview = null, reviewAfterFix = null,'],
  ['review-after-fix consumer branch', CORE, 'if (advisoryReview || reviewAfterFix) {'],
  ['review-after-fix consumer reason', CORE, 'why: advisoryReview?.why ?? reviewAfterFix'],
  ['non-human review-after-fix producer', CORE, ': { reviewAfterFix: why }),'],
  ['release/review thread order', CORE, 'release.index > lastReview.index'],
  ['send-back/review thread order', CORE, 'item.index <= review.index'],
  ['one-shot consumption', CORE, 'operatorSendBackRearm(pr, { verdictId: pr.comments[item.index].id })'],
  ['conflict priority', CORE, "!withPhase.labels.includes(CONFLICT_LABEL) && String(pr?.mergeStateStatus ?? '').toUpperCase() !== 'DIRTY'"],
  ['strict release-head reader', CORE, 'const named = fixClaimReleaseHead(last.c.body)'],
  ['strict release sentence in core', CORE, String.raw`\.(?:[ \t]|\r?\n|$)/i.exec(body)`],
  ['strict release sentence in send-backs', SEND_BACKS, String.raw`\.(?:[ \t]|\r?\n|$)/i.exec(text)`],
  ['fix-end resolution', SEND_BACKS, 'head && (!item.head || differentHead(item.head, head))) return true;'],
])('fixPresent refuses an incomplete R618 delta without %s', (_name, path, marker) => {
  withFixedSources(sourceRoot => {
    const source = readFileSync(join(sourceRoot, path), 'utf8');
    expect(source).toContain(marker);
    writeFileSync(join(sourceRoot, path), source.replace(marker, '/* omitted safeguard */'));
    expect(b.fixPresent(sourceRoot)).toBe(false);
  });
});

it('pinned pre-fix main reproduces both the missing post-fix review and refused operator repair', async () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'soak-r618-main-'));
  try {
    // Archive to a file: the tree is ~74MB, over any sane execFileSync buffer (an ENOBUFS error would also OOM the worker).
    const tarball = join(sourceRoot, 'pre-fix.tar');
    execFileSync('git', ['archive', '-o', tarball, PRE_FIX_COMMIT, 'scripts', 'src/_data', 'schemas', 'package.json'], { cwd: ROOT });
    execFileSync('tar', ['-xf', tarball, '-C', sourceRoot]);
    symlinkSync(join(ROOT, 'node_modules'), join(sourceRoot, 'node_modules'), 'dir');
    expect(b.fixPresent(sourceRoot)).toBe(false);
    // A child node process: importing the whole pre-fix tree through vite-node exhausts the worker heap.
    const script = `import(${JSON.stringify(new URL('./fix-end-rearms-review.mjs', import.meta.url).href)}).then(async m => {`
      + `const r = await m.default.run({ sourceRoot: ${JSON.stringify(sourceRoot)} });`
      + 'console.log(JSON.stringify(m.default.judge(r)));});';
    const out = execFileSync(process.execPath, ['--max-old-space-size=2048', '-e', script],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    expect(JSON.parse(out.trim().split('\n').at(-1))).toEqual([
      'trusted fix-end on a new head did not dispatch review',
      'newer operator send-back did not dispatch fix after the same-head advisory',
      'newer operator send-back was refused already-reviewed-head',
    ]);
  } finally { rmSync(sourceRoot, { recursive: true, force: true }); }
});

it('missing source fails closed with a scenario violation', async () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'soak-r618-missing-'));
  try {
    expect(b.fixPresent(sourceRoot)).toBe(false);
    expect(b.judge(await b.run({ sourceRoot }))).toEqual([
      expect.stringContaining('scenario failed:'),
    ]);
  } finally { rmSync(sourceRoot, { recursive: true, force: true }); }
});

it('incomplete reconcile source is not evidence of the fix', () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'soak-r618-incomplete-'));
  try {
    mkdirSync(join(sourceRoot, 'scripts/conveyor'), { recursive: true });
    writeFileSync(join(sourceRoot, 'scripts/conveyor/reconcile-core.mjs'), 'function latestHeadReview() {}');
    expect(b.fixPresent(sourceRoot)).toBe(false);
  } finally { rmSync(sourceRoot, { recursive: true, force: true }); }
});
