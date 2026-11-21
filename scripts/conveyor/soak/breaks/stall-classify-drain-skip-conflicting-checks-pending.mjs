/** drain-skip:conflicting and drain-skip:checks-pending fell through to "fail-closed: unknown waiting state" NEEDS-YOU. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SOURCE = 'scripts/conveyor/pr-stall-classify.mjs';
const REPOS = 'scripts/lib/constellation-repos.mjs';
const HEAD = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';

/** Classify one waiting row with the classifier under `root`; returns the action or null. */
async function classifyAt(root, state, actor) {
  const { classifyStall } = await import(pathToFileURL(resolve(root, SOURCE)).href);
  const { CONSTELLATION_REPOS } = await import(pathToFileURL(resolve(root, REPOS)).href);
  return classifyStall({ head: HEAD, files: ['scripts/foo.mjs'], row: {
    repo: CONSTELLATION_REPOS.we.slug, number: 77, waitingOn: state, actor, stalled: true, liveJob: null,
    why: 'x', evidence: ['e1', 'e2', 'e3', 'e4'], next: { summary: 's', command: 'c' } } });
}

export default {
  id: 'stall-classify-drain-skip-conflicting-checks-pending',
  title: 'conflicting and checks-pending drain skips get a known owner; an unknown drain-skip kind still fails closed',
  card: 'stall classifier: unknown waiting state drain-skip:conflicting/checks-pending',
  fixedBy: { sha: '3e6843a539', where: 'stall classifier drain-skip owners', paths: [SOURCE] },
  // Synchronous (the harness reads a boolean): run the classifier in a child and read its verdict.
  fixPresent(root) {
    // The sweep first: loading the classifier alone hits an import cycle in a bare node process.
    const code = `await import(${JSON.stringify(pathToFileURL(resolve(root, 'scripts/conveyor/pr-stall-sweep.mjs')).href)});
const { classifyStall } = await import(${JSON.stringify(pathToFileURL(resolve(root, SOURCE)).href)});
const { CONSTELLATION_REPOS } = await import(${JSON.stringify(pathToFileURL(resolve(root, REPOS)).href)});
const r = classifyStall({ head: ${JSON.stringify(HEAD)}, files: ['scripts/foo.mjs'], row: { repo: CONSTELLATION_REPOS.we.slug, number: 77,
  waitingOn: 'drain-skip:conflicting', actor: 'fixer', stalled: true, liveJob: null, why: 'x', evidence: ['a', 'b', 'c', 'd'], next: { summary: 's', command: 'c' } } });
process.stdout.write(r && r.lane === 'system' ? 'yes' : 'no');`;
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    return out.status === 0 && out.stdout === 'yes';
  },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    try {
      for (const [state, actor] of [['drain-skip:conflicting', 'fixer'], ['drain-skip:checks-pending', 'ci']]) {
        const r = await classifyAt(sourceRoot, state, actor);
        if (!r || r.lane !== 'system' || /unknown waiting state/.test(r.reason ?? '')) violations.push(`[known-owner] ${state} must classify to its owner, got ${JSON.stringify(r)}`);
      }
      const unknown = await classifyAt(sourceRoot, 'drain-skip:future-kind', 'drain');
      if (!unknown || unknown.lane !== 'operator' || !/unknown waiting state/.test(unknown.reason ?? '')) violations.push('[fail-closed] an unknown drain-skip kind must still fail closed');
    } catch (error) { violations.push(error.message); }
    return { violations };
  },
  judge: report => report.violations,
};
