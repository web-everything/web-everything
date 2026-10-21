// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readSavedRedTeamResult } from '../drain-saved-red-team.mjs';
import { resolveScorecardStorePath } from '../../conveyor/run-scorecard-store.mjs';
import { writeRun } from '../../operations/run-store.mjs';
import { reviewPrOperation } from '../../operations/review-pr.mjs';
import { isComplete } from '../../operations/engine.mjs';
import { provenanceRun } from './fixtures/saved-red-team-provenance.mjs';

const repo = 'web-everything/web-everything', pr = 6212, head = 'a'.repeat(40);
const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'saved-red-team-provenance-')); roots.push(root);
  const runsDir = join(root, 'runs'); mkdirSync(runsDir);
  const env = { CONVEYOR_STATE_ROOT: root, WE_SHARED_RUNS_DIR: runsDir, OPERATION_RUNS_DIR: runsDir,
    WE_RED_TEAM_DRAIN_READS_SAVED_RESULT: 'true' };
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
  const read = () => readSavedRedTeamResult({ ...input, log: line => lines.push(line) });
  return { input, rows, run, saveRows, saveRun, read, lines };
}
function expectIgnored(f, reason) {
  expect.soft(f.read()).toBeNull();
  expect.soft(f.lines.join('\n')).toMatch(/^saved-red-team-ignored: /m);
  expect.soft(f.lines.join('\n')).toMatch(reason);
  expect.soft(f.lines.join('\n')).not.toContain('ROW_CONTENT_MUST_NOT_BE_LOGGED');
}

describe('saved red-team provenance', () => {
  it('ignores and logs a forged row with no review-pr run', () => {
    expectIgnored(fixture(), /run|referenc|provenance/i);
  });
  it('ignores and logs an edited row whose stored hash no longer matches', () => {
    const f = fixture(); f.saveRun();
    f.rows[0].privateNote += ' EDITED'; f.saveRows();
    expectIgnored(f, /hash|digest|mismatch/i);
  });
  it('reads genuine completed matching-hash evidence', () => {
    const f = fixture(); f.saveRun();
    expect(f.read()).toMatchObject({ pr, rev: head, findings: [], recheckIncomplete: false });
    expect(f.lines).toEqual([]);
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
