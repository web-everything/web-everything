import { daemonAppEnv } from './daemon-app-env.mjs';
import { expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const sha = 'a'.repeat(40);
import { fakeGh, fakeGit } from './merge-ai-prs-fake-ports.mjs';
import { withFixtureEnv } from './with-fixture-env.mjs';

export function createPrestageWorld(runCommand) {
  return async function world(fn, { slug = 'fixture/prestage', localSlug = slug, siblingCloneSource = null } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'prestage-cli-'));
    try {
      const cwd = siblingCloneSource ? join(dir, 'local') : dir;
      if (siblingCloneSource) {
        mkdirSync(cwd);
        symlinkSync(siblingCloneSource, join(dir, slug.split('/').at(-1)), 'dir');
      }
      const bin = join(dir, 'bin'); mkdirSync(bin);
      mkdirSync(join(dir, 'backlog'));
      const fixture = join(dir, 'pr.json'), log = join(dir, 'calls.jsonl'), settings = join(dir, 'settings.json'), coord = join(dir, 'coord'), ledger = join(dir, 'ledger');
      writeFileSync(settings, JSON.stringify({ mergeDelivery: { strategy: 'github-merge-queue' } }));
      // Embed fixture routing in executable shims: safety reads intentionally scrub PRESTAGE_* from their child env.
      const routing = { PRESTAGE_PR: fixture, PRESTAGE_LOG: log, PRESTAGE_REPO: slug, PRESTAGE_LOCAL_REPO: localSlug };
      for (const [name, body] of [['gh', fakeGh], ['git', fakeGit]]) writeFileSync(join(bin, name), withFixtureEnv(body, routing), { mode: 0o755 });
      const pr = { number: 42, id: 'PR_NODE', title: 'Update readme', body: 'Update the readme.', state: 'OPEN', isDraft: false,
        headRefOid: sha, headRefName: 'lane/readme', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
        labels: [{name:'review:accepted'},{name:'ready-to-merge'}], files: [{path:'README.md',changeType:'MODIFIED'}],
        commits: [{oid:sha,messageHeadline:'Update readme',authors:[{name:'Claude',email:'noreply@anthropic.com'}]}],
        statusCheckRollup: [{name:'test',status:'IN_PROGRESS',conclusion:null,head_sha:sha}],
        comments: [{author:{login:'chalbert'},body:'<!-- reviewed-sha: '+sha+' -->',createdAt:new Date().toISOString()}], reviews: [] };
      const run = async (green = false, { rebaseDrop = false, numbering = false, thisRepo = true, args = [], shadowMode = 'off', defaultBranch = 'main', failDefaultBranch = false, env = {} } = {}) => {
        writeFileSync(fixture, JSON.stringify(pr)); writeFileSync(log, '');
        const r = await runCommand([ ...(thisRepo ? ['--this-repo'] : []),'--label=ready-to-merge','--only=42', '--json', ...args,
          '--no-drain-lease','--no-red-main-freeze',...(!rebaseDrop ? ['--no-rebase-drop'] : []),'--no-heal-collision','--no-overlap-yield',
          ...(green ? ['--from-green-event'] : [])], { cwd,encoding:'utf8',timeout:120_000, // a loaded host can push one real drain run past 30s
          env: { ...process.env, ...daemonAppEnv(dir), PATH:bin+':'+process.env.PATH, PRESTAGE_PR:fixture,PRESTAGE_LOG:log, PRESTAGE_REPO:slug, PRESTAGE_LOCAL_REPO:localSlug,
            PRESTAGE_DEFAULT_BRANCH:defaultBranch, PRESTAGE_FAIL_BRANCH:failDefaultBranch ? '1' : '0',
            ...(failDefaultBranch ? { WE_GH_THROTTLE_RETRY_MAX_ATTEMPTS:'1' } : {}),
            WE_COORDINATION_ROOT:coord, WE_ASYNC_DRAIN:shadowMode, LANE_POOL_ROOT:dir, WE_MERGE_DELIVERY_SETTINGS_FILE:settings,
            WE_DRAIN_WAIT_FOR_RED_TEAM_BEFORE_ENQUEUE:'off',WE_MQ_NUMBER_CARDS_BEFORE_ENQUEUE:numbering ? 'on' : 'off',
            WE_DRAIN_WORKFLOW_EDIT_HUMAN:'off',WE_REVIEW_LEDGER_MODE:'off',WE_DRAIN_UNKNOWN_MERGEABLE_RETRIES:'0',
            WE_VERDICT_LEDGER_DIR:ledger, WE_VERDICT_LEDGER_STORE:'home', ...env } });
        expect(r.status, r.stderr + r.stdout).toBe(0);
        return { report:JSON.parse(r.stdout), stdout:r.stdout, calls:readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse), stderr:r.stderr };
      };
      await fn({pr,run,coord,ledger,slug,dir});
    } finally { rmSync(dir,{recursive:true,force:true}); }
  };
}
