/** Process state shared by one simulated world, never by worlds with independent clocks. */
import { delimiter, join } from 'node:path';

export function isolatedProcessEnv(root, ambient = process.env) {
  const env = {
    ...ambient,
    // vitest.setup.ts supplies a per-file root. Scenarios in that file advance independent clocks;
    // sharing its budget can leave the next scenario waiting on a window dated 11 minutes ahead.
    WE_GH_THROTTLE_LOCK_ROOT: join(root, 'gh-throttle'),
    WE_COORDINATION_ROOT: join(root, 'coordination'),
  };
  for (const key of ['WE_DISPATCH_ROUTING_SNAPSHOT', 'WE_GITHUB_APP_ID',
    'WE_GITHUB_APP_INSTALLATION_ID', 'WE_GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_TOKEN']) delete env[key];
  return env;
}

/** Generated App shim directories contain live state, not tools to copy into a fake world's PATH. */
export function toolPathDirs(pathEnv = process.env.PATH ?? '') {
  return pathEnv.split(delimiter).filter(Boolean)
    .filter(dir => !/(^|[/\\])github-app-token([/\\]|$)/.test(dir));
}
