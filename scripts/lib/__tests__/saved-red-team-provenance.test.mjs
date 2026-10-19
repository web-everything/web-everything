// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readSavedRedTeamResult } from '../drain-saved-red-team.mjs';
import { redTeamEnqueueHold } from '../drain-queue-safety.mjs';
import { readDrainRedTeamEvidence } from '../drain-red-team-evidence.mjs';
import { createDrainMergeStrategy } from '../drain-merge-strategy.mjs';
import { resolveMergeDeliveryPolicy } from '../merge-delivery-policy.mjs';
import { resolveScorecardStorePath } from '../../conveyor/run-scorecard-store.mjs';
import { writeRun } from '../../operations/run-store.mjs';
import { reviewPrOperation } from '../../operations/review-pr.mjs';
import { isComplete } from '../../operations/engine.mjs';
import { provenanceRun } from './fixtures/saved-red-team-provenance.mjs';

const repo = 'web-everything/web-everything', pr = 6212, head = 'a'.repeat(40);
const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture(timing = 'post-accept') {
  const root = mkdtempSync(join(tmpdir(), 'saved-red-team-provenance-')); roots.push(root);
  const runsDir = join(root, 'runs'); mkdirSync(runsDir);
  const env = { CONVEYOR_STATE_ROOT: root, WE_SHARED_RUNS_DIR: runsDir, OPERATION_RUNS_DIR: runsDir,
    WE_RED_TEAM_TIMING: timing, WE_RED_TEAM_DRAIN_READS_SAVED_RESULT: 'true',
    WE_DRAIN_ENQUEUE_WHEN_RED_TEAM_NEVER_SCHEDULED: 'true', WE_DRAIN_RED_TEAM_PENDING_MAX_MIN: '1' };
  const rows = [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head,
    status: 'ok', recheckStatus: 'ok', confirmedMissCount: 0, findings: [],
    scoredAt: '2026-10-18T12:00:00Z', privateNote: 'ROW_CONTENT_MUST_NOT_BE_LOGGED' }];
  const path = resolveScorecardStorePath(env); mkdirSync(dirname(path), { recursive: true });
  const saveRows = () => writeFileSync(path, JSON.stringify({ version: 1, records: rows })); saveRows();
  const input = { repo, pr, head, env, runsDir };
  const run = provenanceRun({ env, rows });
  // Pin an actual engine-completed record, not a made-up status string.
  expect(isComplete(run, { registry: { get: () => reviewPrOperation({ readPr: () => { throw new Error('fixture never reads GitHub'); } }) } })).toBe(true);
  const saveRun = (record = run) => writeRun(record, runsDir);
  const lines = [];
  const evidence = () => readDrainRedTeamEvidence({ ...input, isAlive: () => false });
  const hold = () => redTeamEnqueueHold({ ...input, ...evidence(), comments: [], requestPending: false });
  const read = () => readSavedRedTeamResult({ ...input, log: line => lines.push(line) });
  return { input, rows, run, saveRows, saveRun, read, lines, evidence, hold };
}
function expectIgnored(f, reason) {
  expect.soft(f.read()).toBeNull();
  expect.soft(f.lines.join('\n')).toMatch(/^saved-red-team-ignored: /m);
  expect.soft(f.lines.join('\n')).toMatch(reason);
  expect.soft(f.lines.join('\n')).not.toContain('ROW_CONTENT_MUST_NOT_BE_LOGGED');
  expect.soft(f.evidence()).toMatchObject({ recorded: true, attempted: true });
  expect.soft(f.hold()).toMatch(/no recorded result/);
}

// Drive the real queue policy across the pending deadline; a rejected saved row still proves an attempt.
function queue(f) {
  let clock = 0, stored, enqueued = false;
  const mutations = [], requests = [];
  const exec = (cmd, args) => {
    if (cmd === 'git') return args[0] === 'diff' ? 'scripts/example.mjs\0' : `${'b'.repeat(40)}\n`;
    if (args.includes('--slurp')) return '[[]]';
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ state: 'OPEN', id: 'PR_NODE',
      headRefOid: head, baseRefName: 'main', labels: ['review:accepted', 'ready-to-merge'] });
    if (args[0] === 'api' && args[1] === 'graphql') {
      if (args.some(a => a.includes('isInMergeQueue'))) return JSON.stringify({ data: { repository: { pullRequest: { headRefOid: head, isInMergeQueue: enqueued } } } });
      if (args.some(a => a.includes('enqueuePullRequest'))) {
        mutations.push(args); enqueued = true;
        return JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: { id: 'E' } } } });
      }
    }
    if (args[0] === 'api' && args[1] === 'user') return 'drain-bot';
    if (args[0] === 'label' || (args[0] === 'pr' && ['comment', 'edit'].includes(args[1]))) return '';
    throw new Error(`unexpected fixture command: ${cmd} ${args.join(' ')}`);
  };
  const strategy = createDrainMergeStrategy({ env: f.input.env, exec, now: () => clock,
    localSlug: repo, isLocalRepo: r => !r || r === repo, statePath: join(f.input.env.CONVEYOR_STATE_ROOT, 'queue.json'),
    readRedTeamEvidence: f.evidence, requestRedTeam: args => { requests.push(args); return { requested: false }; },
    resolved: { policy: resolveMergeDeliveryPolicy({ tool: { strategy: 'github-merge-queue' } }), note: null },
    readFile: () => { if (!stored) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return JSON.stringify(stored); },
    writeState: (_path, state) => { stored = structuredClone(state); }, log: { write: () => {} },
    cancelObsoleteRuns: () => {}, batching: { gate: () => ({ admit: true }), observe: () => ({}) },
  });
  return { enqueue: () => strategy.enqueue({ num: pr, repo }, head, { comments: [] }),
    expire: () => { clock += 2 * 60_000; }, mutations, requests };
}

