/** Small entry point: handlers are active before the large review-job import graph is evaluated. */
import { installReviewJobExitHandlers } from './review-job-lifecycle.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function runReviewJobEntrypoint({ argv = process.argv.slice(2), env = process.env,
  install = installReviewJobExitHandlers, load = () => import('./review-job.mjs') } = {}) {
  const flag = name => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const lifecycle = install({ session: env.WE_REVIEW_JOB_SLUG,
    pr: flag('pr'), repo: flag('repo'), redTeamOnly: argv.some(arg => arg === '--red-team-only' || arg.startsWith('--red-team-only=')) });
  try {
    const { runReviewJobCli } = await load();
    const out = runReviewJobCli(argv, { onError: error => lifecycle.finish(`setup/claim error: ${error.message}`) });
    lifecycle.finish('review-job returned', out);
  } catch (error) {
    lifecycle.finish(`review-job import/startup failure: ${String(error?.message ?? error).slice(0, 400)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runReviewJobEntrypoint();
