import { describe, it, expect, vi } from 'vitest';
import { backlogOnlyPrepClear, readHeadFiles, resolveBacklogOnlyPrepSetting, runBacklogOnlyPrep } from '../red-team-backlog-only.mjs';
import { redTeamMarker } from '../red-team-gate.mjs';
import { resetCascadeLogForTest } from '../policy-cascade.mjs';
import * as policyCascade from '../policy-cascade.mjs';

const head = 'a'.repeat(40), pr = 742, repo = 'owner/repo';
const note = (sha = head, blocked = false, verdict = blocked ? 'findings' : 'clean') => ({ author: { login: 'web-everything[bot]' },
  body: `<!-- prep-review: head=${sha} round=1${blocked ? ' blocked=1' : ''} -->\n<!-- prep-review-verdict head=${sha} verdict=${verdict} v=1 -->\n**Verdict: ${verdict}**` });
const evidence = () => ({ enabled: true, head, files: [{ filename: 'backlog/742.md', status: 'modified' }],
  comments: [note()], labels: ['review:prep', 'red-team:pending'] });
function fixture(over = {}) {
  const e = evidence();
  return { repo, rawPrs: [{ number: pr, headRefOid: head, labels: e.labels }], enabled: true,
    readComments: () => e.comments, readHeadFiles: () => e.files,
    readLive: () => ({ headRefOid: head, labels: e.labels }), post: vi.fn(), syncLabels: vi.fn(), ...over };
}

