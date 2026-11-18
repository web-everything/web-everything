import { beforeEach, afterEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attributeSessions, readSession, readReport, formatReport, main } from '../claude-tokens-per-pr.mjs';

let temp, projects, project, children, ledger, cwd;
const repository = 'github.com/a/b';
const now = Date.parse('2026-11-18T12:00:00Z');
const mergedAt = '2026-11-17T12:00:00Z';
const prs = [{ number: 10, headRefName: 'claude/bright-river-abc', mergedAt, url: 'https://github.com/a/b/pull/10' },
  { number: 11, headRefName: 'lane/second', mergedAt, url: 'https://github.com/a/b/pull/11' }];
const tokens = (input, cacheCreation, cacheRead, output) => ({ input, cacheCreation, cacheRead, output });
const sessions = [
  { sessionId: 'one', tokens: tokens(10, 20, 30, 40), prs: [999, 10, 11], branches: ['lane/second'] },
  { sessionId: 'two', tokens: tokens(1, 2, 3, 4), prs: [], branches: ['bright-river'] },
  { sessionId: 'three', tokens: tokens(5, 6, 7, 8), prs: [11], branches: [] },
];
const assistant = (id, usage, content = []) => ({ type: 'assistant', message: { id, usage, content } });
const text = value => ({ type: 'text', text: value });
const result = value => ({ type: 'user', message: { content: [{ type: 'tool_result', content: value }] } });
const jsonl = (file, rows) => writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
function transcript(name, rows, dir = project, timestamp = now - 1000) {
  const file = join(dir, `${name}.jsonl`);
  jsonl(file, rows);
  utimesSync(file, timestamp / 1000, timestamp / 1000);
  return file;
}
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'we-claude-per-pr-'));
  cwd = join(temp, 'checkout');
  projects = join(temp, 'projects'); project = join(projects, cwd.replaceAll('/', '-'));
  children = join(project, 'parent', 'subagents'); ledger = join(temp, 'codex.jsonl');
  mkdirSync(children, { recursive: true });
});
afterEach(() => rmSync(temp, { recursive: true, force: true }));

