/** Escape-coded MQ logs must reach every drain evidence reader, rather than looking unreadable. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PATHS = ['scripts/lib/drain-mq-failure-recovery-io.mjs', 'scripts/lib/drain-queue-safety.mjs'];

// Also used in a bounded child process: fix presence measures execution, never source markers.
export async function exerciseReaders(root, refuseReader = null) {
  const { pathToFileURL } = await import('node:url');
  const { resolve } = await import('node:path');
  const load = path => import(pathToFileURL(resolve(root, path)).href);
  const { createDrainMqFailureRecoveryIo } = await load('scripts/lib/drain-mq-failure-recovery-io.mjs');
  const { mqSameHeadGuard } = await load('scripts/lib/drain-queue-safety.mjs');
  const repo = 'fixture/drain', pr = 42, head = 'a'.repeat(40), merge = 'b'.repeat(40), prior = 'c'.repeat(40);
  const now = Date.parse('2026-11-21T12:00:00Z');
  const file = 'tests/widget.test.mjs';
  const failure = `\x1b[31m FAIL  ${file} > suite > case\x1b[0m\nAssertionError: expected true\n Test Files  1 failed\n Tests  1 failed\n##[error]Process completed with exit code 1.\n`;
  const removed = { __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks',
    createdAt: '2026-11-21T11:00:00Z', beforeCommit: { oid: merge, parents: { nodes: [{ oid: prior }, { oid: head }] } } };
  const violations = [], readers = {};
  for (const reader of ['recovery', 'same-head', 'quarantine', 'freeze', 'exact-test']) {
    const reads = [], accepted = [], unexpected = [];
    const name = reader === 'freeze' ? 'merge-gate' : 'test-shard (1)';
    const check = { id: 31, name, status: 'completed', conclusion: 'failure',
      output: { title: '', summary: '' }, details_url: `https://github.com/${repo}/actions/runs/800/job/31` };
    // Let the base reader classify the summary without reading this log, so the exact-test
    // path must execute its own binary log read rather than replaying a cached base read.
    if (reader === 'exact-test') check.output.summary = 'The runner has lost communication with the server.';
    const events = reader === 'exact-test' ? [
      { ...removed, createdAt: '2026-11-21T10:00:00Z' },
      { __typename: 'AddedToMergeQueueEvent', createdAt: '2026-11-21T10:30:00Z' }, removed,
    ] : [removed];
    const exec = (command, args, opts) => {
      if (command === 'funzip') return String(opts.input);
      if (command !== 'gh') throw new Error(`unexpected command: ${command}`);
      const endpoint = args.find(arg => arg.startsWith(`repos/${repo}/`)) ?? '';
      const path = endpoint.split('?')[0];
      if (path.endsWith('/logs')) {
        reads.push({ command, args, encoding: opts.encoding });
        const argv = refuseReader === reader ? args.filter(arg => arg !== '--allow-escape-sequences') : args;
        if (!argv.includes('--allow-escape-sequences'))
          throw new Error('the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway');
        accepted.push(path);
        return reader === 'freeze' ? '\x1b[31m2026-11-21T10:59:00Z   hold              red-main-freeze        main is RED\x1b[0m' : failure;
      }
      if (args.some(arg => arg.includes('isInMergeQueue')))
        return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: false, headRefOid: head } } } });
      if (args.some(arg => arg.includes('timelineItems')))
        return JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { nodes: events, pageInfo: { hasPreviousPage: false } } } } } });
      if (args.includes('mergeStateStatus,headRefOid')) return JSON.stringify({ headRefOid: head, mergeStateStatus: 'CLEAN' });
      if (path.includes('/check-runs') && !path.endsWith('/31') && !path.endsWith('/annotations'))
        return JSON.stringify({ total_count: 1, check_runs: [check] });
      if (path.endsWith('/actions/jobs/31')) return JSON.stringify({ id: 31, name, head_sha: merge, run_id: 800,
        status: 'completed', conclusion: 'failure', steps: [
          { name: 'Unit suite shard 1/9 (coverage)', status: 'completed', conclusion: 'failure' },
        ] });
      if (path.endsWith('/actions/runs/800')) return JSON.stringify({ id: 800, path: '.github/workflows/ci.yml', event: 'merge_group', head_sha: merge });
      if (path.includes('/compare/')) return JSON.stringify({ status: 'ahead', behind_by: 0 });
      if (path.endsWith('/actions/runs')) return JSON.stringify({ total_count: 1, workflow_runs: [
        { id: 800, event: 'merge_group', head_sha: merge, head_branch: `gh-readonly-queue/main/pr-${pr}-${prior}`, conclusion: 'failure' },
      ] });
      if (path.endsWith('/actions/runs/800/jobs')) return JSON.stringify({ total_count: 1, jobs: [check] });
      if (path.endsWith('/actions/runs/800/artifacts')) return JSON.stringify({ total_count: 1, artifacts: [
        { id: 900, name: 'timing-unit-1', expired: false, workflow_run: { id: 800, head_sha: merge } },
      ] });
      if (path.endsWith('/actions/artifacts/900/zip')) return Buffer.from(JSON.stringify({
        numFailedTests: 1, numFailedTestSuites: 1, testResults: [{ name: file, status: 'failed', message: '',
          assertionResults: [{ title: 'case', ancestorTitles: ['suite'], status: 'failed' }] }],
      }));
      if (path.endsWith('/check-runs/31')) return JSON.stringify({ id: 31, output: { annotations_count: 1 } });
      if (path.endsWith('/check-runs/31/annotations')) return JSON.stringify([
        { annotation_level: 'failure', message: 'Process completed with exit code 1.' },
      ]);
      // Deliberately absent later evidence keeps retry authorization closed. These probes test transport.
      if (path.includes('/actions/workflows/') || path.endsWith('/git/ref/heads/main')) throw new Error('main evidence unavailable; operator inspection required');
      unexpected.push(args);
      throw new Error('unexpected fixture read');
    };
    let result;
    if (reader === 'recovery') {
      const io = createDrainMqFailureRecoveryIo({ exec, ledger: {} });
      result = await io.collectEvidence({ removal: { repo, pr, head, mergeGroupHead: merge } });
      if (result.complete !== true || !result.testFiles.includes(file)) violations.push('recovery: ANSI job evidence was not collected');
    } else {
      result = mqSameHeadGuard({ repo, pr, head, exec, now, dryRun: true, readFreeze: () => null,
        quarantine: { now: () => now, readList: () => reader !== 'quarantine' ? { ok: false } : {
          ok: true, list: { version: 1, mode: 'quarantine', entries: [{ test: `${file}::suite > case`,
            brokenSha: prior, owner: 'fixture', reason: 'fixture', addedAt: now - 1000, expiresAt: now + 3600000 }] },
        } } });
      if (reader === 'quarantine' && result.hold !== false) violations.push('quarantine: ANSI failure did not prove coverage');
      if (reader !== 'quarantine' && result.hold !== true) violations.push(`${reader}: incomplete evidence authorized a retry`);
    }
    if (!reads.length || accepted.length !== reads.length) violations.push(`${reader}: escape-coded log was not read successfully`);
    if (unexpected.length) violations.push(`${reader}: unexpected fixture reads: ${JSON.stringify(unexpected)}`);
    readers[reader] = { reads, accepted, result };
  }
  return { violations, readers };
}

export default {
  id: 'drain-mq-log-reader-escape-sequences',
  title: 'drain MQ evidence readers accept escape-coded job logs instead of reporting unreadable evidence',
  card: 'drain MQ log transport escape-sequence fix',
  fixedBy: { sha: 'pending', where: 'working tree', paths: PATHS },
  fixPresent(root) {
    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { pathToFileURL } from 'node:url';
        const { exerciseReaders } = await import(pathToFileURL(process.argv[2]).href);
        const report = await exerciseReaders(process.argv[1]);
        process.stdout.write(JSON.stringify(report.violations));
      `, resolve(root), fileURLToPath(import.meta.url)],
      { encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      const violations = JSON.parse(output);
      return Array.isArray(violations) && violations.length === 0;
    } catch { return false; }
  },
  run() { return exerciseReaders(process.env.SOAK_TREE_ROOT || ROOT); },
  judge(report) { return report?.violations ?? ['drain MQ reader probe returned incomplete evidence']; },
};
