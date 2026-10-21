// @vitest-environment node
/**
 * @file land-human-only.test.mjs — card 334: the operator lands an approved human-only (workflow-file) PR the drain
 *   may not enqueue. Covers the gates and refusals (we:scripts/operations/land-human-only.mjs), the dry-run/no-op
 *   effect plan, and the sink order: head re-check → label → enqueue as the operator → verify → comment
 *   (we:scripts/operations/land-human-only-io.mjs).
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('../../lib/marker-authorship.mjs', async (original) => ({
  ...await original(), OPERATOR_LOGINS: ['chalbert', 'another-operator'],
}));

import {
  evaluateLandGates, planLandHumanOnly, landHumanOnlyOperation, buildLandComment, finishLandOutcome, LAND_HUMAN_ONLY_EFFECT, LAND_HUMAN_ONLY_MARKER,
} from '../land-human-only.mjs';
import { cloneFor, locateClone, readCanonicalSlug, createLandHumanOnlySinks, createLandHumanOnlyReader, resolveOperatorCredential, operatorEnv, operatorTerminalPresent } from '../land-human-only-io.mjs';
import { driveRun, renderOutcome } from '../cli-adapter.mjs';
import { createRegistry } from '../registry.mjs';
import { startRun } from '../engine.mjs';
import { evaluatePrGates } from '../../lib/merge-gate-ci.mjs';
import { readDrainAcceptance } from '../../merge-ai-prs.mjs';

const head = 'a'.repeat(40);
const repo = 'o/r';

function read(over = {}) {
  return {
    repo, number: 7, head, defaultBranch: 'main', nodeId: 'PR_node',
    pr: { state: 'OPEN', isDraft: false, baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
    operatorLogin: 'chalbert', inMergeQueue: false, labelPresent: true, labelDecision: { label: false, reason: null },
    surface: { hold: true, humanOnly: true, paths: ['.github/workflows/ci.yml'] },
    gateRows: [{ id: 'candidate-label', status: 'pass', reason: 'ok' }, { id: 'mergeable', status: 'queue', reason: 'queue-owned' },
      { id: 'pass-cap', status: 'enqueue', reason: 'enqueue-owned' }],
    gateRowsError: null,
    requiredChecks: { names: ['merge-gate', 'test'], allowed: true, affected: [] },
    ...over,
  };
}
const input = (over = {}) => ({ repo, pr: 7, actor: 'chalbert', channel: 'chat', reason: 'land #7 please', 'dry-run': false, ...over });

describe('land-human-only — checkout identity', () => {
  const find = (origin) => cloneFor(repo, { candidates: ['/clone/nested'], canonical: () => null,
    exec: (_bin, args) => args.includes('rev-parse') ? '/clone\n' : origin });
  it.each(['https://github.com/o/r.git', 'git@github.com:o/r.git', 'ssh://git@github.com/o/r.git',
    'https://github.com/O/R/', 'https://github.com/o/r'])('accepts the full GitHub identity in %s', (origin) => {
    expect(find(origin)).toBe('/clone');
  });
  it.each(['https://github.com/other/r.git', 'git@github.com:other/r.git', 'ssh://git@github.com/other/r.git',
    'https://elsewhere.test/o/r.git', 'git@elsewhere.test:o/r.git', 'ssh://git@elsewhere.test/o/r.git',
    '/tmp/o/r.git', 'https://github.com/o/r.git?other', 'https://github.com/o/r.git#other'])('refuses %s', (origin) => {
    expect(find(origin)).toBeNull();
  });
  it('accepts an origin GitHub resolves to the repo (renamed/transferred owner), and says why it refuses otherwise', () => {
    const opts = (canonical) => ({ candidates: ['/lane'], canonical,
      exec: (_bin, args) => args.includes('rev-parse') ? '/lane\n' : 'git@github.com:old-owner/r.git' });
    const asked = [];
    expect(locateClone(repo, opts((s) => { asked.push(s); return 'o/r'; }))).toEqual({ dir: '/lane', reasons: [] });
    expect(asked).toEqual(['old-owner/r']);
    const other = locateClone(repo, opts(() => 'someone/else'));
    expect(other.dir).toBeNull();
    expect(other.reasons.join()).toMatch(/old-owner\/r is someone\/else, not o\/r/);
    // An unreadable resolution fails closed.
    const unread = locateClone(repo, opts(() => null));
    expect(unread.dir).toBeNull();
    expect(unread.reasons.join()).toMatch(/could not be read/);
  });
  it('never asks GitHub about a matching or non-GitHub origin', () => {
    const canonical = () => { throw new Error('must not be called'); };
    const at = (origin) => locateClone(repo, { candidates: ['/c'], canonical, exec: (_b, a) => a.includes('rev-parse') ? '/c\n' : origin });
    expect(at('git@github.com:o/r.git').dir).toBe('/c');
    expect(at('/tmp/o/r.git').reasons.join()).toMatch(/not a github.com owner\/name/);
  });
  it.each([
    ['HTTPS userinfo', 'https://x-access-token:origin-secret@github.com/o/r.git'],
    ['HTTP userinfo', 'http://origin-secret@github.com/o/r.git'],
    ['SSH userinfo', 'ssh://git:origin-secret@github.com/o/r.git'],
    ['query', 'https://github.com/o/r.git?token=origin-secret'],
    ['fragment', 'https://github.com/o/r.git#origin-secret'],
    ['other host', 'https://origin-secret@elsewhere.test/o/r.git'],
    ['malformed URL', 'https://origin-secret@@github.com/o/r.git'],
    ['encoded userinfo', 'https://origin%2Dsecret@github.com/o/r.git'],
    ['local path', '/tmp/origin-secret/o/r.git'],
    ['control characters', 'origin-secret\n\r\u2028https://github.com/o/r.git'],
    ['shell punctuation', '--origin-secret/../`command`/"quoted"'],
    ['Unicode', 'https://origin-secret\u200b@github.com/o/r.git'],
  ])('omits the rejected origin from diagnostics (%s)', (_shape, origin) => {
    const canonical = vi.fn();
    const result = locateClone(repo, { candidates: ['/lane'], canonical,
      exec: (_bin, args) => args.includes('rev-parse') ? '/lane\n' : origin });
    expect(result).toEqual({ dir: null, reasons: ['/lane: origin is not a github.com owner/name'] });
    expect(canonical).not.toHaveBeenCalled();
  });
  it('accepts a renamed origin through the default canonical resolver with only exec mocked', () => {
    const exec = vi.fn((bin, args) => {
      if (bin === 'git' && args.includes('rev-parse')) return '/lane\n';
      if (bin === 'git' && args.includes('get-url')) return 'git@github.com:old-owner/r.git';
      if (bin === 'gh') {
        expect(args).toEqual(['api', '--hostname', 'github.com', 'repos/old-owner/r', '-q', '.full_name']);
        return 'O/R\n';
      }
      throw new Error(`unexpected ${bin} ${args.join(' ')}`);
    });
    expect(locateClone(repo, { candidates: ['/lane'], exec })).toEqual({ dir: '/lane', reasons: [] });
    expect(exec.mock.calls.map(([bin]) => bin)).toEqual(['git', 'git', 'gh']);
  });
  it('reads the canonical slug from GitHub and refuses an unreadable answer', () => {
    expect(readCanonicalSlug('old/r', { exec: (bin, args) => { expect([bin, ...args]).toEqual(['gh', 'api', '--hostname', 'github.com', 'repos/old/r', '-q', '.full_name']); return 'O/R\n'; } })).toBe('o/r');
    expect(readCanonicalSlug('old/r', { exec: () => '' })).toBeNull();
    expect(readCanonicalSlug('old/r', { exec: () => { throw new Error('404'); } })).toBeNull();
  });
  it('continues to a matching candidate after a different owner', () => {
    expect(cloneFor(repo, { candidates: ['/fork', '/correct'], canonical: () => null, exec: (_bin, args) => {
      if (args.includes('rev-parse')) return args[1];
      return args[1] === '/fork' ? 'https://github.com/other/r.git' : 'git@github.com:o/r.git';
    } })).toBe('/correct');
  });
});

describe('land-human-only — refusals (nothing is written)', () => {
  it.each([
    ['a non-operator actor', {}, { actor: 'someone-else' }, /registered operator login/],
    ['a blank reason', {}, { reason: '  ' }, /--reason is required/],
    ['a multi-line channel', {}, { channel: 'a\nb' }, /--channel is required/],
    ['a credential that is not an operator', { operatorLogin: 'web-everything[bot]' }, {}, /operator-credential/],
    ['an unreadable credential', { operatorLogin: null, credentialError: 'no stored login' }, {}, /operator credential unreadable/],
    ['an unreadable queue snapshot', { queueError: 'missing queue state' }, {}, /merge-queue-state/],
    ['a stale queued snapshot', { inMergeQueue: true, queueError: 'PR head moved' }, {}, /merge-queue-state/],
    ['a PR with no human-only surface', { surface: { hold: false } }, {}, /not a human-only PR/],
    ['an unreadable change list', { surface: { hold: true, humanOnly: false, error: 'listed 1 of 2' } }, {}, /change list unreadable/],
    ['a drain gate hold', { gateRows: [{ id: 'review-acceptance', status: 'hold', reason: 'human-only: needs clear-human' }] }, {}, /review-acceptance hold/],
    ['a drain gate fail-closed', { gateRows: [{ id: 'ledger', status: 'fail-closed', reason: 'unread' }] }, {}, /ledger fail-closed/],
    ['unreadable drain gates', { gateRows: null, gateRowsError: 'PR read failed' }, {}, /drain gate rows unreadable/],
    ['required checks not green', { requiredChecks: { names: ['test'], allowed: false, reason: 'required-checks-not-successful', affected: [{ name: 'test', reason: 'failure' }] } }, {}, /test failure/],
    ['an unreadable required set', { requiredChecks: { names: null, allowed: false } }, {}, /required check set unreadable/],
    ['a conflicting PR', { pr: { ...read().pr, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' } }, {}, /not-conflicting/],
    ['uncomputed mergeability', { pr: { ...read().pr, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' } }, {}, /re-run/],
    ['a draft PR', { pr: { ...read().pr, isDraft: true } }, {}, /draft/],
    ['a closed PR', { pr: { ...read().pr, state: 'CLOSED' } }, {}, /open-on-default-branch/],
    ['a PR targeting a non-default branch', { pr: { ...read().pr, baseRefName: 'release' } }, {}, /open-on-default-branch/],
    ['an absent label the drain would not add', { labelPresent: false, labelDecision: { label: false, reason: 'held' } }, {}, /refuses it \(held\)/],
  ])('refuses %s', (_name, readOver, inputOver, message) => {
    expect(() => planLandHumanOnly(read(readOver), input(inputOver))).toThrow(message);
  });
});

describe('land-human-only — the plan', () => {
  it('every gate passing yields label → enqueue → verify → comment, pinned to the head', () => {
    const v = planLandHumanOnly(read({ labelPresent: false, labelDecision: { label: true, reason: null } }), input());
    expect(v.gates.every((g) => g.ok)).toBe(true);
    expect(v.addLabel).toBe(true);
    expect(v.plan).toEqual(['label ready-to-merge', `enqueue o/r#7 expectedHeadOid=${head} as chalbert`, 'verify isInMergeQueue',
      'comment on the PR naming the actor and the instruction']);
  });

  it('a present label is not re-applied', () => {
    const v = planLandHumanOnly(read(), input());
    expect(v.addLabel).toBe(false);
    expect(v.plan[0]).toBe('ready-to-merge already present');
  });

  it('binds the actor to the credential even when the PR is already queued', () => {
    for (const inMergeQueue of [false, true]) {
      expect(() => planLandHumanOnly(read({ operatorLogin: 'another-operator', inMergeQueue }), input())).toThrow(/actor.*credential/i);
    }
  });

  it('normalizes actor and credential logins consistently', () => {
    expect(planLandHumanOnly(read({ operatorLogin: 'Chalbert' }), input({ actor: ' CHALBERT ' })).actor).toBe('chalbert');
  });

  it('every gate id is reported', () => {
    expect(evaluateLandGates(read()).map((g) => g.id)).toEqual(['operator-credential', 'merge-queue-state', 'open-on-default-branch', 'human-only-surface',
      'ready-to-merge-label', 'drain-gates', 'required-checks-green', 'not-conflicting']);
  });

  it('dry-run and an already-queued PR declare zero effects; a real run declares one', () => {
    const op = landHumanOnlyOperation({ readLandContext: () => read() });
    const write = op.steps.find((s) => s.name === 'write').step;
    expect(write.effects({ verdict: planLandHumanOnly(read(), input({ 'dry-run': true })) })).toEqual([]);
    const queued = planLandHumanOnly(read({ inMergeQueue: true }), input());
    expect(queued.noop).toBe(true);
    expect(write.effects({ verdict: queued })).toEqual([]);
    const real = write.effects({ verdict: planLandHumanOnly(read(), input()) });
    expect(real).toHaveLength(1);
    expect(real[0]).toMatchObject({ type: LAND_HUMAN_ONLY_EFFECT, idempotent: false, payload: { verdict: { head, operatorLogin: 'chalbert' } } });
  });

  it('the comment names the actor, the channel, the instruction verbatim and the outcome', () => {
    const body = buildLandComment(planLandHumanOnly(read(), input({ reason: 'yes, land it' })), { queued: true });
    expect(body.startsWith(LAND_HUMAN_ONLY_MARKER)).toBe(true);
    expect(body).toContain('Actor: `chalbert`');
    expect(body).toContain('channel: chat');
    expect(body).toContain('> yes, land it');
    expect(body).toContain('isInMergeQueue');
  });
});

// A scripted `exec`: records every call, answers by argv shape.
function scriptedExec({ liveHead = head, queueHead = liveHead, labels = [{ name: 'ready-to-merge' }], inQueue = true, enqueueErrors = null, commentError = null } = {}) {
  const calls = [];
  const exec = (bin, args, opts = {}) => {
    calls.push({ bin, args, env: opts.env });
    const a = args.join(' ');
    if (a.startsWith('pr view')) return JSON.stringify({ id: 'PR_node', headRefOid: liveHead, labels });
    if (a.includes('isInMergeQueue')) return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: inQueue, headRefOid: queueHead } } } });
    if (a.includes('enqueuePullRequest')) return JSON.stringify(enqueueErrors ? { errors: enqueueErrors } : { data: { enqueuePullRequest: { mergeQueueEntry: { id: 'E', position: 1, state: 'QUEUED' } } } });
    if (a.startsWith('pr comment')) {
      if (commentError) throw new Error(commentError);
      const path = args[args.indexOf('--body-file') + 1];
      calls.at(-1).body = readFileSync(path, 'utf8');
      return 'https://example.test/c/1\n';
    }
    if (a.startsWith('pr edit')) return '';
    throw new Error(`unexpected call: ${bin} ${a}`);
  };
  return { exec, calls };
}
const cred = () => ({ login: 'chalbert', token: 'tok-operator', bin: '/real/gh' });

describe('land-human-only — the sink', () => {
  const verdict = (over = {}) => planLandHumanOnly(read(over), input());

  it('refuses an unattended invocation with a matching actor before reading credentials or writing', async () => {
    const { exec, calls } = scriptedExec();
    const credential = vi.fn(cred);
    await expect(createLandHumanOnlySinks({ exec, credential, interactive: () => false })[LAND_HUMAN_ONLY_EFFECT]({
      verdict: verdict(),
    })).rejects.toThrow(/operator terminal/i);
    expect(credential).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it.each([
    [{ enqueueErrors: [{ message: 'GraphQL enqueue refused' }] }, 'GraphQL enqueue refused'],
    [{ inQueue: false }, 'enqueue returned but isInMergeQueue is false'],
  ])('renders the enqueue failure in the terminal (%j)', async (options, error) => {
    const { exec } = scriptedExec(options);
    const result = await createLandHumanOnlySinks({ exec, credential: cred, interactive: () => true })[LAND_HUMAN_ONLY_EFFECT]({ verdict: verdict() });
    const run = { id: 'land-failed', op: 'land-human-only', findings: {}, verdict: verdict(),
      effects: [{ type: LAND_HUMAN_ONLY_EFFECT, step: 'write', status: 'applied', result }] };
    const rendered = renderOutcome({ outcome: { run, stopped: 'complete', applied: run.effects } });
    const finished = finishLandOutcome({ run, ...rendered });
    expect(finished.code).toBe(1);
    expect(finished.lines.join('\n')).toContain(`failed — ${error}`);
    expect(finished.lines.join('\n')).not.toContain('undefined');
  });

  it.each([true, false])('preserves the enqueue outcome when the audit comment throws (queued=%s)', async (inQueue) => {
    const { exec } = scriptedExec({ inQueue, commentError: 'audit unavailable' });
    const out = await createLandHumanOnlySinks({ exec, credential: cred, interactive: () => true })[LAND_HUMAN_ONLY_EFFECT]({ verdict: verdict() });
    expect(out).toMatchObject({ outcome: inQueue ? 'applied' : 'failed', ok: inQueue, queued: inQueue,
      commentUrl: null, commentError: 'audit unavailable' });
    if (!inQueue) expect(out.error).toContain('isInMergeQueue is false');
    const run = { verdict: verdict(), effects: [{ type: LAND_HUMAN_ONLY_EFFECT, status: 'applied', result: out }] };
    expect(finishLandOutcome({ run, code: 0, lines: [] }).lines.join('\n')).toContain('audit comment failed: audit unavailable');
    expect(JSON.parse(finishLandOutcome({ run, code: 0, lines: ['{}'], json: true }).lines[0]).landing).toEqual(out);
  });

  it('enqueues with expectedHeadOid on the real gh with the operator token, verifies, then comments', async () => {
    const { exec, calls } = scriptedExec();
    const sinks = createLandHumanOnlySinks({ exec, credential: cred, interactive: () => true });
    const out = await sinks[LAND_HUMAN_ONLY_EFFECT]({ verdict: verdict() });
    expect(out).toMatchObject({ outcome: 'applied', ok: true, queued: true, labelled: false });
    const enqueue = calls.find((c) => c.args.join(' ').includes('enqueuePullRequest'));
    expect(enqueue.bin).toBe('/real/gh');
    expect(enqueue.args).toContain(`sha=${head}`);
    expect(enqueue.args.join(' ')).toContain('expectedHeadOid');
    expect(enqueue.env.GH_TOKEN).toBe('tok-operator');
    expect('GITHUB_TOKEN' in enqueue.env).toBe(false);
    const order = calls.map((c) => c.args[0] === 'api' ? (c.args.join(' ').includes('enqueue') ? 'enqueue' : 'verify') : `${c.args[0]} ${c.args[1]}`);
    expect(order).toEqual(['pr view', 'enqueue', 'verify', 'pr comment']);
    expect(calls.at(-1).body).toContain('Actor: `chalbert`');
  });

  it('labels first when ready-to-merge is absent', async () => {
    const { exec, calls } = scriptedExec({ labels: [] });
    const out = await createLandHumanOnlySinks({ exec, credential: cred, interactive: () => true })[LAND_HUMAN_ONLY_EFFECT]({ verdict: verdict({ labelPresent: false, labelDecision: { label: true } }) });
    expect(out.labelled).toBe(true);
    expect(calls[1].args).toEqual(['pr', 'edit', '7', '--repo', repo, '--add-label', 'ready-to-merge']);
    expect(calls[1].bin).toBe('gh');
  });

  it('a head that moved refuses before any write', async () => {
    const { exec, calls } = scriptedExec({ liveHead: 'b'.repeat(40) });
    await expect(createLandHumanOnlySinks({ exec, credential: cred, interactive: () => true })[LAND_HUMAN_ONLY_EFFECT]({ verdict: verdict() })).rejects.toThrow(/head moved/);
    expect(calls).toHaveLength(1);
  });

  it('does not confirm the planned head queued when the verification head moved', async () => {
    const { exec, calls } = scriptedExec({ queueHead: 'b'.repeat(40) });
    const out = await createLandHumanOnlySinks({ exec, credential: cred, interactive: () => true })[LAND_HUMAN_ONLY_EFFECT]({ verdict: verdict() });
    expect(out).toMatchObject({ outcome: 'failed', ok: false, queued: false, error: expect.stringContaining('head moved') });
    expect(calls.at(-1).body).toContain('not queued: PR head moved');
  });

  it('refuses a forged actor at the sink before any write', async () => {
    const { exec, calls } = scriptedExec();
    await expect(createLandHumanOnlySinks({ exec, credential: cred, interactive: () => true })[LAND_HUMAN_ONLY_EFFECT]({
      verdict: { ...verdict(), actor: 'another-operator' },
    })).rejects.toThrow(/credential changed/);
    expect(calls).toHaveLength(1);
  });

  it('isInMergeQueue false is a failure, recorded on the PR', async () => {
    const { exec, calls } = scriptedExec({ inQueue: false });
    const out = await createLandHumanOnlySinks({ exec, credential: cred, interactive: () => true })[LAND_HUMAN_ONLY_EFFECT]({ verdict: verdict() });
    expect(out).toMatchObject({ outcome: 'failed', ok: false, queued: false });
    expect(calls.at(-1).body).toContain('not queued: enqueue returned but isInMergeQueue is false');
  });

  it('a GraphQL refusal is a failure, recorded on the PR', async () => {
    const { exec, calls } = scriptedExec({ enqueueErrors: [{ message: 'Required status check "merge-gate" is failing' }] });
    const out = await createLandHumanOnlySinks({ exec, credential: cred, interactive: () => true })[LAND_HUMAN_ONLY_EFFECT]({ verdict: verdict() });
    expect(out.outcome).toBe('failed');
    expect(calls.at(-1).body).toContain('merge-gate');
  });

  it('a changed credential refuses before any write', async () => {
    const { exec, calls } = scriptedExec();
    const sinks = createLandHumanOnlySinks({ exec, credential: () => ({ login: 'other', token: 't', bin: '/real/gh' }), interactive: () => true });
    await expect(sinks[LAND_HUMAN_ONLY_EFFECT]({ verdict: verdict() })).rejects.toThrow(/credential changed/);
    expect(calls).toHaveLength(1);
  });
});

describe('land-human-only — the operator credential', () => {
  it.each([
    [{}, {}, false], [{ isTTY: true }, {}, false], [{}, { isTTY: true }, false],
    [{ isTTY: true }, { isTTY: true }, true],
  ])('requires both terminal streams (%j, %j)', (input, output, expected) => {
    expect(operatorTerminalPresent({ input, output, env: {} })).toBe(expected);
  });
  it.each(['CODEX_THREAD_ID', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CI'])(
    'refuses an agent/CI pseudo-terminal marked by %s', (key) => {
      const interactive = () => operatorTerminalPresent({ input: { isTTY: true }, output: { isTTY: true }, env: { [key]: 'session' } });
      expect(interactive()).toBe(false);
      const resolveBin = vi.fn(() => '/real/gh');
      expect(resolveOperatorCredential({ interactive, resolveBin }).error).toMatch(/operator terminal/i);
      expect(resolveBin).not.toHaveBeenCalled();
    },
  );
  it('checks the terminal again when applying a saved plan', async () => {
    const { exec, calls } = scriptedExec();
    const credential = vi.fn(cred);
    const interactive = () => operatorTerminalPresent({ input: { isTTY: true }, output: { isTTY: true }, env: { CODEX_THREAD_ID: 'agent' } });
    const verdict = planLandHumanOnly(read(), input());
    await expect(createLandHumanOnlySinks({ exec, credential, interactive })[LAND_HUMAN_ONLY_EFFECT]({ verdict })).rejects.toThrow(/operator terminal/i);
    expect(credential).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
  it('does not resolve the real gh or its stored login without an operator terminal', () => {
    const resolveBin = vi.fn(() => '/real/gh');
    const readToken = vi.fn(() => 'tok');
    const out = resolveOperatorCredential({ resolveBin, readToken, interactive: () => false });
    expect(out.error).toMatch(/operator terminal/i);
    expect(resolveBin).not.toHaveBeenCalled();
    expect(readToken).not.toHaveBeenCalled();
  });
  it('resolves the login with the real gh and the stored token, never the App token', () => {
    const seen = [];
    const out = resolveOperatorCredential({ interactive: () => true, resolveBin: () => '/real/gh', readToken: ({ bin }) => (bin === '/real/gh' ? 'tok' : null),
      exec: (bin, args, opts) => { seen.push({ bin, args, env: opts.env }); return 'chalbert\n'; } });
    expect(out).toEqual({ login: 'chalbert', token: 'tok', bin: '/real/gh' });
    expect(seen[0].env.GH_TOKEN).toBe('tok');
  });
  it('no real gh or no stored login is an error, not a fallback', () => {
    expect(resolveOperatorCredential({ interactive: () => true, resolveBin: () => null }).error).toMatch(/no real gh/);
    expect(resolveOperatorCredential({ interactive: () => true, resolveBin: () => '/real/gh', readToken: () => null }).error).toMatch(/no stored login/);
  });
  it('operatorEnv drops an inherited GITHUB_TOKEN', () => {
    expect(operatorEnv('t', { GITHUB_TOKEN: 'app', PATH: '/bin' })).toEqual({ GH_TOKEN: 't', PATH: '/bin' });
  });
});

describe('land-human-only — the reader', () => {
  // Leave clone and canonical at their factory defaults. No real git/gh process is launched.
  function checkoutTransport({ origin = 'git@github.com:old-owner/r.git', canonical = repo, missingHead = false } = {}) {
    return vi.fn((bin, args, opts) => {
      if (bin === 'git') {
        if (args[0] === '-C' && args.includes('--show-toplevel')) return '/lane\n';
        if (args[0] === '-C' && args.includes('get-url')) return origin;
        expect(opts.cwd).toBe('/lane');
        if (args[0] === 'fetch') {
          expect(args).toContain(head);
          return '';
        }
        if (args[0] === 'cat-file') {
          expect(args).toEqual(['cat-file', '-e', `${head}^{commit}`]);
          if (missingHead) throw new Error('pinned commit unavailable');
        }
        throw new Error(`unexpected git ${args.join(' ')}`);
      }
      expect(bin).toBe('gh');
      if (args[0] === 'pr') return JSON.stringify({ ...read().pr, headRefOid: head, isCrossRepository: false,
        labels: [{ name: 'ready-to-merge' }] });
      if (args[0] === 'repo') return JSON.stringify({ defaultBranchRef: { name: 'main' } });
      if (args.includes('.full_name')) {
        expect(args).toEqual(['api', '--hostname', 'github.com', 'repos/old-owner/r', '-q', '.full_name']);
        if (canonical === null) throw new Error('canonical lookup unavailable');
        return canonical;
      }
      if (args.join(' ').includes('isInMergeQueue')) return JSON.stringify({ data: { repository: {
        pullRequest: { isInMergeQueue: false, headRefOid: head },
      } } });
      // The default gatherer also reads a legacy manifest and body history; neither is needed for these refusals.
      if (args[0] === 'api') return '{}';
      throw new Error(`unexpected gh ${args.join(' ')}`);
    });
  }
  const localFacts = { loadPolicy: () => null, redMainOf: () => null, mainCiOf: () => null,
    ledgerConfigOf: () => ({ authority: 'labels' }), blockOnCodeQLOf: () => true, warn: () => {} };

  it('reads the human-only surface and gate rows through the default clone and canonical resolver', () => {
    const exec = checkoutTransport();
    const gateRows = [{ id: 'candidate-label', status: 'pass', reason: 'ok' }];
    const gather = vi.fn(() => ({ gatePaths: { files: ['.github/workflows/ci.yml'] } }));
    const context = createLandHumanOnlyReader({ exec, credential: cred, requiredChecks: () => [], ...localFacts,
      gather, evaluate: () => ({ results: gateRows }) })({ repo, pr: 7 });
    expect(gather).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/lane', exec, expectedHeadSha: head }));
    expect(exec.mock.calls.some(([bin, args]) => bin === 'git' && args.includes('get-url'))).toBe(true);
    expect(exec.mock.calls.some(([bin, args]) => bin === 'gh' && args.includes('.full_name'))).toBe(true);
    expect(context.surface).toMatchObject({ hold: true, humanOnly: true });
    expect(context.gateRows).toEqual(gateRows);
    expect(context.gateRowsError).toBeNull();
  });

  it('reports default clone refusal reasons when the canonical lookup fails', () => {
    const exec = checkoutTransport({ canonical: null });
    const gather = vi.fn();
    const context = createLandHumanOnlyReader({ exec, credential: cred, requiredChecks: () => [], gather })({ repo, pr: 7 });
    expect(context.surface.error).toContain('origin old-owner/r is not o/r, and GitHub\'s canonical name for it could not be read');
    expect(context.gateRowsError).toBe(context.surface.error);
    expect(context.gateRows).toBeNull();
    expect(gather).not.toHaveBeenCalled();
  });

  it('keeps a token-bearing origin out of the reader context and rendered refusal', async () => {
    const exec = checkoutTransport({ origin: 'https://x-access-token:origin-secret@github.com/o/r.git' });
    const reader = createLandHumanOnlyReader({ exec, credential: cred, requiredChecks: () => [] });
    const context = reader({ repo, pr: 7 });
    expect(context.surface.error).toContain('/lane: origin is not a github.com owner/name');
    expect(context.gateRowsError).toBe(context.surface.error);
    expect(JSON.stringify(context)).not.toContain('origin-secret');
    const registry = createRegistry();
    registry.register(landHumanOnlyOperation({ readLandContext: reader }));
    const write = vi.fn();
    const outcome = await driveRun({ registry, store: { write: () => {} }, sinks: { [LAND_HUMAN_ONLY_EFFECT]: write },
      run: startRun({ op: 'land-human-only', id: 'secret-origin', input: input(), registry }) });
    expect(String(outcome.error?.message ?? outcome.error)).toContain('origin is not a github.com owner/name');
    expect(JSON.stringify(outcome)).not.toContain('origin-secret');
    expect(renderOutcome({ outcome }).lines.join('\n')).not.toContain('origin-secret');
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses a resolved legacy-origin checkout when the pinned head is unavailable', () => {
    const exec = checkoutTransport({ missingHead: true });
    // Keep the real default gatherer and evaluator, including readPinnedChangedFiles and its cat-file probe.
    const context = createLandHumanOnlyReader({ exec, credential: cred, requiredChecks: () => [], ...localFacts })({ repo, pr: 7 });
    expect(exec.mock.calls.some(([bin, args]) => bin === 'gh' && args.includes('.full_name'))).toBe(true);
    expect(exec.mock.calls.filter(([bin, args]) => bin === 'git' && args[0] === 'cat-file')).toHaveLength(2);
    expect(context.surface).toMatchObject({ hold: true, humanOnly: false, error: expect.stringContaining('pinned commit unavailable') });
    expect(context.gateRows.some((row) => row.status === 'fail-closed')).toBe(true);
    expect(() => planLandHumanOnly(context, input())).toThrow(/change list unreadable/);
  });

  async function runWithCeremony(clearedHead) {
    const live = { number: 7, state: 'OPEN', isDraft: false, baseRefName: 'main', headRefOid: head,
      body: 'Land the approved workflow update.', title: 'Workflow update', headRefName: 'lane/workflow',
      labels: [{ name: 'review:accepted' }, { name: 'ready-to-merge' }], commits: [],
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', id: 'PR_node',
      statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
    const exec = (_bin, args) => {
      if (args[0] === 'pr') return JSON.stringify(live);
      if (args[0] === 'repo') return JSON.stringify({ defaultBranchRef: { name: 'main' } });
      if (args.join(' ').includes('isInMergeQueue')) return JSON.stringify({ data: { repository: {
        pullRequest: { isInMergeQueue: false, headRefOid: head },
      } } });
      throw new Error(`unexpected read: ${args.join(' ')}`);
    };
    // The transport supplies the recorded ceremony; the drain parses its real markers and evaluates all gates.
    const comments = clearedHead ? [{ author: { login: 'chalbert' }, body:
      `<!-- reviewed-sha: ${clearedHead} -->\n<!-- cleared-human: chalbert -->` }] : [];
    const acceptance = readDrainAcceptance({ pr: 7, repo, carrySetting: 'off',
      exec: () => JSON.stringify({ headRefOid: head, headRefName: live.headRefName, comments }) });
    const gather = vi.fn(({ expectedHeadSha, defaultBranch }) => ({
      repo, num: 7, defaultBranch, pr: live, pinnedHead: { sha: expectedHeadSha },
      gatePaths: { files: ['.github/workflows/ci.yml'] }, acceptance,
      manifest: { live: null }, bodyHistory: { bodies: [live.body], complete: true },
      duplicateIds: { main: [] }, redMain: { source: 'ops/red-main', frozen: false },
      ledger: { authority: 'labels', folded: null, derived: null }, enqueueClearance: null,
      netSignals: { scored: true, changedFiles: ['.github/workflows/ci.yml'], diffLines: 2,
        humanBasisFiles: ['.github/workflows/ci.yml'], cumulativeDiffLines: 2, basisNarrowed: true,
        netDiffText: { text: '', scored: true }, diffHunks: '' },
    }));
    const reader = createLandHumanOnlyReader({ exec, credential: cred, clone: () => '/clone', gather,
      evaluate: (facts, options) => evaluatePrGates(facts, { ...options, carrySetting: { value: 'off', source: 'test' } }),
      requiredChecks: () => ['test'], loadPolicy: () => null, redMainOf: () => null, mainCiOf: () => null,
      ledgerConfigOf: () => ({ authority: 'labels' }), blockOnCodeQLOf: () => true, warn: () => {} });
    const registry = createRegistry();
    registry.register(landHumanOnlyOperation({ readLandContext: reader }));
    const write = vi.fn(() => ({ outcome: 'applied' }));
    const outcome = await driveRun({ registry, store: { write: () => {} }, sinks: { [LAND_HUMAN_ONLY_EFFECT]: write },
      run: startRun({ op: 'land-human-only', id: 'ceremony-head', input: input(), registry }) });
    expect(gather).toHaveBeenCalledWith(expect.objectContaining({ expectedHeadSha: head }));
    return { outcome, write };
  }

  it('refuses a clear-human ceremony for a previous head', async () => {
    const { outcome, write } = await runWithCeremony('b'.repeat(40));
    expect(String(outcome.error?.message ?? outcome.error)).toMatch(/review-acceptance hold: human-only/);
    expect(outcome.run.effects).toEqual([]);
    expect(write).not.toHaveBeenCalled();
  });

  it('permits the write only for a clear-human ceremony at the current head', async () => {
    const { outcome, write } = await runWithCeremony(head);
    expect(outcome.error).toBeNull();
    expect(outcome.stopped).toBe('complete');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('refuses a missing clear-human ceremony with no write effects', async () => {
    const { outcome, write } = await runWithCeremony(null);
    expect(String(outcome.error?.message ?? outcome.error)).toMatch(/review-acceptance hold: human-only/);
    expect(outcome.run.effects).toEqual([]);
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses a queued snapshot for a newer head instead of planning a no-op', () => {
    const exec = (_bin, args) => {
      if (args[0] === 'pr') return JSON.stringify({ headRefOid: head, labels: [] });
      if (args[0] === 'repo') return JSON.stringify({ defaultBranchRef: { name: 'main' } });
      return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: true, headRefOid: 'b'.repeat(40) } } } });
    };
    const context = createLandHumanOnlyReader({ exec, credential: cred, clone: () => null, requiredChecks: () => ['test'] })({ repo, pr: 7 });
    expect(context.inMergeQueue).toBe(false);
    expect(context.queueError).toContain('head moved');
    expect(() => planLandHumanOnly(context, input())).toThrow(/merge-queue-state/);
  });
  it('reads the gates with ready-to-merge added only when the drain would add it', () => {
    const live = { number: 7, state: 'OPEN', isDraft: false, baseRefName: 'main', headRefOid: head, labels: [{ name: 'review:accepted' }],
      commits: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', id: 'PR_node',
      statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
    const exec = (bin, args) => {
      const a = args.join(' ');
      if (a.startsWith('pr view')) return JSON.stringify(live);
      if (a.startsWith('repo view')) return JSON.stringify({ defaultBranchRef: { name: 'main' } });
      if (a.includes('isInMergeQueue')) return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: false, headRefOid: head } } } });
      throw new Error(`unexpected ${a}`);
    };
    let evaluatedLabels;
    const r = createLandHumanOnlyReader({ exec, credential: cred, clone: () => null, requiredChecks: () => ['test'] })({ repo, pr: 7 });
    expect(r.labelPresent).toBe(false);
    expect(r.labelDecision.label).toBe(true);
    expect(r.gateRowsError).toMatch(/no checkout/);
    const r3 = createLandHumanOnlyReader({ exec, credential: cred, requiredChecks: () => ['test'],
      clone: () => ({ dir: null, reasons: ['/lane: origin x/r is not o/r, and GitHub\'s canonical name for it could not be read'] }) })({ repo, pr: 7 });
    expect(r3.surface.error).toMatch(/run from a clone whose origin is github\.com\/o\/r\) — checked \/lane: origin x\/r is not o\/r/);
    expect(r.requiredChecks.allowed).toBe(true);
    expect(r).not.toHaveProperty('token');
    const r2 = createLandHumanOnlyReader({ exec, credential: cred, clone: () => '/clone', requiredChecks: () => ['test'],
      loadPolicy: () => null, redMainOf: () => null, mainCiOf: () => null, ledgerConfigOf: () => null, blockOnCodeQLOf: () => true,
      gather: () => ({ pr: { labels: live.labels }, gatePaths: { files: ['.github/workflows/ci.yml'] } }),
      evaluate: (facts) => { evaluatedLabels = facts.pr.labels.map((l) => l.name); return { results: [] }; } })({ repo, pr: 7 });
    expect(evaluatedLabels).toEqual(['review:accepted', 'ready-to-merge']);
    expect(r2.surface).toMatchObject({ hold: true, humanOnly: true });
  });
});
