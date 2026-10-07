/**
 * @file scripts/operations/__tests__/agent-activity-io-real.test.mjs
 * @description backlog #3932 — the fidelity qualifier (#2949, motivated by #3264): `agent-activity-io.mjs`'s
 * real reads (a subprocess shell-out, and real directory/file enumeration under a project-slug tree) proved
 * against REAL processes and a REAL directory tree, not the injected doubles `agent-activity.test.mjs` uses
 * for the pure resolver. An injected `run`/`readFileSync` stub has no clone geometry and no directory tree —
 * see `heavy-queue-io-real.test.mjs`'s header for the shipped bug (#3264) this discipline exists to catch.
 */
import { mkdirSync, writeFileSync, utimesSync, openSync, writeSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { it, expect } from 'vitest';
import { withRealRepo } from './helpers/real-repo.mjs';
import {
  readLaneLeases, indexLeasesBySession, codexThreadRows, subagentRowsFor, claimedNumsFromTranscript,
  RECENT_MS, leasesFromLanePoolStatus, firstMessageText, interactiveRows, projectSlugFor, createAgentActivityReader,
} from '../agent-activity-io.mjs';
import { resolveAgentActivity } from '../agent-activity.mjs';

function assistantLine(toolCalls) {
  return JSON.stringify({ type: 'assistant', message: { content: toolCalls } });
}
function userLine(text) {
  return JSON.stringify({ type: 'user', message: { content: text } });
}

it('readLaneLeases shells out to a REAL `<root>/scripts/lane-pool.mjs status --json` child process and parses its real stdout', async () => {
  await withRealRepo(async ({ root }) => {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    // A real, tiny, real Node script — genuinely spawned by `execFileSync`, not an injected function.
    writeFileSync(join(root, 'scripts', 'lane-pool.mjs'),
      "process.stdout.write(JSON.stringify({ lanes: [{ lane: 1, lease: { purpose: 'build-3932', ownerSession: 'op-1', workerSession: 'op-1' } }, { lane: 2, lease: null }] }));\n");
    const leases = readLaneLeases({ run: execFileSync, root });
    expect(leases).toMatchObject([{ purpose: 'build-3932', ownerSession: 'op-1', workerSession: 'op-1' }]);
    expect(indexLeasesBySession(leases).get('op-1')).toMatchObject({ purpose: 'build-3932' });
  });
});

it('readLaneLeases fails soft (empty array, never throws) when the real child process exits non-zero', async () => {
  await withRealRepo(async ({ root }) => {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'lane-pool.mjs'), "process.exit(1);\n");
    expect(readLaneLeases({ run: execFileSync, root })).toEqual([]);
  });
});

it('codexThreadRows reads REAL `.operations/codex-delivery-threads/*.json` files off a real directory tree', async () => {
  await withRealRepo(async ({ root }) => {
    const dir = join(root, '.operations', 'codex-delivery-threads');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'conveyor-3445.json'), JSON.stringify({ sessionSlug: 'conveyor-3445', threadId: 'th_real1', at: '2026-09-26T10:00:00.000Z' }));
    // A corrupt/partial record must be skipped, not thrown on — real disk state includes half-written files.
    writeFileSync(join(dir, 'broken.json'), '{ not json');
    const rows = codexThreadRows(root, { codexHome: join(root, 'codex') });
    expect(rows).toEqual([{
      id: 'codex-th_real1', sessionId: null, runtime: 'codex', kind: 'codex', codexSlug: 'conveyor-3445',
      cwd: null, state: null, startedAt: Date.parse('2026-09-26T10:00:00.000Z'), lastEventAt: null,
      transcriptPath: null, lastActivityMs: null,
    }]);
  });
});

it('codexThreadRows returns [] for a real root with no codex-delivery-threads directory at all', async () => {
  await withRealRepo(async ({ root }) => { expect(codexThreadRows(root)).toEqual([]); });
});

