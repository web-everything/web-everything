/**
 * Live 2026-11-19: gh 2.104 refuses `gh api .../logs` when the log carries terminal escapes unless given
 * --allow-escape-sequences. readMergeGateVerdict swallowed that error, so no merge-gate row was ever annotated
 * as a review hold; review-pending PRs with only review-gate/merge-gate red read as a real CI red and sat behind
 * a ci-heal escalation. Fix presence is decided by behaviour: a gh stand-in that refuses the log read without
 * the flag must still yield a readable verdict.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SOURCE = 'scripts/lib/merge-gate-hold-class.mjs';

export async function probe(sourceRoot) {
  const { readMergeGateVerdict } = await import(pathToFileURL(join(sourceRoot, SOURCE)).href);
  const runGh = args => {
    if (String(args.at(-1)).endsWith('/logs')) {
      if (!args.includes('--allow-escape-sequences')) {
        throw new Error('the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway');
      }
      return '2026-11-19T00:00:00Z \u001b[31mmerge gate\u001b[0m\n';
    }
    return JSON.stringify({ head_sha: 'a'.repeat(40), completed_at: '2026-11-19T00:00:00Z' });
  };
  return readMergeGateVerdict({ repo: 'o/r', jobId: 1, prNumber: 7100, runGh, cache: new Map() });
}

export const escapeRefused = verdict => /escape/i.test(String(verdict?.error ?? ''));

export default {
  id: 'merge-gate-verdict-log-escape-sequences',
  title: 'merge-gate verdict reads a job log that carries terminal escape sequences',
  card: 'review-pending PRs deadlocked behind ci-heal-escalated (merge-gate never annotated)',
  fixedBy: { sha: 'HEAD', where: 'merge-gate-verdict-log-escape-sequences', paths: [SOURCE] },
  fixPresent(root) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { probe, escapeRefused } from ${JSON.stringify(import.meta.url)};
       process.exitCode = escapeRefused(await probe(process.argv[1])) ? 1 : 0;`, root],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    return !result.error && result.status === 0;
  },
  run: async ({ sourceRoot = ROOT } = {}) => ({ verdict: await probe(sourceRoot) }),
  judge: report => escapeRefused(report.verdict)
    ? ['gh refused the merge-gate job log: terminal escape sequences were not allowed'] : [],
};
