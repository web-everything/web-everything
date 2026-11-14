// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideDelegableFinalApproval as decide, resolveDelegableFinalApproval as resolve, runDelegableFinalApprovalPass as run, readDelegableApprovalShape as readShape } from '../delegable-final-approval.mjs';

const head = 'a'.repeat(40);
const other = 'b'.repeat(40);
const comment = body => ({ author: { login: 'web-everything' }, body });
const fixture = () => ({ enabled: true, clearerId: 'daemon-session', shape: { humanRequired: false }, pr: {
  number: 42, state: 'OPEN', headRefOid: head, baseRefName: 'main', commentsComplete: true, body: '<!-- authored-by-actor: author-session -->',
  labels: ['review:human', 'advisory:accepted', 'red-team:clear'], requiredChecks: ['test'],
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  comments: [comment(`**Verdict:** accept\nNet basis: \`${other}..${head}\`\n<!-- reviewed-sha: ${head} -->`),
    comment(`<!-- we:red-team-advisory pr=42 rev=${head} -->\nAdvisory only: red team · recorded verdict \`accept\`.\nThe red team tried to break this change and reported nothing.`)],
} });

describe('delegable final approval', () => {
  it('clears an eligible exact head with an R612 instruction', () => {
    expect(decide(fixture())).toMatchObject({ clear: true, instruction: expect.stringMatching(new RegExp(`R612.*${head}`)) });
  });
  it.each([
    ['human surface', f => { f.shape.humanRequired = true; }],
    ['unknown shape', f => { f.shape = null; }],
    ['moved head', f => { f.pr.headRefOid = other; }],
    ['short advisory head', f => { f.pr.comments[0].body = f.pr.comments[0].body.replace(head, head.slice(0, 8)); }],
    ['red team pending', f => { f.pr.labels.push('red-team:pending'); }],
    ['missing red team result', f => { f.pr.comments.pop(); }],
    ['incomplete red team result', f => { f.pr.comments[1].body = `<!-- we:red-team-advisory pr=42 rev=${head} -->`; }],
    ['red team result on another head', f => { f.pr.comments[1].body = f.pr.comments[1].body.replace(head, other); }],
    ['untrusted red team result', f => { f.pr.comments[1].author.login = 'attacker'; }],
    ['unresolved break', f => { f.pr.comments[1].body += '\n1. [**confirmed**] (edge-case, broken) `x:1` — break'; }],
    ['red CI', f => { f.pr.statusCheckRollup[0].conclusion = 'FAILURE'; }],
    ['missing CI', f => { f.pr.statusCheckRollup = []; }],
    ['unknown required checks', f => { delete f.pr.requiredChecks; }],
    ['same actor', f => { f.clearerId = 'author-session'; }],
    ['empty clearer', f => { f.clearerId = ''; }],
    ['missing author stamp', f => { f.pr.body = ''; }],
    ['setting off', f => { f.enabled = false; }],
    ['missing human label', f => { f.pr.labels = f.pr.labels.slice(1); }],
    ['closed PR', f => { f.pr.state = 'CLOSED'; }],
    ['already cleared', f => { f.pr.comments.push({ id: 'IC_clearance', author: { login: 'chalbert', __typename: 'User' }, body: `<!-- reviewed-sha: ${head} -->\n<!-- cleared-human: operator -->` }); }],
    ['forged acceptance', f => { f.pr.comments[0].author.login = 'attacker'; }],
    ['newer changes advisory', f => { f.pr.comments.push(comment(`**Verdict:** changes\nNet basis: \`${other}..${head}\``)); }],
  ])('refuses %s', (_name, mutate) => {
    const f = fixture(); mutate(f);
    expect(decide(f)).toMatchObject({ clear: false, reason: expect.any(String), instruction: null });
  });
});

