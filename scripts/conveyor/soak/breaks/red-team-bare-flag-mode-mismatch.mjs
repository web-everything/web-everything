/** A bare red-team recovery must publish a completed seat rather than force fresh admission. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SOURCE = 'scripts/operations/review-job.mjs';
export default {
  id: 'red-team-bare-flag-mode-mismatch',
  title: 'bare red-team-only resumes a completed unpublished seat and persists status',
  card: 'blocker rt-publication: bare recovery mode mismatch',
  fixedBy: { sha: 'pending', where: 'working tree', paths: [SOURCE] },
  fixPresent(root) {
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { default: scenario } = await import(process.argv[1]);
      process.exitCode = scenario.judge(await scenario.run({ sourceRoot: process.argv[2] })).length ? 1 : 0;
    `, import.meta.url, root], { cwd: root, env: process.env, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    return !probe.error && probe.status === 0;
  },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [], observations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
    const dir = mkdtempSync(join(tmpdir(), 'soak-red-team-bare-mode-'));
    try {
      const { createReviewJobIo, runReviewJob, runReviewJobCli } = await load(SOURCE);
      const { newRunRecord, writeRun } = await load('scripts/operations/run-store.mjs');
      const { recordRedTeamStatus, readRedTeamStatus } = await load('scripts/lib/drain-red-team-evidence.mjs');
      const repo = 'web-everything/web-everything', pr = 7157, head = 'a'.repeat(40);
      const loopPayload = { verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head } } } };
      const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
      writeRun({ ...newRunRecord({ id: 'review-pr-bare-mode', op: 'review-pr', input: { repo, pr } }), ...loopPayload }, env.WE_SHARED_RUNS_DIR);
      const real = createReviewJobIo({ env,
        readSeatRecords: () => [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'ok' }],
        // Label publication is outside this replay; refuse before any external IO.
        readEvidence: () => { throw Error('label evidence outside replay'); },
      });
      const noop = () => {};
      for (const flag of ['--red-team-only', '--red-team-only=fresh']) {
        recordRedTeamStatus({ repo, pr, loopPayload, status: 'finished', result: 'ran' }, { env });
        const modes = [], statuses = [];
        const io = { root: sourceRoot, now: () => 1000, newActorId: () => 'soak',
          readPrevCompletion: () => null, claim: () => ({ ok: true }), updateRecord: noop, unclaim: noop,
          acquireLane: () => ({ lanePath: sourceRoot }), releaseLane: noop, log: noop, report: noop,
          prepareLane: () => ({ head }), fetchRedTeamHead: () => ({ head }),
          readRedTeamOnlyPayload: () => ({ head, loopPayload }), planRedTeamMode: real.planRedTeamMode,
          redTeamStatus: input => { statuses.push(input.status); return real.redTeamStatus(input); },
          runRedTeam: input => { modes.push(input.redTeamMode); return { status: 'resumed', comment: { status: 'posted' } }; },
          runRedTeamGate: () => ({ status: 'ok', outcome: 'advisory' }),
        };
        let out;
        runReviewJobCli(['run', `--pr=${pr}`, `--repo=${repo}`, flag], {
          runJob: options => { out = runReviewJob(options, io); return {}; },
        });
        const stored = readRedTeamStatus({ repo, pr, head, env });
        observations.push({ flag, modes, statuses, stored, out });
        if (flag === '--red-team-only') {
          check(out?.redTeam?.status === 'resumed' && modes.join() === 'resume', 'bare flag failed to resume completed seat');
          check(statuses.join() === 'queued,finished' && stored?.status === 'finished' && stored?.result === 'resumed', 'bare resume status did not persist');
        } else {
          check(out?.outcome === 'blocked-on-infra' && out?.label?.includes('recovery evidence changed'), 'explicit fresh did not retain strict mismatch refusal');
          check(modes.length === 0 && stored?.result === 'ran', 'explicit fresh ran a seat or changed prior result');
        }
      }
    } catch (error) { violations.push(`scenario failed: ${error.stack ?? error}`); }
    finally { rmSync(dir, { recursive: true, force: true }); }
    return { violations, observations };
  },
  judge: report => report.violations,
};
