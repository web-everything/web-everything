/**
 * Shadow round judge: each verdict path, the trigger detector, and fail-closed.
 */
import { describe, expect, it } from 'vitest';
import { detectRoundCap, extractRounds, formatJudgeLine, isGuardPath, judgeRound, parseReviewFindings, sameFinding, validateVerdict } from '../round-judge.mjs';
import { redTeamGateMarker } from '../red-team-gate.mjs';

const PR = 900;
const H = (n) => String(n).repeat(40).slice(0, 40);
const bot = (body, at) => ({ author: { login: 'web-everything' }, body, createdAt: at });
const op = (body, at) => ({ author: { login: 'chalbert' }, body, createdAt: at });
let t = 0;
const at = () => new Date(Date.UTC(2026, 9, 20, 0, t++, 0)).toISOString();

/** A red-team advisory round. findings: [file, line, summary, impact='broken', confirmed=true, category='failing-input'] */
function rt(head, findings) {
  const lines = findings.map(([file, line, summary, impact = 'broken', confirmed = true, category = 'failing-input'], i) =>
    `${i + 1}. [${confirmed ? '**confirmed**' : 'not confirmed'}] (${category}, ${impact}) \`${file}:${line}\` — ${summary}\n   - Scenario: s\n   - Re-check: demonstrated break`);
  return bot(`<!-- we:red-team-advisory pr=${PR} rev=${head} -->\n### Post-accept red team\n\n${lines.join('\n')}\n`, at());
}
const cap = (head) => bot(`${redTeamGateMarker(PR, head, 'round-cap', 'abcdef0123456789')}\n**Red-team gate** cap`, at());
const review = (bullets) => bot(`🔁 review — changes requested\n\nRecorded by agent (unattended review-loop) via the declared \`review-pr\` operation.\n\n### Findings\n${bullets.join('\n')}\n`, at());
const grantComment = (by = 1) => op(`➕ conveyor — review round extension granted\n\nOperator @chalbert granted +${by} auto-repair round(s) via claude-code-chat\n\n> r\n\n<!-- round-extension: ${JSON.stringify({ version: 1, repo: 'web-everything/web-everything', pr: PR, by, actor: 'chalbert', channel: 'claude-code-chat', reason: 'r', at: '2026-10-20T00:00:00.000Z' })} -->`, at());
const REPO = 'web-everything/web-everything';
const judge = (comments, extra = {}) => judgeRound({ pr: PR, repo: REPO, head: H(9), trigger: 'red-team-cap', comments, ...extra });

