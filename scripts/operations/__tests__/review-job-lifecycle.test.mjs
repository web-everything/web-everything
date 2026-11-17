import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateCompletionRecord } from '../completion-record.mjs';
import { installReviewJobExitHandlers } from '../review-job-lifecycle.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const moduleUrl = name => pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', name)).href;
const lifecycleUrl = moduleUrl('review-job-lifecycle.mjs');
const runnerUrl = moduleUrl('review-job-runner.mjs');
const jobUrl = moduleUrl('review-job.mjs');
function child(body, { completion = null, claim = 'own' } = {}) {
  const root = mkdtempSync(join(process.env.TMPDIR, 'review-lifecycle-')); roots.push(root);
  if (completion !== null) {
    mkdirSync(join(root, 'completions'));
    writeFileSync(join(root, 'completions', 'review-10.json'), completion);
  }
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { installReviewJobExitHandlers } from ${JSON.stringify(lifecycleUrl)};
    ${claim === null ? '' : `
      const fixtureFs = await import('node:fs');
      const fixturePath = await import('node:path');
      fixtureFs.mkdirSync(process.env.OPERATION_REVIEW_JOBS_DIR, {recursive:true});
      fixtureFs.writeFileSync(fixturePath.join(process.env.OPERATION_REVIEW_JOBS_DIR, 'review-10.json'),
        JSON.stringify({slug:'review-10', pr:10, repo:'web-everything/web-everything', pid:${claim === 'own' ? 'process.pid' : JSON.stringify(claim)}}));
    `}
    ${body}
  `], { env: { ...process.env, OPERATION_COMPLETIONS_DIR: join(root, 'completions'),
    OPERATION_REVIEW_JOBS_DIR: join(root, 'jobs'), WE_REVIEW_JOB_SLUG: 'review-10' },
    encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  const path = join(root, 'completions', 'review-10.json');
  if (!existsSync(path)) throw Error(`child left no completion: ${JSON.stringify({ status: result.status, error: result.error?.message, stderr: result.stderr?.slice(-4000) })}`);
  const bytes = readFileSync(path);
  const done = JSON.parse(bytes.toString('utf8'));
  return { result, done, root, bytes };
}
const install = `installReviewJobExitHandlers({session:'review-10', pr:10, repo:'web-everything/web-everything'});`;
const panelCompletion = `${JSON.stringify({ v: 1, session: 'review-10', kind: 'review', pr: '10', item: null,
  sessionId: null, pid: 4242, status: 'done', outcome: 'auto-cleared', verdict: 'converged', runId: 'panel-run',
  label: 'live owner panel verdict', startedAt: '2026-11-17T10:00:00.000Z', updatedAt: '2026-11-17T10:01:00.000Z' }, null, 2)}\n`;
function isolated(overrides = {}) {
  const host = { pid: 70, once: vi.fn(), stderr: { write: vi.fn() } };
  const terminal = vi.fn(), receipt = vi.fn();
  const lifecycle = installReviewJobExitHandlers({ session: 'review-10', pr: 10, repo: 'web-everything/web-everything',
    host, terminal, receipt, read: () => null,
    readClaim: () => ({ slug: 'review-10', pr: 10, repo: 'web-everything/web-everything', pid: host.pid }),
    ...overrides });
  return { host, terminal, receipt, finish: () => lifecycle.finish('startup failed') };
}
describe('review job last-resort terminal records', () => {
  it.each(['absent', 'ours', 'foreign'])('import failure cannot replace another live PID\'s started completion (%s claim)', claim => {
    // The parent remains alive throughout spawnSync: this is a real foreign live PID, not a guessed one.
    const completion = `${JSON.stringify({ ...JSON.parse(panelCompletion), pid: process.pid,
      status: 'started', outcome: null, verdict: null, runId: null, label: null }, null, 2)}\n`;
    const { result, bytes, root } = child(`
      const { runReviewJobEntrypoint } = await import(${JSON.stringify(runnerUrl)});
      await runReviewJobEntrypoint({argv:['run','--pr=10','--repo=web-everything/web-everything'],
        load: async () => { throw Error('import before claim failed'); }});
    `, { completion, claim: claim === 'absent' ? null : claim === 'ours' ? 'own' : process.pid });
    expect(result.status).toBe(1);
    expect(bytes.equals(Buffer.from(completion))).toBe(true);
    expect(result.stderr).toContain('terminal record withheld:');
    expect(existsSync(join(root, 'jobs', '.terminal', 'review-10.json'))).toBe(false);
  });
  it('writes for its own completion PID after the claim has been released', () => {
    const f = isolated({ read: () => ({ session: 'review-10', pid: 70, status: 'started' }), readClaim: () => null });
    f.finish(); expect(f.terminal).toHaveBeenCalledOnce(); expect(f.receipt).toHaveBeenCalledOnce();
  });
  it('writes a PID-less legacy completion only while holding its own claim', () => {
    const read = () => ({ session: 'review-10', status: 'started' });
    const owned = isolated({ read }); owned.finish(); expect(owned.terminal).toHaveBeenCalledOnce();
    const unowned = isolated({ read, readClaim: () => null }); unowned.finish();
    expect(unowned.terminal).not.toHaveBeenCalled(); expect(unowned.receipt).not.toHaveBeenCalled();
  });
  it('replaces an older foreign completion only with its own claim and proven-dead writer', () => {
    const isAlive = vi.fn(() => false);
    const f = isolated({ read: () => ({ session: 'review-10', pid: 71, status: 'started' }), isAlive });
    f.finish(); expect(isAlive).toHaveBeenCalledWith(71); expect(f.terminal).toHaveBeenCalledOnce();
  });
  it.each(['unknown', 'throws'])('withholds terminal writes when a foreign completion PID liveness is %s', mode => {
    const f = isolated({ read: () => ({ session: 'review-10', pid: 71, status: 'started' }),
      isAlive: () => { if (mode === 'throws') throw Error('probe denied'); return null; } });
    f.finish(); expect(f.terminal).not.toHaveBeenCalled(); expect(f.receipt).not.toHaveBeenCalled();
    expect(f.host.stderr.write).toHaveBeenCalledWith(expect.stringContaining('inspect claim/completion before re-arming'));
  });
  it.each(['read', 'readClaim'])('withholds terminal writes on unreadable ownership evidence (%s)', hook => {
    const f = isolated({ [hook]: () => { throw Error('EACCES'); } });
    f.finish(); expect(f.terminal).not.toHaveBeenCalled(); expect(f.receipt).not.toHaveBeenCalled();
    expect(f.host.stderr.write).toHaveBeenCalledWith(expect.stringContaining('ownership evidence unreadable'));
  });
  it('does not invent ownership when both the completion and claim are absent', () => {
    const f = isolated({ readClaim: () => null });
    f.finish(); expect(f.terminal).not.toHaveBeenCalled(); expect(f.receipt).not.toHaveBeenCalled();
  });
  it('a foreign claim vetoes an old completion bearing our PID', () => {
    const f = isolated({ read: () => ({ session: 'review-10', pid: 70, status: 'started' }),
      readClaim: () => ({ slug: 'review-10', pr: 10, repo: 'web-everything/web-everything', pid: 71 }) });
    f.finish(); expect(f.terminal).not.toHaveBeenCalled(); expect(f.receipt).not.toHaveBeenCalled();
  });
  it('refused duplicate exit leaves its live owner\'s panel completion byte-for-byte unchanged', () => {
    const { result, bytes, root } = child(`
      const lifecycle = ${install.slice(0, -1)}
      lifecycle.finish('duplicate refused', { refused: true, outcome: 'refused-live-job' });
      process.exit(75);
    `, { completion: panelCompletion });
    expect(result.status).toBe(75);
    expect(bytes.equals(Buffer.from(panelCompletion))).toBe(true);
    expect(existsSync(join(root, 'jobs', '.terminal', 'review-10.json'))).toBe(false);
  });
  it('red-team-only crash exit preserves the panel completion byte-for-byte and writes a separate terminal receipt', () => {
    const { result, bytes, root } = child(`
      installReviewJobExitHandlers({session:'review-10', pr:10, repo:'web-everything/web-everything', redTeamOnly:true});
      process.exit(23);
    `, { completion: panelCompletion });
    expect(result.status).toBe(23);
    expect(bytes.equals(Buffer.from(panelCompletion))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'jobs', '.terminal', 'review-10.json'), 'utf8'))).toMatchObject({
      status: 'done', outcome: 'blocked-on-infra', label: 'process exit 23 without a clean outcome',
    });
  });
  it.each([
    ['uncaught exception', `${install} throw Error('hard crash');`, /uncaught exception: hard crash/],
    ['process exit', `${install} process.exit(23);`, /process exit 23/],
    ['SIGTERM', `${install} setTimeout(() => process.exit(99), 5000); process.kill(process.pid, 'SIGTERM');`, /signal SIGTERM/],
    ['SIGINT', `${install} setTimeout(() => process.exit(99), 5000); process.kill(process.pid, 'SIGINT');`, /signal SIGINT/],
    ['unhandled rejection', `${install} Promise.reject(Error('lost promise')); await new Promise(resolve => setImmediate(resolve));`, /unhandled rejection: lost promise/],
  ])('writes valid done with an exit reason on %s', (_, body, label) => {
    const { done, result } = child(body);
    expect(result.status).not.toBe(0);
    expect(done).toMatchObject({ status: 'done', outcome: 'blocked-on-infra', label: expect.stringMatching(label) });
    expect(validateCompletionRecord(done).ok).toBe(true);
  });
  it('catches import failure before loading the review graph', () => {
    const { done } = child(`
      const { runReviewJobEntrypoint } = await import(${JSON.stringify(runnerUrl)});
      await runReviewJobEntrypoint({argv:['run','--pr=10','--repo=web-everything/web-everything'],
        load: () => import('./missing-review-job-fixture.mjs')});
    `);
    expect(done).toMatchObject({ status: 'done', outcome: 'blocked-on-infra', label: expect.stringContaining('import/startup failure') });
  });
  it('covers a claim throw before the arc try/finally', () => {
    const { done } = child(`
      const { runReviewJobEntrypoint } = await import(${JSON.stringify(runnerUrl)});
      await runReviewJobEntrypoint({argv:['run','--pr=10','--repo=web-everything/web-everything'], load: async () => {
        const { runReviewJobCli, runReviewJob } = await import(${JSON.stringify(jobUrl)});
        return { runReviewJobCli: (argv, options) => runReviewJobCli(argv, {...options,
          runJob: opts => runReviewJob(opts, {now:()=>1, claim:()=>{throw Error('claim EACCES');}})}) };
      }});
    `);
    expect(done).toMatchObject({ status: 'done', outcome: 'blocked-on-infra', label: 'setup/claim error: claim EACCES' });
  });
  it('preserves the healthy review done record when the exit handler runs', () => {
    const { done, result } = child(`
      const lifecycle = ${install.slice(0, -1)}
      const { writeReviewJobDone } = await import(${JSON.stringify(moduleUrl('review-job-envelope.mjs'))});
      writeReviewJobDone({session:'review-10',pr:10,classified:{outcome:'auto-cleared',label:'clean review'}});
      lifecycle.finish('returned', {outcome:'auto-cleared'});
    `);
    expect(result.status).toBe(0); expect(done.outcome).toBe('auto-cleared'); expect(done.label).toBe('clean review');
  });
});
