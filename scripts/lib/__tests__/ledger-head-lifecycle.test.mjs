import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildLedgerEvent, buildVerdictRecord, ledgerEventId, ledgerObservationApplies, observedLedgerHead } from '../verdict-ledger.mjs';
import { planLedgerObservation, observeLiveLedgerHead, proveLedgerCarry } from '../ledger-observation.mjs';
import { derivePrState } from '../pr-state.mjs';

const repo = 'example/repo', pr = 1;
const head = 'a'.repeat(40), next = 'b'.repeat(40), third = 'c'.repeat(40);
const at = '2026-10-17T12:00:00.000Z';
const settings = { value: { firstSeenRows: true, headMoveInvalidation: true } };
const verdict = (kind, sha = head, extra = {}) => buildVerdictRecord({ repo, pr, at, source: 'test', verdict: kind, headSha: sha, ...extra });
const event = (type, extra = {}) => buildLedgerEvent({ repo, pr, at, source: 'test', type, ...extra });
const facts = sha => ({ repo, pr, head: { sha }, now: at, state: 'OPEN', requiredChecks: [], sessions: [], handoffs: [], refusals: [] });
const plan = (events, headSha = next, proveCarry = () => null) => planLedgerObservation({ repo, pr, headSha, events, now: at, settings, proveCarry });
const codes = (events, sha = next) => derivePrState(events, facts(sha)).holds.map(h => h.code);