describe('verdict paths', () => {
  it('grant(+1): findings shrink and none is re-raised', () => {
    const r = judge([
      rt(H(1), [['src/a.mjs', 10, 'alpha parser drops the trailing record'], ['src/b.mjs', 20, 'beta cache never expires entries'], ['src/c.mjs', 30, 'gamma retry loop spins forever']]),
      rt(H(9), [['src/d.mjs', 5, 'delta timeout unit mismatch in header'], ['src/e.mjs', 8, 'epsilon path join loses the drive']]),
    ]);
    expect(r).toMatchObject({ verdict: 'grant', k: 1 });
    expect(r.reasons[0]).toMatch(/shrinking-3-to-2/);
  });
  it('grant(+2): findings at least halve down to two or fewer', () => {
    const r = judge([
      rt(H(1), [['a.mjs', 1, 'one aaaa broke'], ['b.mjs', 2, 'two bbbb broke'], ['c.mjs', 3, 'three cccc broke'], ['d.mjs', 4, 'four dddd broke']]),
      rt(H(9), [['z.mjs', 9, 'brand new zzzz problem']]),
    ]);
    expect(r).toMatchObject({ verdict: 'grant', k: 2 });
  });
  it('send-back (default): findings change without shrinking', () => {
    const r = judge([rt(H(1), [['a.mjs', 1, 'alpha failure in parser']]), rt(H(9), [['b.mjs', 2, 'beta failure in cache']])]);
    expect(r.verdict).toBe('send-back');
    expect(r.reasons[0]).toMatch(/changing/);
  });
  it('send-back: first round has nothing to compare', () => {
    expect(judge([rt(H(9), [['a.mjs', 1, 'alpha failure in parser']])])).toMatchObject({ verdict: 'send-back', reasons: ['first-round-nothing-to-compare'] });
  });
  it('send-back: a finding re-raised once (same file:line)', () => {
    const r = judge([rt(H(1), [['a.mjs', 1, 'alpha failure in parser']]), rt(H(9), [['a.mjs', 1, 'something reworded entirely different']])]);
    expect(r.verdict).toBe('send-back');
    expect(r.reasons[0]).toMatch(/repeating-1-of-1/);
  });
  it('send-back: nothing parseable for the trigger', () => {
    expect(judge([])).toMatchObject({ verdict: 'send-back', reasons: ['no-parseable-findings-for-trigger'] });
  });
  it('card-the-rest: only degraded / coverage findings are open', () => {
    const r = judge([
      rt(H(1), [['a.mjs', 1, 'alpha minor gap', 'degraded']]),
      rt(H(9), [['b.mjs', 2, 'beta minor gap', 'degraded'], ['c.mjs', 3, 'gamma unproven path', 'degraded', false]]),
    ]);
    expect(r.verdict).toBe('card-the-rest');
  });
  it('card-the-rest NEVER covers a confirmed broken finding', () => {
    const r = judge([rt(H(1), [['a.mjs', 1, 'alpha failure in parser']]), rt(H(9), [['b.mjs', 2, 'beta failure in cache'], ['c.mjs', 3, 'coverage gap only', 'degraded']])]);
    expect(r.verdict).not.toBe('card-the-rest');
  });
  it('card-the-rest on a review round whose findings are all COVERAGE', () => {
    const r = judgeRound({ pr: PR, repo: REPO, head: H(9), trigger: 'review-cap', comments: [
      review(['- `src/a.mjs:4` — COVERAGE: restart test cannot detect early cursor advance', '- `src/b.mjs:9` — dead lock recovery has no test _[impact if unfixed: degraded]_']),
    ] });
    expect(r.verdict).toBe('card-the-rest');
  });
  it('suggest-split: the diff keeps growing between observations', () => {
    const r = judge([rt(H(1), [['a.mjs', 1, 'alpha failure in parser']]), rt(H(9), [['b.mjs', 2, 'beta failure in cache']])], { diff: { size: 900, prevSize: 500 } });
    expect(r.verdict).toBe('suggest-split');
    expect(r.reasons[0]).toMatch(/diff-grew-400/);
  });
  it('suggest-split: the finding surface widens into new files three rounds running', () => {
    const r = judge([
      rt(H(1), [['a.mjs', 1, 'alpha failure parser']]),
      rt(H(2), [['b.mjs', 2, 'beta failure cache']]),
      rt(H(9), [['c.mjs', 3, 'gamma failure queue'], ['d.mjs', 4, 'delta failure lock']]),
    ]);
    expect(r.verdict).toBe('suggest-split');
  });
  it('escalate: a guard / gate file is touched', () => {
    const r = judge([rt(H(1), [['a.mjs', 1, 'alpha failure parser']]), rt(H(9), [['b.mjs', 2, 'beta failure cache']])], { files: ['scripts/lib/red-team-gate.mjs'] });
    expect(r.verdict).toBe('escalate');
    expect(r.reasons[0]).toMatch(/guard-file-touched/);
  });
  it('escalate: the same finding came back unfixed after more than one send-back', () => {
    const f = ['a.mjs', 7, 'alpha failure in parser'];
    const r = judge([rt(H(1), [f]), rt(H(2), [f]), rt(H(9), [f])]);
    expect(r.verdict).toBe('escalate');
    expect(r.reasons[0]).toMatch(/unfixed-after-2-send-backs/);
  });
  it('escalate: a broken finding reads like a guard being weakened', () => {
    const r = judge([rt(H(1), [['a.mjs', 1, 'alpha failure parser']]), rt(H(9), [['b.mjs', 2, 'the new check is fail-open when the ledger is unreadable']])]);
    expect(r.verdict).toBe('escalate');
    expect(r.reasons[0]).toMatch(/possible-guard-weakening/);
  });
  it('escalate: converging but the grant allowance is already spent', () => {
    const r = judge([
      grantComment(), grantComment(), grantComment(),
      rt(H(1), [['a.mjs', 1, 'one aaaa broke'], ['b.mjs', 2, 'two bbbb broke'], ['c.mjs', 3, 'three cccc broke']]),
      rt(H(9), [['z.mjs', 9, 'brand new zzzz problem']]),
    ]);
    expect(r.verdict).toBe('escalate');
    expect(r.reasons[0]).toMatch(/3-grants-already-spent/);
  });
  it('notes red-team edge-case drift as a reason', () => {
    const r = judge([
      rt(H(1), [['a.mjs', 1, 'one aaaa broke'], ['b.mjs', 2, 'two bbbb broke'], ['c.mjs', 3, 'three cccc broke']]),
      rt(H(9), [['z.mjs', 9, 'rare zzzz argv shape', 'broken', true, 'edge-case']]),
    ]);
    expect(r.verdict).toBe('grant');
    expect(r.reasons).toContain('edge-case-drift');
  });
});

