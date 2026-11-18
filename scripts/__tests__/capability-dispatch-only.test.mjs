/** @repo-scanning-test scope=files — capability admission rules are checked per changed source. */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { scanScope, scopedScanFiles } from '../lib/repo-scan-tests.mjs';

const root = resolve(import.meta.dirname, '../..');
const scope = scanScope();
const allowlist = new Set([
  'scripts/conveyor/reconcile-fix-dispatch.mjs', // S1 fixer dispatch admission.
  'scripts/conveyor/orphan-fix-round.mjs', // Orphan fixer redispatch only.
  'scripts/conveyor/load-flake-reverify.mjs', // Redispatch and saved-fix push only.
  'scripts/operations/review-dispatch.mjs', // S1 independent review admission.
  'skills-src/conveyor/review-daemon.mjs', // Ordinary and recovery review starts.
  'scripts/merge-ai-prs.mjs', // Lander enqueue and direct merge dispatch only.
  'scripts/operations/promote-draft-pr-dispatch.mjs', // Draft promotion only.
  'scripts/operations/ci-heal-pr-dispatch.mjs', // S1 CI-heal dispatch admission.
]);
function sources(dir) {
  return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap(entry => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return ['__tests__', 'node_modules'].includes(entry.name) ? [] : sources(path);
    return /\.(?:mjs|js|ts)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name) ? [path] : [];
  });
}
function rosterFilters(source) {
  const file = ts.createSourceFile('source.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && /^(filter|map|flatMap)$/.test(node.expression.name.text)) {
      const text = node.getText(file);
      if (/\b(?:repos|CONSTELLATION_REPOS)\b/.test(node.expression.expression.getText(file))
        && /(?:repoHasCapability|assertCapability|constellationRepoKeysWith|capabilities\s*(?:\.|\[|\?))/.test(text)) found.push(text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}
describe('capabilities admit dispatch only', () => {
  const files = scopedScanFiles([...new Set([
    ...sources('scripts/conveyor'), ...sources('skills-src/conveyor'), ...sources('scripts/operations'),
    'scripts/merge-ai-prs.mjs',
  ])]);
  it.each(files)('%s has no capability-filtered roster or unapproved admission', path => {
    const source = readFileSync(resolve(root, path), 'utf8');
    if (!allowlist.has(path)) expect(source).not.toMatch(/\b(?:constellationRepoKeysWith|repoHasCapability|assertCapability)\b/);
    expect(source).not.toContain('constellationRepoKeysWith');
    expect(rosterFilters(source)).toEqual([]);
  });
  it.each([
    'repos.filter(repo => repoHasCapability(repo, "fix"))',
    'Object.keys(CONSTELLATION_REPOS).map(repo => assertCapability(repo, "review"))',
    'repos.flatMap(repo => repo.capabilities?.fix ? [repo] : [])',
  ])('detects a capability roster regression: %s', source => expect(rosterFilters(source)).toHaveLength(1));

  it.skipIf(scope !== null && !scope.has('scripts/merge-ai-prs.mjs'))('keeps lander admissions at write boundaries, with no roster filtering', () => {
    const source = readFileSync(resolve(root, 'scripts/merge-ai-prs.mjs'), 'utf8');
    const file = ts.createSourceFile('merge-ai-prs.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const sites = [];
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(file) === 'assertCapability') {
        let owner = node.parent;
        while (owner && !ts.isFunctionDeclaration(owner) && !ts.isArrowFunction(owner)) owner = owner.parent;
        if (ts.isFunctionDeclaration(owner)) sites.push(owner.name.text);
        else if (ts.isVariableDeclaration(owner.parent)) sites.push(owner.parent.name.getText(file));
        else if (ts.isPropertyAssignment(owner.parent)) sites.push(owner.parent.name.getText(file));
        else sites.push('unapproved');
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    expect(sites).toEqual(['enqueueWithSameHeadGuard', 'announceAndRetargetBeforeLand',
      'sweepOnce', 'sweepOnce', 'refreshApprovedHead', 'sweepOnce', 'prepare', 'form', 'run', 'sweepOnce']);
  });
});

// card: scope every gh write with an explicit --repo / known remaining unguarded write sites
// Debt inventory only: these existing writes are not additional capability-admission sites.
// Pin argv and multiplicity, not line numbers, so a new call cannot borrow an existing exception.
// The daemon delegates writes; include its label/comment helpers as well as direct gh effects.
const delegatedWrites = new Set([
  'sweepHumanSurfaceRepark', 'sweepReviewHoldLabels', 'holdReconcile', 'notifyReferral',
  'tagStatus', 'tagRound', 'tagReviewRound', 'tagReviewStatus', 'postRefreshMarker',
  'syncResultOnHeadLabels', 'runGateCatchUp',
]);
function remainingWriteSites(source) {
  const file = ts.createSourceFile('source.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const sites = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(file);
      if (delegatedWrites.has(callee)) sites.push(callee);
      else if (node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'gh') {
        const argv = node.arguments[1];
        // Only positively identified reads are exempt. Dynamic argv stays visible in the ratchet.
        const words = argv && ts.isArrayLiteralExpression(argv) ? argv.elements.map(n => ts.isStringLiteral(n) ? n.text : null) : [];
        const read = ['pr', 'repo', 'issue'].includes(words[0]) && ['list', 'view'].includes(words[1])
          || words[0] === 'api' && !argv.elements.some(ts.isSpreadElement)
            && !words.some(w => w && /^(?:-X|-f|-F|--method|--field|--raw-field|--input)/.test(w));
        if (!read) sites.push(`${callee}(${node.arguments.slice(0, 2).map(n => n.getText(file).replace(/\s+/g, ' ')).join(', ')})`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return sites;
}
const remainingUnguardedWrites = [
  {"file":"scripts/merge-ai-prs.mjs","description":"Opaque gh argv forwarding boundary (includes existing readers)","call":"exec('gh', GH_ARGV.readPrReviews(repo || '{owner}/{repo}', pr))"},
  {"file":"scripts/merge-ai-prs.mjs","description":"Opaque gh argv forwarding boundary (includes existing readers)","call":"exec('gh', GH_ARGV.readPrReviews(slug, pr))"},
  {"file":"scripts/merge-ai-prs.mjs","description":"Remove lifecycle/hold/stale label","call":"exec('gh', ['pr', 'edit', String(pr), ...flag, '--remove-label', rm])"},
  {"file":"scripts/merge-ai-prs.mjs","description":"Apply lifecycle/park/review label","call":"exec('gh', ['pr', 'edit', String(pr), ...flag, '--add-label', add])"},
  {"file":"scripts/merge-ai-prs.mjs","description":"Opaque gh argv forwarding boundary (includes existing readers)","call":"exec('gh', apiArgs(repo, headRef))"},
  {"file":"scripts/merge-ai-prs.mjs","description":"Remove lifecycle/hold/stale label","call":"exec('gh', ['pr', 'edit', String(pr), ...(repo ? ['--repo', repo] : []), '--remove-label', label])"},
  {"file":"scripts/merge-ai-prs.mjs","description":"Apply lifecycle/park/review label","call":"exec('gh', ['pr', 'edit', String(pr), ...(repo ? ['--repo', repo] : []), '--add-label', gate.applyLabel])"},
  {"file":"scripts/merge-ai-prs.mjs","description":"Apply lifecycle/park/review label","call":"execFileSync('gh', ['pr', 'edit', String(num), ...repoFlag(repo), '--add-label', label])"},
  {"file":"scripts/merge-ai-prs.mjs","description":"Opaque gh argv forwarding boundary (includes existing readers)","call":"execFileSync('gh', [...args, ...(repo && !repo.startsWith('cwd:') ? ['--repo', repo] : [])])"},
  {"file":"scripts/merge-ai-prs.mjs","description":"Publish drain reason comment","call":"execFileSync('gh', ['pr', 'comment', String(num), ...repoFlag(repo), '--body', buildDrainReasonComment(kind, reasonText, auditLine)])"},
  {"file":"scripts/merge-ai-prs.mjs","description":"Publish drain reason comment","call":"execFileSync('gh', ['pr', 'comment', String(num), ...repoFlag(repo), '--body', buildDrainReasonComment('park', reasonText)])"},
  {"file":"scripts/merge-ai-prs.mjs","description":"Edit existing park comment","call":"execFileSync('gh', ['api', '-X', 'PATCH', `repos/${repo || '{owner}/{repo}'}/issues/comments/${plan.commentId}`, '-f', `body=${buildDrainReasonComment('park', reasonText)}`])"},
  {"file":"scripts/merge-ai-prs.mjs","description":"Opaque gh argv forwarding boundary (includes existing readers)","call":"exec('gh', args)"},
  {"file":"scripts/merge-ai-prs.mjs","description":"Remove lifecycle/hold/stale label","call":"execFileSync('gh', ['pr', 'edit', String(p.number), ...repoFlag(repo), '--remove-label', rm])"},
  {"file":"scripts/merge-ai-prs.mjs","description":"Opaque gh argv forwarding boundary (includes existing readers)","call":"createMqLiveReader((_file, argv, options) => readGh(argv, options))('gh', args)"},
  {"file":"scripts/merge-ai-prs.mjs","description":"Opaque gh argv forwarding boundary (includes existing readers)","call":"execFileP('gh', listArgs)"},
  {"file":"scripts/merge-ai-prs.mjs","description":"Remove lifecycle/hold/stale label","call":"execFileSync('gh', ['pr', 'edit', String(v.num), ...repoFlag(v.repo), '--remove-label', READY_TO_MERGE_LABEL])"},
  {"file":"scripts/merge-ai-prs.mjs","description":"Remove lifecycle/hold/stale label","call":"execFileSync('gh', ['pr', 'edit', String(v.num), ...repoFlag(v.repo), '--remove-label', staleLabel])"},
  {"file":"scripts/merge-ai-prs.mjs","description":"Remove lifecycle/hold/stale label","call":"execFileSync('gh', ['pr', 'edit', String(v.num), ...repoFlag(v.repo), '--remove-label', staleLabel])"},
  {"file":"scripts/merge-ai-prs.mjs","description":"Reconcile carrier PR body","call":"execFileSync('gh', ['pr', 'edit', String(v.num), ...repoFlag(v.repo), '--body', reconciled.body])"},
  {"file":"skills-src/conveyor/review-daemon.mjs","description":"Repark human review surfaces","call":"sweepHumanSurfaceRepark"},
  {"file":"skills-src/conveyor/review-daemon.mjs","description":"Reconcile hold labels","call":"sweepReviewHoldLabels"},
  {"file":"skills-src/conveyor/review-daemon.mjs","description":"Run hold/stamp reconciliation","call":"holdReconcile"},
  {"file":"skills-src/conveyor/review-daemon.mjs","description":"Refresh review/status labels","call":"tagStatus"},
  {"file":"skills-src/conveyor/review-daemon.mjs","description":"Publish referral pause notice","call":"notifyReferral"},
  {"file":"skills-src/conveyor/review-daemon.mjs","description":"Publish scope-refresh result marker","call":"postRefreshMarker"},
  {"file":"skills-src/conveyor/review-daemon.mjs","description":"Publish dispatched review round","call":"tagRound"},
  {"file":"skills-src/conveyor/review-daemon.mjs","description":"Refresh review/status labels","call":"tagStatus"},
  {"file":"skills-src/conveyor/review-daemon.mjs","description":"Repair result labels on current head","call":"syncResultOnHeadLabels"},
  {"file":"skills-src/conveyor/review-daemon.mjs","description":"Publish missing red-team gate result","call":"runGateCatchUp"},
  {"file":"skills-src/conveyor/review-daemon.mjs","description":"Wire round-label writer","call":"tagReviewRound"},
  {"file":"skills-src/conveyor/review-daemon.mjs","description":"Wire status-label writer","call":"tagReviewStatus"},
];

describe('remaining GitHub write debt ratchet', () => {
  it.each(['scripts/merge-ai-prs.mjs', 'skills-src/conveyor/review-daemon.mjs'])
    ('%s adds no write sites outside the documented debt inventory', path => {
      const expected = remainingUnguardedWrites.filter(site => site.file === path);
      expect(expected.every(site => site.description.trim().length > 0)).toBe(true);
      expect(remainingWriteSites(readFileSync(resolve(root, path), 'utf8')).sort())
        .toEqual(expected.map(site => site.call).sort());
    });

  it.each([
    `exec('gh', ['pr', 'edit', '42', '--add-label', 'new'])`,
    `exec('gh', ['api', '-X', 'PATCH', 'repos/owner/repo/issues/42'])`,
    `exec('gh', ['api', 'repos/owner/repo/issues/42', '-f', 'title=new'])`,
    `exec('gh', ['api', '-XPOST', 'repos/owner/repo/issues'])`,
    `exec('gh', ['api', 'repos/owner/repo/issues', ...writeFlags])`,
    `exec('gh', dynamicArgs)`,
    `tagStatus({repo, pr: 42})`,
  ])('detects an added write or opaque gh boundary: %s', source => {
    expect(remainingWriteSites(source)).toHaveLength(1);
    expect(remainingWriteSites(`${source}; ${source};`)).toHaveLength(2);
  });
  it('ignores comments and positively identified reads', () => {
    expect(remainingWriteSites(`// exec('gh', ['pr', 'edit', '42'])
      exec('gh', ['pr', 'view', '42']); exec('gh', ['api', 'repos/owner/repo/pulls']);`)).toEqual([]);
  });
});
