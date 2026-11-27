// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execRead } from '../../lib/proc-read.mjs';
import { createReviewJobIo, runReviewJob } from '../review-job.mjs';

const fixture = vi.hoisted(() => ({ root: null }));
vi.mock('../../lib/proc-read.mjs', async original => ({ ...await original(), execRead: vi.fn() }));
vi.mock('../review-dispatch.mjs', async original => ({ ...await original(),
  planReviewDispatch: ({ pr, repo }) => ({ pr, repo, repoKey: 'we', laneRepo: fixture.root, sessionSlug: 'fixture-review' }),
}));
const repo = 'web-everything/web-everything', pr = 1;
const a = 'a'.repeat(40), b = 'b'.repeat(40), patch = 'e'.repeat(40);
const comments = [
  { id: 'IC_accept', author: { login: 'web-everything' }, createdAt: '2026-11-01T00:00:00Z',
    body: `✅ review — accepted\n<!-- reviewed-sha: ${a} -->` },
  { id: 'IC_result', author: { login: 'web-everything' }, createdAt: '2026-11-01T01:00:00Z',
    body: `<!-- we:red-team-advisory pr=1 rev=${a} -->\nRed team not required on this head: card-only diff` },
];
const reviewsArgv = ['api', `repos/${repo}/pulls/${pr}/reviews`, '--paginate', '--slurp'];

beforeEach(() => { fixture.root = mkdtempSync(join(tmpdir(), 'carry-evidence-')); vi.clearAllMocks(); });
afterEach(() => rmSync(fixture.root, { recursive: true, force: true }));

function reader(pages) {
  execRead.mockImplementation((file, argv, options) => {
    expect(file).toBe('gh'); expect(options.cwd).toBe(fixture.root); expect(options.env).toEqual({ FIXTURE: 'carry' });
    if (argv[0] === 'pr' && argv[1] === 'view') return JSON.stringify({ headRefOid: b });
    if (argv[1] === `repos/${repo}/pulls/${pr}/reviews`) {
      expect(argv).toEqual(reviewsArgv);
      expect(options.timeout).toBeGreaterThan(0); expect(options.maxBuffer).toBeGreaterThan(0);
      if (pages instanceof Error) throw pages;
      return pages;
    }
    if (argv[1] === 'graphql') return JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: comments.length } } } } });
    if (argv.includes(`repos/${repo}/issues/${pr}/comments`)) return comments.map(c => [
      c.body.replaceAll('\n', '\\n'), c.createdAt, c.author.login, c.id, '',
    ].join('\t')).join('\n');
    throw Error(`unexpected fixture argv: ${JSON.stringify(argv)}`);
  });
  return createReviewJobIo({ root: fixture.root, dir: join(fixture.root, 'jobs'), env: { FIXTURE: 'carry' },
    exec: execRead, recoveryProbe: () => null, queueBaseline: () => null, log: vi.fn() });
}
function job(readCarryEvidence) {
  return { root: fixture.root, now: () => 0, claim: () => ({ ok: true }), unclaim: vi.fn(), report: vi.fn(), log: vi.fn(),
    redTeamStatus: vi.fn(), readPrevCompletion: () => null, newActorId: () => 'fixture-actor',
    prepareLane: () => ({ head: b }), acquireLane: () => ({ lanePath: fixture.root }), updateRecord: vi.fn(), releaseLane: vi.fn(),
    carryAcrossRebaseSetting: () => ({ value: 'on', source: 'fixture' }), readCarryEvidence,
    contributionPatchId: () => patch, restampVerdict: vi.fn(() => ({ ok: true })), postCarryComment: vi.fn(),
    publishCarriedCheck: vi.fn(() => ({ ok: true })), markCarriedCheckOwed: vi.fn(),
    runLoop: vi.fn(() => ({ status: 0, stdout: JSON.stringify({ stopped: 'complete', verdict: { verdict: 'accept', loop: { outcome: 'converged' } } }) })),
    runExtraSeats: vi.fn(), runRedTeam: vi.fn(), startSpeculativeRedTeam: vi.fn(), speculativeRedTeamSetting: () => ({ enabled: false }),
  };
}
function refusesCarry(adapter) {
  const io = job(adapter.readCarryEvidence);
  expect(runReviewJob({ pr, repo }, io).outcome).not.toBe('carried');
  for (const key of ['restampVerdict', 'postCarryComment', 'publishCarriedCheck']) expect(io[key]).not.toHaveBeenCalled();
  expect(io.runLoop).toHaveBeenCalledTimes(1);
}
describe('readCarryEvidence formal-review adapter', () => {
  it('reads paginated reviews with --slurp, flattens pages and preserves complete comments', () => {
    const reviews = [{ state: 'APPROVED' }, { state: 'PENDING' }];
    const adapter = reader(JSON.stringify([[reviews[0]], [reviews[1]]]));
    expect(adapter.readCarryEvidence({ pr, repo })).toEqual({ headSha: b, comments, reviews });
    expect(execRead.mock.calls.filter(([, argv]) => argv[1] === reviewsArgv[1])).toHaveLength(1);
  });
  it('page-two CHANGES_REQUESTED reaches the carry decision with no carry write', () => {
    const adapter = reader(JSON.stringify([[], [{ state: 'CHANGES_REQUESTED', submitted_at: '2026-11-02T00:00:00Z' }]]));
    refusesCarry(adapter);
  });
  it.each([
    ['malformed JSON', '{'], ['non-array top level', '{}'], ['non-array page', '[[],{}]'],
    ['truncated JSON', '[[{"state":"APPROVED"}]'], ['empty stream', ''], ['no pages', '[]'],
    ['failed read', Error('gh failed')], ['timed-out read', Object.assign(Error('timeout'), { code: 'ETIMEDOUT' })],
  ])('%s returns reviews:null and never carries', (_name, pages) => {
    const adapter = reader(pages);
    expect(adapter.readCarryEvidence({ pr, repo }).reviews).toBeNull();
    refusesCarry(adapter);
  });
});
