import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contributionPatchId, findCarriableVerdict, decideRebaseVerdictCarry, buildVerdictCarriedMarker, parseVerdictCarriedMarker, resolveCarryAcrossRebase } from '../rebase-verdict-carry.mjs';
const a = 'a'.repeat(40), b = 'b'.repeat(40), p = 'c'.repeat(40);
const comment = body => ({ author: { login: 'chalbert' }, body });

describe('multi-hop carry chain', () => {
  const c = 'c'.repeat(40), d = 'd'.repeat(40);
  const adv = rev => [`<!-- we:red-team-advisory pr=1 rev=${rev} -->`, '### Post-accept red team — no break found', '',
    'Advisory only: this comment changes no label itself; the red-team gate (setting `redTeam.confirmedBreaks`) sends a confirmed broken break back to the fixer. '
      + `Head \`${a.slice(0, 12)}\` · red team codex/test · re-check ok · recorded verdict \`accept\`.`, '',
    'The red team tried to break this change and reported nothing.'].join('\n');
  const cs = () => [
    { ...comment(`✅ review — accepted\n<!-- reviewed-sha: ${a} -->`), createdAt: '2026-11-01T00:00:00Z' },
    comment(adv(a)), comment(`📌 review — acceptance re-stamped\n<!-- reviewed-sha: ${b} -->`),
    comment(`${buildVerdictCarriedMarker({ fromSha: a, toSha: b, patchId: p })}\nReview verdict carried across an identical contribution.\n${adv(b)}`),
    { ...comment(`📌 review — acceptance re-stamped\n<!-- reviewed-sha: ${c} -->`), createdAt: '2026-11-03T00:00:00Z' },
    comment(`${buildVerdictCarriedMarker({ fromSha: b, toSha: c, patchId: p })}\nReview verdict carried across an identical contribution.\n${adv(c)}`),
  ];
  it('carries the plain chain with reviews []', () => expect(findCarriableVerdict({ comments: cs(), headSha: d, pr: 1, reviews: [] })?.sha).toBe(c));
  it.each([undefined, null, {}, [{ state: 'CHANGES_REQUESTED', submitted_at: '2026-11-02T00:00:00Z' }],
    [{ state: 'COMMENTED', submitted_at: '2026-11-02T00:00:00Z', user: { login: 'operator' } },
      { state: 'APPROVED', submitted_at: '2026-11-02T01:00:00Z', user: { login: 'operator' } }]].map(reviews => [reviews]))(
    'refuses missing, unreadable or objecting formal-review evidence %j', reviews =>
      expect(findCarriableVerdict({ comments: cs(), headSha: d, pr: 1, reviews })).toBeNull());
  it('preserves a later changes-requested verdict', () => expect(findCarriableVerdict({
    comments: [...cs(), comment('🔁 review — changes requested')], headSha: d, pr: 1, reviews: [],
  })).toBeNull());
  it.each(['missing sentence', 'quoted', 'wrong gate label'])('refuses a filtered non-canonical multi-hop candidate: %s', mode => {
    const comments = cs();
    if (mode === 'missing sentence') comments.at(-1).body = comments.at(-1).body.replace('Review verdict carried across an identical contribution.\n', '');
    if (mode === 'quoted') comments.at(-1).body = `> ${comments.at(-1).body}`;
    if (mode === 'wrong gate label') comments.at(-1).body = `<!-- we:red-team-gate pr=2 rev=${c} outcome=card-queued -->\n${comments.at(-1).body}`;
    expect(findCarriableVerdict({ comments, headSha: d, pr: 1, reviews: [] })).toBeNull();
  });
  it('carries the gate-prefixed chain with reviews []', async () => {
    const { redTeamResultId, parseRedTeamComment, redTeamGateMarker } = await import('../red-team-gate.mjs');
    const comments = cs(), result = redTeamResultId(parseRedTeamComment(adv(a)));
    for (const [index, sha] of [[3, b], [5, c]]) comments[index].body = `${redTeamGateMarker(1, sha, 'card-queued', result)}\n${comments[index].body}`;
    expect(findCarriableVerdict({ comments, headSha: d, pr: 1, reviews: [] })?.sha).toBe(c);
  });
});
describe('verdict carry', () => {
  it('validates markers and decisions', () => {
    expect(parseVerdictCarriedMarker(buildVerdictCarriedMarker({ fromSha: a, toSha: b, patchId: p }))).toEqual({ fromSha: a, toSha: b, patchId: p });
    for (const key of ['fromSha', 'toSha', 'patchId']) expect(() => buildVerdictCarriedMarker({ fromSha: a, toSha: b, patchId: p, [key]: 'bad' })).toThrow();
    expect(parseVerdictCarriedMarker('bad')).toBeNull();
    const facts = { setting: 'on', prior: { sha: a }, priorPatchId: p, headPatchId: p };
    expect(decideRebaseVerdictCarry(facts).carry).toBe(true);
    for (const change of [{ setting: 'off' }, { prior: null }, { priorPatchId: null }, { headPatchId: null }, { headPatchId: a }]) expect(decideRebaseVerdictCarry({ ...facts, ...change }).carry).toBe(false);
  });
  it('trusts authors and refuses superseding holds', () => {
    const accept = comment(`<!-- reviewed-sha: ${a} -->`);
    expect(findCarriableVerdict({ reviews: [], comments: [accept], headSha: b })).toBeNull();
    expect(findCarriableVerdict({ reviews: [], comments: [accept], headSha: a })).toBeNull();
    expect(findCarriableVerdict({ reviews: [], comments: [{ ...accept, author: { login: 'stranger' } }], headSha: b })).toBeNull();
    for (const body of ['🔁 review — changes requested', '<!-- drain-park-reason -->\nnew policy park', 'review paused: revoke']) expect(findCarriableVerdict({ reviews: [], comments: [accept, comment(body)], headSha: b })).toBeNull();
    const gate = comment(`<!-- we:red-team-gate pr=1 rev=${a} outcome=card-queued -->`);
    expect(findCarriableVerdict({ reviews: [], comments: [accept, gate], headSha: b, pr: 1 }).gateOutcomes).toEqual(['card-queued']);
    for (const outcome of ['sent-back', 'round-cap']) {
      expect(findCarriableVerdict({ reviews: [], comments: [accept, comment(`<!-- we:red-team-gate pr=1 rev=${a} outcome=${outcome} -->`)], headSha: b, pr: 1 })).toBeNull();
    }
    const carried = comment(buildVerdictCarriedMarker({ fromSha: b, toSha: a, patchId: p }));
    expect(findCarriableVerdict({ reviews: [], comments: [accept, gate, carried], headSha: b })?.sha).toBe(a);
    const advisoryBody = `<!-- we:red-team-advisory pr=1 rev=${a} -->\nNo confirmed breaks.`;
    const combined = comment(`${buildVerdictCarriedMarker({ fromSha: b, toSha: a, patchId: p })}\n${advisoryBody}`);
    expect(findCarriableVerdict({ reviews: [], comments: [accept, combined], headSha: b })?.advisoryBody).toBe(advisoryBody);
  });
  it('requires a trusted completed red-team record for the accepted PR and head', () => {
    const accept = comment(`<!-- reviewed-sha: ${a} -->`);
    for (const record of [null,
      comment(`<!-- we:red-team-gate pr=2 rev=${a} outcome=card-queued -->`),
      comment(`<!-- we:red-team-gate pr=1 rev=${b} outcome=card-queued -->`),
      comment(`<!-- we:red-team-advisory pr=2 rev=${a} -->`),
      comment(`<!-- we:red-team-advisory pr=1 rev=${b} -->`),
      { author: { login: 'stranger' }, body: `<!-- we:red-team-advisory pr=1 rev=${a} -->` },
    ]) {
      expect(findCarriableVerdict({ reviews: [], comments: [record, accept].filter(Boolean), headSha: b, pr: 1 }), record?.body).toBeNull();
    }
    for (const body of [`<!-- we:red-team-gate pr=1 rev=${a} outcome=card-queued -->`,
      `<!-- we:red-team-advisory pr=1 rev=${a} -->\nNo confirmed breaks.`]) {
      expect(findCarriableVerdict({ reviews: [], comments: [accept, comment(body)], headSha: b, pr: 1 })?.sha).toBe(a);
    }
  });
  it('drops only trusted same-sha provenance and preserves later holds', () => {
    const accept = comment(`<!-- reviewed-sha: ${a} -->`);
    const carry = buildVerdictCarriedMarker({ fromSha: b, toSha: a, patchId: p });
    const gate = (sha, outcome) => `<!-- we:red-team-gate pr=1 rev=${sha} outcome=${outcome} -->`;
    const advisory = (sha, finding = '') => `<!-- we:red-team-advisory pr=1 rev=${sha} -->\n${finding}`;
    const broken = '1. [**confirmed**] (correctness, broken) — Breaks approval';
    const find = c => findCarriableVerdict({ reviews: [], comments: [accept, comment(gate(a, 'card-queued')), c], headSha: b, pr: 1 });
    for (const body of [carry, `${gate(a, 'card-queued')}\n${carry}\nReview verdict carried across an identical contribution.\n${advisory(a)}`, gate(a, 'card-queued'), advisory(a), advisory(a, '1. [**confirmed**] (quality, degraded) — Cosmetic'), advisory(a, '1. [not confirmed] (correctness, broken) — Unproven')]) {
      expect(find(comment(body))?.sha, body).toBe(a);
      expect(find({ ...comment(body), author: { login: 'stranger' } }), body).toBeNull();
    }
    for (const body of [gate(b, 'card-queued'), gate(a, 'sent-back'), gate(a, 'round-cap'), advisory(b), advisory(a, broken), `${carry}\n${advisory(a, broken)}`, `${gate(a, 'sent-back')}\n${carry}`, `${carry}\n🔁 review — changes requested`, `review paused: revoke\n${carry}`, `${carry}\nunknown hold`, `unknown hold\n${carry}`, 'unknown hold']) {
      expect(find(comment(body)), body).toBeNull();
    }
    expect(find({ ...comment('unknown hold'), author: { login: 'stranger' } })).toBeNull();
    for (const marker of [gate(a, 'card-queued'), carry, advisory(a),
      `${gate(a, 'card-queued')}\n${carry}\nReview verdict carried across an identical contribution.\n${advisory(a)}`]) {
      for (const sep of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
        for (const body of [`unknown hold${sep}${marker}`, `${marker}${sep}unknown hold`]) {
          expect(find(comment(body)), body).toBeNull();
        }
      }
    }
  });
  it('recognizes producer-rendered provenance and preserves text outside it', async () => {
    const { renderRedTeamComment } = await import('../../operations/review-extra-seats.mjs');
    const { buildGateComment } = await import('../../operations/red-team-gate-apply.mjs');
    const accept = comment(`<!-- reviewed-sha: ${a} -->`);
    const gate = buildGateComment({ pr: 1, head: a, outcome: 'card-queued',
      plan: { sendBack: [], card: [{ index: 1 }], advisory: [{ index: 2 }] }, cardResult: { ok: true, session: 'red-team-card' } });
    const advisory = findings => renderRedTeamComment({ pr: 1, rev: a, provider: 'claude', model: 'test',
      findings, recheckStatus: 'complete', foldedVerdict: 'accept' });
    const find = body => findCarriableVerdict({ reviews: [], comments: [accept, comment(body)], headSha: b, pr: 1 });
    for (const body of [gate, advisory([]), advisory([{ confirmedByRecheck: true, category: 'quality',
      impactIfUnfixed: 'degraded', summary: 'Cosmetic', failure_scenario: 'Visible text', recheckReason: 'Confirmed' }])]) {
      expect(find(body)?.sha, body).toBe(a);
      expect(find(`unknown hold\n${body}`)).toBeNull();
      expect(find(`${body}\nunknown hold`)).toBeNull();
    }
    expect(find(gate.replace(':\n', ': unknown hold\n'))).toBeNull();
  });
  it('settings cascade falls back on invalid values', () => {
    const readFile = () => '{"carryAcrossRebase":"on"}';
    expect(resolveCarryAcrossRebase({ env: {}, readFile }).value).toBe('on');
    expect(resolveCarryAcrossRebase({ env: { WE_REVIEW_CARRY_ACROSS_REBASE: 'off' }, readFile }).source).toBe('env');
    expect(resolveCarryAcrossRebase({ env: { WE_REVIEW_CARRY_ACROSS_REBASE: 'bad' }, readFile }).source).toBe('settings');
    expect(resolveCarryAcrossRebase({ env: {}, readFile: () => '{}' }).value).toBe('off');
  });
  it('fetches a missing commit once, rechecks it, and refuses any later git error', () => {
    const calls = []; let readable = false;
    const exec = (file, args) => {
      calls.push(args);
      if (args[0] === 'cat-file' && args[2] === `${a}^{commit}` && !readable) throw Error('missing');
      if (args[0] === 'fetch') { readable = true; return ''; }
      if (args[0] === 'merge-base') return b;
      if (args[0] === 'diff') return 'patch';
      if (args[0] === 'patch-id') return `${p} ${a}`;
      return '';
    };
    expect(contributionPatchId({ exec, sha: a })).toBe(p);
    expect(calls.filter(args => args[0] === 'fetch')).toEqual([['fetch', '--no-tags', '-q', 'origin', a]]);
    expect(calls.filter(args => args[0] === 'cat-file' && args[2] === `${a}^{commit}`)).toHaveLength(2);
    expect(contributionPatchId({ exec: (f, args) => { if (args[0] === 'diff') throw Error('read'); return exec(f, args); }, sha: a })).toBeNull();
  });
  it('compares real merges, changed lines and whitespace-sensitive YAML; fails closed', () => {
    const root = mkdtempSync(join(tmpdir(), 'verdict-carry-'));
    const exec = (f, args, opts) => execFileSync(f, args, { ...opts, cwd: root });
    const git = (...args) => String(exec('git', args, { encoding: 'utf8' })).trim();
    try {
      git('init', '-b', 'main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
      writeFileSync(join(root, 'workflow.yml'), 'steps:\n  - run: echo old\n'); git('add', '.'); git('commit', '-m', 'base');
      git('checkout', '-b', 'lane'); writeFileSync(join(root, 'workflow.yml'), 'steps:\n  - run: echo new\n'); git('commit', '-am', 'contribution'); const A = git('rev-parse', 'HEAD');
      git('checkout', 'main'); writeFileSync(join(root, 'other'), 'main advances'); git('add', '.'); git('commit', '-m', 'main'); git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      git('checkout', 'lane'); git('merge', '--no-edit', 'main'); const B = git('rev-parse', 'HEAD');
      const patch = sha => contributionPatchId({ exec, sha });
      expect(patch(A)).toMatch(/^[a-f0-9]{40}$/); expect(patch(A)).toBe(patch(B));
      writeFileSync(join(root, 'workflow.yml'), 'steps:\n    - run: echo new\n'); git('commit', '-am', 'whitespace'); expect(patch('HEAD')).not.toBe(patch(A));
      writeFileSync(join(root, 'workflow.yml'), 'steps:\n  - run: echo changed\n'); git('commit', '-am', 'change'); expect(patch('HEAD')).not.toBe(patch(A));
      git('reset', '--hard', B);
      writeFileSync(join(root, '.lane-manifest.json'), '{"transient":true}'); git('add', '.'); git('commit', '-m', 'manifest'); expect(patch('HEAD')).toBe(patch(A));
      expect(contributionPatchId({ exec: () => { throw Error(); }, sha: a })).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