it('subagentRowsFor + firstMessageText read a REAL `<projects>/<slug>/<sessionId>/subagents/` tree — plain and workflow-lane children', async () => {
  await withRealRepo(async ({ root }) => {
    const cwd = '/Users/fixture/workspace/some-lane';
    const slug = projectSlugFor(cwd);
    const sessionDir = join(root, 'projects', slug, 'parent-session-1');
    const plainDir = join(sessionDir, 'subagents');
    mkdirSync(plainDir, { recursive: true });
    writeFileSync(join(plainDir, 'agent-a111.jsonl'), `${userLine('go read the file')}\n${assistantLine([{ type: 'text', text: 'ok' }])}\n`);

    const wfDir = join(plainDir, 'workflows', 'wf_run1');
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, 'agent-a222.jsonl'), `${userLine('verify:#3444 please proceed')}\n`);

    const rows = subagentRowsFor('parent-session-1', cwd, join(root, 'projects'));
    expect(rows).toHaveLength(2);
    const plain = rows.find((r) => r.id.endsWith('agent-a111.jsonl'));
    expect(plain).toMatchObject({ parentSessionId: 'parent-session-1', workflowLane: false, firstMessageText: 'go read the file' });
    const wf = rows.find((r) => r.id.includes('wf:wf_run1'));
    expect(wf).toMatchObject({ parentSessionId: 'parent-session-1', workflowLane: true, firstMessageText: 'verify:#3444 please proceed' });
  });
});

it('subagentRowsFor returns [] for a real session with no subagents directory', async () => {
  await withRealRepo(async ({ root }) => {
    expect(subagentRowsFor('sess-none', '/anywhere', join(root, 'projects'))).toEqual([]);
  });
});

it('firstMessageText reads a real multi-block first message off disk', async () => {
  await withRealRepo(async ({ root }) => {
    const p = join(root, 'one.jsonl');
    writeFileSync(p, `${JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }] } })}\n${assistantLine([])}\n`);
    expect(firstMessageText(p)).toBe('part one part two');
  });
});

it('claimedNumsFromTranscript replays REAL claim/release Bash calls off a real transcript file, net set in order', async () => {
  await withRealRepo(async ({ root }) => {
    const p = join(root, 'sess.jsonl');
    const lines = [
      assistantLine([{ type: 'tool_use', name: 'Bash', input: { command: 'node scripts/backlog.mjs claim 3401' } }]),
      assistantLine([{ type: 'tool_use', name: 'Bash', input: { command: 'node scripts/backlog.mjs claim 3555' } }]),
      assistantLine([{ type: 'tool_use', name: 'Bash', input: { command: 'node scripts/backlog.mjs resolve 3401' } }]),
    ];
    writeFileSync(p, lines.join('\n') + '\n');
    expect(claimedNumsFromTranscript(p)).toEqual(['3555']);
  });
});

it('claimedNumsFromTranscript: a repeated claim moves the card to the latest position (A, B, A → A wins)', async () => {
  await withRealRepo(async ({ root }) => {
    const p = join(root, 'sess.jsonl');
    const lines = ['claim 3401', 'claim 3555', 'claim 3401'].map((v) =>
      assistantLine([{ type: 'tool_use', name: 'Bash', input: { command: `node scripts/backlog.mjs ${v}` } }]));
    writeFileSync(p, lines.join('\n') + '\n');
    const owned = claimedNumsFromTranscript(p);
    expect(owned).toEqual(['3555', '3401']);
    // …and the resolver's "most recent claim wins" rule therefore picks A, end to end.
    const { runs } = resolveAgentActivity([{ id: 's', sessionId: 's', kind: 'background', claimedNums: owned }]);
    expect(runs[0]).toMatchObject({ card: '3401', joinVia: 'claim' });
  });
});

