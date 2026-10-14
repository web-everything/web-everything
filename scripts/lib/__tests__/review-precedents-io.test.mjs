/** IO contracts, with injected processes and one local git transport round trip. */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as io from '../review-precedents-io.mjs';
import { precedentEvent, fallbackPattern, captureFromComment, citationEvent, foldCitations } from '../review-precedents.mjs';
import { AUTOMATION_LOGINS } from '../marker-authorship.mjs';
import { FENCED_DATA_RULE } from '../mandate-fence.mjs';
import { withBareOrigin, git, writeLocalIdentity } from '../../operations/__tests__/helpers/real-repo.mjs';

const repo = 'web-everything/web-everything';
const at = '2026-10-13T21:25:00Z';
const seeds = JSON.parse(readFileSync('scripts/review-precedents.seeds.json', 'utf8')).precedents;
const events = seeds.slice(0, 2).map(record => precedentEvent(record, { at }));
const sendBack = `🔁 review — changes requested

Recorded by chalbert via claude-code-chat.

Operator decision (human review ceremony), 2026-10-13 ~17:25 ET, on head 6c580afa1: **changes**. Operator: "Send back".

The post-accept red team confirmed two broken edge cases on this head. Both corrupt backlog links, and this tool is about to close about 580 cards in bulk, so both must be fixed before approval.

1. **\`scripts/operations/close-items.mjs:70\`: closing a duplicate's survivor invalidates the \`closedInto\` pointers already aimed at it.** Fix: refuse to close a card while any closed duplicate points to it.`;
const comment = (body, login = 'chalbert') => ({ body, author: { login }, createdAt: at });
const info = { headRefOid: 'abcdef123', comments: [comment(sendBack), comment(sendBack, 'stranger'), comment('ADVISORY REVIEW', AUTOMATION_LOGINS[0])] };

describe('transport IO', () => {
  it('persists successive citation revisions on the same head and seat idempotently', () => {
    const input = ['changes', 'accept'].map(verdict => citationEvent({ repo, pr: 9, head: 'abcdef123', seat: 'panel', ids: [seeds[0].id], verdict, at }));
    let stored = '';
    const stage = ({ files }) => { stored = files[0].content({ existing: stored }); };
    expect(io.appendPrecedentEvents({ repo, events: input, stage }).rows).toBe(2);
    expect(io.appendPrecedentEvents({ repo, events: input, stage }).rows).toBe(0);
    const rows = stored.trim().split('\n').map(JSON.parse);
    expect(rows).toHaveLength(2);
    expect(foldCitations(rows).at(-1).verdict).toBe('accept');
  });
  it('persists a recurring verdict occurrence without source and replays it idempotently', () => {
    let stored = '';
    const stage = ({ files }) => { stored = files[0].content({ existing: stored }); };
    const events = ['changes', 'accept', 'changes'].map((verdict, index) => citationEvent({ repo, pr: 9, head: 'abcdef123', ids: [seeds[0].id], seat: 'panel', verdict, at: `${at}:${index}` }));
    for (const event of events) expect(io.appendPrecedentEvents({ repo, events: [event], stage }).rows).toBe(1);
    expect(io.appendPrecedentEvents({ repo, events, stage }).rows).toBe(0);
    expect(foldCitations(stored.trim().split('\n').map(JSON.parse))[0].verdict).toBe('changes');
  });
  it('reports a failed read as unreadable and an absent file on a read tip as empty', () => {
    expect(io.readPrecedentLog({ board: '.', repo, run: () => { throw new Error('offline'); } })).toMatchObject({ status: 'unreadable', reason: 'transport-read-failed', error: 'offline' });
    expect(io.readPrecedentLog({ board: '.', repo, run: () => '' })).toEqual({ status: 'ok', events: [], malformed: 0 });
  });
  it('folds precedents and citations while retaining malformed counts', () => {
    const text = `${JSON.stringify(events[0])}\nbroken\n`;
    const run = args => args[0] === 'ls-tree' ? io.precedentGitPath(repo) : args[0] === 'show' ? text : '';
    const result = io.readPrecedents({ board: '.', repo, run });
    expect(result.precedents.get(seeds[0].id)).toEqual(seeds[0]);
    expect(result).toMatchObject({ status: 'ok', citations: [], malformed: 1 });
  });
  it('refuses wrong refs and malformed events before staging', () => {
    const stage = vi.fn();
    expect(() => io.appendPrecedentEvents({ repo, events, branch: 'main', stage })).toThrow();
    expect(() => io.appendPrecedentEvents({ repo, events: [...events, {}], stage })).toThrow(TypeError);
    expect(stage).not.toHaveBeenCalled();
  });
  it('deduplicates against the fetched content and inside the batch, preserves existing bytes, and pins allowRef', () => {
    const existing = `${JSON.stringify(events[0])}\n`;
    let content;
    const stage = opts => {
      expect(opts.allowRef).toBe(io.PRECEDENT_PUSH_REF);
      expect(opts.message).toBe(`review-precedents: append ${repo}`);
      content = opts.files[0].content({ existing });
    };
    expect(io.appendPrecedentEvents({ repo, events: [...events, events[1]], stage, allowRef: 'refs/heads/main' })).toEqual({ status: 'appended', attempts: 1, rows: 1, duplicates: 2 });
    expect(content).toBe(existing + JSON.stringify(events[1]) + '\n');
  });
  it('recomputes appends on retry and carries every error on exhaustion', () => {
    const errors = [new Error('one'), new Error('two'), new Error('three')];
    const sleep = vi.fn(), onRetry = vi.fn();
    let calls = 0;
    try {
      io.appendPrecedentEvents({ repo, events, attempts: 3, sleep, onRetry, stage: () => { throw errors[calls++]; } });
      expect.fail('should exhaust');
    } catch (error) {
      expect(error).toBeInstanceOf(io.PrecedentAppendExhaustedError);
      expect(error.errors).toEqual(errors);
      expect(error.attempts).toBe(3);
    }
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(2);
    calls = 0;
    const stage = ({ files }) => {
      files[0].content({ existing: calls ? events.map(e => JSON.stringify(e)).join('\n') : '' });
      if (calls++ === 0) throw errors[0];
    };
    expect(io.appendPrecedentEvents({ repo, events, stage, sleep })).toMatchObject({ attempts: 2, rows: 0, duplicates: 2 });
  });
  it('appends and replays two seeds on a bare origin, then reads them from a fresh clone', async () => {
    await withBareOrigin(async ctx => {
      ctx.seedOriginBranch(io.PRECEDENT_TRANSPORT_BRANCH);
      expect(io.appendPrecedentEvents({ board: ctx.clone, repo, events }).rows).toBe(2);
      expect(io.appendPrecedentEvents({ board: ctx.clone, repo, events })).toMatchObject({ rows: 0, duplicates: 2 });
      const fresh = join(ctx.tmp, 'fresh');
      git(['clone', '--quiet', ctx.origin, fresh], { cwd: ctx.tmp });
      writeLocalIdentity(fresh);
      expect(io.readPrecedentLog({ board: fresh, repo })).toEqual({ status: 'ok', events, malformed: 0 });
    });
  });
});