describe('whole-session attribution', () => {
  it('attributes three sessions exactly once by first merged PR or embedded branch slug', () => {
    const report = attributeSessions({ sessions, prs });
    assert.deepEqual(report.perPr, [
      { pr: 10, branch: prs[0].headRefName, sessions: 2, claude: { ...tokens(11, 22, 33, 44), total: 110 }, codex: null, agy: null },
      { pr: 11, branch: prs[1].headRefName, sessions: 1, claude: { ...tokens(5, 6, 7, 8), total: 26 }, codex: null, agy: null },
    ]);
    assert.deepEqual(report.totals, { claude: { ...tokens(16, 28, 40, 52), total: 136 }, mergedPrs: 2, codexUnattributedRows: 0, incompleteUsageMessages: 0, claudeTotalPerMergedPr: 68 });
    assert.deepEqual(report.unattributed, []);
    assert.equal(report.note, 'agy tokens: no source');
  });
  it('preserves the fourth session and its tokens in unattributed and overall totals', () => {
    const fourth = { sessionId: 'four', tokens: tokens(2, 3, 4, 5), prs: [], branches: [] };
    const report = attributeSessions({ sessions: [...sessions, fourth], prs });
    assert.deepEqual(report.unattributed, [{ sessionId: 'four', tokens: fourth.tokens }]);
    assert.equal(report.totals.claude.total, 150);
    assert.equal(report.totals.claudeTotalPerMergedPr, 75);
    assert.equal(report.perPr[0].claude.total, 110);
  });
  it('sums Codex rows beside the matching PR without changing Claude totals', () => {
    const report = attributeSessions({ sessions, prs, repository, codexRows: [
      { repo: 'a/b', pr: 10, tokens: { input: 100, cached: 40, output: 20, reasoning: 5 } },
      { repo: 'a/b', pr: '10', tokens: { input: 10, cached: 4, output: 2, reasoning: 1 } },
      { repo: 'a/b', pr: 11, tokens: { input: 9, output: 3 } },
      { pr: 999, tokens: { input: 999 } },
      { tokens: { input: 999 } },
    ] });
    assert.deepEqual(report.perPr[0].codex, { input: 110, cached: 44, output: 22, reasoning: 6 });
    assert.deepEqual(report.perPr[1].codex, { input: 9, cached: null, output: 3, reasoning: null });
    assert.equal(report.totals.claudeTotalPerMergedPr, 68);
  });
  it('does not credit foreign, missing, unknown, or unmatched Codex rows', () => {
    const row = { pr: 10, tokens: { input: 1, cached: 2, output: 3, reasoning: 4 } };
    const report = attributeSessions({ sessions: [], prs, repository, codexRows: [
      { ...row, repo: 'other/repo' }, row, { ...row, repo: null }, { ...row, repo: 'unknown' },
      { ...row, repo: 'a/b', pr: 999 }, { ...row, repo: 'https://github.com/A/B.git' },
    ] });
    assert.deepEqual(report.perPr[0].codex, row.tokens);
    assert.equal(report.totals.codexUnattributedRows, 5);
    assert.equal(attributeSessions({ sessions: [], prs, codexRows: [{ ...row, repo: 'a/b' }] }).totals.codexUnattributedRows, 1);
    assert.match(formatReport(report), /unattributed Codex rows: 5/);
  });
  it('keeps null and undefined Codex counters unknown across subsequent credited rows', () => {
    const complete = { input: 1, cached: 2, output: 3, reasoning: 4 };
    const report = attributeSessions({ sessions: [], prs, repository, codexRows: [
      { repo: 'a/b', pr: 10, tokens: complete },
      { repo: 'a/b', pr: 10, tokens: { input: null, output: 0, reasoning: 0 } },
      { repo: 'a/b', pr: 10, tokens: complete },
      { repo: 'a/b', pr: 11 },
    ] });
    assert.deepEqual(report.perPr[0].codex, { input: null, cached: null, output: 6, reasoning: 8 });
    assert.deepEqual(report.perPr[1].codex, { input: null, cached: null, output: null, reasoning: null });
    assert.match(formatReport(report), /unknown in \/ unknown cached/);
  });
  it('rejects the foreign.example probe while accepting exact hosted and hostless identities', () => {
    const row = { pr: 10, tokens: { input: 1, cached: 2, output: 3, reasoning: 4 } };
    const report = attributeSessions({ sessions: [], prs, repository, codexRows: [
      ...['https://foreign.example/a/b', 'git@foreign.example:a/b.git', 'foreign.example/a/b',
        'b', 'a/b.git', 'a/b/extra', 'prefix/a/b'].map(repo => ({ ...row, repo })),
      ...['a/b', 'https://github.com/A/B.git', 'git@github.com:a/b.git', 'github.com/a/b'].map(repo => ({ ...row, repo })),
    ] });
    assert.deepEqual(report.perPr[0].codex, { input: 4, cached: 8, output: 12, reasoning: 16 });
    assert.equal(report.totals.codexUnattributedRows, 7);
    const enterprise = attributeSessions({ sessions: [], prs, repository: 'foreign.example/a/b', codexRows: [
      { ...row, repo: 'a/b' }, { ...row, repo: 'https://github.com/a/b' },
    ] });
    assert.deepEqual(enterprise.perPr[0].codex, row.tokens);
    assert.equal(enterprise.totals.codexUnattributedRows, 1);
  });
  it.each([-1, NaN, Infinity, -Infinity])('rejects invalid credited Codex counters: %s', value => {
    assert.throws(() => attributeSessions({ sessions: [], prs, repository, codexRows: [
      { repo: 'a/b', pr: 10, tokens: { input: value } },
    ] }), /Invalid token count/);
  });
  it('uses branch order and avoids substring collisions; includes zero-session merged PRs', () => {
    const report = attributeSessions({ sessions: [{ ...sessions[0], prs: [], branches: ['river', 'lane/second'] }], prs });
    assert.equal(report.perPr[0].sessions, 1);
    assert.equal(report.perPr[1].sessions, 0);
    const collision = attributeSessions({ sessions: [{ ...sessions[0], prs: [], branches: ['bright-riv'] }], prs });
    assert.equal(collision.unattributed.length, 1);
  });
  it('reports an undefined average when no PRs merged', () => {
    const report = attributeSessions({ sessions, prs: [] });
    assert.equal(report.totals.claudeTotalPerMergedPr, null);
    assert.equal(report.unattributed.length, 3);
  });
});

