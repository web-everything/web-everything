/**
 * @file operator-queue-needs-your-merge.test.mjs — card 334: an approved PR that touches a workflow or action file
 *   passes every gate but the person-only enqueue, so NEEDS YOU shows it with the one `land-human-only` command
 *   (live: #5298, #5187, #5260 sat approved and silent).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:child_process', async (original) => ({ ...await original(), execFileSync: vi.fn() }));
vi.mock('../../lib/gh-throttle.mjs', async (original) => ({
  ...await original(), execFileSyncThrottled: (...args) => execFileSync(...args),
}));
import { execFileSync } from 'node:child_process';
import { evaluateNeedsYourMerge, needsYourMergeCommand, needsYourMergePrecheck, main } from '../operator-queue.mjs';

const REPO = 'web-everything/web-everything';
const HEAD = 'c'.repeat(40);
const green = (name) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' });
const pr = (over = {}) => ({ number: 5298, title: 'fix red main: CI caps', headRefOid: HEAD, mergeable: 'MERGEABLE', isDraft: false,
  labels: ['ready-to-merge', 'review:accepted'].map((name) => ({ name })), comments: [],
  statusCheckRollup: [green('test'), green('merge-gate'), { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' }], ...over });
const WF = [{ filename: '.github/workflows/ci.yml' }, { filename: 'scripts/x.mjs' }];
const COMMAND = `node scripts/operations/run.mjs land-human-only --pr=5298 --repo=${REPO} --actor=<your login> --channel=<where you said it> --reason='<your words>'`;

beforeEach(() => { execFileSync.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('needs your merge — evaluation', () => {
  it('an approved, green, mergeable PR touching a workflow file is owed', () => {
    expect(evaluateNeedsYourMerge(pr(), { files: WF, changedFiles: 2 })).toEqual({ owed: true, paths: ['.github/workflows/ci.yml'], reasons: [] });
    expect(evaluateNeedsYourMerge(pr(), { files: [{ path: '.github/actions/x/action.yml' }], changedFiles: 1 }).owed).toBe(true);
  });
  it('a rename out of a workflow path counts', () => {
    expect(evaluateNeedsYourMerge(pr(), { files: [{ filename: 'docs/ci.yml', previous_filename: '.github/workflows/ci.yml' }], changedFiles: 1 }).owed).toBe(true);
  });
  it('a PR touching no gate path is the drain\'s, not yours', () => {
    expect(evaluateNeedsYourMerge(pr(), { files: [{ filename: 'scripts/x.mjs' }], changedFiles: 1 })).toMatchObject({ owed: false });
  });
  it('an incomplete file list is never owed', () => {
    expect(evaluateNeedsYourMerge(pr(), { files: WF.slice(0, 1), changedFiles: 112 })).toMatchObject({ owed: false });
  });
  it.each([
    ['draft', { isDraft: true }], ['not accepted', { labels: [{ name: 'ready-to-merge' }] }],
    ['review:human', { labels: [{ name: 'review:accepted' }, { name: 'review:human' }] }],
    ['review:changes', { labels: [{ name: 'review:accepted' }, { name: 'review:changes' }] }],
    ['conflicting', { mergeable: 'CONFLICTING' }], ['unknown mergeability', { mergeable: 'UNKNOWN' }],
    ['a pending check', { statusCheckRollup: [{ name: 'test', status: 'IN_PROGRESS' }] }],
    ['a red check', { statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] }],
    ['no checks', { statusCheckRollup: [] }],
  ])('is not a candidate when %s', (_name, over) => {
    expect(needsYourMergePrecheck(pr(over)).length).toBeGreaterThan(0);
    expect(evaluateNeedsYourMerge(pr(over), { files: WF, changedFiles: 2 }).owed).toBe(false);
  });
  it('the command is the land-human-only operation', () => {
    expect(needsYourMergeCommand({ repo: REPO, number: 5298 })).toBe(COMMAND);
  });
});

const run = (args = [], listing = [pr()], files = WF) => {
  execFileSync.mockImplementation((cmd, argv) => {
    const a = argv.join(' ');
    if (a.startsWith('pr list')) return JSON.stringify(listing);
    if (a.startsWith('pr view') && a.includes('changedFiles')) return JSON.stringify({ changedFiles: files.length });
    if (a.startsWith('api --paginate --slurp')) return JSON.stringify([files]);
    throw new Error(`unexpected ${cmd} ${a}`);
  });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  main([`--repo=${REPO}`, ...args], { unsupportedPath: '/nonexistent-operator-queue-test/unsupported-repo.json' });
  return log.mock.calls.map(([line]) => line).join('\n');
};

describe('needs your merge — under NEEDS YOU', () => {
  it('prints the row with the one command, and NEEDS YOU is not "(none)"', () => {
    const out = run();
    const section = out.slice(out.indexOf('NEEDS YOU'), out.indexOf('RULING NEEDED'));
    expect(section).toContain(`${REPO}#5298  fix red main: CI caps — needs your merge: approved, all gates green, touches .github/workflows/ci.yml (only a person may enqueue)\n    merge: ${COMMAND}`);
    expect(section).not.toContain('(none)');
    expect(out.slice(out.indexOf('RULING NEEDED'))).toContain('(none)');
  });
  it('carries the row in JSON', () => {
    const report = JSON.parse(run(['--json']));
    expect(report.needsYourMerge).toEqual([{ repo: REPO, number: 5298, title: 'fix red main: CI caps', paths: ['.github/workflows/ci.yml'], command: COMMAND }]);
  });
  it('reads files only for a PR that passes the cheap precheck', () => {
    run(['--json'], [pr({ mergeable: 'CONFLICTING' })]);
    expect(execFileSync.mock.calls.map(([, argv]) => argv.slice(0, 2).join(' '))).toEqual(['pr list']);
  });
  it('a PR touching no workflow file gets no row', () => {
    expect(JSON.parse(run(['--json'], [pr()], [{ filename: 'scripts/x.mjs' }])).needsYourMerge).toBeUndefined();
  });
});
