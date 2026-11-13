import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { classifyPr, decideDrainReviewGate, applyEscalationRelief, buildDrainVerdicts } from '../merge-ai-prs.mjs';
import { LISTED_FILES_CAP } from '../lib/red-main-quarantine.mjs';

const fixtures = [
  { number: 4816, headRefOid: '5827924d2652dfd2434ced1ca94d2b9603c08ea3',
    labels: ['ready-to-merge', 'review:accepted', 'review-round:5', 'status:ready-to-merge'],
    files: ['.github/workflows/ci.yml', '.github/workflows/merge-gate.yml', '.github/workflows/soak-replay-gate.yml', 'AGENTS.md', 'scripts/ci/quarantine-skip.mjs', ...Array.from({ length: LISTED_FILES_CAP }, (_, i) => `docs/file-${i}.md`)] },
  { number: 4876, headRefOid: '12583c4873a3004e57db7cae44ac0117f11646f7',
    labels: ['ready-to-merge', 'review:accepted', 'review-round:1'],
    files: ['.github/workflows/merge-gate.yml', 'scripts/lib/__tests__/merge-gate-ci.test.mjs', 'scripts/lib/merge-gate-ci.mjs'] },
];
function replay(pr, { setting, clearance, author = 'chalbert', ...extra } = {}) {
  const comments = [{ author: { login: 'web-everything' }, body: `<!-- reviewed-sha: ${pr.headRefOid} -->` }];
  if (clearance) comments.push({ author: { login: author }, body: `<!-- reviewed-sha: ${clearance} -->\n<!-- cleared-human: operator -->` });
  const repo = 'web-everything/web-everything';
  const [v] = buildDrainVerdicts({ prsByRepo: new Map([[repo, [pr]]]), repos: [repo], readOf: () => ({}) });
  return decideDrainReviewGate({ labels: v.prLabels, escalate: true }, {
    pr: pr.number, repo, local: true, cwd: '/fixture', defaultBranch: 'trunk', files: v.listedFiles, filesComplete: v.listedFilesComplete,
    workflowEditSetting: setting, listedHeadSha: v.listedHeadSha,
    exec: (cmd, args) => cmd === 'gh' ? JSON.stringify({ headRefOid: pr.headRefOid, comments })
      : args[0] === 'diff' ? pr.files.join('\0') + '\0' : '', ...extra,
  });
}
describe('live workflow-edit replay', () => {
  const blockedPr = (extra = {}) => ({ ...fixtures[1], body: 'Workflow update', mergeable: 'MERGEABLE',
    mergeStateStatus: 'BLOCKED', statusCheckRollup: [
      { name: 'test', conclusion: 'SUCCESS' }, { name: 'merge-gate', conclusion: 'FAILURE' },
    ], ...extra });
  it.each(['test', 'merge-gate'])('admits skipped accepted workflow PRs for repark (required %s)', (requiredCheck) => {
    const pr = blockedPr();
    expect(classifyPr(pr, { requiredCheck })).toMatchObject({ decision: 'skip', workflowHoldRepark: true });
    expect(replay(pr)).toMatchObject({ action: 'park', workflowEditHold: true, applyLabel: 'review:human' });
    const cleared = replay(pr, { clearance: pr.headRefOid });
    expect(cleared.action).toBe('merge');
    expect(cleared.workflowEditHold).toBeUndefined();
    expect(cleared.applyLabel).toBeFalsy();
  });
  it.each([
    { labels: ['ready-to-merge', 'review:accepted', 'review:human'] },
    { labels: ['ready-to-merge'] },
    { statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE' }] },
    { mergeStateStatus: 'BEHIND' },
    { mergeable: 'CONFLICTING' },
    { baseRefName: 'lane/stack' },
    { requiredCheckReadError: 'unreadable checks' },
  ])('does not broaden other skip paths: %j', (extra) => {
    expect(classifyPr(blockedPr(extra)).workflowHoldRepark).toBeUndefined();
  });
  for (const requiredCheck of ['test', 'merge-gate']) {
    it.each([
      ['conflicting', { mergeable: 'CONFLICTING' }],
      ['unknown mergeability', { mergeable: 'UNKNOWN' }],
      ['behind', { mergeStateStatus: 'BEHIND' }],
      ['dirty', { mergeStateStatus: 'DIRTY' }],
      ['unknown state', { mergeStateStatus: 'UNKNOWN' }],
      ['human hold', { labels: ['review:accepted', 'review:human'] }],
      ['non-default base', { baseRefName: 'release' }],
      ['merge-gate passing', { statusCheckRollup: [
        { name: 'test', conclusion: 'SUCCESS' }, { name: 'merge-gate', conclusion: 'SUCCESS' },
      ] }],
      ['merge-gate pending', { statusCheckRollup: [
        { name: 'test', conclusion: 'SUCCESS' }, { name: 'merge-gate', status: 'IN_PROGRESS' },
      ] }],
      ['test also failing', { statusCheckRollup: [
        { name: 'test', conclusion: 'FAILURE' }, { name: 'merge-gate', conclusion: 'FAILURE' },
      ] }],
      ['test missing', { statusCheckRollup: [{ name: 'merge-gate', conclusion: 'FAILURE' }] }],
      ['CodeQL failing', { statusCheckRollup: [
        { name: 'test', conclusion: 'SUCCESS' }, { name: 'merge-gate', conclusion: 'FAILURE' },
        { name: 'CodeQL', conclusion: 'FAILURE' },
      ] }],
    ])(`classifyPr refuses repark for %s (required ${requiredCheck})`, (_name, extra) => {
      const verdict = classifyPr(blockedPr(extra), { requiredCheck, defaultBranch: 'trunk', blockOnCodeQL: true });
      expect(verdict.decision).toBe('skip');
      expect(verdict.workflowHoldRepark).toBeUndefined();
      if (requiredCheck === 'merge-gate' && !['merge-gate passing'].includes(_name)) {
        expect(verdict.reason).toBe(extra.baseRefName ? 'base is not trunk (release)' : 'required check "merge-gate" is not green');
      }
    });
    it(`requires every additional required check to pass (required ${requiredCheck})`, () => {
      const pr = blockedPr();
      const options = { requiredCheck, queueRequiredChecks: ['test', 'merge-gate', 'smoke'] };
      expect(classifyPr(pr, options).workflowHoldRepark).toBeUndefined();
      pr.statusCheckRollup.push({ name: 'smoke', conclusion: 'FAILURE' });
      expect(classifyPr(pr, options).workflowHoldRepark).toBeUndefined();
      pr.statusCheckRollup[2].conclusion = 'SUCCESS';
      expect(classifyPr(pr, options).workflowHoldRepark).toBe(true);
    });
  }
  it('runCli pass filter admits workflowHoldRepark skips alongside merge and review-held verdicts', () => {
    const source = readFileSync('scripts/merge-ai-prs.mjs', 'utf8');
    expect(source).toContain("if (v.decision !== 'merge' && !v.reviewHeld && !v.workflowHoldRepark) continue;");
  });
  for (const changeType of ['RENAMED', 'COPIED', undefined]) {
    for (const workflowOnly of [false, true]) {
      it(`reads both paths for ${changeType ?? 'untyped'} listing entries (bare sweep: ${workflowOnly})`, () => {
        const pr = { ...fixtures[1], files: [{ path: 'docs/ci.yml.bak', ...(changeType ? { changeType } : {}) }] };
        const calls = [];
        const result = replay(pr, { workflowOnly, exec: (cmd, args) => {
          calls.push([cmd, args]);
          if (cmd === 'gh') return JSON.stringify({ headRefOid: pr.headRefOid,
            comments: [{ author: { login: 'web-everything' }, body: `<!-- reviewed-sha: ${pr.headRefOid} -->` }] });
          return args[0] === 'diff' ? '.github/workflows/ci.yml\0docs/ci.yml.bak\0' : '';
        } });
        expect(result).toMatchObject({ action: 'park', applyLabel: 'review:human', humanRequired: true });
        expect(calls.find(([, args]) => args[0] === 'diff')?.[1]).toContain('--no-renames');
      });
    }
  }
  for (const pr of fixtures) it(`#${pr.number}: before (off) merge → default human-only hold → exact-head human clearance merge`, () => {
    expect(replay(pr, { setting: 'off' }).action).toBe('merge');
    const held = replay(pr);
    expect(held).toMatchObject({ action: 'park', applyLabel: 'review:human', humanRequired: true, reason: expect.stringContaining('human-only:') });
    expect(applyEscalationRelief(held, { relieved: true }).waive).toBe(false);
    expect(replay(pr, { clearance: pr.headRefOid }).action).toBe('merge');
  });
  it.each([false, true])('untyped non-local listing defers without git or labels (bare sweep: %s)', (workflowOnly) => {
    const pr = { ...fixtures[1], files: [{ path: 'docs/ci.yml.bak' }] };
    expect(replay(pr, { workflowOnly, local: false, exec: (cmd) => {
      expect(cmd).toBe('gh');
      return JSON.stringify({ headRefOid: pr.headRefOid, comments: [] });
    } })).toMatchObject({ action: 'defer', applyLabel: null });
  });
  it('an older human clearance remains human-only', () => {
    expect(replay(fixtures[0], { clearance: 'b'.repeat(40) })).toMatchObject({ action: 'park', humanRequired: true, reason: expect.stringContaining('human-only:') });
  });
  it('non-workflow acceptance still merges with the default enabled', () => {
    expect(replay({ ...fixtures[0], files: ['AGENTS.md', 'package.json'] }).action).toBe('merge');
  });
  it('untrusted marker cannot clear the workflow hold', () => {
    expect(replay(fixtures[0], { clearance: fixtures[0].headRefOid, author: 'mallory' }).action).toBe('park');
  });
  it('a capped non-workflow list merges after a full pinned read', () => {
    const files = Array.from({ length: LISTED_FILES_CAP + 5 }, (_, i) => `docs/${i}.md`);
    expect(replay({ ...fixtures[0], files }).action).toBe('merge');
  });
  it('full-list read errors defer without a label and name the error', () => {
    const calls = [];
    const result = replay(fixtures[0], { exec: (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'gh') return JSON.stringify({ headRefOid: fixtures[0].headRefOid, comments: [] });
      throw new Error('pinned fetch unavailable');
    } });
    expect(result).toMatchObject({ action: 'defer', applyLabel: null, reason: expect.stringContaining('pinned fetch unavailable') });
    expect(calls.filter(([cmd]) => cmd === 'gh')).toHaveLength(1);
  });
  it('non-local incomplete evidence defers without git or label writes', () => {
    let calls = 0;
    expect(replay(fixtures[0], { local: false, exec: (cmd) => {
      calls++;
      expect(cmd).toBe('gh');
      return JSON.stringify({ headRefOid: fixtures[0].headRefOid, comments: [] });
    } })).toMatchObject({ action: 'defer', applyLabel: null });
    expect(calls).toBe(1);
  });
  it('a different listing head reads the full change list at the acceptance head', () => {
    const calls = [];
    const result = replay({ ...fixtures[1], files: ['README.md'] }, {
      listedHeadSha: 'b'.repeat(40), exec: (cmd, args, opts) => {
        calls.push([cmd, args, opts.cwd]);
        if (cmd === 'gh') return JSON.stringify({ headRefOid: fixtures[1].headRefOid, comments: [] });
        return args[0] === 'diff' ? '.github/workflows/merge-gate.yml\0' : '';
      },
    });
    expect(result).toMatchObject({ action: 'park', applyLabel: 'review:human' });
    expect(calls.find(([, args]) => args[0] === 'diff')).toEqual(['git',
      ['diff', '--name-only', '--no-renames', '--no-relative', '-z', '--end-of-options', `refs/remotes/origin/trunk...${fixtures[1].headRefOid}`], '/fixture']);
  });
  it('bare sweep does no acceptance or git calls for complete non-workflow files', () => {
    let calls = 0;
    expect(replay({ ...fixtures[1], files: ['README.md'] }, { workflowOnly: true,
      exec: () => { calls++; throw new Error('unexpected read'); },
    }).action).toBe('merge');
    expect(calls).toBe(0);
  });
  it('bare/waived rubric still holds workflow edits and allows non-workflow edits', () => {
    expect(replay(fixtures[0], { workflowOnly: true }).action).toBe('park');
    expect(replay(fixtures[0], { workflowOnly: true, clearance: fixtures[0].headRefOid }).action).toBe('merge');
    expect(replay({ ...fixtures[0], files: ['README.md'] }, { workflowOnly: true }).action).toBe('merge');
  });
  it('exact-head human clearance does not waive other review gates', () => {
    expect(replay(fixtures[0], { clearance: fixtures[0].headRefOid, filesComplete: false, local: false }).action).toBe('defer');
    expect(replay({ ...fixtures[0], labels: ['review:changes'] }, { clearance: fixtures[0].headRefOid, files: ['README.md'] }).action).not.toBe('merge');
  });
  it('unreadable acceptance still defers without writing a label', () => {
    expect(replay(fixtures[0], { exec: () => { throw new Error('offline'); } })).toMatchObject({ action: 'defer', applyLabel: null });
  });
});

