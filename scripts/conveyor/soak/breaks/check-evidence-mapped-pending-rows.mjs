/**
 * @file check-evidence-mapped-pending-rows.mjs — red-team confirmed break on PR #7084. mapGraphqlPr turns a null
 * conclusion of a queued or in-progress CheckRun into '', and the strict resolver read '' as a terminal conclusion,
 * so a running required check resolved `unknown` (malformed) instead of `pending`.
 *
 * Replay: map a complete current-head GraphQL rollup through the production mapper, resolve it, and require
 * queued/running -> pending, completed success -> pass, and a non-empty conclusion on a running row -> unknown.
 * The replay runs in a child process against the tree under test; fixPresent only checks the resolver exists.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const CASES = [['IN_PROGRESS', null, 'pending'], ['QUEUED', null, 'pending'],
  ['COMPLETED', 'SUCCESS', 'pass'], ['IN_PROGRESS', 'success', 'unknown']];

const SCRIPT = `
import { pathToFileURL } from 'node:url';
const root = process.argv[1], cases = JSON.parse(process.argv[2]);
const { mapGraphqlPr } = await import(pathToFileURL(root + '/scripts/lib/pr-list-paged.mjs').href);
const { resolveRequiredChecks } = await import(pathToFileURL(root + '/scripts/lib/check-state-predicate.mjs').href);
const head = 'a'.repeat(40);
console.log(JSON.stringify(cases.map(([status, conclusion]) => {
  const pr = mapGraphqlPr({ headRefOid: head, commits: { nodes: [{ commit: { oid: head, statusCheckRollup: { contexts: {
    pageInfo: { hasNextPage: false }, totalCount: 1, nodes: [{ __typename: 'CheckRun', name: 'test', status, conclusion }] } } } }] } });
  return resolveRequiredChecks({ rows: pr.statusCheckRollup, rowsHead: pr.rowsHead, rowsComplete: pr.rowsComplete,
    head, requiredNames: ['test'], rosterSource: 'live' }).state;
})));`;

function replay(root) {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', SCRIPT, root, JSON.stringify(CASES)],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  return JSON.parse(out.trim().split('\n').pop());
}

export default {
  id: 'check-evidence-mapped-pending-rows',
  title: 'mapped queued and running checks resolve pending, not malformed',
  card: 'PR #7084 red-team confirmed break (check-state-predicate.mjs:204)',
  fixedBy: { sha: 'lane/ce-s1-plumbing', where: 'lane/ce-s1-plumbing', paths: ['scripts/lib/check-state-predicate.mjs'] },
  fixPresent(root) {
    // Only the subject's presence is checked here; probing the behaviour would turn a regression into an
    // expected failure (it.fails). Once the resolver exists, the replay must be green.
    try { return readFileSync(join(root, 'scripts/lib/check-state-predicate.mjs'), 'utf8').includes('export function resolveRequiredChecks'); } catch { return false; }
  },
  async run({ log, sourceRoot = REPO_ROOT } = {}) {
    const violations = [];
    try {
      const got = replay(join(sourceRoot));
      CASES.forEach(([status, conclusion, want], i) => {
        log?.(`${status}/${conclusion}: ${got[i]}`);
        if (got[i] !== want) violations.push({ invariant: `${status}-${conclusion}`, detail: `expected ${want}, got ${got[i]}` });
      });
    } catch (e) {
      violations.push({ invariant: 'crash', detail: String(e?.message ?? e) });
    }
    return { violations };
  },
  judge(report) { return report.violations.map((v) => `[${v.invariant}] ${v.detail}`); },
};