describe('setting resolution', () => {
  const read = value => () => JSON.stringify(value);
  it('defaults off on missing file', () => {
    expect(resolve({ env: {}, readFile: () => { throw Error('missing'); } })).toEqual({ enabled: false, source: 'standard' });
  });
  it('reads the platform key', () => {
    expect(resolve({ env: {}, readFile: read({ review: { delegableFinalApproval: true } }) })).toEqual({ enabled: true, source: 'platform' });
  });
  it.each(['on', 'true', '1', 'off', 'false', '0'])('env override %s', value => {
    expect(resolve({ env: { WE_REVIEW_DELEGABLE_FINAL_APPROVAL: value }, readFile: read({ review: { delegableFinalApproval: true } }) }))
      .toEqual({ enabled: ['on', 'true', '1'].includes(value), source: 'env' });
  });
  it('malformed env disables an enabled platform', () => {
    expect(resolve({ env: { WE_REVIEW_DELEGABLE_FINAL_APPROVAL: 'oops' }, readFile: read({ review: { delegableFinalApproval: true } }) })).toEqual({ enabled: false, source: 'env' });
  });
  it('malformed platform and JSON fail closed', () => {
    expect(resolve({ env: {}, readFile: read({ review: { delegableFinalApproval: 'oops' } }) }).enabled).toBe(false);
    expect(resolve({ env: {}, readFile: () => '{' }).enabled).toBe(false);
  });
});

