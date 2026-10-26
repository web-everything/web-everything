// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { guardEnqueue, recordEnqueueOutcome } from '../drain-poison-guard.mjs';
import { labelSignature } from '../drain-prestage.mjs';
import { AUTOMATION_LOGINS } from '../marker-authorship.mjs';
import { createDrainMergeStrategy } from '../drain-merge-strategy.mjs';
import { resolveMergeDeliveryPolicy } from '../merge-delivery-policy.mjs';
import { enqueuePr } from '../merge-queue-enqueue.mjs';
import { appendDaemonEvent } from '../daemon-events.mjs';

vi.mock('../merge-queue-enqueue.mjs', async original => ({
  ...(await original()), enqueuePr: vi.fn(() => ({ ok: true, already: false })),
}));
vi.mock('../daemon-events.mjs', () => ({ appendDaemonEvent: vi.fn() }));

const headSha = 'b'.repeat(40);
const repo = 'fixture/poison-admission';
const c = { num: 5969, repo };
const path = 'backlog/7274-new-card.md';
const mainCard = 'backlog/7233-old-card.md';

function gitEvidence({ collision = true, fail, mainKey = 'bornAs', mainValue = 'xgcpm6z', text = '---\nbornAs: xgcpm6z\n---\n' } = {}) {
  return vi.fn((cmd, args) => {
    if (cmd !== 'git') throw new Error(`unexpected command: ${cmd}`);
    if (args[0] === fail) throw Object.assign(new Error(`unreadable ${fail}`), { status: 128 });
    switch (args[0]) {
      case 'diff': return path;
      case 'fetch': return '';
      case 'show': return text;
      case 'ls-remote': return `${'a'.repeat(40)}\trefs/heads/main\n`;
      case 'grep':
        if (!collision || !new RegExp(args[2]).test(`${mainKey}: ${mainValue}`)) throw Object.assign(new Error('no match'), { status: 1 });
        return `origin/main:${mainCard}:${mainKey}: ${mainValue}`;
      default: throw new Error(`unexpected git operation: ${args[0]}`);
    }
  });
}

function strategy(evidence, { pages = () => '[[]]', deliver = () => { throw new Error('GitHub delivery unavailable'); } } = {}) {
  const exec = vi.fn((cmd, args, options) => {
    if (cmd === 'git') return evidence(cmd, args, options);
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view')
      return JSON.stringify({ headRefOid: headSha, labels: ['ready-to-merge'] });
    if (cmd === 'gh' && args.includes('--slurp')) return pages();
    if (cmd === 'gh' && args[0] === 'pr' && ['comment', 'edit'].includes(args[1]))
      return deliver(args);
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  });
  const s = createDrainMergeStrategy({
    exec, localSlug: repo, isLocalRepo: () => true, env: { WE_UNDER_TEST: '1' },
    resolved: { policy: resolveMergeDeliveryPolicy({ tool: { strategy: 'github-merge-queue' } }), note: null },
    queueSafety: { value: { waitForRedTeamBeforeEnqueue: false } },
    redTeamDeadline: { value: { deadlineAction: 'hold' } },
    cardGroupHold: () => null, batching: { gate: () => ({ admit: true }) },
    readFile: () => JSON.stringify({ pending: [], followedUp: [] }), writeState: vi.fn(),
    log: { write: vi.fn() },
  });
  return { s, exec };
}

beforeEach(() => {
  vi.clearAllMocks();
  appendDaemonEvent.mockRejectedValue(new Error('event delivery unavailable'));
});

