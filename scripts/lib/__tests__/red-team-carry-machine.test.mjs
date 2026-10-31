// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeRedTeamCarry, readRedTeamCarry } from '../red-team-carry-machine.mjs';
import { createRedTeamCarryIo } from '../red-team-carry-io.mjs';
import { redTeamMarker } from '../red-team-gate.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const boundaries = ['after-intent', 'after-label', 'after-comment', 'before-done'];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'red-team-carry-'));
  roots.push(root);
  const env = { WE_SHARED_RUNS_DIR: join(root, 'runs') };
  const input = { repo: 'owner/repo', pr: 42, head: 'a'.repeat(40), kind: 'card-only',
    loopPayload: { verdict: { verdict: 'accept' }, carriedFrom: 'b'.repeat(40),
      findings: { read: { netBasis: { rev: 'a'.repeat(40) } } } } };
  const live = { hold: false, head: input.head, panel: false, label: false, comment: false, intent: false };
  const io = { env,
    eligible: vi.fn(() => !live.hold && live.head === input.head && !live.panel),
    intentRecorded: () => live.intent,
    recordIntent: vi.fn(() => { live.intent = true; }),
    labelApplied: () => live.label,
    applyLabel: vi.fn(() => { live.label = true; }),
    resultVisible: () => live.comment,
    postResult: vi.fn(() => { live.comment = true; }),
  };
  const run = () => resumeRedTeamCarry(input, io);
  const state = () => readRedTeamCarry({ ...input, env });
  return { input, io, live, run, state };
}

