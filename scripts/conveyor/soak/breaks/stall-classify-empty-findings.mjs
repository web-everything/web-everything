/** #6957: carding the last confirmed break leaves no open judge findings. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');

function emptyFindingsInput() {
  const head = 'abcdef0123456789abcdef0123456789abcdef01';
  return {
    row: { repo: 'web-everything/web-everything', number: 6957, waitingOn: 'ruling-needed:red-team-round-cap',
      actor: 'operator', stalled: true, liveJob: null, why: 'red-team rounds spent after carding its one break',
      evidence: ['one confirmed red-team break', 'gate carded the break', 'red-team:clear'],
      next: { command: 'operator-next' } },
    head, files: ['scripts/foo.mjs'],
    verdict: { verdict: 'send-back', reasons: ['no open findings after carding'], evidence: {
      rounds: 1, trend: 'first-round', trigger: 'red-team-cap', head: head.slice(0, 12), filesKnown: true, crossBroken: 0, grantsSoFar: 0,
      guardFiles: [], latest: [], latestCount: 0, latestUnparsed: 0, latestComplete: true, classes: { broken: 0, degraded: 0, unconfirmed: 0 },
    } },
  };
}

export default {
  id: 'stall-classify-empty-findings',
  title: 'a consistent empty judge finding list routes to extend-rounds without claiming malformed evidence',
  card: 'xi8jtp1',
  fixedBy: { sha: 'pending', where: 'main', paths: ['scripts/conveyor/pr-stall-classify.mjs'] },
  fixPresent(root) {
    try {
      const modulePath = join(root, 'scripts/conveyor/pr-stall-classify.mjs');
      const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
        const { classifyStall } = await import(process.argv[1]);
        const result = classifyStall(JSON.parse(process.argv[2]));
        process.exit(result?.lane === 'operator' && result.action === 'send-back'
          && result.command?.includes(' extend-rounds --pr=6957 ')
          && !/missing|malformed/.test(result.reason) ? 0 : 1);
      `, pathToFileURL(modulePath).href, JSON.stringify(emptyFindingsInput())], {
        encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024,
      });
      // A failed probe must not turn a landed regression into it.fails (an expected failure).
      // The independent marker keeps the gate mandatory even if the fixed branch is removed.
      return (!probe.error && probe.status === 0)
        || readFileSync(modulePath, 'utf8').includes('export const STALL_EMPTY_FINDINGS_FIX_LANDED = true;');
    } catch {
      return false;
    }
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || ROOT;
    const { classifyStall } = await import(pathToFileURL(join(root, 'scripts/conveyor/pr-stall-classify.mjs')).href);
    const input = emptyFindingsInput();
    const violations = [];
    const result = classifyStall(input);
    if (result?.lane !== 'operator' || result.action !== 'send-back' || !result.command?.includes(' extend-rounds --pr=6957 ')
      || !result.reason.includes('no open findings remain') || /missing|malformed|fail-closed/.test(result.reason)) {
      violations.push('#6957: consistent empty findings do not route to extend-rounds as nothing open');
    }
    const refuses = (patch, files = input.files) => {
      const r = classifyStall({ ...input, files, verdict: { ...input.verdict, evidence: { ...input.verdict.evidence, ...patch } } });
      return r?.lane === 'operator' && r.command === 'operator-next' && /fail-closed|guard code/.test(r.reason);
    };
    for (const patch of [
      { rounds: 0, trend: 'no-evidence' },
      { latestUnparsed: 1 }, { latestComplete: false }, { latestUnparsed: undefined, latestComplete: undefined },
      { latestCount: 1 },
      ...['broken', 'degraded', 'unconfirmed'].map(cls => ({ classes: { broken: 0, degraded: 0, unconfirmed: 0, [cls]: 1 } })),
      { crossBroken: 1 }, { crossBroken: undefined },
      { latest: [{}], latestCount: 1 },
    ]) {
      if (!refuses(patch)) violations.push('incomplete or contradictory finding evidence stopped failing closed');
    }
    if (!refuses({}, ['scripts/conveyor/pr-stall-classify.mjs'])
      || !refuses({ guardFiles: ['scripts/conveyor/pr-stall-classify.mjs'] })) {
      violations.push('empty findings bypass the guard-code refusal');
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
