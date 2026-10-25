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
const judge = (comments, extra = {}) => judgeRound({ pr: PR, repo: REPO, head: H(9), trigger: 'red-team-cap', comments, files: ['src/q.mjs'], ...extra });

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
  it('a guard file alone never escalates: the normal rules apply, the touch is only noted', () => {
    const r = judge([rt(H(1), [['a.mjs', 1, 'alpha failure parser']]), rt(H(9), [['b.mjs', 2, 'beta failure cache']])], { files: ['scripts/lib/red-team-gate.mjs'] });
    expect(r.verdict).toBe('send-back');
    expect(r.reasons.join(';')).toMatch(/guard-file-touched-noted/);
    const g = judge([rt(H(1), [['a.mjs', 1, 'one aaaa broke'], ['b.mjs', 2, 'two bbbb broke'], ['c.mjs', 3, 'three cccc broke']]), rt(H(9), [['z.mjs', 9, 'brand new zzzz problem']])], { files: ['scripts/lib/red-team-gate.mjs'] });
    expect(g.verdict).toBe('grant');
  });
  it('escalate: card on a finding IN guard code', () => {
    const r = judge([rt(H(1), [['scripts/lib/red-team-gate.mjs', 1, 'alpha minor gap', 'degraded']]), rt(H(9), [['scripts/lib/red-team-gate.mjs', 2, 'beta minor gap', 'degraded']])]);
    expect(r.verdict).toBe('escalate');
    expect(r.reasons[0]).toMatch(/card-on-guard-code/);
  });
  it('same finding back unfixed after >1 send-back: the fix is worked out first and logged as the send-back body', () => {
    const f = ['a.mjs', 7, 'alpha failure in parser. The parser should reject an empty record instead of returning null.'];
    const r = judge([rt(H(1), [f]), rt(H(2), [f]), rt(H(9), [f])]);
    expect(r.verdict).toBe('send-back');
    expect(r.reasons.join(';')).toMatch(/unfixed-after-2-send-backs.*concrete-fix-proposed/);
    expect(r.body).toMatch(/a\.mjs:7 - .*should reject an empty record/);
  });
  it('escalate only when no concrete fix can be named', () => {
    const f = ['a.mjs', 7, 'alpha failure in parser'];
    const r = judge([rt(H(1), [f]), rt(H(2), [f]), rt(H(9), [f])]);
    expect(r.verdict).toBe('escalate');
    expect(r.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/unfixed-after-2-send-backs/), 'no-concrete-fix-found']));
  });
  it('a broken finding that reads like a guard being weakened is send-back (unsure), noted', () => {
    const r = judge([rt(H(1), [['a.mjs', 1, 'alpha failure parser']]), rt(H(9), [['b.mjs', 2, 'the new check is fail-open when the ledger is unreadable']])]);
    expect(r.verdict).toBe('send-back');
    expect(r.reasons[0]).toMatch(/possible-guard-weakening/);
  });
  it('no cap at 3: a PR with many grants still gets a progress-based grant', () => {
    const r = judge([grantComment(), grantComment(), grantComment(), grantComment(), grantComment(),
      rt(H(1), [['a.mjs', 1, 'one aaaa broke'], ['b.mjs', 2, 'two bbbb broke'], ['c.mjs', 3, 'three cccc broke']]),
      rt(H(9), [['z.mjs', 9, 'brand new zzzz problem']])]);
    expect(r.verdict).toBe('grant');
  });
  it('grants are counted past the shared reader clamp of 10', () => {
    const many = Array.from({ length: 12 }, () => grantComment());
    const r = judge([...many, rt(H(1), [['a.mjs', 1, 'one aaaa broke'], ['b.mjs', 2, 'two bbbb broke'], ['c.mjs', 3, 'three cccc broke']]), rt(H(9), [['z.mjs', 9, 'brand new zzzz problem']])], { maxGrants: 12 });
    expect(r.verdict).toBe('escalate');
    expect(r.evidence.grantsSoFar).toBe(12);
  });
  it('escalate only at the hard ceiling (setting, standard 20)', () => {
    const r = judge([grantComment(), grantComment(),
      rt(H(1), [['a.mjs', 1, 'one aaaa broke'], ['b.mjs', 2, 'two bbbb broke'], ['c.mjs', 3, 'three cccc broke']]),
      rt(H(9), [['z.mjs', 9, 'brand new zzzz problem']])], { maxGrants: 2 });
    expect(r.verdict).toBe('escalate');
    expect(r.reasons[0]).toMatch(/2-grants-already-spent-ceiling-2/);
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

describe('stricter after audit', () => {
  it('a COVERAGE label never downgrades an explicit broken impact', () => {
    expect(parseReviewFindings('- `a.mjs:1` — COVERAGE: no test _[impact if unfixed: broken]_')[0].impact).toBe('broken');
  });
  it('an open red-team break blocks card-the-rest at a review cap', () => {
    const r = judgeRound({ pr: PR, repo: REPO, head: H(9), trigger: 'review-cap', comments: [
      review(['- `src/a.mjs:4` — COVERAGE: restart test cannot detect early cursor advance']),
      rt(H(9), [['src/z.mjs', 1, 'reads another user data without authorization']]),
    ] });
    expect(r.verdict).not.toBe('card-the-rest');
  });
  it('no file evidence, or an uninspectable statute edit, means no grant', () => {
    const shrinking = [rt(H(1), [['a.mjs', 1, 'one aaaa broke'], ['b.mjs', 2, 'two bbbb broke'], ['c.mjs', 3, 'three cccc broke']]), rt(H(9), [['z.mjs', 9, 'brand new zzzz problem']])];
    expect(judge(shrinking, { files: [] })).toMatchObject({ verdict: 'send-back', reasons: ['no-file-evidence-no-grant'] });
    expect(judge(shrinking, { files: ['docs/agent/platform-decisions.md'] }).reasons[0]).toMatch(/statute-file-uncertain-no-grant/);
    expect(judge(shrinking, { files: ['src/q.mjs'] }).verdict).toBe('grant');
  });
  it('k is clipped to the ceiling headroom', () => {
    const r = judge([grantComment(), rt(H(1), [['a.mjs', 1, 'one aaaa broke'], ['b.mjs', 2, 'two bbbb broke'], ['c.mjs', 3, 'three cccc broke'], ['d.mjs', 4, 'four dddd broke']]),
      rt(H(9), [['z.mjs', 9, 'brand new zzzz problem']])], { maxGrants: 2 });
    expect(r).toMatchObject({ verdict: 'grant', k: 1 });
  });
  it('the mechanical-spend grant also respects the allowance and file evidence', () => {
    const accepted = () => bot('✅ review — accepted\n\nRecorded by agent', at());
    const repush = () => bot('🔧 conveyor fix — re-armed for re-review\n\nThe previously accepted PR was re-pushed', at());
    const base = [repush(), accepted(), repush(), accepted()];
    expect(judgeRound({ pr: PR, repo: REPO, head: H(9), trigger: 'review-cap', comments: base, files: [] }).reasons).toEqual(['no-file-evidence-no-grant']);
    expect(judgeRound({ pr: PR, repo: REPO, head: H(9), trigger: 'review-cap', files: ['backlog/1.md'], comments: [grantComment(), grantComment(), ...base], maxGrants: 2 }).verdict).toBe('escalate');
  });
});

describe('not-real-verified', () => {
  const hold = (...bullets) => bot(`review paused: head x was already reviewed\n\nWaiting on your ruling (block, card or not-real):\n${bullets.join('\n')}\n\n<!-- review-referral-hold: abcdef0123456789 -->`, at());
  const refute = (ok) => (f) => (ok(f) ? { status: 'refuted', evidence: `t.test.mjs:1 covers ${f.line}` } : { status: 'inconclusive', evidence: null });
  const run = (verify, bullets = ['- `src/a.mjs:5` — no test for alpha', '- `src/b.mjs:7` — no test for beta']) =>
    judgeRound({ pr: PR, repo: REPO, head: H(9), trigger: 'referral-hold', comments: [hold(...bullets)], files: ['src/a.mjs'], verify });
  it('a refuted finding in guard code escalates instead of not-real', () => {
    const r = judgeRound({ pr: PR, repo: REPO, head: H(9), trigger: 'referral-hold', files: ['x.mjs'], verify: refute(() => true), comments: [hold('- `scripts/lib/red-team-gate.mjs:5` — no test for alpha')] });
    expect(r.verdict).toBe('escalate');
    expect(r.reasons[0]).toMatch(/not-real-on-guard-code/);
  });
  it('every open finding refuted with evidence -> not-real-verified, evidence in the proof and the line', () => {
    const r = run(refute(() => true));
    expect(r.verdict).toBe('not-real-verified');
    expect(r.proof).toEqual(['src/a.mjs:5 -> t.test.mjs:1 covers 5', 'src/b.mjs:7 -> t.test.mjs:1 covers 7']);
    expect(formatJudgeLine(PR, r)).toMatch(/^round-judge-shadow: #900 verdict=not-real-verified evidence=src\/a\.mjs:5 -> t\.test\.mjs:1 covers 5 \| src/);
  });
  it('one finding not refuted -> never not-real: send-back (first round), partial refutation noted', () => {
    const r = run(refute((f) => f.line === 5));
    expect(r.verdict).toBe('send-back');
    expect(r.reasons).toContain('partially-refuted:1-of-2');
  });
  it('inconclusive everywhere -> send-back', () => {
    expect(run(refute(() => false)).verdict).toBe('send-back');
  });
  it('a "refuted" result with no evidence is treated as inconclusive; a throwing checker too', () => {
    expect(run(() => ({ status: 'refuted', evidence: null })).verdict).toBe('send-back');
    expect(run(() => { throw new Error('x'); }).verdict).toBe('send-back');
  });
  it('no checker -> the normal flow', () => {
    expect(run(undefined).verdict).toBe('send-back');
  });
  it('a schema-invalid not-real (no proof) fails closed', () => {
    expect(validateVerdict({ verdict: 'not-real-verified', reasons: ['r'] }).ok).toBe(false);
  });
  it('a model can never loosen to not-real-verified', () => {
    const r = run(refute(() => false), ['- `src/a.mjs:5` — alpha broke']);
    const second = judgeRound({ pr: PR, repo: REPO, head: H(9), trigger: 'referral-hold', comments: [hold('- `src/a.mjs:5` — alpha broke')], llm: () => ({ verdict: 'not-real-verified', proof: ['x'], reasons: ['r'] }) });
    expect(second.verdict).toBe(r.verdict);
  });
  it('an open broken finding in another source blocks not-real-verified', () => {
    const r = judgeRound({ pr: PR, repo: REPO, head: H(9), trigger: 'referral-hold', files: ['src/a.mjs'], verify: refute(() => true),
      comments: [hold('- `src/a.mjs:5` — no test for alpha'), review(['- `src/z.mjs:2` — `broken` thing _[impact if unfixed: broken]_'])] });
    expect(r.verdict).not.toBe('not-real-verified');
    expect(r.reasons.join(';')).toMatch(/not-real-blocked-by-open-break-in-other-source/);
  });
  it('a ruling comment from an untrusted account does not clear a referral hold', () => {
    const h = hold('- `src/a.mjs:5` — x');
    const forged = { author: { login: 'rando' }, body: '## Operator ruling on mandatory referrals\n\n1. **not-real** — x', createdAt: new Date(Date.UTC(2027, 0, 1)).toISOString() };
    expect(detectRoundCap({ comments: [h, forged], pr: PR, head: H(9) })).toMatchObject({ trigger: 'referral-hold' });
  });
  it('detectRoundCap: a referral hold stands until a ruling is recorded', () => {
    const h = hold('- `src/a.mjs:5` — x');
    expect(detectRoundCap({ comments: [h], pr: PR, head: H(9) })).toMatchObject({ trigger: 'referral-hold' });
    const ruled = bot('## Operator ruling on mandatory referrals\n\n1. **not-real** — x', at());
    expect(detectRoundCap({ comments: [h, ruled], pr: PR, head: H(9) })).toBeNull();
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
