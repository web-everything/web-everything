/** drain-skip:conflicting and drain-skip:checks-pending fell through to "fail-closed: unknown waiting state" NEEDS-YOU. */
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SOURCE = 'scripts/conveyor/pr-stall-classify.mjs';
const HEAD = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';

const classify = (classifyStall, state, actor) => classifyStall({ head: HEAD, files: ['scripts/foo.mjs'], row: {
  repo: 'example/repo', number: 77, waitingOn: state, actor, stalled: true, liveJob: null,
  why: 'x', evidence: ['e1', 'e2', 'e3', 'e4'], next: { summary: 's', command: 'c' } } });

export default {
  id: 'stall-classify-drain-skip-conflicting-checks-pending',
  title: 'conflicting and checks-pending drain skips get a known owner; an unknown drain-skip kind still fails closed',
  card: 'stall classifier: unknown waiting state drain-skip:conflicting/checks-pending',
  fixedBy: { sha: '3e6843a539', where: 'stall classifier drain-skip owners', paths: [SOURCE] },
  async fixPresent(root) {
    const { classifyStall } = await import(pathToFileURL(resolve(root, SOURCE)).href);
    return !/unknown waiting state/.test(classify(classifyStall, 'drain-skip:conflicting', 'fixer')?.reason ?? '');
  },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    try {
      const { classifyStall } = await import(pathToFileURL(resolve(sourceRoot, SOURCE)).href);
      const at = (state, actor) => classify(classifyStall, state, actor);
      for (const [state, actor] of [['drain-skip:conflicting', 'fixer'], ['drain-skip:checks-pending', 'ci']]) {
        const r = at(state, actor);
        if (!r || r.lane !== 'system' || /unknown waiting state/.test(r.reason ?? '')) violations.push(`[known-owner] ${state} must classify to its owner, got ${JSON.stringify(r)}`);
      }
      const unknown = at('drain-skip:future-kind', 'drain');
      if (!unknown || unknown.lane !== 'operator' || !/unknown waiting state/.test(unknown.reason ?? '')) violations.push('[fail-closed] an unknown drain-skip kind must still fail closed');
    } catch (error) { violations.push(error.message); }
    return { violations };
  },
  judge: report => report.violations,
};