describe('IO pass', () => {
  const deps = () => ({ repos: ['o/r'], setting: { enabled: true, source: 'env' }, clearerId: 'daemon-session',
    readPrs: vi.fn(() => [fixture().pr]), readRequiredChecks: () => ({ checks: ['test'], source: 'live' }),
    readLiveHead: vi.fn(({ pr }) => ({ ...fixture().pr, number: pr.number })), readRedTeamHold: vi.fn(() => false),
    readComments: vi.fn(({ pr }) => {
      const comments = fixture().pr.comments;
      comments[1].body = comments[1].body.replace('pr=42', `pr=${pr.number}`);
      return comments;
    }),
    readShape: vi.fn(() => ({ humanRequired: false })), clear: vi.fn(), log: vi.fn() });
  it('disabled reads nothing', async () => {
    const d = deps(); d.setting.enabled = false;
    await run(d);
    expect(d.readPrs).not.toHaveBeenCalled(); expect(d.readShape).not.toHaveBeenCalled(); expect(d.clear).not.toHaveBeenCalled();
    expect(d.readLiveHead).not.toHaveBeenCalled(); expect(d.readRedTeamHold).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith('review-daemon: delegable-final-approval enabled=false (env)');
  });
  it('passes only supported clear-human flags and head-scoped judge delegation through execFile argv', async () => {
    const d = deps(); delete d.clear; const exec = vi.fn();
    await run({ ...d, exec });
    expect(exec).toHaveBeenCalledWith(process.execPath, expect.arrayContaining([
      'scripts/review-set-label.mjs', '42', '--repo=o/r', '--to=clear-human', '--actor=review-daemon', '--approval-kind=judge',
    ]), expect.objectContaining({ maxBuffer: expect.any(Number) }));
    const args = exec.mock.calls[0][1];
    expect(args).toContain(`--expect-head=${head}`);
    expect(exec.mock.calls[0][2].env.CLAUDE_CODE_SESSION_ID).toBe('daemon-session');
    expect(args.find(a => a.startsWith('--reason='))).toContain('R612');
    expect(JSON.parse(args.find(a => a.startsWith('--delegation-json=')).split('=').slice(1).join('='))).toMatchObject({ by: expect.stringContaining('R612'), scope: expect.stringContaining(head), expires: expect.any(String) });
  });
  it('isolates a failed clear', async () => {
    const d = deps(); const second = fixture().pr;
    second.number = 43; second.comments[1].body = second.comments[1].body.replace('pr=42', 'pr=43');
    d.readPrs.mockReturnValue([fixture().pr, second]);
    d.clear.mockImplementationOnce(() => { throw Error('writer refused'); });
    await run(d);
    expect(d.clear).toHaveBeenCalledTimes(2);
    expect(d.log).toHaveBeenCalledWith('review-daemon: delegable-final-approval PR#43 cleared');
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('PR#42 skipped('));
  });
  it('rechecks the live head immediately before clear and skips head-moved', async () => {
    const d = deps(); d.readLiveHead.mockReturnValue({ headRefOid: other, baseRefName: 'main', state: 'OPEN', labels: fixture().pr.labels });
    await run(d);
    expect(d.readShape).toHaveBeenCalledOnce(); expect(d.readLiveHead).toHaveBeenCalledOnce();
    expect(d.clear).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith('review-daemon: delegable-final-approval PR#42 skipped(head-moved)');
  });
  it('refuses a retargeted PR with an unchanged head', async () => {
    const d = deps();
    d.readLiveHead.mockReturnValue({ headRefOid: head, baseRefName: 'release/1.0', state: 'OPEN', labels: fixture().pr.labels });
    await run(d);
    expect(d.readShape).toHaveBeenCalledWith(expect.objectContaining({ pr: expect.objectContaining({ headRefOid: head, baseRefName: 'main' }) }));
    expect(d.readLiveHead).toHaveBeenCalledOnce();
    expect(d.clear).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith('review-daemon: delegable-final-approval PR#42 skipped(target-moved)');
  });
  it('refuses retargeting at the initial live read when discovery omits state', async () => {
    const d = deps(); const pr = fixture().pr; delete pr.state; d.readPrs.mockReturnValue([pr]);
    d.readLiveHead.mockReturnValue({ headRefOid: head, baseRefName: 'release/1.0', state: 'OPEN', labels: pr.labels });
    await run(d);
    expect(d.readShape).not.toHaveBeenCalled(); expect(d.clear).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith('review-daemon: delegable-final-approval PR#42 skipped(target-moved)');
  });
  it.each([undefined, ''])('unreadable live target %s retains human review', async baseRefName => {
    const d = deps();
    d.readLiveHead.mockReturnValue({ headRefOid: head, baseRefName, state: 'OPEN', labels: fixture().pr.labels });
    await run(d); expect(d.clear).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith('review-daemon: delegable-final-approval PR#42 skipped(unknown-target)');
  });
  it('reads the live target together with the head, state and labels', async () => {
    const d = deps(); delete d.readLiveHead;
    const exec = vi.fn(() => JSON.stringify(fixture().pr));
    await run({ ...d, exec });
    expect(exec).toHaveBeenCalledWith('gh', ['pr', 'view', '42', '--repo=o/r', '--json', 'headRefOid,baseRefName,state,labels,body,statusCheckRollup'], expect.any(Object));
    expect(d.clear).toHaveBeenCalledOnce();
  });
  it('orders the full fresh eligibility reads immediately before clear', async () => {
    const order = []; const d = deps();
    d.readComments.mockImplementation(() => { order.push('comments'); return fixture().pr.comments; });
    d.readRequiredChecks = () => { order.push('checks'); return { checks: ['test'] }; };
    d.readRedTeamHold.mockImplementation(() => { order.push('red-team'); return false; });
    d.readShape.mockImplementation(() => { order.push('shape'); return { humanRequired: false }; });
    d.readLiveHead.mockImplementation(() => { order.push('live'); return fixture().pr; });
    d.clear.mockImplementation(() => { order.push('clear'); });
    await run(d); expect(order).toEqual(['comments', 'checks', 'shape', 'red-team', 'live', 'comments', 'checks', 'shape', 'red-team', 'clear']);
  });
  it.each([
    ['closed', { headRefOid: head, baseRefName: 'main', state: 'CLOSED', labels: fixture().pr.labels }],
    ['labels unreadable', { headRefOid: head, baseRefName: 'main', state: 'OPEN' }],
    ['human label removed', { headRefOid: head, baseRefName: 'main', state: 'OPEN', labels: [] }],
    ['red team pending', { headRefOid: head, baseRefName: 'main', state: 'OPEN', labels: [...fixture().pr.labels, 'red-team:pending'] }],
    ['head unreadable', null],
  ])('refuses live evidence: %s', async (_name, live) => {
    const d = deps(); d.readLiveHead.mockReturnValue(live);
    await run(d); expect(d.clear).not.toHaveBeenCalled();
  });
  it('an unreadable live-head read leaves the hold intact', async () => {
    const d = deps(); d.readLiveHead.mockImplementation(() => { throw Error('unreadable head'); });
    await run(d); expect(d.clear).not.toHaveBeenCalled();
  });
  it('proves state for shared discovery rows that omit it', async () => {
    const d = deps(); const pr = fixture().pr; delete pr.state; d.readPrs.mockReturnValue([pr]);
    await run(d); expect(d.readLiveHead).toHaveBeenCalledTimes(2); expect(d.clear).toHaveBeenCalledOnce();
  });
  it('unknown required-check configuration refuses clear', async () => {
    const d = deps(); d.readRequiredChecks = () => { throw Error('unreadable protection'); };
    await run(d); expect(d.clear).not.toHaveBeenCalled();
  });
  it('incomplete comment evidence must be read completely or refuse', async () => {
    const d = deps(); const pr = fixture().pr; delete pr.commentsComplete; d.readPrs.mockReturnValue([pr]);
    const readComments = vi.fn(() => { throw Error('comments incomplete'); });
    await run({ ...d, readComments }); expect(readComments).toHaveBeenCalledOnce(); expect(d.clear).not.toHaveBeenCalled();
  });
  it('a persisted red-team hold refuses clear', async () => {
    const d = deps(); d.readRedTeamHold.mockReturnValue(true);
    await run(d); expect(d.clear).not.toHaveBeenCalled();
  });
  it('bounds candidates and names the operator fallback', async () => {
    const d = deps(); d.readPrs.mockReturnValue([fixture().pr, { ...fixture().pr, number: 43 }]);
    await run({ ...d, maxCandidates: 1 }); expect(d.clear).toHaveBeenCalledOnce();
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('PR#43 skipped(candidate-budget; operator must review remaining PRs)'));
  });
  it('shares a GitHub-call budget across injected readers and names the fallback', async () => {
    const d = deps(); const exec = vi.fn(() => '');
    d.readLiveHead.mockImplementation(({ exec: run }) => { run('gh', ['pr', 'view', '42']); return { headRefOid: head, baseRefName: 'main', state: 'OPEN', labels: fixture().pr.labels }; });
    await run({ ...d, exec, maxGhCalls: 0 }); expect(exec).not.toHaveBeenCalled(); expect(d.clear).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('GitHub budget exceeded; operator must review remaining PRs'));
  });
  it('sanitizes untrusted errors in logs', async () => {
    const d = deps(); d.readShape.mockImplementation(() => { throw Error('bad\x1b[31m\nerror'); });
    await run(d); expect(d.log.mock.calls.every(([line]) => !/[\x00-\x1f\x7f-\x9f]/.test(line))).toBe(true);
  });
  it('unreadable/oversized diff retains human review and continues', async () => {
    const d = deps(); d.readShape.mockImplementation(() => { throw Error('diff bound exceeded; operator must review full diff'); });
    await run(d); expect(d.clear).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('operator must review full diff'));
  });
  it.each([
    ['author changed to clearer', pr => { pr.body = '<!-- authored-by-actor: daemon-session -->'; }],
    ['author stamp removed', pr => { pr.body = ''; }],
    ['author body unreadable', pr => { delete pr.body; }],
    ['CI turned red', pr => { pr.statusCheckRollup[0].conclusion = 'FAILURE'; }],
    ['CI disappeared', pr => { delete pr.statusCheckRollup; }],
  ])('fresh full decision refuses when %s', async (_name, mutate) => {
    const d = deps(); const live = fixture().pr; mutate(live); d.readLiveHead.mockReturnValue(live);
    await run(d); expect(d.clear).not.toHaveBeenCalled();
  });
  it.each([
    ['new changes advisory', comments => comments.push(comment(`**Verdict:** changes\nNet basis: \`${other}..${head}\``))],
    ['acceptance removed', comments => comments.shift()],
    ['red-team result removed', comments => comments.pop()],
    ['new unresolved red-team break', comments => { comments[1].body += '\n1. [**confirmed**] (edge-case, broken) `x:1` — break'; }],
    ['human already cleared', comments => comments.push({ author: { login: 'chalbert', __typename: 'User' }, body: `<!-- reviewed-sha: ${head} -->\n<!-- cleared-human: operator -->` })],
  ])('fresh comments refuse %s even when discovery commentsComplete=true', async (_name, mutate) => {
    const d = deps(); const comments = fixture().pr.comments; mutate(comments);
    d.readComments.mockImplementation(({ pr }) => pr.commentsComplete === true ? fixture().pr.comments : comments);
    await run(d); expect(d.clear).not.toHaveBeenCalled();
    expect(d.readComments).toHaveBeenCalledTimes(2);
    expect(d.readComments).toHaveBeenLastCalledWith(expect.objectContaining({ pr: expect.objectContaining({ commentsComplete: false }) }));
  });
  it('fresh required-check configuration is re-read rather than reused from the branch cache', async () => {
    const d = deps(); d.readRequiredChecks = vi.fn().mockReturnValueOnce({ checks: ['test'] }).mockReturnValueOnce({ checks: ['new-required'] });
    await run(d); expect(d.clear).not.toHaveBeenCalled(); expect(d.readRequiredChecks).toHaveBeenCalledTimes(2);
  });
  it('fresh shape is recomputed and can require human review on the same head', async () => {
    const d = deps(); d.readShape.mockReturnValueOnce({ humanRequired: false }).mockReturnValueOnce({ humanRequired: true });
    await run(d); expect(d.clear).not.toHaveBeenCalled(); expect(d.readShape).toHaveBeenCalledTimes(2);
  });
  it('fresh red-team stored evidence is re-read and can hold the same head', async () => {
    const d = deps(); d.readRedTeamHold.mockReturnValueOnce(false).mockReturnValueOnce(true);
    await run(d); expect(d.clear).not.toHaveBeenCalled(); expect(d.readRedTeamHold).toHaveBeenCalledTimes(2);
  });
  it('fresh deviation disclosure reaches the recomputed shape before clearance', async () => {
    const d = deps(); d.readLiveHead.mockReturnValue({ ...fixture().pr, body: `Deviation: bypassed a rule\n${fixture().pr.body}` });
    d.readShape.mockImplementation(({ pr }) => ({ humanRequired: pr.body.startsWith('Deviation:') }));
    await run(d); expect(d.clear).not.toHaveBeenCalled(); expect(d.readShape).toHaveBeenCalledTimes(2);
  });
  it('passes the fresh author body, complete comments and CI evidence to both the shape reader and writer', async () => {
    const d = deps(); const live = fixture().pr; live.body += '\nFresh operator note';
    d.readLiveHead.mockReturnValue(live);
    await run(d);
    expect(d.readShape).toHaveBeenLastCalledWith(expect.objectContaining({ pr: expect.objectContaining({ body: live.body, commentsComplete: false }) }));
    expect(d.clear).toHaveBeenCalledWith(expect.objectContaining({ pr: expect.objectContaining({
      body: live.body, headRefOid: head, comments: live.comments, requiredChecks: ['test'], statusCheckRollup: live.statusCheckRollup, commentsComplete: false,
    }) }));
  });
  it.each(['readComments', 'readRequiredChecks', 'readShape', 'readRedTeamHold'])('failed fresh %s refuses clear', async reader => {
    const d = deps(); const original = d[reader];
    d[reader] = vi.fn().mockImplementationOnce(original).mockImplementationOnce(() => { throw Error('fresh evidence unreadable'); });
    await run(d); expect(d.clear).not.toHaveBeenCalled(); expect(d[reader]).toHaveBeenCalledTimes(2);
  });
});