describe('poison guard admission boundary', () => {
  it('refuses an identity collision before enqueue even when event, comment and label delivery fail', () => {
    const { s, exec } = strategy(gitEvidence());
    expect(s.enqueue(c, headSha)).toMatchObject({ enqueued: false, deferred: true, kind: 'bornas-collision' });
    expect(enqueuePr).not.toHaveBeenCalled();
    expect(appendDaemonEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'enqueue-refused' }), expect.any(Object));
    expect(exec.mock.calls.some(([cmd, args]) => cmd === 'gh' && args[1] === 'comment')).toBe(true);
    expect(exec.mock.calls.some(([cmd, args]) => cmd === 'gh' && args.includes('review:changes'))).toBe(true);
  });

  it.each(['diff', 'fetch', 'show', 'grep'])('refuses a Git %s read failure before enqueue', fail => {
    const { s, exec } = strategy(gitEvidence({ fail }));
    expect(s.enqueue(c, headSha)).toMatchObject({ enqueued: false, deferred: true, kind: 'bornas-unreadable', reason: expect.stringContaining('check unreadable') });
    expect(enqueuePr).not.toHaveBeenCalled();
    expect(exec.mock.calls.some(([cmd, args]) => cmd === 'gh' && args.includes('--add-label'))).toBe(false);
    expect(appendDaemonEvent).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ error: `unreadable ${fail}` }) }), expect.any(Object));
  });

  it('fetches a remote-only PR head before reading its diff or cards', () => {
    let headAvailable = false;
    const evidence = gitEvidence({ collision: false });
    const git = vi.fn((cmd, args, options) => {
      if (args[0] === 'fetch' && args.includes(headSha)) headAvailable = true;
      if (['diff', 'show'].includes(args[0]) && !headAvailable)
        throw new Error('fatal: unknown revision: PR head exists only on remote');
      return evidence(cmd, args, options);
    });
    const { s } = strategy(git);
    expect(s.enqueue(c, headSha)).toEqual({ enqueued: true, already: false });
    expect(headAvailable).toBe(true);
    expect(enqueuePr).toHaveBeenCalledOnce();
  });

  it.each([
    ['bornAs', '"xgcpm6z"'], ['bornAs', "'xgcpm6z'"],
    ['id', '"xgcpm6z"'], ['id', "'xgcpm6z'"],
  ])('refuses a collision in quoted %s: %s on a numbered card', (key, value) => {
    const { s } = strategy(gitEvidence({ text: `---\n${key}: ${value}\n---\n` }));
    expect(s.enqueue(c, headSha)).toMatchObject({ enqueued: false, kind: 'bornas-collision' });
    expect(enqueuePr).not.toHaveBeenCalled();
  });

  it.each(['bornAs', 'id'].flatMap(mainKey =>
    ['xgcpm6z', '"xgcpm6z"', "'xgcpm6z'"].flatMap(mainValue =>
      ['xgcpm6z', '"xgcpm6z"', "'xgcpm6z'"].map(incoming => [mainKey, mainValue, incoming]))))(
    'refuses main %s: %s colliding with incoming bornAs: %s', (mainKey, mainValue, incoming) => {
      const { s } = strategy(gitEvidence({ mainKey, mainValue, text: `---\nbornAs: ${incoming}\n---\n` }));
      expect(s.enqueue(c, headSha)).toMatchObject({ enqueued: false, kind: 'bornas-collision',
        reason: expect.stringContaining(mainCard) });
      expect(enqueuePr).not.toHaveBeenCalled();
    });

  it('refreshes main before diff so inherited cards cannot collide with themselves', () => {
    let refreshed = false;
    const evidence = gitEvidence();
    const exec = vi.fn((cmd, args) => {
      if (args[0] === 'fetch') refreshed = true;
      if (args[0] === 'diff' && refreshed) return '';
      return evidence(cmd, args);
    });
    const { s } = strategy(exec);
    expect(s.enqueue(c, headSha)).toEqual({ enqueued: true, already: false });
    expect(exec.mock.calls.map(([, args]) => args[0])).toEqual(['fetch', 'diff']);
    expect(enqueuePr).toHaveBeenCalledOnce();
  });

  it('admits a unique identity when grep reports no matches', () => {
    const { s } = strategy(gitEvidence({ collision: false }));
    expect(s.enqueue(c, headSha)).toEqual({ enqueued: true, already: false });
    expect(enqueuePr).toHaveBeenCalledWith(expect.objectContaining({ num: c.num, headSha }));
    expect(appendDaemonEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['matching head and live main, but omitted backlog card', {}],
    ['stale base tip', { baseSha: 'c'.repeat(40) }],
    ['different head', { headSha: 'd'.repeat(40) }],
    ['different base branch', { base: 'release' }],
    ['explicit backlog file', { files: [path] }],
    ['truncated file list', { files: ['scripts/example.mjs'] }],
    ['missing file list', { files: undefined }],
  ])('checks real identity evidence on prepared admission: %s', (_name, surface) => {
    const evidence = gitEvidence();
    const { s } = strategy(evidence);
    const prepared = { allowed: true, safety: { waitForRedTeamBeforeEnqueue: false },
      labels: labelSignature(['ready-to-merge']), comments: [],
      preparedSurface: { headSha, base: 'main', baseSha: 'a'.repeat(40), files: [], ...surface } };
    expect(s.enqueue(c, headSha, { prepared })).toMatchObject({ enqueued: false, kind: 'bornas-collision' });
    expect(evidence.mock.calls.map(([, args]) => args[0])).toEqual(['fetch', 'diff', 'show', 'grep']);
    expect(enqueuePr).not.toHaveBeenCalled();
  });

  it.each([false, true])('prepared admission reads fresh main when unreadable is %s', unreadable => {
    const evidence = gitEvidence({ collision: false, ...(unreadable ? { fail: 'fetch' } : {}) });
    const { s, exec } = strategy(evidence);
    const prepared = { allowed: true, safety: { waitForRedTeamBeforeEnqueue: false },
      labels: labelSignature(['ready-to-merge']), comments: [],
      preparedSurface: { headSha, base: 'main', baseSha: 'a'.repeat(40), files: [] } };
    expect(s.enqueue(c, headSha, { prepared })).toMatchObject(unreadable
      ? { enqueued: false, kind: 'bornas-unreadable' } : { enqueued: true });
    expect(evidence.mock.calls[0][1]).toEqual(expect.arrayContaining(['fetch', headSha, '+refs/heads/main:refs/remotes/origin/main']));
    expect(enqueuePr).toHaveBeenCalledTimes(unreadable ? 0 : 1);
    expect(exec.mock.calls.some(([cmd, args]) => cmd === 'gh' && args.includes('--add-label'))).toBe(false);
  });

  it('deduplicates collision comments across drain instances while retrying failed labels', () => {
    const comments = [];
    const deliver = vi.fn(args => {
      if (args[1] === 'edit') throw new Error('label outage');
      comments.push({ body: args.at(-1), user: { login: AUTOMATION_LOGINS[0] } });
      return '';
    });
    for (let i = 0; i < 2; i++) {
      const { s } = strategy(gitEvidence(), { pages: () => JSON.stringify([[], comments]), deliver });
      expect(s.enqueue(c, headSha)).toMatchObject({ kind: 'bornas-collision' });
    }
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain('<!-- we-drain-poison');
    expect(deliver.mock.calls.filter(([args]) => args[1] === 'edit')).toHaveLength(2);
    expect(enqueuePr).not.toHaveBeenCalled();
  });

  it('retries a failed comment on the next pass and suppresses it after successful delivery', () => {
    const comments = [];
    let fail = true;
    const deliver = vi.fn(args => {
      if (fail) throw new Error('delivery outage');
      if (args[1] === 'comment') comments.push({ body: args.at(-1), user: { login: AUTOMATION_LOGINS[0] } });
      return '';
    });
    const { s } = strategy(gitEvidence(), { pages: () => JSON.stringify([comments]), deliver });
    expect(s.enqueue(c, headSha)).toMatchObject({ kind: 'bornas-collision' });
    fail = false;
    for (let i = 0; i < 2; i++) expect(s.enqueue(c, headSha)).toMatchObject({ kind: 'bornas-collision' });
    expect(deliver.mock.calls.filter(([args]) => args[1] === 'comment')).toHaveLength(2);
    expect(comments).toHaveLength(1);
  });

  it('does not trust a poison marker planted by another author', () => {
    const marker = `<!-- we-drain-poison head=${headSha} kind=bornas-collision hash=xgcpm6z -->`;
    const deliver = vi.fn(() => '');
    const { s } = strategy(gitEvidence(), { pages: () => JSON.stringify([[{ body: marker, user: { login: 'untrusted' } }]]), deliver });
    expect(s.enqueue(c, headSha)).toMatchObject({ kind: 'bornas-collision' });
    expect(deliver.mock.calls.some(([args]) => args[1] === 'comment')).toBe(true);
  });

  it('defers a comment when its complete thread is unreadable, then retries', () => {
    let readable = false;
    const pages = () => { if (!readable) throw new Error('thread outage'); return '[[]]'; };
    const deliver = vi.fn(() => '');
    const { s } = strategy(gitEvidence(), { pages, deliver });
    expect(s.enqueue(c, headSha)).toMatchObject({ kind: 'bornas-collision' });
    expect(deliver.mock.calls.some(([args]) => args[1] === 'comment')).toBe(false);
    readable = true;
    expect(s.enqueue(c, headSha)).toMatchObject({ kind: 'bornas-collision' });
    expect(deliver.mock.calls.filter(([args]) => args[1] === 'comment')).toHaveLength(1);
  });

  it.each(['throw', 'reject'])('keeps collision and unreadable refusals when delivery callbacks %s', async mode => {
    const delivery = () => {
      if (mode === 'throw') throw new Error('delivery unavailable');
      return Promise.reject(new Error('delivery unavailable'));
    };
    for (const [evidence, kind] of [[gitEvidence(), 'bornas-collision'], [gitEvidence({ fail: 'fetch' }), 'bornas-unreadable']]) {
      const emit = vi.fn(delivery);
      const comment = vi.fn(delivery);
      expect(guardEnqueue({ c, repo, headSha, exec: evidence, emit, comment, seen: new Set() }))
        .toMatchObject({ enqueued: false, deferred: true, kind });
      expect(emit).toHaveBeenCalledOnce();
      expect(comment).toHaveBeenCalledOnce();
    }
    await Promise.resolve();
  });
});

