/** Detached card batch seal worker; publication owns the lease and releases its lane in finally. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { publishBatch } from './card-batch-seal-io.mjs';

export async function main(argv = process.argv.slice(2)) {
  const statePath = argv.find(arg => arg.startsWith('--state='))?.slice(8);
  if (!statePath) throw new Error('--state=<path> is required');
  return publishBatch({ statePath });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(result => {
    console.log(JSON.stringify(result));
    if (result.action === 'refuse') process.exitCode = 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
