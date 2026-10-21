import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withRealRepo } from './helpers/real-repo.mjs';
import { explainWhy, lastMentionLine, whyOperation } from '../operator-why.mjs';
import { createWhyReader } from '../operator-why-io.mjs';
import { recordRedTeamStatus, redTeamStatusDir } from '../../lib/drain-red-team-evidence.mjs';

const base = { subject: { kind: 'pr', id: 5017 }, repo: 'web-everything/web-everything', pr: { state: 'OPEN', labels: [] }, logs: [], checks: [], gaps: [] };
const item = { ...base, subject: { kind: 'item', id: '5754' }, card: { status: 'open' } };
describe('why first-match owner rules', () => {
  const rows = [
    ['merged', { pr: { state: 'MERGED' }, standDown: { reason: 'x' } }, 'nobody', 'nothing (closed)', null],
    ['closed', { pr: { state: 'CLOSED' } }, 'nobody', 'nothing (closed)', null],
    ['stand down', { standDown: { reason: 'judgment' } }, 'operator', 'stand-down answer (judgment)', 'stand-down-answer.mjs'],
    ['round cap', { pr: { labels: ['review:human'] }, logs: [{ name: 'fix', line: 'round-cap reached' }] }, 'operator', 'human review / park', 'grant-rounds'],
    ['human park', { pr: { labels: ['review:human'] } }, 'operator', 'human review / park', 'unpark'],
    ['live claim', { claims: [{ live: true, session: 'worker' }] }, 'fix daemon (worker)', 'fix round in progress', null],
    ['stale claim', { claims: [{ live: false }] }, 'nobody (stale fix claim)', 'stale fix claim', 'clear-claim'],
    ['changes', { pr: { labels: ['review:changes'] } }, 'fix daemon', 'fix dispatch', null],
    ['pending', { pr: { labels: ['review:pending'] } }, 'review daemon', 'review', null],
    ['refused fix', { pr: { labels: ['review:changes'] }, logs: [{ name: 'fix', line: 'refused: busy' }] }, 'fix daemon', 'refused: busy', 'rearm'],
    ['skipped review', { pr: { labels: ['review:pending'] }, logs: [{ name: 'review', line: 'skipped: held' }] }, 'review daemon', 'skipped: held', 'rearm'],
    ['red CI', { pr: { labels: ['ready-to-merge'] }, checks: [{ name: 'unit', conclusion: 'FAILURE' }] }, 'drain', 'CI', null],
    ['behind', { pr: { labels: ['ready-to-merge'] }, logs: [{ name: 'drain', line: 'behind main' }] }, 'drain', 'behind main', 'refresh'],
    ['merge queue', { pr: { labels: ['ready-to-merge'] }, mergePosition: 2 }, 'drain', 'merge queue position 2', null],
    ['fallback', {}, 'unknown', 'no signal found', null],
  ];
  for (const [name, facts, owner, waitingFor, op] of rows) it(name, () => {
    const out = explainWhy({ ...base, ...facts });
    expect(out.owner).toBe(owner); expect(out.waitingFor).toBe(waitingFor);
    if (op) expect(out.suggestedOp).toContain(op); else expect(out.suggestedOp).toBeNull();
    if (op) for (const flag of ['--preview', '--actor=<login>', '--channel=<where>', '--reason="<why>"']) expect(out.suggestedOp).toContain(flag);
    expect(out.sections.map(s => s.name)).toEqual(['state', 'checks', 'daemons', 'holds', 'queue', 'owner']);
    expect(out.screen.split('\n').length).toBeLessThanOrEqual(40);
  });
  for (const label of ['red-team:pending', 'red-team:blocked']) {
    for (const [name, extra, owner, waitingFor] of rows.filter(([name]) => name !== 'fallback')) it(`${label} preserves ${name}`, () => {
      const facts = { ...base, ...extra };
      const before = explainWhy(facts);
      const out = explainWhy({ ...facts, pr: { ...facts.pr, labels: [...(facts.pr.labels ?? []), label] } });
      expect(out.owner).toBe(owner);
      expect(out.waitingFor).toBe(waitingFor);
      expect(out.suggestedOp).toBe(before.suggestedOp);
      expect(out.redTeamWaitingFor).toContain('no result for live head');
      expect(out.screen).toContain('red team waiting for:');
    });
    it(`${label} preserves unavailable required checks`, () => {
      const out = explainWhy({ ...base, pr: { labels: ['ready-to-merge', label] }, checksUnavailable: true });
      expect(out.owner).toBe('drain');
      expect(out.waitingFor).toBe('required checks unavailable');
      expect(out.suggestedOp).toBeNull();
    });
  }
  for (const [name, extra, owner, op] of [
    ['build hold', { buildHolds: [{ reason: 'manual' }] }, 'nobody (parked: manual)', 'unpark'],
    ['backoff', { backoffs: [{ reason: 'dispatch-backoff-exhausted' }] }, 'nobody (parked: dispatch-backoff-exhausted)', 'unpark'],
    ['prepare', { prepareFailures: [{ held: true, cause: 'unknown' }] }, 'nobody (parked: prepare failure)', 'retry-prepare'],
    ['active PR', { card: { status: 'active' }, linkedPrs: [{ number: 7, explanation: { owner: 'drain' } }] }, 'drain', null],
    ['queued', { card: { status: 'open', queued: true }, logs: [{ name: 'builder', line: 'waiting for slot' }] }, 'builder', null],
  ]) it(name, () => { const out = explainWhy({ ...item, ...extra }); expect(out.owner).toBe(owner); if (op) expect(out.suggestedOp).toContain(op); if (name === 'active PR') expect(out.waitingFor).toContain('see why --pr=7'); });
});
it('selects last whole-token mention', () => {
  expect(lastMentionLine('#5017 old\n#50170 wrong\npr=5017 newest\npr=50170 wrong', base.subject)).toBe('pr=5017 newest');
  expect(lastMentionLine('pr 5017\n{"pr":5017}', base.subject)).toBe('{"pr":5017}');
  expect(lastMentionLine('#5754 yes\n57540 no', item.subject)).toBe('#5754 yes');
  expect(lastMentionLine('xhk3bja yes\nxhk3bjaa no', { kind: 'item', id: 'xhk3bja' })).toBe('xhk3bja yes');
});
it('refuses neither/both before calling the reader and declares only compute', () => {
  const declaration = whyOperation({ readWhy: () => { throw new Error('reader called'); } });
  expect(declaration.steps.map(s => s.step.kind)).toEqual(['compute', 'compute']);
  for (const input of [{ pr: 0, item: '' }, { pr: 1, item: '2' }]) expect(() => declaration.steps[0].step.fn({ input })).toThrow('exactly one');
});
it('injects all external reads and preserves failed-source gaps', () => {
  const read = createWhyReader({
    run: () => JSON.stringify({ number: 5017, state: 'OPEN', labels: [], headRefOid: 'sha' }),
    readAgents: () => [], readComments: () => [], readRequiredChecks: () => ['unit'], readChecks: () => [{ name: 'unit', conclusion: 'SUCCESS' }],
    listPlists: () => [], listFiles: () => [], tail: () => ({ text: 'now #5017 observed' }),
    readClaims: () => [], readBuildHolds: () => { throw new Error('offline'); }, readBackoffs: () => [],
    readPrepareFailures: () => ({ failures: {} }), listPrs: () => [], readCard: () => ({ status: 'open', queued: true }), now: () => 0,
  });
  const facts = read({ pr: 5017, item: '', repo: base.repo });
  expect(facts.pr.number).toBe(5017); expect(facts.checks[0].conclusion).toBe('SUCCESS');
  expect(facts.gaps).toContainEqual({ source: 'build holds', error: 'offline' });
  expect(facts.logs.find(l => l.name === 'fix').line).toContain('#5017');
  expect(read({ pr: 0, item: '5754', repo: base.repo }).card.queued).toBe(true);
});

