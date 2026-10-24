// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { countConsecutiveFailedChecksEjections as countEvidence, planEjectLoop, readEjectionHistory, readFailingMergeGroupLog, routeEjectLoopToCiHeal } from '../merge-queue-eject-loop.mjs';
const headSha = 'b'.repeat(40);
const groupSha = 'a'.repeat(40);
const date = '2026-10-24T00:00:00Z';
const count = countEvidence;
const removal = (reason = 'failed_checks', createdAt = date) => ({ __typename: 'RemovedFromMergeQueueEvent', onHead: true, reason, createdAt, beforeCommit: { oid: groupSha } });
describe('merge queue ejection loop', () => {
  it('counts two consecutive same-head failures, ignoring Added events', () => {
    expect(count({ headSha, events: [removal(), removal()] }).count).toBe(2);
    expect(count({ headSha, events: [removal(), { __typename: 'AddedToMergeQueueEvent', createdAt: date }, removal('CI_FAILURE')] }).count).toBe(2);
  });
  it('other-reason removals reset the run', () => {
    expect(count({ headSha, events: [removal(), removal('merge conflict'), removal('checks failed')] }).count).toBe(1);
  });
  it('unproven removals end the run and dates do not establish identity', () => {
    expect(count({ events: [removal(), { ...removal(), onHead: undefined }, removal()] }).count).toBe(1);
    expect(count({ events: [removal(), { ...removal(), onHead: false }] }).count).toBe(0);
    expect(count({ events: [removal('failed_checks', 'garbage')] })).toMatchObject({ count: 1, since: null });
  });
  it('plans the threshold and credits routing only for this head', () => {
    expect(planEjectLoop({ count: 1, state: {}, headSha })).toEqual({ loop: false, alreadyRouted: false });
    expect(planEjectLoop({ count: 2, state: { headSha, routedAt: 0 }, headSha })).toEqual({ loop: true, alreadyRouted: true });
    expect(planEjectLoop({ count: 2, state: { headSha: 'old', routedAt: 1 }, headSha })).toEqual({ loop: true, alreadyRouted: false });
    expect(planEjectLoop({ count: 2, threshold: 0, state: {}, headSha }).loop).toBe(false);
    expect(planEjectLoop({ count: 2, threshold: 3, state: {}, headSha }).loop).toBe(false);
  });
  it('reads bounded history and refuses a mismatched head or malformed response', () => {
    const payload = { data: { repository: { pullRequest: { timelineItems: { nodes: [removal()] }, commits: { nodes: [{ commit: { oid: headSha, committedDate: date } }] } } } } };
    const exec = (cmd, args, opts) => {
      expect(cmd).toBe('gh'); expect(args.join(' ')).toContain('timelineItems(last:20');
      expect(opts.timeout).toBeGreaterThan(0); expect(opts.maxBuffer).toBeGreaterThan(0); expect(opts.shell).not.toBe(true);
      return JSON.stringify(payload);
    };
    expect(readEjectionHistory({ repo: 'o/r', num: 42, headSha, exec, readParents: () => [headSha] })).toMatchObject({ ok: true, events: [removal()] });
    expect(readEjectionHistory({ repo: 'o/r', num: 42, headSha: 'old', exec }).ok).toBe(false);
    payload.data.repository.pullRequest.timelineItems.nodes = [{ ...removal(), beforeCommit: null }];
    expect(readEjectionHistory({ repo: 'o/r', num: 42, headSha, exec })).toMatchObject({ ok: true, events: [], unattributable: true });
    for (const out of ['bad', '{}', '{"errors":[{}]}']) expect(readEjectionHistory({ repo: 'o/r', num: 42, headSha, exec: () => out }).ok).toBe(false);
  });
  it('selects the latest matching failed run and strips ANSI, redacts secrets and caps logs', () => {
    const exec = (_cmd, args) => {
      if (args[0] === 'run') return JSON.stringify([
        { databaseId: 1, headSha: groupSha, conclusion: 'failure', createdAt: '2026-10-23T00:00:00Z' },
        { databaseId: 2, headSha: groupSha, conclusion: 'failure', createdAt: date },
        { databaseId: 3, headSha: 'unrelated', conclusion: 'failure', createdAt: date },
      ]);
      if (args[1].includes('/jobs?')) { expect(args[1]).toContain('/runs/2/'); return JSON.stringify({ jobs: [{ id: 9, name: 'unit', conclusion: 'failure' }] }); }
      return '\u001b[31mFAIL assertion\u001b[0m\npassword=super-secret\n' + 'error detail\n'.repeat(1000);
    };
    const r = readFailingMergeGroupLog({ repo: 'o/r', num: 42, oids: [groupSha], exec, maxChars: 100 });
    expect(r).toMatchObject({ check: 'unit', job: 'unit', runId: 2 });
    expect(r.excerpt.length).toBeLessThanOrEqual(100); expect(r.excerpt).not.toContain('\u001b'); expect(r.excerpt).not.toContain('super-secret');
    expect(readFailingMergeGroupLog({ repo: 'o/r', num: 42, oids: [groupSha], exec: () => { throw Error('offline'); } })).toEqual({ unreadable: true });
  });
  it('routes with argv and a body file containing a marker and safely fenced untrusted logs', () => {
    const calls = []; let body;
    routeEjectLoopToCiHeal({ repo: 'o/r', num: 42, headSha, count: 2, failing: { check: 'unit', excerpt: 'FAIL `$(touch nope)`\n```\nerror' }, exec: (cmd, args, opts) => {
      calls.push([cmd, args]); expect(opts.shell).not.toBe(true);
      if (args.includes('--body-file')) body = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
      return '';
    } });
    expect(calls).toHaveLength(2);
    expect(calls.some(([cmd, a]) => cmd === 'gh' && a.includes('--add-label') && a.includes('ci:failed'))).toBe(true);
    expect(body).toContain(`<!-- merge-queue-eject-loop head=${headSha} -->`); expect(body).toContain('unit'); expect(body).toContain('2'); expect(body).toMatch(/`{4,}text/); expect(body).toContain('untrusted');
    expect(body).toContain('Labelled ci:failed with the failing merge-group log for CI-heal / fixers; PR-head checks may be green, so a person should confirm pickup');
    expect(body).not.toContain('routing to CI-heal');
  });
});

describe('bounded and unreadable ejection evidence', () => {
  it('an unreadable or oversized history fails open without throwing', () => {
    for (const error of [new Error('offline'), Object.assign(new Error('maxBuffer exceeded'), { code: 'ENOBUFS' })]) {
      expect(readEjectionHistory({ repo: 'o/r', num: 42, headSha, exec: () => { throw error; } })).toEqual({ ok: false });
    }
  });
  it('keeps error context and redacts credentials before cutting the excerpt', () => {
    const exec = (_cmd, args, opts) => {
      expect(opts.timeout).toBeGreaterThan(0); expect(opts.maxBuffer).toBeGreaterThan(0);
      if (args[0] === 'run') return JSON.stringify([{ databaseId: 1, headSha: groupSha, conclusion: 'failure', createdAt: date }]);
      if (args[1].includes('/jobs?')) return JSON.stringify({ jobs: [{ id: 2, name: 'unit', conclusion: 'failure' }] });
      return 'irrelevant\ncontext before\n\u001b[31mFAIL ghp_abcdefghijklmnopqrstuvwxyz123456\u001b[0m\ncontext after\nignored';
    };
    const r = readFailingMergeGroupLog({ repo: 'o/r', num: 42, oids: [groupSha], exec });
    expect(r.excerpt).not.toContain('context before'); expect(r.excerpt).toContain('context after'); expect(r.excerpt).toContain('FAIL [redacted]');
    expect(r.excerpt).not.toContain('irrelevant'); expect(r.excerpt).not.toContain('abcdefghijklmnopqrstuvwxyz'); expect(r.excerpt).not.toContain('\u001b');
    const short = readFailingMergeGroupLog({ repo: 'o/r', num: 42, oids: [groupSha], exec, maxChars: 35 });
    expect(short.excerpt.length).toBeLessThanOrEqual(35); expect(short.excerpt).not.toContain('ghp_');
  });
  it('missing jobs and oversized logs return unreadable diagnostics', () => {
    const run = JSON.stringify([{ databaseId: 1, headSha: groupSha, conclusion: 'failure', createdAt: date }]);
    for (const jobs of [[], [{ id: 2, name: 'unit', conclusion: 'failure' }]]) {
      expect(readFailingMergeGroupLog({ repo: 'o/r', num: 42, oids: [groupSha], exec: (_cmd, args) => {
        if (args[0] === 'run') return run;
        if (args[1].includes('/jobs?')) return JSON.stringify({ jobs });
        throw Object.assign(Error('maxBuffer exceeded'), { code: 'ENOBUFS' });
      } })).toEqual({ unreadable: true });
    }
  });
  it('label failure is propagated before posting any comment', () => {
    const calls = [];
    expect(() => routeEjectLoopToCiHeal({ repo: 'o/r', num: 42, headSha, count: 2, exec: (_cmd, args) => {
      calls.push(args); throw Error('offline');
    } })).toThrow('offline');
    expect(calls).toHaveLength(1); expect(calls[0]).toContain('--add-label');
  });
});

describe('failure log excerpts', () => {
  const indented = lines => lines.map(line => `    ${line}`).join('\n');
  const excerpt = (lines, maxChars) => readFailingMergeGroupLog({ repo: 'o/r', num: 42, oids: [groupSha], maxChars,
    exec: (_cmd, args) => {
      if (args[0] === 'run') return JSON.stringify([{ databaseId: 1, headSha: groupSha, conclusion: 'failure', createdAt: date }]);
      if (args[1].includes('/jobs?')) return JSON.stringify({ jobs: [{ id: 2, name: 'unit', conclusion: 'failure' }] });
      return lines.map(line => `2026-10-24T17:07:00.1Z ${line}`).join('\n');
    },
  }).excerpt;

  it.each([false, true])('strips every timestamp before redacting spaced password values (diagnostic match: %s)', diagnostic => {
    const lines = [...(diagnostic ? ['FAIL credential test'] : []), 'password: example-secret-value', 'next line'];
    const result = excerpt(lines);
    expect(result).toContain('password=[redacted]');
    expect(result).toContain('next line');
    expect(result).not.toContain('example-secret-value');
    expect(result).not.toContain('2026-10-24T');
    expect(excerpt(lines, 35)).toBe(result.slice(0, 35));
  });

  it('redacts a credential split across timestamped lines before selecting the excerpt', () => {
    const result = excerpt(['password:', 'example-secret-value', 'next line']);
    expect(result).toContain('password=[redacted]');
    expect(result).not.toContain('example-secret-value');
    expect(result).not.toContain('2026-10-24T');
  });

  it('excludes noisy fail branch names and keeps the Vitest FAIL and AssertionError block', () => {
    const block = ['\u001b[31m FAIL \u001b[0m scripts/lib/example.test.mjs > reads evidence',
      'AssertionError: expected false to be true', 'Expected: true', 'Received: false',
      ' ❯ scripts/lib/example.test.mjs:12:3', '     12| expect(result).toBe(true)', '       |                ^', ''];
    const result = excerpt([' * [new branch] lane/read-failclosed -> origin/lane/read-failclosed',
      ' * [new branch] lane/failure-error -> origin/lane/failure-error', 'checkout complete', ...block, 'noise after context']);
    expect(result).toBe(indented(block).replace(/\u001b\[\d+m/g, ''));
    expect(result).not.toContain('[new branch]');
    expect(result).not.toContain('2026-10-24T');
  });

  it('keeps six following lines for only the first three hits and deduplicates overlapping context', () => {
    const lines = ['FAIL first', 'AssertionError: second', ...Array.from({ length: 7 }, (_, i) => `context ${i}`),
      'TypeError: third', ...Array.from({ length: 7 }, (_, i) => `third context ${i}`), 'FAIL fourth', 'excluded'];
    expect(excerpt(lines)).toBe(indented([...lines.slice(0, 8), ...lines.slice(9, 16)]));
    expect(excerpt(lines, 35)).toBe(excerpt(lines).slice(0, 35));
  });

  it.each(['Error: failed', '##[error]failed', '  expected value to equal true'])('recognizes the diagnostic marker %s', marker => {
    expect(excerpt(['noise', marker, 'detail'])).toBe(indented([marker, 'detail']));
  });

  it('falls back to the last fifteen lines when no diagnostic matches and applies maxChars', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `checkout line ${i}`);
    lines[0] = ' * [new branch] lane/read-failclosed -> origin/lane/read-failclosed';
    const tail = indented(lines.slice(-15));
    expect(excerpt(lines)).toBe(tail);
    expect(excerpt(lines, 35)).toBe(tail.slice(0, 35));
  });
});

const readHistory = (events, readParents, extra = {}) => readEjectionHistory({ repo: 'o/r', num: 42, headSha,
  exec: () => JSON.stringify({ data: { repository: { pullRequest: {
    commits: { nodes: [{ commit: { oid: headSha, committedDate: '2000-01-01T00:00:00Z' } }] },
    timelineItems: { nodes: events.map(({ onHead, ...event }) => event) },
  } } } }), readParents, ...extra });

describe('ejection head identity', () => {
  it('counts merge-group commits whose parents include the PR head and retains log OIDs', () => {
    const history = readHistory([removal(), { __typename: 'AddedToMergeQueueEvent' }, removal()], () => ['base', headSha]);
    expect(history.events).toEqual([removal(), removal()]);
    expect(count(history)).toEqual({ count: 2, unattributable: false, oids: [groupSha, groupSha], since: '2026-10-24T00:00:00.000Z' });
  });
  it('looks up parents with bounded argv execution', () => {
    const calls = [];
    const history = readHistory([removal()], undefined, { exec: (cmd, args, opts) => {
      calls.push(args);
      expect(cmd).toBe('gh'); expect(opts.timeout).toBeGreaterThan(0); expect(opts.maxBuffer).toBeGreaterThan(0); expect(opts.shell).not.toBe(true);
      if (args[1] !== 'graphql') {
        expect(args).toEqual(['api', `repos/o/r/commits/${groupSha}`, '--jq', '[.parents[].sha]']);
        return JSON.stringify(['base', headSha]);
      }
      return JSON.stringify({ data: { repository: { pullRequest: { commits: { nodes: [{ commit: { oid: headSha } }] }, timelineItems: { nodes: [removal()] } } } } });
    } });
    expect(count(history).count).toBe(1); expect(calls).toHaveLength(2);
  });
  it('stops at an older head without looking past it, newest to oldest', () => {
    const events = ['oldest', 'older', 'newest'].map(oid => ({ ...removal(), beforeCommit: { oid } }));
    const calls = [];
    const history = readHistory(events, ({ oid }) => { calls.push(oid); return oid === 'newest' ? [headSha] : ['old-head']; });
    expect(calls).toEqual(['newest', 'older']);
    expect(count(history)).toMatchObject({ count: 1, unattributable: false, oids: ['newest'] });
  });
  it('a newly pushed commit with an old date never inherits old-head ejections', () => {
    expect(count(readHistory([removal(), removal()], () => ['old-head']))).toMatchObject({ count: 0, unattributable: false });
  });
  it.each([null, undefined, {}, [''], [null], 'bad'])('older unreadable parents %j preserve the proven suffix', parents => {
    let calls = 0;
    const history = readHistory([removal(), removal(), removal()], () => ++calls === 1 ? [headSha] : parents);
    expect(calls).toBe(2);
    expect(history.events).toEqual([removal()]);
    expect(count(history)).toMatchObject({ count: 1, unattributable: false });
  });
  it('an older lookup failure preserves the newest two proven events and reaches threshold two', () => {
    const events = ['oldest', 'older', 'newest'].map(oid => ({ ...removal(), beforeCommit: { oid } }));
    const calls = [];
    const history = readHistory(events, ({ oid }) => {
      calls.push(oid);
      if (oid === 'oldest') throw Error('offline');
      return [headSha];
    });
    expect(calls).toEqual(['newest', 'older', 'oldest']);
    expect(history).toMatchObject({ ok: true, events: events.slice(1), unattributable: false });
    expect(count(history)).toMatchObject({ count: 2, unattributable: false, oids: ['older', 'newest'] });
    expect(planEjectLoop({ count: count(history).count, threshold: 2 }).loop).toBe(true);
  });
  it('an older missing OID preserves the proven suffix without a lookup', () => {
    let calls = 0;
    const history = readHistory([{ ...removal(), beforeCommit: null }, removal()], () => { calls++; return [headSha]; });
    expect(calls).toBe(1);
    expect(count(history)).toMatchObject({ count: 1, unattributable: false });
  });
  it.each([null, undefined, {}, [''], [null], 'bad'])('newest unreadable parents %j remain unattributable', parents => {
    expect(count(readHistory([removal()], () => parents))).toMatchObject({ count: 0, unattributable: true });
  });
  it('a lookup failure stops the run and marks history unattributable', () => {
    let calls = 0;
    const history = readHistory([removal(), removal()], () => { calls++; throw Error('offline'); });
    expect(calls).toBe(1); expect(history.events).toEqual([]);
    expect(count(history)).toMatchObject({ count: 0, unattributable: true });
  });
  it('missing OIDs are unattributable and never looked up', () => {
    const history = readHistory([removal(), { ...removal(), beforeCommit: null }], () => { throw Error('must not call'); });
    expect(count(history)).toMatchObject({ count: 0, unattributable: true });
  });
  it('bounds oversized history to eight proven events and lookups', () => {
    let calls = 0;
    const history = readHistory(Array(20).fill(removal()), () => { calls++; return [headSha]; });
    expect(calls).toBe(8); expect(count(history)).toMatchObject({ count: 8, unattributable: false });
  });
  it('other-reason removals end parent lookups while Added events are ignored', () => {
    let calls = 0;
    const history = readHistory([removal(), removal('merge conflict'), { __typename: 'AddedToMergeQueueEvent' }, removal()], () => { calls++; return [headSha]; });
    expect(calls).toBe(1); expect(count(history).count).toBe(1);
  });
  it.each([undefined, null, '', 'garbage', '2099-01-01T00:00:00Z'])('commit time %j never affects proven identity', headCommittedAt => {
    expect(count({ headCommittedAt, events: [removal(), removal()] }).count).toBe(2);
  });
});

describe('audit head and log bounds', () => {
  it('ignores an older-head failed run and reports the log as unreadable in the comment', () => {
    const calls = [];
    const failing = readFailingMergeGroupLog({ repo: 'o/r', num: 42, oids: [groupSha], exec: (_cmd, args) => {
      calls.push(args);
      return JSON.stringify([{ databaseId: 1, headSha: 'unrelated', conclusion: 'failure', createdAt: '2026-10-23T23:49:59Z' }]);
    } });
    expect(failing).toEqual({ unreadable: true });
    expect(calls).toHaveLength(1);
    let body;
    routeEjectLoopToCiHeal({ repo: 'o/r', num: 42, headSha, count: 2, failing, exec: (_cmd, args) => {
      if (args.includes('--body-file')) body = readFileSync(args.at(-1), 'utf8');
    } });
    expect(body).toContain('Merge-group log unreadable');
    expect(body).toContain(`<!-- merge-queue-eject-loop head=${headSha} -->`);
  });
  it('uses only counted merge-group SHAs, newest first, without a time window', () => {
    const exec = (_cmd, args) => {
      if (args[0] === 'run') {
        expect(args).toContain('merge_group'); expect(args.at(-1)).toContain('headSha');
        return JSON.stringify([
          { databaseId: 1, headSha: groupSha, conclusion: 'failure', createdAt: date },
          { databaseId: 2, headSha: groupSha, conclusion: 'failure', createdAt: '2026-10-23T00:00:00Z' },
          { databaseId: 3, headSha: 'unrelated', conclusion: 'failure', createdAt: '2026-10-25T00:00:00Z' },
          { databaseId: 4, headSha: groupSha, conclusion: 'success', createdAt: '2026-10-25T00:00:00Z' },
        ]);
      }
      if (args[1].includes('/jobs?')) { expect(args[1]).toContain('/runs/1/'); return JSON.stringify({ jobs: [{ id: 3, name: 'unit', conclusion: 'failure' }] }); }
      return 'FAIL test';
    };
    expect(readFailingMergeGroupLog({ repo: 'o/r', num: 42, oids: [groupSha], exec })).toMatchObject({ runId: 1 });
    expect(readFailingMergeGroupLog({ repo: 'o/r', num: 42, oids: ['missing'], exec })).toEqual({ unreadable: true });
  });
  it('missing or malformed oids refuses log lookup', () => {
    let calls = 0;
    for (const oids of [undefined, null, 'garbage', [], [null]]) {
      expect(readFailingMergeGroupLog({ repo: 'o/r', num: 42, oids, exec: () => { calls++; throw Error('must not read'); } })).toEqual({ unreadable: true });
    }
    expect(calls).toBe(0);
  });
});

describe('parent attribution evidence', () => {
  it('marks missing event history unattributable', () => {
    expect(count({})).toEqual({ count: 0, unattributable: true, oids: [], since: null });
  });
  it('returns only trailing counted OIDs and the earliest valid event timestamp', () => {
    expect(count({ events: [removal(), removal('merge conflict'),
      removal(), removal('failed_checks', '2026-10-24T00:01:00Z')] }))
      .toEqual({ count: 2, unattributable: false, oids: [groupSha, groupSha], since: '2026-10-24T00:00:00.000Z' });
  });
});
