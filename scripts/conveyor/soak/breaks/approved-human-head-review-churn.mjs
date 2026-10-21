/**
 * PR #5354 / cards 339 and 344: fresh main tips repeatedly moved approved workflow
 * PRs (#5187, #5298), losing human clearance and spending review/red-team rounds.
 * Replay the production proof, refresh and review-job paths with injected readers
 * and writers. Only git patch-id runs for real (stdin only; no repository writes).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const HEAD = 'a'.repeat(40), NEXT = 'b'.repeat(40), BASE = 'c'.repeat(40);
const PATCH = 'diff --git a/.github/workflows/test.yml b/.github/workflows/test.yml\n'
  + '--- a/.github/workflows/test.yml\n+++ b/.github/workflows/test.yml\n'
  + '@@ -1 +1 @@\n-old: true\n+new: true\n';
const trusted = body => ({ author: { login: 'chalbert' }, body });

export default {
  id: 'approved-human-head-review-churn',
  title: 'approved human-surface heads survive freshness ticks and identical rebases spend no review round',
  card: 'PR #5354 / cards 339 and 344; live PRs #5187 and #5298',
  fixedBy: {
    sha: '83fd61ea6', where: 'lane/rebase-carry-human-hold',
    paths: ['scripts/lib/approved-human-surface-hold.mjs', 'scripts/lib/rebase-verdict-carry.mjs',
      'scripts/merge-ai-prs.mjs', 'scripts/operations/review-job.mjs'],
  },
  fixPresent(root) {
    try {
      return readFileSync(join(root, 'scripts/merge-ai-prs.mjs'), 'utf8').includes('readApprovedHumanSurfaceHold')
        && readFileSync(join(root, 'scripts/operations/review-job.mjs'), 'utf8').includes('decideRebaseVerdictCarry');
    } catch { return false; }
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const violations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
    let restoreRecorder = () => {};
    try {
      const { CONSTELLATION_REPOS } = await load('scripts/lib/constellation-repos.mjs');
      const repo = CONSTELLATION_REPOS.we.slug;
      // The review job installs an ambient recorder; isolate and restore it even
      // when another scenario already has one active in this process.
      const { createMemoryTelemetryStore, createTelemetryRecorder, setActiveRecorder } = await load('scripts/operations/telemetry-store.mjs');
      restoreRecorder = setActiveRecorder(createTelemetryRecorder({ store: createMemoryTelemetryStore(), resource: {}, enabled: true }));
      const { readApprovedHumanSurfaceHold, refreshHeldHead, retainApprovedHumanQueueHead } = await load('scripts/lib/approved-human-surface-hold.mjs');
      const { refreshStalePr } = await load('scripts/lib/merge-queue-hook.mjs');
      const { revalidateForMerge } = await load('scripts/merge-ai-prs.mjs');
      const { runReviewJob } = await load('scripts/operations/review-job.mjs');
      const { contributionPatchId, parseVerdictCarriedMarker } = await load('scripts/lib/rebase-verdict-carry.mjs');
      const { gateOutcomesForHead } = await load('scripts/lib/red-team-gate.mjs');

      const clearance = trusted(`<!-- reviewed-sha: ${HEAD} -->\n<!-- cleared-human: operator -->`);
      const readHold = (overrides = {}) => {
        const facts = { setting: 'on', head: HEAD, mergeable: 'MERGEABLE', manifest: '',
          labels: ['review:accepted'], comments: [clearance], ...overrides };
        return readApprovedHumanSurfaceHold({ setting: facts.setting, pr: 5354, repo, expectedHead: HEAD,
          readComments: () => facts.comments,
          exec(tool, args) {
            if (facts.unreadable) throw Error('proof unavailable');
            if (tool === 'gh') return JSON.stringify({ headRefOid: facts.head, labels: facts.labels, mergeable: facts.mergeable });
            if (tool !== 'git') throw Error(`unexpected tool: ${tool}`);
            if (args[0] === 'merge-base') return BASE;
            if (args[0] === 'ls-tree') return facts.manifest;
            if (args[0] === 'diff') return args.includes('--name-only') ? '.github/workflows/test.yml\0' : PATCH;
            throw Error(`unexpected git command: ${args}`);
          } });
      };
      const pr = { number: 5354, title: 'workflow change', body: 'Approved workflow change', headRefOid: HEAD,
        labels: ['ready-to-merge', 'review:accepted'], commits: [], mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND',
        statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
      let rebuilds = 0;
      const reruns = [];
      // Each tick represents another main move / newly stale required pass.
      for (let tick = 1; tick <= 3; tick++) {
        const hold = readHold().hold;
        check(hold, `tick ${tick}: the approved live head lost its hold`);
        const result = await refreshHeldHead({ hold, refresh: refreshStalePr,
          options: { laneRef: 'lane/approved-human', expectedHead: HEAD, runId: tick, readTip: () => HEAD,
            refresh: () => { rebuilds++; return { ok: true, action: 'rebuilt', newCommit: NEXT }; },
            rerun: id => reruns.push(id) } });
        check(result.ok && result.action === 'rerun' && !result.newCommit, `tick ${tick}: freshness moved the head instead of rerunning`);
        const retained = retainApprovedHumanQueueHead(pr, { hold, queueOwnsFreshness: true });
        check(revalidateForMerge(retained).decision === 'merge', `tick ${tick}: the queue cannot test the retained head`);
        check(retained.headRefOid === HEAD && pr.mergeStateStatus === 'BEHIND', `tick ${tick}: retention mutated the original PR`);
      }
      check(rebuilds === 0 && reruns.join(',') === '1,2,3', 'freshness must rerun each stale pass without rebuilding');
      for (const facts of [{ setting: 'off' }, { mergeable: 'CONFLICTING' }, { manifest: '.lane-manifest.json' },
        { labels: [] }, { comments: [] }, { comments: [trusted(`<!-- reviewed-sha: ${BASE} -->\n<!-- cleared-human: operator -->`)] }]) {
        check(!readHold(facts).hold, `unsafe approval retained: ${JSON.stringify(facts)}`);
      }
      for (const facts of [{ unreadable: true }, { head: NEXT }, { mergeable: 'UNKNOWN' }]) {
        let refused = false;
        try { readHold(facts); } catch { refused = true; }
        check(refused, `uncertain approval proof did not refuse: ${JSON.stringify(facts)}`);
      }
      const beforeRace = reruns.length;
      const raced = await refreshHeldHead({ hold: true, refresh: refreshStalePr,
        options: { laneRef: 'lane/approved-human', expectedHead: HEAD, runId: 4, readTip: () => NEXT,
          rerun: id => reruns.push(id) } });
      check(!raced.ok && raced.action === 'head-moved' && reruns.length === beforeRace, 'a concurrent push was rerun without a new proof');
      const red = { ...pr, statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] };
      check(revalidateForMerge(retainApprovedHumanQueueHead(red, { hold: true, queueOwnsFreshness: true })).decision === 'skip', 'queue retention bypassed a red required check');

      for (const mode of ['identical', 'whitespace', 'changed', 'unreadable', 'restamp-failed', 'off', 'red-team-pending', 'gate-with-hold',
        'saved-only', 'saved-unreadable', 'no-saved-reader']) {
        const calls = [];
        const posted = [];
        const savedReads = [];
        const io = {
          root: sourceRoot, now: () => 0, claim: () => ({ ok: true }), unclaim: () => {}, report: () => {},
          log: line => log?.(line), readPrevCompletion: () => null, newActorId: () => 'soak-review',
          acquireLane: () => { calls.push('lane'); return { lanePath: 'injected-soak-lane' }; },
          updateRecord: () => {}, releaseLane: () => {},
          carryAcrossRebaseSetting: () => ({ value: mode === 'off' ? 'off' : 'on', source: 'soak' }),
          readCarryEvidence: () => ({ headSha: NEXT, comments: [clearance,
            ...(mode === 'red-team-pending' ? [] : [trusted(`<!-- we:red-team-gate pr=5354 rev=${HEAD} outcome=card-queued -->`
              + (mode === 'gate-with-hold' ? '\nunknown hold' : ''))])] }),
          // Production checks saved evidence before carrying bare gate markers. An
          // absent reader means unknown evidence, not a confirmed empty store.
          readSavedResult: input => {
            savedReads.push(input);
            if (mode === 'saved-unreadable') throw Error('saved red-team evidence malformed');
            return mode === 'saved-only' ? { pr: 5354, rev: HEAD, findings: [] } : null;
          },
          contributionPatchId: ({ sha }) => contributionPatchId({ sha, exec(tool, args, options) {
            if (tool !== 'git') throw Error(`unexpected tool: ${tool}`);
            if (mode === 'unreadable') throw Error('objects unavailable');
            if (args[0] === 'cat-file') return '';
            if (args[0] === 'merge-base') return BASE;
            if (args[0] === 'diff') return sha === NEXT && mode === 'whitespace' ? PATCH.replace('+new:', '+  new:')
              : sha === NEXT && mode === 'changed' ? PATCH.replace('+new:', '+changed:') : PATCH;
            if (args[0] === 'patch-id') return execFileSync('git', args, { ...options, timeout: 5000, maxBuffer: 64 * 1024 * 1024 });
            throw Error(`unexpected git command: ${args}`);
          } }),
          restampVerdict: () => { calls.push('restamp'); return { ok: mode !== 'restamp-failed' }; },
          postCarryComment: ({ body }) => { calls.push('comment'); posted.push(trusted(body)); },
          runLoop: () => { calls.push('round'); return { status: 0, stdout: JSON.stringify({ stopped: 'complete',
            verdict: { verdict: 'accept', loop: { outcome: 'converged' } } }) }; },
          speculativeRedTeamSetting: () => ({ enabled: true }),
          startSpeculativeRedTeam: () => { calls.push('speculative'); return null; },
          runExtraSeats: () => { calls.push('seats'); return { status: 'skipped' }; },
          runRedTeam: () => { calls.push('red-team'); return { status: 'skipped' }; },
        };
        if (mode === 'no-saved-reader') delete io.readSavedResult;
        const result = runReviewJob({ pr: 5354, repo }, io);
        if (['identical', 'restamp-failed', 'saved-only', 'saved-unreadable'].includes(mode)) {
          check(savedReads.length === 1 && savedReads[0].pr === 5354 && savedReads[0].repo === repo && savedReads[0].head === HEAD,
            `${mode}: saved evidence was not checked for the prior head`);
        }
        if (mode === 'identical') {
          check(result.outcome === 'carried' && calls.join(',') === 'restamp,comment', 'identical rebase spent a lane, round or red-team pass, or posted before restamping');
          const marker = parseVerdictCarriedMarker(posted[0]?.body);
          check(marker?.fromSha === HEAD && marker?.toSha === NEXT && /^[a-f0-9]{40}$/.test(marker?.patchId ?? ''), 'carry comment lost its head/patch proof');
          check([...gateOutcomesForHead(posted, 5354, NEXT)].join(',') === 'card-queued', 'carry comment lost the red-team gate for the new head');
        } else {
          check(result.outcome !== 'carried' && calls.filter(c => c === 'round').length === 1 && posted.length === 0,
            `${mode}: review did not fall back to one normal round`);
          check(calls.filter(c => c === 'restamp').length === (mode === 'restamp-failed' ? 1 : 0), `${mode}: unexpected restamp attempt`);
        }
      }
    } catch (error) {
      violations.push(`scenario failed: ${error.stack ?? error}`);
    } finally {
      restoreRecorder();
    }
    return { violations };
  },
  judge: report => report.violations,
};
