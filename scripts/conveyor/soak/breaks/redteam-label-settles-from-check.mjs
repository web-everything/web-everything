/** A clear red-team check on the head must settle a stale red-team:pending label; a break or unknown fact must not. */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SOURCE = 'scripts/lib/red-team-status-labels.mjs';
const head = 'a'.repeat(40);

// Run in a child so a missing export or a throw reads as "fix absent", never as a crash of the soak runner.
function plan(root, checkClear, comments = []) {
  const code = `
    try {
      const { planRedTeamStatusLabels } = await import(process.argv[1]);
      const out = planRedTeamStatusLabels({ repo: 'o/n', pr: 42, head: ${JSON.stringify(head)}, env: {}, labels: ['red-team:pending'],
        comments: JSON.parse(process.argv[2]), evidence: {}, checkClear: JSON.parse(process.argv[3]) });
      process.stdout.write(JSON.stringify(out));
    } catch { process.stdout.write('error'); }
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code, pathToFileURL(join(root, SOURCE)).href,
    JSON.stringify(comments), JSON.stringify(checkClear)], { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  try { return JSON.parse(r.stdout); } catch { return null; }
}

export default {
  id: 'redteam-label-settles-from-check',
  title: 'a clear head-bound red-team check swaps a stale pending label to clear',
  card: 'red-team label settle',
  fixedBy: { sha: 'HEAD', where: SOURCE, paths: [SOURCE] },
  // Presence is the new fact reader's export, independent of the behaviour judged in run() (else a regression flips to it.fails).
  fixPresent(root) {
    const code = `try { const m = await import(process.argv[1]); process.stdout.write(typeof m.readCheckClearFact === 'function' ? 'yes' : 'no'); } catch { process.stdout.write('no'); }`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code, pathToFileURL(join(root, SOURCE)).href],
      { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return !r.error && r.status === 0 && r.stdout === 'yes';
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const violations = [];
    const settled = plan(sourceRoot, true);
    log?.(`clear check plan: ${JSON.stringify(settled)}`);
    if (settled?.add !== 'red-team:clear') violations.push('a clear check left red-team:pending in place');
    // A negative probe must return a real plan: an import failure, throw or timeout (null) is itself a violation.
    const noFact = plan(sourceRoot, false);
    if (!noFact || typeof noFact !== 'object' || noFact.add === 'red-team:clear') violations.push('clear without a check fact (or unreadable probe)');
    const gate = { author: { login: 'web-everything' }, body: `<!-- we:red-team-gate pr=42 rev=${head} outcome=sent-back -->` };
    const found = { author: { login: 'web-everything' }, body: `<!-- we:red-team-advisory pr=42 rev=${head} -->\n1. [**confirmed**] (edge-case, broken) \`scripts/x.mjs:1\` — break` };
    const withBreak = plan(sourceRoot, true, [found, gate]);
    if (withBreak?.add !== 'red-team:blocked') violations.push('a clear check did not leave a recorded break blocked (or unreadable probe)');
    return { violations };
  },
  judge: report => report.violations,
};
