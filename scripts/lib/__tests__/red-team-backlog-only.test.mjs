import { describe, it, expect, vi, afterEach } from 'vitest';
import { backlogOnlyPrepClear, parseNameStatusZ, readBacklogOnlyNetFiles, resolveBacklogOnlyPrepSetting, runBacklogOnlyPrep } from '../red-team-backlog-only.mjs';
import { gitExec, defaultGitDirFor } from '../../operations/free-scope-io.mjs';
import { redTeamMarker } from '../red-team-gate.mjs';
import * as policy from '../policy-cascade.mjs';

vi.mock('../../operations/free-scope-io.mjs', () => ({
  gitExec: vi.fn(() => () => { throw Error('unexpected git IO'); }), defaultGitDirFor: vi.fn(() => null),
}));
vi.mock('../gh-throttle.mjs', async importOriginal => ({
  ...await importOriginal(), runGhSync: vi.fn(() => { throw Error('unexpected GitHub IO'); }),
}));
const repo = 'owner/repo', pr = 742, head = 'a'.repeat(40);
const labels = ['review:prep', 'red-team:pending'];
const net = () => ({ ok: true, files: ['backlog/742.md', 'backlog/nested/other.md'] });
function fixture(over = {}) {
  return { repo, enabled: true, rawPrs: [{ number: pr, headRefOid: head, labels }],
    readHeadFiles: vi.fn(net), readComments: vi.fn(() => []),
    readLive: vi.fn(() => ({ headRefOid: head, labels })), post: vi.fn(), syncLabels: vi.fn(), ...over };
}
function held(f) {
  expect(runBacklogOnlyPrep(f)[0].action).toBe('skip');
  expect(f.post).not.toHaveBeenCalled(); expect(f.syncLabels).not.toHaveBeenCalled();
}
afterEach(() => vi.restoreAllMocks());

