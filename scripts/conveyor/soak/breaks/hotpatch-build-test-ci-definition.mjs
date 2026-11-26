/** PR #7525: green CI must not admit changes to the full-build checks themselves. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { admitHotpatch } from '../../../lib/hotpatch-guards.mjs';
import { HP_SHA, hotpatchFixture } from '../../../lib/__tests__/fixtures/hotpatch.mjs';

const source = 'scripts/lib/hotpatch-guards.mjs';
const buildTests = ['tests/build/site-asset-size.test.mjs', 'tests/build/future-build-check.test.mjs'];

export default {
  id: 'hotpatch-build-test-ci-definition',
  title: 'hotpatch admission refuses full-build test changes even with green CI and an own-sha audit',
  card: 'PR #7525',
  fixedBy: { sha: '6c6dc6181d7', where: 'lane/main-fix-backlog-page-size', paths: [source] },
  fixPresent(root) {
    // Probe behavior independently of run/judge; never gate expected-failure on the scenario verdict.
    const code = `const { ciDefinitionGuard } = await import(${JSON.stringify(pathToFileURL(join(root, source)).href)});
      const results = await Promise.all(${JSON.stringify(buildTests)}.map(path =>
        ciDefinitionGuard('a'.repeat(40), { paths: () => [path] })));
      process.stdout.write(JSON.stringify(results));`;
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024,
    });
    try {
      const results = JSON.parse(probe.stdout);
      return probe.status === 0 && results.length === buildTests.length
        && results.every(r => r.outcome === 'fail' && r.detail === 'hotpatch-ci-definition-change');
    } catch { return false; }
  },
  async run() {
    const { data, readers } = hotpatchFixture();
    const violations = [];
    const check = async (label, outcome, detail) => {
      const decision = await admitHotpatch(HP_SHA, readers);
      if (decision.outcome !== outcome || decision.detail !== detail) {
        violations.push(`${label}: ${decision.outcome}/${decision.detail}`);
      }
      if (outcome !== 'pass' && !decision.fallback?.includes('normal merge path')) {
        violations.push(`${label}: missing operator fallback`);
      }
    };
    // A passing control proves refusal below comes from the changed paths, not incomplete receipts.
    data.paths = ['src/backlog.njk', 'docs/agent/testing/backlog-tile-chunks.md'];
    await check('application and docs', 'pass', 'hotpatch-admitted');
    for (const path of buildTests) {
      data.paths = [path];
      await check(path, 'fail', 'hotpatch-ci-definition-change');
    }
    readers.paths = () => { throw new Error('snapshot temporarily unreadable'); };
    await check('unreadable paths', 'unknown', 'hotpatch-evidence-unreadable');
    readers.paths = () => buildTests;
    await check('retry after path read recovers', 'fail', 'hotpatch-ci-definition-change');
    data.paths = ['tests/buildish/application.test.mjs'];
    readers.paths = () => data.paths;
    await check('adjacent application directory', 'pass', 'hotpatch-admitted');
    return { violations };
  },
  judge(report) { return report.violations; },
};