describe('refreshed PR: stale listing vs net diff', () => {
  const pr = { number: 6666, headRefOid: '5ab05b337d000000000000000000000000000000', labels: ['ready-to-merge', 'review:accepted'],
    files: ['.github/workflows/ci.yml', 'backlog/4456-x.md'] };
  const netExec = (net) => (cmd, args) => cmd === 'gh'
    ? JSON.stringify({ headRefOid: pr.headRefOid, comments: [{ author: { login: 'web-everything' }, body: `<!-- reviewed-sha: ${pr.headRefOid} -->` }] })
    : args[0] === 'diff' ? net : '';
  it('stale listing naming ci.yml does not hold when the net diff has no workflow path', () => {
    expect(replay(pr, { exec: netExec('backlog/4456-x.md\0') }).action).toBe('merge');
  });
  it('a real workflow edit in the net diff still holds, with the head sha in the message', () => {
    const r = replay(pr, { exec: netExec('.github/workflows/ci.yml\0') });
    expect(r).toMatchObject({ action: 'park', humanRequired: true });
    expect(r.reason).toContain('5ab05b337');
    expect(r.reason).not.toContain('unknown');
  });
  it('unreadable net diff keeps the hold (fail closed)', () => {
    const r = replay(pr, { exec: (cmd, args) => { if (cmd === 'git' && args[0] === 'diff') throw new Error('boom'); return netExec('')(cmd, args); } });
    expect(r).toMatchObject({ action: 'park', humanRequired: true });
  });
  it('empty net diff against a workflow listing keeps the hold', () => {
    expect(replay(pr, { exec: netExec('') }).action).toBe('park');
  });
});

it('unknown default branch keeps the listing hold (no net-diff clearing against a guessed base)', () => {
  const pr = { number: 6666, headRefOid: '5ab05b337d000000000000000000000000000000', labels: ['ready-to-merge', 'review:accepted'], files: ['.github/workflows/ci.yml'] };
  const comments = [{ author: { login: 'web-everything' }, body: `<!-- reviewed-sha: ${pr.headRefOid} -->` }];
  expect(replay(pr, { defaultBranch: undefined, exec: (cmd) => cmd === 'gh' ? JSON.stringify({ headRefOid: pr.headRefOid, comments }) : '' }).action).toBe('park');
});
