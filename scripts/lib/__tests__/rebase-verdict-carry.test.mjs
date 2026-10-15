import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contributionPatchId, findCarriableVerdict, decideRebaseVerdictCarry, buildVerdictCarriedMarker, parseVerdictCarriedMarker, resolveCarryAcrossRebase } from '../rebase-verdict-carry.mjs';
const a = 'a'.repeat(40), b = 'b'.repeat(40), p = 'c'.repeat(40);
const comment = body => ({ author: { login: 'chalbert' }, body });
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
    expect(findCarriableVerdict({ comments: [accept], headSha: b })).toBeNull();
    expect(findCarriableVerdict({ comments: [accept], headSha: a })).toBeNull();
    expect(findCarriableVerdict({ comments: [{ ...accept, author: { login: 'stranger' } }], headSha: b })).toBeNull();
    for (const body of ['🔁 review — changes requested', '<!-- drain-park-reason -->\nnew policy park', 'review paused: revoke']) expect(findCarriableVerdict({ comments: [accept, comment(body)], headSha: b })).toBeNull();
    const gate = comment(`<!-- we:red-team-gate pr=1 rev=${a} outcome=card-queued -->`);
    expect(findCarriableVerdict({ comments: [accept, gate], headSha: b, pr: 1 }).gateOutcomes).toEqual(['card-queued']);
    for (const outcome of ['sent-back', 'round-cap']) {
      expect(findCarriableVerdict({ comments: [accept, comment(`<!-- we:red-team-gate pr=1 rev=${a} outcome=${outcome} -->`)], headSha: b, pr: 1 })).toBeNull();
    }
    const carried = comment(buildVerdictCarriedMarker({ fromSha: b, toSha: a, patchId: p }));
    expect(findCarriableVerdict({ comments: [accept, gate, carried], headSha: b })?.sha).toBe(a);
    const advisoryBody = `<!-- we:red-team-advisory pr=1 rev=${a} -->\nNo confirmed breaks.`;
    const combined = comment(`${buildVerdictCarriedMarker({ fromSha: b, toSha: a, patchId: p })}\n${advisoryBody}`);
    expect(findCarriableVerdict({ comments: [accept, combined], headSha: b })?.advisoryBody).toBe(advisoryBody);
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
      expect(findCarriableVerdict({ comments: [record, accept].filter(Boolean), headSha: b, pr: 1 }), record?.body).toBeNull();
    }
    for (const body of [`<!-- we:red-team-gate pr=1 rev=${a} outcome=card-queued -->`,
      `<!-- we:red-team-advisory pr=1 rev=${a} -->\nNo confirmed breaks.`]) {
      expect(findCarriableVerdict({ comments: [accept, comment(body)], headSha: b, pr: 1 })?.sha).toBe(a);
    }
  });
  it('drops only trusted same-sha provenance and preserves later holds', () => {
    const accept = comment(`<!-- reviewed-sha: ${a} -->`);
    const carry = buildVerdictCarriedMarker({ fromSha: b, toSha: a, patchId: p });
    const gate = (sha, outcome) => `<!-- we:red-team-gate pr=1 rev=${sha} outcome=${outcome} -->`;
    const advisory = (sha, finding = '') => `<!-- we:red-team-advisory pr=1 rev=${sha} -->\n${finding}`;
    const broken = '1. [**confirmed**] (correctness, broken) — Breaks approval';
    const find = c => findCarriableVerdict({ comments: [accept, comment(gate(a, 'card-queued')), c], headSha: b, pr: 1 });
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
    const find = body => findCarriableVerdict({ comments: [accept, comment(body)], headSha: b, pr: 1 });
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
