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
