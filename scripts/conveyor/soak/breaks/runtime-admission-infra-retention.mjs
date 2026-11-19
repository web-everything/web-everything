/** Slice 1: admission holds retain infra evidence and isolate malformed cards. */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliRetryInfraBlocked } from '../../../../skills-src/conveyor/build-dispatch-daemon.mjs';
import { resumeOpen, runInfraBlocked } from '../../infra-blocked.mjs';
import { assertRuntimeAdmitted, withRuntimeAdmission } from '../../../lib/runtime-admission.mjs';

const admission = { assertRuntimeAdmitted, withRuntimeAdmission };
const lift = () => ({ mode: 'lift' });
const sha = 'a'.repeat(40);

export function retryProbe(groupMembers) {
  const entries = [{ num: '12', groupMembers }, { num: '13' }];
  const before = JSON.stringify(entries), calls = [];
  const report = withRuntimeAdmission({ num: '13' }, 'infra-recovery', () => cliRetryInfraBlocked({
    now: () => 0, env: {}, readEntries: () => entries,
    exec: (_command, args) => {
      calls.push(args.at(-1));
      return JSON.stringify({ retried: ['13'] });
    },
  }), { readSettings: lift });
  return { report, calls, unchanged: JSON.stringify(entries) === before };
}

export async function replay() {
  const violations = [];
  for (const members of [null, {}, '13', [null], [undefined], ['12\n'], Array(1)]) {
    const probe = retryProbe(members);
    if (!probe.unchanged || probe.calls.join() !== '--num=13'
      || probe.report.failed?.[0]?.reason !== 'runtime-malformed'
      || probe.report.retried?.join() !== '13') violations.push('malformed group stopped healthy recovery');
  }
  const dir = mkdtempSync(join(tmpdir(), 'soak-runtime-infra-'));
  const previous = process.env.CONVEYOR_INFRA_FILE;
  try {
    const file = join(dir, 'infra.json');
    process.env.CONVEYOR_INFRA_FILE = file;
    for (const scenario of ['missing-adapter', 'only', 'malformed', 'identity', 'revoked', 'guard']) {
      const entry = { num: '12', ref: 'lane/12', sha, cause: 'network', attempt: 2,
        refusals: 3, nextRetryAt: '2020-01-01T00:00:00.000Z',
        ...(scenario === 'identity' ? { builderContext: 'broken' } : {}) };
      const original = JSON.stringify([entry]);
      writeFileSync(file, original);
      let settings = scenario === 'only' ? { only: true, ids: [] }
        : scenario === 'malformed' ? { held: true } : lift();
      const commands = [];
      let report;
      await runInfraBlocked(['retry', '--max-auto-rearms=0'], {
        admission: scenario === 'missing-adapter' ? undefined : admission,
        readContext: () => null, readSettings: () => settings,
        fetchStatus: async () => ({ reachable: true, indicator: 'none' }),
        readLocalSlug: () => null,
        writeReport: text => { report = JSON.parse(text); },
        exec: (command) => {
          commands.push(command);
          if (command === 'git') {
            if (scenario === 'revoked') settings = { only: true, ids: [] };
            return sha;
          }
          if (scenario === 'guard') {
            const error = new Error('guard refused');
            error.stdout = JSON.stringify({ reason: 'unverified', detail: 'guard refused' });
            throw error;
          }
          throw new Error('unexpected publish');
        },
      });
      if (scenario === 'guard') {
        const stored = JSON.parse(readFileSync(file, 'utf8'))[0];
        if (stored.refusals !== 4 || stored.attempt !== 2 || !report.failed[0]?.refused
          || report.failed[0]?.admission) violations.push('real guard lost refusal accounting');
      } else {
        if (readFileSync(file, 'utf8') !== original || report.failed[0]?.admission !== true || report.retried.length)
          violations.push(scenario + ': admission changed retained evidence');
        if (commands.some(command => command !== 'git')) violations.push(scenario + ': published refused work');
      }
    }
  } finally {
    if (previous === undefined) delete process.env.CONVEYOR_INFRA_FILE;
    else process.env.CONVEYOR_INFRA_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
  return { violations };
}

export default {
  id: 'runtime-admission-infra-retention',
  title: 'infra admission holds preserve evidence and malformed groups do not stop retries',
  card: 'PR #7090 Slice 1',
  fixedBy: { sha: 'HEAD', where: 'Slice 1', paths: [
    'scripts/conveyor/infra-blocked.mjs', 'skills-src/conveyor/build-dispatch-daemon.mjs',
  ] },
  fixPresent(root) {
    // Probe the candidate tree's real behavior, including persisted refusal accounting.
    const target = pathToFileURL(join(root, 'scripts/conveyor/soak/breaks/runtime-admission-infra-retention.mjs')).href;
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
      'const { replay } = await import(process.argv[1]); const report = await replay(); process.exitCode = report.violations.length ? 1 : 0;',
      target], { cwd: root, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
    return probe.status === 0;
  },
  run: replay,
  judge: report => report.violations,
};