it('keeps the screen bounded while retaining all structured evidence and gaps', () => {
  const facts = { ...base, checks: Array.from({ length: 20 }, (_, i) => ({ name: `check${i}`, conclusion: 'success' })), logs: Array.from({ length: 30 }, (_, i) => ({ name: `daemon${i}`, line: 'observed' })), gaps: Array.from({ length: 20 }, (_, i) => ({ source: `read${i}`, error: 'unavailable' })) };
  const out = explainWhy(facts);
  expect(out.screen.split('\n').length).toBeLessThanOrEqual(40);
  expect(out.sections.find(s => s.name === 'daemons').lines).toHaveLength(30);
  expect(out.screen).toContain('more gaps (see --json)');
});
it('does not claim CI is green when required checks are unreadable', () => {
  expect(explainWhy({ ...base, pr: { labels: ['ready-to-merge'] }, checksUnavailable: true }).waitingFor).toBe('required checks unavailable');
});
it('reads daemon paths from plists, binds both claim kinds, and catches individual read failures', () => {
  const read = createWhyReader({
    run: () => JSON.stringify({ number: 5017, state: 'OPEN', labels: [], headRefOid: 'sha' }),
    readComments: () => { throw new Error('comments offline'); }, readRequiredChecks: () => ['unit'],
    readChecks: () => { throw new Error('checks offline'); }, listPrs: () => [],
    listFiles: () => ['pass-daemon.recovery.log'], listPlists: () => ['com.we.fix'],
    readPlist: () => ({ ProgramArguments: ['node', '/scripts/reconcile-fix-dispatch-daemon.mjs'], StandardOutPath: '/declared/fix.log' }),
    tail: path => { if (path === '/declared/fix.log') return { text: 'date #5017 skipped: held' }; throw new Error('tail offline'); },
    readClaims: () => ['fix', 'ci-heal'].map(kind => ({ meta: { repo: 'we', pr: 5017, kind, who: kind === 'fix' ? 'worker' : 'gone' } })),
    readAgents: () => [{ name: 'worker', state: 'working' }], readBuildHolds: () => [], readBackoffs: () => [],
    readPrepareFailures: () => { throw new Error('ledger corrupt'); }, now: () => 0,
  });
  const facts = read({ pr: 5017, repo: base.repo });
  expect(facts.claims.map(c => c.live)).toEqual([true, false]);
  expect(facts.logs.find(l => l.name === 'fix').path).toBe('/declared/fix.log');
  expect(facts.logs.find(l => l.name === 'fix').line).toBe('date #5017 skipped: held');
  expect(facts.gaps.map(g => g.source)).toEqual(expect.arrayContaining(['comments', 'head checks', 'prepare failures', 'log review']));
});

