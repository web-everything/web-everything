import { formatCardSquashMarker, squashPatchHash } from '../../lib/card-squash-marker.mjs';
import { describe, it, expect, vi, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countRealFixRounds, planReconcile as planReconcileWithTiming, resolveRoundCap } from '../reconcile-core.mjs';
// This historical fixture exercises the serial policy; new defaults have their own timing suite.
const planReconcile = options => planReconcileWithTiming({ reviewTiming: { startAfter: 'ci-green' }, fixTiming: { joinCiAndReview: false }, ...options });
import { readRoundCommits, enrichPrsWithMechanicalRound, BOUNCE_PREFIX, LANE_MANIFEST } from '../mechanical-round-cap.mjs';
import { LANE_MANIFEST as DRAIN_MANIFEST } from '../../lib/rebase-drop-manifest.mjs';
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
// A git double: `log` lists the commits (a commit's tree defaults to its reversed sha), `merge-tree` answers git's
// clean merge of a merge commit's parents as that commit's own tree, and `diff` lists nothing.
const treeOf = (c) => c.tree ?? [...c.sha].reverse().join('');
const gitDouble = (list) => (_bin, args) => {
  if (args[0] === 'fetch') return '';
  if (args[0] === 'merge-tree') return `${treeOf(list.find((c) => c.parents.join(' ') === args.slice(-2).join(' ')))}\0`;
  if (args[0] === 'diff') return '';
  return list.map((c) => [c.sha, c.parents.join(' '), treeOf(c), c.authoredAt, c.subject].join('\0')).join('\n');
};
// Every #4757 merge pulled in upstream history (its base lane or main), never the PR's own work.
const commits = history.map(([sha, parents, date, subject]) => ({ sha, parents: parents.split(' '), authoredAt: at(date), subject,
  mechanicalSquash: false, ...(parents.includes(' ') ? { mergesPrWork: false } : {}) }));
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
  // The drain's rebase is always a two-parent commit-tree: a single-parent commit borrowing its subject is a fix.
  it.each([['drain: rebase branch onto main', 1], ['drain: rebase lane/x onto main, drop transient .lane-manifest.json', 1], ['fix the finding', 1]])('classifies a single-parent %s as real', (subject, real) => {
    expect(countRealFixRounds({ ...pr, comments: [comment('11T06:06:06', REARM_COMMENT_MARKER)], roundCommits: { head, commits: [{ ...commits[0], subject }] } })).toMatchObject({ ok: true, real });
  });
  it('excludes the ci-heal commit before the next review fix-begin', () => {
    const drain = { ...commits[0], parents: [commits[7].parents[0], commits[8].sha], subject: 'drain: rebase x onto main', authoredAt: at('11T01:32:00'), mergesPrWork: false };
    expect(countRealFixRounds({ ...pr, comments: [begin('11T00:44:34', 'ci-heal-4757'), begin('11T01:30:50'), comment('11T01:33:11', REARM_COMMENT_MARKER)], roundCommits: { head, commits: [drain, commits[8]] } })).toMatchObject({ ok: true, real: 0 });
  });
  describe('a re-arm with no commit is never refunded', () => {
    const cycles = ['01', '02', '03', '04', '05', '06'].flatMap((h) => [begin(`11T${h}:00:00`, 'fix-7'), comment(`11T${h}:10:00`, REARM_COMMENT_MARKER)]);
    const oldHead = { ...commits[0], authoredAt: at('10T00:00:00') };
    it('counts six fix-begin → re-arm cycles on an unchanged head as six spent attempts', () => {
      expect(countRealFixRounds({ ...pr, comments: cycles, roundCommits: { head, commits: [oldHead] } })).toMatchObject({ ok: true, real: 6, total: 6 });
    });
    it('keeps the planner at the cap instead of replacing the durable count with zero', () => {
      const others = comments.filter((c) => !c.body.startsWith(REARM_COMMENT_MARKER) && !c.body.startsWith(FIX_BEGIN_MARKER));
      const result = plan({ ...pr, comments: [...others, ...cycles], roundCommits: { head, commits: [oldHead] } });
      expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'cap-exhausted', attempts: 6 }));
    });
    it('a round whose only commits are merges or drain rebases is still refunded', () => {
      const merge = { ...commits[0], parents: [commits[1].sha, commits[2].sha], subject: 'Merge branch x', authoredAt: at('11T01:05:00'), mergesPrWork: false };
      expect(countRealFixRounds({ ...pr, comments: cycles.slice(0, 2), roundCommits: { head, commits: [merge] } })).toMatchObject({ ok: true, real: 0, total: 1 });
    });
  });
  describe('crash-and-replace fixer claims', () => {
    const fixCommit = { ...commits[0], subject: 'real fix', authoredAt: at('11T02:00:00') };
    const rearm = comment('11T04:00:00', REARM_COMMENT_MARKER);
    const end = (date, who = 'fix-7') => comment(date, `🔓 conveyor fix-end — fix claim released\n\n\`${who}\` released the fix claim at \`abcdef123\`.`);
    const count = (extra) => countRealFixRounds({ ...pr, comments: [...extra, rearm], roundCommits: { head, commits: [fixCommit] } });
    it('keeps the round start at the first begin when a replacement claim follows a crash', () => {
      expect(count([begin('11T01:00:00', 'fix-7'), begin('11T03:00:00', 'fix-7')])).toMatchObject({ ok: true, real: 1 });
    });
    it('keeps the first begin through several replacements', () => {
      expect(count([begin('11T01:00:00', 'fix-7'), begin('11T01:30:00', 'fix-8'), begin('11T03:00:00', 'fix-9')])).toMatchObject({ ok: true, real: 1 });
    });
    it.each([['harness reclaim', 'fix-7'], ['own release', 'fix-8']])('a fix-end (%s) between claims does not split the round', (_name, who) => {
      expect(count([begin('11T01:00:00', 'fix-7'), end('11T02:30:00', who), begin('11T03:00:00', 'fix-8')])).toMatchObject({ ok: true, real: 1 });
    });
    it('a begin from before the previous re-arm does not reach back into the earlier round', () => {
      const earlier = comment('11T01:30:00', REARM_COMMENT_MARKER);
      const merge = { ...commits[0], parents: [fixCommit.sha, commits[2].sha], subject: 'Merge branch x', authoredAt: at('11T03:30:00'), mergesPrWork: false };
      const fix = { ...fixCommit, sha: commits[1].sha, parents: [commits[3].sha] };
      const result = countRealFixRounds({ ...pr, comments: [begin('11T01:00:00', 'fix-7'), earlier, begin('11T03:00:00', 'fix-8'), rearm],
        roundCommits: { head, commits: [{ ...merge, parents: [fix.sha, commits[2].sha] }, fix] } });
      expect(result.rounds[1]).toMatchObject({ real: false });
      expect(result).toMatchObject({ ok: true, total: 2, real: 1 });
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
      expect(readRoundCommits({ pr, exec: gitDouble(shallow) })).toMatchObject({ head, ok: false, reason: 'truncated-history' });
    });
    it('a shallow boundary stops the planner replacing the durable count with zero', () => {
      const result = plan({ ...pr, roundCommits: { head, commits: shallow } });
      expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'cap-exhausted', attempts: 6 }));
    });
  });
  describe('real fixes merged from a repair branch (--no-ff)', () => {
    // Six rounds: fix-begin, a fix commit on a repair branch off the PR head, a --no-ff merge of it back, re-arm.
    const sha = (n) => n.toString(16).padStart(40, '0');
    const baseTip = sha(0x1000);
    const line = []; const fixes = []; const cycles = [];
    let prev = baseTip;
    for (let i = 1; i <= 6; i += 1) {
      const fix = { sha: sha(0x2000 + i), parents: [prev], authoredAt: at(`11T0${i}:05:00`), subject: `PR #4914: fix — round ${i}` };
      const merge = { sha: sha(0x3000 + i), parents: [prev, fix.sha], authoredAt: at(`11T0${i}:06:00`), subject: `Merge branch 'repair-${i}'` };
      fixes.push(fix); line.unshift(merge); prev = merge.sha;
      cycles.push(begin(`11T0${i}:00:00`, 'fix-7'), comment(`11T0${i}:10:00`, REARM_COMMENT_MARKER));
    }
    const repairPr = { ...pr, number: 4914, headRefOid: line[0].sha, headRefName: 'lane/repair', baseRefName: 'main', comments: cycles };
    const exec = gitDouble([...line, ...fixes]);
    it('readRoundCommits marks a merge whose merged side is not upstream as bringing PR work', () => {
      const facts = readRoundCommits({ pr: repairPr, exec });
      expect(facts.commits.map((c) => c.sha)).toEqual(line.map((c) => c.sha));
      expect(facts.commits.every((c) => c.mergesPrWork === true)).toBe(true);
    });
    it('countRealFixRounds counts all six repair-branch rounds as spent', () => {
      expect(countRealFixRounds({ ...repairPr, roundCommits: readRoundCommits({ pr: repairPr, exec }) })).toMatchObject({ ok: true, real: 6, total: 6 });
    });
    it('the planner keeps the durable six attempts instead of refunding them', () => {
      const result = planReconcile({ prs: [{ ...repairPr, roundCommits: readRoundCommits({ pr: repairPr, exec }) }], agents: [],
        durableCounts: { 4914: 6 }, requiredChecks: ['test'], now: Date.parse(at('11T07:00:00')) });
      expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'cap-exhausted', attempts: 6 }));
    });
    it('a stacked PR (base is another lane) still counts repair-branch merges as spent', () => {
      const stacked = { ...repairPr, baseRefName: 'lane/parent' };
      const facts = readRoundCommits({ pr: stacked, exec });
      expect(countRealFixRounds({ ...stacked, roundCommits: facts })).toMatchObject({ ok: true, real: 6, total: 6 });
    });
    it('a merge of upstream main (merged side not in the PR range) is still refunded', () => {
      const upstream = line.map((m, i) => ({ ...m, parents: [m.parents[0], sha(0x4000 + i)], subject: 'Merge origin/main' }));
      const facts = readRoundCommits({ pr: { ...repairPr, headRefOid: upstream[0].sha }, exec: gitDouble(upstream) });
      expect(facts.commits.every((c) => c.mergesPrWork === false)).toBe(true);
      expect(countRealFixRounds({ ...repairPr, headRefOid: upstream[0].sha, roundCommits: facts })).toMatchObject({ ok: true, real: 0, total: 6 });
    });
    it('a merge commit without the merged-side evidence fails closed', () => {
      const facts = readRoundCommits({ pr: repairPr, exec });
      const stripped = { ...facts, commits: facts.commits.map(({ mergesPrWork, ...c }) => c) };
      expect(countRealFixRounds({ ...repairPr, roundCommits: stripped })).toMatchObject({ ok: false });
    });
  });
  describe('repairs folded into upstream merges (real git)', () => {
    // Six rounds: fix-begin, merge a newer origin/main with --no-commit, maybe edit, commit the merge, re-arm.
    // Built with plumbing in a throwaway repo so merge-tree and the tree reads run against real git.
    const dirs = [];
    afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
    const build = (variant) => {
      const cwd = mkdtempSync(join(tmpdir(), 'round-merge-')); dirs.push(cwd);
      const run = (args, { input, date } = {}) => execFileSync('git', args, { cwd, input, encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@t', ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) } }).trim();
      run(['init', '-q']);
      const blob = (text) => run(['hash-object', '-w', '--stdin'], { input: text });
      const tree = (files) => run(['mktree'], { input: Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([path, text]) => `100644 blob ${blob(text)}\t${path}\n`).join('') });
      const commit = (files, parents, subject, date) => run(['commit-tree', tree(files), ...parents.flatMap((p) => ['-p', p]), '-m', subject], { date });
      const baseFiles = { 'a.txt': 'base\n' };
      let upstream = commit(baseFiles, [], 'base', at('10T00:00:00'));
      let upstreamFiles = { ...baseFiles };
      let prFiles = { ...baseFiles, 'pr.txt': 'pr\n', [LANE_MANIFEST]: '{}\n' };
      let prev = commit(prFiles, [upstream], 'PR #4914: build', at('10T01:00:00'));
      const cycles = [];
      for (let i = 1; i <= 6; i += 1) {
        upstreamFiles = { ...upstreamFiles, [`u${i}.txt`]: `upstream ${i}\n` };
        upstream = commit(upstreamFiles, [upstream], `main ${i}`, at(`11T0${i}:01:00`));
        const merged = { ...prFiles, ...upstreamFiles };
        const date = at(`11T0${i}:05:00`);
        if (variant === 'drain') {
          // The drain rebase: main first, the branch last, and the transient lane manifest dropped.
          delete merged[LANE_MANIFEST];
          prev = commit(merged, [upstream, prev], 'drain: rebase lane/x onto origin/main, drop transient .lane-manifest.json', date);
        } else {
          if (variant === 'repair') merged[`fix-${i}.mjs`] = `export const fix = ${i};\n`;
          if (variant === 'revert-upstream') delete merged[`u${i}.txt`];
          // Only the manifest's deletion is excused: content smuggled into it is still the PR's own.
          if (variant === 'manifest-edit') merged[LANE_MANIFEST] = `{"fix":${i}}\n`;
          prev = commit(merged, [prev, upstream], 'Merge origin/main', date);
        }
        prFiles = merged;
        cycles.push(begin(`11T0${i}:00:00`, 'fix-7'), comment(`11T0${i}:10:00`, REARM_COMMENT_MARKER));
      }
      run(['update-ref', 'refs/remotes/origin/main', upstream]);
      const exec = (bin, args, opts) => (args[0] === 'fetch' ? '' : execFileSync(bin, args, { ...opts, cwd }));
      const mergePr = { ...pr, number: 4914, headRefOid: prev, headRefName: 'lane/x', baseRefName: 'main', comments: cycles };
      return { mergePr, roundCommits: readRoundCommits({ pr: mergePr, exec }) };
    };
    it.each([['repair', 6], ['revert-upstream', 6], ['manifest-edit', 6], ['clean', 0], ['drain', 0]])('a %s merge of origin/main counts %i spent rounds', (variant, real) => {
      const { mergePr, roundCommits } = build(variant);
      expect(roundCommits.commits.filter((c) => c.parents.length > 1).every((c) => c.mergesPrWork === (real > 0))).toBe(true);
      expect(countRealFixRounds({ ...mergePr, roundCommits })).toMatchObject({ ok: true, real, total: 6 });
    });
    it('the planner keeps the durable six attempts when every merge carried a repair', () => {
      const { mergePr, roundCommits } = build('repair');
      const result = planReconcile({ prs: [{ ...mergePr, roundCommits }], agents: [],
        durableCounts: { 4914: 6 }, requiredChecks: ['test'], now: Date.parse(at('11T07:00:00')) });
      expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'cap-exhausted', attempts: 6 }));
    });
    it('pins the dropped manifest to the drain rebase', () => { expect(LANE_MANIFEST).toBe(DRAIN_MANIFEST); });
  });
  it('walks the drain merge last parent, skips base-side commits, and uses author dates', () => {
    // The drain rebased this stacked PR onto main: main's tip is outside main..head but inside the stacked base range.
    const extra = { ...commits[0], sha: commits[7].parents[0], subject: 'base-only fix' };
    const exec = (bin, args) => {
      if (args[0] !== 'log') return gitDouble(commits)(bin, args);
      expect(args).toContain('--format=%H%x00%P%x00%T%x00%aI%x00%s');
      return gitDouble(args.at(-1).startsWith('origin/main..') ? commits : [...commits, extra])(bin, args);
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


describe('single-parent card squash round evidence', () => {
  const subject = 'drain: rebase lane/cards onto origin/main, drop transient .lane-manifest.json, squash to one commit';
  const parent = 'f'.repeat(40);
  const c = { ...commits[0], parents: [parent], subject };
  const patch = 'diff --git a/backlog/123-card.md b/backlog/123-card.md\n+card\n';
  const proof = { oldHead: parent, newHead: c.sha, patchHash: squashPatchHash(patch) };
  const marker = (extra = {}, author = 'chalbert') => ({ body: formatCardSquashMarker({ ...proof, ...extra }), author: { login: author } });
  function read({ files = 'backlog/123-card.md', upstream = true, headline = subject, markers = [marker()], resultMode = '100644', baseMode = '100644', treeFailure = false } = {}) {
    const exec = (_cmd, args) => {
      if (args[0] === 'fetch') return '';
      if (args[0] === 'log') return [c.sha, parent, treeOf(c), c.authoredAt, headline].join('\0');
      if (args[0] === 'ls-tree') {
        expect(args).toEqual(['ls-tree', '-r', '-z', args[3], '--', files]);
        if (treeFailure) throw new Error('unreadable tree');
        const mode = args[3] === c.sha ? resultMode : baseMode;
        return mode ? `${mode} ${mode === '160000' ? 'commit' : 'blob'} ${parent}\t${files}\0` : '';
      }
      if (args[0] === 'merge-base') { if (!upstream) throw new Error('not upstream'); return ''; }
      if (args[0] === 'diff') {
        if (args.includes('--binary')) { expect(args).toEqual(['diff', '--binary', '--no-renames', '-U0', parent, c.sha]); return patch; }
        expect(args).toEqual(['diff', '--name-only', '--no-renames', parent, c.sha]); return files;
      }
      throw new Error(`unexpected ${args}`);
    };
    return readRoundCommits({ pr: { ...pr, comments: [...pr.comments, ...markers], baseRefName: 'main' }, exec });
  }
  it('only exact subjects, an upstream parent and a nonempty all-card diff establish mechanicalSquash', () => {
    expect(read().commits[0].mechanicalSquash).toBe(true);
    for (const options of [{ files: 'code.js' }, { files: '' }, { upstream: false }, { headline: `${subject}, borrowed` }])
      expect(read(options).commits[0].mechanicalSquash).toBe(false);
  });
  it.each([[], [marker({}, 'outsider')], [marker({ patchHash: '0'.repeat(64) })], [marker({ newHead: parent })]].map(markers => ({ markers })))('forged or mismatched proof counts real: %j', ({ markers }) => {
    const facts = read({ markers });
    expect(facts.commits[0].mechanicalSquash).toBe(false);
    expect(countRealFixRounds({ ...pr, comments: [comment('11T06:06:06', REARM_COMMENT_MARKER), ...markers], roundCommits: facts })).toMatchObject({ ok: true, real: 1 });
  });
  it.each([
    ...['120000', '160000', '100755'].flatMap(mode => [{ resultMode: mode }, { baseMode: mode }]),
    { resultMode: '' }, { treeFailure: true },
  ])('card-shaped non-regular entries remain real fix work: %j', options => {
    const facts = read(options);
    expect(facts.commits[0].mechanicalSquash).toBe(false);
    expect(countRealFixRounds({ ...pr, comments: [comment('11T06:06:06', REARM_COMMENT_MARKER), marker()], roundCommits: facts })).toMatchObject({ ok: true, real: 1 });
  });
  it('a newly added regular card can be mechanical', () => {
    expect(read({ baseMode: '' }).commits[0].mechanicalSquash).toBe(true);
  });
  it('reconcile refuses to refund a flagged squash without its trusted marker', () => {
    expect(countRealFixRounds({ ...pr, comments: [comment('11T06:06:06', REARM_COMMENT_MARKER)],
      roundCommits: { head, commits: [{ ...c, mechanicalSquash: true }] } })).toMatchObject({ ok: true, real: 1 });
  });
  it('refunds only the validated boolean true; plain single-parent drain subjects remain real', () => {
    for (const mechanicalSquash of [true, false, undefined]) {
      const result = countRealFixRounds({ ...pr, comments: [comment('11T06:06:06', REARM_COMMENT_MARKER), marker()],
        roundCommits: { head, commits: [{ ...c, mechanicalSquash }] } });
      expect(result).toMatchObject({ ok: true, real: mechanicalSquash === true ? 0 : 1 });
    }
  });
  it.each([{ mechanicalSquash: 'true' }, { mechanicalSquash: true, subject: 'fix' },
    { mechanicalSquash: true, parents: [parent, 'e'.repeat(40)], mergesPrWork: false }])('rejects malformed squash facts: %j', bad => {
    expect(countRealFixRounds({ ...pr, roundCommits: { head, commits: [{ ...c, ...bad }] } })).toMatchObject({ ok: false, reason: 'invalid-commit' });
  });
});