describe('settings and drafting', () => {
  it('logs each settings line once and gives env precedence', () => {
    const log = vi.fn();
    const args = { settings: { review: { precedents: { maxCount: 2 } } }, env: { WE_REVIEW_PRECEDENTS_MAX_COUNT: '7' }, log };
    expect(io.loadPrecedentSettings(args)).toMatchObject({ maxCount: 7, sources: { maxCount: 'env' } });
    io.loadPrecedentSettings(args);
    expect(log).toHaveBeenCalledTimes(1);
  });
  it('reads PR info with the declared gh fields and the COMPLETE comment thread', () => {
    const { comments, ...head } = info;
    const exec = vi.fn(() => JSON.stringify(head));
    const readComments = vi.fn(() => comments);
    expect(io.readPrInfo({ repo, pr: 5184, exec, readComments })).toEqual(info);
    // The thread never comes from `gh pr view` (one page only): it comes from the paginated reader.
    expect(exec).toHaveBeenCalledWith('gh', ['pr', 'view', '5184', '--repo', repo, '--json', 'number,title,body,headRefOid,state,files']);
    expect(readComments).toHaveBeenCalledWith(5184, repo);
  });
  it('drafts through a routed model with fenced decision data and fails harmlessly', () => {
    const route = () => ({ provider: 'claude', model: 'test-policy-model' });
    const spawn = vi.fn(() => ({ status: 0, stdout: 'Bulk ops must keep closedInto links valid.\n' }));
    expect(io.draftPatternWithModel({ operatorWords: 'send back', body: 'links' }, { route, spawn })).toBe('Bulk ops must keep closedInto links valid.');
    const [cmd, args, options] = spawn.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(args).toContain('test-policy-model');
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', '']);
    expect(options.input).toContain('<decision>');
    expect(options.input).toContain(FENCED_DATA_RULE);
    expect(io.draftPatternWithModel({}, { route, spawn: () => ({ status: 1 }) })).toBeNull();
    expect(io.draftPatternWithModel({}, { route: null, spawn })).toBeNull();
    expect(io.draftPatternWithModel({}, { route: () => { throw new Error('no route'); }, spawn })).toBeNull();
    for (const stdout of ['', 'x'.repeat(401)]) expect(io.draftPatternWithModel({}, { route, spawn: () => ({ status: 0, stdout }) })).toBeNull();
    expect(io.draftPatternWithModel({}, { route, spawn: () => ({ status: 0, stdout: '<rule> `literal`' }) })).toBe('<rule> \'literal\'');
  });
  it('captures only the operator draft, uses the fallback and skips existing ids', async () => {
    const args = { repo, pr: 5184, info, existing: new Map(), now: at };
    const result = await io.capturePrecedents({ ...args, draft: async () => 'Keep survivor links valid.' });
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]).toMatchObject({ status: 'draft', pattern: 'Keep survivor links valid.', source: { head: '6c580afa1' } });
    const fallback = await io.capturePrecedents({ ...args, draft: async () => null });
    expect(fallback.drafts[0].pattern).toBe(fallbackPattern(captureFromComment(info.comments[0], { operatorLogins: ['chalbert'] })[0], { pr: 5184 }));
    expect(await io.capturePrecedents({ ...args, existing: new Map([[result.drafts[0].id, result.drafts[0]]]), draft: async () => null })).toMatchObject({ drafts: [], skipped: [result.drafts[0].id] });
    const invalid = await io.capturePrecedents({ ...args, draft: async () => 'two\nlines' });
    expect(invalid.invalid[0].errors).toContain('pattern');
  });
  it('backfills changes citations only from automation with the reviewed head', () => {
    const body = '🔁 review — changes requested\n[precedent:prec-5184-bulk-link-integrity]\n<!-- reviewed-sha: abcdef987 -->';
    const result = io.recordCitationsFromComments({ repo, pr: 5184, at, info: { ...info, comments: [comment(body, AUTOMATION_LOGINS[0]), comment(body)] } });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'citation', verdict: 'changes', head: 'abcdef987', ids: ['prec-5184-bulk-link-integrity'], seat: 'panel' });
  });
  it('round-trips advisory and recurring panel verdicts without losing the latest evidence', () => {
    const bodies = ['**⚠️ THIS IS AN ADVISORY REVIEW, NOT A RECORDED VERDICT.**', '🔁 review — changes requested', '✅ review — accepted', '🔁 review — changes requested'];
    const comments = bodies.map((body, id) => ({ ...comment(`${body}\n[precedent:${seeds[0].id}]\n<!-- reviewed-sha: abcdef987 -->`, AUTOMATION_LOGINS[0]), id: id + 1 }));
    const events = io.recordCitationsFromComments({ repo, pr: 9, info: { ...info, comments }, at });
    let stored = '';
    const stage = ({ files }) => { stored = files[0].content({ existing: stored }); };
    expect(io.appendPrecedentEvents({ repo, events, stage }).rows).toBe(4);
    expect(io.appendPrecedentEvents({ repo, events: io.recordCitationsFromComments({ repo, pr: 9, info: { ...info, comments }, at: 'later' }), stage }).rows).toBe(0);
    const run = args => args[0] === 'ls-tree' ? io.precedentGitPath(repo) : args[0] === 'show' ? stored : '';
    expect(io.readPrecedents({ board: '.', repo, run }).citations.map(e => [e.seat, e.verdict])).toEqual([['advisory', 'advisory'], ['panel', 'changes']]);
  });
  it('keeps the newer verdict when an older comment is edited and backfilled again', () => {
    const cite = verdict => `${verdict}\n[precedent:${seeds[0].id}]\n<!-- reviewed-sha: abcdef987 -->`;
    const older = { ...comment(cite('🔁 review — changes requested'), AUTOMATION_LOGINS[0]), id: 1, createdAt: '2026-10-13T10:00:00Z', updatedAt: '2026-10-13T10:00:00Z' };
    const newer = { ...comment(cite('✅ review — accepted'), AUTOMATION_LOGINS[0]), id: 2, createdAt: '2026-10-13T11:00:00Z', updatedAt: '2026-10-13T11:00:00Z' };
    let stored = '';
    const stage = ({ files }) => { stored = files[0].content({ existing: stored }); };
    const backfill = comments => io.appendPrecedentEvents({ repo, events: io.recordCitationsFromComments({ repo, pr: 9, info: { ...info, comments }, at }), stage });
    const run = args => args[0] === 'ls-tree' ? io.precedentGitPath(repo) : args[0] === 'show' ? stored : '';
    const panel = () => io.readPrecedents({ board: '.', repo, run }).citations.map(e => e.verdict);
    backfill([older, newer]);
    expect(panel()).toEqual(['accept']);
    // Editing the older comment changes its revision, so the backfill stores it again after the newer verdict.
    const edited = { ...older, body: `${older.body}\ntypo fixed`, updatedAt: '2026-10-13T12:00:00Z' };
    expect(backfill([edited, newer]).rows).toBe(1);
    expect(panel()).toEqual(['accept']);
    // A later revision of the SAME comment still replaces its earlier revision.
    const reworded = { ...newer, body: cite('🔁 review — changes requested'), updatedAt: '2026-10-13T13:00:00Z' };
    expect(backfill([edited, reworded]).rows).toBe(1);
    expect(panel()).toEqual(['changes']);
  });
});