describe('R756 backlog-only exact-head exemption', () => {
  it('settles all-backlog with zero comments and preserves the prep label', () => {
    const f = fixture();
    expect(runBacklogOnlyPrep(f)).toMatchObject([{ action: 'clear', rule: 'backlog-only' }]);
    expect(f.readHeadFiles).toHaveBeenCalledWith({ repo, number: pr, headRefOid: head });
    expect(f.post).toHaveBeenCalledOnce();
    expect(f.post).toHaveBeenCalledWith({ repo, pr, head,
      body: `${redTeamMarker(pr, head)}\n\nRed team not required on this head: backlog-only` });
    expect(f.syncLabels).toHaveBeenCalledOnce();
    expect(f.rawPrs[0].labels).toEqual(labels);
  });
  it('defaults to the strict reader pinned to the exact head', () => {
    const io = gitFixture();
    vi.mocked(gitExec).mockReturnValueOnce(io.git);
    vi.mocked(defaultGitDirFor).mockReturnValueOnce('fixture-checkout');
    const f = fixture({ readHeadFiles: undefined });
    expect(runBacklogOnlyPrep(f)[0].action).toBe('clear');
    expect(io.git).toHaveBeenCalledWith('fixture-checkout', ['merge-base', '--end-of-options', 'origin/main', head]);
  });
  it('holds without a local checkout', () => held(fixture({ readHeadFiles: undefined })));
  it('accepts a complete net list beyond the removed GitHub pagination limit', () => {
    const f = fixture({ readHeadFiles: () => ({ ok: true, files: Array(3001).fill('backlog/a') }) });
    expect(runBacklogOnlyPrep(f)[0].action).toBe('clear');
    expect(f.post).toHaveBeenCalledOnce();
  });
  it.each([
    ['one outside file', ['backlog/a', 'src/a']],
    ['rename from outside backlog (both paths)', ['src/old', 'backlog/new']],
    ['non-string entry', ['backlog/a', null]],
    ['sparse array', new Array(1)],
    ['legacy file object', [{ filename: 'backlog/a' }]],
    ['directory alone', ['backlog/']],
    ['parent traversal', ['backlog/../a']],
    ['backslash', ['backlog/a\\b']],
    ['control character', ['backlog/a\n']],
    ['prefix lookalike', ['backlog-other/a']],
  ])('holds for %s', (_name, files) => held(fixture({ readHeadFiles: () => ({ ok: true, files }) })));
  it.each([
    ['failed read', { ok: false, files: ['backlog/a'] }],
    ['missing success', { files: ['backlog/a'] }],
    ['nonboolean success', { ok: 'true', files: ['backlog/a'] }],
    ['empty', { ok: true, files: [] }],
    ['non-array', { ok: true, files: 'backlog/a' }],
    ['missing result', undefined],
  ])('holds on unreadable list: %s', (_name, result) => held(fixture({ readHeadFiles: () => result })));
  it.each(['readHeadFiles', 'readComments', 'readLive', 'post'])('holds when %s throws', key => {
    const f = fixture({ [key]: vi.fn(() => { throw Error('unreadable\n\u001b'); }) });
    const row = runBacklogOnlyPrep(f)[0];
    expect(row.action).toBe('skip'); expect(row.why).not.toMatch(/[\n\u001b]/);
    expect(f.syncLabels).not.toHaveBeenCalled();
  });
  it.each(['red-team:blocked', 'red-team:clear', 'red-team:unknown', 'review:changes', 'review:human'])('holds with %s', label => {
    held(fixture({ rawPrs: [{ number: pr, headRefOid: head, labels: [...labels, label] }] }));
  });
  it.each([null, [], ['review:prep'], ['red-team:pending']])('ignores non-candidate labels %j', absent => {
    const f = fixture({ rawPrs: [{ number: pr, headRefOid: head, labels: absent }] });
    expect(runBacklogOnlyPrep(f)).toEqual([]); expect(f.readHeadFiles).not.toHaveBeenCalled();
  });
  it.each([1, 2])('holds when head moves at live read %s', read => {
    const f = fixture();
    f.readLive.mockImplementationOnce(() => ({ headRefOid: read === 1 ? 'b'.repeat(40) : head, labels }))
      .mockImplementationOnce(() => ({ headRefOid: 'b'.repeat(40), labels }));
    held(f);
  });
  it.each([
    [1, ['review:prep']], [2, ['review:prep']],
    [1, ['red-team:pending']], [2, ['red-team:pending']],
    ...['review:changes', 'review:human', 'red-team:other'].flatMap(label =>
      [1, 2].map(read => [read, [...labels, label]])),
    [1, [...labels, 'unrelated-label']],
  ])('holds when labels change at live read %s to %j', (read, changed) => {
    const f = fixture();
    f.readLive.mockImplementationOnce(() => ({ headRefOid: head, labels: read === 1 ? changed : labels }))
      .mockImplementationOnce(() => ({ headRefOid: head, labels: changed }));
    held(f);
  });
  it.each([['review:prep'], ['red-team:pending'], null])('holds when live candidate labels disappear: %j', liveLabels => {
    held(fixture({ readLive: () => ({ headRefOid: head, labels: liveLabels }) }));
  });
  it.each([null, [{}]])('holds on unreadable comments %j', comments => held(fixture({ readComments: () => comments })));
  it.each([1, 2, 3])('does not duplicate an exact-head marker at comment read %s', read => {
    const marker = { author: { login: 'web-everything[bot]' }, body: redTeamMarker(pr, head) };
    let calls = 0;
    const f = fixture({ readComments: () => ++calls >= read ? [marker] : [] });
    expect(runBacklogOnlyPrep(f)[0].why).toBe('already');
    expect(f.post).not.toHaveBeenCalled(); expect(f.syncLabels).not.toHaveBeenCalled();
  });
  it('ignores old-head red-team markers', () => {
    const f = fixture({ readComments: () => [{ author: { login: 'web-everything[bot]' }, body: redTeamMarker(pr, 'b'.repeat(40)) }] });
    expect(runBacklogOnlyPrep(f)[0].action).toBe('clear');
  });
  it('setting off performs no IO', () => {
    const f = fixture({ enabled: false });
    expect(runBacklogOnlyPrep(f)).toEqual([]); expect(f.readComments).not.toHaveBeenCalled();
    expect(f.readHeadFiles).not.toHaveBeenCalled(); expect(f.post).not.toHaveBeenCalled();
  });
  it('dry run makes no changes', () => held(fixture({ dryRun: true })));
  it('rejects invalid head evidence', () => {
    expect(backlogOnlyPrepClear({ enabled: true, head: 'short', files: net().files, labels }).ok).toBe(false);
  });
});

