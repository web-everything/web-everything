/** Exercise live holds, successful publication, and successor reservation through the refresh machine. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const SOURCE = 'scripts/lib/mq-failure-refresh.mjs';
export async function probe(refreshMqFailureHead) {
  const head = 'a'.repeat(40), merged = 'b'.repeat(40), violations = [];
  const run = async (labels, recorded, holdAfterMerge = '') => {
    const calls = [];
    const io = {
      readHead: () => head, readAuthorization: () => ({ labels, state: 'OPEN', isDraft: false }),
      createCheckout: () => ({ cwd: 'fixture/x', branch: 'lane/x' }),
      git: ({ args }) => { calls.push(args[0]); if (args[0] === 'merge' && holdAfterMerge) labels = [{ name: holdAfterMerge }]; return args[0] === 'merge' ? { ok: true, head: merged } : { ok: true }; },
      removeCheckout: () => {},
    };
    const ledger = {
      claim: () => { calls.push('claim'); return { claimed: true }; },
      recordRefresh: () => ({ recorded }),
      recordFixFallback: () => ({ recorded: true }), readRefreshSuccessor: () => false,
    };
    const result = await refreshMqFailureHead({ repo: 'o/r', pr: 1, head, ledger, io }); calls.result = result?.action; return calls;
  };
  const control = await run([], true);
  if (!control.includes('push') || control.result !== 'refreshed') violations.push('authorized control never pushed or did not report refreshed');
  for (const label of ['review:human', 'red-team:blocked', 'red-team:pending', 'review:held-mechanical']) {
    const late = await run([], true, label);
    if (late.includes('push') || late.result !== 'stop') violations.push(`${label} added after merge was not a stop without push`);
    const held = await run([{ name: label }], true);
    if (held.includes('claim') || held.includes('push') || held.result !== 'stop') violations.push(`a ${label} PR was claimed, pushed or not stopped`);
  }
  const unconfirmed = await run([], false);
  if (unconfirmed.includes('push') || unconfirmed.result === 'refreshed') violations.push('push happened without a confirmed successor reservation');
  return violations;
}
export default {
  id: 'mq-refresh-live-hold', title: 'an MQ refresh honors live human holds and the successor reservation',
  card: 'FIX-HOLD-LIVE-READS',
  fixedBy: { sha: '0a661c4be4ecceaa848f54f3af95714e4d485ee7', where: 'lane/fix-hold-live-reads', paths: [SOURCE] },
  fixPresent(root) {
    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { pathToFileURL } from 'node:url';
        const { refreshMqFailureHead } = await import(pathToFileURL(process.argv[1]).href);
        process.stdout.write(JSON.stringify(await (${probe.toString()})(refreshMqFailureHead)));
      `, resolve(root, SOURCE)], { encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      const violations = JSON.parse(output);
      return Array.isArray(violations) && violations.length === 0;
    } catch { return false; }
  },
  async run({ log } = {}) {
    const { refreshMqFailureHead } = await import('../../../lib/mq-failure-refresh.mjs');
    const violations = await probe(refreshMqFailureHead); log?.(`mq refresh live hold: ${violations.length} violation(s)`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