describe('review-cap spent on mechanical re-pushes', () => {
  const accepted = () => bot('✅ review — accepted\n\nRecorded by agent (unattended review-loop)', at());
  const repush = () => bot('🔧 conveyor fix — re-armed for re-review\n\nThe previously accepted PR was re-pushed and its acceptance is being re-checked', at());
  it('grant(+1) when the cap went on re-pushes and the latest review accepted', () => {
    const r = judgeRound({ pr: PR, repo: REPO, head: H(9), trigger: 'review-cap', files: ['backlog/1-a.md'], comments: [repush(), accepted(), repush(), accepted()] });
    expect(r).toMatchObject({ verdict: 'grant', k: 1 });
    expect(r.reasons).toEqual(['cap-spent-on-2-mechanical-re-pushes', 'latest-review-accepted', 'card-only']);
  });
  it('no accept (or no re-pushes) stays send-back', () => {
    expect(judgeRound({ pr: PR, repo: REPO, head: H(9), trigger: 'review-cap', comments: [repush(), repush()] }).verdict).toBe('send-back');
    expect(judgeRound({ pr: PR, repo: REPO, head: H(9), trigger: 'review-cap', comments: [accepted()] }).verdict).toBe('send-back');
  });
  it('a prose statute doc alone is not a guard file', () => {
    expect(isGuardPath('docs/agent/platform-decisions.md')).toBe(false);
  });
});

describe('fail closed', () => {
  it('an unknown trigger escalates, logged as fail-closed', () => {
    const r = judgeRound({ pr: PR, head: H(9), trigger: 'nope', comments: [] });
    expect(r).toMatchObject({ verdict: 'escalate' });
    expect(r.reasons[0]).toMatch(/^fail-closed: judge threw/);
    expect(r.evidence.failClosed).toBe(true);
  });
  it('a throwing setting escalates', () => {
    const setting = new Proxy({}, { get() { throw new Error('boom'); } });
    expect(judge([rt(H(1), [['a.mjs', 1, 'alpha failure parser']]), rt(H(9), [['b.mjs', 2, 'beta failure cache']])], { setting }).verdict).toBe('escalate');
  });
  it('a model verdict that fails the schema escalates', () => {
    const base = [rt(H(1), [['a.mjs', 1, 'alpha failure parser']]), rt(H(9), [['b.mjs', 2, 'beta failure cache']])];
    for (const bad of [null, { verdict: 'approve', reasons: ['x'] }, { verdict: 'grant', reasons: ['x'] }, { verdict: 'send-back', reasons: [] }]) {
      expect(judge(base, { llm: () => bad }).verdict).toBe('escalate');
    }
    expect(judge(base, { llm: () => { throw new Error('quota'); } }).verdict).toBe('escalate');
  });
  it('a model can only be stricter, never looser', () => {
    const base = [rt(H(1), [['a.mjs', 1, 'alpha failure parser']]), rt(H(9), [['b.mjs', 2, 'beta failure cache']])];
    expect(judge(base, { llm: () => ({ verdict: 'grant', k: 1, reasons: ['looks fine'] }) })).toMatchObject({ verdict: 'send-back' });
    expect(judge(base, { llm: () => ({ verdict: 'escalate', reasons: ['unsure'] }) }).verdict).toBe('escalate');
  });
  it('validateVerdict', () => {
    expect(validateVerdict({ verdict: 'grant', k: 2, reasons: ['r'] }).ok).toBe(true);
    expect(validateVerdict({ verdict: 'send-back', k: 1, reasons: ['r'] }).ok).toBe(false);
  });
});