describe('transcript evidence', () => {
  it('dedupes assistant message.id with last usage winning, retaining anonymous messages', async () => {
    const file = transcript('dedupe', [
      assistant('same', { input_tokens: 999, output_tokens: 999 }),
      assistant('same', { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 }),
      assistant('other', { input_tokens: 1, output_tokens: 2 }),
      assistant(undefined, { output_tokens: 3 }), assistant(undefined, { output_tokens: 4 }),
      { type: 'user', message: { usage: { input_tokens: 999 } } },
    ]);
    const session = await readSession(file);
    assert.deepEqual(session.tokens, tokens(11, 20, 30, 49));
    assert.equal(session.incompleteUsageMessages, 3);
  });
  it('only reads qualified PR lines in assistant text/tool results, preserving textual order', async () => {
    const file = transcript('evidence', [
      { type: 'user', message: { content: [text('Created PR #900')] } },
      assistant('a', {}, [
        { type: 'tool_use', input: { command: 'Created PR #901' } },
        { type: 'thinking', thinking: 'Created PR #902' },
        text('PR #903\nCreated something\nOpened PR #11 then https://github.com/a/b/pull/10'),
      ]),
      result([{ type: 'text', text: 'pr-land: merged https://github.com/a/b/pull/12' }]),
      assistant('b', {}, 'Created PR #13'),
      result('refs/heads/lane/second\ngit push -u origin bright-river\ngit push origin HEAD:lane/third'),
    ]);
    const session = await readSession(file);
    assert.deepEqual(session.prs, [11, 10, 12, 13]);
    assert.deepEqual(session.prRepositories, [repository, repository, repository, null]);
    assert.deepEqual(session.branches, ['lane/second', 'bright-river', 'lane/third']);
  });
  it('counts incomplete deduped Claude messages in totals, including unattributed sessions', async () => {
    transcript('incomplete', [
      assistant('replaced', {}),
      assistant('replaced', { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }),
      assistant('missing', { input_tokens: 2 }, [text('Created PR #10')]),
      assistant('null', { input_tokens: null, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }),
    ]);
    transcript('unattributed', [assistant('unknown', {})]);
    const report = await readReport({ now, cwd, projectsDir: projects, env: { WE_CODEX_USAGE_LEDGER: ledger }, listMergedPrs: async () => prs });
    assert.equal(report.totals.incompleteUsageMessages, 3);
    assert.equal(report.perPr[0].claude.total, 2);
    assert.match(formatReport(report), /Incomplete Claude usage messages: 3/);
  });
  it.each([-1, NaN, Infinity, -Infinity])('rejects invalid Claude counters: %s', value => {
    assert.throws(() => attributeSessions({ sessions: [{ ...sessions[0], tokens: { input: value } }], prs }), /Invalid token count/);
  });
  it('flags absent and null usage after last-message-ID dedupe, retaining anonymous messages', async () => {
    const complete = { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 };
    const file = transcript('missing-usage', [
      assistant('absent', undefined, [text('Created PR #10')]), assistant('absent', undefined),
      assistant('null', null), assistant('null', null),
      assistant('repaired', null), assistant('repaired', complete),
      assistant('lost', complete), assistant('lost', null),
      assistant(undefined, undefined), assistant(undefined, null),
      { type: 'user', message: { id: 'user' } },
    ]);
    const session = await readSession(file);
    assert.equal(session.incompleteUsageMessages, 5);
    assert.deepEqual(session.tokens, tokens(1, 2, 3, 4));
    transcript('missing-unattributed', [assistant('missing', undefined)]);
    const report = await readReport({ now, cwd, projectsDir: projects, env: { WE_CODEX_USAGE_LEDGER: ledger }, listMergedPrs: async () => prs });
    assert.equal(report.totals.incompleteUsageMessages, 6);
    assert.equal(report.perPr[0].claude.total, 10);
    assert.equal(report.unattributed.length, 1);
    assert.match(formatReport(report), /Incomplete Claude usage messages: 6/);
  });
  it('rejects malformed transcript rows rather than silently understating tokens', async () => {
    const file = transcript('broken', []);
    writeFileSync(file, '{broken\n');
    await assert.rejects(readSession(file), /Incomplete transcript/);
  });
  it('rejects invalid token counters', () => {
    assert.throws(() => attributeSessions({ sessions: [{ ...sessions[0], tokens: { input: -1 } }], prs }), /Invalid token count/);
  });
});

