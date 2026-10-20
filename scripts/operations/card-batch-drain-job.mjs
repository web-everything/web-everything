/** Detached prevention drain worker (see card-batch-drain-io.mjs); output goes to `<state>.drain.log`. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDrainJob } from './card-batch-drain-io.mjs';

export async function main(argv = process.argv.slice(2), deps = {}) {
  const flag = name => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const budget = Number(flag('budget-ms'));
  return runDrainJob({ stateDir: flag('state-dir'), token: flag('token'),
    ...(Number.isFinite(budget) && budget > 0 ? { budgetMs: budget } : {}), ...deps });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(result => { process.exitCode = result.ok ? 0 : 1; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
