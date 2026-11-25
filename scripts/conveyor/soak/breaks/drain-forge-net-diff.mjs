/** Non-local net-diff admission must use fresh forge evidence in the real drain CLI. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeGh, fakeGit } from '../../../__tests__/fixtures/merge-ai-prs-fake-ports.mjs';
import { defaultCachePath } from '../../../lib/github-app-auth-env.mjs';
import { OWNER_INSTALLATIONS, installationCachePath } from '../../../lib/github-app-installations.mjs';
import { daemonAppEnv } from '../../../__tests__/fixtures/daemon-app-env.mjs';
import { synthesizeUnifiedDiff } from '../../../lib/drain-api-reads.mjs';
import { normalizeDiffFingerprint } from '../../../lib/review-escalation.mjs';

const SIBLING = ['frontier-ui', 'frontierui'].join('/');
const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
function probe(root = ROOT) {
  const dir = mkdtempSync(join(tmpdir(), 'soak-forge-net-diff-'));
  const violations = [];
  try {
    const bin = join(dir, 'bin'); mkdirSync(bin); mkdirSync(join(dir, 'backlog'));
    const cwd = join(dir, 'local'); mkdirSync(cwd);
    const fixture = join(dir, 'pr.json'), log = join(dir, 'calls.jsonl'), settings = join(dir, 'settings.json');
    const routing = { PRESTAGE_PR: fixture, PRESTAGE_LOG: log, PRESTAGE_REPO: SIBLING, PRESTAGE_LOCAL_REPO: ['web-everything', 'web-everything'].join('/') };
    for (const [name, body] of [['gh', fakeGh], ['git', fakeGit]]) writeFileSync(join(bin, name), body.replace('\n', '\nObject.assign(process.env, ' + JSON.stringify(routing) + ');\n'), { mode: 0o755 });
    writeFileSync(settings, JSON.stringify({ mergeDelivery: { strategy: 'github-merge-queue' } }));
    const appEnv = daemonAppEnv(dir);
    // Safety reads scrub fixture installation overrides. Seed the canonical routes with fake tokens too,
    // so the real App shim never needs to refresh a credential or reach a live service.
    const cachePath = defaultCachePath(dir);
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    for (const installationId of Object.values(OWNER_INSTALLATIONS)) writeFileSync(installationCachePath(cachePath, installationId), JSON.stringify({ ...cached, installationId }));
    const sha = 'a'.repeat(40), mb = 'b'.repeat(40);
    const clean = { status: 'ahead', merge_base_commit: { sha: mb }, base_commit: { sha: mb }, files: [{ filename: 'README.md', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@ -0,0 +1 @@\n+readme' }] };
    const tamper = { ...clean, files: [{ filename: 'blocks/__tests__/x.test.ts', status: 'added', additions: 1, deletions: 0, changes: 1, patch: '@@ -0,0 +1 @@\n+it.skip("works", () => {});' }] };
    const carryDiff = synthesizeUnifiedDiff(tamper.files);
    for (const scenario of [
      { name: 'clean', compare: clean },
      { name: '500', compare: { status: 500 }, reason: 'api-http-500' },
      { name: 'empty-ahead', compare: { ...clean, files: [] }, reason: 'compare-empty' },
      { name: 'empty-diverged', compare: { ...clean, status: 'diverged', files: [] }, reason: 'compare-empty' },
      { name: 'cleared-500', compare: { status: 500 }, reason: 'api-http-500', cleared: true },
      { name: 'cleared-tamper', compare: tamper, cleared: true },
      { name: 'carry-no-clone', compare: tamper, carry: true },
      { name: 'carry-sibling', compare: tamper, carry: true, sibling: true },
    ]) {
      if (scenario.sibling) symlinkSync(root, join(dir, 'frontierui'), 'dir');
      writeFileSync(log, '');
      rmSync(fixture + '.queued', { force: true });
      writeFileSync(fixture, JSON.stringify({ number: 42, id: 'PR_NODE', title: 'Update readme', body: 'Update the readme.', state: 'OPEN', isDraft: false,
        headRefOid: sha, headRefName: 'lane/readme', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
        labels: [{ name: 'review:accepted' }, { name: 'ready-to-merge' }], files: [{ path: 'README.md', changeType: 'MODIFIED' }],
        commits: [{ oid: sha, messageHeadline: 'Update readme', authors: [{ name: 'Claude', email: 'noreply@anthropic.com' }] }],
        statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', head_sha: sha }],
        comments: [{ author: { login: 'chalbert' }, body: `<!-- reviewed-sha: ${scenario.carry ? 'c'.repeat(40) : sha} -->`
          + (scenario.cleared || scenario.carry ? '\n<!-- cleared-human: chalbert -->' : '')
          + (scenario.carry ? `\n<!-- reviewed-diff: ${normalizeDiffFingerprint(carryDiff)} -->` : ''), createdAt: new Date().toISOString() }], reviews: [],
        ...(scenario.carry ? { gitDiffText: carryDiff } : {}), compare: scenario.compare }));
      const r = spawnSync(process.execPath, [join(root, 'scripts/merge-ai-prs.mjs'), `--repos=${SIBLING}`, '--label=ready-to-merge', '--only=42', '--json', '--no-drain-lease', '--no-red-main-freeze', '--no-rebase-drop', '--no-heal-collision', '--no-overlap-yield'], {
        cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, ...appEnv, ...routing, PATH: bin + ':' + process.env.PATH,
          WE_UNDER_TEST: '1', WE_DRAIN_READS_SOURCE: 'git', WE_GH_THROTTLE_RETRY_MAX_ATTEMPTS: '1',
          WE_COORDINATION_ROOT: join(dir, 'coord'), LANE_POOL_ROOT: dir, WE_MERGE_DELIVERY_SETTINGS_FILE: settings,
          WE_ASYNC_DRAIN: 'off', WE_ACCEPT_CARRY_FORWARD: 'on', WE_DRAIN_WAIT_FOR_RED_TEAM_BEFORE_ENQUEUE: 'off', WE_MQ_NUMBER_CARDS_BEFORE_ENQUEUE: 'off',
          WE_DRAIN_WORKFLOW_EDIT_HUMAN: 'off', WE_REVIEW_LEDGER_MODE: 'off', WE_DRAIN_UNKNOWN_MERGEABLE_RETRIES: '0',
          WE_VERDICT_LEDGER_DIR: join(dir, 'ledger'), WE_VERDICT_LEDGER_STORE: 'home' },
      });
      if (r.status !== 0) { violations.push(`CLI failed (${scenario.name}): ${r.error?.message ?? r.stderr}`); continue; }
      const report = JSON.parse(r.stdout), calls = readFileSync(log, 'utf8');
      // The hermetic gh shim writes this receipt only after queue admission succeeds.
      const delivered = existsSync(fixture + '.queued') || calls.includes('"pr","merge"');
      if (scenario.reason) {
        if (!report.parked?.some(p => p.humanRequired && p.reasons?.some(s => s.includes(`net diff unverified (forge-${scenario.reason}); `)))) violations.push(`${scenario.name} did not produce the named human hold`);
        if (delivered) violations.push(`${scenario.name} attempted delivery`);
      } else if (scenario.carry && !scenario.sibling) {
        if (delivered || !calls.includes('review:held-mechanical')) violations.push('missing sibling did not hold the moved-head clearance');
      } else {
        if (!r.stderr.includes(`net-diff #42: base=${mb} head=${sha} (forge)`)) violations.push(`clean compare not scored via forge: ${r.stderr} ${r.stdout}`);
        if (!delivered) violations.push(`${scenario.name} did not attempt delivery`);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return { violations };
}
export default {
  id: 'drain-forge-net-diff', title: 'non-local forge reads fail closed and human clearance survives verified identical diffs', card: 'CLEAR-HUMAN-NOT-STICKY',
  fixedBy: { sha: 'forge-net-diff', where: 'main', paths: ['scripts/lib/forge-net-diff.mjs', 'scripts/merge-ai-prs.mjs'] },
  // Presence is behavioral: exporting a helper alone cannot prove that the CLI uses it.
  fixPresent(root) { return probe(root).violations.length === 0; },
  async run({ root = ROOT } = {}) { return probe(root); },
  judge: report => report.violations,
};
