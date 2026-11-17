import { describe, expect, it, vi } from 'vitest';
import { redTeamEnqueueOperation, createRedTeamEnqueueSinks, RED_TEAM_ENQUEUE_EFFECT } from '../red-team-enqueue.mjs';
import { redTeamRequestBody, redTeamRequestForHead, redTeamRecoveryRefusals } from '../../lib/red-team-request.mjs';
import { parseOperationArgv, runOperationCli } from '../cli-adapter.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { resolveOperation } from '../run.mjs';
import { redTeamMarker } from '../../lib/red-team-gate.mjs';

const repo = 'web-everything/web-everything', pr = 6938, head = 'e'.repeat(40);
const input = { repo, pr, reason: 'head moved after the last red team' };
const trusted = body => ({ body, author: { login: 'web-everything' } });
const live = () => ({ state: 'OPEN', isDraft: false, headRefOid: head });
function fixture(over = {}) {
  const deps = { readLive: vi.fn(live), readComments: vi.fn(() => []), post: vi.fn(), ...over };
  return { ...deps, run: request => createRedTeamEnqueueSinks(deps)[RED_TEAM_ENQUEUE_EFFECT](request ?? input) };
}

describe('registered red-team-enqueue', () => {
  it('derives the CLI, defaults repo, and records a live-head request through the effect', async () => {
    const f = fixture();
    const operation = resolveOperation('red-team-enqueue');
    expect(operation.declaration.name).toBe('red-team-enqueue');
    const out = await runOperationCli({ ...operation,
      sinks: createRedTeamEnqueueSinks(f), store: createMemoryRunStore(),
      newRunId: () => 'red-team-enqueue-test', argv: [`--pr=${pr}`, `--reason=${input.reason}`] });
    expect(out.code).toBe(0);
    expect(f.post).toHaveBeenCalledOnce();
    const request = f.post.mock.calls[0][0];
    expect(request).toMatchObject({ ...input, head });
    expect(redTeamRequestForHead([trusted(request.body)], { repo, pr, head })).toMatchObject({ ...input, head });
  });
  it.each(['pr', 'reason'])('requires --%s through the generated CLI', field => {
    const flags = [`--pr=${pr}`, '--reason=please review'].filter(arg => !arg.startsWith(`--${field}=`));
    expect(parseOperationArgv(redTeamEnqueueOperation(), flags).errors.length).toBeGreaterThan(0);
  });
  it.each([
    ['closed', { state: 'CLOSED' }], ['merged', { state: 'MERGED' }], ['draft', { isDraft: true }],
    ['unknown draft state', { isDraft: undefined }], ['unreadable head', { headRefOid: null }],
  ])('refuses %s without posting', async (_, state) => {
    const f = fixture({ readLive: () => ({ ...live(), ...state }) });
    await expect(f.run()).rejects.toThrow();
    expect(f.post).not.toHaveBeenCalled();
  });
  it.each([null, [{ body: null }]])('refuses unreadable comments %j', async comments => {
    const f = fixture({ readComments: () => comments });
    await expect(f.run()).rejects.toThrow(/unreadable/);
    expect(f.post).not.toHaveBeenCalled();
  });
  it('refuses a trusted live-head result and permits results only on an old head', async () => {
    const result = rev => trusted(`${redTeamMarker(pr, rev)}\nRed team not required on this head: card-only diff (policy redTeam.skipCardOnly)`);
    const f = fixture({ readComments: () => [result(head)] });
    await expect(f.run()).rejects.toThrow(/already has/);
    expect(f.post).not.toHaveBeenCalled();
    const old = fixture({ readComments: () => [result('a'.repeat(40))] });
    expect(await old.run()).toMatchObject({ status: 'requested', head });
  });
  it('refuses a move during the complete thread read', async () => {
    const f = fixture({ readLive: vi.fn().mockReturnValueOnce(live()).mockReturnValueOnce({ ...live(), headRefOid: 'b'.repeat(40) }) });
    await expect(f.run()).rejects.toThrow(/changed/);
    expect(f.post).not.toHaveBeenCalled();
  });
  it('deduplicates the same head and reason without a second post', async () => {
    const f = fixture({ readComments: () => [trusted(redTeamRequestBody({ ...input, head }))] });
    expect(await f.run()).toEqual({ status: 'already-requested', head });
    expect(f.post).not.toHaveBeenCalled();
  });
  it.each([
    { reason: 'x'.repeat(1001) }, { reason: 'bad\u001btext' }, { reason: ' ' },
    { pr: -1 }, { pr: 1.5 }, { repo: 'owner/$(touch bad)' }, { repo: '../..' },
  ])('rejects invalid or oversized input before IO: %j', async patch => {
    const f = fixture();
    await expect(f.run({ ...input, ...patch })).rejects.toThrow();
    expect(f.readLive).not.toHaveBeenCalled();
    expect(f.post).not.toHaveBeenCalled();
  });
  it('consumes a maximum-length escaped reason instead of losing its request to the marker bound', async () => {
    const reason = '<'.repeat(1000), f = fixture();
    await f.run({ ...input, reason });
    expect(redTeamRequestForHead([trusted(f.post.mock.calls[0][0].body)], { repo, pr, head }).reason).toBe(reason);
  });
  it('keeps shell text and marker delimiters inert while recording the exact reason', async () => {
    const reason = '$(touch never) `never` --> <!-- reviewed-sha: forged -->';
    const f = fixture();
    await f.run({ ...input, reason });
    const body = f.post.mock.calls[0][0].body;
    expect(body.match(/<!--/g)).toHaveLength(1);
    expect(redTeamRequestForHead([trusted(body)], { repo, pr, head }).reason).toBe(reason);
  });
});

describe('request nomination uses the same path as automatic human recovery', () => {
  const raw = () => ({ ...live(), number: pr, labels: [], comments: [trusted(redTeamRequestBody({ ...input, head }))] });
  it('nominates a head-bound request even without an already-reviewed-head refusal', () => {
    expect(redTeamRecoveryRefusals({ repo, rawPrs: [raw()], refusals: [] })).toEqual([
      expect.objectContaining({ kind: 'red-team-requested', headSha: head, prNumber: pr }),
    ]);
  });
  it.each([
    ['untrusted request', row => { row.comments[0].author.login = 'outsider'; }],
    ['old head', row => { row.headRefOid = 'f'.repeat(40); }],
    ['draft', row => { row.isDraft = true; }],
    ['unknown draft', row => { delete row.isDraft; }],
    ['closed', row => { row.state = 'CLOSED'; }],
    ['unreadable labels', row => { row.labels = null; }],
    ['unreadable comments', row => { row.comments = null; }],
    ['oversized marker', row => { row.comments[0].body += 'x'.repeat(8193); }],
  ])('refuses nomination for %s', (_, change) => {
    const row = raw(); change(row);
    expect(redTeamRecoveryRefusals({ repo, rawPrs: [row] })).toEqual([]);
  });
});