it('claimedNumsFromTranscript reads only a BOUNDED tail — a transcript far past V8\'s max string length still yields its recent claims', async () => {
  await withRealRepo(async ({ root }) => {
    const p = join(root, 'huge.jsonl');
    // A real ~600 MB (sparse) file: a whole-file readFileSync(utf8) ABORTS the process (V8 FATAL, uncatchable) on it.
    const tail = `\n${assistantLine([{ type: 'tool_use', name: 'Bash', input: { command: 'node scripts/backlog.mjs claim 3932' } }])}\n`;
    const fd = openSync(p, 'w');
    try { writeSync(fd, tail, 600 * 1024 * 1024); } finally { closeSync(fd); }
    expect(claimedNumsFromTranscript(p)).toEqual(['3932']);
  });
});

it('createAgentActivityReader\'s DEFAULT listing never passes --all, and drops terminal-state sessions (PR #2715 review)', () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    return JSON.stringify([
      { id: 'a', sessionId: 'sa', name: 'conveyor-9001', state: 'done', startedAt: '2020-01-01' },
      { id: 'b', sessionId: 'sb', name: 'conveyor-9002', state: 'failed' },
      { id: 'c', sessionId: 'sc', name: 'conveyor-9003', state: 'stopped' },
      { id: 'd', sessionId: 'sd', name: 'conveyor-9004', state: 'working' },
    ]);
  };
  const io = { listJobs: () => [], run: () => '{"lanes":[]}', root: '/nonexistent', projectsDir: '/nonexistent' };
  const { rows } = createAgentActivityReader({ exec, ...io })({});
  expect(calls).toEqual([['claude', 'agents', '--json']]);
  expect(rows.map((r) => r.name)).toEqual(['conveyor-9004']);
  // The reviewer's exact repro: an injected listing carrying a `done` session must not surface as a run.
  const injected = createAgentActivityReader({
    listAgents: () => [{ name: 'conveyor-9001', state: 'done', startedAt: '2020-01-01' }], ...io,
  });
  expect(resolveAgentActivity(injected({}).rows).runs).toEqual([]);
});

it('claimedNumsFromTranscript returns [] for a real path that does not exist', async () => {
  await withRealRepo(async ({ root }) => { expect(claimedNumsFromTranscript(join(root, 'nope.jsonl'))).toEqual([]); });
});

it('interactiveRows sweeps REAL project directories, skipping known session ids and anything past the recency window', async () => {
  await withRealRepo(async ({ root }) => {
    const projectsDir = join(root, 'projects');
    const slugDir = join(projectsDir, 'some-slug');
    mkdirSync(slugDir, { recursive: true });
    const freshId = '11111111-1111-1111-1111-111111111111';
    const staleId = '22222222-2222-2222-2222-222222222222';
    const knownId = '33333333-3333-3333-3333-333333333333';
    for (const id of [freshId, staleId, knownId]) {
      writeFileSync(join(slugDir, `${id}.jsonl`), `${userLine('hello')}\n`);
    }
    const now = Date.now();
    utimesSync(join(slugDir, `${freshId}.jsonl`), now / 1000, now / 1000);
    const eightHoursAgo = (now - 8 * 3600_000) / 1000;
    utimesSync(join(slugDir, `${staleId}.jsonl`), eightHoursAgo, eightHoursAgo);
    utimesSync(join(slugDir, `${knownId}.jsonl`), now / 1000, now / 1000);

    const rows = interactiveRows(new Set([knownId]), projectsDir, now);
    expect(rows.map((r) => r.sessionId)).toEqual([freshId]);
    expect(rows[0]).toMatchObject({ kind: 'interactive', firstMessageText: 'hello' });
  });
});

