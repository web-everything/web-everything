/** PR #7188: daemon dispatch must carry a request's local policy into the gate child. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DISPATCH = 'scripts/conveyor/verify-dispatch.mjs';
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export default {
  id: 'verify-request-local-policy',
  title: 'verify request --local survives daemon dispatch and retry',
  card: 'PR #7188 post-accept red-team request-mode local policy loss',
  fixedBy: { sha: 'pending', where: 'lane/verify-local-flag', paths: [DISPATCH] },
  fixPresent(root) {
    return readFileSync(join(root, DISPATCH), 'utf8').includes("if (marker.local === true) args.push('--local');");
  },
  async run({ log, sourceRoot = process.env.SOAK_TREE_ROOT || ROOT } = {}) {
    const { runLaneGate } = await import(pathToFileURL(join(sourceRoot, DISPATCH)).href);
    const violations = [];
    const calls = [];
    for (const policy of [{ local: true }, { local: false }, {}]) {
      for (const suites of [undefined, "npx vitest run 'a test.mjs' b.test.mjs"]) {
        // A restarted/retried job uses the same shared entry point and persisted marker.
        for (const attempt of [1, 2]) {
          const marker = JSON.parse(JSON.stringify({
            status: 'running', sha: 'head', treeHash: 'uncached-tree',
            startedAt: '2026-11-20T16:38:35.000Z', suites, ...policy,
          }));
          const runId = `fixture-${attempt}`;
          const dir = join(sourceRoot, 'fixture lane');
          await runLaneGate({
            pool: 'fixture', lane: 1, dir, headSha: marker.sha, marker, runId,
            log: () => {}, logPath: 'unused',
            gateCeiling: { ms: 1000, mode: 'fixture', source: 'fixture', factor: 1 },
            spawnGate: async args => {
              calls.push(args);
              const expected = [join(sourceRoot, 'scripts/verify-lane.mjs'), `--repo=${dir}`,
                '--json', `--run-id=${runId}`,
                ...(suites ? [`--gate=${suites}`] : []), ...(policy.local === true ? ['--local'] : [])];
              if (JSON.stringify(args) !== JSON.stringify(expected)) {
                violations.push(`local=${String(policy.local)}, suites=${suites ? 'explicit' : 'default'}, attempt=${attempt}: child argv lost request policy or gate`);
              }
              return { pid: 123 };
            },
          });
        }
      }
    }
    if (calls.length !== 12) violations.push(`expected 12 gate launches, received ${calls.length}`);
    log?.(`checked ${calls.length} gate launches; ${violations.length} policy violations`);
    return { violations, launches: calls.length };
  },
  judge(report) { return report.violations; },
};
