/** IO contracts, with injected processes and one local git transport round trip. */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as io from '../review-precedents-io.mjs';
import { precedentEvent, fallbackPattern, captureFromComment, citationEvent, foldCitations } from '../review-precedents.mjs';
import { AUTOMATION_LOGINS } from '../marker-authorship.mjs';
import { FENCED_DATA_RULE } from '../mandate-fence.mjs';
import { buildVerdictComment } from '../../review-set-label.mjs';
import { parseChangesVerdictProse } from '../review-escalation.mjs';
import { ADVISORY_NOTE_MARKER } from '../../conveyor/advisory-round-count.mjs';
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
  it('captures a real review-set-label clear-human comment through the wired producer shape', async () => {
    const reason = 'These ten words explain why this finding needs no changes.';
    const body = buildVerdictComment({ to: 'clear-human', actor: 'chalbert', headSha: 'abcdef1234567890abcdef1234567890abcdef12', reason, body: 'The **`scripts/lib/foo.mjs` cache is pure and safe** here.' });
    const result = await io.capturePrecedents({ repo, pr: 5184, info: { headRefOid: 'fedcba987', comments: [comment(body)] }, now: at });
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]).toMatchObject({ decision: 'accept-ok', pattern: "'scripts/lib/foo.mjs' cache is pure and safe",
      rationale: { operatorWords: reason }, scope: { paths: ['scripts/lib/foo.mjs'] },
      source: { kind: 'clear-human', head: 'abcdef1234567890abcdef1234567890abcdef12' } });
  });
  it('captures only the operator draft, uses the fallback and skips existing ids', async () => {
    const args = { repo, pr: 5184, info, existing: new Map(), now: at };
    const result = await io.capturePrecedents({ ...args, draft: async () => 'Keep survivor links valid.' });
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]).toMatchObject({ status: 'draft', pattern: 'Keep survivor links valid.', source: { head: '6c580afa1' } });
    const fallback = await io.capturePrecedents({ ...args, draft: async () => null });
    expect(fallback.drafts[0].pattern).toBe(fallbackPattern(captureFromComment(info.comments[0], { operatorLogins: ['chalbert'], parseChangesVerdict: parseChangesVerdictProse })[0], { pr: 5184 }));
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
  it('reads the reviewed head from the producer slot, never from quoted reviewed-sha prose', () => {
    const real = 'abcdef1234567890abcdef1234567890abcdef12', prHead = 'fedcba9876543210fedcba9876543210fedcba98';
    const quoted = `[precedent:${seeds[0].id}] An earlier round said reviewed-sha: 1111111 and <!-- reviewed-sha: 2222222 -->.`;
    const automation = body => ({ ...comment(body, AUTOMATION_LOGINS[0]), id: body.length });
    const accept = buildVerdictComment({ to: 'accepted', actor: 'review-bot', headSha: real, body: quoted });
    const changes = buildVerdictComment({ to: 'changes', actor: 'review-bot', body: quoted });
    const advisory = [ADVISORY_NOTE_MARKER, quoted, 'Raw quote: <!-- reviewed-sha: 3333333 -->', '', '---', '',
      `Net basis: \`0000000..${real}\` — 1 net changed file(s) vs current main (#2450).`].join('\n');
    const events = io.recordCitationsFromComments({ repo, pr: 9, at, info: { headRefOid: prHead, comments: [accept, changes, advisory].map(automation) } });
    expect(events.map(e => [e.verdict, e.head])).toEqual([['accept', real], ['changes', prHead], ['advisory', real]]);
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
  it('withdraws a comment whose citations were removed or which was deleted, restoring the older attribution', () => {
    const cite = (verdict, id = seeds[0].id) => `${verdict}\n${id ? `[precedent:${id}]\n` : ''}<!-- reviewed-sha: abcdef987 -->`;
    const automation = { author: { login: AUTOMATION_LOGINS[0] } };
    const older = { ...automation, id: 'IC_1', createdAt: '2026-10-13T10:00:00Z', body: cite('🔁 review — changes requested') };
    const newer = { ...automation, id: 'IC_2', createdAt: '2026-10-13T11:00:00Z', body: cite('✅ review — accepted', seeds[1].id) };
    let stored = '';
    const stage = ({ files }) => { stored = files[0].content({ existing: stored }); };
    const backfill = comments => io.appendPrecedentEvents({ repo, stage, citationSnapshot: { pr: 9, at },
      events: io.recordCitationsFromComments({ repo, pr: 9, info: { ...info, comments }, at }) });
    const run = args => args[0] === 'ls-tree' ? io.precedentGitPath(repo) : args[0] === 'show' ? stored : '';
    const panel = () => io.readPrecedents({ board: '.', repo, run }).citations.map(e => [e.verdict, e.ids]);
    expect(backfill([older, newer]).rows).toBe(2);
    expect(panel()).toEqual([['accept', [seeds[1].id]]]);
    // The newer comment loses its last citation: its attribution is withdrawn and the older one is current again.
    const uncited = { ...newer, body: cite('✅ review — accepted', null) };
    expect(backfill([older, uncited]).rows).toBe(1);
    expect(panel()).toEqual([['changes', [seeds[0].id]]]);
    expect(backfill([older, uncited]).rows).toBe(0);
    // Citing again after the withdrawal is stored again.
    expect(backfill([older, newer]).rows).toBe(1);
    expect(panel()).toEqual([['accept', [seeds[1].id]]]);
    // A deleted comment (absent from the complete thread) is withdrawn too, even when nothing else cites.
    expect(backfill([newer]).rows).toBe(1);
    expect(backfill([]).rows).toBe(1);
    expect(panel()).toEqual([]);
    expect(backfill([]).rows).toBe(0);
  });
  it('never lets a stale snapshot restore what a newer snapshot withdrew or replaced', () => {
    // The production reader returns no updatedAt, so two reads of one comment differ only by their snapshot time.
    const cite = (verdict, id = seeds[0].id) => `${verdict}\n${id ? `[precedent:${id}]\n` : ''}<!-- reviewed-sha: abcdef987 -->`;
    const automation = { author: { login: AUTOMATION_LOGINS[0] } };
    const older = { ...automation, id: 'IC_1', createdAt: '2026-10-13T10:00:00Z', body: cite('🔁 review — changes requested') };
    const newer = { ...automation, id: 'IC_2', createdAt: '2026-10-13T11:00:00Z', body: cite('✅ review — accepted', seeds[1].id) };
    let stored = '';
    const stage = ({ files }) => { stored = files[0].content({ existing: stored }); };
    const backfill = (comments, at) => io.appendPrecedentEvents({ repo, stage, citationSnapshot: { pr: 9, at },
      events: io.recordCitationsFromComments({ repo, pr: 9, info: { ...info, comments }, at }) });
    const run = args => args[0] === 'ls-tree' ? io.precedentGitPath(repo) : args[0] === 'show' ? stored : '';
    const panel = () => io.readPrecedents({ board: '.', repo, run }).citations.map(e => [e.verdict, e.ids]);
    const [t1, stale, t3, t4] = ['12:00', '13:00', '14:00', '15:00'].map(time => `2026-10-13T${time}:00Z`);
    expect(backfill([older, newer], t1).rows).toBe(2);
    // A newer read sees the newer comment's last citation removed and withdraws it.
    expect(backfill([older, { ...newer, body: cite('✅ review — accepted', null) }], t3).rows).toBe(1);
    expect(panel()).toEqual([['changes', [seeds[0].id]]]);
    // A read that began before that removal lands after it: it stores nothing and restores nothing.
    expect(backfill([older, newer], stale).rows).toBe(0);
    expect(panel()).toEqual([['changes', [seeds[0].id]]]);
    // A newer read that cites again is still stored.
    expect(backfill([older, newer], t4).rows).toBe(1);
    expect(panel()).toEqual([['accept', [seeds[1].id]]]);
    // The same holds for a deleted comment and for a stale read of an edited verdict.
    expect(backfill([older], '2026-10-13T17:00:00Z').rows).toBe(1);
    expect(backfill([older, newer], '2026-10-13T16:00:00Z').rows).toBe(0);
    expect(panel()).toEqual([['changes', [seeds[0].id]]]);
    const reworded = { ...older, body: cite('✅ review — accepted') };
    expect(backfill([reworded], '2026-10-13T19:00:00Z').rows).toBe(1);
    expect(backfill([older], '2026-10-13T18:00:00Z').rows).toBe(0);
    expect(panel()).toEqual([['accept', [seeds[0].id]]]);
  });
  it('refuses a stale snapshot whole, even when the newer read stored no row or recorded another head', () => {
    const automation = { author: { login: AUTOMATION_LOGINS[0] } };
    const cited = verdict => ({ ...automation, id: 'IC_1', createdAt: '2026-10-13T10:00:00Z', body: `${verdict}\n[precedent:${seeds[0].id}]\n<!-- reviewed-sha: abcdef987 -->` });
    let stored = '';
    const stage = ({ files }) => { stored = files[0].content({ existing: stored }); };
    const run = args => args[0] === 'ls-tree' ? io.precedentGitPath(repo) : args[0] === 'show' ? stored : '';
    const snapshot = (comments, at, extra = {}) => ({ at, events: io.recordCitationsFromComments({ repo, pr: 9, at, info: { ...info, ...extra, comments } }) });
    const apply = ({ at, events }) => io.appendPrecedentEvents({ repo, stage, citationSnapshot: { pr: 9, at }, events });
    const panel = () => io.readPrecedents({ board: '.', repo, run }).citations.map(e => [e.verdict, e.head]);
    expect(apply(snapshot([cited('✅ review — accepted')], '2026-10-13T11:00:00Z')).rows).toBe(1);
    // A newer read sees the same verdict: no row changes, but its read is still marked.
    expect(apply(snapshot([cited('✅ review — accepted')], '2026-10-13T15:00:00Z'))).toMatchObject({ status: 'appended', rows: 0 });
    // A read that began before it (when the comment said changes) lands now and is refused whole.
    expect(apply(snapshot([cited('🔁 review — changes requested')], '2026-10-13T13:00:00Z'))).toMatchObject({ status: 'stale-snapshot', rows: 0 });
    expect(panel()).toEqual([['accept', 'abcdef987']]);
    // Two reads of an empty log record an advisory comment on the head each saw; the stale one lands second.
    stored = '';
    const advisory = { ...automation, id: 'IC_2', createdAt: '2026-10-13T10:00:00Z', body: `ADVISORY REVIEW\n[precedent:${seeds[0].id}]` };
    const older = snapshot([advisory], '2026-10-13T12:00:00Z', { headRefOid: 'aaaaaaa1' });
    const newer = snapshot([advisory], '2026-10-13T13:00:00Z', { headRefOid: 'bbbbbbb2' });
    expect(apply(newer).rows).toBe(1);
    expect(apply(older).status).toBe('stale-snapshot');
    expect(panel()).toEqual([['advisory', 'bbbbbbb2']]);
    expect(() => apply({ at: 'not-a-time', events: [] })).toThrow(TypeError);
  });
  it('derives a snapshot on the tip it appends to, so a backfill landing first keeps the comment on its head', () => {
    const automation = { author: { login: AUTOMATION_LOGINS[0] } };
    const advisory = { ...automation, id: 'IC_2', createdAt: '2026-10-13T10:00:00Z', body: `ADVISORY REVIEW\n[precedent:${seeds[0].id}]` };
    let stored = '';
    const stage = ({ files }) => { stored = files[0].content({ existing: stored }); };
    const run = args => args[0] === 'ls-tree' ? io.precedentGitPath(repo) : args[0] === 'show' ? stored : '';
    const panel = () => io.readPrecedents({ board: '.', repo, run }).citations.map(e => [e.verdict, e.head]);
    const apply = (at, headRefOid, extra = {}) => io.appendPrecedentEvents({ repo, stage, ...extra,
      citationSnapshot: { pr: 9, at, info: { ...info, headRefOid, comments: [advisory] } } });
    // Both read the empty log; the older read (head aaaaaaa1) lands first, then the newer one (head bbbbbbb2).
    expect(apply('2026-10-13T12:00:00Z', 'aaaaaaa1').rows).toBe(1);
    expect(apply('2026-10-13T13:00:00Z', 'bbbbbbb2')).toMatchObject({ status: 'appended', rows: 0 });
    expect(panel()).toEqual([['advisory', 'aaaaaaa1']]);
    // A read mark ahead of this host's clock never refuses an honest read.
    expect(apply('2099-01-01T00:00:00Z', 'aaaaaaa1').rows).toBe(0);
    expect(apply('2026-10-13T14:00:00Z', 'aaaaaaa1', { now: () => Date.parse('2026-10-13T14:00:00Z') }).status).toBe('appended');
    expect(() => io.appendPrecedentEvents({ repo, stage, events: [], citationSnapshot: { pr: 9, at: '2026-10-13T15:00:00Z', info } })).toThrow(TypeError);
  });
  it('never lets a row stamped by a clock that ran ahead freeze a comment', () => {
    const automation = { author: { login: AUTOMATION_LOGINS[0] } };
    const cited = verdict => ({ ...automation, id: 'IC_1', createdAt: '2026-10-13T10:00:00Z', body: `${verdict}\n[precedent:${seeds[0].id}]\n<!-- reviewed-sha: abcdef987 -->` });
    let stored = '';
    const stage = ({ files }) => { stored = files[0].content({ existing: stored }); };
    const run = args => args[0] === 'ls-tree' ? io.precedentGitPath(repo) : args[0] === 'show' ? stored : '';
    const clock = { now: () => Date.parse('2026-10-13T20:00:00Z') };
    // The fold never reads a clock, so every reader sees the same result at any time.
    const panel = () => io.readPrecedents({ board: '.', repo, run }).citations.map(e => e.verdict);
    const apply = (at, comments, extra = clock) => io.appendPrecedentEvents({ repo, stage, ...extra,
      citationSnapshot: { pr: 9, at, info: { ...info, comments } } });
    // A writer whose clock reads 2099 stores an accept.
    expect(apply('2099-01-01T00:00:00Z', [cited('✅ review — accepted')], { now: () => Date.parse('2099-01-01T00:00:00Z') }).rows).toBe(1);
    // An honest newer read of the edited verdict still replaces it, and a read of the deleted comment withdraws it.
    expect(apply('2026-10-13T20:00:00Z', [cited('🔁 review — changes requested')]).rows).toBe(1);
    expect(panel()).toEqual(['changes']);
    stored = '';
    expect(apply('2099-01-01T00:00:00Z', [cited('✅ review — accepted')], { now: () => Date.parse('2099-01-01T00:00:00Z') }).rows).toBe(1);
    expect(apply('2026-10-13T20:00:00Z', []).rows).toBe(1);
    expect(panel()).toEqual([]);
  });
  it('keeps a comment on the head it was first recorded on after the PR head moves', () => {
    const automation = { author: { login: AUTOMATION_LOGINS[0] } };
    const advisory = { ...automation, id: 'IC_9', createdAt: '2026-10-13T10:00:00Z', body: `ADVISORY REVIEW\n[precedent:${seeds[0].id}]` };
    const short = { ...automation, id: 'IC_8', createdAt: '2026-10-13T10:00:00Z', body: `🔁 review — changes requested\n[precedent:${seeds[0].id}]\n<!-- reviewed-sha: abcdef9 -->` };
    const firstHead = 'abcdef9000000000000000000000000000000000', pushedHead = '1234567000000000000000000000000000000000';
    let stored = '';
    const stage = ({ files }) => { stored = files[0].content({ existing: stored }); };
    const backfill = headRefOid => {
      const log = io.readPrecedentLog({ board: '.', repo, run: args => args[0] === 'ls-tree' ? io.precedentGitPath(repo) : args[0] === 'show' ? stored : '' });
      const events = io.recordCitationsFromComments({ repo, pr: 9, at, stored: log.events, info: { ...info, headRefOid, comments: [advisory, short] } });
      return io.appendPrecedentEvents({ repo, stage, citationSnapshot: { pr: 9, at }, events });
    };
    expect(backfill(firstHead).rows).toBe(2);
    expect(backfill(pushedHead).rows).toBe(0);
    const run = args => args[0] === 'ls-tree' ? io.precedentGitPath(repo) : args[0] === 'show' ? stored : '';
    expect(io.readPrecedents({ board: '.', repo, run }).citations.map(e => [e.seat, e.head])).toEqual([['advisory', firstHead], ['panel', firstHead]]);
  });
  it('keeps a reverted edit current when the comment reader returns no revision time', () => {
    // The production reader (pr-comments-list.mjs) returns body, createdAt, author and id only — no updatedAt.
    const cite = verdict => `${verdict}\n[precedent:${seeds[0].id}]\n<!-- reviewed-sha: ABCDEF987 -->`;
    const original = { body: cite('✅ review — accepted'), author: { login: AUTOMATION_LOGINS[0] }, createdAt: '2026-10-13T10:00:00Z', id: 'IC_1' };
    let stored = '';
    const stage = ({ files }) => { stored = files[0].content({ existing: stored }); };
    const backfill = body => io.appendPrecedentEvents({ repo, events: io.recordCitationsFromComments({ repo, pr: 9, info: { ...info, headRefOid: 'abcdef9870000000000000000000000000000000', comments: [{ ...original, body }] }, at }), stage });
    const run = args => args[0] === 'ls-tree' ? io.precedentGitPath(repo) : args[0] === 'show' ? stored : '';
    const panel = () => io.readPrecedents({ board: '.', repo, run }).citations.map(e => [e.head, e.verdict]);
    expect(backfill(original.body).rows).toBe(1);
    expect(backfill(cite('🔁 review — changes requested')).rows).toBe(1);
    expect(backfill(original.body).rows).toBe(1);
    expect(backfill(original.body).rows).toBe(0);
    // The short, upper-case reviewed-sha resolves to the PR head, so every revision folds into one seat.
    expect(panel()).toEqual([['abcdef9870000000000000000000000000000000', 'accept']]);
  });
});
