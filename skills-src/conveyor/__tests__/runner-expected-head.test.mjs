import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCliMechanicalPasses, MECHANICAL_PASS_NAMES } from '../runner.mjs';
import { dispatchReviewJob } from '../../../scripts/operations/review-job.mjs';

const repo = 'web-everything/web-everything';
const head = 'a'.repeat(40);

it.each([
  ['headRefOid', head, true], ['headSha', head, true], ['head', head, true],
  ['headRefOid', undefined, false], ['headRefOid', 'invalid', false],
  ['headRefOid', 'b'.repeat(40), false],
])('runner forwards planned %s=%s into job admission (starts=%s)', async (field, value, starts) => {
  const root = mkdtempSync(join(tmpdir(), 'runner-review-head-'));
  const calls = [], spawnJob = vi.fn(() => 4242);
  let outcome;
  const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await makeCliMechanicalPasses({ scriptsDir: join(root, 'scripts'), repo,
      skipPasses: new Set(MECHANICAL_PASS_NAMES.filter(name => name !== 'reconcile-pass')),
      runPass: async ({ entry }) => {
        calls.push(entry);
        if (entry.script.endsWith('reconcile-pass.mjs')) return { code: 0, output: JSON.stringify({
          dispatch: [{ kind: 'review', prNumber: 77, [field]: value }], refusals: [],
        }) };
        if (entry.script.endsWith('review-dispatch.mjs')) {
          const flag = name => entry.args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
          outcome = dispatchReviewJob({ pr: Number(flag('pr')), repo: flag('repo'), expectedHead: flag('expected-head'),
            root, dir: join(root, 'jobs'), env: {}, spawnJob, io: { liveHead: () => head },
            checkStaleness: () => ({ fresh: true, behind: 0 }), readCompletion: () => null,
            ciGate: () => ({ allowed: true }), resolveSettingsEnv: () => ({}) });
          return { code: outcome.refused ? 75 : 0, output: '' };
        }
        return { code: 0, output: '' };
      },
    })();
    expect(spawnJob).toHaveBeenCalledTimes(starts ? 1 : 0);
    expect(calls.filter(entry => entry.script.endsWith('review-round-tag.mjs'))).toHaveLength(starts ? 1 : 0);
    expect(outcome).toMatchObject(starts ? { jobPid: 4242 } : { refused: true });
    if (value !== undefined) expect(calls.find(entry => entry.script.endsWith('review-dispatch.mjs')).args)
      .toContain(`--expected-head=${value}`);
  } finally {
    warn.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
