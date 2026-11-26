import { legacyStandDownComment } from '../../conveyor/__tests__/fixtures/legacy-stand-down.mjs';
import { describe, it, expect } from 'vitest';
import { prReconcileOperation, shapeReconcileFinding, assessReconcilePrs } from '../pr-reconcile.mjs';
import { createPrReconcileReader, listArgv, commentsArgv, LIST_LIMIT } from '../pr-status-io.mjs';
import { buildDrainReasonComment, buildHeldReviewHoldReason } from '../../merge-ai-prs.mjs';
import { buildStandDownComment } from '../../conveyor/stand-down.mjs';
import { createRegistry } from '../registry.mjs';
import { runOperationCli } from '../cli-adapter.mjs';
import { resolveOperation } from '../run.mjs';

const row = (number = 1, extra = {}) => ({
  number, title: 'fixture', state: 'OPEN', headRefOid: `sha${number}`,
  mergeable: 'MERGEABLE', labels: [], ...extra,
});
// #3383 — every marker reader now requires a TRUSTED author (`we:scripts/lib/marker-authorship.mjs`); these
// fixtures represent legitimate automation-posted comments unless a test says otherwise.
const comment = (body, createdAt = '2026-09-01T00:00:00Z') => ({ body, createdAt, url: 'https://example.com/comment', author: { login: 'web-everything' } });
const check = (name = 'test', conclusion = 'success') => ({ name, status: 'completed', conclusion });

function fixture({ rows = [row()], comments = {}, checks = {} } = {}) {
  const calls = [];
  const run = (bin, argv, options) => {
    calls.push({ bin, argv, options });
    if (argv[0] === 'pr' && argv.at(-1) === 'comments') {
      return JSON.stringify({ comments: comments[Number(argv[2])] ?? [] });
    }
    if (argv[0] === 'pr') {
      return JSON.stringify(argv[1] === 'view' ? rows.find((r) => r.number === Number(argv[2]))
        : rows.slice(0, Number(argv[argv.indexOf('--limit') + 1])));
    }
    const sha = argv.find((a) => a.includes('/commits/'))?.split('/')[4];
    if (sha) return (checks[sha] ?? [check()]).map((c) => JSON.stringify(c)).join('\n');
    throw new Error(`unexpected argv: ${argv}`);
  };
  const readPrs = createPrReconcileReader({ run });
  return { readPrs, calls, report: (pr = 0) => assessReconcilePrs(shapeReconcileFinding(readPrs({ repo: 'o/r', pr }))) };
}

describe('actual labels and comment holds', () => {
  it.each([
    ['review:human', 'human'], ['review:pending', 'advisory-pending'],
    ['review:changes', 'advisory-pending'], ['blocked', 'dependency'],
  ])('explains %s with its exact evidence', (label, heldBy) => {
    const pr = fixture({ rows: [row(1, { labels: [{ name: label }] })] }).report().prs[0];
    expect(pr.heldBy).toBe(heldBy);
    expect(pr.heldByEvidence).toEqual([{ source: 'label', label }]);
    expect(pr.unblock).toBeTruthy();
  });

  it('finds a label-free stand-down through the canonical marker reader', () => {
    const body = legacyStandDownComment({ reason: 'needs-judgment', detail: 'Which behavior is intended?' });
    const pr = fixture({ comments: { 1: [comment(body)] } }).report().prs[0];
    expect(pr.heldBy).toBe('stand-down');
    expect(pr.heldByEvidence).toEqual([{ source: 'comment', excerpt: body, url: 'https://example.com/comment' }]);
  });

  it.each([
    ['held — a review hold (review:human) stands, so the go-ahead is withheld.', 'human'],
    ['held — a review hold (review:pending) stands, so the go-ahead is withheld.', 'advisory-pending'],
    ['Blocked by #42 until its contract lands.', 'dependency'],
    ['Merge conflict with main needs resolution.', 'conflict'],
  ])('reads a comment-only hold: %s', (body, heldBy) => {
    expect(fixture({ comments: { 1: [comment(body)] } }).report().prs[0]).toMatchObject({
      heldBy, heldByEvidence: [{ source: 'comment', excerpt: body }],
    });
  });

  it('recognizes the actual drain comment envelopes, including comment-only conflicts', () => {
    const body = buildDrainReasonComment('skip', buildHeldReviewHoldReason({ labels: ['review:human'] }));
    expect(fixture({ comments: { 1: [comment(body)] } }).report().prs[0]).toMatchObject({
      heldBy: 'human', heldByEvidence: [{ source: 'comment', excerpt: body }],
    });
    const conflict = buildDrainReasonComment('skip', 'not mergeable (mergeable=CONFLICTING)');
    expect(fixture({ comments: { 1: [comment(conflict)] } }).report().prs[0].heldBy).toBe('conflict');
  });

  it('does not let an undated acceptance label override a comment-only human hold', () => {
    expect(fixture({ rows: [row(1, { labels: ['review:accepted'] })],
      comments: { 1: [comment('Human review required')] } }).report().prs[0].heldBy).toBe('human');
  });

  it('reports none explicitly, retaining all review labels', () => {
    const pr = fixture({ rows: [row(1, { labels: ['review:accepted', 'review:extra', 'ready-to-merge'] })] }).report().prs[0];
    expect(pr).toMatchObject({ heldBy: 'none', heldByEvidence: [], holds: [], reviewLabels: ['review:accepted', 'review:extra'] });
  });

  it('does not interpret quoted markers or incidental label mentions as holds', () => {
    const comments = [comment(`> ${legacyStandDownComment()}`), comment('This change documents review:human.')];
    expect(fixture({ comments: { 1: comments } }).report().prs[0].heldBy).toBe('none');
  });

  it('preserves secondary holds and deterministic precedence', () => {
    const pr = fixture({ rows: [row(1, { labels: ['blocked', 'review:pending', 'review:human'], mergeable: 'CONFLICTING' })],
      comments: { 1: [comment(legacyStandDownComment()), comment('Merge conflict with main')] } }).report().prs[0];
    expect(pr.heldBy).toBe('human');
    expect(pr.holds.map((h) => h.heldBy)).toEqual(['human', 'stand-down', 'conflict', 'dependency', 'advisory-pending']);
  });

  it('clears ordinary comment history with a later explicit clearance, but preserves stand-down', () => {
    const comments = [comment('Human review required'), comment('Hold cleared', '2026-09-02T00:00:00Z')];
    expect(fixture({ comments: { 1: comments } }).report().prs[0].heldBy).toBe('none');
    comments.push(comment(legacyStandDownComment()));
    expect(fixture({ comments: { 1: comments } }).report().prs[0].heldBy).toBe('stand-down');
  });
});