describe('resumable red-team not-owed carry', () => {
  it.each(boundaries)('resumes a crash %s exactly once', boundary => {
    const f = fixture();
    f.io.checkpoint = vi.fn(step => { if (step === boundary) throw Error('crash'); });
    expect(f.run).toThrow('crash');
    delete f.io.checkpoint;
    expect(f.run()).toMatchObject({ outcome: 'policy-clear' });
    expect(f.state()).toMatchObject({ step: 'done', loopPayload: { verdict: null } });
    expect(f.io.recordIntent).toHaveBeenCalledTimes(1);
    expect(f.io.applyLabel).toHaveBeenCalledTimes(1);
    expect(f.io.postResult).toHaveBeenCalledTimes(1);
  });
  it.each(['recordIntent', 'applyLabel', 'postResult'])('observes %s after a crash before its journal write', method => {
    const f = fixture(), action = f.io[method].getMockImplementation();
    f.io[method].mockImplementationOnce(() => { action(); throw Error('lost reply'); });
    expect(f.run).toThrow('lost reply');
    f.run();
    expect(f.io[method]).toHaveBeenCalledTimes(1);
    expect(f.state().step).toBe('done');
  });
  it('a done key performs no IO or writes', () => {
    const f = fixture();
    f.run();
    const before = f.state();
    f.io.eligible.mockImplementation(() => { throw Error('unexpected live IO'); });
    expect(f.run().outcome).toBe('already');
    expect(f.state()).toEqual(before);
    expect(f.io.applyLabel).toHaveBeenCalledTimes(1);
    expect(f.io.postResult).toHaveBeenCalledTimes(1);
  });
  it.each(boundaries.flatMap(boundary => ['hold', 'head', 'panel'].map(guard => [boundary, guard])))(
    'refuses %s resume with %s evidence', (boundary, guard) => {
      const f = fixture();
      f.io.checkpoint = step => { if (step === boundary) throw Error('crash'); };
      expect(f.run).toThrow();
      delete f.io.checkpoint;
      f.live[guard] = guard === 'head' ? 'c'.repeat(40) : true;
      const calls = [f.io.applyLabel.mock.calls.length, f.io.postResult.mock.calls.length];
      expect(f.run).toThrow(/refused/);
      expect(f.state().step).not.toBe('done');
      expect([f.io.applyLabel.mock.calls.length, f.io.postResult.mock.calls.length]).toEqual(calls);
    });
  it('refuses an initial hold without recording intent', () => {
    const f = fixture(); f.live.hold = true;
    expect(f.run).toThrow(/refused/);
    expect(f.state()).toBeNull();
    expect(f.io.recordIntent).not.toHaveBeenCalled();
  });
  it.each([undefined, null, 'yes', false])('unknown eligibility %j fails closed', eligible => {
    const f = fixture(); f.io.eligible.mockReturnValue(eligible);
    expect(f.run).toThrow(/refused/);
    expect(f.state()).toBeNull();
    expect(f.io.applyLabel).not.toHaveBeenCalled();
  });
  it.each(boundaries)('a hold arriving at %s stops the same execution', boundary => {
    const f = fixture();
    f.io.checkpoint = step => { if (step === boundary) f.live.hold = true; };
    expect(f.run).toThrow(/refused/);
    expect(f.state().step).not.toBe('done');
  });
  it('comment failure is retryable without reapplying the label', () => {
    const f = fixture();
    f.io.postResult.mockImplementationOnce(() => { throw Error('comment unavailable'); });
    expect(f.run).toThrow('comment unavailable');
    expect(f.state().step).toBe('label');
    f.run();
    expect(f.state().step).toBe('done');
    expect(f.io.applyLabel).toHaveBeenCalledTimes(1);
    expect(f.io.postResult).toHaveBeenCalledTimes(2);
  });
  it('concurrent processes resume one key with exactly one label and comment', async () => {
    const f = fixture(), effects = join(roots.at(-1), 'effects.json');
    writeFileSync(effects, JSON.stringify({ intent: 0, label: 0, comment: 0 }));
    const source = `
      import { readFileSync, writeFileSync } from 'node:fs';
      import { resumeRedTeamCarry } from ${JSON.stringify(new URL('../red-team-carry-machine.mjs', import.meta.url).href)};
      const [input, env, path] = JSON.parse(process.argv[1]);
      const read = () => JSON.parse(readFileSync(path, 'utf8'));
      const act = key => { const state = read(); state[key]++; writeFileSync(path, JSON.stringify(state)); };
      resumeRedTeamCarry(input, { env, eligible: () => true,
        intentRecorded: () => read().intent > 0, recordIntent: () => act('intent'),
        labelApplied: () => read().label > 0, applyLabel: () => act('label'),
        resultVisible: () => read().comment > 0, postResult: () => act('comment'),
      });
    `;
    await Promise.all([1, 2].map(() => promisify(execFile)(process.execPath,
      ['--input-type=module', '-e', source, JSON.stringify([f.input, f.io.env, effects])],
      { timeout: 15_000, maxBuffer: 1024 * 1024 })));
    expect(JSON.parse(readFileSync(effects, 'utf8'))).toEqual({ intent: 1, label: 1, comment: 1 });
    expect(f.state().step).toBe('done');
  });
  it.each(['intent', 'label', 'comment'])('does not mark an unobserved %s effect complete', step => {
    const f = fixture();
    f.io[{ intent: 'recordIntent', label: 'applyLabel', comment: 'postResult' }[step]].mockImplementation(() => {});
    expect(f.run).toThrow(/not observed/);
    expect(f.state().step).not.toBe('done');
  });
  it.each(['invalid JSON', 'wrong identity', 'accept verdict', 'unknown step'])(
    'unreadable journal (%s) refuses with an operator diagnostic and no effects', kind => {
      const f = fixture();
      f.io.checkpoint = () => { throw Error('crash'); };
      expect(f.run).toThrow('crash');
      const state = f.state(), dir = join(roots.at(-1), 'red-team-status', 'carry');
      if (kind === 'wrong identity') state.pr++;
      if (kind === 'accept verdict') state.loopPayload.verdict = { verdict: 'accept' };
      if (kind === 'unknown step') state.step = 'unknown';
      writeFileSync(join(dir, readdirSync(dir).find(name => name.endsWith('.json'))),
        kind === 'invalid JSON' ? '{' : JSON.stringify(state));
      expect(f.run).toThrow(/inspect stored evidence/);
      expect(f.io.applyLabel).not.toHaveBeenCalled();
      expect(f.io.postResult).not.toHaveBeenCalled();
    });
});