describe('windowed report and CLI', () => {
  const options = () => ({ now, cwd, projectsDir: projects, env: { WE_CODEX_USAGE_LEDGER: ledger }, listMergedPrs: async () => prs });
  it('does not attribute another repository’s same-number PR', async () => {
    const foreignProject = join(projects, '-other-checkout');
    mkdirSync(foreignProject);
    transcript('foreign-url', [assistant('f', { input_tokens: 100 }, [text('Created PR #10 https://github.com/other/repo/pull/10'),
      text('refs/heads/claude/bright-river-abc')])], foreignProject);
    transcript('foreign-bare', [assistant('b', { output_tokens: 20 }, [text('Opened PR #10'), text('git push origin bright-river')])], foreignProject);
    transcript('foreign-in-local-project', [assistant('x', { input_tokens: 30 }, [text('Created PR #10 https://github.com/other/repo/pull/10 refs/heads/bright-river')])]);
    transcript('local-url-in-foreign-project', [assistant('l', { input_tokens: 7 }, [text('Created https://github.com/a/b/pull/10')])], foreignProject);
    transcript('local-branch', [assistant('c', { output_tokens: 3 }, [text('git push origin bright-river')])]);
    const report = await readReport(options());
    assert.equal(report.perPr[0].sessions, 2);
    assert.equal(report.perPr[0].claude.total, 10);
    assert.equal(report.unattributed.length, 3);
    assert.deepEqual(Object.fromEntries(report.unattributed.map(row => [row.sessionId, row.tokens])), {
      'foreign-in-local-project': tokens(30, 0, 0, 0),
      'foreign-bare': tokens(0, 0, 0, 20),
      'foreign-url': tokens(100, 0, 0, 0),
    });
    assert.equal(report.totals.claude.total, 160);
  });
  it('uses entry cwd to scope evidence and rejects foreign cwd even within the current project', async () => {
    const foreign = { ...assistant('f', { input_tokens: 9 }, [text('Created PR #10'), text('refs/heads/bright-river')]), cwd: join(temp, 'foreign') };
    const local = { ...assistant('l', { input_tokens: 4 }, [text('Created PR #10')]), cwd: join(cwd, 'subdir') };
    transcript('foreign-cwd', [foreign]);
    const other = join(projects, '-other'); mkdirSync(other);
    transcript('local-cwd', [local], other);
    const report = await readReport(options());
    assert.equal(report.perPr[0].claude.total, 4);
    assert.equal(report.unattributed[0].sessionId, 'foreign-cwd');
  });
  it('rejects unknown or mixed PR repository identity with an operator fallback', async () => {
    await assert.rejects(readReport({ ...options(), listMergedPrs: async () => [{ number: 10, headRefName: 'branch', mergedAt }] }), /supply repository identity/);
    await assert.rejects(readReport({ ...options(), listMergedPrs: async () => [prs[0], { ...prs[1], url: 'https://github.com/other/repo/pull/11' }] }), /Unknown or mixed PR repository/);
    assert.equal((await readReport({ ...options(), repository, listMergedPrs: async () => [{ number: 10, headRefName: 'branch', mergedAt }] })).totals.mergedPrs, 1);
  });
  it('reads parent and subagent files separately by mtime and filters merges and ledger rows by window', async () => {
    const row = assistant('a', { input_tokens: 10 }, [text('Created PR #10')]);
    transcript('parent', [row]); transcript('child', [row], children);
    transcript('old', [row], project, now - 8 * 86400000);
    transcript('future', [row], project, now + 86400000);
    writeFileSync(join(projects, 'ignored.jsonl'), 'invalid root-level file');
    jsonl(ledger, [
      { at: mergedAt, repo: 'a/b', pr: 10, tokens: { input: 20 } },
      { at: mergedAt, repo: 'other/repo', pr: 10, tokens: { input: 999 } },
      { at: mergedAt, repo: 'https://foreign.example/a/b', pr: 10, tokens: { input: 999 } },
      { at: '2026-01-01T00:00:00Z', pr: 10, tokens: { input: 999 } },
      { at: '2027-01-01T00:00:00Z', pr: 10, tokens: { input: 999 } },
    ]);
    const report = await readReport({ ...options(), listMergedPrs: async () => [...prs,
      { number: 12, headRefName: 'old', mergedAt: '2026-01-01T00:00:00Z' }] });
    assert.equal(report.perPr[0].sessions, 2);
    assert.equal(report.perPr[0].claude.total, 20);
    assert.equal(report.perPr[0].codex.input, 20);
    assert.equal(report.perPr[0].codex.cached, null);
    assert.equal(report.totals.codexUnattributedRows, 2);
    assert.equal(report.totals.incompleteUsageMessages, 2);
    assert.equal(report.totals.mergedPrs, 2);
  });
  it('accepts an absent Codex ledger but rejects missing projects, corrupt ledger and failed PR reads', async () => {
    assert.equal((await readReport(options())).perPr[0].codex, null);
    await assert.rejects(readReport({ ...options(), projectsDir: join(temp, 'missing') }), /ENOENT/);
    writeFileSync(ledger, 'broken\n');
    await assert.rejects(readReport(options()), /Incomplete Codex ledger/);
    await assert.rejects(readReport({ ...options(), listMergedPrs: async () => { throw new Error('PR read failed'); } }), /PR read failed/);
  });
  it('rejects incomplete PR evidence and a saturated list with an operator fallback', async () => {
    await assert.rejects(readReport({ ...options(), listMergedPrs: async () => [{}] }), /Invalid merged PR evidence/);
    await assert.rejects(readReport({ ...options(), listMergedPrs: async () => Array.from({ length: 500 }, (_, i) => ({ ...prs[0], number: i + 1 })) }), /complete window-filtered listMergedPrs reader/);
    await assert.rejects(readReport({ ...options(), days: 0 }), /positive finite/);
  });
  it('applies the injected reader cap after window filtering', async () => {
    const mixed = Array.from({ length: 500 }, (_, i) => ({ ...prs[0], number: i + 1,
      mergedAt: i === 499 ? '2026-01-01T00:00:00Z' : mergedAt }));
    assert.equal((await readReport({ ...options(), listMergedPrs: async () => mixed })).totals.mergedPrs, 499);
    await assert.rejects(readReport({ ...options(), listMergedPrs: async () => [...mixed, prs[1]] }), /Merged PR limit reached; supply a complete window-filtered listMergedPrs reader/);
  });
  it('rejects a saturated default gh reader before future-date filtering can hide its cap', async () => {
    const listed = Array.from({ length: 2000 }, (_, i) => ({ ...prs[0], number: i + 1,
      mergedAt: i === 1000 ? '2026-11-11T12:00:00Z' : '2027-01-01T00:00:00Z' }));
    const gh = vi.fn(() => JSON.stringify(listed));
    await assert.rejects(readReport({ ...options(), listMergedPrs: undefined, gh }), /gh listing limit; shorten --days/);
    assert.equal(gh.mock.calls.length, 1);
    assert.deepEqual(gh.mock.calls[0][0], ['pr', 'list', '--state', 'merged', '--limit', '2000', '--json', 'number,headRefName,mergedAt,url']);
    assert.equal(gh.mock.calls[0][1].maxBuffer, 32 * 1024 * 1024);
  });
  it('allows 500+ default-reader results when the raw cap is not saturated inside the window', async () => {
    const listed = Array.from({ length: 1999 }, (_, i) => ({ ...prs[0], number: i + 1 }));
    const gh = () => JSON.stringify(listed);
    assert.equal((await readReport({ ...options(), listMergedPrs: undefined, gh })).totals.mergedPrs, 1999);
    // Oldest merge is deliberately in the middle: the cap must examine every date.
    listed[1000].mergedAt = '2026-01-01T00:00:00Z';
    listed.push({ ...prs[1], number: 2000 });
    assert.equal((await readReport({ ...options(), listMergedPrs: undefined, gh })).totals.mergedPrs, 1999);
  });
  it('refuses invalid default-reader merge dates before they can be filtered away', async () => {
    await assert.rejects(readReport({ ...options(), listMergedPrs: undefined,
      gh: () => JSON.stringify([{ ...prs[0], mergedAt: null }]) }), /Invalid merged PR evidence/);
  });
  it('writes baseline JSON and prints JSON or a short control-safe table', async () => {
    const output = [], out = join(temp, 'baseline.json');
    const spy = vi.spyOn(console, 'log').mockImplementation(value => { output.push(value); });
    const report = await main(['--days=7', '--json', `--out=${out}`], options());
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), report);
    assert.deepEqual(JSON.parse(output[0]), report);
    await main([], options());
    assert.match(output[1], /Claude tokens/);
    assert.match(output[1], /agy tokens: no source/);
    report.perPr[0].branch = '\u001b[31mevil\u0007';
    assert.doesNotMatch(formatReport(report), /[\u001b\u0007]/);
    await assert.rejects(main(['--unknown'], options()), /Unknown option/);
    spy.mockRestore();
  });
});