describe('saved red-team provenance', () => {
  it('ignores and logs a forged row with no review-pr run, preserving the drain hold', () => {
    expectIgnored(fixture(), /run|referenc|provenance/i);
  });
  it('holds a forged attempted head beyond the deadline without the never-scheduled escape', () => {
    const q = queue(fixture());
    expect.soft(q.enqueue()).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    q.expire();
    expect.soft(q.enqueue()).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    expect(q.mutations).toEqual([]);
    expect(q.requests).toEqual([]);
  });
  it('ignores and logs an edited row whose stored hash no longer matches', () => {
    const f = fixture(); f.saveRun();
    f.rows[0].privateNote += ' EDITED'; f.saveRows();
    expectIgnored(f, /hash|digest|mismatch/i);
  });
  it.each(['post-accept', 'panel-seat'])('counts genuine completed matching-hash evidence and admits a clean %s result', timing => {
    const f = fixture(timing); f.saveRun();
    expect(f.read()).toMatchObject({ pr, rev: head, findings: [], recheckIncomplete: false });
    expect(f.lines).toEqual([]);
    expect(f.hold()).toBeNull();
    expect(queue(f).enqueue()).toMatchObject({ enqueued: true });
  });
  it.each(['incomplete', 'another repo', 'another PR', 'another head', 'no hash', 'no reference', 'other writer', 'other operation'])(
    'ignores and logs provenance with %s', kind => {
      const f = fixture(); const run = structuredClone(f.run);
      if (kind === 'incomplete') { run.cursor = 0; expect(isComplete(run, { registry: { get: () => reviewPrOperation({ readPr: () => { throw new Error('fixture never reads GitHub'); } }) } })).toBe(false); }
      if (kind === 'another repo') { run.input.repo = 'other/repo'; run.findings.read.repo = 'other/repo'; }
      if (kind === 'another PR') { run.input.pr = pr + 1; run.findings.read.pr = pr + 1; }
      if (kind === 'another head') run.findings.read.netBasis.rev = 'b'.repeat(40);
      if (kind === 'no hash') delete run.findings.savedRedTeamResult.sha256;
      if (kind === 'no reference') run.findings.savedRedTeamResult.references = [];
      if (kind === 'other writer') run.findings.savedRedTeamResult.writer = 'shell-agent';
      if (kind === 'other operation') { run.op = 'fix-pr'; run.id = 'fix-pr-provenance'; }
      f.saveRun(run);
      expectIgnored(f, /run|complet|repo|PR|head|hash|referenc|writer|provenance/i);
    });
  it('uses the same provenance check for a forged panel-seat result: ignored and held', () => {
    const f = fixture('panel-seat');
    expectIgnored(f, /run|referenc|provenance/i);
    const q = queue(f);
    expect.soft(q.enqueue()).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    q.expire();
    expect.soft(q.enqueue()).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    expect(q.mutations).toEqual([]);
  });
  it('logs a safe single-line reason to stderr by default without saved contents', () => {
    const f = fixture();
    // Observe actual stderr, including writers using fs.writeSync or console.error rather than stream.write.
    // Ignore dependency deprecations (markdown-it uses node:punycode on Node 22); assert our diagnostic exactly.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { readSavedRedTeamResult } from ${JSON.stringify(new URL('../drain-saved-red-team.mjs', import.meta.url).href)};
      const ignored = readSavedRedTeamResult(JSON.parse(process.argv[1])) === null;
      process.stdout.write(JSON.stringify({ ignored }));
    `, JSON.stringify(f.input)], { encoding: 'utf8', env: { ...process.env, ...f.input.env, NODE_NO_WARNINGS: '1' }, timeout: 15_000 });
    expect(child.status).toBe(0);
    expect.soft(JSON.parse(child.stdout)).toEqual({ ignored: true });
    expect(child.stderr).toMatch(/^saved-red-team-ignored: [^\r\n]+\n$/);
    expect(child.stderr).not.toContain('ROW_CONTENT_MUST_NOT_BE_LOGGED');
  });
});
