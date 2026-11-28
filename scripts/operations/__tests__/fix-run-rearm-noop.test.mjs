import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fixer from '../fix-run.mjs';
import * as procedure from '../../conveyor/fix-procedure.mjs';
import { decideEmptyFixRound, decideRearm, buildNoChangeComment } from '../../conveyor/rearm-review.mjs';
import { buildStandDownComment } from '../../conveyor/stand-down.mjs';
import { buildOperatorAnswer } from '../../conveyor/stand-down-answer-core.mjs';
const { isNothingToRearmRefusal, resolveRearmRefusalPolicy } = fixer;

describe('isNothingToRearmRefusal', () => {
  it.each([
    new Error('neither review:changes nor review:accepted is live — nothing to re-arm'),
    { message: 'Command failed', stderr: Buffer.from('nothing to re-arm') },
    { message: 'Command failed', stdout: 'nothing to re-arm' },
  ])('detects the refusal in subprocess error text (%j)', (err) => {
    expect(isNothingToRearmRefusal(err)).toBe(true);
  });

  it.each([new Error('gh down'), { stderr: 'permission denied', stdout: '' }, null, undefined])('rejects other errors (%j)', (err) => {
    expect(isNothingToRearmRefusal(err)).toBe(false);
  });
});

const HEAD = 'a'.repeat(40);
const RUN = 'd69c8366-cc58-4312-b080-2e7189fdc399';
const binding = { repo: 'fixture/example', pr: 7, head: HEAD, runId: RUN, claimId: 'fixture-lease-unique' };
const reason = 'The requested repair is already present';
const trusted = body => ({ id: 'fixture-comment', author: { login: 'web-everything' }, body });
const claim = id => ({ ...trusted(`🔒 conveyor fix-begin — fix claim held\n\n**Branch:** \`lane/fixture\` at \`${HEAD}\``), id });
const authorizedComments = () => [
  trusted(`🔁 review — changes requested\nAlready repaired\n<!-- reviewed-sha: ${HEAD} -->`),
  claim('initial'),
  { ...trusted(buildStandDownComment({ reason: 'needs-judgment', detail: 'Is repair owed?', head: HEAD })), id: 'stop' },
  { id: 'answer', author: { login: 'chalbert' }, body: buildOperatorAnswer({ standDownId: 'stop', actor: 'chalbert',
    channel: 'fixture', reason, disposition: 'rearm-review', noCodeOwed: true, head: HEAD }) },
  claim('resume'),
];
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** All process, lane, repository, time and persistence boundaries are fixtures. Unknown commands fail. */
function noChangeExit({ moved = false, reasonText = reason } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fixer-nocode-'));
  dirs.push(root);
  const lane = join(root, 'lanes', 'lane-fixture');
  mkdirSync(lane, { recursive: true });
  const stdout = [], stderr = [], calls = [];
  let completed = false;
  const run = vi.fn((cmd, args, opts) => {
    calls.push([cmd, args, opts]);
    expect([root, lane]).toContain(opts.cwd);
    if (cmd === 'gh' && args.includes('view')) return JSON.stringify({ title: 'Fixture', body: '', headRefOid: HEAD });
    if (cmd === 'node' && args.includes('acquire')) return JSON.stringify({ path: lane, holder: binding.claimId });
    if (cmd === 'node' && args.includes('release')) return '';
    if (cmd === 'git' && args.includes('config')) return '';
    if (cmd === 'git' && args.includes('rev-parse')) {
      if (args.includes('--git-path')) return 'fixture-absent-merge-head';
      return completed && moved ? 'b'.repeat(40) : HEAD;
    }
    if (cmd === 'git' && args.includes('status')) return '';
    throw Error(`unexpected fixture command: ${cmd} ${args.join(' ')}`);
  });
  const io = { run, weRoot: root, readPrompt: () => 'Apply the fixture review finding.', removePrompt: () => {},
    readComments: async () => authorizedComments(),
    readNoCodeSnapshot: () => ({ headRefOid: HEAD, labels: [{ name: 'review:changes' }], reviews: [] }),
    resolveProvider: async () => ({ spawn: async () => { completed = true; return { finalMessage: reasonText }; } }),
    readLease: () => ({ holder: binding.claimId }), renewLease: () => { throw Error('unexpected heartbeat'); },
    heartbeatMs: 60_000, clock: () => 1234, sleep: () => { throw Error('unexpected wait'); },
    timingPolicy: { pushAfterCi: false }, fixSafety: () => ({ value: {}, sources: {} }),
    acquireWaitPolicy: () => ({ ms: 0, source: 'fixture' }), createRunId: () => RUN,
    pendingRearm: { read: () => null, write: () => { throw Error('unexpected rearm debt'); }, clear: () => {} },
    readFile: () => null, fileExists: () => false, stageEntry: () => { throw Error('unexpected staging'); },
    recordOutcome: () => {}, recordRouted: () => ({}), appendLoopRow: () => {},
    releaseClaim: async () => ({ released: [] }), persistEvidence: () => { throw Error('unexpected persistence'); },
    write: line => stdout.push(line), writeErr: line => stderr.push(line) };
  return { io, stdout, stderr, calls, argv: ['--pr=7', '--session=fixture-fixer', '--ref=lane/fixture',
    `--prompt-file=${join(root, 'prompt.md')}`, '--provider=codex', `--repo=${binding.repo}`, `--lane-repo=${root}`] };
}

