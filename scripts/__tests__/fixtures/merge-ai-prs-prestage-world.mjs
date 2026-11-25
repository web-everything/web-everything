import { daemonAppEnv } from './daemon-app-env.mjs';
import { expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const sha = 'a'.repeat(40);
import { fakeGh, fakeGit } from './merge-ai-prs-fake-ports.mjs';
import { SNAPSHOT_FIELDS } from '../../lib/pr-snapshot.mjs';
import { PR_SNAPSHOT_VERSION } from '../../lib/pr-snapshot-store.mjs';
import { buildManifest, embedManifestInBody, extractManifestFromBody, manifestAuditLine } from '../../readiness/lane-manifest.mjs';
import { CONSTELLATION_REPOS } from '../../lib/constellation-repos.mjs';
import { CI_LIFECYCLE_LABEL_META, buildDrainReasonComment, LAND_REASON, REVIEW_RECORD_HEADLINES } from '../../merge-ai-prs.mjs';
import { REVIEW_LABEL_META } from '../../lib/review-escalation.mjs';

export function createPrestageWorld(runCommand) {
  return async function world(fn, { slug = 'fixture/prestage', fastTargetManifest = true, recordedLand = true } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'prestage-cli-'));
    try {
      const bin = join(dir, 'bin'); mkdirSync(bin);
      mkdirSync(join(dir, 'backlog'));
      for (const [name, body] of [['gh', fakeGh], ['git', fakeGit]]) writeFileSync(join(bin, name), body, { mode: 0o755 });
      const fixture = join(dir, 'pr.json'), log = join(dir, 'calls.jsonl'), settings = join(dir, 'settings.json'), coord = join(dir, 'coord'), ledger = join(dir, 'ledger');
      writeFileSync(settings, JSON.stringify({ mergeDelivery: { strategy: 'github-merge-queue' } }));
      const pr = { number: 42, id: 'PR_NODE', title: 'Update readme', body: 'Update the readme.', state: 'OPEN', isDraft: false,
        headRefOid: sha, updatedAt: '2026-11-18T00:00:00Z', headRefName: 'lane/readme', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: 'APPROVED',
        labels: [{name:'review:accepted'},{name:'ready-to-merge'}], files: [{path:'README.md',changeType:'MODIFIED'}],
        commits: [{oid:sha,messageHeadline:'Update readme',authors:[{name:'Claude',email:'noreply@anthropic.com'}]}],
        statusCheckRollup: [{name:'test',status:'IN_PROGRESS',conclusion:null,head_sha:sha}],
        comments: [{author:{login:'chalbert'},body:REVIEW_RECORD_HEADLINES.restamp+'\n<!-- reviewed-sha: '+sha+' -->',createdAt:new Date().toISOString()}], reviews: [] };
      const run = async (green = false, { rebaseDrop = false, numbering = false, thisRepo = true, args = [], shadowMode = 'off', defaultBranch = 'main', failDefaultBranch = false } = {}) => {
        // The live queue precondition now pins all five producers. Explicit test
        // failures/pending states win; omitted companion checks are successful.
        pr.statusCheckRollup.push(...['test', 'smoke', 'daemon-soak', 'soak-replay-gate', 'merge-gate']
          .filter(name => !pr.statusCheckRollup.some(c => c.name === name))
          .map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS', head_sha: pr.headRefOid })));
        // The hardened fast path requires a readable manifest at the live head. Full-pass
        // preparation remains manifest-less; it cannot authorize the later fast drain.
        if (green && fastTargetManifest && !pr.body.includes('lane-manifest:begin')) pr.body = embedManifestInBody(pr.body,
          buildManifest({ item: 'xabc123', repos: [{ repo: 'we', ref: pr.headRefName }], blockedBy: [], stackParents: [] }));
        // A previous full-pass attempt already provisioned labels and recorded its
        // manifest audit. These facts prevent unrelated full-pass writes from
        // masking the validator each admission test exercises.
        const repos = new Set([slug, ...Object.values(CONSTELLATION_REPOS).map(r => r.slug)]);
        const labelMemo = join(dir, 'labels.json');
        writeFileSync(labelMemo, JSON.stringify({ labels: Object.fromEntries([...repos, `https://github.com/${slug}`]
          .flatMap(repo => Object.keys({ ...CI_LIFECYCLE_LABEL_META, ...REVIEW_LABEL_META }).map(name => [`${repo}::${name}`, Date.now()]))) }));
        const manifest = extractManifestFromBody(pr.body);
        if (green && recordedLand && manifest && !pr.comments.some(c => c.body.startsWith('<!-- drain-land-reason -->')))
          pr.comments.push({ author: { login: 'chalbert' }, body: buildDrainReasonComment('land', LAND_REASON, manifestAuditLine(manifest)) });
        const snapshots = join(dir, 'snapshots'); mkdirSync(snapshots, { recursive: true });
        const owner = slug.split('/')[0];
        for (const repo of new Set([slug, ...Object.values(CONSTELLATION_REPOS).map(r => r.slug), `${owner}/web-everything`, `${owner}/frontierui`, `${owner}/plateau-app`])) {
          const rows = repo === slug ? [pr, ...(pr.contextPartners ?? [])] : [];
          writeFileSync(join(snapshots, `${repo.replace('/', '__')}.json`), JSON.stringify({ v: PR_SNAPSHOT_VERSION,
            repo, fetchedAtMs: Date.now(), fields: SNAPSHOT_FIELDS, count: rows.length, prs: rows,
            heavyMeta: Object.fromEntries(rows.map(p => [p.number, { fetchedAtMs: Date.now() }])) }));
        }
        writeFileSync(fixture, JSON.stringify(pr)); writeFileSync(log, '');
        const groups = join(dir, 'groups.json');
        writeFileSync(groups, JSON.stringify({ v: 1, groups: pr.cardGroups ?? [] }));
        const r = await runCommand([ ...(thisRepo ? ['--this-repo'] : []),'--label=ready-to-merge','--only=42', '--json', ...args,
          '--no-drain-lease','--no-red-main-freeze',...(!rebaseDrop ? ['--no-rebase-drop'] : []),'--no-heal-collision','--no-overlap-yield',
          ...(green ? ['--from-green-event'] : [])], { cwd:dir,encoding:'utf8',timeout:120_000, // a loaded host can push one real drain run past 30s
          env: { ...process.env, ...daemonAppEnv(dir), PATH:bin+':'+process.env.PATH, PRESTAGE_PR:fixture,PRESTAGE_LOG:log, PRESTAGE_REPO:slug,
            PRESTAGE_DEFAULT_BRANCH:defaultBranch, PRESTAGE_FAIL_BRANCH:failDefaultBranch ? '1' : '0',
            ...(failDefaultBranch ? { WE_GH_THROTTLE_RETRY_MAX_ATTEMPTS:'1' } : {}),
            WE_COORDINATION_ROOT:coord, WE_ASYNC_DRAIN:shadowMode, LANE_POOL_ROOT:dir, WE_MERGE_DELIVERY_SETTINGS_FILE:settings,
            WE_DRAIN_LABEL_MEMO_PATH:labelMemo,
            WE_DRAIN_CARD_GROUP_STATE:groups,
            WE_PR_SNAPSHOT:green ? '1' : '0', WE_PR_SNAPSHOT_DIR:snapshots,
            WE_DRAIN_WAIT_FOR_RED_TEAM_BEFORE_ENQUEUE:'off',WE_MQ_NUMBER_CARDS_BEFORE_ENQUEUE:numbering ? 'on' : 'off',
            WE_DRAIN_WORKFLOW_EDIT_HUMAN:'off',WE_REVIEW_LEDGER_MODE:'off',WE_DRAIN_UNKNOWN_MERGEABLE_RETRIES:'0',
            WE_VERDICT_LEDGER_DIR:ledger, WE_VERDICT_LEDGER_STORE:'home' } });
        expect(r.status, r.stderr + r.stdout).toBe(0);
        return { report:JSON.parse(r.stdout), stdout:r.stdout, calls:readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse), stderr:r.stderr };
      };
      await fn({pr,run,coord,ledger,slug,dir});
    } finally { rmSync(dir,{recursive:true,force:true}); }
  };
}