function liveFixture() {
  const f = fixture(), from = f.input.loopPayload.carriedFrom;
  f.input.loopPayload.findings.read = { netBasis: { rev: f.input.head }, diffText: '+card', netChangedFiles: ['backlog/123-card.md'] };
  const oldPayload = { ...f.input.loopPayload, carriedFrom: undefined, verdict: { verdict: 'changes' },
    findings: { read: { ...f.input.loopPayload.findings.read, netBasis: { rev: from } } } };
  const evidence = { loopPayload: oldPayload, recorded: false, seatRecorded: false, inFlight: false,
    status: { head: from, status: 'finished', result: 'skipped', skipCardOnly: true, loopPayload: oldPayload } };
  const live = { headRefOid: f.input.head, labels: [], comments: [], policy: true, status: null, evidence };
  const effects = { applyLabel: vi.fn(() => { live.labels = ['red-team:clear']; }),
    postResult: vi.fn(({ body }) => live.comments.push({ body, author: { login: 'web-everything' } })) };
  const options = { env: f.io.env, ...effects, readStatus: () => live.status,
    writeStatus: value => { live.status = value; }, readEvidence: () => live.evidence,
    readLive: () => ({ headRefOid: live.headRefOid, labels: live.labels }), readComments: () => live.comments,
    skipPolicy: () => live.policy, proveMove: vi.fn(() => ({ ok: true })),
  };
  return { ...f, live, effects, options,
    run: () => resumeRedTeamCarry(f.input, createRedTeamCarryIo(options)) };
}

