/** Environment isolation for scenario clocks and their persistent GitHub throttle budgets. */
import { join } from 'node:path';

export function worldThrottleEnv(root, ambient = process.env) {
  return { ...ambient, WE_GH_THROTTLE_LOCK_ROOT: join(root, 'gh-throttle') };
}
