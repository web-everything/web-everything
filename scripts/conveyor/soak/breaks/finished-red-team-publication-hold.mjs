/** PR #6945: recover a finished round stranded behind a publication hold. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const repo = 'example/widgets', pr = 6945, head = '988887cb' + 'a'.repeat(32);
const context = `red-team/publication #${pr}`, creator = { login: 'web-everything[bot]' };
const comments = [{ author: creator, body:
  `<!-- we:red-team-advisory pr=${pr} rev=${head} -->\n### Post-accept red team — no break found` }];
const load = (root, path) => import(pathToFileURL(join(root, path)).href);
export async function probePlanner(root) {
  const { planRedTeamOnSkip } = await load(root, 'scripts/lib/review-red-team-on-skip.mjs');
  return planRedTeamOnSkip({ repo, refusals: [{ kind: 'already-reviewed-head', prNumber: pr }],
    rawPrs: [{ number: pr, headRefOid: head, comments, labels: [], reviews: [] }],
    readEvidence: () => ({ loopPayload: { verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head } } } } }),
    readStatus: () => null, readFinishedHold: () => true, now: 2_000_000,
    setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: new Map() })[0]?.action === 'republish-publication';
}
export default {
  id: 'finished-red-team-publication-hold', title: 'posted red-team results retry publication holds', card: 'PR #6945',
  fixedBy: { sha: 'publication-republish', where: 'working tree',
    paths: ['scripts/lib/review-red-team-on-skip.mjs', 'scripts/lib/drain-red-team-evidence.mjs'] },
  fixPresent(root) {
    const source = `import { probePlanner } from ${JSON.stringify(import.meta.url)};
      process.stdout.write(JSON.stringify(await probePlanner(${JSON.stringify(root)})));`;
    try { return execFileSync(process.execPath, ['--input-type=module', '-e', source],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, WE_UNDER_TEST: '1' } }).trim() === 'true'; }
    catch { return false; }
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || ROOT, violations = [];
    if (!await probePlanner(root)) return { violations: ['finished publication hold skipped despite posted result'] };
    const { redTeamStatusDir, republishPublicationStatus } = await load(root, 'scripts/lib/drain-red-team-evidence.mjs');
    const { writeJsonAtomic } = await load(root, 'scripts/lib/atomic-json-file.mjs');
    const { renderRedTeamComment } = await load(root, 'scripts/operations/review-extra-seats.mjs');
    const liveComments = [{ author: creator, body: renderRedTeamComment({ pr, rev: head, provider: 'codex', model: 'fixture',
      findings: [], recheckStatus: 'not-needed', foldedVerdict: 'accept' }) }];
    const scratch = mkdtempSync(join(tmpdir(), 'finished-hold-soak-'));
    try {
      const env = { WE_SHARED_RUNS_DIR: join(scratch, 'runs'), WE_RED_TEAM_CHECK_LOCK_DIR: join(scratch, 'locks') };
      const path = join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${pr}-${head}.json`);
      mkdirSync(redTeamStatusDir(env), { recursive: true });
      writeJsonAtomic(path, { repo, pr, head, status: 'finished', result: 'ran', sealedBreaks: [] });
      writeJsonAtomic(`${path}.unpublished`, { status: 'finished', remoteHold: true });
      let history = [{ id: 10, state: 'failure', context, creator, description: 'held: finished round not confirmed published' }];
      let posts = 0, checkOk = false, race = false;
      const gh = (args, options) => {
        if (args[0] === 'auth') return 'ghs_synthetic_soak_only';
        if (args.includes('POST')) {
          posts++;
          const next = { ...JSON.parse(options.input), id: 20 + posts, creator }; history.unshift(next);
          if (race && next.state === 'success') history.push({ ...history[1], id: 15 });
          return JSON.stringify(next);
        }
        if (args[1].includes('/statuses?')) return JSON.stringify(history);
        throw Error('unexpected soak GitHub call');
      };
      const key = { repo, pr, head, env, gh, readCheck: () => ({ ok: checkOk, runId: 50 }),
        readLivePr: () => ({ headRefOid: head, labels: [] }), readComments: () => liveComments };
      if (republishPublicationStatus(key).ok || posts || !existsSync(`${path}.unpublished`)) violations.push('unknown check cleared hold');
      checkOk = true; race = true;
      const raced = republishPublicationStatus(key);
      if (raced.ok || posts !== 2 || history[0].state !== 'failure'
        || !existsSync(`${path}.unpublished`)) violations.push(`concurrent hold did not restore failure: ${raced.reason}`);
      race = false;
      const recovered = republishPublicationStatus(key);
      if (!recovered.ok || existsSync(`${path}.unpublished`)) violations.push(`confirmed recovery failed to settle: ${recovered.reason}`);
      if (!republishPublicationStatus(key).noop || posts !== 3) violations.push('rerun was not a no-op');
    } finally { rmSync(scratch, { recursive: true, force: true }); }
    return { violations };
  },
  judge(report) { return report.violations; },
};