describe('real net diff reader with injected git IO', () => {
  const input = () => ({ repo: 'web-everything/web-everything', pr: fixture().pr });
  it.each(['Deviation: bypassed a rule', 'Deviation:'])('disclosed deviation %s forces human review despite ordinary net files', body => {
    const exec = vi.fn().mockReturnValueOnce(other).mockReturnValueOnce('README.md\0')
      .mockReturnValueOnce('diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n');
    const score = vi.fn(({ deviation }) => ({ humanRequired: Boolean(deviation) }));
    expect(readShape({ ...input(), pr: { ...fixture().pr, body }, exec, score }).humanRequired).toBe(true);
    expect(score).toHaveBeenCalledWith(expect.objectContaining({ deviation: expect.any(String) }));
  });
  it('scores merge-base net files and hunks rather than PR summary files', () => {
    const score = vi.fn(() => ({ humanRequired: false }));
    const exec = vi.fn().mockReturnValueOnce(other).mockReturnValueOnce('README.md\0')
      .mockReturnValueOnce('diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n');
    const result = readShape({ ...input(), pr: { ...fixture().pr, files: ['misleading-summary.md'] }, exec, score });
    expect(result.humanRequired).toBe(false);
    expect(score).toHaveBeenCalledWith({ changedFiles: ['README.md'], diffHunks: expect.stringContaining('+new'), deviation: null });
    expect(exec.mock.calls.map(call => call[1])).toEqual([
      ['merge-base', 'origin/main', head], ['diff', '--name-only', '-z', '--no-renames', other, head],
      ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', other, head],
    ]);
  });
  it('scores divergent target history including human-surface changes already present on main', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'delegable-target-history-'));
    const git = args => execFileSync('git', [
      '-c', 'init.templateDir=', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
      '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args,
    ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, maxBuffer: 1024 * 1024 });
    const surface = 'scripts/lib/delivery-platform-preferences.json';
    try {
      git(['init', '-b', 'main']);
      mkdirSync(join(cwd, 'scripts/lib'), { recursive: true });
      writeFileSync(join(cwd, surface), '{"review":{"delegableFinalApproval":false}}\n');
      writeFileSync(join(cwd, 'README.md'), 'base\n');
      git(['add', '.']); git(['commit', '-m', 'common ancestor']);
      git(['checkout', '-b', 'release/1.0']);
      writeFileSync(join(cwd, 'RELEASE.md'), 'target-only history\n');
      git(['add', '.']); git(['commit', '-m', 'target diverges']);
      git(['update-ref', 'refs/remotes/origin/release/1.0', 'HEAD']);
      git(['checkout', 'main']);
      writeFileSync(join(cwd, surface), '{"review":{"delegableFinalApproval":true}}\n');
      git(['add', '.']); git(['commit', '-m', 'human-surface change on main']);
      git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      git(['checkout', '-b', 'proposed']);
      writeFileSync(join(cwd, 'README.md'), 'proposal\n');
      git(['add', '.']); git(['commit', '-m', 'proposal inherits main']);
      const headRefOid = git(['rev-parse', 'HEAD']).trim();
      const exec = vi.fn((file, args) => { expect(file).toBe('git'); return git(args); });
      const score = vi.fn(({ changedFiles }) => ({ humanRequired: changedFiles.includes(surface) }));
      const options = { ...input(), pr: { ...fixture().pr, headRefOid }, exec, score };
      expect(readShape(options).humanRequired).toBe(false);
      expect(score).toHaveBeenLastCalledWith({ changedFiles: ['README.md'], diffHunks: expect.any(String), deviation: null });
      score.mockClear();
      expect(readShape({ ...options, pr: { ...options.pr, baseRefName: 'release/1.0' } }).humanRequired).toBe(true);
      expect(exec).toHaveBeenCalledWith('git', ['merge-base', 'origin/release/1.0', headRefOid], expect.any(Object));
      expect(score).toHaveBeenCalledOnce();
      expect(score).toHaveBeenCalledWith({
        changedFiles: expect.arrayContaining(['README.md', surface]),
        diffHunks: expect.stringContaining('+{"review":{"delegableFinalApproval":true}}'),
        deviation: null,
      });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it.each([undefined, ''])('missing target branch %s refuses classification before git IO', baseRefName => {
    const exec = vi.fn();
    expect(() => readShape({ ...input(), pr: { ...fixture().pr, baseRefName }, exec })).toThrow('unknown diff basis; operator must review full diff');
    expect(exec).not.toHaveBeenCalled();
  });
  it('oversized output retains review with an operator fallback', () => {
    const exec = vi.fn().mockReturnValueOnce(other).mockReturnValueOnce('x'.repeat(8 * 1024 * 1024));
    expect(() => readShape({ ...input(), exec })).toThrow('operator must review full diff');
  });
  it('1025 changed paths retain review with an operator fallback', () => {
    const exec = vi.fn().mockReturnValueOnce(other).mockReturnValueOnce(Array.from({ length: 1025 }, (_, i) => `f${i}`).join('\0'));
    expect(() => readShape({ ...input(), exec })).toThrow('file bound exceeded; operator must review full diff');
  });
  it('unreadable merge base refuses shape', () => {
    expect(() => readShape({ ...input(), exec: () => '' })).toThrow('operator must review full diff');
  });
});