describe('FIXER-NOCODE-TRAILER', () => {
  it('no-change stand-down emits a head-bound no-code-owed trailer', async () => {
    const fixture = noChangeExit();
    expect((await fixer.runFixCli(fixture.argv, fixture.io)).code).toBe(0);
    const output = fixture.stdout.join('');
    expect(output).toContain('<!-- conveyor-no-code-owed:');
    const body = output.slice(output.indexOf('⚠️ conveyor fix — no-code-owed stand-down')).trim();
    // Terminal bookkeeping follows the comment: the emitted body is one write, not a substring of logs.
    const standDown = fixture.stdout.find(line => line.startsWith('⚠️ conveyor fix — no-code-owed stand-down')).trimEnd();
    expect(body).toContain(standDown);
    expect(procedure.parseNoCodeOwedStandDown(trusted(standDown), binding)).toEqual({ version: 1, ...binding, reason });
    expect(output.match(/<!-- conveyor-no-code-owed:/g)).toHaveLength(1);
    expect(fixture.calls.some(([cmd, args]) => cmd === 'gh' && args.includes('comment'))).toBe(false);
    const comments = [...authorizedComments(), trusted(standDown)];
    const facts = { comments, noCodeBinding: binding, labels: ['review:changes'], reviews: [] };
    expect(decideEmptyFixRound({ ...facts, liveHead: HEAD })).toEqual({ empty: false, noCodeResume: true });
    expect(decideEmptyFixRound({ ...facts, liveHead: 'b'.repeat(40) })).toMatchObject({ empty: true });
    const rearm = decideRearm({ currentLabels: ['review:changes', 'review:human'] });
    expect(rearm.addLabel).not.toBe('review:accepted');
    expect(rearm.removeLabels).not.toContain('review:human');
  });

  it('changed head emits no no-code authorization', async () => {
    const fixture = noChangeExit({ moved: true });
    await fixer.runFixCli(fixture.argv, fixture.io);
    expect(fixture.stdout.join('')).not.toContain('<!-- conveyor-no-code-owed:');
  });

  it('stand-down producer emits one fully bound versioned trailer', () => {
    const reads = [], output = [];
    const emit = () => fixer.emitNoCodeOwedStandDown({ ...binding, reason }, {
      readState: () => { reads.push('read'); return { head: HEAD, prHead: HEAD, clean: true, claimId: binding.claimId }; },
      write: text => { reads.push('write'); output.push(text); },
    });
    expect(emit()).toMatchObject({ emitted: true });
    expect(reads).toEqual(['read', 'write']);
    expect(procedure.parseNoCodeOwedStandDown(trusted(output[0].trimEnd()), binding)).toEqual({ version: 1, ...binding, reason });
  });

  it.each([
    ['missing state', null], ['dirty worktree', { clean: false }], ['missing worktree proof', { clean: undefined }],
    ['moved head', { head: 'b'.repeat(40) }], ['moved PR', { prHead: 'b'.repeat(40) }],
    ['missing head', { head: null }], ['short head', { head: HEAD.slice(0, 9) }],
    ['claim lost', { claimId: 'successor' }], ['claim unreadable', { claimId: null }],
  ])('withholds authorization for %s with an operator diagnostic', (_name, over) => {
    const write = vi.fn();
    const result = fixer.emitNoCodeOwedStandDown({ ...binding, reason }, {
      readState: () => over === null ? null : { head: HEAD, prHead: HEAD, clean: true, claimId: binding.claimId, ...over }, write,
    });
    expect(result).toMatchObject({ emitted: false, reason: expect.stringMatching(/no-code.*operator/i) });
    expect(write).not.toHaveBeenCalled();
  });

  it('unreadable or timed-out state holds without fallback', () => {
    const write = vi.fn();
    const result = fixer.emitNoCodeOwedStandDown({ ...binding, reason }, { readState: () => { throw Error('timed out'); }, write });
    expect(result).toMatchObject({ emitted: false, reason: expect.stringContaining('timed out') });
    expect(write).not.toHaveBeenCalled();
  });

  it('consumer refuses forged unbound and replayed trailers', () => {
    const body = procedure.buildNoCodeOwedStandDown({ ...binding, reason });
    const valid = trusted(body);
    const bad = [ { ...valid, author: { login: 'outsider' }, viewerDidAuthor: true },
      trusted(body.replace(RUN, 'other-run')), trusted(body.replace(HEAD, 'b'.repeat(40))),
      trusted(body.replace(`"runId":"${RUN}",`, '')), trusted(body.replace(`"head":"${HEAD}",`, '')),
      trusted(`Quoted evidence:\n${body}`), trusted(`${body}\n${body}`), trusted(`${body}\ntrailing prose`),
      trusted(body.replace('"version":1', '"version":2')) ];
    for (const comment of bad) {
      expect(procedure.parseNoCodeOwedStandDown(comment, binding)).toBeNull();
      expect(decideEmptyFixRound({ comments: [comment], liveHead: HEAD, noCodeBinding: binding }).empty).toBe(true);
    }
    for (const expected of [{ ...binding, claimId: 'later-claim' }, { ...binding, runId: undefined }, { ...binding, repo: 'other/repo' }, { ...binding, pr: 8 }]) {
      expect(procedure.parseNoCodeOwedStandDown(valid, expected)).toBeNull();
    }
    expect(decideEmptyFixRound({ comments: [valid, valid], liveHead: HEAD, noCodeBinding: binding }).empty).toBe(true);
    expect(decideEmptyFixRound({ comments: null, liveHead: HEAD, noCodeBinding: binding }).empty).toBe(true);
  });

  it('legacy guard notes remain diagnostic and never authorize the structured path', () => {
    const legacy = trusted(buildNoChangeComment({ actor: 'fixture fixer', since: HEAD }));
    expect(decideEmptyFixRound({ comments: [legacy], liveHead: HEAD, noCodeBinding: binding }).empty).toBe(true);
    expect(procedure.parseNoCodeOwedStandDown(legacy, binding)).toBeNull();
  });

  it('oversized reasons and input hold with an operator fallback', () => {
    expect(() => procedure.buildNoCodeOwedStandDown({ ...binding, reason: 'x'.repeat(1001) })).toThrow(/operator/);
    expect(procedure.parseNoCodeOwedStandDown(trusted('x'.repeat(8193)), binding)).toBeNull();
  });
});

describe('resolveRearmRefusalPolicy', () => {
  const env = { WE_PLATFORM_PREFERENCES_FILE: '/nonexistent/fix-run-rearm-policy.json' };

  it('defaults to noop and reports the standard source', () => {
    expect(resolveRearmRefusalPolicy(env)).toEqual({ mode: 'noop', source: 'standard' });
  });

  it.each(['fail', 'noop'])('accepts the %s env override and reports its source', (mode) => {
    expect(resolveRearmRefusalPolicy({ ...env, WE_FIX_REARM_NOTHING_TO_REARM: mode })).toEqual({ mode, source: 'env' });
  });

  it('ignores invalid overrides', () => {
    expect(resolveRearmRefusalPolicy({ ...env, WE_FIX_REARM_NOTHING_TO_REARM: 'invalid' })).toEqual({ mode: 'noop', source: 'standard' });
  });

  it('never throws when reading the environment fails', () => {
    const brokenEnv = { get WE_FIX_REARM_NOTHING_TO_REARM() { throw new Error('unreadable'); } };
    expect(resolveRearmRefusalPolicy(brokenEnv)).toEqual({ mode: 'noop', source: 'standard' });
  });
});