describe('ledger head lifecycle red-team regressions', () => {
  for (const carryRule of ['numbering-only', 'tree-identical', 'identical-net-patch']) {
    for (const mirrored of [false, true]) it(`${carryRule} cannot answer a later ${mirrored ? 'mirrored' : 'legacy'} manual human hold`, () => {
      const accepted = verdict('accepted');
      const hold = event('label-input', { label: 'review:human', change: 'added', sender: 'operator',
        ...(mirrored ? { clearanceBaseline: [ledgerEventId(accepted)] } : {}) });
      // Exact red-team order: accept A, human adds a hold, mechanical move A -> B carries the old verdict.
      const carried = verdict('carried', next, { fromHead: head, carryRule });
      const events = [accepted, hold, carried];
      expect(codes(events)).toContain('label-input:review:human');
      expect(derivePrState(events, facts(next)).clears).toBe(false);
      // A further invalidation cannot make the old hold disappear either.
      expect(codes([...events, ...plan(events, third)], third)).toContain('label-input:review:human');
      expect(codes([...events, verdict('accepted', next)])).toContain('label-input:review:human');
      expect(codes([...events, verdict('clear-human', next)])).not.toContain('label-input:review:human');
      const approval = event('approval', { approval: 'clear-human' });
      expect(codes([...events, approval])).not.toContain('label-input:review:human');
      expect(derivePrState([...events, approval], facts(next)).clears).toBe(true);
    });
  }

  it('operator send-back: a planner carry on real git objects never clears a later mirrored manual human hold', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ledger-carry-hold-'));
    const git = args => String(execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
    try {
      git(['init', '-b', 'main']); git(['config', 'user.email', 'test@example.com']); git(['config', 'user.name', 'Test']);
      writeFileSync(join(cwd, 'file.txt'), 'content\n');
      git(['add', '.']); git(['commit', '-m', 'base']);
      const fromSha = git(['rev-parse', 'HEAD']);
      git(['commit', '--allow-empty', '-m', 'identical tree']);
      const toSha = git(['rev-parse', 'HEAD']);
      // The exact red-team stream: accepted(A), then a mirrored review:human hold whose baseline names that acceptance.
      const accepted = verdict('accepted', fromSha);
      const hold = event('label-input', { label: 'review:human', change: 'added', sender: 'operator', clearanceBaseline: [ledgerEventId(accepted)] });
      const events = [accepted, hold];
      expect(derivePrState(events, facts(fromSha))).toMatchObject({ clears: false });
      const rows = planLedgerObservation({ repo, pr, headSha: toSha, labels: ['review:human'], events, now: at, settings,
        proveCarry: args => proveLedgerCarry({ ...args, cwd }) });
      expect(rows).toEqual([expect.objectContaining({ verdict: 'carried', carryRule: 'tree-identical' })]);
      expect(ledgerObservationApplies(rows[0], events)).toBe(true);
      const after = derivePrState([...events, ...rows], facts(toSha));
      expect(after.clears).toBe(false);
      expect(after.holds.map(h => h.code)).toContain('label-input:review:human');
      // Only a human answer lifts it.
      expect(derivePrState([...events, ...rows, verdict('accepted', toSha)], facts(toSha)).holds.map(h => h.code)).toContain('label-input:review:human');
      expect(derivePrState([...events, ...rows, verdict('clear-human', toSha)], facts(toSha)).holds.map(h => h.code)).not.toContain('label-input:review:human');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('operator send-back: a send-back of a bounced head is released by a head move and a fresh acceptance', () => {
    // Exact red-team stream: changes(A), send-back, head-moved(A→B), accepted(B), live head B.
    const sentBack = [verdict('changes'), event('send-back', { cause: 'changes' })];
    expect(codes(sentBack, head)).toContain('send-back');
    const moved = [...sentBack, ...plan(sentBack)];
    expect(moved.at(-1)).toMatchObject({ verdict: 'head-moved', fromHead: head });
    const released = derivePrState([...moved, verdict('accepted', next)], facts(next));
    expect(released.holds.map(h => h.code)).not.toContain('send-back');
    expect(released.clears).toBe(true);
  });

  it('a manual human hold survives a substantive head move after its human answer, but not an equivalent carry', () => {
    // Decision (docs/agent/testing.md): a substantive move expires every human answer to a manual hold; the
    // hold stands again until a fresh human answer at the new head. An equivalent carry keeps the answer.
    const accepted = verdict('accepted');
    const hold = event('label-input', { label: 'review:human', change: 'added', sender: 'operator' });
    for (const answer of [verdict('clear-human'), event('approval', { approval: 'clear-human' })]) {
      const answered = [accepted, hold, answer];
      expect(codes(answered, head)).not.toContain('label-input:review:human');
      expect(derivePrState([...answered, ...plan(answered, next, () => 'tree-identical')], facts(next)).clears).toBe(true);
      const moved = [...answered, ...plan(answered)];
      expect(moved.at(-1)).toMatchObject({ verdict: 'head-moved' });
      expect(codes([...moved, verdict('accepted', next)])).toContain('label-input:review:human');
      expect(codes([...moved, verdict('accepted', next), verdict('clear-human', next)])).not.toContain('label-input:review:human');
      expect(codes([...moved, verdict('accepted', next), event('approval', { approval: 'clear-human' })])).not.toContain('label-input:review:human');
    }
  });

  it('a delayed acceptance for a never-witnessed intermediate head never clears the live head', () => {
    // accepted(A), changes(C), then a slow review of B lands. B was never witnessed, so the fold takes it as the
    // witness (a fresh review must witness its head when an observation was missed). The observer then sees B !== C
    // and invalidates: the outcome is a re-review, never a stale acceptance standing for C.
    const middle = 'e'.repeat(40);
    const events = [verdict('accepted'), verdict('changes', third), verdict('accepted', middle)];
    expect(observedLedgerHead(events)).toBe(middle);
    const observed = [...events, ...plan(events, third)];
    expect(observed.at(-1)).toMatchObject({ verdict: 'head-moved', fromHead: middle });
    expect(derivePrState(observed, facts(third)).clears).toBe(false);
    // An equivalent B→C move must not carry the delayed acceptance over the reviewer's changes(C).
    const carriedOver = plan(events, third, () => 'tree-identical');
    expect(carriedOver).toEqual([expect.objectContaining({ verdict: 'head-moved', fromHead: middle })]);
    expect(derivePrState([...events, ...carriedOver], facts(third)).clears).toBe(false);
    const forged = verdict('carried', third, { fromHead: middle, carryRule: 'tree-identical', source: 'head-observer' });
    expect(ledgerObservationApplies(forged, events)).toBe(false);
  });

  it('a restamp cannot answer any kind of manual hold', () => {
    for (const label of ['review:human', 'review:changes', 'review:pending', 'advisory:ruling-needed']) {
      const accepted = verdict('accepted');
      const hold = event('label-input', { label, change: 'added', sender: 'operator' });
      expect(codes([accepted, hold, verdict('restamped', next)])).toContain(`label-input:${label}`);
    }
  });

  it('does not resurrect a released send-back when head-move pruning runs', () => {
    const sentBack = [verdict('accepted'), event('send-back', { cause: 'changes' })];
    expect(codes(sentBack)).not.toContain('send-back');
    const moved = [...sentBack, ...plan(sentBack)];
    expect(codes(moved)).not.toContain('send-back');
    expect(derivePrState([...moved, verdict('accepted', next)], facts(next)).clears).toBe(true);
    // A second send-back binds to B, and is released only by C.
    const second = [...moved, event('send-back', { cause: 'changes' })];
    expect(codes(second)).toContain('send-back');
    expect(codes([...second, ...plan(second, third)], third)).not.toContain('send-back');
  });

  it('retains a send-back head witnessed only by an exemption without retaining exemption authority', () => {
    const exempt = event('review-exempt', { headSha: head, basis: 'no review owed' });
    const sentBack = [exempt, event('send-back', { cause: 'changes' })];
    expect(codes(sentBack, head)).toContain('send-back');
    const moved = [...sentBack, ...plan(sentBack)];
    expect(codes(moved)).not.toContain('send-back');
    expect(derivePrState(moved, facts(next))).toMatchObject({ clears: false, reviewExempt: false });
    expect(derivePrState([...moved, verdict('accepted', next)], facts(next)).clears).toBe(true);
  });

  it('keeps an explicit human clearance through an equivalent carried head move', () => {
    const accepted = verdict('accepted');
    const hold = event('label-input', { label: 'review:human', change: 'added', sender: 'operator' });
    const approval = event('approval', { approval: 'clear-human' });
    const events = [accepted, hold, approval];
    expect(derivePrState([...events, ...plan(events, next, () => 'tree-identical')], facts(next)).clears).toBe(true);
  });

  for (const kind of ['carried', 'restamped']) it(`preserves a fresh clear-human answer through ${kind}, without answering a newer hold`, () => {
    const accepted = verdict('accepted');
    const hold = event('label-input', { label: 'review:human', change: 'added', sender: 'operator' });
    const clearance = verdict('clear-human');
    const carry = verdict(kind, next, kind === 'carried' ? { fromHead: head, carryRule: 'tree-identical', state: 'clear-human' } : {});
    expect(derivePrState([accepted, hold, clearance, carry], facts(next)).clears).toBe(true);
    expect(codes([accepted, clearance, hold, carry])).toContain('label-input:review:human');
    const onward = verdict('carried', third, { fromHead: next, carryRule: 'identical-net-patch', state: 'clear-human' });
    expect(derivePrState([accepted, hold, clearance, carry, onward], facts(third)).clears).toBe(true);
    // A new manual hold between the two carries still requires a new human answer.
    expect(codes([accepted, hold, clearance, carry, hold, onward], third)).toContain('label-input:review:human');
  });

  it('ignores delayed transitions and superseded clearances when following the human answer', () => {
    const hold = event('label-input', { label: 'review:human', change: 'added', sender: 'operator' });
    const clearance = verdict('clear-human');
    const carry = verdict('carried', next, { fromHead: head, carryRule: 'tree-identical', state: 'clear-human' });
    const delayedMove = verdict('head-moved', third, { fromHead: head });
    const onward = verdict('carried', third, { fromHead: next, carryRule: 'tree-identical', state: 'clear-human' });
    for (const delayed of [delayedMove, verdict('accepted'), verdict('restamped')]) {
      expect(derivePrState([hold, clearance, carry, delayed, onward], facts(third)).clears).toBe(true);
    }
  });

  it('uses full applied history after pruning older superseded heads', () => {
    const old = 'd'.repeat(40), intermediate = 'e'.repeat(40);
    const previous = [verdict('accepted', old), verdict('head-moved', intermediate, { fromHead: old }),
      verdict('head-moved', head, { fromHead: intermediate })];
    const hold = event('label-input', { label: 'review:human', change: 'added', sender: 'operator' });
    const carry = verdict('carried', next, { fromHead: head, carryRule: 'tree-identical', state: 'clear-human' });
    const onward = verdict('carried', third, { fromHead: next, carryRule: 'tree-identical', state: 'clear-human' });
    const events = [...previous, hold, verdict('clear-human'), carry, verdict('accepted', old), onward];
    expect(derivePrState(events, { ...facts(third), pr: String(pr) }).clears).toBe(true);
  });

  for (const size of [7, 12, 39]) it(`does not invent a head move for a ${size}-character restamp SHA`, () => {
    const restamp = verdict('restamped', head.slice(0, size));
    const events = [verdict('accepted'), restamp];
    expect(plan(events, head)).toEqual([]);
    expect(observedLedgerHead(events)).toBe(head);
    const append = verdict('head-moved', head, { fromHead: head.slice(0, size), source: 'head-observer' });
    expect(ledgerObservationApplies(append, events)).toBe(false);
    const readPr = () => { throw Error('unchanged head should not read the network'); };
    expect(observeLiveLedgerHead({ repo, pr, listedHeadSha: head }, { read: () => events, readPr })).toMatchObject({ ok: true, skipped: 'head-unchanged' });
    expect(plan(events, next)[0]).toMatchObject({ verdict: 'head-moved', fromHead: head });
    // A legacy stream with only an abbreviated witness also compares equal to its full head.
    expect(plan([restamp], head)).toEqual([]);
    expect(plan([restamp], next)[0]).toMatchObject({ verdict: 'head-moved', fromHead: head.slice(0, size) });
  });
});