describe('shared IO and complete stable report', () => {
  it('reads all three states and never treats a historical label as a live hold', () => {
    const f = fixture({ rows: ['CLOSED', 'MERGED', 'OPEN'].map((state, i) => row(3 - i, { state, labels: ['review:human'] })) });
    expect(f.report().prs.map((p) => [p.number, p.state, p.heldBy])).toEqual([
      [1, 'open', 'human'], [2, 'merged', 'none'], [3, 'closed', 'none'],
    ]);
    expect(f.calls[0].argv).toEqual(listArgv({ repo: 'o/r', state: 'all' }));
    expect(f.calls.some((c) => JSON.stringify(c.argv) === JSON.stringify(commentsArgv({ repo: 'o/r', pr: 2 })))).toBe(true);
    expect(f.calls.every((c) => c.bin === 'gh' && c.options.timeout > 0)).toBe(true);
  });

  it('continues past the old listing cap', () => {
    const f = fixture({ rows: Array.from({ length: LIST_LIMIT + 1 }, (_, i) => row(i + 1)) });
    expect(f.report().prs).toHaveLength(LIST_LIMIT + 1);
    expect(f.calls.filter((c) => c.argv[1] === 'list')).toHaveLength(2);
  });

  it('reads only the requested PR when narrowed', () => {
    const f = fixture({ rows: [row(1), row(2)] });
    expect(f.report(2).prs.map((p) => p.number)).toEqual([2]);
    expect(f.calls.some((c) => c.argv[1] === 'list')).toBe(false);
  });

  it('reports the required check on the actual head, not an unrelated successful check', () => {
    const f = fixture({ checks: { sha1: [check('lint'), check('test', 'failure')] } });
    expect(f.report().prs[0].requiredCheck).toMatchObject({ name: 'test', state: 'red' });
    expect(f.calls.some((c) => c.argv.includes('repos/o/r/commits/sha1/check-runs') && c.argv.includes('--paginate'))).toBe(true);
    expect(fixture({ checks: { sha1: [check('lint')] } }).report().prs[0].requiredCheck.state).toBe('unchecked');
  });

  it('is byte-stable across reordered labels, PRs, checks and comments', () => {
    const rows = [row(2), row(1, { labels: ['review:pending', 'blocked'] })];
    const comments = [comment('Context'), comment('Blocked by #9')];
    const a = fixture({ rows, comments: { 1: comments }, checks: { sha1: [check(), check('lint')] } }).report();
    const b = fixture({ rows: [...rows].reverse().map((r) => ({ ...r, labels: [...r.labels].reverse() })),
      comments: { 1: [...comments].reverse() }, checks: { sha1: [check('lint'), check()] } }).report();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('fails loudly when comment fetch fails or returns an unreadable shape', () => {
    for (const answer of [null, '{}']) {
      const read = createPrReconcileReader({ run: (_bin, argv) => {
        if (argv.at(-1) !== 'comments') return JSON.stringify([row()]);
        if (answer === null) throw new Error('network unreachable');
        return answer;
      } });
      expect(() => read({ repo: 'o/r' })).toThrow(/network unreachable|unreadable comments/);
    }
    expect(() => shapeReconcileFinding({ prs: [{ number: 1, headSha: 'abc' }] })).toThrow(/needs state/);
  });
});

describe('declaration and derived CLI, no subprocess', () => {
  it('registers with the same two compute steps and no sinks', () => {
    expect(() => prReconcileOperation()).toThrow(/needs a `readPrs/);
    const { declaration, sinks } = resolveOperation('pr-reconcile');
    expect(declaration.steps.map((s) => s.step.kind)).toEqual(['compute', 'compute']);
    expect(sinks).toEqual({});
    expect(declaration.input.repo.required).toBe(true);
  });

  it('returns the standard JSON envelope and exits zero even for held PRs', async () => {
    const f = fixture({ rows: [row(42, { labels: ['review:human'] })], checks: { sha42: [check('build')] } });
    const declaration = prReconcileOperation({ readPrs: f.readPrs });
    const registry = createRegistry();
    registry.register(declaration);
    const result = await runOperationCli({ declaration, registry,
      argv: ['--repo=o/r', '--pr=42', '--requiredCheck=build', '--json'],
      store: { write() {} }, sinks: {}, newRunId: () => 'fixture-run',
    });
    expect(result.code).toBe(0);
    expect(result.stopped).toBe('complete');
    expect(JSON.parse(result.lines[0]).verdict.prs[0]).toMatchObject({ number: 42, heldBy: 'human', requiredCheck: { name: 'build', state: 'green' } });
  });
});
