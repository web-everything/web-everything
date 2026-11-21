/** PR #7188: daemon dispatch must carry a request's local policy into the gate child. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const DISPATCH = 'scripts/conveyor/verify-dispatch.mjs';
const JOBS = 'scripts/conveyor/verify-gate-job.mjs';
const DAEMON = 'skills-src/conveyor/verify-daemon.mjs';
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export default {
  id: 'verify-request-local-policy',
  title: 'verify request --local survives daemon dispatch, retry and supersession',
  card: 'PR #7188 post-accept red-team request-mode local policy loss',
  fixedBy: { sha: 'pending', where: 'lane/verify-local-flag', paths: [DISPATCH, JOBS, DAEMON] },
  fixPresent(root) {
    const source = readFileSync(join(root, DISPATCH), 'utf8');
    return source.includes("if (marker.local === true) args.push('--local');")
      && source.includes('(entry.local === true) === (marker.local === true)');
  },
  async run({ log, sourceRoot = process.env.SOAK_TREE_ROOT || ROOT } = {}) {
    const { runLaneGate, sameVerifyRequest, inFlightSuperseded, laneNeedsVerifyDispatch, countDispatchesInFlight } = await import(pathToFileURL(join(sourceRoot, DISPATCH)).href);
    const violations = [];
    const calls = [];
    const source = readFileSync(join(sourceRoot, DISPATCH), 'utf8');
    const sweepStart = source.indexOf('export async function runVerifyDispatch(');
    const sweepEnd = source.indexOf('\nasync function main(', sweepStart);
    if (sweepStart < 0 || sweepEnd < 0) throw new Error('verify dispatch sweep not found');
    // Run the real serializer bodies with inert IO ports, including the durable JSON boundary.
    const jobs = readFileSync(join(sourceRoot, JOBS), 'utf8');
    const entryStart = jobs.indexOf('  const entryFor =');
    const entryEnd = jobs.indexOf('  const consumedPath =', entryStart);
    const launchStart = jobs.indexOf('    launch({');
    const launchEnd = jobs.indexOf('    /**', launchStart);
    const daemon = readFileSync(join(sourceRoot, DAEMON), 'utf8');
    const handoffStart = daemon.indexOf('export function inFlightHandoff(');
    const handoffEnd = daemon.indexOf('export function writeInFlightHandoff(', handoffStart);
    if ([entryStart, entryEnd, launchStart, launchEnd, handoffStart, handoffEnd].some(index => index < 0)) {
      throw new Error('verify policy serializer not found');
    }
    const entryFor = runInNewContext(`${jobs.slice(entryStart, entryEnd)}; entryFor`, { queuedMs: () => 0, now: () => 0 });
    const launch = runInNewContext(`({${jobs.slice(launchStart, launchEnd)}}).launch`, {
      enqueueJob: value => JSON.parse(JSON.stringify(value)), store: {}, VERIFY_GATE_JOB_KIND: {}, readHead: () => 'head', now: () => 0,
    });
    const handoff = runInNewContext(`${daemon.slice(handoffStart, handoffEnd).replace(/^export /, '')}; inFlightHandoff`);
    for (const previous of [undefined, false, true]) {
      for (const next of [undefined, false, true]) {
        const entry = {
          sha: 'head', suites: 'npx vitest run a.test.mjs', treeHash: 'tree',
          runId: 'old-run', requestStartedAt: '2026-11-20T16:38:35.000Z', local: previous,
        };
        const marker = {
          status: 'running', sha: entry.sha, suites: entry.suites, treeHash: entry.treeHash,
          startedAt: '2026-11-20T16:39:35.000Z', local: next,
        };
        const changed = (previous === true) !== (next === true);
        if (sameVerifyRequest(entry, marker) !== !changed) {
          violations.push(`local=${previous} -> ${next}: request identity ignored execution policy`);
        }
        if (inFlightSuperseded(entry, marker, 'head') !== changed) {
          violations.push(`local=${previous} -> ${next}: newer policy did not supersede the active run`);
        }
        if (inFlightSuperseded(entry, marker, 'head', 'never')) violations.push('never policy superseded a run');
        if (!inFlightSuperseded(entry, marker, 'head', 'any')) violations.push('any policy retained a restamped run');

        // Exercise the actual sweep with read-only IO ports: first launch, then a same-tree
        // re-request. A preconstructed entry alone would miss lost policy at entry creation.
        const dir = join(sourceRoot, 'fixture', 'lane-1');
        let current = { ...marker, local: previous, startedAt: entry.requestStartedAt };
        const inFlight = new Map();
        let kills = 0;
        const launched = [];
        const sweep = runInNewContext(`${source.slice(sweepStart, sweepEnd).replace(/^export /, '')}; runVerifyDispatch`, {
          process: { env: {} }, log() {}, join, randomUUID: () => `fixture-${launched.length}`,
          isQueueScopeEnabled: () => false, resolveSupersedePolicy: () => 'newer',
          poolsToScan: () => ['fixture'], laneIndicesIn: () => [1], tryGit: () => 'head',
          markerFor: () => current, laneNeedsVerifyDispatch, countDispatchesInFlight,
          sameVerifyRequest, inFlightSuperseded,
        });
        const options = {
          poolRoot: sourceRoot, inFlight, maxInFlight: 1, spawnGate: async () => {},
          launchGate: ({ marker: request }) => { launched.push(request); return { id: 'fixture-job' }; },
          killJobGate: () => { kills += 1; return true; },
        };
        await sweep(options);
        if (inFlight.get(dir)?.local !== (previous === true)) violations.push(`local=${previous}: sweep lost entry policy`);
        const queued = launch({ pool: 'fixture', lane: 1, dir, headSha: 'head', marker: current, runId: 'old-run' });
        const recovered = entryFor({ id: 'fixture-job', input: queued.input }, 123, null);
        const [adopted] = JSON.parse(JSON.stringify(handoff(new Map([[dir, { ...inFlight.get(dir), pid: 123 }]]))));
        for (const [mode, resumed] of [['job-sync', recovered], ['daemon-handoff', adopted]]) {
          if (resumed.local !== (previous === true) || !sameVerifyRequest(resumed, current)
            || inFlightSuperseded(resumed, marker, 'head') !== changed) {
            violations.push(`local=${previous} -> ${next}: ${mode} lost execution policy`);
          }
        }
        current = marker;
        const result = await sweep(options);
        if (kills !== Number(changed) || result.superseded.length !== Number(changed)) {
          violations.push(`local=${previous} -> ${next}: dispatch sweep failed supersession`);
        }
        if (changed) {
          // Simulate settlement; the next sweep must launch the pending replacement policy.
          inFlight.delete(dir);
          await sweep(options);
          if (launched.length !== 2 || launched[1].local !== next) violations.push('replacement policy was not launched');
        } else if (launched.length !== 1) violations.push('identical request was relaunched');
      }
    }
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