it('codexThreadRows stamps activity from a REAL nested rollout, leaving missing rollouts unknown', async () => {
  await withRealRepo(async ({ root }) => {
    const dir = join(root, '.operations', 'codex-delivery-threads');
    const codexHome = join(root, 'codex');
    const sessions = join(codexHome, 'sessions', '2026', '10', '03');
    mkdirSync(dir, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    const path = join(sessions, 'rollout-2026-10-03T12-00-00-thread-one.jsonl');
    writeFileSync(path, '');
    utimesSync(path, 1791028800, 1791028800);
    for (const threadId of ['thread-one', 'thread-two']) {
      writeFileSync(join(dir, `${threadId}.json`), JSON.stringify({ sessionSlug: threadId, threadId }));
    }
    expect(codexThreadRows(root, { codexHome })).toMatchObject([
      { transcriptPath: path, lastActivityMs: 1791028800000 },
      { transcriptPath: null, lastActivityMs: null },
    ]);
  });
});

it('reader drops a finished Codex job, keeps re-dispatch and tolerates missing/corrupt/invalid completions across repeated reads', async () => {
  await withRealRepo(async ({ root }) => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    const dir = join(root, '.operations', 'codex-delivery-threads');
    const completionsDir = join(root, 'completions');
    const codexHome = join(root, 'codex');
    const sessions = join(codexHome, 'sessions', '2026');
    for (const path of [dir, completionsDir, sessions]) mkdirSync(path, { recursive: true });
    const slugs = ['conveyor-9101', 'conveyor-9102', 'conveyor-9103', 'conveyor-9104', '../invalid'];
    for (const [i, sessionSlug] of slugs.entries()) {
      // Both runs are recent: the finished row must be dropped by completion, not age.
      const at = new Date(now - (i === 0 ? 2000 : 500)).toISOString();
      writeFileSync(join(dir, `${i}.json`), JSON.stringify({ sessionSlug, threadId: `thread-${i}`, at }));
      const path = join(sessions, `rollout-date-thread-${i}.jsonl`);
      writeFileSync(path, '');
      utimesSync(path, now / 1000, now / 1000);
      if (i < 2) writeFileSync(join(completionsDir, `${sessionSlug}.json`), JSON.stringify({
        v: 1, session: sessionSlug, kind: 'fix', status: 'done', startedAt: at,
        updatedAt: new Date(now - 1000).toISOString(),
      }));
      if (i === 2) writeFileSync(join(completionsDir, `${sessionSlug}.json`), '{broken');
    }
    const read = createAgentActivityReader({ root, codexHome, completionsDir, projectsDir: join(root, 'projects'),
      listAgents: () => [], listJobs: () => [], run: () => '{"lanes":[]}', now: () => now });
    for (let pass = 0; pass < 20; pass++) {
      expect(read({}).rows.map(r => r.codexSlug)).toEqual(slugs.slice(1));
    }
  });
});

it('reader ages out a 17-day-old no-pid background session and its children, keeps fresh and pid-carrying sessions', async () => {
  await withRealRepo(async ({ root }) => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    const old = now - 17 * 86400_000;
    const projectsDir = join(root, 'projects');
    const cwd = '/fixture';
    const project = join(projectsDir, projectSlugFor(cwd));
    mkdirSync(project, { recursive: true });
    const agents = ['stale', 'fresh', 'pid'].map(sessionId => ({
      sessionId, name: sessionId, cwd, state: 'working', startedAt: old,
      ...(sessionId === 'pid' ? { pid: 123 } : {}),
    }));
    for (const { sessionId } of agents) {
      const path = join(project, `${sessionId}.jsonl`);
      writeFileSync(path, userLine('hello'));
      const at = sessionId === 'fresh' ? now : old;
      utimesSync(path, at / 1000, at / 1000);
      const children = join(project, sessionId, 'subagents');
      mkdirSync(children, { recursive: true });
      writeFileSync(join(children, 'agent-child.jsonl'), userLine('check #9101'));
    }
    const read = createAgentActivityReader({ root, projectsDir, codexHome: join(root, 'codex'), completionsDir: join(root, 'completions'),
      listAgents: () => agents, listJobs: () => [], run: () => '{"lanes":[]}', now: () => now });
    for (let pass = 0; pass < 20; pass++) {
      const rows = read({ all: true }).rows;
      expect(rows.filter(r => r.kind === 'background').map(r => r.name)).toEqual(['fresh', 'pid']);
      expect(rows.filter(r => r.kind === 'subagent').map(r => r.parentSessionId)).toEqual(['fresh', 'pid']);
      expect(rows.find(r => r.name === 'fresh').lastActivityMs).toBe(now);
    }
  });
});

