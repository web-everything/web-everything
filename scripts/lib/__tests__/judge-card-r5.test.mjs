/** Audit 4: default production readers and writer, with only subprocess IO replaced. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => {
  vi.resetModules();
  process.env.WE_AUTOMATION_LOGINS = 'web-everything,web-everything[bot],other-automation[bot]';
  return { calls: [], comments: [], card: '', ancestor: true, fetch: true, tip: 'b'.repeat(40) };
});
vi.mock('node:child_process', async original => {
  const real = await original();
  const spawnSync = vi.fn((...args) => {
    try { return { status: 0, stdout: io.output(...args), stderr: '' }; }
    catch (error) { return { status: 1, stdout: '', stderr: error.message }; }
  });
  const execFileSync = vi.fn((...args) => io.output(...args));
  return { ...real, spawnSync, execFileSync, default: { ...real.default, spawnSync, execFileSync } };
});
const output = (command, args, options = {}) => {
    io.calls.push([command, args]);
    if (command === 'git') {
      if (args[0] === 'fetch') { if (!io.fetch) throw new Error('offline'); return ''; }
      if (args[0] === 'rev-parse') return io.tip;
      if (args[0] === 'ls-remote') return `${io.tip}\trefs/heads/main`;
      if (args[0] === 'merge-base') {
        // Cached origin/main still contains the SHA; the fresh tip does not.
        if (args.at(-1) !== 'origin/main' && !io.ancestor) throw new Error('not ancestor');
        return '';
      }
      if (args[0] === 'show') { if (io.card === null) throw new Error('absent'); return io.card; }
    }
    if (command === 'gh') {
      if (args.includes('installation/repositories?per_page=1')) return '1';
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ headRefOid: 'a'.repeat(40), labels: [], comments: io.comments });
      if (args[0] === 'pr' && args[1] === 'comment') {
        io.comments.push({ body: options.input, author: { login: 'web-everything[bot]' }, id: `c${io.comments.length}` });
        return '';
      }
      if (args[0] === 'api' && args.some(a => String(a).includes('/comments'))) {
        if (args.some(a => String(a).includes('@tsv'))) {
          const escape = s => String(s).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
          return io.comments.map((c, i) => [c.body, '2026-11-20T00:00:00Z', c.author.login, `c${i}`, ''].map(escape).join('\t')).join('\n');
        }
        return JSON.stringify(io.comments);
      }
      if (args[0] === 'api' && args[1] === 'graphql') return args.includes('--jq') ? String(io.comments.length)
        : JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: io.comments.length } } } } });
    }
    throw new Error(`unexpected process: ${command} ${args.join(' ')}`);
  };
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { CONFIRMED_BREAKS_DEFAULTS, gateOutcomesForHead, liveResultGateState, operatorRulingsOnLiveResult,
  parseRedTeamComment, readRedTeamDisposition, redTeamGateMarker, redTeamResultId } from '../red-team-gate.mjs';
import { operatorBoundComments } from '../operator-identity.mjs';
import { AUTOMATION_LOGINS, JUDGE_ATTRIBUTION, isJudgeAuthored } from '../marker-authorship.mjs';
import { createRecordRedTeamRulingSinks } from '../../operations/record-red-team-ruling-io.mjs';
import { RED_TEAM_RULING_CARD_EFFECT } from '../../operations/record-red-team-ruling.mjs';

const pr = 71, head = 'a'.repeat(40), mainSha = 'b'.repeat(40), cardRef = 'we:backlog/xabcdef-card.md';
const bot = body => ({ body, author: { login: 'web-everything' }, id: `c${io.comments.length}` });
function fixture(fields = {}, extra = []) {
  const result = bot(renderRedTeamComment({ pr, rev: head, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
    findings: [{ summary: 'break', file: 'src/x.js', line: 7, category: 'edge-case', impactIfUnfixed: 'broken', confirmedByRecheck: true,
      findingClass: 'coverage-or-style', classBasis: 'missing coverage', ...fields }, ...extra] }));
  if (fields.rawAlso) result.body += `\n   - Also class: ${fields.rawAlso}`;
  const parsed = parseRedTeamComment(result.body), resultId = redTeamResultId(parsed);
  const record = (outcome, line, login = 'web-everything') => ({ ...bot(redTeamGateMarker(pr, head, outcome, resultId)
    .replace(' -->', ' actor=judge:r10 -->') + `\n${JUDGE_ATTRIBUTION}\n${line}`), author: { login } });
  const release = record('operator-card', `- 1 finding(s) carded by the operator to \`${cardRef}\` (#1).\nPre-existing on main (${mainSha}): probe node probe.mjs; main=null pr=null`);
  const cap = bot(redTeamGateMarker(pr, head, 'round-cap', resultId) + '\n- 1 confirmed break(s) NOT sent back: held for the operator (#1).');
  const block = record('operator-block', '- 1 confirmed break(s) NOT sent back: held for a card (#1).');
  io.comments = [result, cap, block, release];
  io.card = `---\nstatus: open\n---\nBreak ${resultId}#1\n`;
  return { result, cap, release, resultId, findings: parsed.findings, record };
}
const read = () => readRedTeamDisposition({ comments: io.comments, pr, head });
function released(f) {
  expect(read().dispositions.get(1).state).toBe('released carded');
  expect(read().held).toEqual([]);
  expect(operatorBoundComments(io.comments)).toContain(f.release);
  expect(gateOutcomesForHead(io.comments, pr, head).has('operator-card')).toBe(true);
  expect(liveResultGateState(io.comments, pr, head).outcomes.has('operator-card')).toBe(true);
  expect(operatorRulingsOnLiveResult(io.comments, pr, head).carded.has(1)).toBe(true);
}
function held(f) {
  expect(read().held.map(f => f.index)).toContain(1);
  expect(operatorBoundComments(io.comments)).not.toContain(f.release);
  expect(gateOutcomesForHead(io.comments, pr, head).has('operator-card')).toBe(false);
  expect(liveResultGateState(io.comments, pr, head).outcomes.has('operator-card')).toBe(false);
  expect(operatorRulingsOnLiveResult(io.comments, pr, head).carded.has(1)).toBe(false);
}
beforeEach(() => {
  io.calls = []; io.fetch = true; io.ancestor = true; io.tip = mainSha;
  io.output = output;
});
afterEach(() => vi.unstubAllEnvs());
describe('audit 4 production judge card evidence', () => {
  it('refreshes main on each read; a SHA only ancestral to cached origin/main refuses', () => {
    const f = fixture(); released(f);
    io.calls = []; io.tip = 'c'.repeat(40); io.ancestor = false;
    held(f);
    expect(io.calls.some(([c, a]) => c === 'git' && a[0] === 'fetch' && a.includes('origin') && a.includes('main'))).toBe(true);
  });
  it('ignores another AUTOMATION_LOGINS member rather than granting every App judge authority', () => {
    const f = fixture(); released(f);
    expect(AUTOMATION_LOGINS).toContain('other-automation[bot]');
    f.release.author.login = 'other-automation[bot]';
    expect(isJudgeAuthored(f.release)).toBe(false);
    held(f);
  });
  it.each([
    ['security category', { category: 'security' }],
    ['security class', { findingClass: 'security-reachable-today' }],
    ['retained security class', { alsoClasses: ['security-reachable-today'] }],
    ['retained unknown security class', { rawAlso: 'security-injection' }],
    ['retained namespaced security class', { rawAlso: 'security/injection' }],
    ['security reachable today', { securityReachableToday: true }],
  ])('refuses %s despite coverage deferral', (_name, fields) => {
    released(fixture()); held(fixture(fields));
  });
  it('refuses a card release while another open security-category finding exists', () => {
    released(fixture());
    held(fixture({}, [{ summary: 'injection', category: 'security', file: 'src/y.js', line: 1, confirmedByRecheck: true,
      impactIfUnfixed: 'leak', findingClass: 'coverage-or-style', classBasis: 'coverage' }]));
  });
  it('refuses an open security-category finding reported by another source', () => {
    const f = fixture(); released(f);
    io.comments.push({ ...f.result, author: { login: 'another-reviewer' },
      body: f.result.body.replace('(edge-case,', '(security,') });
    held(f);
  });
  it.each(['unrelated', 'completed', 'duplicate status', 'nonexistent', 'pr-only', 'oversized', 'unreadable refresh'])('refuses %s backing card evidence', mode => {
    const f = fixture(); released(f);
    if (mode === 'unrelated') io.card = io.card.replace(f.resultId, '0'.repeat(16));
    if (mode === 'completed') io.card = io.card.replace('status: open', 'status: resolved');
    if (mode === 'duplicate status') io.card = io.card.replace('status: open', 'status: open\nstatus: resolved');
    if (mode === 'nonexistent') io.card = null;
    if (mode === 'pr-only') f.release.body = f.release.body.replace(cardRef, `${cardRef}@pr123`);
    if (mode === 'oversized') io.card += 'x'.repeat((1 << 20) + 1);
    if (mode === 'unreadable refresh') io.fetch = false;
    held(f);
  });
  it.each([['operator-block', 'held'], ['operator-block', 'send-back'], ['round-cap', 'held']])('an indexed human %s %s outranks a later judge card', (outcome, action) => {
    const f = fixture(); released(f);
    const line = action === 'held' ? '- 1 confirmed break(s) NOT sent back: held for a card (#1).'
      : '- 1 confirmed break(s) sent back to the fixer (#1).';
    const hold = { ...bot(redTeamGateMarker(pr, head, outcome, f.resultId) + `\n${line}`), author: { login: 'chalbert' } };
    io.comments.splice(2, 0, hold); held(f);
    expect(read().dispositions.get(1).state).toBe('held');
  });
  it('does no git IO without a judge card comment', () => {
    fixture(); io.comments.pop(); read(); operatorBoundComments(io.comments);
    expect(io.calls.filter(([c]) => c === 'git')).toEqual([]);
  });
  it('memoizes evidence within a pass but refreshes it on the next pass', () => {
    const f = fixture(); io.comments.push({ ...f.release });
    read();
    expect(io.calls.filter(([c, a]) => c === 'git' && a[0] === 'fetch')).toHaveLength(1);
    read();
    expect(io.calls.filter(([c, a]) => c === 'git' && a[0] === 'fetch')).toHaveLength(2);
  });
  it.each([true, false])('the default writer read-back agrees with every default reader (valid card=%s)', validCard => {
    const f = fixture(); io.comments.pop();
    if (!validCard) io.card = io.card.replace(f.resultId, '0'.repeat(16));
    const p = { repo: 'web-everything/web-everything', pr, head, resultId: f.resultId, indices: [1], findings: f.findings,
      setting: CONFIRMED_BREAKS_DEFAULTS, scope: { anyState: false }, actor: 'judge:r10', ruling: 'card', cardRef,
      reason: JUDGE_ATTRIBUTION, channel: 'judge', at: '2026-11-20T00:00:00Z',
      preExisting: { mainSha, probe: 'node probe.mjs', mainResult: 'null', prResult: 'null' } };
    const write = () => createRecordRedTeamRulingSinks()[RED_TEAM_RULING_CARD_EFFECT](p);
    if (validCard) expect(write).not.toThrow();
    else expect(write).toThrow(/not in the read-back/);
    const release = io.comments.find(c => c.body.includes('outcome=operator-card'));
    expect(release).toBeDefined();
    if (validCard) released({ release }); else held({ release });
  });
});
