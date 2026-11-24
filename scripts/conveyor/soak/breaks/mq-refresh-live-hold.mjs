/** Exercise live holds, successful publication, and successor reservation through the refresh machine. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const SOURCE = 'scripts/lib/mq-failure-refresh.mjs';
export async function probe(refreshMqFailureHead) {
  const head = 'a'.repeat(40), merged = 'b'.repeat(40), violations = [];
  const run = async (labels, recorded, holdAfterMerge = false) => {
    const calls = [];
    const io = {
      readHead: () => head, readAuthorization: () => ({ labels, state: 'OPEN', isDraft: false }),
      createCheckout: () => ({ cwd: 'fixture/x', branch: 'lane/x' }),
      git: ({ args }) => { calls.push(args[0]); if (args[0] === 'merge' && holdAfterMerge) labels = ['review:human']; return args[0] === 'merge' ? { ok: true, head: merged } : { ok: true }; },
      removeCheckout: () => {},
    };
    const ledger = {
      claim: () => { calls.push('claim'); return { claimed: true }; },
      recordRefresh: () => ({ recorded }),
      recordFixFallback: () => ({ recorded: true }), readRefreshSuccessor: () => false,
    };
    await refreshMqFailureHead({ repo: 'o/r', pr: 1, head, ledger, io }); return calls;
  };
  if (!(await run([], true)).includes('push')) violations.push('authorized control never pushed');
  if ((await run([], true, true)).includes('push')) violations.push('hold added after merge did not block push');
  const held = await run([{ name: 'review:human' }], true);
  if (held.includes('claim') || held.includes('push')) violations.push('a review:human PR was claimed or pushed');
  const unconfirmed = await run([], false);
  if (unconfirmed.includes('push')) violations.push('push happened without a confirmed successor reservation');
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
