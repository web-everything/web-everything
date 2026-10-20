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
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluatePr, evaluateCeremonyOwed, evaluateNeedsYourMerge, needsYourMergeCommand, needsYourMergePrecheck, main } from '../operator-queue.mjs';

const REPO = 'web-everything/web-everything';
const HEAD = 'c'.repeat(40);
const green = (name) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' });
const pr = (over = {}) => ({ number: 5298, title: 'fix red main: CI caps', headRefOid: HEAD, mergeable: 'MERGEABLE', isDraft: false,
  labels: ['ready-to-merge', 'review:accepted'].map((name) => ({ name })), comments: [],
  statusCheckRollup: [green('test'), green('merge-gate'), { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' }], ...over });
const WF = [{ filename: '.github/workflows/ci.yml' }, { filename: 'scripts/x.mjs' }];
const COMMAND = `git pull --ff-only origin main && node scripts/run-fresh.mjs land-human-only --pr=5298 --repo=${REPO} --actor=<your login> --channel=<where you said it> --reason='<your words>'`;

const originalExitCode = process.exitCode;
beforeEach(() => { execFileSync.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); process.exitCode = originalExitCode; });

describe('needs your merge — evaluation', () => {
  it('accepts successful StatusContext checks alongside CheckRun checks', () => {
    expect(needsYourMergePrecheck(pr({ statusCheckRollup: [green('test'), { context: 'legacy', state: 'SUCCESS' }] }))).toEqual([]);
  });
  it('also accepts successful StatusContext checks in the human-review and ceremony paths', () => {
    const candidate = pr({ statusCheckRollup: [green('test'), { context: 'legacy', state: 'SUCCESS' }] });
    expect(evaluatePr(candidate).reasons.some((reason) => reason.startsWith('CI '))).toBe(false);
    candidate.statusCheckRollup.push({ name: 'merge-gate', status: 'COMPLETED', conclusion: 'FAILURE' });
    expect(evaluateCeremonyOwed(candidate).needsMergeGateVerdict).toBe(true);
  });
  it.each(['PENDING', 'FAILURE', 'ERROR', undefined])('refuses a %s StatusContext alongside CheckRun checks', (state) => {
    expect(needsYourMergePrecheck(pr({ statusCheckRollup: [green('test'), { context: 'legacy', state }] }))).toContain('checks not all green');
  });
  it('does not need another merge when already queued', () => {
    expect(evaluateNeedsYourMerge(pr({ isInMergeQueue: true }), { files: WF, changedFiles: 2 }).owed).toBe(false);
  });
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
  it.each([0, 1])('bootstraps a checkout missing the launcher, stopping if update fails (status %s)', (updateStatus) => {
    const dir = mkdtempSync(join(tmpdir(), 'merge-bootstrap-'));
    try {
      mkdirSync(join(dir, 'bin'));
      // Simulate the update without network access or git writes. The launcher is initially absent.
      writeFileSync(join(dir, 'bin', 'git'), `#!/bin/sh
test "$*" = 'pull --ff-only origin main' || exit 90
echo UPDATE_ATTEMPTED
${updateStatus ? 'exit 1' : `mkdir -p scripts
echo 'console.log("FRESH_LAUNCHER", JSON.stringify(process.argv.slice(2)))' > scripts/run-fresh.mjs`}
`, { mode: 0o755 });
      const command = needsYourMergeCommand({ repo: REPO, number: 5298 })
        .replace('<your login>', 'operator')
        .replace('<where you said it>', 'terminal')
        .replace('<your words>', 'approved in person');
      const result = spawnSync('/bin/sh', ['-c', command], {
        cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
      });
      expect(result.stdout, result.stderr).toContain('UPDATE_ATTEMPTED');
      expect(result.status).toBe(updateStatus);
      expect(result.stderr).not.toContain('MODULE_NOT_FOUND');
      if (updateStatus === 0) {
        expect(result.stdout).toContain('FRESH_LAUNCHER');
        expect(result.stdout).toContain('"land-human-only","--pr=5298"');
        expect(result.stdout).toContain('"--reason=approved in person"');
      } else {
        expect(result.stdout).not.toContain('FRESH_LAUNCHER');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const run = (args = [], listing = [pr()], files = WF, queue = { isInMergeQueue: false, headRefOid: HEAD }) => {
  execFileSync.mockImplementation((cmd, argv) => {
    const a = argv.join(' ');
    if (a.startsWith('pr list')) return JSON.stringify(listing);
    if (a.startsWith('pr view') && a.includes('changedFiles')) return JSON.stringify({ changedFiles: files.length });
    if (a.startsWith('api --paginate --slurp')) return JSON.stringify([files]);
    if (a.startsWith('api graphql')) return JSON.stringify({ data: { repository: { pullRequest: queue } } });
    throw new Error(`unexpected ${cmd} ${a}`);
  });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  main([`--repo=${REPO}`, ...args], { unsupportedPath: '/nonexistent-operator-queue-test/unsupported-repo.json' });
  return log.mock.calls.map(([line]) => line).join('\n');
};

describe('needs your merge — under NEEDS YOU', () => {
  it('omits a ready-to-merge PR already in the queue', () => {
    const report = JSON.parse(run(['--json'], [pr()], WF, { isInMergeQueue: true, headRefOid: HEAD }));
    expect(report.needsYourMerge).toBeUndefined();
    expect(execFileSync.mock.calls.some(([, args]) => args.join(' ').includes('isInMergeQueue'))).toBe(true);
  });
  it.each([null, {}, { isInMergeQueue: false, headRefOid: 'd'.repeat(40) }])('reports unknown or stale queue state instead of a merge command (%j)', (queue) => {
    const report = JSON.parse(run(['--json'], [pr()], WF, queue));
    expect(report.needsYourMerge).toBeUndefined();
    expect(report.errors.length).toBeGreaterThan(0);
  });
  it('prints the merge command with successful legacy status checks', () => {
    expect(run([], [pr({ statusCheckRollup: [green('test'), { context: 'legacy', state: 'SUCCESS' }] })])).toContain(COMMAND);
  });
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