describe('drain CLI enqueue outcome recorder', () => {
  const source = readFileSync(new URL('../../merge-ai-prs.mjs', import.meta.url), 'utf8');

  it('uses the combined recorder for the CLI instead of separate push and emit statements', () => {
    expect(source).toMatch(/return\s+recordEnqueueOutcome\s*\(\s*\{\s*outcomes\s*,\s*repo\s*,\s*outcome\s*,\s*emit:\s*appendDaemonEvent\s*\}\s*\)/);
    expect(source).not.toMatch(/enqueueOutcomes\s*\.\s*push\s*\(/);
    expect(source).not.toContain('emitEnqueueOutcome');
  });

  it.each(['card-grouping', 'branch-preparation', 'merge-lock-held', 'card-group-hold', 'enqueue-error', 'batching-deferred', 'prestage'])(
    'records and emits a %s refusal atomically', kind => {
      const outcomes = [];
      const outcome = { num: c.num, outcome: 'not-enqueued', kind, reason: 'fixture refusal' };
      const atEmission = [];
      const emit = vi.fn(() => { atEmission.push([...outcomes]); });
      expect(recordEnqueueOutcome({ outcomes, outcome, repo, emit })).toBe(outcome);
      expect(atEmission).toEqual([[outcome]]);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith({ kind: 'enqueue-skipped', repo, pr: c.num,
        detail: { kind, reason: 'fixture refusal' } });
    });

  it.each([true, false])('records a successful enqueue with already=%s', already => {
    const outcomes = [];
    const emit = vi.fn();
    const outcome = { num: c.num, outcome: 'enqueued', already };
    recordEnqueueOutcome({ outcomes, outcome, repo, emit });
    expect(outcomes).toEqual([outcome]);
    expect(emit).toHaveBeenCalledWith({ kind: 're-enqueued', repo, pr: c.num,
      detail: { reason: 'cleared by the pass', already } });
  });

  it('emits an event for every recorded outcome, including repeated decisions', () => {
    const outcomes = [];
    const emit = vi.fn();
    const outcome = { num: c.num, outcome: 'not-enqueued', kind: 'prestage' };
    for (let i = 0; i < 2; i++) recordEnqueueOutcome({ outcomes, outcome, repo, emit });
    expect(outcomes).toHaveLength(2);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it.each(['throw', 'reject'])('keeps the outcome when event delivery fails by %s', async mode => {
    const outcomes = [];
    const outcome = { num: c.num, repo: 'other/repo', outcome: 'not-enqueued', kind: 'prestage' };
    const emit = vi.fn(() => { if (mode === 'throw') throw new Error('offline'); return Promise.reject(new Error('offline')); });
    recordEnqueueOutcome({ outcomes, outcome, repo, emit });
    expect(outcomes).toEqual([outcome]);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ repo: 'other/repo', detail: expect.objectContaining({ reason: 'no reason reported' }) }));
    await Promise.resolve();
  });
});