describe('backlog-only setting', () => {
  it('defaults true and logs standard provenance', () => {
    policy.resetCascadeLogForTest(); const log = vi.fn();
    vi.spyOn(policy, 'readPlatformPreferences').mockReturnValue({ prefs: {}, errors: [] });
    expect(resolveBacklogOnlyPrepSetting({ env: { WE_POLICY_CASCADE_LOG: '1' }, log, readFile: () => '{}' })).toEqual({ enabled: true });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('skipBacklogOnlyPrep=true (standard)'));
  });
  it.each([['0', false], ['false', false], ['1', true], ['true', true]])('honors environment %s', (value, enabled) => {
    vi.spyOn(policy, 'readPlatformPreferences').mockReturnValue({ prefs: {}, errors: [] });
    expect(resolveBacklogOnlyPrepSetting({ env: { WE_RED_TEAM_SKIP_BACKLOG_ONLY_PREP: value }, readFile: () => '{}' })).toEqual({ enabled });
  });
  it.each(['tool read', 'tool parse', 'platform read'])('fails closed on %s even with env on', failure => {
    vi.spyOn(policy, 'readPlatformPreferences').mockReturnValue({ prefs: {}, errors: failure === 'platform read' ? ['unreadable'] : [] });
    const readFile = () => { if (failure === 'tool read') throw Error('unreadable'); return failure === 'tool parse' ? '{' : '{}'; };
    expect(resolveBacklogOnlyPrepSetting({ env: { WE_RED_TEAM_SKIP_BACKLOG_ONLY_PREP: '1' }, readFile })).toEqual({ enabled: false });
  });
  it('retains the platform and tool setting layers', () => {
    vi.spyOn(policy, 'readPlatformPreferences').mockReturnValue({ prefs: { redTeam: { skipBacklogOnlyPrep: false } }, errors: [] });
    expect(resolveBacklogOnlyPrepSetting({ env: {}, readFile: () => '{}' })).toEqual({ enabled: false });
    expect(resolveBacklogOnlyPrepSetting({ env: {}, readFile: () => '{"redTeam":{"skipBacklogOnlyPrep":true}}' })).toEqual({ enabled: true });
  });
});

