// @vitest-environment node
import { describe, it, expect, vi, beforeAll } from 'vitest';

// Register cases before loading the implementation, which is absent in this red phase.
let checkBornAsCollision, guardEnqueue, enqueueOutcomeEvent;
beforeAll(async () => {
  ({ checkBornAsCollision, guardEnqueue, enqueueOutcomeEvent } = await import('../drain-poison-guard.mjs'));
});

const sha = 'b'.repeat(40);
const newCard = 'backlog/7274-new-card.md';
const mainCard = 'backlog/7233-old-card.md';
const cardText = (hash) => `---\nid: 7274\nbornAs: ${hash}\n---\nbody\n`;

// A fake git: `added` = files the PR adds, `texts` = file text at the PR head, `main` = grep output lines.
function fakeExec({ added = [newCard], texts = { [newCard]: cardText('xgcpm6z') }, main = `origin/main:${mainCard}:bornAs: xgcpm6z`, fetchFails = false, grepError = false } = {}) {
  return vi.fn((cmd, args) => {
    if (cmd !== 'git') throw new Error(`unexpected ${cmd}`);
    if (args[0] === 'fetch') { if (fetchFails) throw new Error('network down'); return ''; }
    if (args[0] === 'diff') return added.join('\n');
    if (args[0] === 'show') return texts[args[1].split(':').slice(1).join(':')];
    if (args[0] === 'grep') {
      if (grepError) throw Object.assign(new Error('fatal: bad object'), { status: 128 });
      if (!main) throw Object.assign(new Error('no match'), { status: 1 });
      return main;
    }
    throw new Error(`unexpected git ${args[0]}`);
  });
}

describe('checkBornAsCollision', () => {
  it('reports the hash and the card main already holds', () => {
    expect(checkBornAsCollision({ exec: fakeExec(), headSha: sha })).toEqual({ collision: { hash: 'xgcpm6z', path: newCard, mainCard } });
  });
  it('passes a PR whose new cards are unique on main', () => {
    expect(checkBornAsCollision({ exec: fakeExec({ main: '' }), headSha: sha })).toEqual({ ok: true });
  });
  it('passes a PR that adds no backlog cards after refreshing main', () => {
    const exec = fakeExec({ added: [] });
    expect(checkBornAsCollision({ exec, headSha: sha })).toEqual({ ok: true });
    expect(exec.mock.calls.map(([, a]) => a[0])).toEqual(['fetch', 'diff']);
  });
  it('catches a hash-named card by its file name when bornAs is not in the text', () => {
    const exec = fakeExec({ added: ['backlog/xgcpm6z-new.md'], texts: { 'backlog/xgcpm6z-new.md': '---\nid: x\n---\n' } });
    expect(checkBornAsCollision({ exec, headSha: sha }).collision.hash).toBe('xgcpm6z');
  });
  it('fails closed when main cannot be fetched', () => {
    expect(checkBornAsCollision({ exec: fakeExec({ fetchFails: true }), headSha: sha })).toEqual({ error: expect.stringContaining('network down') });
  });
  it('fails closed when main cannot be searched (not just "no match")', () => {
    expect(checkBornAsCollision({ exec: fakeExec({ grepError: true }), headSha: sha })).toEqual({ error: expect.stringContaining('bad object') });
  });
});

describe('guardEnqueue', () => {
  const c = { num: 5969, repo: 'o/r' };
  it('refuses a collision, emits enqueue-refused and comments', () => {
    const emit = vi.fn(); const comment = vi.fn();
    const out = guardEnqueue({ c, headSha: sha, repo: 'o/r', exec: fakeExec(), emit, comment });
    expect(out).toMatchObject({ enqueued: false, deferred: true, kind: 'bornas-collision' });
    expect(out.reason).toContain('xgcpm6z');
    expect(emit).toHaveBeenCalledWith({ kind: 'enqueue-refused', repo: 'o/r', pr: 5969,
      detail: { pr: 5969, reason: 'bornas-collision', hash: 'xgcpm6z', mainCard } });
    expect(comment).toHaveBeenCalledTimes(1);
    expect(comment.mock.calls[0][0]).toContain(mainCard);
  });
  it('refuses (does not enqueue) when main is unreadable', () => {
    const emit = vi.fn();
    const out = guardEnqueue({ c, headSha: sha, repo: 'o/r', exec: fakeExec({ fetchFails: true }), emit, comment: vi.fn() });
    expect(out).toMatchObject({ enqueued: false, deferred: true, kind: 'bornas-unreadable' });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'enqueue-refused', detail: expect.objectContaining({ reason: 'bornas-unreadable' }) }));
  });
  it('returns null (proceed) when clean, with no event', () => {
    const emit = vi.fn();
    expect(guardEnqueue({ c, headSha: sha, repo: 'o/r', exec: fakeExec({ main: '' }), emit, comment: vi.fn() })).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });
  it('does not comment twice for the same head and hash', () => {
    const comment = vi.fn(); const seen = new Set();
    for (let i = 0; i < 2; i++) guardEnqueue({ c, headSha: sha, repo: 'o/r', exec: fakeExec(), emit: vi.fn(), comment, seen });
    expect(comment).toHaveBeenCalledTimes(1);
  });
});

describe('enqueueOutcomeEvent', () => {
  it('names the reason for a skipped enqueue', () => {
    expect(enqueueOutcomeEvent({ repo: 'o/r', outcome: { num: 5974, outcome: 'not-enqueued', kind: 'batching-deferred', reason: 'queue holds 1 group(s) (max 1)' } }))
      .toEqual({ kind: 'enqueue-skipped', repo: 'o/r', pr: 5974, detail: { kind: 'batching-deferred', reason: 'queue holds 1 group(s) (max 1)' } });
  });
  it('names the reason for an enqueue', () => {
    expect(enqueueOutcomeEvent({ repo: 'o/r', outcome: { num: 5974, outcome: 'enqueued', already: false } }))
      .toEqual({ kind: 're-enqueued', repo: 'o/r', pr: 5974, detail: { reason: 'cleared by the pass', already: false } });
  });
  it('gives a fallback reason when none is supplied', () => {
    expect(enqueueOutcomeEvent({ repo: 'o/r', outcome: { num: 1, outcome: 'not-enqueued' } }).detail.reason).toBe('no reason reported');
  });
});
