import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const fixture = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { root: mkdtempSync(join(tmpdir(), 'fixer-nocode-audit-')), external: [] };
});
vi.mock('node:os', async original => ({ ...await original(),
  homedir: () => fixture.root, userInfo: () => ({ homedir: fixture.root }), tmpdir: () => fixture.root,
}));
vi.mock('node:child_process', async original => {
  const refuse = (...args) => { fixture.external.push(args); throw Error('unported subprocess'); };
  const ports = { ...await original(), execFileSync: refuse, execSync: refuse, spawnSync: refuse, spawn: refuse, execFile: refuse };
  return { ...ports, default: ports };
});
vi.mock('../../lib/settings-files.mjs', async original => ({ ...await original(), readSettings: () => ({}) }));
vi.mock('../../lib/github-app-identity.mjs', async original => ({ ...await original(),
  readBotLogins: () => ['web-everything'],
}));
vi.mock('../../lib/policy-cascade.mjs', async original => ({ ...await original(),
  readPlatformPreferences: () => ({ prefs: {}, errors: [] }), platformPreference: () => undefined,
  cascadePolicy: (_name, _tool, { standard = {} } = {}) => ({ value: { ...standard },
    sources: Object.fromEntries(Object.keys(standard).map(key => [key, 'fixture'])) }),
}));

import { runFixCli } from '../fix-run.mjs';
import { buildNoCodeOwedStandDown, parseNoCodeOwedStandDown } from '../../conveyor/fix-procedure.mjs';
import { buildStandDownComment } from '../../conveyor/stand-down.mjs';
import { buildOperatorAnswer, NO_CODE_REARM_RECEIPT } from '../../conveyor/stand-down-answer-core.mjs';
import { decideEmptyFixRound, REARM_COMMENT_MARKER } from '../../conveyor/rearm-review.mjs';

const HEAD = 'a'.repeat(40);
const binding = { repo: 'fixture/example', pr: 7, head: HEAD, runId: 'fixture-run', claimId: 'fixture-holder' };
const comment = (id, body, login = 'web-everything') => ({ id, body, author: { login } });
const claim = id => comment(id, `🔒 conveyor fix-begin — fix claim held\n\n**Branch:** \`lane/fixture\` at \`${HEAD}\``);
const verdict = comment('verdict', `🔁 review — changes requested\nRepair the defect\n<!-- reviewed-sha: ${HEAD} -->`);
const stop = id => comment(id, buildStandDownComment({ reason: 'needs-judgment', detail: 'Is repair owed?', head: HEAD }));
const answer = (id, standDownId, extra = {}) => comment(id, buildOperatorAnswer({ standDownId,
  actor: 'chalbert', channel: 'fixture', reason: 'No repair is owed', disposition: 'rearm-review',
  noCodeOwed: true, head: HEAD, ...extra }), 'chalbert');
const authorized = () => [verdict, claim('initial'), stop('stop'), answer('answer', 'stop'), claim('resume')];
const record = comment('record', buildNoCodeOwedStandDown({ ...binding, reason: 'Already repaired' }));
const decide = (comments, extra = {}) => decideEmptyFixRound({ comments, liveHead: HEAD,
  noCodeBinding: binding, labels: ['review:changes'], reviews: [], ...extra });

let cwd;
beforeAll(() => { cwd = vi.spyOn(process, 'cwd').mockReturnValue(fixture.root); vi.useFakeTimers(); vi.setSystemTime(1234); });
afterAll(() => {
  cwd.mockRestore(); vi.useRealTimers(); rmSync(fixture.root, { recursive: true, force: true });
  expect(fixture.external).toEqual([]);
});

function launcher({ comments = [verdict], message = 'Unable to repair the requested defect', snapshot = {}, readError } = {}) {
  const root = join(fixture.root, 'repo');
  const lane = join(root, 'lanes', 'lane-fixture');
  mkdirSync(lane, { recursive: true });
  const writes = [], calls = [];
  const run = (cmd, args, opts) => {
    calls.push([cmd, args]);
    expect([root, lane]).toContain(opts.cwd);
    if (cmd === 'gh' && args.includes('view')) {
      return JSON.stringify({ title: 'Fixture', body: '', headRefOid: HEAD,
        labels: [{ name: 'review:changes' }], reviews: [], ...snapshot });
    }
    if (cmd === 'node' && args.includes('acquire')) return JSON.stringify({ path: lane, holder: binding.claimId });
    if (cmd === 'node' && args.includes('release')) return '';
    if (cmd === 'git' && args.includes('config')) return '';
    if (cmd === 'git' && args.includes('status')) return '';
    if (cmd === 'git' && args.includes('rev-parse')) return args.includes('--git-path') ? 'absent-merge-head' : HEAD;
    throw Error(`unexpected fixture command: ${cmd} ${args.join(' ')}`);
  };
  const io = { run, weRoot: root, readComments: async () => comments, readPrompt: () => 'Repair the fixture defect.',
    readNoCodeSnapshot: ({ repo, pr, cwd }) => {
      expect({ repo, pr, cwd }).toEqual({ repo: binding.repo, pr: '7', cwd: root });
      if (readError) throw readError;
      return { headRefOid: HEAD, labels: [{ name: 'review:changes' }], reviews: [], ...snapshot };
    },
    removePrompt: () => {}, resolveProvider: async () => ({ spawn: async () => ({ finalMessage: message }) }),
    readLease: () => ({ holder: binding.claimId }), renewLease: () => { throw Error('unexpected renewal'); },
    clock: () => 1234, createRunId: () => binding.runId, heartbeatMs: 60_000,
    timingPolicy: { pushAfterCi: false }, sleep: () => { throw Error('unexpected wait'); },
    readFile: () => null, fileExists: () => false, stageEntry: () => { throw Error('unexpected staging'); },
    pendingRearm: { read: () => null, write: () => { throw Error('unexpected rearm debt'); }, clear: () => {} },
    persistEvidence: () => { throw Error('unexpected evidence write'); }, recordOutcome: () => {}, recordRouted: () => ({}),
    appendLoopRow: () => {}, releaseClaim: async () => ({ released: [] }), write: line => writes.push(line),
    writeErr: line => writes.push(line) };
  return { writes, calls, execute: () => runFixCli(['--pr=7', '--session=fixture-session', '--ref=lane/fixture',
    `--prompt-file=${join(root, 'prompt.md')}`, '--provider=codex', `--repo=${binding.repo}`, `--lane-repo=${root}`], io) };
}

