import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { join } from 'node:path';
import { buildPostmortem, shouldPostmortem, publishPostmortem, resolvePostmortemSettings, collectPrTimeline, withCoronerLock } from '../coroner-pr-postmortem.mjs';
import { runPostmortemPass, listMergedSince } from '../../conveyor/pass-daemons/pr-postmortem-pass.mjs';
const at = m => new Date(Date.UTC(2026, 9, 17, 0, m)).toISOString();
const comment = (m, body) => ({ createdAt: at(m), body, author: { login: 'web-everything' } });
function fixture(pr = 1) {
  return { repo: 'example/repo', pr, openedAt: at(0), mergedAt: at(600),
    labels: [[0, 'checking'], [10, 'status:awaiting-ci'], [20, 'review:queued'], [40, 'review:running'], [50, 'review:changes'], [80, 'status:needs-you'], [100, 'ready-to-merge'], [200, 'merge-queue']].map(([m,label]) => ({ event: 'labeled', created_at: at(m), label: { name: label } })),
    comments: [comment(50, '🔁 review — changes requested\nRecorded by agent\nfor head `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`\n### Findings\n**judge/correctness** (1)\n- `src/a.js:2` — missing guard'), comment(60, '🔒 conveyor fix-begin\n**Who:** `fixer`'), comment(70, '🔓 conveyor fix-end\n`fixer` released'), comment(90, 'conveyor fix — stood down: does not reproduce'), comment(120, 'drain-skip: required check test is not green')],
    commits: [{ sha: 'a'.repeat(40), commit: { committer: { date: at(0) }, message: 'build' } }, { sha: 'b'.repeat(40), commit: { committer: { date: at(75) }, message: 'fix' } }],
    checks: [{ name: 'test', head_sha: 'a'.repeat(40), created_at: at(0), started_at: at(10), completed_at: at(20), conclusion: 'failure' }],
    verdicts: [{ at: at(55), verdict: 'accept', coverage: { headSha: 'a'.repeat(40) } }], fixLoop: [], files: [{ filename: 'src/a.js' }, { filename: 'extra.js' }], scope: ['src/**'], prepares: [{ at: at(-1440), ref: 'prepare-1' }] };
}
const temp = () => fs.mkdtempSync(join(process.cwd(), '.coroner-test-'));
describe('per PR postmortem', () => {
  it('extracts deterministic phases, benchmark gaps, rounds, checks, approvals and scope', () => {
    const r = buildPostmortem(fixture());
    expect(r).toEqual(buildPostmortem(fixture()));
    expect(r.phases.find(p => p.phase === 'ci-wait').minutes).toBe(10);
    expect(r.checks[0]).toMatchObject({ waitMinutes: 10, runMinutes: 10 });
    expect(r.gaps.find(g => g.kind === 'ready-enqueued')).toMatchObject({ minutes: 100, p90: 75.2, minutesLost: 24.8 });
    expect(r.rounds[0].causes.map(c => c.cause)).toContain('ci-heal');
    expect(r.rounds[0].causes.map(c => c.cause)).toContain('review-finding');
    expect(r.approvals.lost).toBe(1);
    expect(r.scope.outside).toEqual(['extra.js']);
    expect(r.prepareHistory[0].ageHours).toBe(24);
    expect(r.drainSkips).toHaveLength(1);
  });
  it('retains REST check runs that expose started_at without created_at', () => {
    const f = fixture();
    f.checks = [{id:1,name:'test',head_sha:'a'.repeat(40),started_at:at(10),completed_at:at(20),conclusion:'failure'}];
    const r = buildPostmortem(f);
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0]).toMatchObject({waitMinutes:null,runMinutes:10});
    expect(r.rounds.flatMap(x => x.causes)).toEqual(expect.arrayContaining([expect.objectContaining({cause:'ci-heal',check:'test'})]));
  });
  it('respects every threshold including equality and stand-down', () => {
    const r = { leadHours: 1, rounds: [], approvals: { lost: 0 }, standDowns: [] };
    expect(shouldPostmortem(r)).toBe(false);
    expect(shouldPostmortem({ ...r, leadHours: 8 })).toBe(true);
    expect(shouldPostmortem({ ...r, rounds: Array(4) })).toBe(true);
    expect(shouldPostmortem({ ...r, approvals: { lost: 2 } })).toBe(true);
    expect(shouldPostmortem({ ...r, standDowns: [{}] })).toBe(true);
    expect(shouldPostmortem({ ...r, standDowns: [{}] }, { minLeadHours: 8, minFixRounds: 4, minLostApprovals: 2, onStandDown: false })).toBe(false);
  });
  it('logs cascade sources and ignores invalid overrides', () => {
    const logs = [];
    const s = resolvePostmortemSettings({ tool: { minLeadHours: 3 }, platform: { minFixRounds: 2 }, env: { WE_CORONER_POSTMORTEM_MIN_LEAD_HOURS: '-1' }, log: l => logs.push(l) });
    expect(s.value.minLeadHours).toBe(3);
    expect(s.sources.minFixRounds).toBe('platform');
    expect(logs.join('')).toContain('tool');
  });
  it('publishes once across reruns and emits one candidate for three distinct PRs in 24 hours', () => {
    const dir = temp();
    try {
      for (const pr of [1, 1, 2, 3, 3, 4]) publishPostmortem(buildPostmortem(fixture(pr)), { dir });
      const rows = fs.readFileSync(join(dir, 'incidents.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      expect(rows.filter(r => r.repo === 'example/repo' && r.pr === 1 && r.cause === 'review-finding')).toHaveLength(1);
      expect(rows.filter(r => r.kind === 'triage-candidate' && r.cause === 'review-finding')).toHaveLength(1);
      expect(fs.existsSync(join(dir, 'postmortem-example-repo-1.md'))).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('uses production labels and queue events, excludes outsiders and post-merge evidence', () => {
    const f = fixture();
    f.labels = [
      { event: 'labeled', created_at: at(10), label: { name: 'review-status:fixing' } },
      { event: 'unlabeled', created_at: at(20), label: { name: 'review-status:fixing' } },
      { event: 'labeled', created_at: at(20), label: { name: 'review-status:reviewing' } },
      { event: 'unlabeled', created_at: at(30), label: { name: 'review-status:reviewing' } },
      { event: 'added_to_merge_queue', created_at: at(550) },
    ];
    f.scope = ['we:src/**']; f.repo = 'web-everything/web-everything';
    f.comments.push({ ...comment(90,'conveyor fix — stood down: does not reproduce'), author: {login:'outsider'} }, comment(700,'conveyor fix — stood down: does not reproduce'));
    f.checks.push({ id: 8, name:'test', created_at:at(700), completed_at:at(800), conclusion:'failure' });
    const r = buildPostmortem(f);
    expect(r.phases).toEqual(expect.arrayContaining([{phase:'fix-running',minutes:10},{phase:'review-running',minutes:10},{phase:'queue-checks',minutes:50}]));
    expect(r.standDowns).toHaveLength(1);
    expect(r.falseFindings).toHaveLength(1);
    expect(r.checks).toHaveLength(1);
    expect(r.scope.outside).toEqual(['extra.js']);
  });
  it('records observed carry, confirmed red-team send-back and unconfirmed findings separately', () => {
    const f = fixture();
    f.comments.push(comment(80, `<!-- review-verdict-carried from=${'a'.repeat(40)} to=${'b'.repeat(40)} patch-id=${'c'.repeat(40)} -->`),
      comment(81, `<!-- we:red-team-gate pr=1 rev=${'b'.repeat(40)} outcome=sent-back -->`),
      comment(82, '### Post-accept red team — 1 possible break(s)\n· red team codex/test · re-check ok\n1. [not confirmed] (correctness, broken) `src/a.js:2` — claim\n   - Re-check: deliberate design'));
    const r = buildPostmortem(f);
    expect(r.approvals.lost).toBe(0);
    expect(r.approvals.headChanges[0].carryApplied).toBe(true);
    expect(r.rounds.flatMap(x => x.causes).filter(c => c.cause === 'red-team-break')).toHaveLength(1);
    expect(r.falseFindings.some(f => f.source === 'red-team')).toBe(true);
  });
  it('keeps independent cause windows separate and recovers journal-first publication', async () => {
    const dir = temp();
    try {
      const r = buildPostmortem(fixture());
      await withCoronerLock(dir, async () => {
        await expect(withCoronerLock(dir, () => {})).rejects.toThrow('already running');
        publishPostmortem(r,{dir});
      });
      fs.unlinkSync(join(dir,'postmortem-example-repo-1.md'));
      publishPostmortem(r,{dir});
      expect(fs.existsSync(join(dir,'postmortem-example-repo-1.md'))).toBe(true);
      publishPostmortem(buildPostmortem(fixture(2)),{dir});
      const later = fixture(3); later.mergedAt = at(2100);
      publishPostmortem(buildPostmortem(later),{dir});
      const rows = fs.readFileSync(join(dir,'incidents.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      expect(rows.filter(r => r.kind === 'triage-candidate')).toHaveLength(0);
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
  it('collects paginated read-only evidence and fails on incomplete core reads', () => {
    const calls = [];
    const gh = args => {
      calls.push(args);
      const path = args.at(-1);
      if (path.endsWith('/pulls/1')) return { merged_at:at(600), created_at:at(0), head:{ref:'lane/no-card'}, base:{sha:'z'} };
      if (path.includes('/commits?')) return [fixture().commits];
      if (path.includes('/check-runs?')) return [{check_runs:fixture().checks}];
      if (path.includes('/contents/')) return {content:Buffer.from('').toString('base64')};
      return [[]];
    };
    const r = collectPrTimeline('example/repo',1,{gh,comments:() => fixture().comments,env:{WE_FIX_LOOP_LEDGER:join(process.cwd(),'.absent-coroner-ledger')}});
    expect(r.checks).toHaveLength(2);
    expect(r.warnings).toContain('Verdict ledger unavailable');
    expect(calls.every(args => args[0] === 'api' && !args.includes('POST') && !args.includes('PATCH'))).toBe(true);
    expect(() => collectPrTimeline('example/repo',1,{gh:() => { throw Error('network failed'); }})).toThrow('network failed');
  });
  it('discovers recent merges without search and refuses a saturated listing', () => {
    const page = Array.from({length:100},(_,i) => ({number:i+1,updated_at:at(610),merged_at:i < 2 ? at(600) : null}));
    const calls = [];
    const rows = listMergedSince('example/repo',at(500),at(700),{gh:args => { calls.push(args); return calls.length === 1 ? page : []; }});
    expect(rows.map(r => r.number)).toEqual([1,2]);
    expect(calls.every(args => !args.at(-1).includes('search/'))).toBe(true);
    expect(() => listMergedSince('example/repo',at(500),at(700),{gh:() => page,maxPages:1})).toThrow('page cap');
  });
  it('persists cursor and done set, skips short PRs, and retries a failed read after restart', async () => {
    const dir = temp(); let fail = true; const reads = [];
    const listMerged = () => [{ number: 1, merged_at: at(600) }, { number: 2, merged_at: at(601) }];
    const collect = (_repo, pr) => { reads.push(pr); if (pr === 2 && fail) throw Error('read failed'); return { ...fixture(pr), ...(pr === 1 ? { mergedAt: at(1), comments: [], labels: [], checks: [], verdicts: [] } : {}) }; };
    try {
      await expect(runPostmortemPass({ repo: 'example/repo', dir, now: at(700), listMerged, collect })).rejects.toThrow('read failed');
      fail = false;
      await runPostmortemPass({ repo: 'example/repo', dir, now: at(701), listMerged, collect });
      await runPostmortemPass({ repo: 'example/repo', dir, now: at(702), listMerged, collect });
      expect(reads).toEqual([1, 2, 2]);
      expect(fs.existsSync(join(dir, 'postmortem-example-repo-1.md'))).toBe(false);
      expect(JSON.parse(fs.readFileSync(join(dir, 'merge-cursor-example-repo.json'))).done).toEqual([1, 2]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