describe('carry production IO guards and marker postconditions', () => {
  const restampHeadline = '📌 review — acceptance re-stamped after a rebase (no new review)';
  const reviewComment = sha => ({ body: `✅ review — accepted\n<!-- reviewed-sha: ${sha} -->`,
    author: { login: 'web-everything' } });
  const restampComment = sha => ({ ...reviewComment(sha),
    body: `${restampHeadline}\n\n<!-- reviewed-sha: ${sha} -->` });
  const anchoredFixture = () => {
    const f = liveFixture();
    f.live.comments.push(reviewComment(f.input.loopPayload.carriedFrom));
    return f;
  };

  it('allows a trusted current-head restamp after the anchor and preserves its witness', () => {
    const f = anchoredFixture();
    f.live.comments.push(restampComment(f.input.head));
    const io = createRedTeamCarryIo(f.options);
    expect(io.eligible(f.input)).toBe(true);
    const witness = createHash('sha256').update(JSON.stringify(f.live.comments.map(c => c.body))).digest('hex');
    expect(io.witness()).toBe(witness);
    expect(io.eligible({ ...f.input, reviewWitness: witness })).toBe(true);
    expect(f.run().outcome).toBe('policy-clear');
    expect(f.state().reviewWitness).toBe(witness);
  });
  it('allows repeated current-head markers in a trusted restamp', () => {
    const f = anchoredFixture(), comment = restampComment(f.input.head);
    comment.body += `\n<!-- reviewed-sha: ${f.input.head} -->`;
    f.live.comments.push(comment);
    expect(createRedTeamCarryIo(f.options).eligible(f.input)).toBe(true);
  });
  it('refuses a trusted current-head restamp containing a drain park marker', () => {
    const f = anchoredFixture(), comment = restampComment(f.input.head);
    comment.body += '\n<!-- drain-park-reason -->';
    f.live.comments.push(comment);
    expect(createRedTeamCarryIo(f.options).eligible(f.input)).toBe(false);
  });
  it.each(['different head', 'abbreviated head', 'mixed markers'])(
    'refuses a trusted restamp with %s after the anchor', kind => {
      const f = anchoredFixture(), comment = restampComment('c'.repeat(40));
      if (kind === 'abbreviated head') comment.body = restampComment(f.input.head.slice(0, 7)).body;
      if (kind === 'mixed markers') comment.body += `\n<!-- reviewed-sha: ${f.input.head} -->`;
      f.live.comments.push(comment);
      expect(createRedTeamCarryIo(f.options).eligible(f.input)).toBe(false);
    });
  it.each(['leading whitespace', 'quoted headline', 'different headline'])(
    'refuses a current-head marker with %s', kind => {
      const f = anchoredFixture(), comment = restampComment(f.input.head);
      if (kind === 'leading whitespace') comment.body = ` ${comment.body}`;
      if (kind === 'quoted headline') comment.body = `> ${comment.body}`;
      if (kind === 'different headline') comment.body = comment.body.replace('no new review', 'new review');
      f.live.comments.push(comment);
      expect(createRedTeamCarryIo(f.options).eligible(f.input)).toBe(false);
    });
  it.each([{ login: 'attacker' }, undefined])('keeps existing trust semantics for restamps by %j', author => {
    const f = anchoredFixture(), comment = { ...restampComment(f.input.head), author };
    const io = createRedTeamCarryIo(f.options);
    expect(io.eligible(f.input)).toBe(true);
    const witness = io.witness();
    f.live.comments.push(comment);
    expect(io.eligible({ ...f.input, reviewWitness: witness })).toBe(true);
    expect(io.witness()).toBe(witness);
    f.live.comments.push(reviewComment(f.input.head));
    expect(io.eligible(f.input)).toBe(false);
  });
  it.each(['SHA marker', 'verdict heading'])('refuses a real later review (%s) after a current-head restamp', kind => {
    const f = anchoredFixture();
    f.live.comments.push(restampComment(f.input.head), kind === 'SHA marker' ? reviewComment(f.input.head)
      : { body: '🔁 review — changes requested', author: { login: 'web-everything' } });
    expect(createRedTeamCarryIo(f.options).eligible(f.input)).toBe(false);
  });
  it('refuses a changed restamp body against a pinned witness', () => {
    const f = anchoredFixture(), comment = restampComment(f.input.head);
    f.live.comments.push(comment);
    const io = createRedTeamCarryIo(f.options);
    expect(io.eligible(f.input)).toBe(true);
    const reviewWitness = io.witness();
    comment.body += '\nEdited restamp explanation.';
    expect(createRedTeamCarryIo(f.options).eligible({ ...f.input, reviewWitness })).toBe(false);
  });

  it.each(boundaries.flatMap(boundary => ['review:human', 'review:changes', 'review:held-mechanical', 'review:pending',
    'red-team:blocked', 'policy-off', 'unknown-policy', 'head-moved', 'panel', 'different-verdict', 'same-source-panel',
    'labels-unreadable', 'comments-unreadable', 'evidence-unreadable', 'proof-failed'].map(guard => [boundary, guard])))(
    'refuses %s retry with %s in live IO', (boundary, guard) => {
      const f = liveFixture();
      f.options.checkpoint = step => { if (step === boundary) throw Error('crash'); };
      expect(f.run).toThrow('crash');
      delete f.options.checkpoint;
      const calls = [f.effects.applyLabel.mock.calls.length, f.effects.postResult.mock.calls.length];
      if (guard.includes(':')) f.live.labels.push(guard);
      else if (guard === 'policy-off') f.live.policy = false;
      else if (guard === 'unknown-policy') f.live.policy = undefined;
      else if (guard === 'head-moved') f.live.headRefOid = 'c'.repeat(40);
      else if (guard === 'panel') f.live.evidence = { ...f.live.evidence, carryConflict: true };
      else if (guard === 'different-verdict' || guard === 'same-source-panel') {
        f.live.comments.push({ body: `<!-- reviewed-sha: ${guard === 'same-source-panel' ? f.input.loopPayload.carriedFrom : f.input.head} -->`, author: { login: 'web-everything' } });
      } else if (guard === 'labels-unreadable') f.live.labels = null;
      else if (guard === 'comments-unreadable') f.live.comments = null;
      else if (guard === 'evidence-unreadable') f.live.evidence = null;
      else f.options.proveMove.mockReturnValue({ ok: false });
      expect(f.run).toThrow(/refused/);
      expect(f.state().step).not.toBe('done');
      expect([f.effects.applyLabel.mock.calls.length, f.effects.postResult.mock.calls.length]).toEqual(calls);
    });
  it('each execution re-proves the move, including a pinned carried read', () => {
    const f = liveFixture();
    f.options.checkpoint = step => { if (step === 'after-label') throw Error('crash'); };
    expect(f.run).toThrow('crash');
    f.live.evidence = { ...f.live.evidence, loopPayload: f.state().loopPayload,
      status: { ...f.live.status, head: f.input.head, skipCardOnly: true } };
    delete f.options.checkpoint;
    f.run();
    expect(f.options.proveMove).toHaveBeenCalledTimes(2);
    expect(f.effects.applyLabel).toHaveBeenCalledTimes(1);
    expect(f.effects.postResult).toHaveBeenCalledTimes(1);
  });
  it('ignores untrusted result markers and observes the trusted post after a lost reply', () => {
    const f = liveFixture();
    f.live.comments.push({ body: redTeamMarker(f.input.pr, f.input.head), author: { login: 'attacker' } });
    const post = f.effects.postResult.getMockImplementation();
    f.effects.postResult.mockImplementationOnce(input => { post(input); throw Error('lost reply'); });
    expect(f.run).toThrow('lost reply');
    f.run();
    expect(f.effects.postResult).toHaveBeenCalledTimes(1);
    expect(f.state().step).toBe('done');
  });
});
