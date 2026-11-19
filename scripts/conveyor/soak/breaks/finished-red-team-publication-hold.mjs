/** PR #6945: a posted ordinary result must retry the finished writer's unconfirmed publication hold. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const repo = 'example/widgets', pr = 6945, head = '988887cb' + 'a'.repeat(32);
const comments = [{ author: { login: 'web-everything' }, body:
  `<!-- we:red-team-advisory pr=${pr} rev=${head} -->\n### Post-accept red team — no break found` }];
const load = (root, path) => import(pathToFileURL(join(root, path)).href);
export async function probePlanner(root) {
  const { planRedTeamOnSkip } = await load(root, 'scripts/lib/review-red-team-on-skip.mjs');
  return planRedTeamOnSkip({ repo, refusals: [{ kind: 'already-reviewed-head', prNumber: pr }],
    rawPrs: [{ number: pr, headRefOid: head, comments, labels: [], reviews: [] }],
    readEvidence: () => ({ loopPayload: { verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head } } } } }),
    readStatus: () => null, readFinishedHold: () => true, now: 2_000_000,
    setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: new Map() })[0]?.action === 'clear-finished-hold';
}
export default {
  id: 'finished-red-team-publication-hold',
  title: 'posted ordinary red-team results retry finished publication holds',
  card: 'PR #6945',
  fixedBy: { sha: 'finished-publication-hold-recovery', where: 'working tree',
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
    const { redTeamStatusDir, readFinishedPublicationHold, settleFinishedPublicationHold } = await load(root, 'scripts/lib/drain-red-team-evidence.mjs');
    const { writeJsonAtomic } = await load(root, 'scripts/lib/atomic-json-file.mjs');
    const scratch = mkdtempSync(join(tmpdir(), 'finished-hold-soak-'));
    try {
      const env = { WE_SHARED_RUNS_DIR: join(scratch, 'runs') };
      const path = join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${pr}-${head}.json.unpublished`);
      writeJsonAtomic(path, { status: 'finished', remoteHold: true });
      let held = true, posts = 0, checkOk = false, postOk = false;
      const key = { repo, pr, head, env, lock: fn => fn(), readCheck: () => ({ ok: checkOk }),
        readComments: () => comments, postHold: ({ held: next }) => {
          posts++;
          if (!postOk) return { ok: false, reason: 'transient post failure' };
          held = next; return { ok: true };
        } };
      if (settleFinishedPublicationHold(key).ok || posts || !readFinishedPublicationHold(key)) violations.push('unknown check cleared hold');
      checkOk = true;
      if (settleFinishedPublicationHold(key).ok || !held || !existsSync(path)) violations.push('failed clear lost retry marker');
      postOk = true;
      if (!settleFinishedPublicationHold(key).ok || held || existsSync(path)) violations.push('confirmed clear failed to settle');
      if (!settleFinishedPublicationHold(key).ok || posts !== 2) violations.push('second settlement was not idempotent');
    } finally { rmSync(scratch, { recursive: true, force: true }); }
    return { violations };
  },
  judge(report) { return report.violations; },
};