describe('backlog-only prep', () => {
  const marker = (sha = head) => `<!-- prep-review-verdict head=${sha} verdict=clean v=1 -->`;
  it.each([
    ['double space', marker().replace(' head=', '  head=')],
    ['uppercase HEAD', marker().replace('head=', 'HEAD=')],
    ['uppercase marker name', marker().replace('prep-review-verdict', 'PREP-REVIEW-VERDICT')],
    ['malformed other head', marker('b'.repeat(40)).replace(' head=', '  head=')],
    ['bare marker name', 'prep-review-verdict'],
  ])('R752: holds after older clean evidence followed by trusted %s evidence', (_name, malformed) => {
    for (const body of [malformed, marker() + '\n' + malformed, malformed + '\n' + marker()]) {
      const comments = [note(), { ...note(), body }];
      expect(backlogOnlyPrepClear({ ...evidence(), comments }).ok).toBe(false);
      const f = fixture({ readComments: () => comments });
      expect(runBacklogOnlyPrep(f)[0].action).toBe('skip');
      expect(f.post).not.toHaveBeenCalled(); expect(f.syncLabels).not.toHaveBeenCalled();
    }
  });
  it.each([
    ['prefix 7', marker(head.slice(0, 7))],
    ['prefix 12', marker(head.slice(0, 12))],
    ['uppercase head', marker(head.toUpperCase())],
    ['39 hex', marker(head.slice(1))],
    ['41 hex', marker(head + 'a')],
    ['missing version', marker().replace(' v=1', '')],
    ['version 2', marker().replace('v=1', 'v=2')],
    ['extra text', marker() + ' trailing'],
    ['inline sentence', 'Here is ' + marker()],
    ['trusted fenced marker', '```markdown\n' + marker() + '\n```'],
    ['trusted tilde fence', '~~~\n' + marker() + '\n~~~'],
    ['unclosed fence', '```\n' + marker()],
    ['legacy free text', `<!-- prep-review: head=${head} round=1 -->\n**Verdict: clean**`],
  ])('holds for %s', (_name, body) => {
    expect(backlogOnlyPrepClear({ ...evidence(), comments: [{ ...note(), body }] }).ok).toBe(false);
  });
  it.each([
    ['multiline inline-code span', '`\n' + marker() + '\n`'],
    ['double-backtick inline-code span', '``quoted ` text\n' + marker() + '\n``'],
    ['unclosed inline-code span', '`quoted\n' + marker()],
    ['enclosing HTML comment', '<!-- quoted example\n' + marker() + '\n-->'],
    ['HTML comment opened mid-line', 'Example: <!--\n' + marker() + '\n-->'],
    ['unclosed enclosing HTML comment', '<!-- quoted example\n' + marker()],
  ])('quoted markers cannot clear the gate: %s', (_name, body) => {
    const comments = [{ ...note(), body }];
    expect(backlogOnlyPrepClear({ ...evidence(), comments }).ok).toBe(false);
    const f = fixture({ readComments: () => comments });
    expect(runBacklogOnlyPrep(f)[0].action).toBe('skip');
    expect(f.post).not.toHaveBeenCalled(); expect(f.syncLabels).not.toHaveBeenCalled();
  });
  it.each([
    ['inline code', '`\n' + marker() + '\n`'],
    ['HTML comment', '<!--\n' + marker() + '\n-->'],
  ])('accepts a later real marker after a quoted %s example', (_name, quoted) => {
    const comments = [{ ...note(), body: quoted + '\n' + marker() }];
    expect(backlogOnlyPrepClear({ ...evidence(), comments }).ok).toBe(true);
  });
  it('holds for an untrusted fenced marker', () => {
    expect(backlogOnlyPrepClear({ ...evidence(), comments: [{ author: { login: 'stranger' },
      body: '```\n' + marker() + '\n```' }] }).ok).toBe(false);
  });
  it('uses the newest clean marker despite historical findings and free text', () => {
    expect(backlogOnlyPrepClear({ ...evidence(), comments: [note(head, true),
      { ...note(), body: marker() + '\n**Verdict: findings**' }] }).ok).toBe(true);
  });
  it('holds when a block label arrives after the last comment read', () => {
    const calls = [];
    let liveReads = 0;
    const f = fixture({ readComments: () => { calls.push('comments'); return [note()]; },
      readLive: () => {
        const blocked = ++liveReads === 2;
        calls.push(blocked ? 'live:blocked' : 'live:benign');
        return { headRefOid: head, labels: [...evidence().labels, ...(blocked ? ['red-team:blocked'] : [])] };
      }, post: vi.fn(() => calls.push('post')) });
    expect(runBacklogOnlyPrep(f)[0].action).not.toBe('clear');
    expect(calls).toEqual(['comments', 'comments', 'live:benign', 'comments', 'live:blocked']);
    expect(f.post).not.toHaveBeenCalled(); expect(f.syncLabels).not.toHaveBeenCalled();
  });
  it('settles exact-head clean prep, posts the bound marker and synchronizes labels', () => {
    const f = fixture();
    expect(runBacklogOnlyPrep(f)).toMatchObject([{ action: 'clear', rule: 'backlog-only-prep' }]);
    expect(f.post.mock.calls[0][0].body).toBe(`${redTeamMarker(pr, head)}\n\nRed team not required on this head: backlog-only prep (rule backlog-only-prep)`);
    expect(f.syncLabels).toHaveBeenCalledWith(expect.objectContaining({ repo, pr, head }));
  });
  it.each([
    ['non-backlog', { files: [{ filename: 'scripts/a.mjs' }] }],
    ['mixed code and backlog', { files: [{ filename: 'backlog/a.md' }, { filename: 'src/a.js' }] }],
    ['rename out of code', { files: [{ filename: 'backlog/a.md', previous_filename: 'src/a.js' }] }],
    ['older head', { comments: [note('b'.repeat(40))] }],
    ['blocked note', { comments: [note(head, true)] }],
    ['newest blocked note', { comments: [note(), note(head, true)] }],
    ['marker without verdict', { comments: [note(head, false, 'unknown')] }],
    ['advise findings without blocked marker', { comments: [note(head, false, 'findings')] }],
    ['newest note without clean verdict', { comments: [note(), note(head, false, 'unknown')] }],
    ['both verdicts in one trusted note', { comments: [{ ...note(), body: note().body + `\n<!-- prep-review-verdict head=${head} verdict=findings v=1 -->` }] }],
    ['untrusted clean cannot settle trusted findings', { comments: [note(head, false, 'findings'), { ...note(), author: { login: 'stranger' } }] }],
    ['untrusted note', { comments: [{ ...note(), author: { login: 'stranger' } }] }],
    ['empty files', { files: [] }],
    ['unknown files', { files: null }],
    ['possibly truncated files; inspect full diff manually', { files: Array(3000).fill({ filename: 'backlog/a.md' }) }],
    ['changes label', { labels: ['review:prep', 'red-team:pending', 'review:changes'] }],
    ['human label', { labels: ['review:prep', 'red-team:pending', 'review:human'] }],
    ['blocked red team', { labels: ['review:prep', 'red-team:pending', 'red-team:blocked'] }],
    ['invalid head', { head: 'short' }],
  ])('refuses %s', (_name, over) => {
    const e = { ...evidence(), ...over };
    expect(backlogOnlyPrepClear(e).ok).toBe(false);
    const f = fixture({ readHeadFiles: () => e.files, readComments: () => e.comments,
      rawPrs: [{ number: pr, headRefOid: e.head, labels: e.labels }] });
    expect(runBacklogOnlyPrep(f)[0].action).toBe('skip');
    expect(f.post).not.toHaveBeenCalled(); expect(f.syncLabels).not.toHaveBeenCalled();
  });
  it.each(['backlog/../x', 'backlog/a..md', 'backlog/\\a', '/backlog/a', 'backlog/a\n', null])('refuses unsafe path %j', filename => {
    expect(backlogOnlyPrepClear({ ...evidence(), files: [{ filename }] }).ok).toBe(false);
  });
  it.each(['files', 'comments', 'live', 'post', 'sync'])('holds on throwing %s IO with sanitized reason', kind => {
    const key = { files: 'readHeadFiles', comments: 'readComments', live: 'readLive', post: 'post', sync: 'syncLabels' }[kind];
    const f = fixture({ [key]: () => { throw Error('unreadable\n\u001b'); } });
    expect(runBacklogOnlyPrep(f)[0]).toMatchObject({ action: 'skip' });
    expect(runBacklogOnlyPrep(f)[0].why).not.toMatch(/[\n\u001b]/);
  });
  it.each([null, {}])('refuses incomplete comments %j', comments => {
    const f = fixture({ readComments: () => comments }); runBacklogOnlyPrep(f);
    expect(f.post).not.toHaveBeenCalled();
  });
  it.each([
    { headRefOid: 'b'.repeat(40), labels: evidence().labels },
    { headRefOid: head, labels: [...evidence().labels, 'review:changes'] },
    { headRefOid: head, labels: null },
  ])('does not post when live evidence changes %j', live => {
    const f = fixture({ readLive: () => live });
    expect(runBacklogOnlyPrep(f)[0].action).toBe('skip'); expect(f.post).not.toHaveBeenCalled();
  });
  it('does not repost an existing trusted marker', () => {
    const f = fixture({ readComments: () => [note(), { author: { login: 'chalbert' }, body: redTeamMarker(pr, head) }] });
    expect(runBacklogOnlyPrep(f)[0].why).toBe('already'); expect(f.post).not.toHaveBeenCalled();
  });
  it('ignores findings for another head and untrusted findings', () => {
    const comments = [note('b'.repeat(40), true), note(), { ...note(head, true), author: { login: 'stranger' } }];
    expect(backlogOnlyPrepClear({ ...evidence(), comments }).ok).toBe(true);
  });
  it.each([
    ['blocked', note(head, true)],
    ['advise findings', note(head, false, 'findings')],
    ['unknown verdict', note(head, false, 'unknown')],
  ])('holds when fresh comments contain a newer %s note', (_name, newer) => {
    const readComments = vi.fn().mockReturnValueOnce([note()]).mockReturnValueOnce([note(), newer]);
    const f = fixture({ readComments });
    expect(runBacklogOnlyPrep(f)[0].action).toBe('skip');
    expect(readComments).toHaveBeenCalledTimes(2);
    expect(f.post).not.toHaveBeenCalled(); expect(f.syncLabels).not.toHaveBeenCalled();
  });
  it('holds when the final comment read fails', () => {
    const readComments = vi.fn().mockReturnValueOnce([note()]).mockImplementationOnce(() => { throw Error('unreadable'); });
    const f = fixture({ readComments });
    expect(runBacklogOnlyPrep(f)[0].action).toBe('skip');
    expect(f.post).not.toHaveBeenCalled(); expect(f.syncLabels).not.toHaveBeenCalled();
  });
  it('setting env zero returns no rows and performs no IO', () => {
    const f = fixture({ enabled: undefined, env: { WE_RED_TEAM_SKIP_BACKLOG_ONLY_PREP: '0' } });
    expect(runBacklogOnlyPrep(f)).toEqual([]); expect(f.post).not.toHaveBeenCalled();
  });
  it('dry run posts nothing', () => {
    const f = fixture({ dryRun: true }); runBacklogOnlyPrep(f);
    expect(f.post).not.toHaveBeenCalled(); expect(f.syncLabels).not.toHaveBeenCalled();
  });
  it('defaults true with standard provenance logged', () => {
    resetCascadeLogForTest(); const log = vi.fn();
    expect(resolveBacklogOnlyPrepSetting({ env: { WE_POLICY_CASCADE_LOG: '1' }, log, readFile: () => '{}' })).toEqual({ enabled: true });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('skipBacklogOnlyPrep=true (standard)'));
  });
  it('invalid/unreadable tool preserves a platform false', () => {
    const readFile = path => { if (String(path).endsWith('red-team.json')) throw Error('unreadable');
      return JSON.stringify({ redTeam: { skipBacklogOnlyPrep: false } }); };
    expect(resolveBacklogOnlyPrepSetting({ env: {}, readFile })).toEqual({ enabled: false });
  });
  it('defaults true when optional settings files are missing', () => {
    expect(resolveBacklogOnlyPrepSetting({ env: {}, readFile: () => { throw Object.assign(Error('missing'), { code: 'ENOENT' }); } })).toEqual({ enabled: true });
  });
  it.each(['tool read', 'tool parse', 'platform read', 'platform parse'])('fails closed on %s failure whatever the env says', failure => {
    const readFile = path => {
      const tool = String(path).endsWith('red-team.json');
      if (tool === failure.startsWith('tool')) {
        if (failure.endsWith('parse')) return '{';
        throw Object.assign(Error('denied'), { code: 'EACCES' });
      }
      return JSON.stringify({ redTeam: { skipBacklogOnlyPrep: true } });
    };
    for (const [value, enabled] of [[undefined, false], ['invalid', false], ['1', false], ['true', false], ['0', false], ['false', false]]) {
      expect(resolveBacklogOnlyPrepSetting({ env: { WE_RED_TEAM_SKIP_BACKLOG_ONLY_PREP: value }, readFile })).toEqual({ enabled });
    }
  });
  it.each([[undefined, false], ['invalid', false], ['true', false], ['false', false]])('fails closed on cascade throw with env %s', (value, enabled) => {
    const spy = vi.spyOn(policyCascade, 'cascadePolicy').mockImplementationOnce(() => { throw Error('cascade failed'); });
    try {
      expect(resolveBacklogOnlyPrepSetting({ env: { WE_RED_TEAM_SKIP_BACKLOG_ONLY_PREP: value }, readFile: () => JSON.stringify({ redTeam: { skipBacklogOnlyPrep: true } }) })).toEqual({ enabled });
    } finally { spy.mockRestore(); }
  });
  it.each(['added', 'modified', 'removed', 'changed', 'unchanged', 'renamed', 'copied'])('accepts known status %s with complete paths', status => {
    expect(backlogOnlyPrepClear({ ...evidence(), files: [{ filename: 'backlog/a', status,
      ...(['renamed', 'copied'].includes(status) ? { previous_filename: 'backlog/b' } : {}) }] }).ok).toBe(true);
  });
  it.each(['renamed', 'copied', 'unknown', undefined, null])('refuses status %s without a string previous filename', status => {
    for (const previous_filename of [undefined, null, 42]) {
      const f = fixture({ readHeadFiles: () => [{ filename: 'backlog/a', status, ...(previous_filename === undefined ? {} : { previous_filename }) }] });
      expect(runBacklogOnlyPrep(f)[0].action).toBe('skip');
      expect(f.post).not.toHaveBeenCalled();
    }
  });
  it.each([
    '**Verdict: clean**\n**Verdict: clean**',
    '> **Verdict: clean**',
    'prefix **Verdict: clean**',
    '```markdown\n**Verdict: clean**\n```',
    '~~~markdown\n**Verdict: clean**\n~~~',
    '**Verdict: unknown**\n**Verdict: clean**',
  ])('refuses ambiguous or nonplain verdict %j', verdict => {
    const comments = [{ ...note(), body: note().body.split('\n')[0] + '\n' + verdict }];
    expect(backlogOnlyPrepClear({ ...evidence(), comments }).ok).toBe(false);
    const f = fixture({ readComments: () => comments });
    expect(runBacklogOnlyPrep(f)[0].action).toBe('skip');
    expect(f.post).not.toHaveBeenCalled();
  });
  it('reads final comments, live head and labels, comments again, live again, then posts', () => {
    const order = [];
    const f = fixture({ readComments: () => { order.push('comments'); return [note()]; },
      readLive: () => { order.push('live'); return { headRefOid: head, labels: evidence().labels }; },
      post: vi.fn(() => order.push('post')) });
    expect(runBacklogOnlyPrep(f)[0].action).toBe('clear');
    expect(order).toEqual(['comments', 'comments', 'live', 'comments', 'live', 'post']);
  });
  it.each([
    ['backtick fence', '```markdown\n' + note().body + '\n```'],
    ['tilde fence', '~~~markdown\n' + note().body + '\n~~~'],
    ['inline code', '`\n' + note().body.split('\n')[0] + '\n`\n**Verdict: clean**'],
    ['fenced marker with plain verdict', '```\n' + note().body.split('\n')[0] + '\n```\n**Verdict: clean**'],
  ])('refuses prep proof present only in %s', (_name, body) => {
    const comments = [{ ...note(), body }];
    expect(backlogOnlyPrepClear({ ...evidence(), comments }).ok).toBe(false);
    const f = fixture({ readComments: () => comments });
    expect(runBacklogOnlyPrep(f)[0].action).not.toBe('clear');
    expect(f.post).not.toHaveBeenCalled(); expect(f.syncLabels).not.toHaveBeenCalled();
  });
  it.each(['```', '~~~'])('accepts real prep proof after a %s fenced fake marker for another head', fence => {
    const comments = [{ ...note(), body: `${fence}\n${note('b'.repeat(40), true).body}\n${fence}\n${note().body}` }];
    expect(backlogOnlyPrepClear({ ...evidence(), comments }).ok).toBe(true);
    const f = fixture({ readComments: () => comments });
    expect(runBacklogOnlyPrep(f)[0].action).toBe('clear');
  });
  it.each([
    ['moved head', { headRefOid: 'b'.repeat(40), labels: evidence().labels }],
    ['unreadable labels', { headRefOid: head, labels: null }],
    ['malformed label', { headRefOid: head, labels: [...evidence().labels, {}] }],
    ...['red-team:clear', 'red-team:unknown', 'review:changes', 'review:human'].map(label =>
      [label, { headRefOid: head, labels: [...evidence().labels, label] }]),
  ])('holds on %s arriving at the last live read', (_name, live) => {
    const f = fixture({ readLive: vi.fn().mockReturnValueOnce({ headRefOid: head, labels: evidence().labels }).mockReturnValueOnce(live) });
    expect(runBacklogOnlyPrep(f)[0].action).not.toBe('clear');
    expect(f.post).not.toHaveBeenCalled(); expect(f.syncLabels).not.toHaveBeenCalled();
  });
  it('holds when trusted findings arrive on the third comment read between live read and post', () => {
    const readComments = vi.fn().mockReturnValueOnce([note()]).mockReturnValueOnce([note()])
      .mockReturnValueOnce([note(), note(head, false, 'findings')]);
    const f = fixture({ readComments });
    expect(runBacklogOnlyPrep(f)[0].action).toBe('skip');
    expect(readComments).toHaveBeenCalledTimes(3);
    expect(f.post).not.toHaveBeenCalled(); expect(f.syncLabels).not.toHaveBeenCalled();
  });
  it('holds when the third comment read throws', () => {
    const f = fixture({ readComments: vi.fn().mockReturnValueOnce([note()]).mockReturnValueOnce([note()])
      .mockImplementationOnce(() => { throw Error('unreadable'); }) });
    expect(runBacklogOnlyPrep(f)[0].action).toBe('skip'); expect(f.post).not.toHaveBeenCalled();
  });
  it.each([null, undefined])('holds when the third comment read is incomplete: %j', value => {
    const f = fixture({ readComments: vi.fn().mockReturnValueOnce([note()]).mockReturnValueOnce([note()]).mockReturnValueOnce(value) });
    expect(runBacklogOnlyPrep(f)[0].action).toBe('skip'); expect(f.post).not.toHaveBeenCalled();
  });
  it('reads paginated files and verifies current head and changedFiles count', () => {
    const exec = vi.fn().mockReturnValueOnce(JSON.stringify([[{ filename: 'backlog/a', status: 'modified' }], [{ filename: 'backlog/b', status: 'renamed', previous_filename: 'backlog/c' }]]))
      .mockReturnValueOnce(JSON.stringify({ headRefOid: head, changedFiles: 2 }));
    expect(readHeadFiles({ repo, pr, head, exec })).toEqual([{ filename: 'backlog/a', status: 'modified' },
      { filename: 'backlog/b', status: 'renamed', previous_filename: 'backlog/c' }]);
    expect(exec.mock.calls[1][0]).toContain('headRefOid,changedFiles');
    expect(exec.mock.calls[0][0]).toContain('--paginate');
  });
  it.each([0, 2, undefined, null, '1', -1, 1.5])('throws for incomplete or invalid changedFiles count %j', changedFiles => {
    const exec = vi.fn().mockReturnValueOnce(JSON.stringify([[{ filename: 'backlog/a', status: 'modified' }]]))
      .mockReturnValueOnce(JSON.stringify({ headRefOid: head, changedFiles }));
    expect(() => readHeadFiles({ repo, pr, head, exec })).toThrow(/files.*inspect full diff manually/i);
  });
  it('throws at the 3000-file cutoff even when the count matches, requesting full manual review', () => {
    const exec = vi.fn().mockReturnValueOnce(JSON.stringify([Array(3000).fill({ filename: 'backlog/a', status: 'modified' })]))
      .mockReturnValueOnce(JSON.stringify({ headRefOid: head, changedFiles: 3000 }));
    expect(() => readHeadFiles({ repo, pr, head, exec })).toThrow(/inspect full diff manually/);
  });
  it.each(['bad json', '{}', 'null'])('throws for malformed file response %s', value => {
    expect(() => readHeadFiles({ repo, pr, head, exec: () => value })).toThrow();
  });
  it('throws when the files read belongs to a moved head', () => {
    const exec = vi.fn().mockReturnValueOnce('[[{"filename":"backlog/a"}]]').mockReturnValueOnce('{"headRefOid":"moved"}');
    expect(() => readHeadFiles({ repo, pr, head, exec })).toThrow();
  });
});
