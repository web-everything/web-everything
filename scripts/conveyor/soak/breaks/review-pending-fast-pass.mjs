import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runFastPass } from '../../../lib/review-fast-pass.mjs';

const source = 'scripts/lib/review-fast-pass.mjs';
async function exercise(run) {
  const head = 'a'.repeat(40), calls = [];
  const pr = { number: 1, headRefOid: head, state: 'OPEN', labels: ['review:pending'], statusCheckRollup: [], comments: [] };
  const options = { repo: 'fixture/repo', readLastPlan: () => ({ plan: { dispatch: [] }, rawPrs: [], savedAt: 1, mainSha: 'main' }),
    readPr: ({ pending }) => pending ? [pr] : pr, readAgents: () => [], readJobs: () => [],
    planOne: () => ({ dispatch: [{ kind: 'review', prNumber: 1 }] }), mainSha: () => 'main', liveCap: () => 1,
    hostAdmission: () => ({ admitted: true, maxPerTick: 1 }), dispatch: o => { calls.push(o); return { jobPid: 5 }; } };
  await run(options);
  options.readJobs = () => [{ repo: 'fixture/repo', pr: 1 }];
  await run(options);
  return { violations: calls.length === 1 && calls[0].expectedHead === head ? [] : ['pending PR not dispatched once with head binding'] };
}
export default {
  id: 'review-pending-fast-pass', title: 'new pending PR dispatches without waiting for the full tick', card: 'REVIEW-SPEED-FAST',
  fixedBy: { sha: 'HEAD', where: source, paths: [source] },
  fixPresent(root) {
    const code = `const {runFastPass}=await import(${JSON.stringify(pathToFileURL(join(root, source)).href)});
      process.stdout.write(JSON.stringify(await (${exercise.toString()})(runFastPass)));`;
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 20000, maxBuffer: 65536 });
    try { return probe.status === 0 && JSON.parse(probe.stdout).violations.length === 0; } catch { return false; }
  },
  run: () => exercise(runFastPass), judge: report => report.violations,
};
