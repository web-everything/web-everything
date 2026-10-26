// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { guardEnqueue } from '../drain-poison-guard.mjs';
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
      case 'grep':
        if (!collision || !new RegExp(args[2]).test(`${mainKey}: ${mainValue}`)) throw Object.assign(new Error('no match'), { status: 1 });
        return `origin/main:${mainCard}:${mainKey}: ${mainValue}`;
      default: throw new Error(`unexpected git operation: ${args[0]}`);
    }
  });
}

function strategy(evidence) {
  const exec = vi.fn((cmd, args, options) => {
    if (cmd === 'git') return evidence(cmd, args, options);
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view')
      return JSON.stringify({ headRefOid: headSha, labels: ['ready-to-merge'] });
    if (cmd === 'gh' && args.includes('--slurp')) return '[[]]';
    if (cmd === 'gh' && args[0] === 'pr' && ['comment', 'edit'].includes(args[1]))
      throw new Error('GitHub delivery unavailable');
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
    const { s } = strategy(gitEvidence({ fail }));
    expect(s.enqueue(c, headSha)).toMatchObject({ enqueued: false, deferred: true, kind: 'bornas-unreadable', reason: expect.stringContaining(`unreadable ${fail}`) });
    expect(enqueuePr).not.toHaveBeenCalled();
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

// The CLI runs on import; exercise its outcome-emission statements in isolation.
describe('drain CLI enqueue outcome wiring', () => {
  const source = readFileSync(new URL('../../merge-ai-prs.mjs', import.meta.url), 'utf8');

  it.each(['branch-preparation', 'merge-lock-held', 'enqueueFailure'])(
    'emits the recorded %s refusal', kind => {
      const line = source.split('\n').find(line => kind === 'enqueueFailure'
        ? line.includes('if (e.enqueueFailure)') : line.includes(`kind: '${kind}'`));
      const statements = line.match(/enqueueOutcomes\.push\(.*?\); emitEnqueueOutcome\(.*?\);/)?.[0];
      expect(statements).toBeDefined();
      const enqueueOutcomes = [];
      const emitEnqueueOutcome = vi.fn();
      const reason = 'fixture refusal';
      new Function('c', 'localSlug', 'enqueueOutcomes', 'emitEnqueueOutcome', 'revalidationAborted', 'prepared', 'landLock', 'e', statements)(
        c, repo, enqueueOutcomes, emitEnqueueOutcome, [{ reason }], {}, { heldBy: 'other writer' },
        { enqueueFailure: { kind: 'fixture-error', reason } });
      expect(enqueueOutcomes).toHaveLength(1);
      expect(emitEnqueueOutcome.mock.calls).toEqual([[repo, enqueueOutcomes[0]]]);
      expect(enqueueOutcomes[0]).toMatchObject({ num: c.num, outcome: 'not-enqueued' });
    });

  it.each([true, false])('emits the prestaged outcome when enqueued is %s', enqueued => {
    const block = source.match(/if \(!fast\.fallback\) \{([\s\S]*?)return \{ result, merged:/)?.[1];
    expect(block).toBeDefined();
    const emitEnqueueOutcome = vi.fn();
    const result = new Function('fast', 'onlyPr', 'localSlug', 'emitEnqueueOutcome', `${block}return result;`)(
      { enqueued }, c.num, repo, emitEnqueueOutcome);
    expect(emitEnqueueOutcome.mock.calls).toEqual([[repo, result.enqueueOutcomes[0]]]);
    expect(result.enqueueOutcomes[0].outcome).toBe(enqueued ? 'enqueued' : 'not-enqueued');
  });
});
