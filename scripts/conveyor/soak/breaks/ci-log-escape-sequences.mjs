/** Replay gh's refusal of escape-coded raw job logs in timeout evidence collection. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MODES = ['plain', 'facts-off', 'facts-on'];

export async function collect(sourceRoot, { mode, stripFlag = false } = {}) {
  const { readTimeoutEvidence } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/reconcile-pass.mjs')));
  const { makeFixEvidenceReader } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/fix-facts.mjs')));
  const repo = 'example-org/example-repo', head = 'a'.repeat(40), prefix = `repos/${repo}`;
  const job = { id: 20, run_id: 10, head_sha: head, run_attempt: 1,
    status: 'completed', conclusion: 'failure', name: 'test' };
  const data = {
    [`${prefix}/pulls/42`]: { state: 'open', head: { sha: head }, base: { sha: 'b'.repeat(40) }, changed_files: 1 },
    [`${prefix}/pulls/42/files?per_page=100&page=1`]: [{ filename: 'backlog/example.md' }],
    [`${prefix}/commits/${head}/check-runs?per_page=100&page=1&filter=latest`]: { total_count: 1,
      check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure',
        details_url: `https://github.com/${repo}/actions/runs/10/job/20` }] },
    [`${prefix}/commits/${head}/status`]: { total_count: 0 },
    [`${prefix}/actions/jobs/20`]: job,
    [`${prefix}/actions/runs/10`]: { id: 10, head_sha: head, run_attempt: 1, repository: { full_name: repo } },
  };
  const json = path => {
    if (!Object.hasOwn(data, path)) throw new Error(`unexpected endpoint: ${path}`);
    return data[path];
  };
  let logReads = 0, rejected = 0;
  const exec = (command, args) => {
    if (command !== 'gh' || args[0] !== 'api') throw new Error('unexpected command');
    const path = args.at(-1);
    if (path === `${prefix}/actions/jobs/20/logs`) {
      logReads++;
      const effective = stripFlag ? args.filter(arg => arg !== '--allow-escape-sequences') : args;
      if (!effective.includes('--allow-escape-sequences')) {
        rejected++;
        throw new Error('gh: response contains escape sequences; use --allow-escape-sequences');
      }
      // Readable transport still must fail closed on unattributed whole-job evidence.
      return '\x1b[31mFAIL unrelated assertion\x1b[0m\n';
    }
    return JSON.stringify(json(path));
  };
  const cacheDir = mkdtempSync(join(tmpdir(), 'ci-log-escape-sequences-'));
  try {
    const reader = mode === 'plain' ? undefined : makeFixEvidenceReader({ repo, pr: 42, head, exec,
      deadline: Date.now() + 15_000, cacheDir, env: { WE_FIX_FACTS: mode === 'facts-on' ? '1' : '0' },
      rest: path => ({ json: json(path) }) });
    const evidence = readTimeoutEvidence({ number: 42, headRefOid: head }, { repo, exec, reader,
      facts: () => ({ stale: false }), sleep: () => { throw new Error('unexpected retry'); } });
    return { mode, stripFlag, logReads, rejected, evidence };
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

export default {
  id: 'ci-log-escape-sequences',
  title: 'timeout evidence raw job-log reads allow escape sequences',
  card: 'timeout-evidence raw job-log transport',
  fixedBy: { sha: 'HEAD', where: 'ciJobLogApiArgs in timeout evidence readers',
    paths: ['scripts/conveyor/reconcile-pass.mjs', 'scripts/lib/fix-facts.mjs'] },
  fixPresent(root) {
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const { collect } = await import(process.argv[1]);
       for (const mode of ${JSON.stringify(MODES)}) {
         const r = await collect(process.argv[2], { mode });
         if (r.logReads !== 1 || r.rejected !== 0 || r.evidence.eligible !== false
           || r.evidence.reason !== 'timeout-evidence:unattributed-job-log') process.exit(1);
       }`, import.meta.url, root], { encoding: 'utf8', timeout: 15_000, maxBuffer: 65_536 });
    return !probe.error && probe.status === 0;
  },
  async run({ sourceRoot = process.env.SOAK_TREE_ROOT || ROOT } = {}) {
    const cases = [];
    for (const mode of MODES) {
      for (const stripFlag of [true, false]) cases.push(await collect(sourceRoot, { mode, stripFlag }));
    }
    return { cases };
  },
  judge({ cases = [] } = {}) {
    const violations = [];
    for (const mode of MODES) {
      for (const stripFlag of [true, false]) {
        const rows = cases.filter(c => c.mode === mode && c.stripFlag === stripFlag);
        const c = rows[0], reason = stripFlag ? 'log-unreadable' : 'timeout-evidence:unattributed-job-log';
        if (rows.length !== 1 || c.logReads !== 1 || c.rejected !== Number(stripFlag)
          || c.evidence?.eligible !== false || c.evidence?.unknown || c.evidence?.reason !== reason) {
          violations.push(`${mode} stripFlag=${stripFlag}: expected one raw log read and ${reason}; got ${JSON.stringify(rows)}`);
        }
      }
    }
    return violations;
  },
};