const base = 'b'.repeat(40);
function gitFixture({ raw = 'M\0backlog/a.md\0', fails, missing = false } = {}) {
  return { gitDirFor: () => 'fixture-checkout', git: vi.fn((_dir, args) => {
    if (args[0] === fails || (missing && args[0] === 'cat-file')) throw Error('git failed');
    if (args[0] === 'merge-base') return `${base}\n`;
    if (args[0] === 'diff') return raw;
    return '';
  }) };
}
describe('strict backlog-only net evidence', () => {
  it.each([
    ['trailing status', 'M\0backlog/a\0M\0'],
    ['unterminated path', 'M\0backlog/a'],
    ['odd fields', 'M\0backlog/a\0A\0backlog/b\0D\0'],
    ['empty path', 'M\0\0'], ['empty status', '\0backlog/a\0'],
    ...['R', 'R100', 'C', 'U', 'X', 'B', 'MM', 'M\n'].map(status => [status, `${status}\0backlog/a\0`]),
    ['empty stream', ''], ['non-string', null],
  ])('rejects %s', (_name, raw) => expect(parseNameStatusZ(raw)).toEqual({ ok: false }));
  it('accepts complete known status records without filtering fields', () => {
    expect(parseNameStatusZ('M\0backlog/a.md\0A\0backlog/b.md\0')).toEqual({ ok: true, files: ['backlog/a.md', 'backlog/b.md'] });
    expect(parseNameStatusZ('D\0backlog/a\0T\0backlog/b\0').ok).toBe(true);
  });
  it('fetches current main and diffs the exact head with strict git flags', () => {
    const io = gitFixture({ missing: true });
    expect(readBacklogOnlyNetFiles({ repo, number: pr, headRefOid: head }, io)).toEqual({ ok: true, files: ['backlog/a.md'] });
    expect(io.git.mock.calls).toEqual([
      ['fixture-checkout', ['cat-file', '-e', `${head}^{commit}`]],
      ['fixture-checkout', ['fetch', '--quiet', '--no-write-fetch-head', '--end-of-options', 'origin', '+refs/heads/main:refs/remotes/origin/main', `refs/pull/${pr}/head`]],
      ['fixture-checkout', ['merge-base', '--end-of-options', 'origin/main', head]],
      ['fixture-checkout', ['diff', '--no-ext-diff', '--no-renames', '--name-status', '-z', '--end-of-options', base, head]],
    ]);
  });
  it.each(['fetch', 'merge-base', 'diff'])('holds on %s failure without cached-base fallback', fails => {
    const io = gitFixture({ fails });
    held(fixture({ readHeadFiles: key => readBacklogOnlyNetFiles(key, io) }));
    if (fails === 'fetch') expect(io.git.mock.calls.some(([, args]) => args[0] === 'diff')).toBe(false);
  });
  it.each(['M\0backlog/a\0M\0', 'M\0backlog/a'])('never posts with truncated git stdout %j', raw => {
    held(fixture({ readHeadFiles: key => readBacklogOnlyNetFiles(key, gitFixture({ raw })) }));
  });
  it('holds on invalid merge-base output', () => {
    const io = gitFixture(); io.git.mockImplementation((_dir, args) => args[0] === 'merge-base' ? 'invalid' : '');
    expect(readBacklogOnlyNetFiles({ repo, number: pr, headRefOid: head }, io).ok).toBe(false);
  });
});
describe('strict backlog-only setting values', () => {
  it.each(['tool', 'env'])('disables and sanitises logged invalid %s values even with another layer on', layer => {
    vi.spyOn(policy, 'readPlatformPreferences').mockReturnValue({ prefs: {}, errors: [] });
    for (const value of ['off', 2, null, {}, 'bad\n\u001bvalue']) {
      const log = vi.fn();
      const env = { WE_RED_TEAM_SKIP_BACKLOG_ONLY_PREP: layer === 'env' ? value : '1' };
      const readFile = () => JSON.stringify({ redTeam: { skipBacklogOnlyPrep: layer === 'tool' ? value : true } });
      expect(resolveBacklogOnlyPrepSetting({ env, readFile, log })).toEqual({ enabled: false });
      expect(log).toHaveBeenCalledWith(expect.stringContaining(layer));
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`invalid ${layer} skipBacklogOnlyPrep=${JSON.stringify(value)}`));
      expect(log.mock.calls.flat().join('')).not.toMatch(/[\n\u001b]/);
    }
  });
  it.each([[true, true], [false, false], ['1', true], ['0', false]])('accepts tool value %j', (value, enabled) => {
    vi.spyOn(policy, 'readPlatformPreferences').mockReturnValue({ prefs: {}, errors: [] });
    expect(resolveBacklogOnlyPrepSetting({ env: {}, readFile: () => JSON.stringify({ redTeam: { skipBacklogOnlyPrep: value } }) })).toEqual({ enabled });
  });
  it.each([true, false, 'TRUE', 'FaLsE'])('accepts env boolean %j', value => {
    vi.spyOn(policy, 'readPlatformPreferences').mockReturnValue({ prefs: {}, errors: [] });
    expect(resolveBacklogOnlyPrepSetting({ env: { WE_RED_TEAM_SKIP_BACKLOG_ONLY_PREP: value }, readFile: () => '{}' })).toEqual({ enabled: String(value).toLowerCase() === 'true' });
  });
  it('defaults true when the tool file is absent', () => {
    vi.spyOn(policy, 'readPlatformPreferences').mockReturnValue({ prefs: {}, errors: [] });
    expect(resolveBacklogOnlyPrepSetting({ env: {}, readFile: () => { throw Object.assign(Error('absent'), { code: 'ENOENT' }); } })).toEqual({ enabled: true });
  });
});