it('reads real cards and bounded log tails without changing a corrupt failure ledger', async () => {
  await withRealRepo(async ({ root, git }) => {
    const coordinationRoot = join(root, 'coordination');
    const cardPath = join(root, 'backlog', '5754-fixture.md');
    const logPath = join(coordinationRoot, 'build-dispatch-daemon.log');
    const failurePath = join(coordinationRoot, 'prepare-failures.json');
    mkdirSync(join(root, 'backlog'), { recursive: true }); mkdirSync(coordinationRoot);
    writeFileSync(cardPath, '---\nstatus: open\nkind: story\n---\n# fixture\n');
    writeFileSync(logPath, '#5754 outside tail\n' + 'x'.repeat(600 * 1024) + '\n2026-10-13 #5754 builder waiting\n');
    writeFileSync(failurePath, '{corrupt');
    const before = git(['status', '--porcelain', '--untracked-files=all']);
    const read = createWhyReader({ root, home: root, coordinationRoot, listPrs: () => [], readClaims: () => [], readBuildHolds: () => [], readBackoffs: () => [] });
    const facts = read({ item: '5754', repo: base.repo });
    expect(facts.card.status).toBe('open'); expect(facts.card.type).toBe('story');
    expect(facts.logs.find(l => l.name === 'builder').line).toBe('2026-10-13 #5754 builder waiting');
    expect(facts.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'prepare failures' })]));
    expect(readFileSync(failurePath, 'utf8')).toBe('{corrupt');
    expect(readdirSync(coordinationRoot).sort()).toEqual(['build-dispatch-daemon.log', 'prepare-failures.json']);
    expect(git(['status', '--porcelain', '--untracked-files=all'])).toBe(before);
  });
});

it('builder last mention skips JSON timing summaries', () => {
  expect(lastMentionLine('5754 parked: prepare failure\n{"timings":{"item":5754}}', { kind: 'item', id: '5754' })).toBe('5754 parked: prepare failure');
});

it('prepare holds suggest the real retry-prepare control', () => {
  const result = explainWhy({ subject: { kind: 'item', id: '7' }, repo: 'web-everything/web-everything', buildHolds: [{ reason: 'prepare-unstamped' }] });
  expect(result.suggestedOp).toContain('retry-prepare --preview');
  expect(result.screen).toContain('owner:');
  expect(result.screen).toContain('waiting for:');
  expect(result.screen).not.toContain('ownerWhy');
});