describe('FIXER-NOCODE-TRAILER audit regressions', () => {
  it('finding 1255: unchanged clean repair failure cannot emit no-code authorization', async () => {
    const run = launcher();
    expect((await run.execute()).code).toBe(0);
    expect(run.writes.join('')).not.toContain('<!-- conveyor-no-code-owed:');
    expect(run.writes.join('')).toMatch(/no-code evidence withheld.*operator/i);
    expect(run.calls.some(([cmd, args]) => cmd === 'gh' && args.includes('comment'))).toBe(false);
  });

  it('an authorized controlled no-change exit parses through the guard and refuses changed-head replay', async () => {
    const run = launcher({ comments: authorized(), message: 'Already repaired' });
    expect((await run.execute()).code).toBe(0);
    const emissions = run.writes.filter(line => line.startsWith('⚠️ conveyor fix — no-code-owed stand-down'));
    expect(emissions).toHaveLength(1);
    const produced = comment('produced', emissions[0].trimEnd());
    expect(parseNoCodeOwedStandDown(produced, binding)).toEqual({ version: 1, ...binding, reason: 'Already repaired' });
    expect(decide([...authorized(), produced])).toEqual({ empty: false, noCodeResume: true });
    expect(decide([...authorized(), produced], { liveHead: 'b'.repeat(40) }).empty).toBe(true);
  });

  it.each([
    ['snapshot timed out', { readError: Error('fixture timeout') }],
    ['live labels unreadable', { snapshot: { labels: null } }],
    ['formal reviews unreadable', { snapshot: { reviews: null } }],
    ['formal changes requested', { snapshot: { reviews: [{ state: 'CHANGES_REQUESTED' }] } }],
    ['live head moved', { snapshot: { headRefOid: 'b'.repeat(40) } }],
  ])('producer withholds authorization when %s', async (_name, options) => {
    const run = launcher({ comments: authorized(), message: 'Already repaired', ...options });
    expect((await run.execute()).code).toBe(0);
    expect(run.writes.join('')).not.toContain('<!-- conveyor-no-code-owed:');
    expect(run.writes.join('')).toMatch(/no-code evidence withheld.*operator/i);
  });

  it.each([
    ['missing operator ruling', [verdict, claim('initial')]],
    ['later changes-requested verdict', [...authorized(), record, verdict]],
    ['later stand-down', [...authorized(), record, stop('new-stop')]],
    ['second same-head claim', [...authorized(), record, claim('second')]],
    ['completed rearm', [...authorized(), record, comment('rearmed', REARM_COMMENT_MARKER)]],
    ['spent ruling', [...authorized(), record, comment('receipt', NO_CODE_REARM_RECEIPT('answer', HEAD))]],
    ['record without authorization', [record]],
  ])('finding 285: structured record preserves %s guard', (_name, comments) => {
    const thread = comments.includes(record) ? comments : [...comments, record];
    expect(decide(thread).empty).toBe(true);
  });

  it('structured record preserves exhausted waiver and cap-override budgets', () => {
    const thread = [verdict, claim('c0'), stop('s0'), answer('a0', 's0', { noCodeOwed: false, head: undefined }),
      claim('c1'), stop('s1'), answer('a1', 's1', { noCodeOwed: false, head: undefined }),
      claim('c2'), stop('s2'), answer('a2', 's2'), claim('c3'), stop('s3'), answer('a3', 's3'), claim('c4'), record];
    expect(decide(thread).empty).toBe(true);
  });

  it.each([
    ['missing labels', { labels: undefined }], ['red-team hold', { labels: ['review:changes', 'red-team:blocked'] }],
    ['missing reviews', { reviews: undefined }], ['malformed reviews', { reviews: [{}] }],
    ['formal changes-requested review', { reviews: [{ state: 'CHANGES_REQUESTED', commit: { oid: HEAD } }] }],
  ])('structured record holds on %s', (_name, snapshot) => {
    expect(decide([...authorized(), record], snapshot).empty).toBe(true);
  });
});