it('filters stale plain and workflow transcripts before opening their heads; default keeps both', async () => {
  await withRealRepo(async ({ root }) => {
    const projects = join(root, 'projects');
    const cwd = '/fixture';
    const base = join(projects, projectSlugFor(cwd), 'parent', 'subagents');
    // Whole seconds survive filesystem timestamp precision at the exact six-hour boundary.
    const now = Math.floor(Date.now() / 1000) * 1000;
    for (const dir of [base, join(base, 'workflows', 'run')]) {
      mkdirSync(dir, { recursive: true });
      for (const [name, age] of [['stale', 7 * 3600000], ['fresh', 0], ['boundary', RECENT_MS]]) {
        const path = join(dir, `agent-${name}.jsonl`);
        writeFileSync(path, userLine(name));
        const time = new Date(now - age);
        utimesSync(path, time, time);
      }
    }
    // A real Node child instruments the native ESM binding before importing the reader.
    const proof = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const opened = [], original = fs.openSync;
      fs.openSync = (path, ...args) => { opened.push(path); return original(path, ...args); };
      syncBuiltinESMExports();
      const { subagentRowsFor } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'scripts/operations/agent-activity-io.mjs')).href)});
      // The loader may open its own module files through the patched binding (Node-version dependent), so
      // drop everything recorded during import and keep only transcript heads opened by the reader call.
      opened.length = 0;
      const rows = subagentRowsFor('parent', ${JSON.stringify(cwd)}, ${JSON.stringify(projects)}, { recentMs: ${RECENT_MS}, now: ${now} });
      const heads = opened.filter((path) => /agent-[^/]*\\.jsonl$/.test(String(path)));
      opened.length = 0;
      const unreadable = subagentRowsFor('parent', ${JSON.stringify(cwd)}, ${JSON.stringify(projects)}, {
        recentMs: ${RECENT_MS}, now: ${now}, stat: () => { throw new Error('gone'); },
      });
      console.log(JSON.stringify({ rows, heads, unreadable, unreadableHeads: opened }));
    `], { encoding: 'utf8', timeout: 15000 }));
    expect(proof.rows.map(r => r.firstMessageText).sort()).toEqual(['boundary', 'boundary', 'fresh', 'fresh']);
    expect(proof.heads).toHaveLength(4);
    expect(proof.heads.every(path => !path.includes('stale'))).toBe(true);
    expect(proof.unreadable).toEqual([]);
    expect(proof.unreadableHeads).toEqual([]);
    expect(subagentRowsFor('parent', cwd, projects)).toHaveLength(6);
    const lease = { purpose: 'build-1', ownerSession: 'parent' };
    const reader = createAgentActivityReader({
      root, projectsDir: projects, codexHome: join(root, 'codex'), listJobs: () => [],
      listAgents: () => [{ sessionId: 'parent', cwd, state: 'working' }],
      run: () => { throw new Error('unexpected lane-pool spawn'); },
      readLeases: () => [lease], subagentRecentMs: RECENT_MS, now: () => now,
    });
    const result = reader({});
    expect(result.rows.find(row => row.sessionId === 'parent').lease).toEqual(lease);
    expect(result.rows.filter(row => row.kind === 'subagent')).toHaveLength(4);
  });
});

it('leasesFromLanePoolStatus tolerates missing and malformed status', () => {
  for (const parsed of [undefined, null, {}, { lanes: 'x' }, { lanes: [null, {}] }]) {
    expect(leasesFromLanePoolStatus(parsed)).toEqual([]);
  }
});