describe('why red-team evidence and recent comments', () => {
  const head = 'a'.repeat(40), oldHead = 'b'.repeat(40);
  function fixture(fn) {
    const root = mkdtempSync(join(tmpdir(), 'operator-why-'));
    const env = { WE_SHARED_RUNS_DIR: join(root, 'runs') };
    const statusPath = rev => join(redTeamStatusDir(env), `${encodeURIComponent(base.repo)}-5017-${rev}.json`);
    const save = (rev, status = 'done', result = 'ran', at = 1000) => {
      recordRedTeamStatus({ repo: base.repo, pr: 5017, loopPayload: { findings: { read: { netBasis: { rev } } } }, status, result }, { env, readPidStart: () => null });
      utimesSync(statusPath(rev), at / 1000, at / 1000);
    };
    const read = (options = {}) => createWhyReader({
      root, home: root, coordinationRoot: root, env,
      run: () => JSON.stringify({ ...base.pr, number: 5017, headRefOid: head, labels: ['ready-to-merge', 'red-team:pending'] }),
      readComments: () => [], readRequiredChecks: () => [], readChecks: () => [],
      listPlists: () => [], tail: () => ({ text: '' }), listPrs: () => [],
      readClaims: () => [], readBuildHolds: () => [], readBackoffs: () => [], readPrepareFailures: () => ({ failures: {} }),
      ...options,
    })({ pr: 5017, repo: base.repo });
    try { fn({ read, save, statusPath }); } finally { rmSync(root, { recursive: true, force: true }); }
  }

  it('reads the writer format and prefers the live head even when an older head was updated later', () => fixture(({ read, save }) => {
    save(head); save(oldHead, 'running', null, 2000);
    const facts = read();
    expect(facts.redTeam).toEqual({ head, state: 'done', verdict: 'ran', updatedAt: '1970-01-01T00:00:01.000Z', isLiveHead: true });
    const out = explainWhy(facts);
    expect(out.waitingFor).toBe('merge queue position unknown');
    expect(out.screen).toContain(`red team: done; verdict=ran; head=${head}; live=true; updated=`);
    expect(out.screen).toContain('recent:\n  —');
  }));

  it('reports the latest older-head record and explains a pending live-head result', () => fixture(({ read, save }) => {
    save('c'.repeat(40), 'queued', null, 500); save(oldHead);
    const facts = read();
    expect(facts.redTeam.head).toBe(oldHead);
    expect(facts.redTeam.isLiveHead).toBe(false);
    expect(explainWhy(facts).waitingFor).toBe('merge queue position unknown');
    expect(explainWhy(facts).redTeamWaitingFor).toBe(`red team (no result for live head ${head.slice(0, 9)})`);
  }));

  it('returns null and a reason for a missing directory without throwing', () => fixture(({ read }) => {
    const facts = read();
    expect(facts.redTeam).toBeNull();
    expect(facts.gaps).toContainEqual({ source: 'red team', error: expect.stringContaining('ENOENT') });
    expect(explainWhy(facts).waitingFor).toBe('merge queue position unknown');
    expect(explainWhy(facts).redTeamWaitingFor).toContain('no result for live head');
  }));

  it('returns null with a reason for an empty directory, corrupt record, mismatched identity or unreadable record', () => fixture(({ read, save, statusPath }) => {
    save(head);
    expect(read({ listFiles: () => [] }).redTeam).toBeNull();
    for (const body of ['{corrupt', JSON.stringify({ repo: 'another/repo', pr: 5017, head, status: 'done' })]) {
      writeFileSync(statusPath(head), body);
      const facts = read();
      expect(facts.redTeam).toBeNull();
      expect(facts.gaps).toContainEqual({ source: 'red team', error: expect.any(String) });
    }
    const facts = read({ readText: () => { throw new Error('unreadable'); } });
    expect(facts.redTeam).toBeNull();
    expect(facts.gaps).toContainEqual({ source: 'red team', error: 'unreadable' });
  }));

  it('retains valid history when another candidate is corrupt, invalid or unreadable', () => fixture(({ read, save, statusPath }) => {
    const badHead = 'c'.repeat(40);
    save(oldHead); save(badHead, 'running', null, 2000);
    for (const body of ['{corrupt', JSON.stringify({ repo: 'wrong/repo', pr: 5017, head: badHead, status: 'done' })]) {
      writeFileSync(statusPath(badHead), body);
      const facts = read();
      expect(facts.redTeam.head).toBe(oldHead);
      expect(facts.gaps).toContainEqual({ source: 'red team', error: expect.any(String) });
    }
    for (const options of [
      { readText: path => { if (path === statusPath(badHead)) throw new Error('record unreadable'); return readFileSync(path, 'utf8'); } },
      { readStat: path => { if (path === statusPath(badHead)) throw new Error('stat unreadable'); return { mtimeMs: 1000 }; } },
    ]) {
      const facts = read(options);
      expect(facts.redTeam.head).toBe(oldHead);
      expect(facts.gaps).toContainEqual({ source: 'red team', error: expect.stringContaining('unreadable') });
    }
  }));

  it('sanitizes hostile comment previews before truncation and renders one safe line', () => fixture(({ read }) => {
    const hostile = '\x1b[2J\x1b[H\x9b31m' + ' '.repeat(300)
      + 'safe\twords\u2028next\u2029line\x00\x07\x7f\x80\x9f'
      + '\x1b]0;spoofed title\x07\x9dhidden title\x9c\u00a0end';
    const body = hostile;
    const facts = read({ readComments: () => [{ createdAt: 'today', author: { login: 'guest' }, body }] });
    expect(facts.recentComments[0].body).toBe('safe words next line end');
    const screen = explainWhy(facts).screen;
    expect(screen).toContain('recent:\n  today guest: safe words next line end');
    expect(screen).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/);
    expect(screen).not.toContain('spoofed title');
    expect(screen).not.toContain('hidden title');
  }));

  it('reuses the comments read, strips multiline HTML comments and truncates the last three previews', () => fixture(({ read }) => {
    let calls = 0;
    const comments = [
      { body: 'older' },
      { createdAt: '2026-10-21T01:00:00Z', author: { login: 'operator' }, body: 'gate\n<!-- hidden\nmarker -->paused\r\nnext' },
      { createdAt: '2026-10-21T02:00:00Z', author: { login: 'bot' }, body: '<!-- marker -->' + 'x'.repeat(300) },
      { createdAt: '2026-10-21T03:00:00Z', body: 'last<!-- unfinished\nhidden' },
    ];
    const facts = read({ readComments: () => { calls++; return comments; } });
    expect(calls).toBe(1);
    expect(facts.pr.comments).toBe(comments);
    expect(facts.recentComments).toEqual([
      { createdAt: comments[1].createdAt, author: 'operator', body: 'gate paused next' },
      { createdAt: comments[2].createdAt, author: 'bot', body: 'x'.repeat(260) },
      { createdAt: comments[3].createdAt, author: null, body: 'last' },
    ]);
    expect(explainWhy(facts).screen).toContain('recent:\n  2026-10-21T01:00:00Z operator: gate paused next');
  }));

  for (const label of ['red-team:pending', 'red-team:blocked']) it(`explains missing evidence for ${label}`, () => {
    expect(explainWhy({ ...base, pr: { labels: [{ name: label }], headRefOid: head }, redTeam: null }).waitingFor)
      .toBe(`red team (no result for live head ${head.slice(0, 9)})`);
  });
  it('surfaces missing red-team evidence alongside other holds but preserves the closed rule', () => {
    const pr = { state: 'OPEN', labels: ['review:pending', 'red-team:pending'], headRefOid: head };
    expect(explainWhy({ ...base, pr }).waitingFor).toBe('review');
    expect(explainWhy({ ...base, pr }).redTeamWaitingFor).toContain('no result for live head');
    expect(explainWhy({ ...base, pr: { ...pr, state: 'MERGED' } }).waitingFor).toBe('nothing (closed)');
  });
  it('keeps the existing rules when the label is clear or a live-head record exists', () => {
    for (const extra of [
      { pr: { labels: ['ready-to-merge', 'red-team:clear'] }, redTeam: null },
      { pr: { labels: ['ready-to-merge', 'red-team:pending'] }, redTeam: { isLiveHead: true } },
    ]) expect(explainWhy({ ...base, ...extra }).waitingFor).toBe('merge queue position unknown');
  });
});
