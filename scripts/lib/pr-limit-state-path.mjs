/** Shared host-state path resolver; kept free of PR/GitHub IO for admission readers. */
import { homedir } from 'node:os';
import { join } from 'node:path';

export function resolveLimitStatePath(env = process.env, home = homedir()) {
  const override = env?.WE_PR_LIMIT_STATE_FILE;
  return override && String(override).trim() ? String(override).trim() : join(home, '.claude', 'conveyor', 'pr-limit.json');
}
