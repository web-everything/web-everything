/**
 * @file scripts/lib/judge-trusted-paths.mjs
 * @description Slice 5062 owns this file and will add more exports; this one exports only the switch path.
 */
import os from 'node:os';
import { join } from 'node:path';

export const JUDGE_SWITCHES_PATH = join(
  os.userInfo().homedir, 'workspace', '.operations', 'coordination', 'judge-switches.json',
);
