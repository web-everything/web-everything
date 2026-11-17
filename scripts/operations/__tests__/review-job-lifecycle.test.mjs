import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateCompletionRecord } from '../completion-record.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const moduleUrl = name => pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', name)).href;
const lifecycleUrl = moduleUrl('review-job-lifecycle.mjs');
const runnerUrl = moduleUrl('review-job-runner.mjs');
const jobUrl = moduleUrl('review-job.mjs');
function child(body, { completion = null } = {}) {
  const root = mkdtempSync(join(process.env.TMPDIR, 'review-lifecycle-')); roots.push(root);
  if (completion !== null) {
    mkdirSync(join(root, 'completions'));
    writeFileSync(join(root, 'completions', 'review-10.json'), completion);
  }
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { installReviewJobExitHandlers } from ${JSON.stringify(lifecycleUrl)};
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
describe('review job last-resort terminal records', () => {
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
    ['SIGTERM', `${install} process.kill(process.pid, 'SIGTERM'); await new Promise(resolve => setImmediate(resolve));`, /signal SIGTERM/],
    ['SIGINT', `${install} process.kill(process.pid, 'SIGINT'); await new Promise(resolve => setImmediate(resolve));`, /signal SIGINT/],
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
