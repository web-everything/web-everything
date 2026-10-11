import { describe, it, expect, vi } from 'vitest';
import { countRealFixRounds, planReconcile, resolveRoundCap } from '../reconcile-core.mjs';
import { readRoundCommits, enrichPrsWithMechanicalRound, BOUNCE_PREFIX } from '../mechanical-round-cap.mjs';
import { REARM_COMMENT_MARKER } from '../rearm-review.mjs';
import { FIX_BEGIN_MARKER } from '../fix-procedure.mjs';

// Live #4757 own-line history. Dates are UTC (00:49:38Z = Oct 10 20:49:38-04:00).
const history = [
  ['965af3a67087b16c94c8f15163d55457cfba2135', 'd86770adb784869f3f9da16e693afead9fc64786', '11T05:06:29', 'PR #4757: fix — restore the resume-ladder settings keys (resumeAcrossRounds, strongerModelFromRound) in resolveFixSettings after the restack merge (PR 4757)'],
  ['d86770adb784869f3f9da16e693afead9fc64786', '1aac17fa5cef50052326cee1368a3399618919e1 cd9f96a9462af2f42a36e00c601533578e9b6499', '11T04:55:44', 'Merge origin/lane/fixer-history-takeover into lane/fixer-resume-ladder'],
  ['1aac17fa5cef50052326cee1368a3399618919e1', 'b80b06a9d3d2b5711791277c889b1b29ab205cb2', '11T04:15:25', "PR #4757: fix — round resume re-writes the guard hooks in the earlier session's cwd before resuming (PR 4757)"],
  ['b80b06a9d3d2b5711791277c889b1b29ab205cb2', '2756980ebe0b7ea8181fef83104dad2f5ddffb98', '11T04:03:08', 'PR #4757: fix — stacked-base parent read from pull commits, resume cwd held to the scratch root, voids cancel only an earlier takeover start (PR 4757)'],
  ['2756980ebe0b7ea8181fef83104dad2f5ddffb98', '43cfe129f09f0bd332d0a7e843d2f56e351b68cf 12d2a97d5a9ce6c5a711c6862737d7b04b06656e', '11T03:17:28', "Merge commit '12d2a97d5a9ce6c5a711c6862737d7b04b06656e'"],
  ['43cfe129f09f0bd332d0a7e843d2f56e351b68cf', 'ace787eb2fcba92b28be7f44793e53f00c1e7cc1 0ca861b3d369abf9953c346bdcbbd0a49953d4a1', '11T02:35:11', "Merge branch 'lane/fixer-history-takeover' of github.com:chalbert/web-everything"],
  ['ace787eb2fcba92b28be7f44793e53f00c1e7cc1', 'b41108447f6b63b37ee7c710cd58502e225035f7 457daec02511786e550d05e0f26ac4c9238a4b07', '11T01:31:23', "Merge branch 'lane/fixer-history-takeover' of github.com:chalbert/web-everything"],
  ['b41108447f6b63b37ee7c710cd58502e225035f7', '32f5f93739525a9466347f06961553b3ccaa654d f06a4b26d26b66defc48558424345c00a721d530', '11T01:17:38', 'drain: rebase lane/fixer-resume-ladder onto origin/main, drop transient .lane-manifest.json'],
  ['f06a4b26d26b66defc48558424345c00a721d530', 'f57600dbfa74477ee88be0bad9ac0da8a0d58dcc', '11T00:49:38', 'PR #4757: ci-heal — parked-pr-conflict integration test expects attempts/cap on planned refusals'],
  ['f57600dbfa74477ee88be0bad9ac0da8a0d58dcc', '4a9e3102b8c2e3fcff4258b990f576a5742294fe b8c947f6950ea04608356b04d78f917e5c67681d', '11T00:45:15', "Merge commit 'b8c947f6950ea04608356b04d78f917e5c67681d'"],
  ['4a9e3102b8c2e3fcff4258b990f576a5742294fe', '3113246fda81e4ebe6c8a2ead683c3a672d40e3e 9ba3ed361f729b36c47e9634643f05a9cd673c56', '10T22:13:43', "Merge branch 'lane/fixer-history-takeover' of github.com:chalbert/web-everything"],
  ['3113246fda81e4ebe6c8a2ead683c3a672d40e3e', '01fe3200343f5103c04ffe9b2144d15e1d917d56 00f1d7fcbe8a9077c38bb9008cb8c305e201d8d5', '10T20:44:51', 'Merge origin/lane/fixer-history-takeover into lane/fixer-resume-ladder'],
  ['01fe3200343f5103c04ffe9b2144d15e1d917d56', 'c49560e3ac4e68b39717766432ca2fdbc4347f79 15418f552ebe7e67744a296b59301d73182fc527', '10T15:05:55', 'PR #4757: restack onto lane/fixer-history-takeover (PR 4757)'],
  ['c49560e3ac4e68b39717766432ca2fdbc4347f79', 'a99c637a41a14b9137da9c1d6856e4ec425d75b8', '10T12:40:42', 'conveyor fix: replay names how the resumed session gets its checkout (#xrbu1bp)'],
  ['a99c637a41a14b9137da9c1d6856e4ec425d75b8', '1be5affcd252f21798e3242eeb64b1d7e02e7016', '10T12:39:12', 'conveyor fix: resume the previous round’s fixer session + stronger model from round 3'],
];
const at = (s) => `2026-10-${s}Z`;
const commits = history.map(([sha, parents, date, subject]) => ({ sha, parents: parents.split(' '), authoredAt: at(date), subject }));
const head = commits[0].sha;
const comment = (date, body) => ({ createdAt: at(date), body, author: { login: 'web-everything' } });
const begin = (date, who = 'fix-4757') => comment(date, `${FIX_BEGIN_MARKER}\n\n**Who:** \`${who}\``);
const comments = [
  ...['10T15:03:59', '10T20:32:24', '10T22:10:41', '11T01:30:50', '11T02:34:25', '11T03:53:27', '11T04:55:15'].map((t) => begin(t)),
  ...['11T00:44:34', '11T01:12:11'].map((t) => begin(t, 'ci-heal-4757')),
  ...['10T15:39:45', '10T20:47:36', '10T22:17:29', '11T01:33:11', '11T04:37:46', '11T06:06:06'].map((t) => comment(t, REARM_COMMENT_MARKER)),
  comment('11T01:17:40', '🔀 conveyor rebase-onto-main'),
  ...['10T14:45:15', '10T20:28:30', '10T21:50:09', '11T01:22:19', '11T02:18:51', '11T04:39:04'].map((t) => comment(t, `${BOUNCE_PREFIX}\n\n### Findings\n- repair needed\n\nNet basis: \`${'0'.repeat(40)}..${commits[1].sha}\``)),
];
const pr = { number: 4757, headRefOid: head, headRefName: 'lane/fixer-resume-ladder', baseRefName: 'lane/fixer-history-takeover',
  labels: ['review:pending', 'review-round:5'].map((name) => ({ name })), isDraft: false, createdAt: at('10T12:00:00'),
  files: [{ path: 'scripts/conveyor/reconcile-core.mjs' }], comments,
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', headSha: head }],
};
const facts = { head, commits };
const plan = (p) => planReconcile({ prs: [p], agents: [], durableCounts: { 4757: 6 }, requiredChecks: ['test'], now: Date.parse(at('11T07:00:00')) });

