/** PR #6584: a carried card-queued advisory preserves acceptance; a missing required run can self-heal. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'carried-hold-and-norun-required-check-refresh',
  title: 'PR #6584: carried acceptance stands and a startup_failure missing required run gets a main refresh',
  card: 'PR #6584',
  fixedBy: {
    // Undo both audit rounds before the original fix, which otherwise masks the regression.
    sha: '150928dff01c2d573443b419498dda37d6fd4948,a9d8dec13a,70fd3936f9',
    where: 'main',
    paths: ['scripts/conveyor/pass-daemons/pr-ready-stuck.mjs', 'scripts/lib/accept-carry-forward.mjs'],
  },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/accept-carry-forward.mjs'), 'utf8').includes('const gatePart =')
      && readFileSync(join(root, 'scripts/conveyor/pass-daemons/pr-ready-stuck.mjs'), 'utf8').includes("checks.push({ name, conclusion: 'MISSING' })");
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || fileURLToPath(new URL('../../../../', import.meta.url));
    const load = path => import(pathToFileURL(join(root, path)).href);
    const { isKnownMachineBody, latestAcceptRecord, decideAcceptCarryForward } = await load('scripts/lib/accept-carry-forward.mjs');
    const { runReadyStuck } = await load('scripts/conveyor/pass-daemons/pr-ready-stuck.mjs');
    const old = '1'.repeat(40), head = 'a'.repeat(40), main = 'c'.repeat(40), diff = 'f'.repeat(64);
    const trusted = { author: { login: 'web-everything[bot]' } };
    const body = [
      `<!-- we:red-team-gate pr=6584 rev=${head} outcome=card-queued result=${'d'.repeat(16)} -->`,
      `<!-- review-verdict-carried from=${old} to=${head} patch-id=${'b'.repeat(40)} -->`,
      'Review verdict carried across an identical contribution.',
      `<!-- we:red-team-advisory pr=6584 rev=${head} -->`,
      "### Post-accept red team — 1 possible break(s), 1 confirmed by Claude's re-check",
      '',
      'Advisory only: this comment changes no label itself; the red-team gate (setting `redTeam.confirmedBreaks`) sends a confirmed broken break back to the fixer. '
        + `Head \`${old.slice(0, 12)}\` · red team codex/gpt-6.1-sol · re-check ok · recorded verdict \`changes\`.`,
      '',
      '1. [**confirmed**] (edge-case, degraded) `scripts/x.mjs:253` — Unreachable later effects can block replay',
      '   - Class: live-reproduced → fix-now (basis: probe)',
      '   - Also class: correctness-in-normal-use',
      '   - Scenario: a scenario',
      '   - Re-check: demonstrated break',
      '   - Files read: scripts/x.mjs',
      '',
      "A confirmed break is recorded as a miss for the accepting review and for the builder's model.",
    ].join('\n');
    const accept = { ...trusted, createdAt: '2026-11-08T08:00:00Z',
      body: `✅ review — accepted\n<!-- reviewed-sha: ${old} -->\n<!-- reviewed-diff: ${diff} -->` };
    const carried = { ...trusted, createdAt: '2026-11-09T08:00:00Z', body };
    const record = latestAcceptRecord([accept, carried], []);
    const decision = decideAcceptCarryForward({ setting: 'on', record, headSha: head, headDiff: diff, equivalence: 'strict' });
    const violations = [];
    if (!isKnownMachineBody(body, carried) || record?.laterVerdict !== false || decision.action !== 'carry') {
      violations.push('acceptance superseded by the carried card-queued machine record');
    }
    for (const [name, comment] of [
      ['untrusted author', { ...carried, author: { login: 'mallory' } }],
      ['appended hold', { ...carried, body: body + '\nPlease hold this change.' }],
      ['confirmed broken finding', { ...carried, body: body.replace('edge-case, degraded', 'edge-case, broken') }],
    ]) {
      if (isKnownMachineBody(comment.body, comment)
        || latestAcceptRecord([accept, comment], [])?.laterVerdict !== true) violations.push(`${name} failed to preserve the hold`);
    }

    const repo = 'example/widgets', now = Date.parse('2026-11-10T12:00:00Z');
    const exerciseRefresh = async ({ missingMain = false, unreadableRules = false } = {}) => {
      const receipt = {}, refreshes = [], alerts = [], unexpectedReads = [];
      const pr = { number: 6584, state: 'OPEN', isDraft: false, headRefOid: head, headRefName: 'lane/6584',
        labels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }], reviewDecision: 'APPROVED',
        comments: [accept, carried], mergeStateStatus: 'BLOCKED',
        // startup_failure creates no check-run at all: do not fabricate a failed rollup entry.
        statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
      const read = ([, path]) => {
        if (path === `repos/${repo}/pulls/6584`) return { head: { sha: head, repo: { full_name: repo } },
          base: { ref: 'main', repo: { id: 42 } }, mergeable: true, draft: false, state: 'open' };
        if (path === `repos/${repo}/rulesets?includes_parents=true&per_page=100`) return [{ id: 1, enforcement: 'active' }];
        if (path === `repos/${repo}/rulesets/1`) {
          if (unreadableRules) throw Error('unreadable ruleset detail');
          return { rules: [{ type: 'required_status_checks', parameters: {
            required_status_checks: [{ context: 'merge-gate', integration_id: 99 }] } }] };
        }
        if (path === `repos/${repo}/branches/main/protection`) return { required_status_checks: { contexts: ['test'] } };
        if (path === `repos/${repo}/commits/main`) return { sha: main };
        if (path === `repos/${repo}/commits/${main}/check-runs?filter=latest&per_page=100`) {
          const checks = [{ name: 'test', conclusion: 'SUCCESS' },
            ...(!missingMain ? [{ name: 'merge-gate', conclusion: 'SUCCESS', app: { id: 99 } }] : [])];
          return { total_count: checks.length, check_runs: checks };
        }
        if (path === `repos/${repo}/commits/${main}/status?per_page=100`) return { total_count: 0, statuses: [] };
        unexpectedReads.push(path);
        throw Error('unexpected fixture read');
      };
      const args = { repo, pr, receipt, now, config: { readyStuckMinutes: 120, selfHealStaleHours: 24 }, read,
        readLabelTime: () => now - 25 * 3600000, readSkipReason: () => 'required merge-gate has no run (startup_failure)',
        send: event => { alerts.push(event); }, save: () => {}, log: () => {},
        refresh: request => { refreshes.push({ mainSha: request.mainSha, persisted: receipt.refreshed }); return { action: 'rebased' }; } };
      await runReadyStuck(args);
      await runReadyStuck(args); // persisted attempt prevents a second refresh on the same head.
      if (unexpectedReads.length) violations.push(`unexpected evidence reads: ${unexpectedReads.join(', ')}`);
      return { receipt, refreshes, alerts };
    };
    const recovery = await exerciseRefresh();
    if (recovery.refreshes.length !== 1 || recovery.refreshes[0].mainSha !== main
      || recovery.refreshes[0].persisted !== true || recovery.alerts.length !== 1) {
      violations.push('missing ruleset-required run did not decide one persisted main-merge refresh after the alert');
    }
    for (const [name, options] of [['missing main evidence', { missingMain: true }], ['unreadable ruleset', { unreadableRules: true }]]) {
      const refused = await exerciseRefresh(options);
      if (refused.refreshes.length || refused.receipt.refreshed || !refused.receipt.readyStuckAlerted) {
        violations.push(`${name} failed closed: refresh must remain blocked with an operator alert`);
      }
    }
    return { violations, acceptance: { laterVerdict: record?.laterVerdict, action: decision.action }, recovery };
  },
  judge(report) { return report.violations; },
};
