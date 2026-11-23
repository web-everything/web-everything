/**
 * DRAIN-LOG-ESCAPE: gh refuses job logs containing terminal escapes unless explicitly allowed.
 * Probe the production recovery reader with coloured infra evidence, not source markers.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const SOURCE = 'scripts/lib/drain-mq-failure-recovery-io.mjs';

async function probe(createDrainMqFailureRecoveryIo, positiveOnly = false) {
  const removal = { repo: 'fixture/drain', pr: 42, head: 'a'.repeat(40), mergeGroupHead: 'b'.repeat(40) };
  const plain = 'The runner has lost communication with the server.';
  const read = async (baseline = false, empty = false) => {
    let logReads = 0;
    const exec = (file, args) => {
      if (file !== 'gh' || args[0] !== 'api') throw new Error('unexpected IO');
      const endpoint = args[1];
      if (endpoint.includes('/actions/runs?')) return JSON.stringify({ total_count: 1, workflow_runs: [{
        id: 701, event: 'merge_group', head_sha: removal.mergeGroupHead, conclusion: 'failure',
        head_branch: `gh-readonly-queue/main/pr-42-${'c'.repeat(40)}`,
      }] });
      if (endpoint.includes('/compare/')) return JSON.stringify({ status: 'ahead', behind_by: 0 });
      if (endpoint.includes('/actions/runs/701/jobs?')) return JSON.stringify({ total_count: 1,
        jobs: [{ id: 901, name: 'unit', status: 'completed', conclusion: 'failure' }] });
      if (endpoint.endsWith('/actions/jobs/901/logs')) {
        logReads++;
        // Model the old caller by dropping the opt-in before the gh-like executor sees it.
        const received = baseline ? args.filter(arg => arg !== '--allow-escape-sequences') : args;
        if (!received.includes('--allow-escape-sequences')) throw new Error('unreadable escape-containing log');
        if (empty) return undefined;
        return '\x1b[31mThe runner has lost \x1b]0;hidden title\x07communication with the server.\x1b[0m\n';
      }
      throw new Error('unexpected API read');
    };
    const evidence = await createDrainMqFailureRecoveryIo({ exec, ledger: {} }).collectEvidence({ removal });
    return { evidence, logReads };
  };
  const violations = [];
  const fixed = await read();
  if (fixed.logReads !== 1 || !fixed.evidence.complete || fixed.evidence.assertions.length !== 1
    || fixed.evidence.assertions[0] !== plain) violations.push('escaped infra log was unreadable or did not match clean evidence');
  if (positiveOnly) return violations;
  for (const [name, result] of [['baseline without flag', await read(true)], ['empty log', await read(false, true)]]) {
    if (result.logReads !== 1 || result.evidence.complete || result.evidence.assertions.length)
      violations.push(`${name} did not fail closed as unreadable evidence`);
  }
  return violations;
}

export default {
  id: 'mq-log-escape-sequences-readable',
  title: 'escape-containing MQ job logs remain readable and match infrastructure evidence',
  card: 'DRAIN-LOG-ESCAPE',
  fixedBy: { sha: 'pending', where: 'DRAIN-LOG-ESCAPE', paths: [SOURCE, 'scripts/lib/drain-queue-safety.mjs'] },
  fixPresent(root) {
    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { pathToFileURL } from 'node:url';
        const { createDrainMqFailureRecoveryIo } = await import(pathToFileURL(process.argv[1]).href);
        process.stdout.write(JSON.stringify(await (${probe.toString()})(createDrainMqFailureRecoveryIo, true)));
      `, resolve(root, SOURCE)], { encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      const violations = JSON.parse(output);
      return Array.isArray(violations) && violations.length === 0;
    } catch { return false; }
  },
  async run({ log } = {}) {
    const { createDrainMqFailureRecoveryIo } = await import('../../../lib/drain-mq-failure-recovery-io.mjs');
    const violations = await probe(createDrainMqFailureRecoveryIo);
    log?.(`mq escaped job log: ${violations.length} violation(s)`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