describe('mechanical re-arm rounds', () => {
  it('counts only the two real #4757 fix rounds', () => {
    const result = countRealFixRounds({ ...pr, roundCommits: facts });
    expect(result).toMatchObject({ ok: true, total: 6, real: 2 });
    expect(result.rounds.filter((r) => r.real).map((r) => r.at)).toEqual([at('11T04:37:46'), at('11T06:06:06')]);
    expect(Date.parse('2026-10-10T20:49:38-04:00')).toBe(Date.parse(commits[8].authoredAt));
  });
  it.each([undefined, { ...facts, head: 'a'.repeat(40) }, { head, ok: false }, { head, commits: [{ ...commits[0], authoredAt: 'bad' }] }])('fails safe without valid current evidence: %j', (roundCommits) => {
    expect(plan({ ...pr, roundCommits }).refusals).toContainEqual(expect.objectContaining({ kind: 'cap-exhausted', attempts: 6 }));
  });
  it('dispatches the owed review with two attempts despite both raw counts being six', () => {
    const result = plan({ ...pr, roundCommits: facts });
    expect(result.refusals.some((r) => r.kind === 'cap-exhausted')).toBe(false);
    expect(result.dispatch).toContainEqual(expect.objectContaining({ kind: 'review', attempts: 2, mechanicalRebaseRounds: 4 }));
  });
  it.each([['drain: rebase branch onto main', 0], ['fix the finding', 1]])('classifies a single-parent %s', (subject, real) => {
    expect(countRealFixRounds({ ...pr, comments: [comment('11T06:06:06', REARM_COMMENT_MARKER)], roundCommits: { head, commits: [{ ...commits[0], subject }] } })).toMatchObject({ ok: true, real });
  });
  it('excludes the ci-heal commit before the next review fix-begin', () => {
    expect(countRealFixRounds({ ...pr, comments: [begin('11T00:44:34', 'ci-heal-4757'), begin('11T01:30:50'), comment('11T01:33:11', REARM_COMMENT_MARKER)], roundCommits: { head, commits: [{ ...commits[8], sha: head }] } })).toMatchObject({ ok: true, real: 0 });
  });
  describe('crash-and-replace fixer claims', () => {
    const fixCommit = { ...commits[0], subject: 'real fix', authoredAt: at('11T02:00:00') };
    const rearm = comment('11T04:00:00', REARM_COMMENT_MARKER);
    const end = (date, who = 'fix-7') => comment(date, `🔓 conveyor fix-end — fix claim released\n\n\`${who}\` released the fix claim at \`abcdef123\`.`);
    const count = (extra) => countRealFixRounds({ ...pr, comments: [...extra, rearm], roundCommits: { head, commits: [fixCommit] } });
    it('keeps the round start at the first begin when a replacement claim never saw a release', () => {
      expect(count([begin('11T01:00:00', 'fix-7'), begin('11T03:00:00', 'fix-7')])).toMatchObject({ ok: true, real: 1 });
    });
    it('keeps the first begin through several unreleased replacements', () => {
      expect(count([begin('11T01:00:00', 'fix-7'), begin('11T01:30:00', 'fix-8'), begin('11T03:00:00', 'fix-9')])).toMatchObject({ ok: true, real: 1 });
    });
    it('starts a new window after a clean release, so the earlier claim does not own the later round', () => {
      expect(count([begin('11T01:00:00', 'fix-7'), end('11T02:30:00'), begin('11T03:00:00', 'fix-8')])).toMatchObject({ ok: true, real: 0 });
    });
    it('does not let an untrusted release comment split the window', () => {
      const forged = { ...end('11T02:30:00'), author: { login: 'outsider' } };
      expect(count([begin('11T01:00:00', 'fix-7'), forged, begin('11T03:00:00', 'fix-7')])).toMatchObject({ ok: true, real: 1 });
    });
  });
  describe('truncated (shallow) history', () => {
    const shallow = commits.map((c, i) => (i === commits.length - 1 ? { ...c, parents: [] } : c));
    it('countRealFixRounds refuses a walk whose last commit has no parent', () => {
      expect(countRealFixRounds({ ...pr, roundCommits: { head, commits: shallow } })).toMatchObject({ ok: false });
    });
    it('countRealFixRounds refuses a single commit with no parent', () => {
      expect(countRealFixRounds({ ...pr, comments: [comment('11T06:06:06', REARM_COMMENT_MARKER)], roundCommits: { head, commits: [{ ...commits[0], parents: [] }] } })).toMatchObject({ ok: false });
    });
    it('readRoundCommits fails closed when the walk ends on a parentless boundary commit', () => {
      const exec = (_bin, args) => (args[0] === 'fetch' ? '' : shallow.map((c) => [c.sha, c.parents.join(' '), c.authoredAt, c.subject].join('\0')).join('\n'));
      expect(readRoundCommits({ pr, exec })).toMatchObject({ head, ok: false, reason: 'truncated-history' });
    });
    it('a shallow boundary stops the planner replacing the durable count with zero', () => {
      const result = plan({ ...pr, roundCommits: { head, commits: shallow } });
      expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'cap-exhausted', attempts: 6 }));
    });
  });
  it('walks the drain merge last parent, skips base-side commits, and uses author dates', () => {
    const extra = { ...commits[0], sha: commits[7].parents[0], subject: 'base-only fix' };
    const exec = (_bin, args) => {
      if (args[0] === 'fetch') return '';
      expect(args).toContain('--format=%H%x00%P%x00%aI%x00%s');
      return [...commits, extra].map((c) => [c.sha, c.parents.join(' '), c.authoredAt, c.subject].join('\0')).join('\n');
    };
    expect(readRoundCommits({ pr, exec })).toEqual(facts);
    expect(readRoundCommits({ pr, exec: () => { throw new Error('offline'); } })).toMatchObject({ head, ok: false });
  });
  it('enriches trusted re-arms without requiring a conflict marker, and contains injected failures', () => {
    expect(enrichPrsWithMechanicalRound([pr], { roundCap: 6, readRoundCommits: () => facts })[0].roundCommits).toEqual(facts);
    expect(enrichPrsWithMechanicalRound([pr], { roundCap: 6, readRoundCommits: () => { throw new Error('offline'); } })[0].roundCommits).toMatchObject({ head, ok: false });
    const foreign = { ...pr, comments: comments.map((c) => ({ ...c, author: { login: 'outsider' } })) };
    expect(enrichPrsWithMechanicalRound([foreign], { roundCap: 6, readRoundCommits: () => { throw new Error('must not read'); } })[0]).toBe(foreign);
  });
  it('leaves a PR with one trusted re-arm unchanged without reading commits', () => {
    const belowCap = { ...pr, comments: [comment('11T06:06:06', REARM_COMMENT_MARKER)] };
    const reader = vi.fn(() => { throw new Error('must not read'); });
    expect(enrichPrsWithMechanicalRound([belowCap], { roundCap: 5, readRoundCommits: reader })[0]).toBe(belowCap);
    expect(reader).not.toHaveBeenCalled();
  });
  it.each([undefined, '', ' 3 ', '06', '0', '-1', '1.5', '5oops', '9007199254740992'])('defaults to the reconcile round cap for env %j', (value) => {
    vi.stubEnv('WE_REVIEW_ROUND_CAP', value);
    try {
      const cap = resolveRoundCap(process.env);
      for (const count of [0, 1, 2, 3, 4, 5, 6, 7]) {
        const candidate = { ...pr, comments: Array.from({ length: count }, () => comment('11T06:06:06', REARM_COMMENT_MARKER)) };
        const reader = vi.fn(() => facts);
        const enriched = enrichPrsWithMechanicalRound([candidate], { readRoundCommits: reader })[0];
        expect(reader).toHaveBeenCalledTimes(count >= cap ? 1 : 0);
        if (count < cap) expect(enriched).toBe(candidate);
        else expect(enriched.roundCommits).toEqual(facts);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