describe('detectRoundCap', () => {
  const live = H(9);
  it('red-team-cap: the gate round-cap record for the live head', () => {
    expect(detectRoundCap({ comments: [rt(live, [['a.mjs', 1, 'x aaaa']]), cap(live)], pr: PR, head: live })).toMatchObject({ trigger: 'red-team-cap' });
  });
  it('a later sent-back record for that head clears it', () => {
    const c = cap(live);
    const sent = bot(`${redTeamGateMarker(PR, live, 'sent-back', 'abcdef0123456789')}\nx`, at());
    expect(detectRoundCap({ comments: [c, sent], pr: PR, head: live })).toBeNull();
  });
  it('a cap record for another head is stale', () => {
    expect(detectRoundCap({ comments: [cap(H(1))], pr: PR, head: live })).toBeNull();
  });
  it('review-cap: status at-round-limit', () => {
    expect(detectRoundCap({ comments: [], pr: PR, head: live, state: 'at-round-limit' })).toMatchObject({ trigger: 'review-cap' });
  });
  it('review-cap: the exhausted note stands only until a grant', () => {
    const note = bot('🔔 conveyor — needs your decision\n\nneeds your decision: auto-repair rounds exhausted\n\n<!-- conveyor-note-key: round-cap-exhausted:900:review:6/5 -->', at());
    expect(detectRoundCap({ comments: [note], pr: PR, head: live, state: 'needs-you', repo: REPO })).toMatchObject({ trigger: 'review-cap' });
    expect(detectRoundCap({ comments: [note, grantComment()], pr: PR, head: live, state: 'needs-you', repo: REPO })).toBeNull();
  });
  it('nothing at a cap -> null', () => {
    expect(detectRoundCap({ comments: [], pr: PR, head: live, state: 'awaiting-review' })).toBeNull();
  });
});

describe('helpers', () => {
  it('sameFinding: same file:line, or near-identical summary in the same file', () => {
    expect(sameFinding({ file: 'a', line: 1, summary: 'x' }, { file: 'a', line: 1, summary: 'totally different words here' })).toBe(true);
    expect(sameFinding({ file: 'a', line: 1, summary: 'cursor advances before the write lands' }, { file: 'a', line: 9, summary: 'the cursor advances before write lands' })).toBe(true);
    expect(sameFinding({ file: 'a', line: 1, summary: 'cursor advances before the write lands' }, { file: 'b', line: 1, summary: 'cursor advances before the write lands' })).toBe(false);
  });
  it('parseReviewFindings reads bullets, impact tags and COVERAGE', () => {
    const f = parseReviewFindings('- `x.mjs:3` — COVERAGE: no test\n- `y.mjs:4` — real bug _[PLAUSIBLE]_ _[impact if unfixed: degraded]_\n1. `z.mjs` (judge) — broken thing');
    expect(f.map((x) => [x.file, x.line, x.impact])).toEqual([['x.mjs', 3, 'degraded'], ['y.mjs', 4, 'degraded'], ['z.mjs', null, null]]);
  });
  it('extractRounds ignores untrusted authors, conflict bounces and operator decisions', () => {
    const rounds = extractRounds([
      { author: { login: 'rando' }, body: rt(H(1), [['a.mjs', 1, 'x aaaa']]).body, createdAt: at() },
      bot('🔁 review — changes requested\n\nRecorded by parked-pr-conflict-watch\n\n- `a.mjs:1` — conflict', at()),
      op('🔁 review — changes requested\n\nRecorded by chalbert via claude-code-chat.\n\n1. `a.mjs:1` — do it', at()),
    ], PR);
    expect(rounds).toEqual([]);
  });
  it('isGuardPath', () => {
    expect(isGuardPath('scripts/lib/red-team-gate.mjs')).toBe(true);
    expect(isGuardPath('.github/workflows/ci.yml')).toBe(true);
    expect(isGuardPath('scripts/lib/round-judge.mjs')).toBe(false);
  });
  it('formatJudgeLine', () => {
    expect(formatJudgeLine(7, { verdict: 'grant', k: 2, reasons: ['a', 'b'] })).toBe('round-judge-shadow: #7 verdict=grant(+2) reasons=a;b');
    expect(formatJudgeLine(7, { verdict: 'send-back', reasons: ['a'] })).toBe('round-judge-shadow: #7 verdict=send-back reasons=a');
  });
});
