import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '../..');
const allowlist = new Set([
  'scripts/conveyor/reconcile-fix-dispatch.mjs', // S1 fixer dispatch admission.
  'scripts/conveyor/orphan-fix-round.mjs', // Orphan fixer redispatch only.
  'scripts/conveyor/load-flake-reverify.mjs', // Redispatch and saved-fix push only.
  'scripts/operations/review-dispatch.mjs', // S1 independent review admission.
  'skills-src/conveyor/review-daemon.mjs', // Ordinary and recovery review starts.
  'scripts/merge-ai-prs.mjs', // Lander enqueue only.
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
  const files = [...new Set([
    ...sources('scripts/conveyor'), ...sources('skills-src/conveyor'), ...sources('scripts/operations'),
    'scripts/merge-ai-prs.mjs',
  ])];
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
});
